import * as core from '@actions/core';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Buffer } from 'buffer';
import { execute_git } from '../git.js'; // Use existing git helper
import { convert_pdf_to_pngs } from './pdf_converter.js';
import { fetch_drive_file_as_pdf } from './google_drive_fetch.js';
const SKIP_CI_TAG = '[skip visual-diff]'; // Specific tag for this step
/**
 * Checks the latest commit message on the specified branch for a skip tag.
 */
async function should_skip_generation(branch_name) {
    core.startGroup(`Checking latest commit on branch '${branch_name}' for skip tag`);
    try {
        // Ensure we are on the correct branch (or fetch if needed) - checkout might be needed if action runs in detached state
        // For simplicity, assume the calling context ensures the correct branch is checked out or reachable.
        // Fetch latest changes for the branch first
        core.info(`Fetching latest updates for branch ${branch_name}...`);
        await execute_git('fetch', ['origin', branch_name], { silent: true });
        // Get the commit message of the most recent commit on the *remote* branch ref
        const latest_commit_message_result = await execute_git('log', ['-1', '--pretty=%B', `origin/${branch_name}`], // Check the remote ref head
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
        }
        else {
            core.info('Previous commit does not contain the skip tag. Proceeding with generation.');
            core.endGroup();
            return false; // Don't skip
        }
    }
    catch (error) {
        core.warning(`Failed to check previous commit message on branch ${branch_name}: ${error.message}. Proceeding cautiously.`);
        core.endGroup();
        return false; // Default to not skipping if check fails
    }
}
/**
 * Commits and pushes generated PNGs.
 */
async function commit_and_push_pngs(params, commit_message) {
    core.startGroup('Committing and Pushing PNGs');
    try {
        // Ensure we are on the correct branch
        core.info(`Checking out branch '${params.head_branch}'...`);
        await execute_git('fetch', ['origin', params.head_branch], { silent: true });
        await execute_git('checkout', [params.head_branch]);
        // Configure Git user
        await execute_git("config", ["--local", "user.email", params.git_user_email]);
        await execute_git("config", ["--local", "user.name", params.git_user_name]);
        core.info(`Adding generated files in '${params.output_base_dir}' to Git index...`);
        await execute_git('add', [params.output_base_dir]);
        // Check if there are staged changes
        const status_result = await execute_git('status', ['--porcelain', '--', params.output_base_dir], { ignoreReturnCode: true });
        if (!status_result.stdout.trim()) {
            core.info(`No staged changes detected within '${params.output_base_dir}'. Nothing to commit.`);
            core.endGroup();
            return;
        }
        core.debug("Staged changes detected:\n" + status_result.stdout);
        core.info('Committing changes...');
        await execute_git('commit', ['-m', commit_message]);
        core.info(`Pushing changes to branch ${params.head_branch}...`);
        // Use --force-with-lease to avoid overwriting unrelated changes
        await execute_git('push', ['--force-with-lease', 'origin', params.head_branch]);
        core.info('Changes pushed successfully.');
    }
    catch (error) {
        core.error(`Failed to commit and push PNG changes: ${error.message}`);
        throw error;
    }
    finally {
        core.endGroup();
    }
}
/**
 * Main function to generate visual diffs for a Pull Request.
 */
