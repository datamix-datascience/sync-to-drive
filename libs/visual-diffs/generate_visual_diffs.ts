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
 * NOTE: Assumes 'origin' is the relevant remote.
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
 * ASSUMES the correct branch is already checked out and the working directory
 * contains the desired final state (including deletions).
 *
 * @param changes_dir The directory containing the changes to stage and commit relative to repo root.
 * @param commit_message The commit message.
 * @param git_user_email The email address for the Git commit author.
 * @param git_user_name The name for the Git commit author.
 * @param target_branch The name of the branch to push to.
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
  // Check commit message on the *remote* branch before checking out locally
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
  // This should happen *after* checkout, as checkout might remove it if it wasn't tracked
  try {
    core.info(`Ensuring output directory exists: ${params.output_base_dir}`);
    await fs.promises.mkdir(params.output_base_dir, { recursive: true });
  } catch (dirError: any) {
    core.error(`Failed to create output directory ${params.output_base_dir} after checkout: ${dirError.message}`);
    throw dirError;
  }

  // --- Find Changed Link Files in PR ---
  // This uses the GitHub API, independent of local checkout state for *finding* files,
  // but we need the local checkout to get file content later.
  core.startGroup('Finding Changed Link Files in PR');
  const changed_link_files: { path: string; base_name: string; file_type: string }[] = [];
  const known_extensions_vd = Object.values(MIME_TYPE_TO_EXTENSION).join('|');
  const link_file_regex_vd = new RegExp(`\\.(${known_extensions_vd})\\.gdrive\\.json$`, 'i');
  core.debug(`Using regex to find link files: ${link_file_regex_vd}`);

  try {
    const files_iterator = params.octokit.paginate.iterator(params.octokit.rest.pulls.listFiles, {
      owner: params.owner, repo: params.repo, pull_number: params.pr_number, per_page: 100,
    });

    for await (const { data: files } of files_iterator) {
      for (const file of files) {
        const match = file.filename.match(link_file_regex_vd);
        if (
          match &&
          (file.status === 'added' || file.status === 'modified' || file.status === 'renamed')
        ) {
          const matched_suffix = match[0];
          const file_type = match[1];
          const base_name = path.basename(file.filename, matched_suffix);
          core.info(` -> Found candidate: ${file.filename} (Status: ${file.status}) -> Base Name: ${base_name} (Type: ${file_type})`);
          changed_link_files.push({ path: file.filename, base_name, file_type });
        } else {
          core.debug(` -> Skipping file: ${file.filename} (Status: ${file.status}, Pattern mismatch: ${!match})`);
        }
      }
    }
    core.info(`Found ${changed_link_files.length} added/modified/renamed link file(s) matching pattern to process.`);
  } catch (error: any) {
    core.error(`Failed to list PR files via GitHub API: ${error.message}`);
    core.endGroup();
    throw error;
  } finally {
    core.endGroup();
  }

  if (changed_link_files.length === 0) {
    core.info('No relevant changed link files found in this PR update. Nothing to generate or commit.');
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
  const processed_files_info: string[] = []; // Track info for commit message

  // --- Process Each Link File ---
  core.startGroup('Processing Files and Generating PNGs');

  // Phase 1: Collect metadata for all link files
  interface FileMetadata {
    path: string;
    file_id: string;
    mime_type: string;
    original_name: string;
    extension: string;
    file_type: string;
    base_name: string;
    modifiedTime?: string;
  }
  const file_metadata: FileMetadata[] = [];
  core.info('Collecting metadata for changed link files...');
  for (const link_file of changed_link_files) {
    core.info(`Collecting metadata for: ${link_file.path}`);
    try {
      // Read file content *from the local filesystem* which is now checked out to head_sha
      core.debug(`Reading local file content for: ${link_file.path}`);
      // Note: We assume the file exists locally because we checked out the branch.
      // If the PR involves file deletion, listFiles API finds it, but it won't exist locally.
      // We should handle this case. Let's check existence first.

      let file_content_str: string;
      try {
        file_content_str = await fs.promises.readFile(link_file.path, 'utf-8');
      } catch (readFileError: any) {
        if (readFileError.code === 'ENOENT') {
          // This handles the case where the PR deleted the link file.
          // We shouldn't process it for PNGs.
          core.warning(`   - Link file ${link_file.path} not found locally. It might have been deleted in this PR. Skipping.`);
          continue; // Skip to the next link file
        } else {
          // Rethrow other file reading errors
          throw readFileError;
        }
      }

      const file_data = JSON.parse(file_content_str);

      if (!file_data || typeof file_data.id !== 'string' || typeof file_data.mimeType !== 'string') {
        core.warning(`   - Could not find 'id' and 'mimeType' in JSON content of ${link_file.path}. Skipping.`);
        continue;
      }

      const file_id = file_data.id;
      const mime_type = file_data.mimeType;
      const original_name = (typeof file_data.name === 'string' && file_data.name.trim() ? file_data.name.trim() : link_file.base_name).replace(
        new RegExp(`\\.(?:${Object.values(MIME_TYPE_TO_EXTENSION).join('|')})$`, 'i'),
        ''
      );
      const extension = MIME_TYPE_TO_EXTENSION[mime_type] || link_file.file_type;
      const modifiedTime = typeof file_data.modifiedTime === 'string' ? file_data.modifiedTime : undefined;

      file_metadata.push({
        path: link_file.path,
        file_id,
        mime_type,
        original_name,
        extension,
        file_type: link_file.file_type,
        base_name: link_file.base_name,
        modifiedTime
      });
      core.info(`   - Collected: ID=${file_id}, MIME=${mime_type}, Name=${original_name}, Extension=${extension}, Modified=${modifiedTime || 'N/A'}`);

    } catch (error: any) {
      // Handle JSON parsing errors or other unexpected issues
      core.warning(`   - Failed to read or parse local content of ${link_file.path}: ${error.message}. Skipping.`);
      core.debug(error.stack);
      continue; // Skip this file on error
    }
  } // End metadata collection loop

  // Phase 2: Detect duplicates and assign unique folder names
  interface ProcessedMetadata { meta: FileMetadata; folder_name: string; }
  const name_type_map: { [key: string]: FileMetadata[] } = {};
  file_metadata.forEach((meta) => {
    const key = `${meta.original_name}:${meta.extension}`;
    if (!name_type_map[key]) name_type_map[key] = [];
    name_type_map[key].push(meta);
  });

  const processed_metadata: ProcessedMetadata[] = [];
  core.info('Assigning output folder names...');
  for (const key in name_type_map) {
    const files_with_same_name_type = name_type_map[key];
    if (files_with_same_name_type.length > 1) {
      core.info(`Detected ${files_with_same_name_type.length} files resolving to name/type: ${key}. Using file ID for disambiguation.`);
      files_with_same_name_type.sort((a, b) => {
        if (!a.modifiedTime && !b.modifiedTime) return 0;
        if (!a.modifiedTime) return 1;
        if (!b.modifiedTime) return -1;
        return b.modifiedTime.localeCompare(a.modifiedTime);
      });
      files_with_same_name_type.forEach((meta, index) => {
        const folder_name = index === 0
          ? `${meta.original_name}.${meta.extension}`
          : `${meta.original_name}.${meta.file_id.slice(0, 8)}.${meta.extension}`;
        processed_metadata.push({ meta, folder_name });
        core.debug(`   - Assigned folder_name=${folder_name} for ${meta.path} (Modified=${meta.modifiedTime || 'N/A'}, Index=${index})`);
      });
    } else {
      const meta = files_with_same_name_type[0];
      const folder_name = `${meta.original_name}.${meta.extension}`;
      processed_metadata.push({ meta, folder_name });
      core.debug(`   - Assigned folder_name=${folder_name} for ${meta.path} (No duplicates for this name/type)`);
    }
  } // End duplicate handling loop

  // --- Phase 3: Process files - Fetch PDF, Convert to PNGs ---
  // This phase modifies the local filesystem based on the checked-out state.
  for (const { meta, folder_name } of processed_metadata) {
    core.info(`Processing file: ${meta.path} -> Output Folder: ${folder_name}`);
    const { file_id, mime_type } = meta;

    const sanitized_folder_name = folder_name.replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/\s+/g, '_');
    const temp_pdf_path = path.join(temp_dir, `${sanitized_folder_name}.pdf`);
    const relative_dir_of_link_file = path.dirname(meta.path);
    const image_output_dir_relative_path = path.join(relative_dir_of_link_file, sanitized_folder_name);
    const image_output_dir_absolute_path = path.join(params.output_base_dir, image_output_dir_relative_path);

    // Fetch PDF
    core.info(`   - Fetching Drive file ID ${file_id} as PDF...`);
    const fetch_success = await fetch_drive_file_as_pdf(params.drive, file_id, mime_type, temp_pdf_path);

    if (!fetch_success) {
      core.warning(`   - Failed to fetch PDF for ${meta.path}. Skipping PNG generation.`);
      continue; // Skip to next file
    }

    // Convert PDF to PNGs
    core.info(`   - Converting PDF to PNGs in target directory: ${image_output_dir_absolute_path}`);
    try {
      // CRITICAL: Clean the specific output directory *before* generating new files.
      // This occurs *after* checkout, modifying the working directory.
      // It ensures that if pages were deleted in Drive, the corresponding old PNGs
      // are removed from the local filesystem before 'git add'.
      core.debug(`   - Cleaning existing output directory: ${image_output_dir_absolute_path}`);
      await fs.promises.rm(image_output_dir_absolute_path, { recursive: true, force: true });
      await fs.promises.mkdir(image_output_dir_absolute_path, { recursive: true });

      const generated_pngs = await convert_pdf_to_pngs(temp_pdf_path, image_output_dir_absolute_path, params.resolution_dpi);

      if (generated_pngs.length > 0) {
        total_pngs_generated += generated_pngs.length;
        processed_files_info.push(`'${meta.path}' (${generated_pngs.length} pages) -> ${image_output_dir_relative_path}`);
        core.info(`   - Successfully generated ${generated_pngs.length} PNGs.`);
      } else {
        core.warning(`   - No PNGs generated from PDF for ${meta.path}. PDF might be empty or conversion failed.`);
        // Add info even if 0 pages, indicates processing attempt
        processed_files_info.push(`'${meta.path}' (0 pages) -> ${image_output_dir_relative_path}`);
      }
    } catch (conversionError: any) {
      core.error(`   - Failed during PDF->PNG conversion or directory handling for ${meta.path}: ${conversionError.message}`);
      core.debug(conversionError.stack);
    } finally {
      // Clean up temporary PDF
      core.debug(`   - Removing temporary PDF: ${temp_pdf_path}`);
      await fs.promises.rm(temp_pdf_path, { force: true, recursive: false }).catch((rmErr: any) =>
        core.warning(`   - Failed to remove temp PDF ${temp_pdf_path}: ${rmErr.message}`)
      );
    }
  } // End loop through processed metadata
  core.endGroup(); // End 'Processing Files' group

  // --- Cleanup Temporary Directory ---
  if (temp_dir) {
    core.info(`Cleaning up base temporary directory: ${temp_dir}`);
    await fs.promises.rm(temp_dir, { recursive: true, force: true }).catch((rmErr: any) =>
      core.warning(`Failed to remove base temp directory ${temp_dir}: ${rmErr.message}`)
    );
  }

  core.info(`Total PNGs generated or updated in this run: ${total_pngs_generated}`);

  // --- Commit and Push Changes ---
  // Only commit if we actually attempted to process files (even if 0 PNGs resulted)
  // and therefore potentially modified the filesystem (e.g., cleaned directories).
  if (processed_metadata.length > 0) { // Use processed_metadata as trigger, not just png count
    const commit_message = `${SKIP_CI_TAG} Generate visual diff PNGs for PR #${params.pr_number}\n\nProcessed ${processed_files_info.length} file(s):\n- ${processed_files_info.join('\n- ')}`;
    try {
      // Call the commit function, assuming we are on the correct branch already
      await stage_commit_and_push_changes(
        params.output_base_dir, // Directory containing all changes
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
      // Error is already logged within stage_commit_and_push_changes
      core.error("Visual diff generation process completed, but committing/pushing changes failed.");
      throw commitError; // Fail the action
    }
  } else {
    core.info('No link files were processed, or no relevant changes found. No commit needed.');
  }

  core.info('Visual Diff Generation step finished successfully.');
  core.endGroup(); // End the main group
}
