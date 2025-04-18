import * as core from "@actions/core";
import { Octokit } from "@octokit/rest"; // Import Octokit type
import { Buffer } from "buffer";
import * as fs from "fs";
import { drive_v3 } from "googleapis"; // Import drive_v3 type
import * as os from "os";
import * as path from "path";
import { execute_git } from "../git.js"; // Use existing git helper
import {
  analyze_image_diff_with_gemini,
  format_pr_comment,
} from "./gemini_analyzer.js";
import { fetch_drive_file_as_pdf } from "./google_drive_fetch.js";
import { convert_pdf_to_pngs } from "./pdf_converter.js";
import { GenerateVisualDiffsParams, LinkFileInfo } from "./types.js"; // Import LinkFileInfo

const SKIP_CI_TAG = "[skip visual-diff]"; // Specific tag for this step

/**
 * Checks the latest commit message on the specified branch for a skip tag.
 */
async function should_skip_generation(branch_name: string): Promise<boolean> {
  core.startGroup(
    `Checking latest commit on branch '${branch_name}' for skip tag`
  );
  try {
    // Ensure we are on the correct branch (or fetch if needed) - checkout might be needed if action runs in detached state
    // For simplicity, assume the calling context ensures the correct branch is checked out or reachable.
    // Fetch latest changes for the branch first
    core.info(`Fetching latest updates for branch ${branch_name}...`);
    await execute_git("fetch", ["origin", branch_name], { silent: true });

    // Get the commit message of the most recent commit on the *remote* branch ref
    const latest_commit_message_result = await execute_git(
      "log",
      ["-1", "--pretty=%B", `origin/${branch_name}`], // Check the remote ref head
      { silent: true, ignoreReturnCode: true } // Ignore errors if branch hasn't been pushed?
    );

    if (
      latest_commit_message_result.exitCode !== 0 ||
      !latest_commit_message_result.stdout
    ) {
      core.warning(
        `Could not get latest commit message from origin/${branch_name}. Exit code: ${latest_commit_message_result.exitCode}. Stderr: ${latest_commit_message_result.stderr}`
      );
      core.info("Proceeding with generation as skip status is uncertain.");
      core.endGroup();
      return false;
    }

    const latest_commit_message = latest_commit_message_result.stdout.trim();
    core.info(
      "Latest commit message on remote branch:\n" + latest_commit_message
    );

    if (latest_commit_message.includes(SKIP_CI_TAG)) {
      core.info(
        `Latest commit message contains '${SKIP_CI_TAG}'. Skipping PNG generation to prevent loop.`
      );
      core.endGroup();
      return true; // Skip
    } else {
      core.info(
        "Previous commit does not contain the skip tag. Proceeding with generation."
      );
      core.endGroup();
      return false; // Don't skip
    }
  } catch (error: any) {
    core.warning(
      `Failed to check previous commit message on branch ${branch_name}: ${error.message}. Proceeding cautiously.`
    );
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
  core.startGroup("Committing and Pushing PNGs");
  try {
    // Ensure we are on the correct branch
    core.info(`Checking out branch '${params.head_branch}'...`);
    await execute_git("fetch", ["origin", params.head_branch], {
      silent: true,
    });
    await execute_git("checkout", [params.head_branch]);

    // Configure Git user
    await execute_git("config", [
      "--local",
      "user.email",
      params.git_user_email,
    ]);
    await execute_git("config", ["--local", "user.name", params.git_user_name]);

    core.info(
      `Adding generated files in '${params.output_base_dir}' to Git index...`
    );
    await execute_git("add", [params.output_base_dir]);

    // Check if there are staged changes
    const status_result = await execute_git(
      "status",
      ["--porcelain", "--", params.output_base_dir],
      { ignoreReturnCode: true }
    );

    if (!status_result.stdout.trim()) {
      core.info(
        `No staged changes detected within '${params.output_base_dir}'. Nothing to commit.`
      );
      core.endGroup();
      return;
    }
    core.debug("Staged changes detected:\n" + status_result.stdout);

    core.info("Committing changes...");
    await execute_git("commit", ["-m", commit_message]);

    core.info(`Pushing changes to branch ${params.head_branch}...`);
    // Use --force-with-lease to avoid overwriting unrelated changes
    await execute_git("push", [
      "--force-with-lease",
      "origin",
      params.head_branch,
    ]);

    core.info("Changes pushed successfully.");
  } catch (error: any) {
    core.error(`Failed to commit and push PNG changes: ${error.message}`);
    throw error;
  } finally {
    core.endGroup();
  }
}

/**
 * Generates PNG images for a list of link files at a specific Git reference (commit SHA or branch name).
 * Fetches link file content, downloads from Drive, converts PDF to PNG.
 *
 * @param ref The Git reference (SHA or branch name) to fetch link file content from.
 * @param link_files An array of objects, each containing the path and base_name of a link file.
 * @param image_output_root_dir The root directory where generated PNG subdirectories should be placed.
 * @param temp_dir A temporary directory for intermediate files (like PDFs).
 * @param octokit Initialized Octokit instance.
 * @param drive Initialized Google Drive API client.
 * @param owner GitHub repository owner.
 * @param repo GitHub repository name.
 * @param resolution_dpi DPI for PNG conversion.
 * @returns A Promise resolving to an array of objects, each containing info about the processed file and generated PNG paths.
 */
async function generate_images_for_ref(
  ref: string,
  link_files: LinkFileInfo[],
  image_output_root_dir: string,
  temp_dir: string,
  octokit: Octokit,
  drive: drive_v3.Drive,
  owner: string,
  repo: string,
  resolution_dpi: number
): Promise<
  {
    link_file_path: string;
    base_name: string;
    png_paths: string[];
    original_drive_name: string | null;
  }[]
> {
  core.startGroup(
    `Generating images for ref '${ref}' into '${image_output_root_dir}'`
  );
  const results = [];
  // Create a dedicated temp subdir for PDFs for this ref to avoid potential clashes if run concurrently (though unlikely here)
  const pdf_temp_dir = path.join(temp_dir, `pdfs_${ref.substring(0, 10)}`); // Use part of ref for subdir name
  await fs.promises.mkdir(pdf_temp_dir, { recursive: true });

  for (const link_file of link_files) {
    core.info(`Processing link file for ref '${ref}': ${link_file.path}`);
    let file_id: string | null = null;
    let mime_type: string | null = null;
    let original_name: string | null = null;
    let generated_pngs: string[] = []; // Initialize here

    // 1. Get File ID and MIME Type from link file content at the specified ref
    try {
      core.debug(`Fetching content for: ${link_file.path} at ref ${ref}`);
      // Note: getContent might throw 404 if the file doesn't exist at this ref, which is expected for base ref if the file was added in the PR.
      const { data: content_response } = await octokit.rest.repos.getContent({
        owner: owner,
        repo: repo,
        path: link_file.path,
        ref: ref,
      });

      // Type guard to ensure response has content
      if (
        "content" in content_response &&
        content_response.content &&
        content_response.encoding === "base64"
      ) {
        const file_content_str = Buffer.from(
          content_response.content,
          "base64"
        ).toString("utf-8");
        const file_data = JSON.parse(file_content_str);
        if (
          file_data &&
          typeof file_data.id === "string" &&
          typeof file_data.mimeType === "string"
        ) {
          file_id = file_data.id;
          mime_type = file_data.mimeType;
          original_name =
            typeof file_data.name === "string"
              ? file_data.name
              : path.basename(link_file.base_name); // Use base name as fallback
          core.info(
            `   - Extracted Drive ID: ${file_id}, MIME Type: ${mime_type}${
              original_name ? `, Name: ${original_name}` : ""
            }`
          );
        } else {
          core.warning(
            `   - Could not find 'id' and 'mimeType' (both strings) in JSON content of ${link_file.path} at ref '${ref}'. Skipping image generation.`
          );
          results.push({
            link_file_path: link_file.path,
            base_name: link_file.base_name,
            png_paths: [],
            original_drive_name: null,
          });
          continue;
        }
      } else {
        core.warning(
          `   - Could not retrieve valid base64 content for ${link_file.path} at ref '${ref}'. Skipping.`
        );
        results.push({
          link_file_path: link_file.path,
          base_name: link_file.base_name,
          png_paths: [],
          original_drive_name: null,
        });
        continue;
      }
    } catch (error: any) {
      // Handle case where file might not exist at the ref (expected for base ref if file is new)
      if (error.status === 404) {
        core.info(
          `   - Link file ${link_file.path} not found at ref '${ref}'. Assuming it was added in the PR. Skipping base image generation.`
        );
      } else {
        core.warning(
          `   - Failed to get or parse content of ${link_file.path} at ref '${ref}': ${error.message}. Skipping.`
        );
      }
      results.push({
        link_file_path: link_file.path,
        base_name: link_file.base_name,
        png_paths: [],
        original_drive_name: null,
      });
      continue; // Skip this file for this ref
    }

    // Should have id and mimeType if we reached here
    if (!file_id || !mime_type || !original_name) {
      core.error(
        `Logic error: file_id, mime_type, or original_name missing after successful parse for ${link_file.path} at ref '${ref}'`
      );
      results.push({
        link_file_path: link_file.path,
        base_name: link_file.base_name,
        png_paths: [],
        original_drive_name: null,
      });
      continue;
    }

    // 2. Fetch PDF content from Drive
    const sanitized_base_name = original_name.replace(/[^a-zA-Z0-9_.-]/g, "_");
    // Use the dedicated temp dir for PDFs for this ref
    const temp_pdf_path = path.join(
      pdf_temp_dir,
      `${sanitized_base_name}_${link_file.base_name}.pdf`
    ); // Add link file base name for uniqueness

    const fetch_success = await fetch_drive_file_as_pdf(
      drive,
      file_id,
      mime_type,
      temp_pdf_path
    );

    if (!fetch_success) {
      core.warning(
        `   - Failed to fetch PDF for ${link_file.path} (Drive ID: ${file_id}, ref: ${ref}). Skipping PNG generation.`
      );
      results.push({
        link_file_path: link_file.path,
        base_name: link_file.base_name,
        png_paths: [],
        original_drive_name: original_name,
      });
      continue;
    }

    // 3. Convert PDF to PNGs
    // Output path structure: image_output_root_dir / <relative_path_of_link_file_dir> / <base_name_from_link_file> / page.png
    const relative_dir = path.dirname(link_file.path);
    const image_output_dir_relative_path = path.join(
      relative_dir,
      link_file.base_name
    );
    const image_output_dir_absolute_path = path.join(
      image_output_root_dir,
      image_output_dir_relative_path
    );

    core.info(
      `   - Converting PDF to PNGs in directory: ${image_output_dir_absolute_path}`
    );
    // Ensure the output directory exists before conversion
    await fs.promises.mkdir(image_output_dir_absolute_path, {
      recursive: true,
    });
    generated_pngs = await convert_pdf_to_pngs(
      temp_pdf_path,
      image_output_dir_absolute_path,
      resolution_dpi
    );

    if (generated_pngs.length > 0) {
      core.info(
        `   - Generated ${generated_pngs.length} PNGs for ${link_file.path} at ref '${ref}'.`
      );
    } else {
      core.warning(
        `   - No PNGs generated from PDF for ${link_file.path} at ref '${ref}'.`
      );
    }

    // 4. Clean up temporary PDF for this file
    core.debug(`   - Removing temporary PDF: ${temp_pdf_path}`);
    await fs.promises
      .rm(temp_pdf_path, { force: true, recursive: false })
      .catch((rmErr) =>
        core.warning(
          `   - Failed to remove temp PDF ${temp_pdf_path}: ${rmErr.message}`
        )
      );

    results.push({
      link_file_path: link_file.path,
      base_name: link_file.base_name,
      png_paths: generated_pngs, // Store the absolute paths
      original_drive_name: original_name,
    });
  } // End loop through link files

  // Clean up the dedicated PDF temp dir for this ref
  core.debug(`Cleaning up PDF temp directory: ${pdf_temp_dir}`);
  await fs.promises
    .rm(pdf_temp_dir, { recursive: true, force: true })
    .catch((rmErr) =>
      core.warning(
        `Failed to remove PDF temp directory ${pdf_temp_dir}: ${rmErr.message}`
      )
    );

  core.endGroup();
  return results;
}

/**
 * Main function to generate visual diffs for a Pull Request.
 */
export async function generate_visual_diffs_for_pr(
  params: GenerateVisualDiffsParams
): Promise<void> {
  core.startGroup(`Generating Visual Diffs for PR #${params.pr_number}`);
  core.info(`Repo: ${params.owner}/${params.repo}`);
  core.info(`Head Branch: ${params.head_branch} (SHA: ${params.head_sha})`);
  core.info(`PNG Output Dir: ${params.output_base_dir}`);
  core.info(`PNG Resolution: ${params.resolution_dpi} DPI`);
  core.info(`Link File Suffix: ${params.link_file_suffix}`);
  // Log Gemini related inputs if enabled
  if (params.gemini_api_key) {
    core.info(
      `Gemini Analysis Enabled: Yes (Model: ${params.gemini_model_name})`
    );
  } else {
    core.info(`Gemini Analysis Enabled: No`);
  }

  // --- Skip Check ---
  if (await should_skip_generation(params.head_branch)) {
    core.info("Skipping visual diff generation based on commit message.");
    core.endGroup();
    return;
  }

  // --- Get Base SHA and Repo URL ---
  let base_sha: string | null = null;
  let repo_html_url: string | undefined;
  try {
    core.info(
      `Fetching base commit SHA and repo URL for PR #${params.pr_number}...`
    );
    const { data: pr_data } = await params.octokit.rest.pulls.get({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pr_number,
    });
    base_sha = pr_data.base.sha;
    // Extract base repo URL from the PR data's html_url
    if (pr_data.html_url) {
      repo_html_url = pr_data.html_url.split("/pull/")[0];
    }
    core.info(`   - Base Branch: ${pr_data.base.ref}`);
    core.info(`   - Base SHA: ${base_sha}`);
    core.info(`   - Repo URL: ${repo_html_url ?? "Not found"}`);
    if (!base_sha) throw new Error("Base SHA could not be determined.");
  } catch (error: any) {
    core.error(
      `Failed to get base SHA/repo URL for PR #${params.pr_number}: ${error.message}`
    );
    core.endGroup();
    throw error; // Cannot proceed without base SHA
  }

  // --- Find Changed Link Files in PR ---
  core.startGroup("Finding Changed Link Files in PR");
  const changed_link_files: LinkFileInfo[] = []; // Use LinkFileInfo type
  const changed_file_statuses: { [path: string]: string } = {}; // Store status
  try {
    // Uses compareCommits to find files changed between base and head
    const compare_response = await params.octokit.rest.repos.compareCommits({
      owner: params.owner,
      repo: params.repo,
      base: base_sha, // Compare against the base SHA
      head: params.head_sha, // Compare with the head SHA
    });

    // Iterate through files in the comparison
    if (compare_response.data.files) {
      for (const file of compare_response.data.files) {
        if (
          file.filename.endsWith(params.link_file_suffix) &&
          (file.status === "added" ||
            file.status === "modified" ||
            file.status === "renamed" ||
            file.status === "removed") // Include removed
        ) {
          const base_name = path.basename(
            file.filename,
            params.link_file_suffix
          );
          core.info(
            ` -> Found candidate: ${file.filename} (Status: ${file.status}) -> Output Base: ${base_name}`
          );
          changed_link_files.push({ path: file.filename, base_name });
          changed_file_statuses[file.filename] = file.status; // Store status
        } else {
          core.debug(
            ` -> Skipping file: ${file.filename} (Status: ${
              file.status
            }, Suffix mismatch: ${!file.filename.endsWith(
              params.link_file_suffix
            )})`
          );
        }
      }
    }
    core.info(
      `Found ${changed_link_files.length} added/modified/renamed/removed link file(s) to process.`
    ); // Update log
  } catch (error: any) {
    core.error(`Failed to compare commits or list PR files: ${error.message}`);
    core.endGroup();
    throw error;
  } finally {
    core.endGroup();
  }

  if (changed_link_files.length === 0) {
    core.info(
      "No relevant changed link files found between base and head. Nothing to generate or analyze."
    );
    core.endGroup();
    return;
  }

  // --- Setup Temporary Directory for All Processing ---
  let processing_temp_dir: string | null = null;
  try {
    processing_temp_dir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), `visual-diff-processing-${params.pr_number}-`)
    );
    core.info(`Using temporary processing directory: ${processing_temp_dir}`);
    // Define subdirs for base and head images
    const base_image_temp_dir = path.join(processing_temp_dir, "base_images");
    const head_image_temp_dir = path.join(processing_temp_dir, "head_images");
    await fs.promises.mkdir(base_image_temp_dir, { recursive: true });
    await fs.promises.mkdir(head_image_temp_dir, { recursive: true });

    // Filter files for image generation (exclude removed files)
    const files_for_head_generation = changed_link_files.filter(
      (f) => changed_file_statuses[f.path] !== "removed"
    );
    const files_for_base_generation = changed_link_files.filter(
      (f) => changed_file_statuses[f.path] !== "added"
    );

    // --- Generate Base Branch Images (Into Temp Dir) ---
    core.info(`Generating base images (ref: ${base_sha})...`);
    const base_image_results = await generate_images_for_ref(
      base_sha,
      files_for_base_generation, // Only generate for existing/modified/renamed/removed
      base_image_temp_dir,
      processing_temp_dir,
      params.octokit,
      params.drive,
      params.owner,
      params.repo,
      params.resolution_dpi
    );

    // --- Generate Head Branch Images (Into Temp Dir) ---
    core.info(`Generating head images (ref: ${params.head_sha})...`);
    const head_image_results = await generate_images_for_ref(
      params.head_sha,
      files_for_head_generation, // Only generate for existing/modified/renamed/added
      head_image_temp_dir,
      processing_temp_dir,
      params.octokit,
      params.drive,
      params.owner,
      params.repo,
      params.resolution_dpi
    );

    // --- Ensure Final Output Directory Exists ---
    core.info(
      `Ensuring final output directory exists: ${params.output_base_dir}`
    );
    await fs.promises.mkdir(params.output_base_dir, { recursive: true });

    // --- Copy Head Images to Final Output Directory & Clean Removed Dirs ---
    core.startGroup("Updating final output directory");
    let total_pngs_generated_for_commit = 0;
    const processed_files_info_for_commit = [];

    // Process files present in head
    for (const result of head_image_results) {
      if (result.png_paths.length > 0) {
        const relative_dir = path.dirname(result.link_file_path);
        const image_output_dir_relative_path = path.join(
          relative_dir,
          result.base_name
        );
        const final_output_dir = path.join(
          params.output_base_dir,
          image_output_dir_relative_path
        );

        core.info(
          `Copying/Updating ${result.png_paths.length} PNGs for ${result.link_file_path} to ${final_output_dir}`
        );
        await fs.promises.mkdir(final_output_dir, { recursive: true });

        for (const png_path of result.png_paths) {
          const filename = path.basename(png_path);
          const final_path = path.join(final_output_dir, filename);
          await fs.promises.copyFile(png_path, final_path);
          core.debug(`   - Copied ${png_path} to ${final_path}`);
        }
        total_pngs_generated_for_commit += result.png_paths.length;
        processed_files_info_for_commit.push(
          `'${result.link_file_path}' (${result.png_paths.length} pages)`
        );
      } else {
        core.info(
          `No head images generated for ${result.link_file_path}, nothing to copy.`
        );
      }
    }

    // Process removed files - delete their corresponding directories in the output
    const removed_files = changed_link_files.filter(
      (f) => changed_file_statuses[f.path] === "removed"
    );
    for (const removed_file of removed_files) {
      const relative_dir = path.dirname(removed_file.path);
      const image_output_dir_relative_path = path.join(
        relative_dir,
        removed_file.base_name
      );
      const final_output_dir_to_remove = path.join(
        params.output_base_dir,
        image_output_dir_relative_path
      );
      core.info(
        `Removing directory for deleted link file ${removed_file.path}: ${final_output_dir_to_remove}`
      );
      await fs.promises
        .rm(final_output_dir_to_remove, { recursive: true, force: true })
        .catch((rmErr) =>
          core.warning(
            `Failed to remove directory ${final_output_dir_to_remove}: ${rmErr.message}`
          )
        );
      // Add info about removal for commit message clarity
      processed_files_info_for_commit.push(`'${removed_file.path}' (Removed)`);
    }
    core.endGroup();

    // --- Commit and Push Changes (including removals) ---
    // Check if any head images were generated OR if any files were removed (need to commit directory deletions)
    if (total_pngs_generated_for_commit > 0 || removed_files.length > 0) {
      const commit_message = `${SKIP_CI_TAG} Update visual diff PNGs for PR #${
        params.pr_number
      }\\n\\nUpdates/Generates ${total_pngs_generated_for_commit} PNG(s) and handles removals for:\\n- ${processed_files_info_for_commit.join(
        "\\n- "
      )}`;
      try {
        await commit_and_push_pngs(params, commit_message);
      } catch (commitError) {
        core.error(
          "Visual diff PNG update succeeded, but committing/pushing changes failed."
        );
        throw commitError;
      }
    } else {
      core.info("No PNGs were generated or removed in this run.");
    }

    // --- === Gemini Analysis === ---
    if (params.gemini_api_key && changed_link_files.length > 0) {
      core.startGroup("Performing Gemini Visual Diff Analysis");
      core.info("Pairing base and head images for analysis...");

      const analysis_results: {
        filePath: string;
        page: number;
        analysis: string | null;
      }[] = [];

      const base_results_map = new Map(
        base_image_results.map((r) => [r.link_file_path, r])
      );
      const head_results_map = new Map(
        head_image_results.map((r) => [r.link_file_path, r])
      );

      for (const link_file of changed_link_files) {
        const base_result = base_results_map.get(link_file.path);
        const head_result = head_results_map.get(link_file.path);
        const file_status = changed_file_statuses[link_file.path];

        core.info(
          `Processing file: ${link_file.path} (Status: ${file_status})`
        );

        if (file_status === "added") {
          core.info(`   - Reporting added file...`);
          // Simple report, no Gemini call for added file itself
          analysis_results.push({
            filePath: link_file.path,
            page: 0, // Use 0 for file-level status
            analysis: "**ファイル追加**",
          });
          // Analyze individual pages if they exist
          if (head_result && head_result.png_paths.length > 0) {
            for (let i = 0; i < head_result.png_paths.length; i++) {
              const page_num = i + 1;
              const head_png_path = head_result.png_paths[i];
              core.info(`   - Analyzing added Page ${page_num}...`);
              try {
                const analysis = await analyze_image_diff_with_gemini(
                  null, // No base image
                  head_png_path,
                  params.gemini_api_key,
                  params.gemini_model_name
                );
                analysis_results.push({
                  filePath: link_file.path,
                  page: page_num,
                  analysis,
                });
              } catch (geminiError) {
                core.error(
                  `   - Gemini analysis failed for added page ${page_num}: ${
                    (geminiError as Error).message
                  }`
                );
                analysis_results.push({
                  filePath: link_file.path,
                  page: page_num,
                  analysis:
                    "*エラー: 追加されたページの分析中に問題が発生しました。*",
                });
              }
            }
          } else {
            core.warning(
              `   - No head images found for added file ${link_file.path}.`
            );
          }
        } else if (file_status === "removed") {
          core.info(`   - Reporting removed file...`);
          // Simple report, no Gemini call needed as analyze_image_diff_with_gemini handles null head_png_path
          const analysis = await analyze_image_diff_with_gemini(
            base_result?.png_paths[0] ?? null, // Use first page of base if available for context (optional)
            null, // No head image
            params.gemini_api_key,
            params.gemini_model_name
          );
          analysis_results.push({
            filePath: link_file.path,
            page: 0, // Use 0 for file-level status
            analysis: analysis ?? "**ファイル削除**", // Use Gemini result or default
          });
        } else if (file_status === "modified" || file_status === "renamed") {
          if (base_result && head_result) {
            // Compare page counts
            const base_pages = base_result.png_paths.length;
            const head_pages = head_result.png_paths.length;
            const max_pages = Math.max(base_pages, head_pages);
            core.info(
              `   - Analyzing modified/renamed file (Base: ${base_pages} pages, Head: ${head_pages} pages)`
            );

            if (base_pages === 0 && head_pages > 0) {
              analysis_results.push({
                filePath: link_file.path,
                page: 0,
                analysis:
                  "**コンテンツ追加** (ファイルは変更されましたが、以前は空でした)",
              });
              // Also analyze the new pages individually
              for (let i = 0; i < head_pages; i++) {
                const page_num = i + 1;
                const head_png_path = head_result.png_paths[i];
                core.info(
                  `   - Analyzing added Page ${page_num} in modified file...`
                );
                try {
                  const analysis = await analyze_image_diff_with_gemini(
                    null,
                    head_png_path,
                    params.gemini_api_key,
                    params.gemini_model_name
                  );
                  analysis_results.push({
                    filePath: link_file.path,
                    page: page_num,
                    analysis,
                  });
                } catch (geminiError) {
                  core.error(
                    `   - Gemini analysis failed for added page ${page_num}: ${
                      (geminiError as Error).message
                    }`
                  );
                  analysis_results.push({
                    filePath: link_file.path,
                    page: page_num,
                    analysis:
                      "*エラー: 追加されたページの分析中に問題が発生しました。*",
                  });
                }
              }
            } else if (head_pages === 0 && base_pages > 0) {
              analysis_results.push({
                filePath: link_file.path,
                page: 0,
                analysis:
                  "**コンテンツ削除** (ファイルは変更されましたが、現在は空です)",
              });
            } else if (base_pages === 0 && head_pages === 0) {
              core.warning(
                `   - Both base and head have no images for ${link_file.path}. Skipping.`
              );
              continue;
            }

            // Analyze common pages and report additions/deletions
            for (let i = 0; i < max_pages; i++) {
              const page_num = i + 1;
              const base_png_path = base_result.png_paths[i]; // Might be undefined
              const head_png_path = head_result.png_paths[i]; // Might be undefined

              if (base_png_path && head_png_path) {
                // --- Actual Gemini Call for Page Diff ---
                core.info(`   - Comparing Page ${page_num}...`);
                try {
                  const analysis = await analyze_image_diff_with_gemini(
                    base_png_path,
                    head_png_path,
                    params.gemini_api_key, // API key is checked at the start of the block
                    params.gemini_model_name
                  );
                  analysis_results.push({
                    filePath: link_file.path,
                    page: page_num,
                    analysis, // Store Gemini's response
                  });
                } catch (geminiError) {
                  core.error(
                    `   - Gemini analysis failed for page ${page_num}: ${
                      (geminiError as Error).message
                    }`
                  );
                  analysis_results.push({
                    filePath: link_file.path,
                    page: page_num,
                    analysis: "*エラー: ページの分析中に問題が発生しました。*", // Indicate error in comment
                  });
                }
                // --- End Actual Gemini Call ---
              } else if (head_png_path) {
                // Report added page and analyze it
                core.info(`   - Page ${page_num} added.`);
                analysis_results.push({
                  filePath: link_file.path,
                  page: page_num,
                  analysis: "**ページ追加**",
                });
                try {
                  const analysis = await analyze_image_diff_with_gemini(
                    null,
                    head_png_path,
                    params.gemini_api_key,
                    params.gemini_model_name
                  );
                  // Prepend note that this is analysis of the added page
                  analysis_results.push({
                    filePath: link_file.path,
                    page: page_num,
                    analysis: `追加内容:\n${analysis}`,
                  });
                } catch (geminiError) {
                  core.error(
                    `   - Gemini analysis failed for added page ${page_num}: ${
                      (geminiError as Error).message
                    }`
                  );
                  analysis_results.push({
                    filePath: link_file.path,
                    page: page_num,
                    analysis:
                      "*エラー: 追加されたページの分析中に問題が発生しました。*",
                  });
                }
              } else if (base_png_path) {
                // Report removed page
                core.info(`   - Page ${page_num} removed.`);
                analysis_results.push({
                  filePath: link_file.path,
                  page: page_num,
                  analysis: "**ページ削除**",
                });
              }
            }
          } else {
            core.warning(
              `Could not find both base and head image results for modified/renamed file: ${link_file.path}. Skipping analysis.`
            );
          }
        }
      }

      // --- Post Comment to PR ---
      if (analysis_results.length > 0) {
        core.info("Aggregating Gemini results and posting PR comment...");
        try {
          // --- Actual Call to format_pr_comment ---
          const comment_body = format_pr_comment(
            analysis_results,
            repo_html_url, // Pass repo URL for linking
            params.head_sha // Pass head SHA for linking
          );
          // --- End Actual Call ---

          await params.octokit.rest.issues.createComment({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.pr_number,
            body: comment_body,
          });
          core.info("Successfully posted analysis comment to PR.");
        } catch (commentError) {
          core.error(
            `Failed to post analysis comment to PR #${params.pr_number}: ${
              (commentError as Error).message
            }`
          );
          // Don't fail the whole action for a comment failure
        }
      } else {
        core.info("No analysis results to post.");
      }

      core.endGroup(); // End Gemini Analysis group
    } else if (params.gemini_api_key) {
      core.info(
        "Skipping Gemini analysis as no relevant files were changed or processed."
      );
    } else {
      core.info("Skipping Gemini analysis as API key is not provided.");
    }
  } catch (error) {
    core.error(
      `Unhandled error during visual diff generation: ${
        (error as Error).message
      }`
    );
    core.setFailed(
      `Visual diff generation failed: ${(error as Error).message}`
    );
  } finally {
    // --- Cleanup Temp Directory ---
    if (processing_temp_dir) {
      core.info(
        `Cleaning up temporary processing directory: ${processing_temp_dir}`
      );
      await fs.promises
        .rm(processing_temp_dir, { recursive: true, force: true })
        .catch((rmErr) =>
          core.warning(
            `Failed to remove processing temp directory ${processing_temp_dir}: ${rmErr.message}`
          )
        );
    }
    core.info("Visual Diff Generation step completed.");
    core.endGroup(); // End main group
  }
}
