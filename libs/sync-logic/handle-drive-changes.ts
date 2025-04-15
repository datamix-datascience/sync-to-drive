import * as core from "@actions/core";
import * as path from "path";
import * as fs from "fs"; // Need fs.promises
import { execute_git } from "../git";
import { list_local_files } from "../local-files/list";
import { list_drive_files_recursively } from "../google-drive/list";
import { handle_download_item } from "../google-drive/files";
import { create_pull_request_with_retry } from "../github/pull-requests";
import { octokit } from "../github/auth"; // Get the initialized octokit instance
import { DriveItem } from "../google-drive/types";
import { GOOGLE_DOC_MIME_TYPES, MIME_TYPE_TO_EXTENSION } from "../google-drive/file_types";
import { FileInfo } from "../local-files/types";


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
): Promise<void> {
  core.info(`Handling potential incoming changes from Drive folder: ${folder_id} (Trigger: ${trigger_event_name}, Untrack action: ${on_untrack_action})`);

  let original_state_branch: string = ''; // Initialize for finally block safety
  const repo_info = get_repo_info(); // Get repo info early
  const run_id = process.env.GITHUB_RUN_ID || Date.now().toString();

  // *** Determine Initial Branch Name FIRST ***
  // This is now outside the main try/finally for sync logic & cleanup.
  // If this fails, the function will exit early.
  const initial_branch = await determineInitialBranch(repo_info);

  try {
    // *** 1. Create temporary state branch ***
    // initial_branch is guaranteed to be assigned here.
    original_state_branch = `original-state-${folder_id}-${run_id}`;
    core.info(`Initial branch is '${initial_branch}'. Creating temporary state branch '${original_state_branch}'`);
    const initial_commit_hash = (await execute_git('rev-parse', ['HEAD'], { silent: true })).stdout.trim();
    // Ensure the commit hash exists before trying to branch from it
    if (!initial_commit_hash) {
      throw new Error("Could not get initial commit hash.");
    }
    await execute_git("checkout", ["-b", original_state_branch, initial_commit_hash]);

    // *** 2. List local files from the state branch ***
    core.info("Listing local files from original state branch...");
    const local_files_list = await list_local_files("."); // List files in the checked-out original state
    const local_map = new Map(local_files_list.map(f => [f.relative_path.replace(/\\/g, '/'), f]));
    core.info(`Found ${local_map.size} relevant local files in original state.`);

    // Case-insensitive lookup map
    const local_lower_to_original_key = new Map<string, string>();
    local_map.forEach((_, key) => {
      local_lower_to_original_key.set(key.toLowerCase(), key);
    });
    core.debug(`Created lowercase lookup map with ${local_lower_to_original_key.size} entries.`);


    // *** 3. List Drive content ***
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
      // Jump to finally for cleanup, don't proceed with comparison/PR
      return;
    }

    // *** 4. Compare Drive state to local state ***
    const new_files_to_process: { path: string; item: DriveItem }[] = [];
    const modified_files_to_process: { path: string; item: DriveItem }[] = [];
    const deleted_local_paths: string[] = [];
    const found_local_keys = new Set<string>();

    for (const [drive_path, drive_item] of drive_files) {
      core.debug(`Comparing Drive item: '${drive_path}' (ID: ${drive_item.id})`);
      const drive_path_lower = drive_path.toLowerCase();
      const is_google_doc = GOOGLE_DOC_MIME_TYPES.includes(drive_item.mimeType || "");

      let expected_local_shortcut_path = "";
      if (is_google_doc && drive_item.name) {
        const type_extension = MIME_TYPE_TO_EXTENSION[drive_item.mimeType!] || 'googledoc';
        const drive_base_name = path.basename(drive_item.name);
        const drive_dir_name = path.dirname(drive_path);
        const shortcut_filename = `${drive_base_name}.${type_extension}.json.txt`;
        expected_local_shortcut_path = drive_dir_name === '.' ? shortcut_filename : path.join(drive_dir_name, shortcut_filename).replace(/\\/g, '/');
        core.debug(` -> Is Google Doc. Expected local shortcut path: '${expected_local_shortcut_path}'`);
      } else if (is_google_doc && !drive_item.name) {
        core.warning(`Google Doc item (ID: ${drive_item.id}) has no name. Cannot determine expected shortcut path accurately.`);
      }

      const direct_match_key = local_lower_to_original_key.get(drive_path_lower);
      const shortcut_match_key = expected_local_shortcut_path ? local_lower_to_original_key.get(expected_local_shortcut_path.toLowerCase()) : undefined;

      let found_local_info: FileInfo | undefined = undefined;
      let actual_found_local_key: string | undefined = undefined;

      if (direct_match_key) {
        found_local_info = local_map.get(direct_match_key);
        actual_found_local_key = direct_match_key;
        core.debug(` -> Found direct match in local map: '${actual_found_local_key}'`);
      } else if (shortcut_match_key) {
        found_local_info = local_map.get(shortcut_match_key);
        actual_found_local_key = shortcut_match_key;
        core.debug(` -> Found shortcut match in local map: '${actual_found_local_key}'`);
      }

      if (!found_local_info || !actual_found_local_key) {
        core.debug(` -> Local file NOT FOUND for Drive item '${drive_path}'. Treating as NEW.`);
        new_files_to_process.push({ path: drive_path, item: drive_item });
      } else {
        found_local_keys.add(actual_found_local_key);
        let needs_modification = false;
        if (is_google_doc && expected_local_shortcut_path) {
          if (actual_found_local_key !== expected_local_shortcut_path) {
            core.info(`Modification detected for GDoc '${drive_path}': Local file '${actual_found_local_key}' needs update to expected shortcut format '${expected_local_shortcut_path}'.`);
            needs_modification = true;
          } else {
            core.debug(` -> Google Doc '${drive_path}' found locally as correct shortcut '${actual_found_local_key}'. No content change needed.`);
          }
        } else if (!is_google_doc) {
          const is_local_file_shortcut_format = actual_found_local_key.endsWith('.json.txt') && GOOGLE_DOC_MIME_TYPES.some(mime => actual_found_local_key.includes(`.gdrive-link.json.txt`));
          if (is_local_file_shortcut_format) {
            core.info(`Modification detected for non-GDoc '${drive_path}': Local file '${actual_found_local_key}' is an unexpected shortcut format. Updating.`);
            needs_modification = true;
          } else if (drive_item.hash && found_local_info.hash !== drive_item.hash) {
            core.info(`Modification detected for file '${drive_path}': Hash mismatch.`);
            needs_modification = true;
          } else if (!drive_item.hash && !is_google_doc) {
            core.warning(`Drive file '${drive_path}' (non-GDoc) has no md5Checksum. Treating as modified to ensure latest version.`);
            needs_modification = true;
          } else if (drive_path !== actual_found_local_key) {
            core.info(`Rename detected: Drive path '${drive_path}' differs from matched local path '${actual_found_local_key}'. Will be handled as delete+add.`);
            needs_modification = true;
          } else {
            core.debug(` -> File '${drive_path}' found locally ('${actual_found_local_key}') and matches Drive state. No modification needed.`);
          }
        }
        if (needs_modification) {
          modified_files_to_process.push({ path: drive_path, item: drive_item });
        }
      }
    } // End of comparison loop


    // *** 5. Identify files/folders deleted in Drive ***
    core.debug("Checking for items deleted in Drive...");
    for (const [local_key, _local_file_info] of local_map) {
      if (!found_local_keys.has(local_key)) {
        core.info(`Deletion detected: Local item '${local_key}' not found during Drive scan.`);
        deleted_local_paths.push(local_key);
      }
    }
    const local_folders = new Set<string>();
    local_files_list.forEach(f => {
      let dir = path.dirname(f.relative_path);
      while (dir && dir !== '.') {
        local_folders.add(dir.replace(/\\/g, '/'));
        dir = path.dirname(dir);
      }
    });
    core.debug(`Local folders derived from file paths: ${[...local_folders].join(', ')}`)
    for (const local_folder_path of local_folders) {
      if (!drive_folders.has(local_folder_path) && !deleted_local_paths.some(p => p === local_folder_path || p.startsWith(local_folder_path + '/'))) {
        const files_under_folder_in_drive = [...drive_files.keys()].some(drive_path => drive_path.startsWith(local_folder_path + '/'));
        if (!files_under_folder_in_drive) {
          core.info(`Deletion detected: Local folder '${local_folder_path}' seems removed from Drive.`);
          if (!deleted_local_paths.includes(local_folder_path)) {
            deleted_local_paths.push(local_folder_path);
          }
        }
      }
    }
    core.info(`Identified ${deleted_local_paths.length} local paths corresponding to items potentially deleted/renamed in Drive.`);


    // *** 6. Apply changes locally and stage them ***
    let changes_made = false;
    const added_or_updated_paths_final = new Set<string>();
    const removed_paths_final = new Set<string>();

    // --- Handle Deletions FIRST ---
    const should_remove = trigger_event_name !== 'push' && on_untrack_action === 'remove';
    if (deleted_local_paths.length > 0) {
      if (should_remove) {
        core.info(`Processing ${deleted_local_paths.length} local items to remove...`);
        for (const local_path_to_delete of deleted_local_paths) {
          try {
            if (!fs.existsSync(local_path_to_delete)) {
              core.debug(`Local item '${local_path_to_delete}' already removed. Skipping git rm.`);
              continue;
            }
            core.info(`Removing local item: ${local_path_to_delete}`);
            await execute_git("rm", ["-r", "--ignore-unmatch", "--", local_path_to_delete]);
            removed_paths_final.add(local_path_to_delete);
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

    // --- Handle New and Modified Files ---
    const items_to_process = [...new_files_to_process, ...modified_files_to_process];
    core.info(`Processing ${new_files_to_process.length} new and ${modified_files_to_process.length} modified items from Drive...`);

    for (const { path: original_drive_path, item: drive_item } of items_to_process) {
      let target_local_path: string;
      const is_google_doc = GOOGLE_DOC_MIME_TYPES.includes(drive_item.mimeType || "");

      if (is_google_doc && drive_item.name) {
        const type_extension = MIME_TYPE_TO_EXTENSION[drive_item.mimeType!] || 'googledoc';
        const drive_base_name = path.basename(drive_item.name);
        const drive_dir_name = path.dirname(original_drive_path);
        const shortcut_filename = `${drive_base_name}.${type_extension}.json.txt`;
        target_local_path = drive_dir_name === '.' ? shortcut_filename : path.join(drive_dir_name, shortcut_filename).replace(/\\/g, '/');
      } else if (is_google_doc && !drive_item.name) {
        core.warning(`Cannot determine target path for unnamed Google Doc ${drive_item.id}. Skipping processing.`);
        continue;
      }
      else {
        target_local_path = original_drive_path;
      }

      core.info(`Handling Drive item: ${drive_item.name || `(ID: ${drive_item.id})`} -> Target local path: ${target_local_path}`);

      try {
        const local_dir = path.dirname(target_local_path);
        if (local_dir && local_dir !== '.') {
          await fs.promises.mkdir(local_dir, { recursive: true });
        }
        const { linkFilePath, contentFilePath } = await handle_download_item(drive_item, target_local_path);

        const add_or_updated = async (final_local_path?: string) => {
          if (!final_local_path) return;
          core.info(`Staging added/updated file: ${final_local_path}`);
          await execute_git("add", ["--", final_local_path]);
          added_or_updated_paths_final.add(final_local_path);
          changes_made = true;

          if (removed_paths_final.has(final_local_path)) {
            core.debug(`Path ${final_local_path} was added/updated, removing from final deletion list.`);
            removed_paths_final.delete(final_local_path);
          }
        }

        add_or_updated(linkFilePath);
        add_or_updated(contentFilePath);
      } catch (error) {
        core.error(`Failed to process/stage item from Drive ${drive_item.name || `(ID: ${drive_item.id})`} to ${target_local_path}: ${(error as Error).message}`);
      }
    } // End of processing loop


    // *** 7. Commit, Push, and Create PR if changes were made ***
    if (!changes_made && removed_paths_final.size === 0 && added_or_updated_paths_final.size === 0) {
      core.info("No effective local file changes detected (add/update/remove). Skipping commit and PR.");
      return; // Jump to finally
    }

    const status_result = await execute_git('status', ['--porcelain']);
    if (!status_result.stdout.trim()) {
      core.info("Git status clean after processing changes. No commit needed.");
      if (changes_made) {
        core.warning("Logic indicated changes were made, but git status is clean. Investigate if expected changes were skipped.");
      }
      return; // Jump to finally
    } else {
      core.info("Git status is not clean, proceeding with commit.");
      core.debug("Git status output:\n" + status_result.stdout);
    }

    core.info("Changes detected originating from Drive. Proceeding with commit and PR.");
    const commit_messages: string[] = [`Sync changes from Google Drive (${folder_id})`];
    if (added_or_updated_paths_final.size > 0) commit_messages.push(`- Add/Update: ${[...added_or_updated_paths_final].map(p => `'${p}'`).join(", ")}`);
    if (removed_paths_final.size > 0) commit_messages.push(`- Remove: ${[...removed_paths_final].map(p => `'${p}'`).join(", ")}`);
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

      if (local_branch_exists) {
        core.info(`Branch ${head_branch} exists locally. Checking it out...`);
        await execute_git("checkout", [head_branch]);
      } else if (remote_branch_exists) {
        core.info(`Branch ${head_branch} exists remotely but not locally. Fetching and checking out...`);
        try {
          // Fetch the remote branch specifically into the local namespace with the same name
          await execute_git("fetch", ["origin", `${head_branch}:${head_branch}`]);
          // Now checkout the local branch that was just created/updated by fetch
          await execute_git("checkout", [head_branch]);
        } catch (fetchCheckoutError) {
          core.warning(`Failed to fetch/checkout remote branch ${head_branch}. Creating new local branch from commit hash as fallback. Error: ${(fetchCheckoutError as Error).message}`);
          // Fallback: Create the branch purely locally from the hash if fetch/checkout failed
          await execute_git("checkout", ["-b", head_branch, sync_commit_hash]);
        }
      } else {
        core.info(`Branch ${head_branch} does not exist locally or remotely. Creating it from commit hash...`);
        await execute_git("checkout", ["-b", head_branch, sync_commit_hash]);
      }

      // ** Critical Step: ** Ensure the checked-out branch points exactly to the new commit
      core.info(`Resetting branch ${head_branch} to sync commit ${sync_commit_hash}...`);
      await execute_git("reset", ["--hard", sync_commit_hash]); // DO NOT ignore return code here - reset must succeed


      // --- Push and PR ---
      core.info(`Pushing branch ${head_branch} to origin...`);
      await execute_git("push", ["--force", "origin", head_branch]);

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
        base: initial_branch, // Use the safely determined initial branch
        body: pr_body
      };

      core.info(`Attempting to create or update Pull Request: ${pr_title} (${head_branch} -> ${initial_branch})`);
      const pr_result = await create_pull_request_with_retry(octokit, pr_params);

      if (pr_result) {
        core.info(`Pull request operation successful: ${pr_result.url}`);
      } else {
        core.info("Pull request was not created or updated.");
      }

    } catch (error) {
      core.error(`Failed during commit, push, or PR creation: ${(error as Error).message}`);
    }

  } catch (error) {
    // Catch errors from the main sync logic (state branching, listing, comparison, processing)
    core.error(`Error during Drive change handling for folder ${folder_id}: ${(error as Error).message}`);
    // Allow finally block to run for cleanup
  } finally {
    // *** 8. Cleanup ***
    // initial_branch is guaranteed to be assigned because determineInitialBranch runs first and throws on failure.
    core.info(`Cleaning up temporary branch '${original_state_branch}' and returning to '${initial_branch}'`);
    try {
      const current_cleanup_branch_result = await execute_git('rev-parse', ['--abbrev-ref', 'HEAD'], { silent: true, ignoreReturnCode: true });
      const current_cleanup_branch = current_cleanup_branch_result.stdout.trim();

      // Only checkout if not already on the initial branch
      if (current_cleanup_branch !== initial_branch) {
        core.info(`Currently on branch '${current_cleanup_branch || 'detached HEAD'}', checking out initial branch '${initial_branch}'...`);
        // Use --force checkout to discard potential failed changes from try block
        await execute_git("checkout", ["--force", initial_branch]);
      } else {
        core.info(`Already on initial branch '${initial_branch}'.`);
      }

      // Delete the temporary state branch if it exists
      if (original_state_branch) {
        const branch_check = await execute_git('show-ref', ['--verify', `refs/heads/${original_state_branch}`], { ignoreReturnCode: true, silent: true });
        if (branch_check.exitCode === 0) {
          core.info(`Deleting temporary state branch '${original_state_branch}'...`);
          await execute_git("branch", ["-D", original_state_branch]);
        } else {
          core.debug(`Temporary state branch '${original_state_branch}' not found for deletion (already deleted or never created?).`);
        }
      }
    } catch (checkoutError) {
      core.warning(`Failed to fully clean up Git state (checkout initial branch or delete temp branch). Manual cleanup may be needed. Error: ${(checkoutError as Error).message}`);
    }
  }
}
