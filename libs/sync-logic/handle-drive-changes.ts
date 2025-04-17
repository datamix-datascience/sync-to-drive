import * as core from "@actions/core";
import * as path from "path";
import * as fs from "fs";
import { execute_git } from "../git.js";
import { list_local_files } from "../local-files/list.js";
import { list_drive_files_recursively } from "../google-drive/list.js";
import { handle_download_item } from "../google-drive/files.js";
import { create_pull_request_with_retry } from "../github/pull-requests.js";
import { octokit } from "../github/auth.js";
import { DriveItem } from "../google-drive/types.js";
// Import the necessary types and functions from file_types
import { GOOGLE_DOC_MIME_TYPES, LINK_FILE_MIME_TYPES, MIME_TYPE_TO_EXTENSION, get_link_file_suffix } from "../google-drive/file_types.js";
import { format_pr_body } from "./pretty.js";
import { SuccessfullyProcessedItem } from "./types.js";

// Define a return type for the function
interface HandleDriveChangesResult {
  pr_number?: number;
  head_branch?: string;
}

// Helper to safely get repo owner and name
function get_repo_info(): { owner: string; repo: string } {
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
async function determineInitialBranch(repo_info: { owner: string; repo: string }): Promise<string> {
  let branchName: string | undefined;
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

  } catch (error) {
    core.error(`Failed to determine initial branch name: ${(error as Error).message}`);
    // This is critical, cannot reliably proceed or clean up without the initial branch.
    throw new Error("Could not determine the initial branch. Action cannot continue.");
  }
}


