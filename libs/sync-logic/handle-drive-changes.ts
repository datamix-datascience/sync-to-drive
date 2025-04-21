import * as core from "@actions/core";
import * as path from "path";
import * as fs from "fs";
import * as fs_promises from "fs/promises"; // Use promises for fs operations
import { execute_git } from "../git.js";
import { list_local_files } from "../local-files/list.js";
import { DriveFileWithPath, list_drive_files_recursively } from "../google-drive/list.js";
import { handle_download_item } from "../google-drive/files.js";
import { create_pull_request_with_retry } from "../github/pull-requests.js";
import { octokit } from "../github/auth.js";
// Import construct_link_file_name, remove get_link_file_suffix if no longer needed elsewhere
import { GOOGLE_DOC_MIME_TYPES, LINK_FILE_MIME_TYPES, construct_link_file_name } from "../google-drive/file_types.js";
import { DriveItem } from "../google-drive/types.js";
import { format_pr_body } from "./pretty.js";

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

export async function handle_drive_changes(
  folder_id: string,
  on_untrack_action: "ignore" | "remove" | "request",
  trigger_event_name: string,
  git_user_name: string,
  git_user_email: string
): Promise<HandleDriveChangesResult> {
  core.info(`Handling potential incoming changes from Drive folder: ${folder_id}`);

  let original_state_branch: string = '';
  const repo_info = get_repo_info();
  const run_id = process.env.GITHUB_RUN_ID || Date.now().toString();
  let result: HandleDriveChangesResult = {};
  const initial_branch = await determineInitialBranch(repo_info);

  // Use a Set to track Drive IDs that caused updates for the PR body
  const drive_ids_causing_update = new Set<string>();
  // Keep the original list of DriveItems for PR body generation
  const drive_items_for_pr_body: DriveItem[] = [];
  const local_paths_identified_for_deletion = new Set<string>();
  // Removed duplicate tracking:
  // const potential_duplicates_map = new Map<string, DriveItem[]>();
  // const duplicate_items_for_pr_body = new Set<DriveItem>();


  try {
    // Step 1: Create temporary state branch
    original_state_branch = `original-state-${folder_id}-${run_id}`;
    core.info(`Initial branch is '${initial_branch}'. Creating temporary state branch '${original_state_branch}'`);
    const initial_commit_hash = (await execute_git('rev-parse', ['HEAD'], { silent: true })).stdout.trim();
    if (!initial_commit_hash) throw new Error("Could not get initial commit hash.");
    await execute_git("checkout", ["-b", original_state_branch, initial_commit_hash]);


    // Step 2: List local files from original state
    core.info("Listing local files from original state branch...");
    const initial_local_files_list = await list_local_files(".");
    const initial_local_map = new Map(initial_local_files_list.map(f => [f.relative_path.replace(/\\/g, '/'), f]));
    core.info(`Found ${initial_local_map.size} relevant local files in original state.`);


    // Step 3: List Drive content (Using the modified function)
    core.info("Listing Drive content...");
    let drive_files_with_paths: DriveFileWithPath[];
    let drive_folders: Map<string, DriveItem>;
    try {
      const drive_data = await list_drive_files_recursively(folder_id);
      drive_files_with_paths = drive_data.files;
      drive_folders = drive_data.folders;
      core.info(`Found ${drive_files_with_paths.length} files and ${drive_folders.size} folders in Drive.`);
    } catch (error) {
      core.error(`Failed list Drive content for folder ${folder_id}: ${(error as Error).message}. Aborting incoming sync logic.`);
      return result;
    }

    // --- Step 4: Determine Expected Local State & Identify Changes ---
    core.startGroup('Determining Expected State and Changes');
    // Map of expected *local* relative paths to the DriveItem causing them
    const expected_local_files = new Map<string, { type: 'link' | 'content', driveItem: DriveItem }>();
    // Store DriveItems that require a file system operation (add/update)
    const drive_items_needing_processing = new Map<string, { driveItem: DriveItem, targetContentPath: string }>();

    // Populate expected_local_files based on the drive_files_with_paths array
    for (const { path: drive_path, item: drive_item } of drive_files_with_paths) { // <-- Iterate the array
      if (!drive_item.id || !drive_item.name || !drive_item.mimeType) {
        core.warning(`Skipping Drive item with missing id, name, or mimeType. Path: '${drive_path}', ID: ${drive_item.id || 'N/A'}`);
        continue;
      }

      // Removed duplicate detection logic

      const is_google_doc = GOOGLE_DOC_MIME_TYPES.includes(drive_item.mimeType);
      const needs_link_file = LINK_FILE_MIME_TYPES.includes(drive_item.mimeType);

      // 1. Determine Expected Content Path (usually the drive_path, represents the binary/downloadable version if applicable)
      const expected_content_path = drive_path; // Use the path calculated during listing

      // 2. Determine Expected Link Path (if needed) using the NEW naming scheme
      let expected_link_path: string | null = null;
      if (needs_link_file) {
        const base_name = drive_item.name;
        const drive_dir = path.dirname(drive_path); // Get directory from the *Drive path*
        // Construct the unique link file name using the new function
        const link_filename = construct_link_file_name(base_name, drive_item.id, drive_item.mimeType);
        // Calculate the link file path relative to the root
        expected_link_path = drive_dir === '.' ? link_filename : path.join(drive_dir, link_filename).replace(/\\/g, '/');
      }


      // Add expected *local* files to the map
      if (!is_google_doc) { // Content file expected for non-Google Docs
        if (expected_local_files.has(expected_content_path)) {
          // This should be rare now unless non-link files somehow clash exactly
          core.debug(`Duplicate content path mapping detected: ${expected_content_path}. Overwriting with Drive ID ${drive_item.id}.`)
        }
        expected_local_files.set(expected_content_path, { type: 'content', driveItem: drive_item });
      }
      if (expected_link_path) { // Link file expected for Google Docs and PDFs
        if (expected_local_files.has(expected_link_path)) {
          // This should theoretically NOT happen anymore due to unique file IDs in names
          core.error(`FATAL: Duplicate link path mapping detected even with file ID in name: ${expected_link_path}. Existing ID: ${expected_local_files.get(expected_link_path)?.driveItem.id}, New ID: ${drive_item.id}. This indicates a logic error.`);
          // Consider throwing an error or handling this unexpected state
        }
        expected_local_files.set(expected_link_path, { type: 'link', driveItem: drive_item });
      }
    }
    core.info(`Calculated ${expected_local_files.size} expected local files based on Drive state.`);
    // Removed duplicate warning log

    // Compare expected state against initial local state to find changes
    // Iterate through the Drive items AGAIN to ensure each one is checked
    for (const { path: drive_path, item: drive_item } of drive_files_with_paths) {
      if (!drive_item.id || !drive_item.name || !drive_item.mimeType) continue; // Skip incomplete items

      const is_google_doc = GOOGLE_DOC_MIME_TYPES.includes(drive_item.mimeType);
      const needs_link_file = LINK_FILE_MIME_TYPES.includes(drive_item.mimeType);
      let item_needs_update = false; // Flag if *this specific* drive item triggers an update
      let update_reasons: string[] = [];

      // A. Check expected content file (if applicable)
      if (!is_google_doc) {
        const expected_content_path = drive_path;
        const expected_content_info = expected_local_files.get(expected_content_path);
        // Ensure the mapping points back to the *current* drive_item ID
        if (expected_content_info && expected_content_info.driveItem.id === drive_item.id) {
          const local_file_info = initial_local_map.get(expected_content_path);
          let needs_update = false;
          let reason = "";
          if (!local_file_info) {
            needs_update = true; reason = `Content file missing locally`;
          } else {
            if (expected_content_info.driveItem.hash && local_file_info.hash !== expected_content_info.driveItem.hash) {
              needs_update = true; reason = `Content hash mismatch`;
            } else if (!expected_content_info.driveItem.hash) {
              // Fallback to modified time check via link file (if available)
              // Calculate the EXPECTED link path using the NEW function
              const base_name = drive_item.name;
              const drive_dir = path.dirname(drive_path);
              const expected_link_path_for_content = drive_dir === '.'
                ? construct_link_file_name(base_name, drive_item.id, drive_item.mimeType)
                : path.join(drive_dir, construct_link_file_name(base_name, drive_item.id, drive_item.mimeType)).replace(/\\/g, '/');

              const corresponding_link_expected = expected_local_files.get(expected_link_path_for_content);
              if (corresponding_link_expected?.type === 'link' && corresponding_link_expected.driveItem.id === drive_item.id) {
                const local_link_info = initial_local_map.get(expected_link_path_for_content);
                if (!local_link_info) {
                  needs_update = true; reason = "Corresponding link file missing locally for timestamp check";
                } else {
                  try {
                    const link_content = await fs_promises.readFile(local_link_info.path, "utf-8");
                    const link_data = JSON.parse(link_content);
                    if (link_data.modifiedTime !== drive_item.modifiedTime) {
                      needs_update = true; reason = `ModifiedTime mismatch via link file`;
                    }
                  } catch { needs_update = true; reason = `Cannot read link file for timestamp check`; }
                }
              } else {
                core.debug(`No Drive hash and no corresponding link file found for ${expected_content_path}. Cannot reliably check for update.`);
              }
            }
          }
          if (needs_update) {
            item_needs_update = true;
            update_reasons.push(`Content file '${expected_content_path}': ${reason}`);
          }
        }
      }

      // B. Check expected link file (if applicable)
      if (needs_link_file) {
        // Calculate the EXPECTED link path using the NEW function
        const base_name = drive_item.name;
        const drive_dir = path.dirname(drive_path);
        const expected_link_path = drive_dir === '.'
          ? construct_link_file_name(base_name, drive_item.id, drive_item.mimeType)
          : path.join(drive_dir, construct_link_file_name(base_name, drive_item.id, drive_item.mimeType)).replace(/\\/g, '/');

        const expected_link_info = expected_local_files.get(expected_link_path);
        // No need to check for duplicates here anymore, the check is implicit in the map lookup

        // Ensure the mapping points back to the *current* drive_item ID
        if (expected_link_info && expected_link_info.driveItem.id === drive_item.id) {
          const local_file_info = initial_local_map.get(expected_link_path);
          let needs_update = false;
          let reason = "";
          if (!local_file_info) {
            needs_update = true; reason = `Link file missing locally`;
          } else {
            try {
              const link_content = await fs_promises.readFile(local_file_info.path, "utf-8");
              const link_data = JSON.parse(link_content);
              if (link_data.id !== drive_item.id ||
                link_data.name !== drive_item.name || // Check name consistency
                link_data.modifiedTime !== drive_item.modifiedTime) {
                needs_update = true; reason = `Link file data mismatch (ID, Name, or modifiedTime)`;
              }
            } catch (error) { needs_update = true; reason = `Cannot read/parse local link file`; }
          }
          if (needs_update) {
            item_needs_update = true;
            update_reasons.push(`Link file '${expected_link_path}': ${reason}`);
          }
        }
      }

      // C. Add to processing list if *this* Drive item triggered an update
      if (item_needs_update) {
        core.info(` -> Change detected for Drive item: ${drive_item.name} (ID: ${drive_item.id}, Path: ${drive_path}). Reasons: ${update_reasons.join('; ')}`);
        // Target path for handle_download_item is the *conceptual* content path based on Drive structure
        const targetContentPath = drive_path;

        if (!drive_items_needing_processing.has(drive_item.id)) {
          drive_items_needing_processing.set(drive_item.id, {
            driveItem: drive_item,
            targetContentPath: targetContentPath
          });
        }
        // Also add to list for PR body (using Set to avoid duplicates)
        if (!drive_ids_causing_update.has(drive_item.id)) {
          drive_ids_causing_update.add(drive_item.id);
          drive_items_for_pr_body.push(drive_item); // Add the actual item object
        }
      }
    }


    // Files to Delete: Iterate initial local files and check if they are in the expected set
    for (const [local_path, _local_file_info] of initial_local_map) {
      // Check if *any* Drive item resulted in this local path being expected
      if (!expected_local_files.has(local_path)) {
        local_paths_identified_for_deletion.add(local_path);
        core.info(` -> Deletion identified for local path: ${local_path}`);
      }
    }

    // Get all unique directory paths from the initial local map
    const initial_local_dirs = new Set<string>();
    initial_local_map.forEach((_, local_path) => {
      let dir = path.dirname(local_path);
      while (dir && dir !== '.') {
        initial_local_dirs.add(dir);
        dir = path.dirname(dir);
      }
    });
    // Get all unique directory paths from the expected local map
    const expected_local_dirs = new Set<string>();
    expected_local_files.forEach((_, expected_path) => { // Use the expected_local_files map
      let dir = path.dirname(expected_path);
      while (dir && dir !== '.') {
        expected_local_dirs.add(dir);
        dir = path.dirname(dir);
      }
    });
    // Find dirs present initially but not expected anymore
    for (const initial_dir of initial_local_dirs) {
      if (!expected_local_dirs.has(initial_dir)) {
        let parent_deleted = false;
        for (const deleted_path of local_paths_identified_for_deletion) {
          if (initial_dir.startsWith(deleted_path + path.sep)) {
            parent_deleted = true;
            break;
          }
        }
        const drive_folder_exists = drive_folders.has(initial_dir);
        if (!parent_deleted && !drive_folder_exists) {
          core.info(` -> Deletion identified for potentially empty local directory: ${initial_dir}`);
          local_paths_identified_for_deletion.add(initial_dir);
        }
      }
    }


    core.info(`Identified ${drive_items_needing_processing.size} Drive items needing add/update processing.`);
    core.info(`Identified ${local_paths_identified_for_deletion.size} local paths/folders for deletion.`);
    core.endGroup();


    // --- Step 5: Apply File System Changes ---
    core.startGroup('Applying File System Changes');
    let changes_applied = false;

    // 5a. Apply Deletions
    if (local_paths_identified_for_deletion.size > 0) {
      // Sort paths: deeper paths first for safe deletion
      const sorted_deletion_paths = Array.from(local_paths_identified_for_deletion).sort((a, b) => b.split(path.sep).length - a.split(path.sep).length || a.localeCompare(b));
      core.info(`Applying ${sorted_deletion_paths.length} deletions...`);
      for (const local_path_to_delete of sorted_deletion_paths) {
        try {
          const stats = await fs_promises.lstat(local_path_to_delete).catch(() => null);
          if (stats) {
            core.info(`   - Removing: ${local_path_to_delete}`);
            await fs_promises.rm(local_path_to_delete, { recursive: true, force: true });
            changes_applied = true;
          } else { core.debug(`   - Skipping removal, path already gone: ${local_path_to_delete}`); }
        } catch (error) { core.error(`   - Failed to remove ${local_path_to_delete}: ${(error as Error).message}`); }
      }
    }
    // 5b. Apply Additions/Updates
    if (drive_items_needing_processing.size > 0) {
      core.info(`Applying ${drive_items_needing_processing.size} additions/updates...`);
      for (const { driveItem, targetContentPath } of drive_items_needing_processing.values()) {
        core.info(`   - Processing Drive item: ${driveItem.name || `(ID: ${driveItem.id})`} -> Target local content path: ${targetContentPath}`);
        try {
          await handle_download_item(driveItem, targetContentPath);
          changes_applied = true;
        } catch (error) { core.error(`   - Failed to process item from Drive ${driveItem.name || `(ID: ${driveItem.id})`} to ${targetContentPath}: ${(error as Error).message}`); }
      }
    }
    core.endGroup();

    // --- Step 6: Stage, Commit, Push, and Create PR ---
    if (!changes_applied) {
      core.info("No file system changes were applied. Checking Git status anyway.");
    }

    core.startGroup('Committing Changes and Creating PR');
    await execute_git("config", ["--local", "user.email", git_user_email || "github-actions[bot]@users.noreply.github.com"]);
    await execute_git("config", ["--local", "user.name", git_user_name || "github-actions[bot]"]);
    core.info("Staging all detected changes...");
    await execute_git("add", ["."]);
    await execute_git("add", ["-u"]);
    const status_result = await execute_git('status', ['--porcelain']);
    // Removed duplicate check from this condition
    if (!status_result.stdout.trim()) {
      core.info("Git status is clean. No commit or PR needed.");
      core.endGroup();
      return result; // Exit early if no changes
    }
    // Removed log message about creating PR just for duplicates
    core.info("Git status shows changes. Proceeding with commit.");
    core.debug("Git status output:\n" + status_result.stdout);

    // Commit message details
    const commit_detail_lines = [];
    // Use drive_items_for_pr_body for Added/Updated list
    const added_updated_display = drive_items_for_pr_body // <-- Use the list collected earlier
      .map(item => item.name || item.id)
      .sort((a, b) => a.localeCompare(b));
    if (added_updated_display.length > 0) commit_detail_lines.push(`- Add/Update (from Drive): ${added_updated_display.map(p => `'${p}'`).join(", ")}`);

    const removed_display_paths = Array.from(local_paths_identified_for_deletion).sort((a, b) => a.localeCompare(b));
    if (removed_display_paths.length > 0) commit_detail_lines.push(`- Remove (local paths): ${removed_display_paths.map(p => `'${p}'`).join(", ")}`);

    // Removed addition of duplicate info to commit message

    const commit_message = [
      `Sync changes from Google Drive (${folder_id})`,
      ...(commit_detail_lines.length > 0 ? commit_detail_lines : ["- No file content changes detected."]), // Ensure commit body isn't empty if only deletions happened
      `\nSource Drive Folder ID: ${folder_id}`,
      `Workflow Run ID: ${run_id}`
    ].join("\n");

    try {
      // Only commit if there are actual file changes (status is not clean)
      // This condition is implicitly handled now by the early return above if status is clean
      core.info("Committing staged changes on temporary branch...");
      await execute_git("commit", ["-m", commit_message]);
      const sync_commit_hash = (await execute_git('rev-parse', ['HEAD'], { silent: true })).stdout.trim(); // Get HEAD SHA of the new commit
      core.info(`Created sync commit ${sync_commit_hash} on temporary branch '${original_state_branch}'.`);


      const sanitized_folder_id = folder_id.replace(/[^a-zA-Z0-9_-]/g, '_');
      const head_branch = `sync-from-drive-${sanitized_folder_id}`;
      result.head_branch = head_branch;

      core.info(`Preparing PR branch: ${head_branch}`);
      const local_branch_exists_check = await execute_git('show-ref', ['--verify', `refs/heads/${head_branch}`], { ignoreReturnCode: true, silent: true });
      const remote_branch_exists_check = await execute_git('ls-remote', ['--exit-code', '--heads', 'origin', head_branch], { ignoreReturnCode: true, silent: true });

      let branch_creation_needed = true; // Assume needed unless reset below

      if (local_branch_exists_check.exitCode === 0) {
        core.info(`Branch ${head_branch} exists locally. Checking it out and resetting...`);
        await execute_git("checkout", ["--force", head_branch]);
        await execute_git("reset", ["--hard", sync_commit_hash]); // Reset to the sync commit
        branch_creation_needed = false;
      } else if (remote_branch_exists_check.exitCode === 0) {
        core.info(`Branch ${head_branch} exists remotely. Fetching, checking out, and resetting...`);
        try {
          await execute_git("fetch", ["origin", `${head_branch}:${head_branch}`]);
          await execute_git("checkout", ["--force", head_branch]);
          await execute_git("reset", ["--hard", sync_commit_hash]); // Reset to the sync commit
          branch_creation_needed = false;
        } catch (fetchCheckoutError) {
          core.warning(`Failed to fetch/checkout/reset remote branch ${head_branch}. Will create new local branch. Error: ${(fetchCheckoutError as Error).message}`);
          // Fall through to create branch locally
        }
      }

      if (branch_creation_needed) {
        core.info(`Branch ${head_branch} does not exist or couldn't be reset. Creating it from commit ${sync_commit_hash}...`);
        // We are already on the temp branch with the commit, just create the new branch from here
        await execute_git("checkout", ["-b", head_branch]);
      }


      core.info(`Pushing branch ${head_branch} to origin...`);
      // Push force needed because we might reset the branch
      await execute_git("push", ["--force", "origin", head_branch]);

      // Remove duplicate tag from PR title
      const pr_title = `Sync changes from Google Drive (${folder_id})`;
      // Remove duplicates argument from format_pr_body call
      const pr_body = format_pr_body(
        folder_id,
        run_id,
        drive_items_for_pr_body, // Added/Updated items
        local_paths_identified_for_deletion // Removed paths
      );

      const pr_params = { owner: repo_info.owner, repo: repo_info.repo, title: pr_title, head: head_branch, base: initial_branch, body: pr_body };
      core.info(`Attempting to create or update Pull Request: ${pr_title} (${head_branch} -> ${initial_branch})`);
      const pr_result = await create_pull_request_with_retry(octokit, pr_params);
      if (pr_result) {
        core.info(`Pull request operation successful: ${pr_result.url}`);
        result = { pr_number: pr_result.number, head_branch: head_branch };
      } else {
        core.info("Pull request was not created or updated.");
        if (!result.head_branch) result = {};
      }
    } catch (error) {
      core.error(`Failed during commit, push, or PR creation: ${(error as Error).message}`);
      if (!result.head_branch) result = {};
    } finally {
      core.endGroup();
    }

  } catch (error) {
    core.error(`Error during Drive change handling for folder ${folder_id}: ${(error as Error).message}`);
    result = {};
  } finally {
    core.startGroup(`Cleaning up Git State`);
    core.info(`Cleaning up temporary branch '${original_state_branch}' and returning to '${initial_branch}'`);
    try {
      const current_cleanup_branch_result = await execute_git('rev-parse', ['--abbrev-ref', 'HEAD'], { silent: true, ignoreReturnCode: true });
      const current_cleanup_branch = current_cleanup_branch_result.stdout.trim();

      if (current_cleanup_branch !== initial_branch && initial_branch) {
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
    } finally {
      core.endGroup(); // End Cleanup group
    }
  }
  return result;
}
