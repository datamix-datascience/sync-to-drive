import * as core from "@actions/core";
import * as path from "path";

// Lib Imports
import { config, SyncConfig, DriveTarget } from "./libs/config"; // Load config first
import { credentials_json } from "./libs/google-drive/auth"; // Needed for ownership check
import { list_local_files } from "./libs/local-files/list";
import { list_drive_files_recursively } from "./libs/google-drive/list";
import { build_folder_structure } from "./libs/google-drive/folders";
import { upload_file } from "./libs/google-drive/files";
import { delete_untracked } from "./libs/google-drive/delete";
import { request_ownership_transfer, accept_ownership_transfers } from "./libs/google-drive/ownership";
import { handle_drive_changes } from "./libs/sync-logic/handle-drive-changes";
import { GOOGLE_DOC_MIME_TYPES, MIME_TYPE_TO_EXTENSION } from "./libs/google-drive/shortcuts";
import { DriveItem } from "./libs/google-drive/types";
import { drive } from "./libs/google-drive/auth"; // Needed for direct Drive calls (rename)

// --- Get Trigger Event Name ---
// Read this early, needed by handle_drive_changes
const trigger_event_name = core.getInput('trigger_event_name', { required: true });

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

  // We might list local files again inside the loop for outgoing sync,
  // but an initial list can be useful for early checks if needed.
  // const initial_local_files = await list_local_files(".");
  // core.info(`Found ${initial_local_files.length} initial local files potentially relevant.`);

  for (const target of config.targets.forks) {
    const folder_id = target.drive_folder_id;
    const on_untrack_action = target.on_untrack || "ignore";
    core.startGroup(`Processing Target Drive Folder: ${folder_id} (Untrack Action: ${on_untrack_action})`);
    core.info(`Drive URL: ${target.drive_url || `https://drive.google.com/drive/folders/${folder_id}`}`);

    let operation_failed = false; // Track if any critical part fails for this target

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
          let is_local_shortcut = false;
          let drive_comparison_path = local_relative_path; // Path to compare/find in Drive

          // Check if the *local* file is a shortcut placeholder
          const shortcut_match = local_relative_path.match(/^(.*)\.([a-zA-Z]+)\.json\.txt$/);
          if (shortcut_match && GOOGLE_DOC_MIME_TYPES.some(mime => MIME_TYPE_TO_EXTENSION[mime] === shortcut_match[2])) {
            is_local_shortcut = true;
            drive_comparison_path = shortcut_match[1]; // Use the base path for Drive lookup/comparison
            core.debug(` -> Local file identified as shortcut placeholder. Drive comparison path: ${drive_comparison_path}`);
          }

          files_processed_for_outgoing.add(drive_comparison_path); // Track the path expected in Drive

          const existing_drive_file = drive_files_map_outgoing.get(drive_comparison_path);
          const drive_target_name = path.basename(drive_comparison_path); // The name this file *should* have in Drive

          // Find the parent Drive folder ID using the *local* directory structure
          const local_dir_path = path.dirname(local_relative_path);
          const parent_dir_lookup = (local_dir_path === '.') ? "" : local_dir_path.replace(/\\/g, '/');
          const target_folder_id = folder_path_to_id_map.get(parent_dir_lookup);

          if (!target_folder_id) {
            core.warning(`Could not find target Drive folder ID for local file '${local_relative_path}' (lookup path '${parent_dir_lookup}'). Skipping.`);
            continue;
          }

          // --- Sync Logic ---
          if (is_local_shortcut) {
            // Local file is a shortcut. We DON'T upload its content.
            // We only check if the corresponding Drive file exists and if its name needs updating.
            core.debug(` -> Skipping content upload for local shortcut: ${local_relative_path}`);
            if (existing_drive_file && existing_drive_file.name !== drive_target_name) {
              core.info(`Local shortcut implies Drive file name should be '${drive_target_name}', but it is '${existing_drive_file.name}'. Updating Drive file name (ID: ${existing_drive_file.id}).`);
              try {
                await drive.files.update({ fileId: existing_drive_file.id, requestBody: { name: drive_target_name }, fields: "id,name" });
              } catch (renameError) {
                core.warning(`Failed to rename Drive file ${existing_drive_file.id} based on local shortcut ${local_relative_path}: ${(renameError as Error).message}`);
              }
            } else if (!existing_drive_file) {
              core.warning(`Local shortcut file '${local_relative_path}' exists, but no corresponding file found in Drive at path '${drive_comparison_path}'. Cannot enforce state.`);
            }
            continue; // Move to the next local file
          }

          // --- Regular local file (not a shortcut) ---
          if (!existing_drive_file) {
            // File exists locally, not in Drive -> Upload
            core.info(`New file detected locally: '${local_relative_path}'. Uploading to Drive folder ${target_folder_id}.`);
            await upload_file(local_file.path, target_folder_id);
          } else {
            // File exists in both places. Compare hash and name.
            const drive_file_needs_update = (!existing_drive_file.hash || existing_drive_file.hash !== local_file.hash);
            const drive_file_needs_rename = (existing_drive_file.name !== drive_target_name);

            if (drive_file_needs_update) {
              core.info(`Local file '${local_relative_path}' is newer (hash mismatch or Drive hash missing). Updating Drive file (ID: ${existing_drive_file.id}).`);
              // Pass existing file info for update operation. upload_file handles rename internally if needed.
              await upload_file(local_file.path, target_folder_id, { id: existing_drive_file.id, name: existing_drive_file.name });
            } else if (drive_file_needs_rename) {
              // Hashes match, but name differs. Only rename the Drive file.
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
        } // End of local file loop


        // *** STEP 2: Handle Untracked Files/Folders in Drive (after push sync) ***
        core.info("Step 2: Handling untracked items in Drive (after potential outgoing sync)...");

        // Re-list Drive content *after* potential uploads/renames to get the latest state for untracked check
        core.info("Re-listing Drive content after outgoing sync for untracked check...");
        try {
          const drive_data_after_sync = await list_drive_files_recursively(folder_id);
          drive_files_map_outgoing = new Map(Array.from(drive_data_after_sync.files.entries()).map(([p, item]) => [p.replace(/\\/g, '/'), item]));
          drive_folders_map_outgoing = new Map(Array.from(drive_data_after_sync.folders.entries()).map(([p, item]) => [p.replace(/\\/g, '/'), item]));
          core.info(`Drive state after sync: ${drive_files_map_outgoing.size} files, ${drive_folders_map_outgoing.size} folders.`);
        } catch (listError) {
          core.error(`Failed re-list Drive content after outgoing sync: ${(listError as Error).message}. Skipping untracked handling.`);
          operation_failed = true;
          continue; // Skip to next target
        }


        // Identify untracked items based on the paths processed from local files
        const untracked_drive_files = Array.from(drive_files_map_outgoing.entries())
          .filter(([drive_path]) => !files_processed_for_outgoing.has(drive_path));

        // Check untracked folders: A folder is untracked if its path wasn't required by any processed local file's path
        const required_folder_paths = new Set(folder_path_to_id_map.keys());
        const untracked_drive_folders = Array.from(drive_folders_map_outgoing.entries())
          .filter(([folder_path]) => folder_path !== "" && !required_folder_paths.has(folder_path)); // Exclude root, check if path was needed

        core.info(`Found ${untracked_drive_files.length} potentially untracked files and ${untracked_drive_folders.length} potentially untracked folders in Drive.`);

        const all_untracked_items: { path: string; item: DriveItem; isFolder: boolean }[] = [
          ...untracked_drive_files.map(([p, i]) => ({ path: p, item: i, isFolder: false })),
          ...untracked_drive_folders.map(([p, i]) => ({ path: p, item: i, isFolder: true }))
        ];

        if (all_untracked_items.length > 0) {
          if (on_untrack_action === "ignore") {
            core.info(`Ignoring ${all_untracked_items.length} untracked item(s) in Drive as per config.`);
          } else {
            core.info(`Processing ${all_untracked_items.length} untracked items based on on_untrack='${on_untrack_action}'...`);
            for (const { path: untracked_path, item: untracked_item, isFolder } of all_untracked_items) {
              core.info(`Processing untracked ${isFolder ? 'folder' : 'file'} in Drive: ${untracked_path} (ID: ${untracked_item.id}, Owned: ${untracked_item.owned})`);

              if (!untracked_item.owned) {
                // --- Not owned by service account ---
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
                // --- Owned by service account ---
                core.info(`Untracked item '${untracked_path}' is owned by the service account.`);
                if (on_untrack_action === "remove") {
                  await delete_untracked(untracked_item.id, untracked_path, isFolder);
                } else if (on_untrack_action === "request") {
                  // Already owned, 'request' implies no action needed if owned
                  core.info(`Untracked item '${untracked_path}' is already owned. No action needed for 'request'.`);
                }
                // 'ignore' action is handled by the main 'if' block
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
        await handle_drive_changes(folder_id, on_untrack_action, trigger_event_name);
      } else {
        core.warning("Skipping Step 4 (Incoming Changes Check) due to failures in previous steps.");
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
