import * as core from "@actions/core";
import * as path from "path";
import * as github from '@actions/github'; // Need this for context

// Lib Imports
import { config, SyncConfig, DriveTarget } from "./libs/config"; // Load config first
import { credentials_json, drive } from "./libs/google-drive/auth"; // Needed for ownership check + drive client
import { octokit } from "./libs/github/auth"; // Get initialized octokit
import { list_local_files } from "./libs/local-files/list";
import { list_drive_files_recursively } from "./libs/google-drive/list";
import { build_folder_structure } from "./libs/google-drive/folders";
import { upload_file } from "./libs/google-drive/files";
import { delete_untracked } from "./libs/google-drive/delete";
import { request_ownership_transfer, accept_ownership_transfers } from "./libs/google-drive/ownership";
import { handle_drive_changes } from "./libs/sync-logic/handle-drive-changes";
import { GOOGLE_DOC_MIME_TYPES } from "./libs/google-drive/file_types";
import { DriveItem } from "./libs/google-drive/types";
import { generate_visual_diffs_for_pr } from './libs/visual-diffs/generate_visual_diffs';

// --- Get Inputs ---
const trigger_event_name = core.getInput('trigger_event_name', { required: true });
// Inputs for visual diff generation
const enable_visual_diffs = core.getBooleanInput('enable_visual_diffs', { required: false });
const visual_diff_output_dir = core.getInput('visual_diff_output_dir', { required: false }) || 'visual-diff-output'; // Default directory
const visual_diff_link_suffix = core.getInput('visual_diff_link_suffix', { required: false }) || '.gdrive.json'; // Default suffix matching our creation logic
const visual_diff_dpi = parseInt(core.getInput('visual_diff_dpi', { required: false }) || '150', 10); // Default DPI
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
    let pr_details: { pr_number?: number; head_branch?: string } = {}; // Store PR info for visual diff

    try {
      // *** STEP 1: Sync Outgoing Changes (Local -> Drive) ***
      // Run this only if the trigger was a 'push' event, otherwise skip to incoming.
      if (trigger_event_name === 'push') {
        core.info("Step 1: Processing outgoing changes (local -> Drive) triggered by 'push' event...");

        // --- List current local state and Drive state ---
        core.info("Listing current local files for outgoing sync...");
        const current_local_files = await list_local_files(".");
        const current_local_map = new Map(current_local_files.map(f => [f.relative_path.replace(/\\/g, '/'), f]));
        core.info(`Found ${current_local_map.size} local files for outgoing sync.`);

        core.info("Listing current Drive content for outgoing sync comparison...");
        let drive_files_map_outgoing: Map<string, DriveItem>;
        let drive_folders_map_outgoing: Map<string, DriveItem>;
        try {
          const drive_data_outgoing = await list_drive_files_recursively(folder_id);
          drive_files_map_outgoing = new Map(Array.from(drive_data_outgoing.files.entries()).map(([p, item]) => [p.replace(/\\/g, '/'), item]));
          drive_folders_map_outgoing = new Map(Array.from(drive_data_outgoing.folders.entries()).map(([p, item]) => [p.replace(/\\/g, '/'), item]));
          core.info(`Drive state: ${drive_files_map_outgoing.size} files, ${drive_folders_map_outgoing.size} folders.`);
        } catch (listError) {
          core.error(`Failed list Drive content before outgoing sync: ${(listError as Error).message}. Skipping outgoing sync steps.`);
          operation_failed = true;
          core.endGroup(); // Close group before continuing
          continue; // Skip to next target if listing fails critically
        }

        // --- Build Folder Structure ---
        core.info("Ensuring Drive folder structure matches local structure...");
        let folder_path_to_id_map: Map<string, string>;
        try {
          folder_path_to_id_map = await build_folder_structure(folder_id, current_local_files, drive_folders_map_outgoing);
        } catch (structureError) {
          core.error(`Failed to build Drive folder structure: ${(structureError as Error).message}. Skipping file uploads/updates.`);
          // Continue with untracked handling, but note failure
          operation_failed = true;
          folder_path_to_id_map = new Map([["", folder_id]]); // Basic map for root checks
        }

        // --- Upload/Update Files ---
        core.info("Processing local files for upload/update to Drive...");
        const files_processed_for_outgoing = new Set<string>(); // Track Drive paths corresponding to processed local files

        for (const [local_relative_path, local_file] of current_local_map) {
          core.debug(`Processing local file for outgoing sync: ${local_relative_path}`);

          // Skip link files during outgoing sync - they are generated from Drive, not pushed to it
          if (local_relative_path.endsWith(visual_diff_link_suffix)) {
            core.debug(` -> Skipping GDrive link file: ${local_relative_path}`);
            // We still need to track the *intended* Drive path based on this link file
            // for the untracked check later. Assume link file name structure is <drive_base_name><link_suffix>
            const drive_comparison_path = local_relative_path.substring(0, local_relative_path.length - visual_diff_link_suffix.length);
            files_processed_for_outgoing.add(drive_comparison_path);
            continue;
          }

          // Regular content file
          const drive_comparison_path = local_relative_path;
          files_processed_for_outgoing.add(drive_comparison_path);

          const existing_drive_file = drive_files_map_outgoing.get(drive_comparison_path);
          const drive_target_name = path.basename(drive_comparison_path);

          const local_dir_path = path.dirname(local_relative_path);
          const parent_dir_lookup = (local_dir_path === '.') ? "" : local_dir_path.replace(/\\/g, '/');
          const target_folder_id = folder_path_to_id_map.get(parent_dir_lookup);

          if (!target_folder_id) {
            core.warning(`Could not find target Drive folder ID for local file '${local_relative_path}' (lookup path '${parent_dir_lookup}'). Skipping.`);
            continue;
          }

          // --- Upload/Update Logic ---
          if (!existing_drive_file) {
            core.info(`New file detected locally: '${local_relative_path}'. Uploading to Drive folder ${target_folder_id}.`);
            await upload_file(local_file.path, target_folder_id);
          } else {
            // Compare hash and name for regular files
            if (GOOGLE_DOC_MIME_TYPES.includes(existing_drive_file.mimeType || '')) {
              // If the Drive file is a Google Doc, we don't compare hashes.
              // Check only if the name needs updating based on the local path.
              core.debug(` -> Drive file ${existing_drive_file.id} is a Google Doc type.`);
              if (existing_drive_file.name !== drive_target_name) {
                core.info(`Local path implies Drive file name should be '${drive_target_name}', but it is '${existing_drive_file.name}'. Renaming Drive file (ID: ${existing_drive_file.id}).`);
                try {
                  await drive.files.update({ fileId: existing_drive_file.id, requestBody: { name: drive_target_name }, fields: "id,name" });
                } catch (renameError) {
                  core.warning(`Failed to rename Drive Google Doc ${existing_drive_file.id}: ${(renameError as Error).message}`);
                }
              } else {
                core.debug(` -> Google Doc name matches local path basename. No outgoing action needed.`);
              }
            } else {
              // Regular binary file - compare hash and name
              const drive_file_needs_update = (!existing_drive_file.hash || existing_drive_file.hash !== local_file.hash);
              const drive_file_needs_rename = (existing_drive_file.name !== drive_target_name);

              if (drive_file_needs_update) {
                core.info(`Local file '${local_relative_path}' is newer (hash mismatch or Drive hash missing). Updating Drive file (ID: ${existing_drive_file.id}).`);
                await upload_file(local_file.path, target_folder_id, { id: existing_drive_file.id, name: existing_drive_file.name });
              } else if (drive_file_needs_rename) {
                core.info(`File content matches, but name differs for '${local_relative_path}'. Renaming Drive file '${existing_drive_file.name}' to '${drive_target_name}' (ID: ${existing_drive_file.id}).`);
                try {
                  await drive.files.update({ fileId: existing_drive_file.id, requestBody: { name: drive_target_name }, fields: "id,name" });
                } catch (renameError) {
                  core.warning(`Failed to rename Drive file ${existing_drive_file.id}: ${(renameError as Error).message}`);
                }
              } else {
                core.debug(`Local file '${local_relative_path}' matches Drive file '${existing_drive_file.name}' (ID: ${existing_drive_file.id}). No outgoing sync needed.`);
              }
            }
          }
        } // End of local file loop


        // *** STEP 2: Handle Untracked Files/Folders in Drive (after push sync) ***
        core.info("Step 2: Handling untracked items in Drive (after potential outgoing sync)...");

        // Re-list Drive content *after* potential uploads/renames
        core.info("Re-listing Drive content after outgoing sync for untracked check...");
        try {
          const drive_data_after_sync = await list_drive_files_recursively(folder_id);
          drive_files_map_outgoing = new Map(Array.from(drive_data_after_sync.files.entries()).map(([p, item]) => [p.replace(/\\/g, '/'), item]));
          drive_folders_map_outgoing = new Map(Array.from(drive_data_after_sync.folders.entries()).map(([p, item]) => [p.replace(/\\/g, '/'), item]));
          core.info(`Drive state after sync: ${drive_files_map_outgoing.size} files, ${drive_folders_map_outgoing.size} folders.`);
        } catch (listError) {
          core.error(`Failed re-list Drive content after outgoing sync: ${(listError as Error).message}. Skipping untracked handling.`);
          operation_failed = true;
          core.endGroup(); // Close group before continuing
          continue; // Skip to next target
        }

        // Identify untracked drive files
        const untracked_drive_files = Array.from(drive_files_map_outgoing.entries())
          .filter(([drive_path]) => !files_processed_for_outgoing.has(drive_path));

        // Identify untracked drive folders
        const required_folder_paths = new Set(folder_path_to_id_map.keys());
        const untracked_drive_folders = Array.from(drive_folders_map_outgoing.entries())
          .filter(([folder_path]) => folder_path !== "" && !required_folder_paths.has(folder_path));

        core.info(`Found ${untracked_drive_files.length} potentially untracked files and ${untracked_drive_folders.length} potentially untracked folders in Drive.`);

        const all_untracked_items: { path: string; item: DriveItem; isFolder: boolean }[] = [
          ...untracked_drive_files.map(([p, i]) => ({ path: p, item: i, isFolder: false })),
          ...untracked_drive_folders.map(([p, i]) => ({ path: p, item: i, isFolder: true }))
        ];

        // (Untracked handling logic remains the same as before)
        if (all_untracked_items.length > 0) {
          if (on_untrack_action === "ignore") {
            core.info(`Ignoring ${all_untracked_items.length} untracked item(s) in Drive as per config.`);
            all_untracked_items.forEach(u => core.debug(` - Ignored untracked: ${u.path} (ID: ${u.item.id})`));
          } else {
            core.info(`Processing ${all_untracked_items.length} untracked items based on on_untrack='${on_untrack_action}'...`);
            for (const { path: untracked_path, item: untracked_item, isFolder } of all_untracked_items) {
              core.info(`Processing untracked ${isFolder ? 'folder' : 'file'} in Drive: ${untracked_path} (ID: ${untracked_item.id}, Owned: ${untracked_item.owned})`);

              if (!untracked_item.owned) {
                const owner_info = untracked_item.permissions?.find(p => p.role === 'owner');
                const current_owner_email = owner_info?.emailAddress;
                core.warning(`Untracked item '${untracked_path}' (ID: ${untracked_item.id}) is not owned by the service account (Owner: ${current_owner_email || 'unknown'}).`);
                if (on_untrack_action === 'request' && current_owner_email && current_owner_email !== credentials_json.client_email) {
                  await request_ownership_transfer(untracked_item.id, current_owner_email);
                } else if (on_untrack_action === 'remove') {
                  core.warning(`Cannot remove '${untracked_path}' because it's not owned by the service account. Skipping removal.`);
                } else {
                  core.info(`Ignoring untracked, un-owned item '${untracked_path}' (action: ${on_untrack_action}).`);
                }
              } else {
                core.info(`Untracked item '${untracked_path}' is owned by the service account.`);
                if (on_untrack_action === "remove") {
                  await delete_untracked(untracked_item.id, untracked_path, isFolder);
                } else if (on_untrack_action === "request") {
                  core.info(`Untracked item '${untracked_path}' is already owned. No action needed for 'request'.`);
                }
              }
            }
          }
        } else {
          core.info("No untracked items found in Drive after outgoing sync.");
        }

      } else {
        core.info("Step 1 & 2: Skipping outgoing sync (local -> Drive) and untracked handling because trigger event was not 'push'.");
      } // End of 'if trigger_event_name === push'


      // *** STEP 3: Accept Pending Ownership Transfers ***
      // Always run this, regardless of trigger event
      core.info("Step 3: Checking for and accepting pending ownership transfers...");
      try {
        await accept_ownership_transfers(folder_id); // Start recursive check from root
      } catch (acceptError) {
        // Log error but continue if possible
        core.error(`Error during ownership transfer acceptance: ${(acceptError as Error).message}`);
        operation_failed = true;
      }

      // *** STEP 4: Handle Incoming Changes from Drive (Drive -> Local PR) ***
      // Always run this, unless a critical error occurred earlier
      if (!operation_failed) {
        core.info("Step 4: Handling potential incoming changes from Drive (Drive -> Local PR)...");
        // Pass the original trigger event name and the untrack action config
        // Store the result which might contain PR details
        pr_details = await handle_drive_changes(folder_id, on_untrack_action, trigger_event_name);
      } else {
        core.warning("Skipping Step 4 (Incoming Changes Check) due to failures in previous steps.");
      }

      // *** STEP 5: Generate Visual Diffs (if enabled and PR was created/updated) ***
      if (enable_visual_diffs && pr_details.pr_number && pr_details.head_branch && !operation_failed) {
        core.info("Step 5: Generating visual diffs for the created/updated PR...");
        try {
          // Get the SHA of the head branch from the PR context or fetch it
          let head_sha = github.context.payload.pull_request?.head?.sha;
          if (!head_sha && github.context.eventName === 'pull_request') {
            core.warning("Could not get head SHA directly from PR payload context. Trying to fetch...");
            // Attempt to fetch the head SHA if running in a different context or payload is minimal
            const pr_data = await octokit.rest.pulls.get({ owner, repo, pull_number: pr_details.pr_number });
            head_sha = pr_data.data.head.sha;
          }
          if (!head_sha) {
            // Final attempt: get ref and then SHA
            const ref_data = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${pr_details.head_branch}` });
            head_sha = ref_data.data.object.sha;
          }

          if (!head_sha) {
            throw new Error(`Could not determine head SHA for branch ${pr_details.head_branch}`);
          }
          core.info(`Using head SHA ${head_sha} for visual diff source.`);


          await generate_visual_diffs_for_pr({
            octokit,
            drive,
            pr_number: pr_details.pr_number,
            head_branch: pr_details.head_branch,
            head_sha,
            owner,
            repo,
            output_base_dir: visual_diff_output_dir,
            link_file_suffix: visual_diff_link_suffix,
            resolution_dpi: visual_diff_dpi,
            git_user_name,
            git_user_email,
          });
        } catch (diffError) {
          core.error(`Visual diff generation failed: ${(diffError as Error).message}`);
          // Decide if this should fail the whole target processing
          // operation_failed = true; // Optional: Mark target as failed if diffs fail
        }
      } else if (enable_visual_diffs) {
        if (operation_failed) {
          core.info("Skipping Step 5 (Visual Diffs) because previous steps failed.");
        } else {
          core.info("Skipping Step 5 (Visual Diffs) because no PR was created/updated in Step 4.");
        }
      }

    } catch (error) {
      // Catch any unhandled errors from the main steps for this target
      core.error(`Unhandled error during sync process for Drive folder ${folder_id}: ${(error as Error).message}`);
      operation_failed = true; // Mark as failed
      // Optionally set failed for the whole action if any target fails critically
      // core.setFailed(`Sync failed for folder ${folder_id}`);
    } finally {
      // Output link regardless of success/failure
      core.setOutput(`drive_link_${folder_id.replace(/[^a-zA-Z0-9]/g, '_')}`, `https://drive.google.com/drive/folders/${folder_id}`);
      core.info(`Sync process finished for Drive folder: ${folder_id}${operation_failed ? ' with errors' : ''}.`);
      core.endGroup(); // End group for this target
    }
  } // End of loop through targets

  core.info("All sync targets processed.");
}

// --- Run the main action ---
sync_main().catch((error: unknown) => {
  // Catch top-level errors (e.g., config loading, auth setup)
  const err = error as Error;
  core.error(`Top-level error caught: ${err.message}`);
  if (err.stack) {
    core.error(err.stack);
  }
  core.setFailed(`Sync action failed: ${err.message}`);
});
