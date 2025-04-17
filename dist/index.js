import * as core from "@actions/core";
import * as path from "path";
import * as github from '@actions/github'; // Need this for context
// Lib Imports
import { config } from "./libs/config.js"; // Load config first
import { credentials_json, drive } from "./libs/google-drive/auth.js"; // Needed for ownership check + drive client
import { octokit } from "./libs/github/auth.js"; // Get initialized octokit
import { list_local_files } from "./libs/local-files/list.js";
import { list_drive_files_recursively } from "./libs/google-drive/list.js";
import { build_folder_structure } from "./libs/google-drive/folders.js";
import { upload_file } from "./libs/google-drive/files.js";
import { delete_untracked } from "./libs/google-drive/delete.js";
import { request_ownership_transfer, accept_ownership_transfers } from "./libs/google-drive/ownership.js";
import { handle_drive_changes } from "./libs/sync-logic/handle-drive-changes.js";
import { GOOGLE_DOC_MIME_TYPES } from "./libs/google-drive/file_types.js";
import { generate_visual_diffs_for_pr } from './libs/visual-diffs/generate_visual_diffs.js';
// --- Get Inputs ---
const trigger_event_name = core.getInput('trigger_event_name', { required: true });
// Inputs for visual diff generation
const enable_visual_diffs = core.getBooleanInput('enable_visual_diffs', { required: false });
const visual_diff_output_dir = core.getInput('visual_diff_output_dir', { required: false }) || '_diff_'; // Default directory
const visual_diff_link_suffix = core.getInput('visual_diff_link_suffix', { required: false }) || '.gdrive.json'; // Default suffix matching our creation logic
const visual_diff_dpi = parseInt(core.getInput('visual_diff_dpi', { required: false }) || '72', 10); // Default DPI
const git_user_name = core.getInput('git_user_name', { required: false }) || 'github-actions[bot]';
const git_user_email = core.getInput('git_user_email', { required: false }) || 'github-actions[bot]@users.noreply.github.com';
// *** Main sync function ***
async function sync_main() {
    const repo_full_name = process.env.GITHUB_REPOSITORY;
    if (!repo_full_name) {
        core.setFailed("GITHUB_REPOSITORY environment variable is not set.");
        return;
    }
    const [owner, repo] = repo_full_name.split("/");
    core.info(`Syncing repository: ${owner}/${repo}`);
    core.info(`Triggered by event: ${trigger_event_name}`);
    core.info(`Visual Diff Generation Enabled: ${enable_visual_diffs}`);
    // Validate visual diff inputs if enabled
    if (enable_visual_diffs) {
        if (isNaN(visual_diff_dpi) || visual_diff_dpi <= 0) {
            core.setFailed(`Invalid visual_diff_dpi: ${core.getInput('visual_diff_dpi')}. Must be a positive number.`);
            return;
        }
        if (!visual_diff_link_suffix.startsWith('.')) {
            core.setFailed(`Invalid visual_diff_link_suffix: "${visual_diff_link_suffix}". Should start with a dot.`);
            return;
        }
        core.info(`Visual Diff Settings: Output Dir='${visual_diff_output_dir}', Link Suffix='${visual_diff_link_suffix}', DPI=${visual_diff_dpi}`);
    }
    for (const target of config.targets.forks) {
        const folder_id = target.drive_folder_id;
        const on_untrack_action = target.on_untrack || "ignore";
        core.startGroup(`Processing Target Drive Folder: ${folder_id} (Untrack Action: ${on_untrack_action})`);
        core.info(`Drive URL: ${target.drive_url || `https://drive.google.com/drive/folders/${folder_id}`}`);
        let operation_failed = false; // Track if any critical part fails for this target
        let pr_details = {}; // Store PR info for visual diff
        let needs_recursive_ownership_check = true; // Default to true, potentially set to false during push event
        try {
            // *** STEP 1 & 2: Sync Outgoing Changes & Handle Untracked (Push Trigger Only) ***
            if (trigger_event_name === 'push') {
                core.info("Step 1 & 2: Processing outgoing changes and untracked items (push trigger)...");
                // --- List current local state ---
                core.info("Listing current local files for outgoing sync...");
                const current_local_files = await list_local_files(".");
                const current_local_map = new Map(current_local_files.map(f => [f.relative_path.replace(/\\/g, '/'), f]));
                core.info(`Found ${current_local_map.size} local files for outgoing sync.`);
                // --- List Drive state ONCE ---
                core.info("Listing current Drive content ONCE for comparison and untracked check...");
                let drive_files_map;
                let drive_folders_map;
                let initial_list_found_unowned = false; // Flag for ownership check optimization
                try {
                    const drive_data = await list_drive_files_recursively(folder_id); // <<< LIST ONCE
                    // Create drive_files_map from drive_data.files array
                    drive_files_map = new Map(drive_data.files.map((file) => [
                        file.path.replace(/\\/g, '/'), // Normalize path to use forward slashes
                        file.item, // The DriveItem (file object)
                    ]));
                    // Create drive_folders_map from drive_data.folders (assuming it's similar)
                    drive_folders_map = new Map(Array.from(drive_data.folders.entries()).map(([p, item]) => [p.replace(/\\/g, '/'), item]));
                    // Check ownership during initial list processing to optimize Step 3
                    core.debug("Checking ownership of listed Drive items...");
                    for (const item of drive_files_map.values()) {
                        if (!item.owned) {
                            initial_list_found_unowned = true;
                            core.debug(`Found unowned file: ${item.name} (ID: ${item.id})`);
                            break; // Found one, no need to check further files
                        }
                    }
                    if (!initial_list_found_unowned) {
                        for (const item of drive_folders_map.values()) {
                            if (!item.owned && item.id !== folder_id) { // Ignore root folder ownership itself
                                initial_list_found_unowned = true;
                                core.debug(`Found unowned folder: ${item.name} (ID: ${item.id})`);
                                break; // Found one, no need to check further folders
                            }
                        }
                    }
                    // Set the flag for Step 3 based on this check
                    needs_recursive_ownership_check = initial_list_found_unowned;
                    core.info(`Initial Drive state: ${drive_files_map.size} files, ${drive_folders_map.size} folders. Needs recursive ownership check: ${needs_recursive_ownership_check}`);
                }
                catch (listError) {
                    core.error(`Failed list Drive content: ${listError.message}. Skipping outgoing sync steps.`);
                    operation_failed = true;
                    needs_recursive_ownership_check = true; // Assume check is needed if list fails
                    core.endGroup();
                    continue; // Skip to next target
                }
                // --- Build Folder Structure ---
                core.info("Ensuring Drive folder structure matches local structure...");
                let folder_path_to_id_map;
                try {
                    folder_path_to_id_map = await build_folder_structure(folder_id, current_local_files, drive_folders_map); // Pass existing map
                }
                catch (structureError) {
                    core.error(`Failed to build Drive folder structure: ${structureError.message}. Skipping file uploads/updates.`);
                    operation_failed = true;
                    folder_path_to_id_map = new Map([["", folder_id]]);
                }
                // --- Upload/Update Files ---
                core.info("Processing local files for upload/update to Drive...");
                const files_processed_for_outgoing = new Set(); // Track Drive paths corresponding to processed local files
                // Use Promise.all for potential parallel uploads (adjust concurrency as needed)
                const uploadPromises = [];
                const CONCURRENT_UPLOADS = 5; // Limit concurrency to avoid rate limits
                for (const [local_relative_path, local_file] of current_local_map) {
                    // Push an async function to the promises array
                    uploadPromises.push((async () => {
                        core.debug(`Processing local file for outgoing sync: ${local_relative_path}`);
                        if (local_relative_path.endsWith(visual_diff_link_suffix)) {
                            core.debug(` -> Skipping GDrive link file: ${local_relative_path}`);
                            const drive_comparison_path = local_relative_path.substring(0, local_relative_path.length - visual_diff_link_suffix.length);
                            files_processed_for_outgoing.add(drive_comparison_path); // Still track base path
                            return; // Skip actual upload
                        }
                        const drive_comparison_path = local_relative_path;
                        files_processed_for_outgoing.add(drive_comparison_path);
                        const existing_drive_file = drive_files_map.get(drive_comparison_path);
                        const drive_target_name = path.basename(drive_comparison_path);
                        const local_dir_path = path.dirname(local_relative_path);
                        const parent_dir_lookup = (local_dir_path === '.') ? "" : local_dir_path.replace(/\\/g, '/');
                        const target_folder_id = folder_path_to_id_map.get(parent_dir_lookup);
                        if (!target_folder_id) {
                            core.warning(`Could not find target Drive folder ID for local file '${local_relative_path}' (lookup path '${parent_dir_lookup}'). Skipping.`);
                            return;
                        }
                        try {
                            if (!existing_drive_file) {
                                core.info(`[Upload Queue] New file: '${local_relative_path}' to folder ${target_folder_id}.`);
                                await upload_file(local_file.path, target_folder_id);
                            }
                            else {
                                if (GOOGLE_DOC_MIME_TYPES.includes(existing_drive_file.mimeType || '')) {
                                    core.debug(` -> Drive file ${existing_drive_file.id} is a Google Doc type.`);
                                    if (existing_drive_file.name !== drive_target_name) {
                                        core.info(`[Rename Queue] Google Doc '${existing_drive_file.name}' to '${drive_target_name}' (ID: ${existing_drive_file.id}).`);
                                        await drive.files.update({ fileId: existing_drive_file.id, requestBody: { name: drive_target_name }, fields: "id,name" });
                                    }
                                    else {
                                        core.debug(` -> Google Doc name matches.`);
                                    }
                                }
                                else {
                                    const drive_file_needs_update = (!existing_drive_file.hash || existing_drive_file.hash !== local_file.hash);
                                    const drive_file_needs_rename = (existing_drive_file.name !== drive_target_name);
                                    if (drive_file_needs_update) {
                                        core.info(`[Update Queue] File content '${local_relative_path}' (ID: ${existing_drive_file.id}).`);
                                        await upload_file(local_file.path, target_folder_id, { id: existing_drive_file.id, name: existing_drive_file.name });
                                    }
                                    else if (drive_file_needs_rename) {
                                        core.info(`[Rename Queue] File '${existing_drive_file.name}' to '${drive_target_name}' (ID: ${existing_drive_file.id}).`);
                                        await drive.files.update({ fileId: existing_drive_file.id, requestBody: { name: drive_target_name }, fields: "id,name" });
                                    }
                                    else {
                                        core.debug(` -> File '${local_relative_path}' matches Drive (ID: ${existing_drive_file.id}).`);
                                    }
                                }
                            }
                        }
                        catch (uploadError) {
                            // Log individual upload errors but don't fail the whole batch necessarily
                            core.error(`Failed processing outgoing file ${local_relative_path}: ${uploadError.message}`);
                            // Optionally mark operation_failed = true here if any upload failure is critical
                        }
                    })()); // Immediately invoke the async function
                    // Simple concurrency limiting
                    if (uploadPromises.length >= CONCURRENT_UPLOADS) {
                        core.debug(`Waiting for batch of ${CONCURRENT_UPLOADS} uploads to finish...`);
                        await Promise.all(uploadPromises);
                        uploadPromises.length = 0; // Reset batch
                    }
                }
                // Wait for any remaining promises in the last batch
                if (uploadPromises.length > 0) {
                    core.debug(`Waiting for final batch of ${uploadPromises.length} uploads to finish...`);
                    await Promise.all(uploadPromises);
                }
                core.info("Finished processing local files for upload/update.");
                // --- Handle Untracked Files/Folders (using the maps from the single listing) ---
                core.info("Handling untracked items in Drive (using initial listing)...");
                // No need to re-list Drive content here!
                const untracked_drive_files = Array.from(drive_files_map.entries()) // <<< Use existing map
                    .filter(([drive_path]) => !files_processed_for_outgoing.has(drive_path));
                const required_folder_paths = new Set(folder_path_to_id_map.keys());
                const untracked_drive_folders = Array.from(drive_folders_map.entries()) // <<< Use existing map
                    .filter(([folder_path]) => folder_path !== "" && !required_folder_paths.has(folder_path));
                core.info(`Found ${untracked_drive_files.length} potentially untracked files and ${untracked_drive_folders.length} potentially untracked folders in Drive.`);
                const all_untracked_items = [
                    ...untracked_drive_files.map(([p, i]) => ({ path: p, item: i, isFolder: false })),
                    ...untracked_drive_folders.map(([p, i]) => ({ path: p, item: i, isFolder: true }))
                ];
                if (all_untracked_items.length > 0) {
                    if (on_untrack_action === "ignore") {
                        core.info(`Ignoring ${all_untracked_items.length} untracked item(s) in Drive as per config.`);
                        all_untracked_items.forEach(u => core.debug(` - Ignored untracked: ${u.path} (ID: ${u.item.id})`));
                    }
                    else {
                        core.info(`Processing ${all_untracked_items.length} untracked items based on on_untrack='${on_untrack_action}'...`);
                        // Process untracked items sequentially for clarity, can be parallelized if needed
                        for (const { path: untracked_path, item: untracked_item, isFolder } of all_untracked_items) {
                            core.info(`Processing untracked ${isFolder ? 'folder' : 'file'} in Drive: ${untracked_path} (ID: ${untracked_item.id}, Owned: ${untracked_item.owned})`);
                            if (!untracked_item.owned) {
                                const owner_info = untracked_item.permissions?.find(p => p.role === 'owner');
                                const current_owner_email = owner_info?.emailAddress;
                                core.warning(`Untracked item '${untracked_path}' (ID: ${untracked_item.id}) is not owned by the service account (Owner: ${current_owner_email || 'unknown'}).`);
                                if (on_untrack_action === 'request' && current_owner_email && current_owner_email !== credentials_json.client_email) {
                                    await request_ownership_transfer(untracked_item.id, current_owner_email);
                                }
                                else if (on_untrack_action === 'remove') {
                                    core.warning(`Cannot remove '${untracked_path}' because it's not owned by the service account. Skipping removal.`);
                                }
                                else {
                                    core.info(`Ignoring untracked, un-owned item '${untracked_path}' (action: ${on_untrack_action}).`);
                                }
                            }
                            else {
                                core.info(`Untracked item '${untracked_path}' is owned by the service account.`);
                                if (on_untrack_action === "remove") {
                                    await delete_untracked(untracked_item.id, untracked_path, isFolder);
                                }
                                else if (on_untrack_action === "request") {
                                    core.info(`Untracked item '${untracked_path}' is already owned. No action needed for 'request'.`);
                                }
                            }
                        }
                    }
                }
                else {
                    core.info("No untracked items found in Drive based on initial listing.");
                }
            }
            else {
                core.info("Step 1 & 2: Skipping outgoing sync (local -> Drive) and untracked handling because trigger event was not 'push'.");
                // needs_recursive_ownership_check remains true (default) for non-push events
            } // End of 'if trigger_event_name === push'
            // *** STEP 3: Accept Pending Ownership Transfers ***
            // Optimization: Only run the recursive check if needed (determined during push trigger list)
            if (needs_recursive_ownership_check) {
                core.info("Step 3: Checking for and accepting pending ownership transfers (recursive check needed)...");
                try {
                    await accept_ownership_transfers(folder_id); // Start recursive check from root
                }
                catch (acceptError) {
                    core.error(`Error during ownership transfer acceptance: ${acceptError.message}`);
                    operation_failed = true;
                }
            }
            else {
                core.info("Step 3: Skipping recursive ownership transfer check as initial list showed all items owned by service account.");
            }
            // *** STEP 4: Handle Incoming Changes from Drive (Drive -> Local PR) ***
            // Always run this, unless a critical error occurred earlier in this target's processing
            if (!operation_failed) {
                core.info("Step 4: Handling potential incoming changes from Drive (Drive -> Local PR)...");
                // Pass the original trigger event name and the untrack action config
                // Store the result which might contain PR details
                // Note: handle_drive_changes includes its own Drive list and comparison logic, optimized separately
                pr_details = await handle_drive_changes(folder_id, on_untrack_action, trigger_event_name, git_user_name, git_user_email);
            }
            else {
                core.warning("Skipping Step 4 (Incoming Changes Check) due to failures in previous steps.");
            }
            // *** STEP 5: Generate Visual Diffs (if enabled and PR was created/updated) ***
            // Logic for this step remains the same
            if (enable_visual_diffs && pr_details.pr_number && pr_details.head_branch && !operation_failed) {
                core.info("Step 5: Generating visual diffs for the created/updated PR...");
                try {
                    let head_sha = github.context.payload.pull_request?.head?.sha;
                    if (!head_sha && github.context.eventName === 'pull_request') {
                        core.warning("Could not get head SHA directly from PR payload context. Trying to fetch...");
                        const pr_data = await octokit.rest.pulls.get({ owner, repo, pull_number: pr_details.pr_number });
                        head_sha = pr_data.data.head.sha;
                    }
                    if (!head_sha) {
                        core.debug(`Could not get head SHA from PR context or direct fetch. Trying ref lookup for branch ${pr_details.head_branch}...`);
                        const ref_data = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${pr_details.head_branch}` });
                        head_sha = ref_data.data.object.sha;
                    }
                    if (!head_sha) {
                        throw new Error(`Could not determine head SHA for branch ${pr_details.head_branch}`);
                    }
                    core.info(`Using head SHA ${head_sha} for visual diff source.`);
                    await generate_visual_diffs_for_pr({
                        octokit, drive,
                        pr_number: pr_details.pr_number, head_branch: pr_details.head_branch, head_sha,
                        owner, repo,
                        output_base_dir: visual_diff_output_dir, link_file_suffix: visual_diff_link_suffix,
                        resolution_dpi: visual_diff_dpi, git_user_name, git_user_email,
                    });
                }
                catch (diffError) {
                    core.error(`Visual diff generation failed: ${diffError.message}`);
                    // Optionally mark target as failed if diffs fail: operation_failed = true;
                }
            }
            else if (enable_visual_diffs) {
                if (operation_failed) {
                    core.info("Skipping Step 5 (Visual Diffs) because previous steps failed.");
                }
                else if (!(pr_details.pr_number && pr_details.head_branch)) {
                    core.info("Skipping Step 5 (Visual Diffs) because no PR was created/updated in Step 4.");
                }
            }
        }
        catch (error) {
            // Catch any unhandled errors from the main steps for this target
            core.error(`Unhandled error during sync process for Drive folder ${folder_id}: ${error.message}`);
            operation_failed = true; // Mark as failed
        }
        finally {
            // Output link regardless of success/failure
            core.setOutput(`drive_link_${folder_id.replace(/[^a-zA-Z0-9]/g, '_')}`, `https://drive.google.com/drive/folders/${folder_id}`);
            core.info(`Sync process finished for Drive folder: ${folder_id}${operation_failed ? ' with errors' : ''}.`);
            core.endGroup(); // End group for this target
        }
    } // End of loop through targets
    core.info("All sync targets processed.");
}
// --- Run the main action ---
sync_main().catch((error) => {
    // Catch top-level errors (e.g., config loading, auth setup)
    const err = error;
    core.error(`Top-level error caught: ${err.message}`);
    if (err.stack) {
        core.error(err.stack);
    }
    core.setFailed(`Sync action failed: ${err.message}`);
});