export async function generate_visual_diffs_for_pr(params) {
    core.startGroup(`Generating Visual Diffs for PR #${params.pr_number}`);
    core.info(`Repo: ${params.owner}/${params.repo}`);
    core.info(`Branch: ${params.head_branch} (SHA: ${params.head_sha})`);
    core.info(`Looking for link files ending with: ${params.link_file_suffix}`);
    core.info(`Outputting PNGs to directory: ${params.output_base_dir}`);
    core.info(`PNG Resolution: ${params.resolution_dpi} DPI`);
    // Debug current branch and HEAD
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
        core.info(`Ensuring output directory exists and is potentially cleaned: ${params.output_base_dir}`);
        // Optional: Clean the directory first? Be careful if it contains other things.
        // await fs.promises.rm(params.output_base_dir, { recursive: true, force: true });
        await fs.promises.mkdir(params.output_base_dir, { recursive: true });
    }
    catch (dirError) {
        core.error(`Failed to prepare output directory ${params.output_base_dir}: ${dirError.message}`);
        core.endGroup();
        throw dirError; // Cannot proceed without output dir
    }
    // --- Find Changed Link Files in PR ---
    core.startGroup('Finding Changed Link Files in PR');
    const changed_link_files = [];
    try {
        const files_iterator = params.octokit.paginate.iterator(params.octokit.rest.pulls.listFiles, {
            owner: params.owner, repo: params.repo, pull_number: params.pr_number, per_page: 100,
        });
        for await (const { data: files } of files_iterator) {
            for (const file of files) {
                // Process files that are added or modified and end with the specified suffix
                if (file.filename.endsWith(params.link_file_suffix) &&
                    (file.status === 'added' || file.status === 'modified')) {
                    // base_name is the filename without the suffix, used for the output sub-folder
                    const base_name = path.basename(file.filename, params.link_file_suffix);
                    core.info(` -> Found candidate: ${file.filename} (Status: ${file.status}) -> Output Base: ${base_name}`);
                    changed_link_files.push({ path: file.filename, base_name });
                }
                else {
                    core.debug(` -> Skipping file: ${file.filename} (Status: ${file.status}, Suffix mismatch: ${!file.filename.endsWith(params.link_file_suffix)})`);
                }
            }
        }
        core.info(`Found ${changed_link_files.length} added/modified link file(s) to process.`);
    }
    catch (error) {
        core.error(`Failed to list PR files: ${error.message}`);
        core.endGroup(); // Close group before re-throwing
        throw error; // Re-throw to indicate critical failure
    }
    finally {
        core.endGroup();
    }
    if (changed_link_files.length === 0) {
        core.info('No relevant changed link files found in this PR update. Nothing to generate.');
        // No commit needed if nothing generated.
        return;
    }
    // --- Setup Temporary Directory ---
    let temp_dir = null;
    try {
        temp_dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `visual-diff-${params.pr_number}-`));
        core.info(`Using temporary directory: ${temp_dir}`);
    }
    catch (tempError) {
        core.error(`Failed to create temporary directory: ${tempError.message}`);
        throw tempError; // Cannot proceed without temp dir
    }
    let total_pngs_generated = 0;
    const processed_files_info = []; // Track info for commit message
    // --- Process Each Link File ---
    core.startGroup('Processing Files and Generating PNGs');
    for (const link_file of changed_link_files) {
        core.info(`Processing link file: ${link_file.path}`);
        let file_id = null;
        let mime_type = null;
        let original_name = null; // Store original name for context
        // 1. Get File ID and MIME Type from link file content (using head_sha)
        try {
            core.debug(`Fetching content for: ${link_file.path} at ref ${params.head_sha}`);
            const { data: content_response } = await params.octokit.rest.repos.getContent({
                owner: params.owner, repo: params.repo, path: link_file.path, ref: params.head_sha, // Fetch from the specific commit
            });
            // Type guard to ensure response has content
            if ('content' in content_response && content_response.content && content_response.encoding === 'base64') {
                const file_content_str = Buffer.from(content_response.content, 'base64').toString('utf-8');
                const file_data = JSON.parse(file_content_str);
                if (file_data && typeof file_data.id === 'string' && typeof file_data.mimeType === 'string') {
                    file_id = file_data.id;
                    mime_type = file_data.mimeType;
                    original_name = typeof file_data.name === 'string' ? file_data.name : path.basename(link_file.base_name); // Use base name as fallback
                    core.info(`   - Extracted Drive ID: ${file_id}, MIME Type: ${mime_type}${original_name ? `, Name: ${original_name}` : ''}`);
                }
                else {
                    core.warning(`   - Could not find 'id' and 'mimeType' (both strings) in JSON content of ${link_file.path}. Skipping.`);
                    continue; // Skip this file
                }
            }
            else {
                core.warning(`   - Could not retrieve valid base64 content for ${link_file.path} (SHA: ${params.head_sha}). Skipping.`);
                continue; // Skip this file
            }
        }
        catch (error) {
            // Handle case where file might not exist at head_sha (e.g., force-pushed over)
            if (error.status === 404) {
                core.warning(`   - Link file ${link_file.path} not found at ref ${params.head_sha}. It might have been moved or deleted. Skipping.`);
            }
            else {
                core.warning(`   - Failed to get or parse content of ${link_file.path} at ref ${params.head_sha}: ${error.message}. Skipping.`);
            }
            continue; // Skip this file
        }
        // Should have id and mimeType if we reached here
        if (!file_id || !mime_type || !original_name) {
            core.error(`Logic error: file_id, mime_type, or original_name missing after successful parse for ${link_file.path}`);
            continue;
        }
        // 2. Fetch PDF content from Drive
        // Sanitize the original name for use in the temporary file path
        const sanitized_base_name = original_name.replace(/[^a-zA-Z0-9_.-]/g, '_');
        const temp_pdf_path = path.join(temp_dir, `${sanitized_base_name}.pdf`);
        const fetch_success = await fetch_drive_file_as_pdf(params.drive, file_id, mime_type, temp_pdf_path);
        if (!fetch_success) {
            core.warning(`   - Failed to fetch PDF for ${link_file.path} (Drive ID: ${file_id}). Skipping PNG generation for this file.`);
            continue; // Skip to the next link file
        }
        // 3. Convert PDF to PNGs
        // Output path structure: output_base_dir / <relative_path_of_link_file_dir> / <base_name_from_link_file> / page.png
        const relative_dir = path.dirname(link_file.path); // e.g., "docs/subdir" or "."
        // Use link_file.base_name which is derived directly from the link file's path structure
        const image_output_dir_relative_path = path.join(relative_dir, link_file.base_name);
        const image_output_dir_absolute_path = path.join(params.output_base_dir, image_output_dir_relative_path);
        core.info(`   - Converting PDF to PNGs in directory: ${image_output_dir_absolute_path} (relative: ${image_output_dir_relative_path})`);
        const generated_pngs = await convert_pdf_to_pngs(temp_pdf_path, image_output_dir_absolute_path, params.resolution_dpi);
        if (generated_pngs.length > 0) {
            total_pngs_generated += generated_pngs.length;
            processed_files_info.push(`'${link_file.path}' (${generated_pngs.length} pages)`);
            core.info(`   - Generated ${generated_pngs.length} PNGs for ${link_file.path}`);
        }
        else {
            core.warning(`   - No PNGs generated from PDF for ${link_file.path}. Conversion might have failed.`);
        }
        // 4. Clean up temporary PDF for this file
        core.debug(`   - Removing temporary PDF: ${temp_pdf_path}`);
        await fs.promises.rm(temp_pdf_path, { force: true, recursive: false }).catch(rmErr => core.warning(`   - Failed to remove temp PDF ${temp_pdf_path}: ${rmErr.message}`));
    } // End loop through link files
    core.endGroup(); // End 'Processing Files' group
    // --- Cleanup Temp Directory ---
    if (temp_dir) {
        core.info(`Cleaning up temporary directory: ${temp_dir}`);
        await fs.promises.rm(temp_dir, { recursive: true, force: true }).catch(rmErr => core.warning(`Failed to remove base temp directory ${temp_dir}: ${rmErr.message}`));
    }
    core.info(`Total PNGs generated in this run: ${total_pngs_generated}`);
    // --- Commit and Push PNGs ---
    if (total_pngs_generated > 0) {
        const commit_message = `${SKIP_CI_TAG} Generate visual diff PNGs for PR #${params.pr_number}\n\nGenerates ${total_pngs_generated} PNG(s) for:\n- ${processed_files_info.join('\n- ')}`;
        try {
            await commit_and_push_pngs(params, commit_message);
            // Debug post-commit state
            core.info('Debugging post-commit Git state...');
            const postCommitBranch = await execute_git('rev-parse', ['--abbrev-ref', 'HEAD'], { silent: true });
            core.info(`Post-commit branch: ${postCommitBranch.stdout.trim()}`);
            const postCommitHead = await execute_git('rev-parse', ['HEAD'], { silent: true });
            core.info(`Post-commit HEAD SHA: ${postCommitHead.stdout.trim()}`);
            const postCommitLog = await execute_git('log', ['-1', '--pretty=%H %s'], { silent: true });
            core.info(`Latest commit:\n${postCommitLog.stdout}`);
        }
        catch (commitError) {
            core.error("Visual diff generation succeeded, but committing/pushing PNGs failed.");
            throw commitError;
        }
    }
    else {
        core.info('No PNGs were generated or committed in this run.');
    }
    core.info('Visual Diff Generation step completed.');
    // No endGroup needed here as the main startGroup concludes the function.
}
