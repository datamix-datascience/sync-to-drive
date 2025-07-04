import * as core from "@actions/core";
import * as github from "@actions/github"; // Need this for context
import * as fs from "fs/promises"; // Need this for reading link files
import * as path from "path";

// Lib Imports
import { config } from "./libs/config.js"; // Load config first
import {
  getChangedImageFiles,
  postSeparatedPRComments,
} from "./libs/gemini/slide-compare.js";
import { octokit } from "./libs/github/auth.js"; // Get initialized octokit
import { credentials_json, drive } from "./libs/google-drive/auth.js"; // Needed for ownership check + drive client
import { delete_untracked } from "./libs/google-drive/delete.js";
import {
  GOOGLE_DOC_MIME_TYPES,
  MIME_TYPE_TO_EXTENSION,
} from "./libs/google-drive/file_types.js"; // Use MIME_TYPE_TO_EXTENSION for regex
import { upload_file } from "./libs/google-drive/files.js";
import { build_folder_structure } from "./libs/google-drive/folders.js";
import { list_drive_files_recursively } from "./libs/google-drive/list.js";
import {
  accept_ownership_transfers,
  request_ownership_transfer,
} from "./libs/google-drive/ownership.js";
import { DriveItem } from "./libs/google-drive/types.js";
import { list_local_files } from "./libs/local-files/list.js";
import { handle_drive_changes } from "./libs/sync-logic/handle-drive-changes.js";
import { FileInfo } from "./libs/types.js";
import { generate_visual_diffs_for_pr } from "./libs/visual-diffs/generate_visual_diffs.js";

// --- Get Inputs ---
const trigger_event_name = core.getInput("trigger_event_name", {
  required: true,
});
// Inputs for visual diff generation
const enable_visual_diffs = core.getBooleanInput("enable_visual_diffs", {
  required: false,
});
const visual_diff_output_dir =
  core.getInput("visual_diff_output_dir", { required: false }) || "_diff_"; // Default directory
const visual_diff_link_suffix =
  core.getInput("visual_diff_link_suffix", { required: false }) ||
  ".gdrive.json"; // Default suffix matching our creation logic
const visual_diff_dpi = parseInt(
  core.getInput("visual_diff_dpi", { required: false }) || "72",
  10,
); // Default DPI
const git_user_name =
  core.getInput("git_user_name", { required: false }) || "github-actions[bot]";
const git_user_email =
  core.getInput("git_user_email", { required: false }) ||
  "github-actions[bot]@users.noreply.github.com";
// Inputs for slide comparison
const enable_slide_compare = core.getBooleanInput("enable_slide_compare", {
  required: false,
});
const gemini_api_key = core.getInput("gemini_api_key", { required: false });

// STEP 0: Define interface for the expected structure of the link file
interface GDriveLinkData {
  id: string;
  name: string; // The original name of the file in Drive
  modifiedTime: string;
  mimeType?: string; // Mime type is helpful for reconstruction
}

// STEP 0: Define Regex for matching link files based on the construct_link_file_name format
// Matches: "basename--ID.type.gdrive.json"
// e.g., "Report--XYZ123.doc.gdrive.json"
const known_extensions_regex_part = Object.values(MIME_TYPE_TO_EXTENSION).join(
  "|",
);
// Be careful with paths containing '--' in the base name itself. The regex needs to be somewhat specific.
// It looks for '--', then likely ID chars (alphanumeric, -, _), then a dot, known extension, then the final suffix.
const LINK_FILE_REGEX = new RegExp(
  `--[a-zA-Z0-9_-]+\\.(${known_extensions_regex_part})${visual_diff_link_suffix.replace(
    ".",
    "\\.",
  )}$`,
);

// STEP 0: Define function to parse link files and create mapping
/**
 * Parses local files matching the link file pattern, extracts Drive metadata,
 * and returns a map linking Drive file paths to their last known Drive state.
 * @param local_files List of local files found in the repository.
 * @param link_file_regex Regex to identify link files (e.g., based on *--ID.type.gdrive.json).
 * @returns A map where keys are Drive file relative paths (e.g., 'docs/My Doc.docx')
 *          and values are objects containing the Drive file ID and modified time.
 */
