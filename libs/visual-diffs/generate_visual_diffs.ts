import * as core from '@actions/core';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Buffer } from 'buffer';
import { execute_git, GitResult } from '../git.js'; // Assuming GitResult type exists
import { convert_pdf_to_pngs } from './pdf_converter.js';
import { fetch_drive_file_as_pdf } from './google_drive_fetch.js';
import { GenerateVisualDiffsParams } from './types.js';
import { MIME_TYPE_TO_EXTENSION } from '../google-drive/file_types.js'; // Import the map

const SKIP_CI_TAG = '[skip visual-diff]'; // Specific tag for this step

/**
 * Checks the latest commit message on the specified remote branch for a skip tag.
 */
async function should_skip_generation(branch_name: string): Promise<boolean> {
  core.startGroup(`Checking latest commit on remote branch 'origin/${branch_name}' for skip tag`);
  try {
    // Fetch latest changes for the branch first to ensure we have the remote head ref
    core.info(`Fetching latest updates for branch ${branch_name}...`);
    await execute_git('fetch', ['origin', branch_name, '--depth=1'], { silent: true }); // Fetch only the latest commit

    // Get the commit message of the most recent commit on the *remote* branch ref
    const latest_commit_message_result = await execute_git(
      'log',
      ['-1', '--pretty=%B', `origin/${branch_name}`], // Check the remote ref head
      { silent: true, ignoreReturnCode: true }
    );

    if (latest_commit_message_result.exitCode !== 0 || !latest_commit_message_result.stdout) {
      core.warning(`Could not get latest commit message from origin/${branch_name}. Exit code: ${latest_commit_message_result.exitCode}. Stderr: ${latest_commit_message_result.stderr}`);
      core.info('Proceeding with generation as skip status is uncertain.');
      core.endGroup();
      return false;
    }

    const latest_commit_message = latest_commit_message_result.stdout.trim();
    core.debug('Latest commit message on remote branch:\n' + latest_commit_message);

    if (latest_commit_message.includes(SKIP_CI_TAG)) {
      core.info(`Latest commit message contains '${SKIP_CI_TAG}'. Skipping PNG generation.`);
      core.endGroup();
      return true; // Skip
    } else {
      core.info('Previous commit does not contain the skip tag. Proceeding with generation.');
      core.endGroup();
      return false; // Don't skip
    }

  } catch (error: any) {
    core.warning(`Failed to check previous commit message on branch ${branch_name}: ${error.message}. Proceeding cautiously.`);
    core.endGroup();
    return false; // Default to not skipping if check fails
  }
}

/**
 * Stages, commits, and pushes changes within a specified directory.
 */
async function stage_commit_and_push_changes(
  changes_dir: string,
  commit_message: string,
  git_user_email: string,
  git_user_name: string,
  target_branch: string // Need the branch name for the push command
): Promise<void> {
  core.startGroup(`Committing and Pushing changes in '${changes_dir}' to branch '${target_branch}'`);
  try {
    // Configure Git user for this commit action
    core.info(`Configuring Git user: ${git_user_name} <${git_user_email}>`);
    await execute_git("config", ["--local", "user.email", git_user_email]);
    await execute_git("config", ["--local", "user.name", git_user_name]);

    core.info(`Adding changes within '${changes_dir}' to Git index...`);
    // Add the specific base directory. This will stage:
    // - New files created within it.
    // - Modified files within it.
    // - Deletions of files/directories within it (because they are gone from the filesystem
    //   compared to the index/HEAD state).
    await execute_git('add', [changes_dir]);

    // Check if there are staged changes *within the target directory*
    const status_result: GitResult = await execute_git(
      'status',
      ['--porcelain', '--', changes_dir], // Limit status check to the target dir
      { ignoreReturnCode: true, silent: true } // Silence expected output
    );

    if (status_result.exitCode !== 0) {
      core.warning(`Git status check failed with code ${status_result.exitCode}. Stderr: ${status_result.stderr}`);
      // Proceeding, but this might indicate an issue.
    }

    if (!status_result.stdout.trim()) {
      core.info(`No staged changes detected within '${changes_dir}' after add operation. Nothing to commit.`);
      core.endGroup();
      return; // Exit cleanly, nothing to do
    }
    core.info("Staged changes detected within target directory.");
    core.debug("Staged changes:\n" + status_result.stdout);

    core.info('Committing staged changes...');
    await execute_git('commit', ['-m', commit_message]);

    core.info(`Pushing changes to branch ${target_branch}...`);
    // Using --force as this branch is assumed to be managed by the action. Adjust if needed.
    await execute_git('push', ['--force', 'origin', target_branch]);

    core.info('Changes pushed successfully.');

  } catch (error: any) {
    core.error(`Failed to stage, commit, or push changes: ${error.message}`);
    if (error.stderr) { // If the error object has stderr (e.g., from execute_git)
      core.error(`Git command stderr: ${error.stderr}`);
    }
    throw error; // Re-throw to indicate failure
  } finally {
    // Optional: Unset git config if needed, though usually not required in CI runners
    // await execute_git("config", ["--local", "--unset", "user.email"]);
    // await execute_git("config", ["--local", "--unset", "user.name"]);
    core.endGroup();
  }
}


