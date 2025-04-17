import * as core from "@actions/core";
import * as path from "path";
import * as fs from "fs";
import * as fs_promises from "fs/promises"; // Use promises for fs operations
import { execute_git } from "../git.js";
import { list_local_files } from "../local-files/list.js";
import { list_drive_files_recursively } from "../google-drive/list.js";
import { handle_download_item } from "../google-drive/files.js";
import { create_pull_request_with_retry } from "../github/pull-requests.js";
import { octokit } from "../github/auth.js";
import { GOOGLE_DOC_MIME_TYPES, LINK_FILE_MIME_TYPES, get_link_file_suffix } from "../google-drive/file_types.js";
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

  // Store results for PR body generation
  const drive_items_causing_update: DriveItem[] = [];
  const local_paths_identified_for_deletion = new Set<string>();

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
    // Map local RELATIVE path to FileInfo object for easy lookup
    const initial_local_map = new Map(initial_local_files_list.map(f => [f.relative_path.replace(/\\/g, '/'), f]));
    core.info(`Found ${initial_local_map.size} relevant local files in original state.`);

    // Step 3: List Drive content
    core.info("Listing Drive content...");
    let drive_files: Map<string, DriveItem>;
    let drive_folders: Map<string, DriveItem>; // Keep track of Drive folders too
    try {
      const drive_data = await list_drive_files_recursively(folder_id);
      drive_files = new Map(Array.from(drive_data.files.entries()).map(([p, item]) => [p.replace(/\\/g, '/'), item]));
      drive_folders = new Map(Array.from(drive_data.folders.entries()).map(([p, item]) => [p.replace(/\\/g, '/'), item])); // Store folder map
      core.info(`Found ${drive_files.size} files and ${drive_folders.size} folders in Drive.`);
    } catch (error) {
      core.error(`Failed list Drive content for folder ${folder_id}: ${(error as Error).message}. Aborting incoming sync logic.`);
      return result;
    }

    // --- Step 4: Determine Expected Local State & Identify Changes ---
    core.startGroup('Determining Expected State and Changes');
    // Map of expected relative paths to the DriveItem causing them
    const expected_local_files = new Map<string, { type: 'link' | 'content', driveItem: DriveItem }>();
    // Store DriveItems that require a file system operation (add/update)
    const drive_items_needing_processing = new Map<string, { driveItem: DriveItem, targetContentPath: string }>(); // Use Drive ID as key

    // Populate expected_local_files based on drive_files
    for (const [drive_path, drive_item] of drive_files) {
      if (!drive_item.id || !drive_item.name || !drive_item.mimeType) {
        core.warning(`Skipping Drive item with missing id, name, or mimeType. Path: '${drive_path}', ID: ${drive_item.id || 'N/A'}`);
        continue;
      }

      const is_google_doc = GOOGLE_DOC_MIME_TYPES.includes(drive_item.mimeType);
      const needs_link_file = LINK_FILE_MIME_TYPES.includes(drive_item.mimeType);

      // 1. Determine Expected Content Path (always based on drive_path)
      const expected_content_path = drive_path;

      // 2. Determine Expected Link Path (if needed)
      let expected_link_path: string | null = null;
      if (needs_link_file) {
        const link_suffix = get_link_file_suffix(drive_item.mimeType);
        const base_name = drive_item.name; // Use Drive name for link file
        const drive_dir = path.dirname(drive_path);
        const link_filename = `${base_name}${link_suffix}`;
        expected_link_path = drive_dir === '.' ? link_filename : path.join(drive_dir, link_filename).replace(/\\/g, '/');
      }

      // Add expected files to the map
      if (!is_google_doc) { // Content file expected for non-Google Docs
        expected_local_files.set(expected_content_path, { type: 'content', driveItem: drive_item });
      }
      if (expected_link_path) { // Link file expected for Google Docs and PDFs
        expected_local_files.set(expected_link_path, { type: 'link', driveItem: drive_item });
      }
    }
    core.info(`Calculated ${expected_local_files.size} expected local files based on Drive state.`);

    // Compare expected state against initial local state to find changes
    // Files to Add/Update: Iterate expected files and check against local state
    for (const [expected_path, expected_info] of expected_local_files) {
      const local_file_info = initial_local_map.get(expected_path);
      let needs_update = false;
      let reason = "";

      if (!local_file_info) {
        needs_update = true;
        reason = `File missing locally`;
      } else {
        // Check content hash or link modifiedTime
        if (expected_info.type === 'content') {
          if (expected_info.driveItem.hash && local_file_info.hash !== expected_info.driveItem.hash) {
            needs_update = true; reason = `Content hash mismatch (Local: ${local_file_info.hash}, Drive: ${expected_info.driveItem.hash})`;
          } else if (!expected_info.driveItem.hash) {
            // If drive hash is missing (e.g. PDF from Drive often lacks md5), compare modifiedTime from LINK file if available
            const link_suffix = get_link_file_suffix(expected_info.driveItem.mimeType);
            const expected_link_path_for_content = path.join(path.dirname(expected_path), `${expected_info.driveItem.name}${link_suffix}`).replace(/\\/g, '/');
            const corresponding_link_expected = expected_local_files.get(expected_link_path_for_content);
            if (corresponding_link_expected?.type === 'link') {
              const local_link_info = initial_local_map.get(expected_link_path_for_content);
              if (!local_link_info) {
                needs_update = true; reason = "Corresponding link file missing locally, cannot verify content timestamp";
              } else {
                try {
                  const link_content = await fs_promises.readFile(local_link_info.path, "utf-8");
                  const link_data = JSON.parse(link_content);
                  if (link_data.modifiedTime !== expected_info.driveItem.modifiedTime) {
                    needs_update = true; reason = `Inferred content update needed due to modifiedTime mismatch in corresponding link file`;
                  }
                } catch {
                  needs_update = true; reason = `Cannot read corresponding link file ${local_link_info.path}, cannot verify content timestamp`;
                }
              }
            } else {
              core.debug(`No Drive hash and no corresponding link file found for ${expected_path}. Cannot reliably check for update.`);
            }
          }
        } else { // type === 'link'
          try {
            const link_content = await fs_promises.readFile(local_file_info.path, "utf-8");
            const link_data = JSON.parse(link_content);
            // Check ID, Name, and modifiedTime for changes
            if (link_data.id !== expected_info.driveItem.id ||
              link_data.name !== expected_info.driveItem.name || // Check name consistency
              link_data.modifiedTime !== expected_info.driveItem.modifiedTime) {
              needs_update = true; reason = `Link file data mismatch (ID, Name, or modifiedTime)`;
            }
          } catch (error) {
            needs_update = true; // Cannot read/parse local link file
            reason = `Cannot read/parse local link file: ${(error as Error).message}`;
          }
        }
      }

      if (needs_update) {
        core.info(` -> Change detected for: ${expected_path} (Reason: ${reason})`);
        // Store the DriveItem needing processing, keyed by ID to avoid duplicates if both link/content change
        // Target path for handle_download_item is the *conceptual* content path
        const targetContentPath = expected_info.type === 'content'
          ? expected_path
          : path.join(path.dirname(expected_path), expected_info.driveItem.name).replace(/\\/g, '/'); // Use Drive name to reconstruct base path

        if (!drive_items_needing_processing.has(expected_info.driveItem.id)) {
          drive_items_needing_processing.set(expected_info.driveItem.id, {
            driveItem: expected_info.driveItem,
            targetContentPath: targetContentPath
          });
          // Also add to list for PR body
          drive_items_causing_update.push(expected_info.driveItem);
        }
      }
    }

    // Files to Delete: Iterate initial local files and check if they are in the expected set
    for (const [local_path, _local_file_info] of initial_local_map) {
      if (!expected_local_files.has(local_path)) {
        local_paths_identified_for_deletion.add(local_path);
        core.info(` -> Deletion identified for local path: ${local_path}`);
      }
    }

    // Identify Empty Folders for Deletion (optional but good practice)
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
    expected_local_files.forEach((_, expected_path) => {
      let dir = path.dirname(expected_path);
      while (dir && dir !== '.') {
        expected_local_dirs.add(dir);
        dir = path.dirname(dir);
      }
    });
    // Find dirs present initially but not expected anymore
    for (const initial_dir of initial_local_dirs) {
      if (!expected_local_dirs.has(initial_dir)) {
        // Check if this directory is already implicitly deleted by deleting a parent
        let parent_deleted = false;
        for (const deleted_path of local_paths_identified_for_deletion) {
          if (initial_dir.startsWith(deleted_path + path.sep)) {
            parent_deleted = true;
            break;
          }
        }
        // Also check if it might still be needed by a Drive folder (less common case)
        const drive_folder_exists = drive_folders.has(initial_dir);

        if (!parent_deleted && !drive_folder_exists) {
          core.info(` -> Deletion identified for potentially empty local directory: ${initial_dir}`);
          local_paths_identified_for_deletion.add(initial_dir); // Add directory itself for deletion
        }
      }
    }


    core.info(`Identified ${drive_items_needing_processing.size} Drive items needing add/update.`);
    core.info(`Identified ${local_paths_identified_for_deletion.size} local paths/folders for deletion.`);
    core.endGroup();


    // --- Step 5: Apply File System Changes ---
    core.startGroup('Applying File System Changes');
    let changes_applied = false;

    // 5a. Apply Deletions
    if (local_paths_identified_for_deletion.size > 0) {
      // Sort paths: deeper paths first for safe deletion
      const sorted_deletion_paths = Array.from(local_paths_identified_for_deletion).sort((a, b) => {
        const depth_a = a.split(path.sep).length;
        const depth_b = b.split(path.sep).length;
        if (depth_a !== depth_b) return depth_b - depth_a;
        return a.localeCompare(b);
      });

      core.info(`Applying ${sorted_deletion_paths.length} deletions...`);
      for (const local_path_to_delete of sorted_deletion_paths) {
        try {
          // Check existence before attempting rm
          const stats = await fs_promises.lstat(local_path_to_delete).catch(() => null); // Use lstat, catch error if not found
          if (stats) {
            core.info(`   - Removing: ${local_path_to_delete}`);
            await fs_promises.rm(local_path_to_delete, { recursive: true, force: true }); // Use recursive for directories
            changes_applied = true;
          } else {
            core.debug(`   - Skipping removal, path already gone: ${local_path_to_delete}`);
          }
        } catch (error) {
          core.error(`   - Failed to remove ${local_path_to_delete}: ${(error as Error).message}`);
          // Continue attempting other deletions
        }
      }
    }

    // 5b. Apply Additions/Updates
    if (drive_items_needing_processing.size > 0) {
      core.info(`Applying ${drive_items_needing_processing.size} additions/updates...`);
      for (const { driveItem, targetContentPath } of drive_items_needing_processing.values()) {
        core.info(`   - Processing Drive item: ${driveItem.name || `(ID: ${driveItem.id})`} -> Target local content path: ${targetContentPath}`);
        try {
          // handle_download_item creates directories and downloads/updates content/link files
          await handle_download_item(driveItem, targetContentPath);
          changes_applied = true; // Mark that file system operations happened
        } catch (error) {
          core.error(`   - Failed to process item from Drive ${driveItem.name || `(ID: ${driveItem.id})`} to ${targetContentPath}: ${(error as Error).message}`);
          // Continue attempting other items
        }
      }
    }
    core.endGroup();

    // --- Step 6: Stage, Commit, Push, and Create PR ---
    if (!changes_applied) {
      core.info("No file system changes were applied. Checking Git status anyway.");
      // Fall through to Git status check, as sometimes FS changes might not be tracked correctly
    }

    core.startGroup('Committing Changes and Creating PR');
    // Configure Git user
    await execute_git("config", ["--local", "user.email", git_user_email || "github-actions[bot]@users.noreply.github.com"]); // Provide default
    await execute_git("config", ["--local", "user.name", git_user_name || "github-actions[bot]"]); // Provide default

    // Stage ALL changes relative to the original state
    core.info("Staging all detected changes...");
    await execute_git("add", ["."]); // Stage new/modified files
    // `git add .` might not stage deletions of previously tracked files correctly in all git versions.
    // Use `git add -u` to stage modifications and deletions of tracked files.
    await execute_git("add", ["-u"]); // Stage modifications/deletions

    // Check Git status
    const status_result = await execute_git('status', ['--porcelain']);
    if (!status_result.stdout.trim()) {
      core.info("Git status is clean. No commit needed.");
      core.endGroup();
      return result; // No PR needed
    }

    core.info("Git status shows changes. Proceeding with commit.");
    core.debug("Git status output:\n" + status_result.stdout);

    // Commit message details
    const commit_detail_lines = [];
    // Use drive_items_causing_update for Added/Updated list
    const added_updated_display_paths = drive_items_causing_update
      .map(item => item.name || item.id) // Display Drive name or ID
      .sort((a, b) => a.localeCompare(b));
    if (added_updated_display_paths.length > 0) commit_detail_lines.push(`- Add/Update (from Drive): ${added_updated_display_paths.map(p => `'${p}'`).join(", ")}`);

    // Use local_paths_identified_for_deletion for Removed list
    const removed_display_paths = Array.from(local_paths_identified_for_deletion).sort((a, b) => a.localeCompare(b));
    if (removed_display_paths.length > 0) commit_detail_lines.push(`- Remove (local paths): ${removed_display_paths.map(p => `'${p}'`).join(", ")}`);

    const commit_message = [
      `Sync changes from Google Drive (${folder_id})`,
      ...commit_detail_lines,
      `\nSource Drive Folder ID: ${folder_id}`,
      `Workflow Run ID: ${run_id}`
    ].join("\n");

    try {
      core.info("Committing staged changes on temporary branch...");
      await execute_git("commit", ["-m", commit_message]);
      const sync_commit_hash = (await execute_git('rev-parse', ['HEAD'], { silent: true })).stdout.trim();
      core.info(`Created sync commit ${sync_commit_hash} on temporary branch '${original_state_branch}'.`);

      const sanitized_folder_id = folder_id.replace(/[^a-zA-Z0-9_-]/g, '_');
      const head_branch = `sync-from-drive-${sanitized_folder_id}`;
      result.head_branch = head_branch; // Store head branch early

      core.info(`Preparing PR branch: ${head_branch}`);
      // Check existence and create/checkout/reset PR branch
      const local_branch_exists_check = await execute_git('show-ref', ['--verify', `refs/heads/${head_branch}`], { ignoreReturnCode: true, silent: true });
      const remote_branch_exists_check = await execute_git('ls-remote', ['--exit-code', '--heads', 'origin', head_branch], { ignoreReturnCode: true, silent: true });
      const local_branch_exists = local_branch_exists_check.exitCode === 0;
      const remote_branch_exists = remote_branch_exists_check.exitCode === 0;

      if (local_branch_exists) {
        core.info(`Branch ${head_branch} exists locally. Checking it out and resetting...`);
        await execute_git("checkout", ["--force", head_branch]);
        await execute_git("reset", ["--hard", sync_commit_hash]);
      } else if (remote_branch_exists) {
        core.info(`Branch ${head_branch} exists remotely. Fetching, checking out, and resetting...`);
        try {
          await execute_git("fetch", ["origin", `${head_branch}:${head_branch}`]);
          await execute_git("checkout", ["--force", head_branch]);
          await execute_git("reset", ["--hard", sync_commit_hash]);
        } catch (fetchCheckoutError) {
          core.warning(`Failed to fetch/checkout/reset remote branch ${head_branch}. Creating new local branch from sync commit. Error: ${(fetchCheckoutError as Error).message}`);
          await execute_git("checkout", ["-b", head_branch, sync_commit_hash]);
        }
      } else {
        core.info(`Branch ${head_branch} does not exist. Creating it from sync commit...`);
        await execute_git("checkout", ["-b", head_branch, sync_commit_hash]);
      }

      core.info(`Pushing branch ${head_branch} to origin...`);
      await execute_git("push", ["--force", "origin", head_branch]);

      const pr_title = `Sync changes from Google Drive (${folder_id})`;
      // Use the new lists for the PR body
      const pr_body = format_pr_body(
        folder_id,
        run_id,
        drive_items_causing_update, // Pass the list of Drive items
        local_paths_identified_for_deletion // Pass the set of deleted local paths
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
        result = { pr_number: pr_result.number, head_branch: head_branch };
      } else {
        core.info("Pull request was not created or updated (e.g., no diff or error).");
        if (!result.head_branch) result = {};
      }
    } catch (error) {
      core.error(`Failed during commit, push, or PR creation: ${(error as Error).message}`);
      if (!result.head_branch) result = {};
    } finally {
      core.endGroup(); // End Commit/PR group
    }

  } catch (error) {
    core.error(`Error during Drive change handling for folder ${folder_id}: ${(error as Error).message}`);
    result = {}; // Clear result on major error
  } finally {
    // --- Cleanup logic remains the same ---
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