// Handle Drive changes with PR creation
export async function handle_drive_changes(
  folder_id: string,
  on_untrack_action: "ignore" | "remove" | "request",
  trigger_event_name: string
): Promise<HandleDriveChangesResult> { // Updated return type
  core.info(`Handling potential incoming changes from Drive folder: ${folder_id} (Trigger: ${trigger_event_name}, Untrack action: ${on_untrack_action})`);

  let original_state_branch: string = ''; // Initialize for finally block safety
  const repo_info = get_repo_info(); // Get repo info early
  const run_id = process.env.GITHUB_RUN_ID || Date.now().toString();
  let result: HandleDriveChangesResult = {}; // Initialize result

  // *** Determine Initial Branch Name FIRST ***
  const initial_branch = await determineInitialBranch(repo_info);

  try {
    // Step 1: Create temporary state branch
    original_state_branch = `original-state-${folder_id}-${run_id}`;
    core.info(`Initial branch is '${initial_branch}'. Creating temporary state branch '${original_state_branch}'`);
    const initial_commit_hash = (await execute_git('rev-parse', ['HEAD'], { silent: true })).stdout.trim();
    if (!initial_commit_hash) {
      throw new Error("Could not get initial commit hash.");
    }
    await execute_git("checkout", ["-b", original_state_branch, initial_commit_hash]);

    // Step 2: List local files
    core.info("Listing local files from original state branch...");
    const local_files_list = await list_local_files(".");
    const local_map = new Map(local_files_list.map(f => [f.relative_path.replace(/\\/g, '/'), f]));
    core.info(`Found ${local_map.size} relevant local files in original state.`);
    const local_lower_to_original_key = new Map<string, string>();
    local_map.forEach((_, key) => local_lower_to_original_key.set(key.toLowerCase(), key));
    core.debug(`Created lowercase lookup map with ${local_lower_to_original_key.size} entries.`);

    // Step 3: List Drive content
    core.info("Listing Drive content for incoming change comparison...");
    let drive_files: Map<string, DriveItem>;
    let drive_folders: Map<string, DriveItem>;
    try {
      const drive_data = await list_drive_files_recursively(folder_id);
      drive_files = new Map(Array.from(drive_data.files.entries()).map(([p, item]) => [p.replace(/\\/g, '/'), item]));
      drive_folders = new Map(Array.from(drive_data.folders.entries()).map(([p, item]) => [p.replace(/\\/g, '/'), item]));
      core.info(`Found ${drive_files.size} files and ${drive_folders.size} folders in Drive.`);
    } catch (error) {
      core.error(`Failed list Drive content for folder ${folder_id}: ${(error as Error).message}. Aborting incoming sync logic.`);
      return result;
    }

    // Step 4: Compare Drive state to local state
    const new_files_to_process: SuccessfullyProcessedItem[] = []; // Use the new type
    const modified_files_to_process: SuccessfullyProcessedItem[] = []; // Use the new type
    const deleted_local_paths: string[] = [];
    const found_local_keys = new Set<string>(); // Keep track of local keys that correspond to a found Drive item

    // --- Comparison Loop (uses new link file naming) ---
    for (const [drive_path, drive_item] of drive_files) {
      // Ensure drive_item has necessary fields before proceeding
      if (!drive_item.id || !drive_item.name || !drive_item.mimeType) {
        core.warning(`Skipping Drive item with missing id, name, or mimeType. Path: '${drive_path}', ID: ${drive_item.id || 'N/A'}`);
        continue;
      }

      core.debug(`Comparing Drive item: '${drive_path}' (ID: ${drive_item.id}, MIME: ${drive_item.mimeType}, modifiedTime: ${drive_item.modifiedTime})`);
      const drive_path_lower = drive_path.toLowerCase();
      const is_google_doc = GOOGLE_DOC_MIME_TYPES.includes(drive_item.mimeType);
      const needs_link_file = LINK_FILE_MIME_TYPES.includes(drive_item.mimeType);

      // Determine expected paths based on Drive item
      const expected_content_path = drive_path; // Content path matches conceptual drive path
      // Calculate expected link file path based on Drive item's name and type
      const link_suffix = needs_link_file ? get_link_file_suffix(drive_item.mimeType) : null;
      const base_name = drive_item.name; // Use the actual Drive name for the link file base
      const drive_dir = path.dirname(drive_path); // Get directory from conceptual drive path
      const expected_link_filename = link_suffix ? `${base_name}${link_suffix}` : null;
      const expected_link_path = expected_link_filename ? (drive_dir === '.' ? expected_link_filename : path.join(drive_dir, expected_link_filename).replace(/\\/g, '/')) : null;
      core.debug(` -> Expected local content path: ${expected_content_path}`);
      core.debug(` -> Expected local link path: ${expected_link_path || 'None'}`);

      // Find corresponding local files using lowercase lookup
      const match_content_key = local_lower_to_original_key.get(expected_content_path.toLowerCase());
      const match_link_key = expected_link_path ? local_lower_to_original_key.get(expected_link_path.toLowerCase()) : null;

      const local_content_info = match_content_key ? local_map.get(match_content_key) : undefined;
      const local_link_info = match_link_key ? local_map.get(match_link_key) : undefined;

      // Add found keys to set for deletion check later
      if (match_content_key) found_local_keys.add(match_content_key);
      if (match_link_key) found_local_keys.add(match_link_key);

      let needs_processing = false;
      let reason = "";

      // --- START: Logic to determine needs_processing and reason (largely same as before, uses corrected paths) ---
      if (is_google_doc) {
        // Google Docs: Expect only link file (with new name), no content file
        if (local_content_info) {
          core.warning(`Found unexpected local content file '${match_content_key}' for Google Doc '${drive_path}'. Marking for processing to fix.`);
          needs_processing = true;
          reason = "unexpected content file";
        }
        if (!local_link_info) {
          core.debug(` -> Google Doc '${drive_path}' is NEW or missing its link file (${expected_link_path}) locally.`);
          needs_processing = true;
          reason = "missing link file";
        } else {
          // Check modifiedTime for existing link file
          try {
            const link_content = await fs.promises.readFile(local_link_info.path, "utf-8"); // Use full path from local_info
            const link_data = JSON.parse(link_content);
            const stored_modified_time = link_data.modifiedTime;
            const drive_modified_time = drive_item.modifiedTime;
            core.debug(` -> Google Doc '${drive_path}' modifiedTime comparison: stored=${stored_modified_time}, drive=${drive_modified_time}`);
            if (drive_modified_time && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*Z$/.test(drive_modified_time)) {
              core.warning(` -> Invalid modifiedTime format for '${drive_path}': ${drive_modified_time}`);
              needs_processing = true; reason = "invalid modifiedTime format";
            } else if (!stored_modified_time || !drive_modified_time) {
              core.debug(` -> Google Doc '${drive_path}' missing modifiedTime data. Marking for update.`);
              needs_processing = true; reason = "missing modifiedTime data";
            } else if (stored_modified_time !== drive_modified_time) {
              core.debug(` -> Google Doc '${drive_path}' modified. Marking for update.`);
              needs_processing = true; reason = `modifiedTime mismatch (Drive: ${drive_modified_time}, Local: ${stored_modified_time})`;
            } else {
              core.debug(` -> Google Doc '${drive_path}' link file up-to-date.`);
            }
          } catch (error) {
            core.warning(`Failed to read/parse link file '${local_link_info.path}': ${(error as Error).message}. Marking for update.`);
            needs_processing = true; reason = "failed to parse link file";
          }
        }
      } else if (needs_link_file) { // e.g., PDF
        // ... (rest of the PDF logic remains the same, as it relies on local_content_info and local_link_info which are now found using the correct expected paths)
        // Just ensure the debug logs use the correct path variables if needed.
        core.debug(`--- Debugging PDF/Link File: ${drive_path} ---`);
        core.debug(` -> Drive Item Info: ID=${drive_item.id}, Hash=${drive_item.hash || 'N/A'}, ModifiedTime=${drive_item.modifiedTime}`);
        core.debug(` -> Expected Content Path (local): ${expected_content_path}`);
        core.debug(` -> Expected Link Path (local): ${expected_link_path}`);
        core.debug(` -> Matching Key - Content: ${match_content_key || 'None'}`);
        core.debug(` -> Matching Key - Link: ${match_link_key || 'None'}`);
        core.debug(` -> Found Local Content? ${local_content_info ? `Yes (Path: ${local_content_info.path}, Hash: ${local_content_info.hash})` : 'No'}`);
        core.debug(` -> Found Local Link? ${local_link_info ? `Yes (Path: ${local_link_info.path})` : 'No'}`);

        let content_mismatch = false;
        if (!local_content_info) {
          core.debug(` -> Reason Check 1: Missing local content file ('${expected_content_path}').`);
          needs_processing = true; reason = "missing content file";
          content_mismatch = true; // Assume content needs update if missing
        } else {
          // Compare hashes only if Drive provides one
          if (drive_item.hash) {
            if (local_content_info.hash !== drive_item.hash) {
              core.debug(` -> Reason Check 2: Content hash mismatch (Local: ${local_content_info.hash}, Drive: ${drive_item.hash}).`);
              needs_processing = true; reason = `content hash mismatch (Local: ${local_content_info.hash}, Drive: ${drive_item.hash})`;
              content_mismatch = true;
            } else {
              core.debug(` -> Content hash matches Drive hash.`);
            }
          } else {
            core.debug(` -> Drive hash is missing. Will rely on modifiedTime check for content change decision.`);
          }
        }

        // Check link file, regardless of content state
        if (!local_link_info) {
          core.debug(` -> Reason Check 3: Missing local link file ('${expected_link_path}').`);
          needs_processing = true; reason = reason ? `${reason}, missing link file` : "missing link file";
        } else {
          try {
            const link_content = await fs.promises.readFile(local_link_info.path, "utf-8"); // Use full path
            const link_data = JSON.parse(link_content);
            const stored_modified_time = link_data.modifiedTime;
            const drive_modified_time = drive_item.modifiedTime;
            core.debug(` -> Parsed link file: Stored modifiedTime='${stored_modified_time}' vs Drive modifiedTime='${drive_modified_time}'`);

            if (drive_modified_time && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*Z$/.test(drive_modified_time)) {
              core.debug(` -> Reason Check 4: Invalid Drive modifiedTime format.`);
              needs_processing = true; reason = reason ? `${reason}, invalid modifiedTime format` : "invalid modifiedTime format";
              content_mismatch = true;
            } else if (!stored_modified_time || !drive_modified_time) {
              core.debug(` -> Reason Check 5: Missing modifiedTime in link or drive item.`);
              needs_processing = true; reason = reason ? `${reason}, missing modifiedTime data` : "missing modifiedTime data";
              content_mismatch = true;
            } else if (stored_modified_time !== drive_modified_time) {
              core.debug(` -> Reason Check 6: Link modifiedTime mismatch.`);
              needs_processing = true; reason = reason ? `${reason}, link modifiedTime mismatch` : `link modifiedTime mismatch (Drive: ${drive_modified_time}, Local: ${stored_modified_time})`;
              if (!content_mismatch) {
                core.debug(` -> Marking content_mismatch=true due to modifiedTime difference.`);
                content_mismatch = true;
              }
            } else {
              core.debug(` -> Link file modifiedTime matches Drive modifiedTime.`);
            }
          } catch (error) {
            core.debug(` -> Reason Check 7: Failed to read/parse link file '${local_link_info.path}'.`);
            core.warning(`Failed to read/parse link file '${local_link_info.path}': ${(error as Error).message}. Marking for update.`);
            needs_processing = true; reason = reason ? `${reason}, failed to parse link file` : "failed to parse link file";
            content_mismatch = true;
          }
        }

        if (content_mismatch && !reason.includes("content hash mismatch") && !reason.includes("missing content file")) {
          reason = reason ? `${reason}, content update required (inferred)` : "content update required (inferred)";
          core.debug(` -> Final reason updated to include inferred content update: ${reason}`);
        }
        core.debug(`--- End Debug PDF/Link File: ${drive_path}. Needs Processing: ${needs_processing}, Final Reason: ${reason || 'None'} ---`);
      } else { // Binary file (no link file expected)
        // ... (binary file logic remains the same, checking hash match etc. with local_content_info)
        if (!local_content_info) {
          core.debug(` -> Binary file '${drive_path}' is NEW locally.`);
          needs_processing = true; reason = "missing content file";
        } else {
          // Compare hashes if Drive provides one
          if (drive_item.hash && local_content_info.hash !== drive_item.hash) {
            core.debug(` -> Binary file '${drive_path}' content hash mismatch (Local: ${local_content_info.hash}, Drive: ${drive_item.hash}).`);
            needs_processing = true; reason = `content hash mismatch (Local: ${local_content_info.hash}, Drive: ${drive_item.hash})`;
          } else if (!drive_item.hash) {
            core.debug(` -> Drive hash is missing for binary file '${drive_path}'. Assuming modified based on timestamp or if missing locally.`);
            // Simple approach: if hash missing, mark for processing if modified time differs (or if new)
            // This requires comparing local file mtime to drive mtime, which we aren't doing currently.
            // Safest bet might be to re-download if hash is missing and file exists locally.
            // OR rely on the link file logic for modifiedTime check (if we decide binaries should have links?)
            // For now, let's just mark as modified if hash missing and file exists locally.
            // core.debug(` -> Marking for processing because Drive hash is missing.`);
            // needs_processing = true; reason = "missing drive hash";

            // Alternative: Use modifiedTime (requires reading local file stats - adds overhead)
            // For simplicity now: Only update binary if hash mismatch OR if it's new. Ignore if hash missing but file exists.
            core.debug(` -> Skipping binary file update check due to missing Drive hash.`);

          } else {
            core.debug(` -> Binary file '${drive_path}' hash matches.`);
          }
        }
      }
      // --- END: Logic to determine needs_processing ---

      if (needs_processing) {
        core.info(`--> Change detected for ${is_google_doc ? "Google Doc" : needs_link_file ? "PDF/Linkable" : "binary file"} '${drive_path}': ${reason}. Adding to processing list.`);
        const item_to_add = { path: drive_path, item: drive_item }; // Use conceptual drive path
        if (local_content_info || local_link_info) { // If either part existed locally
          modified_files_to_process.push(item_to_add);
        } else {
          new_files_to_process.push(item_to_add);
        }
      } else {
        core.debug(` -> No processing needed for '${drive_path}'.`);
      }
    } // End comparison loop


    // Step 5: Identify deletions (using found_local_keys set)
    // Pre-compile regex for link file detection during deletion check
    const known_extensions_del = Object.values(MIME_TYPE_TO_EXTENSION).join('|');
    const link_file_regex_del = new RegExp(`\\.(${known_extensions_del})\\.gdrive\\.json$`);
    core.debug("Checking for items deleted in Drive...");
    for (const [local_key, _local_file_info] of local_map) {
      // Check if this specific local file key was marked as found during the Drive comparison
      if (!found_local_keys.has(local_key)) {
        // This local file (content or link) did not have a direct match in Drive based on expected paths.
        // We need to be careful not to delete a content file if its *link file* was found, or vice-versa.
        // The `found_local_keys` set correctly handles this. If a local file wasn't added to the set,
        // it means neither its expected content path nor its expected link path (if applicable) matched a drive item.
        core.info(`Deletion detected: Local item '${local_key}' not found (or its corresponding Drive item missing/renamed).`);
        if (!deleted_local_paths.includes(local_key)) {
          deleted_local_paths.push(local_key);
        }
      } else {
        core.debug(`Local key '${local_key}' found corresponding Drive item. Keeping.`);
      }
    }

    // Folder deletion check (remains the same logic)
    const local_folders = new Set<string>();
    local_files_list.forEach(f => {
      const paths_to_check = [f.relative_path];
      // Check if it's a link file using the regex to derive potential base path
      const match = f.relative_path.match(link_file_regex_del);
      if (match) {
        const suffix_length = match[0].length;
        const base_name_from_link = path.basename(f.relative_path.substring(0, f.relative_path.length - suffix_length));
        const dir_name = path.dirname(f.relative_path);
        const conceptual_content_path = dir_name === '.' ? base_name_from_link : path.join(dir_name, base_name_from_link).replace(/\\/g, '/');
        paths_to_check.push(conceptual_content_path);
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
        const folder_still_relevant_in_drive =
          [...drive_files.keys()].some(drive_path => drive_path.startsWith(local_folder_path + '/')) ||
          [...drive_folders.keys()].some(drive_folder => drive_folder.startsWith(local_folder_path + '/'));
        if (!folder_still_relevant_in_drive) {
          core.info(`Deletion detected: Local folder structure '${local_folder_path}' seems entirely removed from Drive.`);
          if (!deleted_local_paths.includes(local_folder_path)) {
            // Add folder path itself for potential 'git rm -rf'
            deleted_local_paths.push(local_folder_path);
          }
        }
      }
    }
    core.info(`Identified ${deleted_local_paths.length} local paths corresponding to items potentially deleted/renamed in Drive.`);


    // Step 6: Apply changes locally and stage them
    let changes_made = false;
    const added_or_updated_paths_final = new Set<string>(); // Tracks actual staged files
    const removed_paths_final = new Set<string>(); // Tracks actual removed files
    const successfully_added_updated_items: SuccessfullyProcessedItem[] = []; // Tracks items for PR body

    // Handle Deletions
    const should_remove = trigger_event_name !== 'push' && on_untrack_action === 'remove';
    if (deleted_local_paths.length > 0) {
      if (should_remove) {
        core.info(`Processing ${deleted_local_paths.length} local items to remove...`);
        // Sort paths: deeper paths first, then alphabetically for files/folders at same level
        deleted_local_paths.sort((a, b) => {
          const depth_a = a.split(/[\\/]/).length;
          const depth_b = b.split(/[\\/]/).length;
          if (depth_a !== depth_b) {
            return depth_b - depth_a; // Deeper paths first
          }
          return a.localeCompare(b); // Alphabetical otherwise
        });
        core.debug(`Sorted deletion paths: ${deleted_local_paths.join(', ')}`);

        for (const local_path_to_delete of deleted_local_paths) {
          try {
            // Double check existence before attempting rm, git might have already handled sub-files
            if (!fs.existsSync(local_path_to_delete)) {
              core.debug(`Local item '${local_path_to_delete}' already removed. Skipping git rm.`);
              added_or_updated_paths_final.delete(local_path_to_delete);
              removed_paths_final.add(local_path_to_delete); // Still track as removed conceptually
              continue;
            }
            core.info(`Removing local item: ${local_path_to_delete}`);
            // Use -rf for folders, --ignore-unmatch in case git doesn't track it but fs has it
            await execute_git("rm", ["-rf", "--ignore-unmatch", "--", local_path_to_delete]);
            removed_paths_final.add(local_path_to_delete); // Track successful removal staging
            added_or_updated_paths_final.delete(local_path_to_delete); // Unmark if previously added
            changes_made = true;
          } catch (error) {
            core.error(`Failed to stage deletion of ${local_path_to_delete}: ${(error as Error).message}`);
          }
        }
      } else {
        const reason = trigger_event_name === 'push' ? `trigger was 'push'` : `'on_untrack' is '${on_untrack_action}'`;
        core.info(`Found ${deleted_local_paths.length} item(s) locally but not in Drive. Skipping removal because ${reason}.`);
        deleted_local_paths.forEach(fp => core.info(`  - Skipped removal: ${fp}`));
      }
    }

    // Handle New and Modified Files
    const items_to_process = [...new_files_to_process, ...modified_files_to_process];
    core.info(`Processing ${new_files_to_process.length} new and ${modified_files_to_process.length} modified items from Drive...`);

    for (const { path: original_drive_path, item: drive_item } of items_to_process) {
      // target_content_local_path uses the conceptual drive path
      const target_content_local_path = original_drive_path;
      core.info(`Handling Drive item: ${drive_item.name || `(ID: ${drive_item.id})`} -> Target local content path: ${target_content_local_path}`);
      let item_staging_succeeded = false; // Track success for *this specific item*

      try {
        // handle_download_item creates necessary directories internally now
        const { linkFilePath, contentFilePath } = await handle_download_item(drive_item, target_content_local_path);

        // Helper to stage files and track changes for *this item*
        const stage_file = async (file_path_to_stage?: string): Promise<boolean> => {
          if (!file_path_to_stage) return false;
          // Check existence within the WORKSPACE, not necessarily git index yet
          if (!fs.existsSync(file_path_to_stage)) {
            core.warning(`Attempted to stage file '${file_path_to_stage}' but it does not exist on filesystem.`);
            return false;
          }
          try {
            core.info(`Staging added/updated file: ${file_path_to_stage}`);
            // No need for check-ignore if we unconditionally add
            await execute_git("add", ["--", file_path_to_stage]);

            // Verify staging (optional, adds overhead)
            // const add_status = await execute_git("status", ["--porcelain", "--", file_path_to_stage], { ignoreReturnCode: true });
            // core.debug(`Git status after adding '${file_path_to_stage}':\n${add_status.stdout}`);

            added_or_updated_paths_final.add(file_path_to_stage); // Track overall staged files
            changes_made = true; // Set global flag

            if (removed_paths_final.has(file_path_to_stage)) {
              core.debug(`Path ${file_path_to_stage} was staged, removing from final conceptual deletion list.`);
              removed_paths_final.delete(file_path_to_stage);
            }
            return true; // Indicate success for this file
          } catch (stageError) {
            core.warning(`Failed to stage ${file_path_to_stage}: ${(stageError as Error).message}`);
            return false; // Indicate failure for this file
          }
        };

        // Stage the generated files and track if any succeeded
        const staged_link = await stage_file(linkFilePath);
        const staged_content = await stage_file(contentFilePath);

        // Consider staging successful if EITHER the link OR the content was staged
        // (e.g., for a Google Doc, only the link file exists/is staged)
        if (staged_link || staged_content) {
          item_staging_succeeded = true;
        } else if (!linkFilePath && !contentFilePath) {
          // This case might happen if handle_download_item skipped due to missing drive item info
          core.debug(`No files generated by handle_download_item for ${drive_item.name}. Assuming no staging needed.`);
        } else {
          core.warning(`Neither link file (${linkFilePath || 'N/A'}) nor content file (${contentFilePath || 'N/A'}) could be staged for ${drive_item.name}.`);
        }


      } catch (error) {
        core.error(`Failed to process/stage item from Drive ${drive_item.name || `(ID: ${drive_item.id})`} to ${target_content_local_path}: ${(error as Error).message}`);
        // item_staging_succeeded remains false
      }

      // If staging succeeded for this item, add it to the list for the PR body
      if (item_staging_succeeded) {
        // Use the conceptual Drive path (original_drive_path) for the PR body list
        successfully_added_updated_items.push({ path: original_drive_path, item: drive_item });
      }
    } // end of items_to_process loop


    // Step 7: Commit, Push, and Create PR (logic mostly unchanged)
    // Ensure git status check is reliable
    await execute_git('status', ['--porcelain']); // Run status to ensure index is updated after adds/rms
    const status_result = await execute_git('status', ['--porcelain']);

    if (!status_result.stdout.trim()) {
      core.info("Git status clean after processing changes. No commit needed.");
      return result; // Return current result (likely empty)
    } else {
      core.info("Git status is not clean, proceeding with commit.");
      core.debug("Git status output:\n" + status_result.stdout);
      if (!changes_made) {
        core.warning("Git status shows changes, but internal changes_made flag was false. Proceeding with commit anyway.");
        changes_made = true;
      }
    }

    if (!changes_made) {
      // This check is likely redundant now if status check is accurate, but keep for safety
      core.info("No effective file changes detected by internal flag. Skipping commit and PR.");
      return result;
    }

    core.info("Changes detected originating from Drive. Proceeding with commit and PR.");

    // Commit message details
    const commit_detail_lines = [];
    const added_updated_display_paths = successfully_added_updated_items
      .map(item => item.path)
      .sort((a, b) => a.localeCompare(b));
    if (added_updated_display_paths.length > 0) commit_detail_lines.push(`- Add/Update: ${added_updated_display_paths.map(p => `'${p}'`).join(", ")}`);

    // Use the final set of conceptually removed paths for the commit message
    const removed_display_paths = Array.from(removed_paths_final).sort((a, b) => a.localeCompare(b));
    if (removed_display_paths.length > 0) commit_detail_lines.push(`- Remove: ${removed_display_paths.map(p => `'${p}'`).join(", ")}`);

    const commit_message = [
      `Sync changes from Google Drive (${folder_id})`,
      ...commit_detail_lines,
      `\nSource Drive Folder ID: ${folder_id}`,
      `Workflow Run ID: ${run_id}`
    ].join("\n");


    try {
      await execute_git("config", ["--local", "user.email", "github-actions[bot]@users.noreply.github.com"]);
      await execute_git("config", ["--local", "user.name", "github-actions[bot]"]);

      core.info("Committing changes on temporary branch...");
      // Add all changes again just before commit to catch anything missed (e.g., removals)
      await execute_git("add", ["."]);
      await execute_git("commit", ["-m", commit_message]);
      const sync_commit_hash = (await execute_git('rev-parse', ['HEAD'], { silent: true })).stdout.trim();
      core.info(`Created sync commit ${sync_commit_hash} on temporary branch '${original_state_branch}'.`);

      const sanitized_folder_id = folder_id.replace(/[^a-zA-Z0-9_-]/g, '_');
      const head_branch = `sync-from-drive-${sanitized_folder_id}`;
      result.head_branch = head_branch; // Store head branch early

      core.info(`Preparing PR branch: ${head_branch}`);
      // Check existence and create/checkout/reset PR branch (logic remains the same)
      // ... (checkout/reset logic) ...
      const local_branch_exists_check = await execute_git('show-ref', ['--verify', `refs/heads/${head_branch}`], { ignoreReturnCode: true, silent: true });
      const remote_branch_exists_check = await execute_git('ls-remote', ['--exit-code', '--heads', 'origin', head_branch], { ignoreReturnCode: true, silent: true });
      const local_branch_exists = local_branch_exists_check.exitCode === 0;
      const remote_branch_exists = remote_branch_exists_check.exitCode === 0;

      if (local_branch_exists) {
        core.info(`Branch ${head_branch} exists locally. Checking it out and resetting...`);
        await execute_git("checkout", ["--force", head_branch]); // Force checkout if needed
        await execute_git("reset", ["--hard", sync_commit_hash]);
      } else if (remote_branch_exists) {
        core.info(`Branch ${head_branch} exists remotely. Fetching, checking out, and resetting...`);
        try {
          // Fetch specific ref to avoid fetching unrelated things
          await execute_git("fetch", ["origin", `${head_branch}:${head_branch}`]);
          await execute_git("checkout", ["--force", head_branch]); // Force checkout
          await execute_git("reset", ["--hard", sync_commit_hash]);
        } catch (fetchCheckoutError) {
          core.warning(`Failed to fetch/checkout/reset remote branch ${head_branch}. Creating new local branch from sync commit. Error: ${(fetchCheckoutError as Error).message}`);
          await execute_git("checkout", ["-b", head_branch, sync_commit_hash]); // Create new branch from hash
        }
      } else {
        core.info(`Branch ${head_branch} does not exist. Creating it from sync commit...`);
        await execute_git("checkout", ["-b", head_branch, sync_commit_hash]); // Create new branch from hash
      }

      core.info(`Pushing branch ${head_branch} to origin...`);
      await execute_git("push", ["--force", "origin", head_branch]);

      const pr_title = `Sync changes from Google Drive (${folder_id})`;
      const pr_body = format_pr_body(
        folder_id,
        run_id,
        successfully_added_updated_items, // Pass the list of successfully processed Drive items
        removed_paths_final // Pass the set of conceptually removed paths
      );

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
        result = { pr_number: pr_result.number, head_branch: head_branch }; // Update result fully
      } else {
        core.info("Pull request was not created or updated (e.g., no diff or error).");
        // Keep head_branch in result if push succeeded but PR failed/not needed
        if (!result.head_branch) result = {}; // Clear result if push also failed implicitly
      }
    } catch (error) {
      core.error(`Failed during commit, push, or PR creation: ${(error as Error).message}`);
      // Keep head_branch in result if push succeeded but subsequent steps failed
      if (!result.head_branch) result = {};
    }
  } catch (error) {
    core.error(`Error during Drive change handling for folder ${folder_id}: ${(error as Error).message}`);
    result = {}; // Clear result on major error
  } finally {
    // --- Cleanup logic remains the same ---
    core.info(`Cleaning up temporary branch '${original_state_branch}' and returning to '${initial_branch}'`);
    try {
      const current_cleanup_branch_result = await execute_git('rev-parse', ['--abbrev-ref', 'HEAD'], { silent: true, ignoreReturnCode: true });
      const current_cleanup_branch = current_cleanup_branch_result.stdout.trim();

      if (current_cleanup_branch !== initial_branch && initial_branch) { // Check initial_branch exists
        core.info(`Currently on branch '${current_cleanup_branch || 'detached HEAD'}', checking out initial branch '${initial_branch}'...`);
        await execute_git("checkout", ["--force", initial_branch]);
      } else if (current_cleanup_branch === initial_branch) {
        core.info(`Already on initial branch '${initial_branch}'.`);
      } else {
        core.warning(`Could not determine initial branch for cleanup checkout. Staying on '${current_cleanup_branch || 'detached HEAD'}'`);
      }

      if (original_state_branch) {
        const branch_check = await execute_git('show-ref', ['--verify', `refs/heads/${original_state_branch}`], { ignoreReturnCode: true, silent: true });
        if (branch_check.exitCode === 0) {
          core.info(`Deleting temporary state branch '${original_state_branch}'...`);
          await execute_git("branch", ["-D", original_state_branch]);
        } else {
          core.debug(`Temporary state branch '${original_state_branch}' not found for deletion.`);
        }
      }
    } catch (checkoutError) {
      core.warning(`Failed to fully clean up Git state. Manual cleanup may be needed. Error: ${(checkoutError as Error).message}`);
    }
  }
  return result;
}