/**
 * Main function to generate visual diffs for a Pull Request.
 */
export async function generate_visual_diffs_for_pr(params: GenerateVisualDiffsParams): Promise<void> {
  core.startGroup(`Generating Visual Diffs for PR #${params.pr_number} on branch ${params.head_branch}`);
  core.info(`Repo: ${params.owner}/${params.repo}`);
  core.info(`Output Base Directory: ${params.output_base_dir}`);
  core.info(`PNG Resolution: ${params.resolution_dpi} DPI`);

  // --- Skip Check ---
  if (await should_skip_generation(params.head_branch)) {
    core.info("Skipping visual diff generation based on remote commit message.");
    core.endGroup();
    return;
  }

  // --- Setup Git Environment ---
  core.startGroup(`Setting up Git environment for branch ${params.head_branch}`);
  try {
    core.info(`Fetching latest state of branch '${params.head_branch}'...`);
    // Fetch should happen before checkout
    await execute_git('fetch', ['origin', params.head_branch]);

    core.info(`Checking out branch '${params.head_branch}'...`);
    // Checkout the branch to ensure the working directory is at the correct baseline
    await execute_git('checkout', [params.head_branch]);

    // Optional: Pull to fast-forward if necessary, though checkout should handle most cases
    // await execute_git('pull', ['origin', params.head_branch]);

    core.info('Verifying Git state after checkout...');
    const currentBranch = await execute_git('rev-parse', ['--abbrev-ref', 'HEAD'], { silent: true });
    const currentHead = await execute_git('rev-parse', ['HEAD'], { silent: true });
    if (currentBranch.stdout.trim() !== params.head_branch) {
      throw new Error(`Failed to checkout correct branch. Expected '${params.head_branch}', but on '${currentBranch.stdout.trim()}'`);
    }
    core.info(`Successfully checked out branch: ${currentBranch.stdout.trim()} at SHA: ${currentHead.stdout.trim()}`);
    const status = await execute_git('status', ['--short'], { silent: true });
    core.info(`Git status after checkout:\n${status.stdout || '(clean)'}`);

  } catch (error: any) {
    core.error(`Failed to setup Git environment: ${error.message}`);
    if (error.stderr) core.error(`Git stderr: ${error.stderr}`);
    core.endGroup();
    throw error; // Cannot proceed without correct git state
  } finally {
    core.endGroup();
  }

  // --- Ensure output directory exists ---
  try {
    core.info(`Ensuring output directory exists: ${params.output_base_dir}`);
    await fs.promises.mkdir(params.output_base_dir, { recursive: true });
  } catch (dirError: any) {
    core.error(`Failed to create output directory ${params.output_base_dir} after checkout: ${dirError.message}`);
    throw dirError;
  }

  // --- Find Changed Link Files in PR ---
  core.startGroup('Finding Changed Link Files in PR');
  // Store just the path reported by GitHub API initially
  const changed_link_file_paths: string[] = [];
  const known_extensions_vd = Object.values(MIME_TYPE_TO_EXTENSION).join('|');
  // Regex still useful for *finding* the relevant files, even if we don't capture groups here
  const link_file_regex_vd = new RegExp(`--[a-zA-Z0-9_-]+\\.(${known_extensions_vd})\\.gdrive\\.json$`, 'i');
  core.debug(`Using regex to find link files: ${link_file_regex_vd}`);

  // *** ADDED DEBUGGING: Log all files found ***
  core.info("Listing all files returned by GitHub API for PR diff...");
  let api_file_count = 0;
  // *** END ADDED DEBUGGING ***

  try {
    const files_iterator = params.octokit.paginate.iterator(params.octokit.rest.pulls.listFiles, {
      owner: params.owner, repo: params.repo, pull_number: params.pr_number, per_page: 100,
    });

    for await (const { data: files } of files_iterator) {
      for (const file of files) {
        api_file_count++; // Increment counter
        const file_basename = path.basename(file.filename);
        const is_match = link_file_regex_vd.test(file_basename);
        const is_relevant_status = (file.status === 'added' || file.status === 'modified' || file.status === 'renamed' || file.status === 'removed');

        // *** MODIFIED DEBUGGING: Log details for every file ***
        core.debug(`  - API File #${api_file_count}: Path='${file.filename}', Status='${file.status}', Basename='${file_basename}', RegexMatch=${is_match}, RelevantStatus=${is_relevant_status}`);
        // *** END MODIFIED DEBUGGING ***

        if (is_match && is_relevant_status) {
          core.info(` -> Found candidate link file: ${file.filename} (Status: ${file.status})`);
          changed_link_file_paths.push(file.filename); // Store the full path
        }
        // Removed the 'else' block for skipping, as the debug log above covers it.
      }
    }
    // *** ADDED DEBUGGING: Log summary ***
    core.info(`Finished listing API files. Total files checked: ${api_file_count}.`);
    // *** END ADDED DEBUGGING ***
    core.info(`Found ${changed_link_file_paths.length} added/modified/renamed/removed link file(s) matching pattern to process.`);
  } catch (error: any) {
    core.error(`Failed to list PR files via GitHub API: ${error.message}`);
    core.endGroup();
    throw error;
  } finally {
    core.endGroup();
  }

  // If no relevant files changed *according to the PR diff*, we don't need to do anything.
  if (changed_link_file_paths.length === 0) {
    core.info('No relevant changed link files found in this PR update. Nothing to generate or commit.');
    // *** ADDED DEBUGGING: Explicit message before exit ***
    core.warning('Exiting visual diff generation because no matching link files were identified in the PR diff from the API.');
    // *** END ADDED DEBUGGING ***
    core.endGroup(); // Close the main group
    return;
  }

  // --- Setup Temporary Directory ---
  let temp_dir: string | null = null;
  try {
    temp_dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `visual-diff-${params.pr_number}-`));
    core.info(`Using temporary directory: ${temp_dir}`);
  } catch (tempError: any) {
    core.error(`Failed to create temporary directory: ${tempError.message}`);
    // Attempt cleanup just in case
    if (temp_dir) await fs.promises.rm(temp_dir, { recursive: true, force: true }).catch(() => { });
    throw tempError;
  }

  let total_pngs_generated = 0;
  const processed_files_info: string[] = []; // Track info for commit message (PNG generation)
  const cleaned_diff_dirs: string[] = []; // Track cleaned directories

  // --- Process Each Link File ---
  core.startGroup('Processing Files and Generating/Cleaning PNGs');

  // Phase 1: Collect metadata AND determine output path for each link file
  // We still iterate through the *changed* link files from the PR diff to decide what *might* need processing.
  interface ProcessedLinkInfo {
    link_file_path: string; // Full path from PR list (e.g., docs/Report--ID.doc.gdrive.json)
    png_output_relative_path: string; // Relative path for PNG folder (e.g., docs/Report--ID.doc)
    file_id_from_content: string; // ID read from JSON content
    mime_type: string; // Mime type from JSON content
  }
  const files_to_process: ProcessedLinkInfo[] = [];
  core.info('Collecting metadata and calculating output paths based on PR diff...');
  for (const link_file_path of changed_link_file_paths) {
    core.info(`Preparing metadata for: ${link_file_path}`);
    try {
      // Read file content *from the local filesystem* in the checked-out branch
      // This file *might* exist, or it might have been deleted by the sync commit.
      core.debug(`Checking local file content for: ${link_file_path}`);
      let file_content_str: string;
      try {
        file_content_str = await fs.promises.readFile(link_file_path, 'utf-8');
      } catch (readFileError: any) {
        if (readFileError.code === 'ENOENT') {
          // File listed in PR diff but not found locally - means it was deleted.
          // We still need its potential output path for cleanup.
          core.info(`   - Link file ${link_file_path} not found locally (deleted by sync). Will process for cleanup.`);
          // Calculate the expected output path even without content
          const png_output_relative_path = link_file_path.replace(/\.gdrive\.json$/i, '');
          if (png_output_relative_path === link_file_path) {
            core.error(`   - Failed to remove '.gdrive.json' suffix from ${link_file_path} (even though it was deleted). Skipping cleanup for this path.`);
            continue;
          }
          // Add to processing list, but ID/MIME will be dummy values (won't be used for fetch)
          files_to_process.push({
            link_file_path: link_file_path,
            png_output_relative_path: png_output_relative_path,
            file_id_from_content: "deleted", // Placeholder
            mime_type: "deleted", // Placeholder
          });
          continue; // Go to next file in PR diff
        } else {
          // Other read error, re-throw
          throw readFileError;
        }
      }

      // If read succeeded, parse JSON
      const file_data = JSON.parse(file_content_str);

      if (!file_data || typeof file_data.id !== 'string' || typeof file_data.mimeType !== 'string') {
        core.warning(`   - Could not find 'id' and 'mimeType' in JSON content of ${link_file_path}. Skipping.`);
        continue;
      }

      // Calculate the PNG output folder path
      const png_output_relative_path = link_file_path.replace(/\.gdrive\.json$/i, '');
      if (png_output_relative_path === link_file_path) {
        core.error(`   - Failed to remove '.gdrive.json' suffix from ${link_file_path}. Skipping.`);
        continue;
      }

      // Add valid file info to the list
      files_to_process.push({
        link_file_path: link_file_path,
        png_output_relative_path: png_output_relative_path,
        file_id_from_content: file_data.id,
        mime_type: file_data.mimeType,
      });
      core.info(`   - Ready to process: ContentID=${file_data.id}, MIME=${file_data.mimeType}, OutputPath=${png_output_relative_path}`);

    } catch (error: any) {
      core.warning(`   - Failed to read or parse local content of ${link_file_path}: ${error.message}. Skipping.`);
      core.debug(error.stack);
      continue;
    }
  } // End metadata collection loop
  core.info(`Collected metadata for ${files_to_process.length} link files based on PR diff.`);


  // Phase 2: Process files - Fetch PDF, Convert to PNGs OR Cleanup old diffs
  // Now iterate through the collected files_to_process list
  for (const file_info of files_to_process) {
    core.info(`Processing file entry: ${file_info.link_file_path} -> Output Folder: ${file_info.png_output_relative_path}`);
    const { link_file_path, png_output_relative_path, file_id_from_content, mime_type } = file_info;

    // Construct the absolute path for the final PNG output directory
    // It's crucial this uses params.output_base_dir which is relative to the repo root
    const image_output_dir_absolute_path = path.join(params.output_base_dir, png_output_relative_path);

    // *** START CLEANUP/PROCESS LOGIC ***
    // Check if the source link file *still exists* on the filesystem in the checked-out branch
    try {
      // Use access to check existence - throws if not found or no permissions
      await fs.promises.access(link_file_path, fs.constants.F_OK);
      // If access succeeds, the link file exists, proceed to generate/update PNGs
      core.info(`   - Link file '${link_file_path}' exists locally. Proceeding with PNG generation/update.`);

      // --- PNG Generation Path ---
      // Use the relative path's basename for the temp PDF name for clarity
      const temp_pdf_basename = path.basename(png_output_relative_path);
      const temp_pdf_path = path.join(temp_dir!, `${temp_pdf_basename}.pdf`); // Use temp_dir! as it's checked earlier

      // Fetch PDF
      core.info(`   - Fetching Drive file ID ${file_id_from_content} as PDF...`);
      const fetch_success = await fetch_drive_file_as_pdf(params.drive, file_id_from_content, mime_type, temp_pdf_path);

      if (!fetch_success) {
        core.warning(`   - Failed to fetch PDF for ${link_file_path}. Skipping PNG generation.`);
        // Optionally: Decide if you want to REMOVE the existing diff dir if fetch fails
        // For now, we'll leave potentially stale diffs if fetch fails
        continue; // Skip to next file
      }

      // Convert PDF to PNGs
      core.info(`   - Converting PDF to PNGs in target directory: ${image_output_dir_absolute_path}`);
      try {
        // Clean the specific output directory *before* generating new files.
        // This is important for updates where the number of pages might change.
        core.debug(`   - Cleaning existing output directory before regeneration: ${image_output_dir_absolute_path}`);
        // Use force:true to avoid errors if dir doesn't exist yet
        await fs.promises.rm(image_output_dir_absolute_path, { recursive: true, force: true });
        await fs.promises.mkdir(image_output_dir_absolute_path, { recursive: true });

        const generated_pngs = await convert_pdf_to_pngs(temp_pdf_path, image_output_dir_absolute_path, params.resolution_dpi);

        if (generated_pngs.length > 0) {
          total_pngs_generated += generated_pngs.length;
          processed_files_info.push(`'${link_file_path}' (${generated_pngs.length} pages) -> ${png_output_relative_path}`);
          core.info(`   - Successfully generated ${generated_pngs.length} PNGs.`);
        } else {
          core.warning(`   - No PNGs generated from PDF for ${link_file_path}. PDF might be empty or conversion failed.`);
          // We still processed it, even if 0 pages resulted
          processed_files_info.push(`'${link_file_path}' (0 pages) -> ${png_output_relative_path}`);
        }
      } catch (conversionError: any) {
        core.error(`   - Failed during PDF->PNG conversion or directory handling for ${link_file_path}: ${conversionError.message}`);
        core.debug(conversionError.stack);
      } finally {
        // Clean up temporary PDF
        core.debug(`   - Removing temporary PDF: ${temp_pdf_path}`);
        await fs.promises.rm(temp_pdf_path, { force: true, recursive: false }).catch((rmErr: any) =>
          core.warning(`   - Failed to remove temp PDF ${temp_pdf_path}: ${rmErr.message}`)
        );
      }
      // --- End PNG Generation Path ---

    } catch (error: any) {
      // If access check fails, indicating file not found (ENOENT), it means handle_drive_changes deleted it.
      if (error.code === 'ENOENT') {
        // --- Cleanup Path ---
        core.info(`   - Link file '${link_file_path}' not found locally (likely deleted by prior sync step).`);
        core.info(`   - Cleaning up corresponding visual diff directory: ${image_output_dir_absolute_path}`);
        try {
          // Check if the diff directory actually exists before trying to remove
          // Use stat which returns info or throws ENOENT
          await fs.promises.stat(image_output_dir_absolute_path);
          // If stat succeeded, the directory exists, remove it
          await fs.promises.rm(image_output_dir_absolute_path, { recursive: true, force: true });
          core.info(`   - Successfully removed visual diff directory.`);
          // Use the absolute path here, convert to relative later for commit message
          cleaned_diff_dirs.push(image_output_dir_absolute_path); // Track cleaned dir
        } catch (rmOrStatError: any) {
          if (rmOrStatError.code === 'ENOENT') {
            core.info(`   - Visual diff directory '${image_output_dir_absolute_path}' does not exist. No cleanup needed.`);
          } else {
            core.warning(`   - Failed to check or remove visual diff directory '${image_output_dir_absolute_path}': ${rmOrStatError.message}`);
          }
        }
        // --- End Cleanup Path ---
      } else {
        // Log other errors during the access check but still skip processing this file
        core.warning(`   - Error checking existence of link file '${link_file_path}': ${error.message}. Skipping.`);
      }
      // Whether cleanup happened or another error occurred, skip to next file in the list
      continue;
    }
    // *** END CLEANUP/PROCESS LOGIC ***

  } // End loop through files_to_process
  core.endGroup(); // End 'Processing Files' group


  // --- Cleanup Temporary Directory ---
  if (temp_dir) {
    core.info(`Cleaning up base temporary directory: ${temp_dir}`);
    await fs.promises.rm(temp_dir, { recursive: true, force: true }).catch((rmErr: any) =>
      core.warning(`Failed to remove base temp directory ${temp_dir}: ${rmErr.message}`)
    );
  }

  // --- Summarize results ---
  core.info(`Total PNGs generated or updated in this run: ${total_pngs_generated}`);
  if (cleaned_diff_dirs.length > 0) {
    core.info(`Removed ${cleaned_diff_dirs.length} visual diff directories due to missing link files.`);
  }

  // --- Commit and Push Changes ---
  // Commit if we generated PNGs OR cleaned directories
  if (processed_files_info.length > 0 || cleaned_diff_dirs.length > 0) {
    const commit_lines: string[] = [];
    if (processed_files_info.length > 0) {
      commit_lines.push(`Processed ${processed_files_info.length} file(s) for PNG generation:`);
      commit_lines.push(...processed_files_info.map(line => `- ${line}`));
    }
    if (cleaned_diff_dirs.length > 0) {
      commit_lines.push(`Cleaned ${cleaned_diff_dirs.length} visual diff directorie(s):`);
      // Use relative path for cleaner commit message
      // Make relative to the CWD (repo root), not output_base_dir
      commit_lines.push(...cleaned_diff_dirs.map(absPath => `- ${path.relative('.', absPath).replace(/\\/g, '/')}`));
    }

    const commit_message = `${SKIP_CI_TAG} Update visual diff PNGs for PR #${params.pr_number}\n\n${commit_lines.join('\n')}`;

    try {
      // stage_commit_and_push_changes should correctly stage the deletions made by fs.rm
      // when 'git add params.output_base_dir' is called.
      await stage_commit_and_push_changes(
        params.output_base_dir, // Directory containing all changes (additions and deletions)
        commit_message,
        params.git_user_email,
        params.git_user_name,
        params.head_branch // Branch to push to
      );

      // Debug post-commit Git state
      core.debug('Debugging post-commit Git state...');
      try {
        const postCommitBranch = await execute_git('rev-parse', ['--abbrev-ref', 'HEAD'], { silent: true });
        core.debug(`Post-commit branch is now: ${postCommitBranch.stdout.trim()}`); // Should still be head_branch
        const postCommitHead = await execute_git('rev-parse', ['HEAD'], { silent: true });
        core.debug(`Post-commit HEAD SHA: ${postCommitHead.stdout.trim()}`);
        const postCommitLog = await execute_git('log', ['-1', '--pretty=%H %s'], { silent: true });
        core.debug(`Latest commit on local branch:\n${postCommitLog.stdout}`);
      } catch (gitError: any) {
        core.warning(`Could not get post-commit git debug info: ${gitError.message}`);
      }


    } catch (commitError) {
      core.error("Visual diff generation/cleanup process completed, but committing/pushing changes failed.");
      throw commitError; // Fail the action
    }
  } else {
    core.info('No link files were processed or cleaned up. No commit needed.');
  }


  core.info('Visual Diff Generation step finished successfully.');
  core.endGroup(); // End the main group
}
