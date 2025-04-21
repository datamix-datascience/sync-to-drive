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
  const changed_link_files: { path: string; base_name: string; file_id: string; file_type: string }[] = []; // Added file_id
  const known_extensions_vd = Object.values(MIME_TYPE_TO_EXTENSION).join('|');
  // Updated regex to match the new pattern: --[ID].[type].gdrive.json
  // Capture Group 1: Base name (non-greedy)
  // Capture Group 2: File ID
  // Capture Group 3: Type extension (e.g., doc, sheet, pdf)
  const link_file_regex_vd = new RegExp(`^(.*?)--([a-zA-Z0-9_-]+)\\.(${known_extensions_vd})\\.gdrive\\.json$`, 'i');
  core.debug(`Using regex to find link files: ${link_file_regex_vd}`);


  try {
    const files_iterator = params.octokit.paginate.iterator(params.octokit.rest.pulls.listFiles, {
      owner: params.owner, repo: params.repo, pull_number: params.pr_number, per_page: 100,
    });

    for await (const { data: files } of files_iterator) {
      for (const file of files) {
        // Extract the filename itself from the full path
        const filename_only = path.basename(file.filename);
        const match = filename_only.match(link_file_regex_vd);

        if (
          match &&
          (file.status === 'added' || file.status === 'modified' || file.status === 'renamed')
        ) {
          const base_name = match[1]; // Captured base name part
          const file_id = match[2]; // Captured file ID part
          const file_type = match[3]; // Captured type extension part (doc, sheet, etc.)
          core.info(` -> Found candidate: ${file.filename} (Status: ${file.status}) -> Base Name: ${base_name}, ID: ${file_id}, Type: ${file_type}`);
          // Store the full path from the PR file list
          changed_link_files.push({ path: file.filename, base_name, file_id, file_type });
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
    path: string; // Full path from PR list
    file_id_from_name: string; // ID extracted from filename
    file_id_from_content: string; // ID read from JSON content
    mime_type: string;
    original_name_from_content: string; // Name read from JSON content
    extension: string; // Type extension (doc, pdf)
    base_name_from_name: string; // Base name extracted from filename
    modifiedTime?: string;
  }
  const file_metadata: FileMetadata[] = [];
  core.info('Collecting metadata for changed link files...');
  for (const link_file of changed_link_files) { // link_file now contains path, base_name, file_id, file_type
    core.info(`Collecting metadata for: ${link_file.path}`);
    try {
      // Read file content *from the local filesystem*
      core.debug(`Reading local file content for: ${link_file.path}`);
      let file_content_str: string;
      try {
        file_content_str = await fs.promises.readFile(link_file.path, 'utf-8');
      } catch (readFileError: any) {
        if (readFileError.code === 'ENOENT') {
          core.warning(`   - Link file ${link_file.path} not found locally (deleted in PR?). Skipping.`);
          continue;
        } else { throw readFileError; }
      }

      const file_data = JSON.parse(file_content_str);

      if (!file_data || typeof file_data.id !== 'string' || typeof file_data.mimeType !== 'string') {
        core.warning(`   - Could not find 'id' and 'mimeType' in JSON content of ${link_file.path}. Skipping.`);
        continue;
      }

      // Basic consistency check between filename ID and content ID
      if (file_data.id !== link_file.file_id) {
        core.warning(`   - File ID mismatch for ${link_file.path}: Filename ID='${link_file.file_id}', Content ID='${file_data.id}'. Using content ID.`);
      }

      const file_id_from_content = file_data.id;
      const mime_type = file_data.mimeType;
      // Prefer name from content, fall back to base name from filename if content name missing
      const original_name_from_content = (typeof file_data.name === 'string' && file_data.name.trim()) ? file_data.name.trim() : link_file.base_name;
      const extension = MIME_TYPE_TO_EXTENSION[mime_type] || link_file.file_type; // Use file_type extracted from regex as fallback
      const modifiedTime = typeof file_data.modifiedTime === 'string' ? file_data.modifiedTime : undefined;

      file_metadata.push({
        path: link_file.path,
        file_id_from_name: link_file.file_id,
        file_id_from_content: file_id_from_content,
        mime_type,
        original_name_from_content: original_name_from_content,
        extension,
        base_name_from_name: link_file.base_name, // Keep for potential folder naming
        modifiedTime
      });
      core.info(`   - Collected: ContentID=${file_id_from_content}, MIME=${mime_type}, ContentName=${original_name_from_content}, Ext=${extension}, Modified=${modifiedTime || 'N/A'}`);

    } catch (error: any) {
      core.warning(`   - Failed to read or parse local content of ${link_file.path}: ${error.message}. Skipping.`);
      core.debug(error.stack);
      continue;
    }
  } // End metadata collection loop

  // Phase 2: Assign unique folder names (still useful for organizing PNGs)
  // Use content name and extension as the primary key for grouping, but use ID for folder if names clash.
  interface ProcessedMetadata { meta: FileMetadata; folder_name: string; }
  const name_type_map: { [key: string]: FileMetadata[] } = {};
  file_metadata.forEach((meta) => {
    // Group by the name stored *inside* the link file and its type extension
    const key = `${meta.original_name_from_content}:${meta.extension}`;
    if (!name_type_map[key]) name_type_map[key] = [];
    name_type_map[key].push(meta);
  });

  const processed_metadata: ProcessedMetadata[] = [];
  core.info('Assigning output folder names...');
  for (const key in name_type_map) {
    const files_with_same_name_type = name_type_map[key];
    if (files_with_same_name_type.length > 1) {
      // Name/type clash based on content, need to disambiguate folder name
      core.info(`Detected ${files_with_same_name_type.length} files resolving to content name/type: ${key}. Using file ID for folder name disambiguation.`);
      // Sort by modified time (most recent first might be preferred, but let's stick to consistency)
      files_with_same_name_type.sort((a, b) => {
        // Sort primarily by modified time (desc), then by path as tie-breaker
        const timeCompare = (b.modifiedTime || '').localeCompare(a.modifiedTime || '');
        if (timeCompare !== 0) return timeCompare;
        return a.path.localeCompare(b.path);
      });

      files_with_same_name_type.forEach((meta, index) => {
        // Use content name + extension for the first, add content ID for subsequent ones
        const folder_name = index === 0
          ? `${meta.original_name_from_content}.${meta.extension}`
          : `${meta.original_name_from_content}--${meta.file_id_from_content}.${meta.extension}`; // Use content ID
        processed_metadata.push({ meta, folder_name });
        core.debug(`   - Assigned folder_name=${folder_name} for ${meta.path} (ContentID=${meta.file_id_from_content}, Index=${index})`);
      });
    } else {
      // No name/type clash for this group based on content
      const meta = files_with_same_name_type[0];
      const folder_name = `${meta.original_name_from_content}.${meta.extension}`; // Use content name + extension
      processed_metadata.push({ meta, folder_name });
      core.debug(`   - Assigned folder_name=${folder_name} for ${meta.path} (No content name/type duplicates)`);
    }
  } // End folder name assignment loop

  // --- Phase 3: Process files - Fetch PDF, Convert to PNGs ---
  for (const { meta, folder_name } of processed_metadata) {
    core.info(`Processing file: ${meta.path} -> Output Folder: ${folder_name}`);
    // Use the file ID read from the JSON content for fetching
    const file_id_to_fetch = meta.file_id_from_content;
    const { mime_type } = meta;

    // Sanitize the calculated folder name for filesystem use
    const sanitized_folder_name = folder_name.replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/\s+/g, '_');
    const temp_pdf_path = path.join(temp_dir, `${sanitized_folder_name}.pdf`);

    // IMPORTANT: Place PNGs relative to the *link file's* directory
    const relative_dir_of_link_file = path.dirname(meta.path);
    const image_output_dir_relative_path = path.join(relative_dir_of_link_file, sanitized_folder_name);
    const image_output_dir_absolute_path = path.join(params.output_base_dir, image_output_dir_relative_path);


    // Fetch PDF
    core.info(`   - Fetching Drive file ID ${file_id_to_fetch} (from content) as PDF...`);
    const fetch_success = await fetch_drive_file_as_pdf(params.drive, file_id_to_fetch, mime_type, temp_pdf_path);

    if (!fetch_success) {
      core.warning(`   - Failed to fetch PDF for ${meta.path}. Skipping PNG generation.`);
      continue; // Skip to next file
    }

    // Convert PDF to PNGs
    core.info(`   - Converting PDF to PNGs in target directory: ${image_output_dir_absolute_path}`);
    try {
      // Clean the specific output directory *before* generating new files.
      core.debug(`   - Cleaning existing output directory: ${image_output_dir_absolute_path}`);
      await fs.promises.rm(image_output_dir_absolute_path, { recursive: true, force: true });
      await fs.promises.mkdir(image_output_dir_absolute_path, { recursive: true });

      const generated_pngs = await convert_pdf_to_pngs(temp_pdf_path, image_output_dir_absolute_path, params.resolution_dpi);

      if (generated_pngs.length > 0) {
        total_pngs_generated += generated_pngs.length;
        // Use the original link file path for the commit message info
        processed_files_info.push(`'${meta.path}' (${generated_pngs.length} pages) -> ${image_output_dir_relative_path}`);
        core.info(`   - Successfully generated ${generated_pngs.length} PNGs.`);
      } else {
        core.warning(`   - No PNGs generated from PDF for ${meta.path}. PDF might be empty or conversion failed.`);
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
  if (processed_metadata.length > 0) {
    const commit_message = `${SKIP_CI_TAG} Generate visual diff PNGs for PR #${params.pr_number}\n\nProcessed ${processed_files_info.length} file(s):\n- ${processed_files_info.join('\n- ')}`;
    try {
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
      core.error("Visual diff generation process completed, but committing/pushing changes failed.");
      throw commitError; // Fail the action
    }
  } else {
    core.info('No link files were processed, or no relevant changes found. No commit needed.');
  }


  core.info('Visual Diff Generation step finished successfully.');
  core.endGroup(); // End the main group
}