async function create_link_file_data_map(
  local_files: FileInfo[],
  link_file_regex: RegExp,
): Promise<Map<string, { drive_id: string; drive_modified_time: string }>> {
  const link_data_map = new Map<
    string,
    { drive_id: string; drive_modified_time: string }
  >();
  core.info(`Parsing local link files using regex: ${link_file_regex.source}`);

  for (const file of local_files) {
    // Use regex to check if the filename matches the expected link file pattern
    if (link_file_regex.test(file.relative_path)) {
      core.debug(` -> Potential link file found: ${file.relative_path}`);
      try {
        const content = await fs.readFile(file.path, "utf-8");
        const data = JSON.parse(content) as GDriveLinkData;
        // Ensure essential data is present before adding to the map
        if (data.id && data.modifiedTime && data.name) {
          // Reconstruct the *Drive* path using the directory of the link file and the name from the JSON content
          const link_dir = path.dirname(file.relative_path);
          const drive_file_path =
            link_dir === "." ? data.name : path.join(link_dir, data.name);
          // Normalize path separators
          const normalized_drive_path = drive_file_path.replace(/\\/g, "/");

          link_data_map.set(normalized_drive_path, {
            drive_id: data.id,
            drive_modified_time: data.modifiedTime,
          });
          core.debug(
            `    -> Found link data for Drive path '${normalized_drive_path}': ID=${data.id}, ModifiedTime=${data.modifiedTime}`,
          );
        } else {
          core.warning(
            `Skipping link file '${file.relative_path}' due to missing 'id', 'modifiedTime', or 'name' fields in JSON content.`,
          );
        }
      } catch (error) {
        core.warning(
          `Failed to read or parse link file '${file.relative_path}': ${
            (error as Error).message
          }`,
        );
      }
    }
  }
  core.info(`Found link data for ${link_data_map.size} Drive files.`);
  return link_data_map;
}

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
      core.setFailed(
        `Invalid visual_diff_dpi: ${core.getInput(
          "visual_diff_dpi",
        )}. Must be a positive number.`,
      );
      return;
    }
    if (!visual_diff_link_suffix.startsWith(".")) {
      core.setFailed(
        `Invalid visual_diff_link_suffix: "${visual_diff_link_suffix}". Should start with a dot.`,
      );
      return;
    }
    core.info(
      `Visual Diff Settings: Output Dir='${visual_diff_output_dir}', Link Suffix='${visual_diff_link_suffix}', DPI=${visual_diff_dpi}`,
    );
  }

  for (const target of config.targets.forks) {
    const folder_id = target.drive_folder_id;
    const on_untrack_action = target.on_untrack || "ignore";
    core.startGroup(
      `Processing Target Drive Folder: ${folder_id} (Untrack Action: ${on_untrack_action})`,
    );
    core.info(
      `Drive URL: ${
        target.drive_url ||
        `https://drive.google.com/drive/folders/${folder_id}`
      }`,
    );

    let operation_failed = false; // Track if any critical part fails for this target
    let pr_details: { pr_number?: number; head_branch?: string } = {}; // Store PR info for visual diff
    let needs_recursive_ownership_check = true; // Default to true, potentially set to false during push event

    try {
      // *** STEP 1 & 2: Sync Outgoing Changes & Handle Untracked (Push Trigger Only) ***
      if (trigger_event_name === "push") {
        core.info(
          "Step 1 & 2: Processing outgoing changes and untracked items (push trigger)...",
        );

        // STEP 1.1: List current local state
        core.info("Listing current local files for outgoing sync...");
        const current_local_files = await list_local_files(".");
        const current_local_map = new Map(
          current_local_files.map((f) => [
            f.relative_path.replace(/\\/g, "/"),
            f,
          ]),
        );
        core.info(
          `Found ${current_local_map.size} local files for outgoing sync.`,
        );

        // STEP 1.2: Parse link files to get last known Drive state (if visual diffs enabled)
        let link_file_data_map = new Map<
          string,
          { drive_id: string; drive_modified_time: string }
        >();
        if (enable_visual_diffs) {
          // Create the map using the new function and the regex
          link_file_data_map = await create_link_file_data_map(
            current_local_files,
            LINK_FILE_REGEX,
          );
        } else {
          core.info("Skipping link file parsing as visual diffs are disabled.");
        }

        // STEP 1.3: List Drive state ONCE
        core.info(
          "Listing current Drive content ONCE for comparison and untracked check...",
        );
        let drive_files_map: Map<string, DriveItem>;
        let drive_folders_map: Map<string, DriveItem>;
        let initial_list_found_unowned = false; // Flag for ownership check optimization

        try {
          // Ensure modifiedTime is requested for the comparison check later
          const drive_data = await list_drive_files_recursively(folder_id);
          // Create drive_files_map from drive_data.files array
          drive_files_map = new Map(
            drive_data.files.map((file) => [
              file.path.replace(/\\/g, "/"), // Normalize path to use forward slashes
              file.item, // The DriveItem (file object)
            ]),
          );
          // Create drive_folders_map from drive_data.folders (assuming it's similar)
          drive_folders_map = new Map(
            Array.from(drive_data.folders.entries()).map(([p, item]) => [
              p.replace(/\\/g, "/"),
              item,
            ]),
          );

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
              if (!item.owned && item.id !== folder_id) {
                // Ignore root folder ownership itself
                initial_list_found_unowned = true;
                core.debug(
                  `Found unowned folder: ${item.name} (ID: ${item.id})`,
                );
                break; // Found one, no need to check further folders
              }
            }
          }
          // Set the flag for Step 3 based on this check
          needs_recursive_ownership_check = initial_list_found_unowned;
          core.info(
            `Initial Drive state: ${drive_files_map.size} files, ${drive_folders_map.size} folders. Needs recursive ownership check: ${needs_recursive_ownership_check}`,
          );
        } catch (listError) {
          core.error(
            `Failed list Drive content: ${
              (listError as Error).message
            }. Skipping outgoing sync steps.`,
          );
          operation_failed = true;
          needs_recursive_ownership_check = true; // Assume check is needed if list fails
          core.endGroup();
          continue; // Skip to next target
        }

        // STEP 1.4: Build Folder Structure
        core.info("Ensuring Drive folder structure matches local structure...");
        let folder_path_to_id_map: Map<string, string>;
        try {
          folder_path_to_id_map = await build_folder_structure(
            folder_id,
            current_local_files,
            drive_folders_map,
          ); // Pass existing map
        } catch (structureError) {
          core.error(
            `Failed to build Drive folder structure: ${
              (structureError as Error).message
            }. Skipping file uploads/updates.`,
          );
          operation_failed = true;
          folder_path_to_id_map = new Map([["", folder_id]]);
        }

        // STEP 1.5: Upload/Update Files (with modifiedTime check)
        core.info("Processing local files for upload/update to Drive...");
        const files_processed_for_outgoing = new Set<string>(); // Track Drive paths corresponding to processed local files

        // Use Promise.all for potential parallel uploads (adjust concurrency as needed)
        const uploadPromises = [];
        const CONCURRENT_UPLOADS = 5; // Limit concurrency to avoid rate limits

        for (const [local_relative_path, local_file] of current_local_map) {
          // Push an async function to the promises array
          uploadPromises.push(
            (async () => {
              if (local_relative_path.endsWith(".gdrive.json")) {
                core.debug(
                  ` -> Skipping exported JSON file: ${local_relative_path}`,
                );
                return; // Skip upload/processing for this file type
              }

              core.debug(
                `Processing local file for outgoing sync: ${local_relative_path}`,
              );
              // Check if it's a link file first (these are handled by parsing, not upload)
              if (
                enable_visual_diffs &&
                LINK_FILE_REGEX.test(local_relative_path)
              ) {
                core.debug(
                  ` -> Skipping GDrive link file itself: ${local_relative_path}`,
                );
                // Try to determine the *source* path it corresponds to by parsing its content
                let source_path: string | null = null;
                try {
                  const content = await fs.readFile(local_file.path, "utf-8");
                  const data = JSON.parse(content) as GDriveLinkData;
                  if (data.name) {
                    const link_dir = path.dirname(local_relative_path);
                    source_path =
                      link_dir === "."
                        ? data.name
                        : path.join(link_dir, data.name);
                    source_path = source_path.replace(/\\/g, "/"); // Normalize
                  }
                } catch (parseError) {
                  core.warning(
                    `Could not parse link file ${local_relative_path} to determine source path for untracked logic: ${
                      (parseError as Error).message
                    }`,
                  );
                }
                // Mark the *source* path as processed *if* we could determine it.
                // This prevents the Drive file from being wrongly marked as untracked if the
                // local source file was deleted but the link file hasn't been removed yet.
                if (source_path) {
                  files_processed_for_outgoing.add(source_path);
                  core.debug(
                    ` -> Marking corresponding Drive path '${source_path}' as processed based on link file.`,
                  );
                }
                return; // Skip actual upload of the link file
              }

              const drive_comparison_path = local_relative_path; // Use the normalized path
              files_processed_for_outgoing.add(drive_comparison_path); // Track that we are considering this path for potential upload/update

              const existing_drive_file = drive_files_map.get(
                drive_comparison_path,
              );
              const drive_target_name = path.basename(drive_comparison_path);
              const local_dir_path = path.dirname(local_relative_path);
              const parent_dir_lookup =
                local_dir_path === "."
                  ? ""
                  : local_dir_path.replace(/\\/g, "/");
              const target_folder_id =
                folder_path_to_id_map.get(parent_dir_lookup);

              if (!target_folder_id) {
                core.warning(
                  `Could not find target Drive folder ID for local file '${local_relative_path}' (lookup path '${parent_dir_lookup}'). Skipping.`,
                );
                return;
              }

              try {
                // STEP 1.5.1: Check if Drive has a newer version based on link file data
                // This check only runs if visual diffs are enabled (implying link files exist),
                // and if the file exists on Drive with a modification time.
                if (enable_visual_diffs && existing_drive_file?.modifiedTime) {
                  const link_data = link_file_data_map.get(
                    drive_comparison_path,
                  );
                  if (link_data?.drive_modified_time) {
                    // Parse timestamps for comparison
                    const drive_mod_time_ms = Date.parse(
                      existing_drive_file.modifiedTime,
                    );
                    const link_mod_time_ms = Date.parse(
                      link_data.drive_modified_time,
                    );

                    // Perform the check only if both timestamps are valid
                    if (
                      !isNaN(drive_mod_time_ms) &&
                      !isNaN(link_mod_time_ms) &&
                      drive_mod_time_ms > link_mod_time_ms
                    ) {
                      core.warning(
                        `[Skip Upload] Drive file '${drive_comparison_path}' (ID: ${existing_drive_file.id}) modified at ${existing_drive_file.modifiedTime} is newer than local sync state recorded at ${link_data.drive_modified_time}.`,
                      );
                      // Skip the rest of the upload/update logic for this file
                      return;
                    } else if (
                      isNaN(drive_mod_time_ms) ||
                      isNaN(link_mod_time_ms)
                    ) {
                      core.warning(
                        `Could not parse timestamps for comparison for ${drive_comparison_path}. Drive: ${existing_drive_file.modifiedTime}, Link: ${link_data.drive_modified_time}. Proceeding with default update logic.`,
                      );
                    } else {
                      core.debug(
                        `Drive file is not newer based on link data timestamps. Proceeding with upload/update logic.`,
                      );
                    }
                  } else {
                    core.debug(
                      `No link file data found for ${drive_comparison_path}. Proceeding with default update logic.`,
                    );
                  }
                  core.debug(`--------------------------/`);
                } else {
                  core.debug(
                    `Skipping modifiedTime check: Visual diffs disabled or Drive file/time missing.`,
                  );
                }

                // STEP 1.5.2: Proceed with upload/update/rename if the modifiedTime check passed or didn't apply
                if (!existing_drive_file) {
                  core.info(
                    `[Upload Queue] New file: '${local_relative_path}' to folder ${target_folder_id}.`,
                  );
                  await upload_file(local_file.path, target_folder_id);
                } else {
                  // Handle Google Docs (primarily renaming)
                  if (
                    GOOGLE_DOC_MIME_TYPES.includes(
                      existing_drive_file.mimeType || "",
                    )
                  ) {
                    core.debug(
                      ` -> Drive file ${existing_drive_file.id} is a Google Doc type.`,
                    );
                    if (existing_drive_file.name !== drive_target_name) {
                      core.info(
                        `[Rename Queue] Google Doc '${existing_drive_file.name}' to '${drive_target_name}' (ID: ${existing_drive_file.id}).`,
                      );
                      // Note: This rename happens even if the content check was skipped, as it's a metadata change.
                      await drive.files.update({
                        fileId: existing_drive_file.id,
                        requestBody: { name: drive_target_name },
                        fields: "id,name",
                        supportsAllDrives: true,
                      });
                    } else {
                      core.debug(` -> Google Doc name matches.`);
                    }
                  }
                  // Handle regular files (content update or rename)
                  else {
                    // Use md5Checksum (hash) for binary files if available and different
                    const drive_file_needs_update =
                      !existing_drive_file.hash ||
                      existing_drive_file.hash !== local_file.hash;
                    const drive_file_needs_rename =
                      existing_drive_file.name !== drive_target_name;

                    if (drive_file_needs_update) {
                      core.info(
                        `[Update Queue] File content '${local_relative_path}' (ID: ${
                          existing_drive_file.id
                        }). Hash mismatch (Drive: ${
                          existing_drive_file.hash || "N/A"
                        }, Local: ${local_file.hash}).`,
                      );
                      await upload_file(local_file.path, target_folder_id, {
                        id: existing_drive_file.id,
                        name: existing_drive_file.name,
                      });
                    } else if (drive_file_needs_rename) {
                      core.info(
                        `[Rename Queue] File '${existing_drive_file.name}' to '${drive_target_name}' (ID: ${existing_drive_file.id}). Content hash matches.`,
                      );
                      await drive.files.update({
                        fileId: existing_drive_file.id,
                        requestBody: { name: drive_target_name },
                        fields: "id,name",
                        supportsAllDrives: true,
                      });
                    } else {
                      core.debug(
                        ` -> File '${local_relative_path}' hash and name match Drive (ID: ${existing_drive_file.id}). No update needed.`,
                      );
                    }
                  }
                }
              } catch (uploadError) {
                // Log individual upload errors but don't fail the whole batch necessarily
                core.error(
                  `Failed processing outgoing file ${local_relative_path}: ${
                    (uploadError as Error).message
                  }`,
                );
                // Optionally mark operation_failed = true here if any upload failure is critical
              }
            })(),
          ); // Immediately invoke the async function

          // Simple concurrency limiting
          if (uploadPromises.length >= CONCURRENT_UPLOADS) {
            core.debug(
              `Waiting for batch of ${CONCURRENT_UPLOADS} uploads to finish...`,
            );
            await Promise.all(uploadPromises);
            uploadPromises.length = 0; // Reset batch
          }
        }
        // Wait for any remaining promises in the last batch
        if (uploadPromises.length > 0) {
          core.debug(
            `Waiting for final batch of ${uploadPromises.length} uploads to finish...`,
          );
          await Promise.all(uploadPromises);
        }
        core.info("Finished processing local files for upload/update.");

        // STEP 1.6: Handle Untracked Files/Folders (using the maps from the single listing)
        core.info(
          "Handling untracked items in Drive (using initial listing)...",
        );

        // Identify Drive files/folders whose paths were NOT marked for processing during the upload/update phase
        const untracked_drive_files = Array.from(
          drive_files_map.entries(),
        ).filter(
          ([drive_path]) => !files_processed_for_outgoing.has(drive_path),
        );

        const required_folder_paths = new Set(folder_path_to_id_map.keys());
        const untracked_drive_folders = Array.from(
          drive_folders_map.entries(),
        ).filter(
          ([folder_path]) =>
            folder_path !== "" && !required_folder_paths.has(folder_path),
        );

        core.info(
          `Found ${untracked_drive_files.length} potentially untracked files and ${untracked_drive_folders.length} potentially untracked folders in Drive.`,
        );
        core.debug(
          `Files processed (considered for upload/update or skipped as link files): ${Array.from(
            files_processed_for_outgoing,
          ).join(", ")}`,
        );
        core.debug(
          `Required folder paths from local structure: ${Array.from(
            required_folder_paths,
          ).join(", ")}`,
        );

        const all_untracked_items: {
          path: string;
          item: DriveItem;
          isFolder: boolean;
        }[] = [
          ...untracked_drive_files.map(([p, i]) => ({
            path: p,
            item: i,
            isFolder: false,
          })),
          ...untracked_drive_folders.map(([p, i]) => ({
            path: p,
            item: i,
            isFolder: true,
          })),
        ];

        if (all_untracked_items.length > 0) {
          if (on_untrack_action === "ignore") {
            core.info(
              `Ignoring ${all_untracked_items.length} untracked item(s) in Drive as per config.`,
            );
            all_untracked_items.forEach((u) =>
              core.debug(` - Ignored untracked: ${u.path} (ID: ${u.item.id})`),
            );
          } else {
            core.info(
              `Processing ${all_untracked_items.length} untracked items based on on_untrack='${on_untrack_action}'...`,
            );
            // Process untracked items sequentially for clarity, can be parallelized if needed
            for (const {
              path: untracked_path,
              item: untracked_item,
              isFolder,
            } of all_untracked_items) {
              core.info(
                `Processing untracked ${
                  isFolder ? "folder" : "file"
                } in Drive: ${untracked_path} (ID: ${
                  untracked_item.id
                }, Owned: ${untracked_item.owned})`,
              );

              if (!untracked_item.owned) {
                const owner_info = untracked_item.permissions?.find(
                  (p) => p.role === "owner",
                );
                const current_owner_email = owner_info?.emailAddress;
                core.warning(
                  `Untracked item '${untracked_path}' (ID: ${
                    untracked_item.id
                  }) is not owned by the service account (Owner: ${
                    current_owner_email || "unknown"
                  }).`,
                );
                if (
                  on_untrack_action === "request" &&
                  current_owner_email &&
                  current_owner_email !== credentials_json.client_email
                ) {
                  await request_ownership_transfer(
                    untracked_item.id,
                    current_owner_email,
                  );
                } else if (on_untrack_action === "remove") {
                  core.warning(
                    `Cannot remove '${untracked_path}' because it's not owned by the service account. Skipping removal.`,
                  );
                } else {
                  core.info(
                    `Ignoring untracked, un-owned item '${untracked_path}' (action: ${on_untrack_action}).`,
                  );
                }
              } else {
                core.info(
                  `Untracked item '${untracked_path}' is owned by the service account.`,
                );
                if (on_untrack_action === "remove") {
                  await delete_untracked(
                    untracked_item.id,
                    untracked_path,
                    isFolder,
                  );
                } else if (on_untrack_action === "request") {
                  core.info(
                    `Untracked item '${untracked_path}' is already owned. No action needed for 'request'.`,
                  );
                }
              }
            }
          }
        } else {
          core.info(
            "No untracked items found in Drive based on initial listing.",
          );
        }
      } else {
        core.info(
          "Step 1 & 2: Skipping outgoing sync (local -> Drive) and untracked handling because trigger event was not 'push'.",
        );
        // needs_recursive_ownership_check remains true (default) for non-push events
      } // End of 'if trigger_event_name === push'

      // *** STEP 3: Accept Pending Ownership Transfers ***
      // Optimization: Only run the recursive check if needed (determined during push trigger list)
      if (needs_recursive_ownership_check) {
        core.info(
          "Step 3: Checking for and accepting pending ownership transfers (recursive check needed)...",
        );
        try {
          await accept_ownership_transfers(folder_id); // Start recursive check from root
        } catch (acceptError) {
          core.error(
            `Error during ownership transfer acceptance: ${
              (acceptError as Error).message
            }`,
          );
          operation_failed = true;
        }
      } else {
        core.info(
          "Step 3: Skipping recursive ownership transfer check as initial list showed all items owned by service account.",
        );
      }

      // *** STEP 4: Handle Incoming Changes from Drive (Drive -> Local PR) ***
      // Always run this, unless a critical error occurred earlier in this target's processing
      if (!operation_failed) {
        core.info(
          "Step 4: Handling potential incoming changes from Drive (Drive -> Local PR)...",
        );
        // Pass the original trigger event name and the untrack action config
        // Store the result which might contain PR details
        // Note: handle_drive_changes includes its own Drive list and comparison logic, optimized separately
        pr_details = await handle_drive_changes(
          folder_id,

          trigger_event_name,
          git_user_name,
          git_user_email,
          visual_diff_output_dir,
        );
      } else {
        core.warning(
          "Skipping Step 4 (Incoming Changes Check) due to failures in previous steps.",
        );
      }

      // *** STEP 5: Generate Visual Diffs (if enabled and PR was created/updated) ***
      if (
        enable_visual_diffs &&
        pr_details.pr_number &&
        pr_details.head_branch &&
        !operation_failed
      ) {
        core.info(
          "Step 5: Generating visual diffs for the created/updated PR...",
        );
        try {
          let head_sha = github.context.payload.pull_request?.head?.sha;
          if (!head_sha && github.context.eventName === "pull_request") {
            core.warning(
              "Could not get head SHA directly from PR payload context. Trying to fetch...",
            );
            const pr_data = await octokit.rest.pulls.get({
              owner,
              repo,
              pull_number: pr_details.pr_number,
            });
            head_sha = pr_data.data.head.sha;
          }
          // If still no SHA (e.g., triggered by push to the PR branch *after* handle_drive_changes ran but *before* this step)
          // try getting the ref for the head branch
          if (!head_sha && pr_details.head_branch) {
            core.debug(
              `Could not get head SHA from PR context or direct fetch. Trying ref lookup for branch ${pr_details.head_branch}...`,
            );
            // Ensure the ref is correctly formatted
            const ref_lookup = `heads/${pr_details.head_branch}`;
            core.debug(`Looking up ref: ${ref_lookup}`);
            try {
              const ref_data = await octokit.rest.git.getRef({
                owner,
                repo,
                ref: ref_lookup,
              });
              head_sha = ref_data.data.object.sha;
            } catch (refError) {
              core.warning(
                `Failed to get ref for ${ref_lookup}: ${
                  (refError as Error).message
                }`,
              );
            }
          }

          if (!head_sha) {
            // Final fallback or error if SHA is still missing
            if (github.context.sha) {
              core.warning(
                `Could not determine specific head SHA for branch ${pr_details.head_branch}. Falling back to GITHUB_SHA: ${github.context.sha}`,
              );
              head_sha = github.context.sha;
            } else {
              throw new Error(
                `Could not determine head SHA for branch ${pr_details.head_branch} or GITHUB_SHA.`,
              );
            }
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
          core.error(
            `Visual diff generation failed: ${(diffError as Error).message}`,
          );
          // Optionally mark target as failed if diffs fail: operation_failed = true;
        }
      } else if (enable_visual_diffs) {
        if (operation_failed) {
          core.info(
            "Skipping Step 5 (Visual Diffs) because previous steps failed.",
          );
        } else if (!(pr_details.pr_number && pr_details.head_branch)) {
          core.info(
            "Skipping Step 5 (Visual Diffs) because no PR was created/updated in Step 4.",
          );
        }
      }

      // *** STEP 6: Compare Slide Images and Comment on PR (if enabled and PR was created/updated) ***
      if (
        enable_slide_compare &&
        pr_details.pr_number &&
        pr_details.head_branch &&
        !operation_failed
      ) {
        core.info(
          "Step 6: Comparing slide images and generating PR comment...",
        );

        // Add a 10-second wait before starting Step 6 processing
        core.info("Waiting 10 seconds before processing slide comparisons...");
        await new Promise((resolve) => setTimeout(resolve, 10000));
        core.info("Wait complete. Proceeding with slide comparison...");

        try {
          if (!gemini_api_key) {
            throw new Error(
              "gemini_api_key is required when enable_slide_compare is true.",
            );
          }

          // GitHub Token: Use the one provided by the action input
          // This is explicitly set here to ensure the slide-compare module has access to it
          process.env.GITHUB_TOKEN = core.getInput("github_token");
          if (!process.env.GITHUB_TOKEN) {
            core.warning(
              "github_token is not set correctly, slide comparison may fail to access GitHub API",
            );
          } else {
            core.info("GitHub token is properly set for slide comparison");
          }

          // Set environment variables for compare-images
          process.env.GEMINI_API_KEY = gemini_api_key;
          process.env.PR_NUMBER = pr_details.pr_number.toString();
          process.env.DIFF_DIR = visual_diff_output_dir;
          process.env.GITHUB_REPOSITORY_OWNER = owner;
          process.env.GITHUB_REPOSITORY = `${owner}/${repo}`;

          // Check if there are changes in image files
          const changedImageFiles = await getChangedImageFiles(
            owner,
            repo,
            pr_details.pr_number,
            visual_diff_output_dir,
          );

          if (changedImageFiles.length > 0) {
            core.info(
              `Found ${changedImageFiles.length} changed slide images to compare`,
            );

            await postSeparatedPRComments(
              owner,
              repo,
              pr_details.pr_number,
              visual_diff_output_dir,
            );
            core.info(
              "Posted separated English and Japanese slide comparison comments to PR",
            );
          } else {
            core.info("No slide image changes detected for comparison");
          }
        } catch (compareError) {
          core.error(
            `Slide comparison failed: ${(compareError as Error).message}`,
          );

          // Add more detailed error information
          if ((compareError as any).status) {
            core.error(`Status code: ${(compareError as any).status}`);
          }

          // Log stack trace for debugging
          core.debug(`Stack trace: ${(compareError as Error).stack}`);

          // Don't mark operation as failed since this is an enhancement feature
        }
      } else if (enable_slide_compare) {
        if (operation_failed) {
          core.info(
            "Skipping Step 6 (Slide Comparison) because previous steps failed.",
          );
        } else if (!(pr_details.pr_number && pr_details.head_branch)) {
          core.info(
            "Skipping Step 6 (Slide Comparison) because no PR was created/updated in Step 4.",
          );
        }
      }
    } catch (error) {
      // Catch any unhandled errors from the main steps for this target
      core.error(
        `Unhandled error during sync process for Drive folder ${folder_id}: ${
          (error as Error).message
        }`,
      );
      operation_failed = true; // Mark as failed
    } finally {
      // Output link regardless of success/failure
      core.setOutput(
        `drive_link_${folder_id.replace(/[^a-zA-Z0-9]/g, "_")}`,
        `https://drive.google.com/drive/folders/${folder_id}`,
      );
      core.info(
        `Sync process finished for Drive folder: ${folder_id}${
          operation_failed ? " with errors" : ""
        }.`,
      );
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
