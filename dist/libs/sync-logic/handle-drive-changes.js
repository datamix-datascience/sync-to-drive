import * as core from "@actions/core";
import * as path from "path";
import * as fs from "fs";
import { execute_git } from "../git.js";
import { list_local_files } from "../local-files/list.js";
import { list_drive_files_recursively } from "../google-drive/list.js";
import { handle_download_item } from "../google-drive/files.js";
import { create_pull_request_with_retry } from "../github/pull-requests.js";
import { octokit } from "../github/auth.js";
import { GOOGLE_DOC_MIME_TYPES, LINK_FILE_MIME_TYPES } from "../google-drive/file_types.js";
// Helper to safely get repo owner and name
function get_repo_info() {
    const repo_full_name = process.env.GITHUB_REPOSITORY;
    if (!repo_full_name) {
        throw new Error("GITHUB_REPOSITORY environment variable is not set.");
    }
    const [owner, repo] = repo_full_name.split("/");
    if (!owner || !repo) {
        throw new Error(`Could not parse owner and repo from GITHUB_REPOSITORY: ${repo_full_name}`);
    }
    return { owner, repo };
}
// Helper to determine initial branch name *before* the main try block
async function determineInitialBranch(repo_info) {
    let branchName;
    core.info("Determining initial branch name...");
    try {
        // Attempt 1: Git rev-parse
        const current_branch_result = await execute_git('rev-parse', ['--abbrev-ref', 'HEAD'], { silent: true });
        const parsedBranch = current_branch_result.stdout.trim();
        if (parsedBranch && parsedBranch !== 'HEAD') {
            branchName = parsedBranch;
            core.info(`Determined initial branch from git rev-parse: '${branchName}'`);
            return branchName;
        }
        // Attempt 2: GITHUB_REF
        const ref = process.env.GITHUB_REF;
        if (ref && ref.startsWith('refs/heads/')) {
            branchName = ref.substring('refs/heads/'.length);
            core.info(`Using branch name from GITHUB_REF: '${branchName}'`);
            return branchName;
        }
        // Attempt 3: GitHub API default branch
        core.info("Falling back to fetching default branch from GitHub API...");
        const repoData = await octokit.rest.repos.get({ owner: repo_info.owner, repo: repo_info.repo });
        branchName = repoData.data.default_branch;
        if (!branchName) {
            throw new Error("GitHub API did not return a default branch name.");
        }
        core.info(`Using default branch from GitHub API: '${branchName}'`);
        return branchName;
    }
    catch (error) {
        core.error(`Failed to determine initial branch name: ${error.message}`);
        // This is critical, cannot reliably proceed or clean up without the initial branch.
        throw new Error("Could not determine the initial branch. Action cannot continue.");
    }
}
// Handle Drive changes with PR creation
export async function handle_drive_changes(folder_id, on_untrack_action, trigger_event_name) {
    core.info(`Handling potential incoming changes from Drive folder: ${folder_id} (Trigger: ${trigger_event_name}, Untrack action: ${on_untrack_action})`);
    let original_state_branch = ''; // Initialize for finally block safety
    const repo_info = get_repo_info(); // Get repo info early
    const run_id = process.env.GITHUB_RUN_ID || Date.now().toString();
    let result = {}; // Initialize result
    // *** Determine Initial Branch Name FIRST ***
    // This is now outside the main try/finally for sync logic & cleanup.
    // If this fails, the function will exit early.
    const initial_branch = await determineInitialBranch(repo_info);
    try {
        // Step 1: Create temporary state branch
        original_state_branch = `original-state-${folder_id}-${run_id}`;
        core.info(`Initial branch is '${initial_branch}'. Creating temporary state branch '${original_state_branch}'`);
        const initial_commit_hash = (await execute_git('rev-parse', ['HEAD'], { silent: true })).stdout.trim();
        // Ensure the commit hash exists before trying to branch from it
        if (!initial_commit_hash) {
            throw new Error("Could not get initial commit hash.");
        }
        await execute_git("checkout", ["-b", original_state_branch, initial_commit_hash]);
        // Step 2: List local files
        core.info("Listing local files from original state branch...");
        const local_files_list = await list_local_files("."); // List files in the checked-out original state
        const local_map = new Map(local_files_list.map(f => [f.relative_path.replace(/\\/g, '/'), f]));
        core.info(`Found ${local_map.size} relevant local files in original state.`);
        // Case-insensitive lookup map
        const local_lower_to_original_key = new Map();
        local_map.forEach((_, key) => {
            local_lower_to_original_key.set(key.toLowerCase(), key);
        });
        core.debug(`Created lowercase lookup map with ${local_lower_to_original_key.size} entries.`);
        // Step 3: List Drive content
        core.info("Listing Drive content for incoming change comparison...");
        let drive_files;
        let drive_folders;
        try {
            const drive_data = await list_drive_files_recursively(folder_id);
            drive_files = new Map(Array.from(drive_data.files.entries()).map(([p, item]) => [p.replace(/\\/g, '/'), item]));
            drive_folders = new Map(Array.from(drive_data.folders.entries()).map(([p, item]) => [p.replace(/\\/g, '/'), item]));
            core.info(`Found ${drive_files.size} files and ${drive_folders.size} folders in Drive.`);
        }
        catch (error) {
            core.error(`Failed list Drive content for folder ${folder_id}: ${error.message}. Aborting incoming sync logic.`);
            // Jump to finally for cleanup, don't proceed with comparison/PR
            return result; // Return empty result
        }
        // Step 4: Compare Drive state to local state
        const new_files_to_process = [];
        const modified_files_to_process = [];
        const deleted_local_paths = [];
        const found_local_keys = new Set();
        for (const [drive_path, drive_item] of drive_files) {
            core.debug(`Comparing Drive item: '${drive_path}' (ID: ${drive_item.id}, MIME: ${drive_item.mimeType}, modifiedTime: ${drive_item.modifiedTime})`);
            const drive_path_lower = drive_path.toLowerCase();
            const is_google_doc = GOOGLE_DOC_MIME_TYPES.includes(drive_item.mimeType || "");
            const needs_link_file = LINK_FILE_MIME_TYPES.includes(drive_item.mimeType || "");
            const expected_content_path = drive_path;
            const expected_link_path = needs_link_file ? `${drive_path}.gdrive.json` : null;
            const match_content_key = local_lower_to_original_key.get(expected_content_path.toLowerCase());
            const match_link_key = expected_link_path ? local_lower_to_original_key.get(expected_link_path.toLowerCase()) : null;
            const local_content_info = match_content_key ? local_map.get(match_content_key) : undefined;
            const local_link_info = match_link_key ? local_map.get(match_link_key) : undefined;
            let needs_processing = false;
            let reason = "";
            if (is_google_doc) {
                // Google Docs: Expect only .gdrive.json, no content file
                if (local_content_info) {
                    core.warning(`Found unexpected local content file '${match_content_key}' for Google Doc '${drive_path}'. Marking for processing to fix.`);
                    needs_processing = true;
                    if (match_content_key)
                        found_local_keys.add(match_content_key);
                    reason = "unexpected content file";
                }
                if (!local_link_info) {
                    core.debug(` -> Google Doc '${drive_path}' is NEW or missing its link file locally.`);
                    needs_processing = true;
                    reason = "missing link file";
                }
                else {
                    // Check modifiedTime for existing link file
                    if (match_link_key) {
                        found_local_keys.add(match_link_key);
                        try {
                            const link_content = await fs.promises.readFile(match_link_key, "utf-8");
                            core.debug(` -> Existing .gdrive.json content for '${match_link_key}': ${link_content}`);
                            const link_data = JSON.parse(link_content);
                            const stored_modified_time = link_data.modifiedTime;
                            const drive_modified_time = drive_item.modifiedTime;
                            core.debug(` -> Google Doc '${drive_path}' modifiedTime comparison: stored=${stored_modified_time}, drive=${drive_modified_time}`);
                            // Validate modifiedTime format
                            if (drive_modified_time && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*Z$/.test(drive_modified_time)) {
                                core.warning(` -> Invalid modifiedTime format for '${drive_path}': ${drive_modified_time}`);
                                needs_processing = true;
                                reason = "invalid modifiedTime format";
                            }
                            else if (!stored_modified_time || !drive_modified_time) {
                                core.debug(` -> Google Doc '${drive_path}' missing modifiedTime in link file or Drive data. Marking for update.`);
                                needs_processing = true;
                                reason = "missing modifiedTime data";
                            }
                            else if (stored_modified_time !== drive_modified_time) {
                                core.debug(` -> Google Doc '${drive_path}' modified (Drive: ${drive_modified_time}, Local: ${stored_modified_time}). Marking for update.`);
                                needs_processing = true;
                                reason = `modifiedTime mismatch (Drive: ${drive_modified_time}, Local: ${stored_modified_time})`;
                            }
                            else {
                                core.debug(` -> Google Doc '${drive_path}' link file found and modifiedTime matches. No update needed.`);
                            }
                        }
                        catch (error) {
                            core.warning(`Failed to read or parse link file '${match_link_key}': ${error.message}. Marking for update.`);
                            needs_processing = true;
                            reason = "failed to parse link file";
                        }
                    }
                }
            }
            else if (needs_link_file) {
                // PDFs: Expect both content file and .gdrive.json
                if (!local_content_info) {
                    core.debug(` -> PDF '${drive_path}' is NEW or missing its content file locally.`);
                    needs_processing = true;
                    reason = "missing content file";
                }
                else {
                    if (match_content_key)
                        found_local_keys.add(match_content_key);
                    // Check hash for content
                    if (drive_item.hash && local_content_info.hash !== drive_item.hash) {
                        core.debug(` -> PDF '${drive_path}' has hash mismatch (Local: ${local_content_info.hash}, Drive: ${drive_item.hash}). Marking for update.`);
                        needs_processing = true;
                        reason = `content hash mismatch (Local: ${local_content_info.hash}, Drive: ${drive_item.hash})`;
                    }
                    else if (!drive_item.hash) {
                        core.debug(` -> PDF '${drive_path}' in Drive is missing hash. Checking modifiedTime.`);
                        // Fallback to modifiedTime if hash is unavailable
                        if (local_link_info && match_link_key) {
                            found_local_keys.add(match_link_key);
                            try {
                                const link_content = await fs.promises.readFile(match_link_key, "utf-8");
                                core.debug(` -> Existing .gdrive.json content for '${match_link_key}': ${link_content}`);
                                const link_data = JSON.parse(link_content);
                                const stored_modified_time = link_data.modifiedTime;
                                const drive_modified_time = drive_item.modifiedTime;
                                core.debug(` -> PDF '${drive_path}' modifiedTime comparison: stored=${stored_modified_time}, drive=${drive_modified_time}`);
                                // Validate modifiedTime format
                                if (drive_modified_time && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*Z$/.test(drive_modified_time)) {
                                    core.warning(` -> Invalid modifiedTime format for '${drive_path}': ${drive_modified_time}`);
                                    needs_processing = true;
                                    reason = "invalid modifiedTime format";
                                }
                                else if (!stored_modified_time || !drive_modified_time) {
                                    core.debug(` -> PDF '${drive_path}' missing modifiedTime in link file or Drive data. Marking for update.`);
                                    needs_processing = true;
                                    reason = "missing modifiedTime data";
                                }
                                else if (stored_modified_time !== drive_modified_time) {
                                    core.debug(` -> PDF '${drive_path}' modified (Drive: ${drive_modified_time}, Local: ${stored_modified_time}). Marking for update.`);
                                    needs_processing = true;
                                    reason = `modifiedTime mismatch (Drive: ${drive_modified_time}, Local: ${stored_modified_time})`;
                                }
                                else {
                                    core.debug(` -> PDF '${drive_path}' content and modifiedTime match. No update needed.`);
                                }
                            }
                            catch (error) {
                                core.warning(`Failed to read or parse link file '${match_link_key}': ${error.message}. Marking for update.`);
                                needs_processing = true;
                                reason = "failed to parse link file";
                            }
                        }
                        else {
                            core.debug(` -> PDF '${drive_path}' missing link file. Marking for update to create it.`);
                            needs_processing = true;
                            reason = "missing link file";
                        }
                    }
                    else {
                        core.debug(` -> PDF '${drive_path}' content matches based on hash. Checking link file.`);
                        // Check if link file needs update
                        if (!local_link_info) {
                            core.debug(` -> PDF '${drive_path}' missing link file. Marking for update.`);
                            needs_processing = true;
                            reason = "missing link file";
                        }
                        else if (match_link_key) {
                            found_local_keys.add(match_link_key);
                            try {
                                const link_content = await fs.promises.readFile(match_link_key, "utf-8");
                                core.debug(` -> Existing .gdrive.json content for '${match_link_key}': ${link_content}`);
                                const link_data = JSON.parse(link_content);
                                const stored_modified_time = link_data.modifiedTime;
                                const drive_modified_time = drive_item.modifiedTime;
                                core.debug(` -> PDF '${drive_path}' modifiedTime comparison: stored=${stored_modified_time}, drive=${drive_modified_time}`);
                                // Validate modifiedTime format
                                if (drive_modified_time && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*Z$/.test(drive_modified_time)) {
                                    core.warning(` -> Invalid modifiedTime format for '${drive_path}': ${drive_modified_time}`);
                                    needs_processing = true;
                                    reason = "invalid modifiedTime format";
                                }
                                else if (!stored_modified_time || !drive_modified_time) {
                                    core.debug(` -> PDF '${drive_path}' missing modifiedTime in link file or Drive data. Marking for update.`);
                                    needs_processing = true;
                                    reason = "missing modifiedTime data";
                                }
                                else if (stored_modified_time !== drive_modified_time) {
                                    core.debug(` -> PDF '${drive_path}' link file modifiedTime mismatch (Drive: ${drive_modified_time}, Local: ${stored_modified_time}). Marking for update.`);
                                    needs_processing = true;
                                    reason = `modifiedTime mismatch (Drive: ${drive_modified_time}, Local: ${stored_modified_time})`;
                                }
                                else {
                                    core.debug(` -> PDF '${drive_path}' link file modifiedTime matches. No update needed.`);
                                }
                            }
                            catch (error) {
                                core.warning(`Failed to read or parse link file '${match_link_key}': ${error.message}. Marking for update.`);
                                needs_processing = true;
                                reason = "failed to parse link file";
                            }
                        }
                    }
                }
            }
            else {
                // Other binary files: Expect only content file, no .gdrive.json
                if (!local_content_info) {
                    core.debug(` -> Binary file '${drive_path}' is NEW or missing locally.`);
                    needs_processing = true;
                    reason = "missing content file";
                }
                else {
                    if (match_content_key)
                        found_local_keys.add(match_content_key);
                    if (drive_item.hash && local_content_info.hash !== drive_item.hash) {
                        core.debug(` -> Binary file '${drive_path}' has hash mismatch.`);
                        needs_processing = true;
                        reason = `content hash mismatch (Local: ${local_content_info.hash}, Drive: ${drive_item.hash})`;
                    }
                    else if (!drive_item.hash) {
                        core.debug(` -> Binary file '${drive_path}' in Drive is missing hash. Treating as modified.`);
                        needs_processing = true;
                        reason = "Drive item missing hash";
                    }
                    else {
                        core.debug(` -> Binary file '${drive_path}' matches local state based on hash.`);
                        needs_processing = false;
                    }
                }
                if (local_link_info) {
                    core.warning(`Found unexpected local link file '${match_link_key}' for non-PDF, non-Google Doc '${drive_path}'. Scheduling for deletion.`);
                    if (match_link_key) {
                        found_local_keys.add(match_link_key);
                        deleted_local_paths.push(match_link_key);
                    }
                }
            }
            if (needs_processing) {
                core.info(`Change detected for ${is_google_doc ? "Google Doc" : needs_link_file ? "PDF" : "binary file"} '${drive_path}': ${reason}. Marking for processing.`);
                if (local_content_info || local_link_info) {
                    modified_files_to_process.push({ path: drive_path, item: drive_item });
                }
                else {
                    new_files_to_process.push({ path: drive_path, item: drive_item });
                }
            }
        }
        // Step 5: Identify deletions
        core.debug("Checking for items deleted in Drive...");
        for (const [local_key, _local_file_info] of local_map) {
            if (!found_local_keys.has(local_key)) {
                // Check if it's a .gdrive.json file whose corresponding content file *was* found
                // Example: local has `image.png` and `image.png.gdrive.json`. Drive has `image.png`.
                // We should *not* delete `image.png.gdrive.json` in this case.
                if (local_key.endsWith('.gdrive.json')) {
                    const base_content_path = local_key.substring(0, local_key.length - '.gdrive.json'.length);
                    if (found_local_keys.has(base_content_path)) {
                        core.debug(`Keeping link file '${local_key}' as its content file '${base_content_path}' was found.`);
                        continue; // Don't add this link file to deletions
                    }
                }
                core.info(`Deletion detected: Local item '${local_key}' not found during Drive scan.`);
                deleted_local_paths.push(local_key);
            }
        }
        // Folder deletion check (remains the same logic conceptually)
        const local_folders = new Set();
        local_files_list.forEach(f => {
            // Derive folder paths from both content and link files
            const paths_to_check = [f.relative_path];
            if (f.relative_path.endsWith('.gdrive.json')) {
                const base_path = f.relative_path.substring(0, f.relative_path.length - '.gdrive.json'.length);
                paths_to_check.push(base_path);
            }
            paths_to_check.forEach(p => {
                let dir = path.dirname(p);
                while (dir && dir !== '.') {
                    local_folders.add(dir.replace(/\\/g, '/'));
                    dir = path.dirname(dir);
                }
            });
        });
        core.debug(`Local folders derived from file paths: ${[...local_folders].join(', ')}`);
        for (const local_folder_path of local_folders) {
            if (!drive_folders.has(local_folder_path) && !deleted_local_paths.some(p => p === local_folder_path || p.startsWith(local_folder_path + '/'))) {
                // Check if *any* file (content or link) *or* Drive folder still exists under this local path prefix in Drive
                const folder_still_relevant_in_drive = [...drive_files.keys()].some(drive_path => drive_path.startsWith(local_folder_path + '/')) ||
                    [...drive_folders.keys()].some(drive_folder => drive_folder.startsWith(local_folder_path + '/'));
                if (!folder_still_relevant_in_drive) {
                    core.info(`Deletion detected: Local folder structure '${local_folder_path}' seems entirely removed from Drive.`);
                    if (!deleted_local_paths.includes(local_folder_path)) {
                        // Add the folder itself for deletion if it's not already covered
                        deleted_local_paths.push(local_folder_path);
                    }
                }
            }
        }
        core.info(`Identified ${deleted_local_paths.length} local paths corresponding to items potentially deleted/renamed in Drive.`);
        // Step 6: Apply changes locally and stage them
        let changes_made = false;
        const added_or_updated_paths_final = new Set();
        const removed_paths_final = new Set();
        // Handle Deletions
        const should_remove = trigger_event_name !== 'push' && on_untrack_action === 'remove';
        if (deleted_local_paths.length > 0) {
            if (should_remove) {
                core.info(`Processing ${deleted_local_paths.length} local items to remove...`);
                // Sort paths to remove directories after files
                deleted_local_paths.sort((a, b) => b.length - a.length);
                for (const local_path_to_delete of deleted_local_paths) {
                    try {
                        // Check existence relative to current working directory
                        if (!fs.existsSync(local_path_to_delete)) {
                            core.debug(`Local item '${local_path_to_delete}' already removed or doesn't exist. Skipping git rm.`);
                            // Ensure it's not marked for addition if it was somehow added before deletion check
                            added_or_updated_paths_final.delete(local_path_to_delete);
                            continue;
                        }
                        core.info(`Removing local item: ${local_path_to_delete}`);
                        // Use git rm with recursive flag and force for directories/files
                        // --ignore-unmatch prevents errors if the file is already gone (e.g., deleted manually or by a previous step)
                        await execute_git("rm", ["-rf", "--ignore-unmatch", "--", local_path_to_delete]);
                        removed_paths_final.add(local_path_to_delete);
                        // If we remove a file, ensure it's not also marked as added/updated
                        added_or_updated_paths_final.delete(local_path_to_delete);
                        changes_made = true;
                    }
                    catch (error) {
                        core.error(`Failed to stage deletion of ${local_path_to_delete}: ${error.message}`);
                    }
                }
            }
            else {
                const reason = trigger_event_name === 'push' ? `trigger was 'push'` : `'on_untrack' is '${on_untrack_action}'`;
                core.info(`Found ${deleted_local_paths.length} item(s) locally but not in Drive. Skipping removal because ${reason}.`);
                deleted_local_paths.forEach(fp => core.info(`  - Skipped removal: ${fp}`));
            }
        }
        // Handle New and Modified Files
        const items_to_process = [...new_files_to_process, ...modified_files_to_process];
        core.info(`Processing ${new_files_to_process.length} new and ${modified_files_to_process.length} modified items from Drive...`);
        for (const { path: original_drive_path, item: drive_item } of items_to_process) {
            // Determine the target local path for the *content*
            // The link file path will be derived from this using the Drive item's name
            const target_content_local_path = original_drive_path;
            core.info(`Handling Drive item: ${drive_item.name || `(ID: ${drive_item.id})`} -> Target local content path: ${target_content_local_path}`);
            try {
                // Ensure parent directory for the *content* path exists
                const local_dir = path.dirname(target_content_local_path);
                if (local_dir && local_dir !== '.') {
                    await fs.promises.mkdir(local_dir, { recursive: true });
                }
                // Handle download/linking - creates link file and potentially content file
                const { linkFilePath, contentFilePath } = await handle_download_item(drive_item, target_content_local_path);
                // Helper to stage files and track changes
                const stage_file = async (file_path_to_stage) => {
                    if (!file_path_to_stage)
                        return;
                    // Check if file actually exists before staging
                    if (!fs.existsSync(file_path_to_stage)) {
                        core.warning(`Attempted to stage file '${file_path_to_stage}' but it does not exist.`);
                        return;
                    }
                    core.info(`Staging added/updated file: ${file_path_to_stage}`);
                    // Debug: Check Git ignore status
                    const ignore_check = await execute_git("check-ignore", [file_path_to_stage], { ignoreReturnCode: true });
                    core.debug(`Git check-ignore for '${file_path_to_stage}': ${ignore_check.stdout || "not ignored"}`);
                    await execute_git("add", ["--", file_path_to_stage]);
                    // Debug: Verify staging
                    const add_status = await execute_git("status", ["--porcelain", "--", file_path_to_stage], { ignoreReturnCode: true });
                    core.debug(`Git status after adding '${file_path_to_stage}':\n${add_status.stdout}`);
                    // Debug: Log file content
                    try {
                        const content = await fs.promises.readFile(file_path_to_stage, "utf-8");
                        core.debug(`Staged file content for '${file_path_to_stage}': ${content}`);
                    }
                    catch (error) {
                        core.debug(`Could not read staged file '${file_path_to_stage}' (binary or error): ${error.message}`);
                    }
                    added_or_updated_paths_final.add(file_path_to_stage);
                    changes_made = true;
                    // If this file was previously marked for removal, unmark it
                    if (removed_paths_final.has(file_path_to_stage)) {
                        core.debug(`Path ${file_path_to_stage} was staged, removing from final deletion list.`);
                        removed_paths_final.delete(file_path_to_stage);
                    }
                };
                // Stage the generated link file and content file (if created)
                await stage_file(linkFilePath);
                await stage_file(contentFilePath);
            }
            catch (error) {
                core.error(`Failed to process/stage item from Drive ${drive_item.name || `(ID: ${drive_item.id})`} to ${target_content_local_path}: ${error.message}`);
            }
        }
        // Step 7: Commit, Push, and Create PR
        const status_result = await execute_git('status', ['--porcelain']);
        if (!status_result.stdout.trim()) {
            core.info("Git status clean after processing changes. No commit needed.");
            return result;
        }
        else {
            core.info("Git status is not clean, proceeding with commit.");
            core.debug("Git status output:\n" + status_result.stdout);
            // Update changes_made flag if status shows changes but the flag wasn't set
            if (!changes_made) {
                core.debug("Git status shows changes, ensuring changes_made flag is set.");
                changes_made = true;
            }
        }
        // Proceed only if changes_made is true (set during add/rm or by status check)
        if (!changes_made) {
            core.info("No effective file changes detected after final status check. Skipping commit and PR.");
            return result;
        }
        core.info("Changes detected originating from Drive. Proceeding with commit and PR.");
        const commit_messages = [`Sync changes from Google Drive (${folder_id})`];
        // Use the final sets for the commit message
        if (added_or_updated_paths_final.size > 0)
            commit_messages.push(`- Add/Update: ${[...added_or_updated_paths_final].map(p => `'${p}'`).join(", ")}`);
        if (removed_paths_final.size > 0)
            commit_messages.push(`- Remove: ${[...removed_paths_final].map(p => `'${p}'`).join(", ")}`);
        commit_messages.push(`\nSource Drive Folder ID: ${folder_id}`);
        commit_messages.push(`Workflow Run ID: ${run_id}`);
        const commit_message = commit_messages.join("\n");
        try {
            await execute_git("config", ["--local", "user.email", "github-actions[bot]@users.noreply.github.com"]);
            await execute_git("config", ["--local", "user.name", "github-actions[bot]"]);
            core.info("Committing changes on temporary branch...");
            await execute_git("commit", ["-m", commit_message]);
            const sync_commit_hash = (await execute_git('rev-parse', ['HEAD'], { silent: true })).stdout.trim();
            core.info(`Created sync commit ${sync_commit_hash} on temporary branch '${original_state_branch}'.`);
            // --- Prepare PR Branch ---
            const sanitized_folder_id = folder_id.replace(/[^a-zA-Z0-9_-]/g, '_');
            const head_branch = `sync-from-drive-${sanitized_folder_id}`;
            core.info(`Preparing PR branch: ${head_branch}`);
            // Check existence of local and remote branch
            const local_branch_exists_check = await execute_git('show-ref', ['--verify', `refs/heads/${head_branch}`], { ignoreReturnCode: true, silent: true });
            const remote_branch_exists_check = await execute_git('ls-remote', ['--exit-code', '--heads', 'origin', head_branch], { ignoreReturnCode: true, silent: true });
            const local_branch_exists = local_branch_exists_check.exitCode === 0;
            const remote_branch_exists = remote_branch_exists_check.exitCode === 0;
            // Create or checkout the head branch pointing to the temporary commit
            if (local_branch_exists) {
                core.info(`Branch ${head_branch} exists locally. Checking it out...`);
                await execute_git("checkout", [head_branch]);
                // Resetting ensures it points exactly to the new commit, even if the branch existed.
                core.info(`Resetting existing local branch ${head_branch} to sync commit ${sync_commit_hash}...`);
                await execute_git("reset", ["--hard", sync_commit_hash]);
            }
            else if (remote_branch_exists) {
                core.info(`Branch ${head_branch} exists remotely but not locally. Fetching and checking out...`);
                try {
                    await execute_git("fetch", ["origin", `${head_branch}:${head_branch}`]);
                    await execute_git("checkout", [head_branch]);
                    core.info(`Resetting fetched branch ${head_branch} to sync commit ${sync_commit_hash}...`);
                    await execute_git("reset", ["--hard", sync_commit_hash]);
                }
                catch (fetchCheckoutError) {
                    core.warning(`Failed to fetch/checkout/reset remote branch ${head_branch}. Creating new local branch from commit hash as fallback. Error: ${fetchCheckoutError.message}`);
                    await execute_git("checkout", ["-b", head_branch, sync_commit_hash]); // Create new branch from hash
                }
            }
            else {
                core.info(`Branch ${head_branch} does not exist locally or remotely. Creating it from commit hash...`);
                await execute_git("checkout", ["-b", head_branch, sync_commit_hash]); // Create new branch from hash
            }
            // --- Push and PR ---
            core.info(`Pushing branch ${head_branch} to origin...`);
            await execute_git("push", ["--force", "origin", head_branch]);
            const pr_title = `Sync changes from Google Drive (${folder_id})`;
            const pr_body_lines = [
                `This PR syncs changes detected in Google Drive folder [${folder_id}](https://drive.google.com/drive/folders/${folder_id}):`,
                ...(added_or_updated_paths_final.size > 0 ? [`*   **Added/Updated:** ${[...added_or_updated_paths_final].map(p => `\`${p}\``).join(", ")}`] : []),
                ...(removed_paths_final.size > 0 ? [`*   **Removed:** ${[...removed_paths_final].map(p => `\`${p}\``).join(", ")}`] : []),
                `\n*Source Drive Folder ID: ${folder_id}*`,
                `*Workflow Run ID: ${run_id}*`
            ];
            const pr_body = pr_body_lines.filter(line => line && line.trim() !== '').join('\n');
            const pr_params = {
                owner: repo_info.owner,
                repo: repo_info.repo,
                title: pr_title,
                head: head_branch,
                base: initial_branch,
                body: pr_body
            };
            core.info(`Attempting to create or update Pull Request: ${pr_title} (${head_branch} -> ${initial_branch})`);
            const pr_result = await create_pull_request_with_retry(octokit, pr_params);
            if (pr_result) {
                core.info(`Pull request operation successful: ${pr_result.url}`);
                // Store the result for the visual diff step
                result = { pr_number: pr_result.number, head_branch: head_branch };
            }
            else {
                core.info("Pull request was not created or updated (e.g., no diff).");
                // Ensure result is empty if PR op wasn't successful
                result = {};
            }
        }
        catch (error) {
            core.error(`Failed during commit, push, or PR creation: ${error.message}`);
            result = {};
        }
    }
    catch (error) {
        core.error(`Error during Drive change handling for folder ${folder_id}: ${error.message}`);
        result = {};
    }
    finally {
        core.info(`Cleaning up temporary branch '${original_state_branch}' and returning to '${initial_branch}'`);
        try {
            const current_cleanup_branch_result = await execute_git('rev-parse', ['--abbrev-ref', 'HEAD'], { silent: true, ignoreReturnCode: true });
            const current_cleanup_branch = current_cleanup_branch_result.stdout.trim();
            // Only checkout if not already on the initial branch
            if (current_cleanup_branch !== initial_branch) {
                core.info(`Currently on branch '${current_cleanup_branch || 'detached HEAD'}', checking out initial branch '${initial_branch}'...`);
                // Use --force checkout to discard potential failed changes from try block
                await execute_git("checkout", ["--force", initial_branch]);
            }
            else {
                core.info(`Already on initial branch '${initial_branch}'.`);
            }
            // Delete the temporary state branch if it exists
            if (original_state_branch) {
                const branch_check = await execute_git('show-ref', ['--verify', `refs/heads/${original_state_branch}`], { ignoreReturnCode: true, silent: true });
                if (branch_check.exitCode === 0) {
                    core.info(`Deleting temporary state branch '${original_state_branch}'...`);
                    await execute_git("branch", ["-D", original_state_branch]);
                }
                else {
                    core.debug(`Temporary state branch '${original_state_branch}' not found for deletion (already deleted or never created?).`);
                }
            }
        }
        catch (checkoutError) {
            core.warning(`Failed to fully clean up Git state (checkout initial branch or delete temp branch). Manual cleanup may be needed. Error: ${checkoutError.message}`);
        }
    }
    // Return the result (contains PR info if successful)
    return result;
}
