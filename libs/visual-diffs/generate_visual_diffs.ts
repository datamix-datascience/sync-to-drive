import * as core from '@actions/core';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Buffer } from 'buffer';
import { execute_git } from '../git.js'; // Use existing git helper
import { convert_pdf_to_pngs } from './pdf_converter.js';
import { fetch_drive_file_as_pdf } from './google_drive_fetch.js';
import { GenerateVisualDiffsParams } from './types.js';
import { MIME_TYPE_TO_EXTENSION } from '../google-drive/file_types.js'; // Import the map

const SKIP_CI_TAG = '[skip visual-diff]'; // Specific tag for this step

/**
 * Checks the latest commit message on the specified branch for a skip tag.
 */
async function should_skip_generation(branch_name: string): Promise<boolean> {
  core.startGroup(`Checking latest commit on branch '${branch_name}' for skip tag`);
  try {
    // Ensure we are on the correct branch (or fetch if needed) - checkout might be needed if action runs in detached state
    // For simplicity, assume the calling context ensures the correct branch is checked out or reachable.
    // Fetch latest changes for the branch first
    core.info(`Fetching latest updates for branch ${branch_name}...`);
    await execute_git('fetch', ['origin', branch_name], { silent: true });

    // Get the commit message of the most recent commit on the *remote* branch ref
    const latest_commit_message_result = await execute_git(
      'log',
      ['-1', '--pretty=%B', `origin/${branch_name}`], // Check the remote ref head
      { silent: true, ignoreReturnCode: true } // Ignore errors if branch hasn't been pushed?
    );

    if (latest_commit_message_result.exitCode !== 0 || !latest_commit_message_result.stdout) {
      core.warning(`Could not get latest commit message from origin/${branch_name}. Exit code: ${latest_commit_message_result.exitCode}. Stderr: ${latest_commit_message_result.stderr}`);
      core.info('Proceeding with generation as skip status is uncertain.');
      core.endGroup();
      return false;
    }

    const latest_commit_message = latest_commit_message_result.stdout.trim();
    core.info('Latest commit message on remote branch:\n' + latest_commit_message);

    if (latest_commit_message.includes(SKIP_CI_TAG)) {
      core.info(`Latest commit message contains '${SKIP_CI_TAG}'. Skipping PNG generation to prevent loop.`);
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
 * Commits and pushes generated PNGs.
 */
async function commit_and_push_pngs(
  params: GenerateVisualDiffsParams,
  commit_message: string
): Promise<void> {
  core.startGroup('Committing and Pushing PNGs');
  try {
    // Ensure we are on the correct branch
    core.info(`Checking out branch '${params.head_branch}'...`);
    await execute_git('fetch', ['origin', params.head_branch], { silent: true });
    await execute_git('checkout', ["--force", params.head_branch]); // Force checkout

    // Configure Git user
    await execute_git("config", ["--local", "user.email", params.git_user_email]);
    await execute_git("config", ["--local", "user.name", params.git_user_name]);

    core.info(`Adding generated files in '${params.output_base_dir}' to Git index...`);
    // Add the specific output directory to avoid unrelated changes
    await execute_git('add', [params.output_base_dir]);

    // Check if there are staged changes *within the output directory*
    const status_result = await execute_git(
      'status',
      ['--porcelain', '--', params.output_base_dir], // Limit status check to the output dir
      { ignoreReturnCode: true }
    );

    if (!status_result.stdout.trim()) {
      core.info(`No staged changes detected within '${params.output_base_dir}'. Nothing to commit.`);
      core.endGroup();
      return;
    }
    core.debug("Staged changes detected:\n" + status_result.stdout);

    core.info('Committing changes...');
    // Commit only the added files within the output directory implicitly via `git add` above
    // or explicitly commit the path: await execute_git('commit', ['-m', commit_message, '--', params.output_base_dir]);
    await execute_git('commit', ['-m', commit_message]); // Commits all staged changes

    core.info(`Pushing changes to branch ${params.head_branch}...`);
    // Use --force-with-lease to avoid overwriting unrelated changes if possible, but may need --force if history diverged significantly
    await execute_git('push', ['--force', 'origin', params.head_branch]); // Using --force for simplicity as this branch is action-managed

    core.info('Changes pushed successfully.');
  } catch (error: any) {
    core.error(`Failed to commit and push PNG changes: ${error.message}`);
    throw error;
  } finally {
    core.endGroup();
  }
}


/**
 * Main function to generate visual diffs for a Pull Request.
 */
export async function generate_visual_diffs_for_pr(params: GenerateVisualDiffsParams): Promise<void> {
  core.startGroup(`Generating Visual Diffs for PR #${params.pr_number}`);
  core.info(`Repo: ${params.owner}/${params.repo}`);
  core.info(`Branch: ${params.head_branch} (SHA: ${params.head_sha})`);
  // Link file suffix input might be less relevant now, but we log it. The code uses regex based on types.
  core.info(`Looking for link files matching type patterns (e.g., *.doc.gdrive.json, *.pdf.gdrive.json)`);
  core.info(`Outputting PNGs to directory: ${params.output_base_dir}`);
  core.info(`PNG Resolution: ${params.resolution_dpi} DPI`);

  // Debug current branch and HEAD
  // ... (debug git state logic remains the same) ...
  core.info('Debugging current Git state...');
  const currentBranch = await execute_git('rev-parse', ['--abbrev-ref', 'HEAD'], { silent: true });
  core.info(`Current branch: ${currentBranch.stdout.trim()}`);
  const currentHead = await execute_git('rev-parse', ['HEAD'], { silent: true });
  core.info(`Current HEAD SHA: ${currentHead.stdout.trim()}`);
  const branchStatus = await execute_git('status', ['--short'], { silent: true });
  core.info(`Git status:\n${branchStatus.stdout}`);


  // --- Skip Check ---
  if (await should_skip_generation(params.head_branch)) {
    core.info("Skipping visual diff generation based on commit message.");
    core.endGroup();
    return;
  }

  // --- Ensure output directory is clean or exists ---
  try {
    core.info(`Ensuring output directory exists: ${params.output_base_dir}`);
    // Consider cleaning only specific subdirs related to changed files later if needed
    await fs.promises.mkdir(params.output_base_dir, { recursive: true });
  } catch (dirError) {
    core.error(`Failed to prepare output directory ${params.output_base_dir}: ${(dirError as Error).message}`);
    core.endGroup();
    throw dirError; // Cannot proceed without output dir
  }

  // --- Find Changed Link Files in PR ---
  core.startGroup('Finding Changed Link Files in PR');
  const changed_link_files: { path: string; base_name: string; file_type: string }[] = [];
  // Pre-compile regex based on known extensions
  const known_extensions_vd = Object.values(MIME_TYPE_TO_EXTENSION).join('|');
  const link_file_regex_vd = new RegExp(`\\.(${known_extensions_vd})\\.gdrive\\.json$`);
  core.debug(`Using regex to find link files: ${link_file_regex_vd}`);

  try {
    const files_iterator = params.octokit.paginate.iterator(params.octokit.rest.pulls.listFiles, {
      owner: params.owner, repo: params.repo, pull_number: params.pr_number, per_page: 100,
    });

    for await (const { data: files } of files_iterator) {
      for (const file of files) {
        // Check if file is added, modified, OR renamed AND matches the link file pattern
        const match = file.filename.match(link_file_regex_vd);
        if (
          match &&
          (file.status === 'added' || file.status === 'modified' || file.status === 'renamed')
        ) {
          const matched_suffix = match[0]; // e.g., ".doc.gdrive.json" or ".pdf.pdf.gdrive.json"
          const file_type = match[1]; // Keep as is: "doc" or "pdf.pdf"
          // base_name is the filename without .gdrive.json, preserving full extension (e.g., "test-genai.pdf.pdf")
          const base_name = path.basename(file.filename, '.gdrive.json');
          core.info(` -> Found candidate: ${file.filename} (Status: ${file.status}) -> Output Base: ${base_name} (Type: ${file_type})`);
          changed_link_files.push({ path: file.filename, base_name, file_type });
        } else {
          core.debug(` -> Skipping file: ${file.filename} (Status: ${file.status}, Pattern mismatch: ${!match})`);
        }
      }
    }
    core.info(`Found ${changed_link_files.length} added/modified/renamed link file(s) matching pattern to process.`);
  } catch (error: any) {
    core.error(`Failed to list PR files: ${error.message}`);
    core.endGroup(); // Close group before re-throwing
    throw error; // Re-throw to indicate critical failure
  } finally {
    core.endGroup();
  }

  if (changed_link_files.length === 0) {
    core.info('No relevant changed link files found in this PR update. Nothing to generate.');
    // No commit needed if nothing generated.
    return;
  }

  // --- Setup Temporary Directory ---
  let temp_dir: string | null = null;
  try {
    temp_dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `visual-diff-${params.pr_number}-`));
    core.info(`Using temporary directory: ${temp_dir}`);
  } catch (tempError) {
    core.error(`Failed to create temporary directory: ${(tempError as Error).message}`);
    throw tempError; // Cannot proceed without temp dir
  }

  let total_pngs_generated = 0;
  const processed_files_info = []; // Track info for commit message

  // --- Process Each Link File ---
  core.startGroup('Processing Files and Generating PNGs');
  for (const link_file of changed_link_files) {
    core.info(`Processing link file: ${link_file.path}`);
    let file_id: string | null = null;
    let mime_type: string | null = null;
    let original_name: string | null = null; // Store original name for folder naming

    // 1. Get File ID and MIME Type from link file content (using head_sha)
    try {
      core.debug(`Fetching content for: ${link_file.path} at ref ${params.head_sha}`);
      const { data: content_response } = await params.octokit.rest.repos.getContent({
        owner: params.owner, repo: params.repo, path: link_file.path, ref: params.head_sha,
      });

      if ('content' in content_response && content_response.content && content_response.encoding === 'base64') {
        const file_content_str = Buffer.from(content_response.content, 'base64').toString('utf-8');
        const file_data = JSON.parse(file_content_str);
        if (file_data && typeof file_data.id === 'string' && typeof file_data.mimeType === 'string') {
          file_id = file_data.id;
          mime_type = file_data.mimeType;
          // Use name from JSON if available, otherwise fallback to base_name
          original_name = typeof file_data.name === 'string' && file_data.name.trim() ? file_data.name.trim() : link_file.base_name;
          core.info(`   - Extracted Drive ID: ${file_id}, MIME Type: ${mime_type}, Name: ${original_name}`);
        } else {
          core.warning(`   - Could not find 'id' and 'mimeType' (both strings) in JSON content of ${link_file.path}. Skipping.`);
          continue;
        }
      } else {
        core.warning(`   - Could not retrieve valid base64 content for ${link_file.path} (SHA: ${params.head_sha}). Skipping.`);
        continue;
      }
    } catch (error: any) {
      if (error.status === 404) {
        core.warning(`   - Link file ${link_file.path} not found at ref ${params.head_sha}. It might have been moved or deleted. Skipping.`);
      } else {
        core.warning(`   - Failed to get or parse content of ${link_file.path} at ref ${params.head_sha}: ${error.message}. Skipping.`);
      }
      continue;
    }

    if (!file_id || !mime_type || !original_name) {
      core.error(`Logic error: file_id, mime_type, or original_name missing after successful parse for ${link_file.path}`);
      continue;
    }

    // 2. Fetch PDF content from Drive
    // Sanitize original_name for filesystem safety, preserving extensions
    const sanitized_base_name = original_name.replace(/[^a-zA-Z0-9_. -]/g, '_').replace(/\s+/g, '_');
    const temp_pdf_path = path.join(temp_dir, `${sanitized_base_name}.pdf`);

    const fetch_success = await fetch_drive_file_as_pdf(params.drive, file_id, mime_type, temp_pdf_path);

    if (!fetch_success) {
      core.warning(`   - Failed to fetch PDF for ${link_file.path} (Drive ID: ${file_id}). Skipping PNG generation for this file.`);
      continue;
    }

    // 3. Convert PDF to PNGs
    const relative_dir = path.dirname(link_file.path); // e.g., "docs/subdir" or "."
    // Use sanitized original_name as the folder name to preserve full extension (e.g., "test-genai.pdf.pdf")
    const image_output_dir_relative_path = path.join(relative_dir, sanitized_base_name);
    const image_output_dir_absolute_path = path.join(params.output_base_dir, image_output_dir_relative_path);

    core.info(`   - Converting PDF to PNGs in directory: ${image_output_dir_absolute_path} (relative: ${image_output_dir_relative_path})`);
    // Optional: Clean the specific output directory before generating new PNGs to avoid stale files
    await fs.promises.rm(image_output_dir_absolute_path, { recursive: true, force: true });
    await fs.promises.mkdir(image_output_dir_absolute_path, { recursive: true });

    const generated_pngs = await convert_pdf_to_pngs(temp_pdf_path, image_output_dir_absolute_path, params.resolution_dpi);

    if (generated_pngs.length > 0) {
      total_pngs_generated += generated_pngs.length;
      processed_files_info.push(`'${link_file.path}' (${generated_pngs.length} pages)`);
      core.info(`   - Generated ${generated_pngs.length} PNGs for ${link_file.path}`);
    } else {
      core.warning(`   - No PNGs generated from PDF for ${link_file.path}. Conversion might have failed.`);
    }

    // 4. Clean up temporary PDF for this file
    core.debug(`   - Removing temporary PDF: ${temp_pdf_path}`);
    await fs.promises.rm(temp_pdf_path, { force: true, recursive: false }).catch(rmErr =>
      core.warning(`   - Failed to remove temp PDF ${temp_pdf_path}: ${rmErr.message}`)
    );
  } // End loop through link files
  core.endGroup(); // End 'Processing Files' group

  // --- Cleanup Temp Directory ---
  if (temp_dir) {
    core.info(`Cleaning up temporary directory: ${temp_dir}`);
    await fs.promises.rm(temp_dir, { recursive: true, force: true }).catch(rmErr =>
      core.warning(`Failed to remove base temp directory ${temp_dir}: ${rmErr.message}`)
    );
  }

  core.info(`Total PNGs generated in this run: ${total_pngs_generated}`);

  // --- Commit and Push PNGs ---
  if (total_pngs_generated > 0) {
    const commit_message = `${SKIP_CI_TAG} Generate visual diff PNGs for PR #${params.pr_number}\n\nGenerates ${total_pngs_generated} PNG(s) for:\n- ${processed_files_info.join('\n- ')}`;
    try {
      await commit_and_push_pngs(params, commit_message);
      // Debug post-commit state
      // ... (post-commit debug logic remains the same) ...
      core.info('Debugging post-commit Git state...');
      const postCommitBranch = await execute_git('rev-parse', ['--abbrev-ref', 'HEAD'], { silent: true });
      core.info(`Post-commit branch: ${postCommitBranch.stdout.trim()}`);
      const postCommitHead = await execute_git('rev-parse', ['HEAD'], { silent: true });
      core.info(`Post-commit HEAD SHA: ${postCommitHead.stdout.trim()}`);
      const postCommitLog = await execute_git('log', ['-1', '--pretty=%H %s'], { silent: true });
      core.info(`Latest commit:\n${postCommitLog.stdout}`);
    } catch (commitError) {
      core.error("Visual diff generation succeeded, but committing/pushing PNGs failed.");
      // Decide if this should fail the whole action
      throw commitError;
    }
  } else {
    core.info('No PNGs were generated or committed in this run.');
  }

  core.info('Visual Diff Generation step completed.');
  // No endGroup needed here as the main startGroup concludes the function.
}
