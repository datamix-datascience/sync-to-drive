import * as core from "@actions/core";
import { google } from "googleapis";
import * as fs_promises from "fs/promises";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { glob } from "glob";
import { exec, getExecOutput } from "@actions/exec";
import { Octokit } from "@octokit/rest";

// Config types
interface SyncConfig {
  source: { repo: string };
  ignore: string[];
  targets: { forks: DriveTarget[] };
}

interface DriveTarget {
  drive_folder_id: string;
  drive_url: string;
  on_untrack: "ignore" | "remove" | "request";
}

interface FileInfo {
  path: string;
  hash: string;
  relative_path: string;
}

interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  md5Checksum?: string;
  owners?: { emailAddress: string }[];
}

interface DriveFilesListResponse {
  files?: DriveFile[];
  nextPageToken?: string;
}

interface DrivePermission {
  id: string;
  role: string;
  pendingOwner?: boolean;
  emailAddress?: string;
}

interface DrivePermissionsListResponse {
  permissions?: DrivePermission[];
  nextPageToken?: string;
}

interface UntrackedItem {
  id: string;
  path: string;
  url: string;
  name: string;
  owner_email: string;
  ownership_transfer_requested: boolean;
}

interface DriveItem {
  id: string;
  name: string;
  hash?: string;
  owned: boolean;
  permissions: DrivePermission[];
}

// Load config
let config: SyncConfig;
try {
  config = JSON.parse(readFileSync("sync.json", "utf-8"));
} catch (error) {
  core.setFailed("Failed to load sync.json from target repo");
  process.exit(1);
}

// Google Drive API setup
const credentials = core.getInput("credentials", { required: true });
const credentials_json = JSON.parse(Buffer.from(credentials, "base64").toString());
const auth = new google.auth.JWT(
  credentials_json.client_email,
  undefined,
  credentials_json.private_key,
  ["https://www.googleapis.com/auth/drive"]
);
const drive = google.drive({ version: "v3", auth });

// GitHub API setup
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// Track ownership transfer requests
const ownership_transfer_requested_ids = new Set<string>();

// Compute file hash
async function compute_hash(file_path: string): Promise<string> {
  const content = await fs_promises.readFile(file_path);
  return createHash("md5").update(content).digest("hex");
}

// List local files
async function list_local_files(root_dir: string): Promise<FileInfo[]> {
  const files: FileInfo[] = [];
  const all_files = await glob("**", {
    cwd: root_dir,
    nodir: false,
    dot: true,
    ignore: config.ignore.concat([".git/**"]),
  });

  for (const relative_path of all_files) {
    const full_path = path.join(root_dir, relative_path);
    const stats = await fs_promises.stat(full_path);
    if (stats.isFile()) {
      const hash = await compute_hash(full_path);
      files.push({ path: full_path, hash, relative_path });
    }
  }
  return files;
}

// Accept pending ownership transfers recursively
async function accept_ownership_transfers(file_id: string) {
  try {
    let permissions: DrivePermission[] = [];
    let next_page_token: string | undefined;

    do {
      const res = await drive.permissions.list({
        fileId: file_id,
        fields: "nextPageToken, permissions(id, role, emailAddress, pendingOwner)",
        pageToken: next_page_token,
      }) as { data: DrivePermissionsListResponse };

      permissions = permissions.concat(res.data.permissions || []);
      next_page_token = res.data.nextPageToken;
    } while (next_page_token);

    const service_account_email = credentials_json.client_email;
    const pending_permissions = permissions.filter(
      p => p.emailAddress === service_account_email && p.pendingOwner
    );

    for (const perm of pending_permissions) {
      core.info(`Accepting ownership transfer for item ${file_id}, permission ID: ${perm.id}`);
      await drive.permissions.update({
        fileId: file_id,
        permissionId: perm.id,
        requestBody: { role: "owner" },
        transferOwnership: true,
      });
      core.info(`Ownership accepted for item ${file_id}`);
      ownership_transfer_requested_ids.delete(file_id);
    }

    const children = await drive.files.list({
      q: `'${file_id}' in parents`,
      fields: "files(id, mimeType)",
    });
    for (const child of children.data.files || []) {
      if (child.id) {
        await accept_ownership_transfers(child.id);
      }
    }
  } catch (error: unknown) {
    const err = error as any;
    core.warning(`Failed to accept ownership transfers for item ${file_id}: ${err.message}`);
  }
}

// List Drive files recursively
async function list_drive_files_recursively(
  folder_id: string,
  base_path: string = ""
): Promise<{
  files: Map<string, DriveItem>;
  folders: Map<string, DriveItem>;
}> {
  const file_map = new Map<string, DriveItem>();
  const folder_map = new Map<string, DriveItem>();
  let all_files: DriveFile[] = [];
  let next_page_token: string | undefined;

  do {
    const res = await drive.files.list({
      q: `'${folder_id}' in parents`,
      fields: "nextPageToken, files(id, name, mimeType, md5Checksum, owners(emailAddress))",
      spaces: "drive",
      pageToken: next_page_token,
      pageSize: 1000,
    }) as { data: DriveFilesListResponse };

    all_files = all_files.concat(res.data.files || []);
    next_page_token = res.data.nextPageToken;
  } while (next_page_token);

  const service_account_email = credentials_json.client_email;
  for (const file of all_files) {
    if (!file.name || !file.id) continue;
    const relative_path = base_path ? path.join(base_path, file.name) : file.name;
    const owned = file.owners?.some(owner => owner.emailAddress === service_account_email) || false;

    const perm_res = await drive.permissions.list({
      fileId: file.id,
      fields: "permissions(id, role, emailAddress, pendingOwner)",
    }) as { data: DrivePermissionsListResponse };
    const permissions = perm_res.data.permissions || [];

    if (file.mimeType === "application/vnd.google-apps.folder") {

      folder_map.set(relative_path, { id: file.id, name: file.name, owned, permissions });
      const subfolder_data = await list_drive_files_recursively(file.id, relative_path);
      for (const [sub_path, sub_file] of subfolder_data.files) {
        file_map.set(sub_path, sub_file);
      }
      for (const [sub_path, sub_folder] of subfolder_data.folders) {
        folder_map.set(sub_path, sub_folder);
      }
    } else {

      file_map.set(relative_path, { id: file.id, name: file.name, hash: file.md5Checksum || "", owned, permissions });
    }
  }

  return { files: file_map, folders: folder_map };
}

// Ensure folder (reuse existing if possible)
async function ensure_folder(parent_id: string, folder_name: string): Promise<string> {
  core.info(`Ensuring folder '${folder_name}' under parent '${parent_id}'`);
  try {
    let all_files: DriveFile[] = [];
    let next_page_token: string | undefined;

    do {
      core.info(`Listing files under '${parent_id}' with query: '${parent_id}' in parents`);
      const res = await drive.files.list({
        q: `'${parent_id}' in parents`,
        fields: "nextPageToken, files(id, name, mimeType)",
        spaces: "drive",
        pageToken: next_page_token,
        pageSize: 1000,
      }) as { data: DriveFilesListResponse };

      core.info(`API response for '${parent_id}': ${JSON.stringify(res.data)}`);
      all_files = all_files.concat(res.data.files || []);
      next_page_token = res.data.nextPageToken;
    } while (next_page_token);

    const existing_folder = all_files.find(file =>
      file.mimeType === "application/vnd.google-apps.folder" &&
      file.name?.toLowerCase() === folder_name.toLowerCase()
    );
    if (existing_folder && existing_folder.id) {
      core.info(`Reusing existing folder '${folder_name}' with ID: ${existing_folder.id}`);
      return existing_folder.id;
    }

    core.info(`Folder '${folder_name}' not found, creating it...`);
    const folder = await drive.files.create({
      requestBody: {
        name: folder_name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parent_id],
      },
      fields: "id",
    });
    core.info(`Created folder '${folder_name}' with ID: ${folder.data.id}`);
    return folder.data.id!;
  } catch (error: unknown) {
    const err = error as any;
    core.error(`Failed to ensure folder '${folder_name}' under '${parent_id}': ${err.message}`);
    throw err;
  }
}

// Build folder structure
async function build_folder_structure(
  root_folder_id: string,
  local_files: FileInfo[],
  existing_folders: Map<string, DriveItem>
): Promise<Map<string, string>> {
  const folder_map = new Map<string, string>();
  folder_map.set("", root_folder_id);

  const unique_paths = new Set<string>();
  for (const file of local_files) {
    const parts = file.relative_path.split(path.sep);
    let current_path = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current_path = current_path ? path.join(current_path, parts[i]) : parts[i];
      unique_paths.add(current_path);
    }
  }

  for (const folder_path of Array.from(unique_paths).sort()) {
    const parts = folder_path.split(path.sep);
    let current_folder_id = root_folder_id;
    let current_path = "";
    for (const part of parts) {
      current_path = current_path ? path.join(current_path, part) : part;
      if (!folder_map.has(current_path)) {
        const existing_folder = existing_folders.get(current_path);
        if (existing_folder && existing_folder.id) {
          core.info(`Using existing folder '${current_path}' with ID: ${existing_folder.id}`);
          current_folder_id = existing_folder.id;
        } else {
          current_folder_id = await ensure_folder(current_folder_id, part);
        }
        folder_map.set(current_path, current_folder_id);
      } else {
        current_folder_id = folder_map.get(current_path)!;
      }
    }
  }

  return folder_map;
}

// Upload or update file
async function upload_file(file_path: string, folder_id: string, existing_file?: { id: string; name: string }): Promise<boolean> {
  const file_name = path.basename(file_path);
  const media = { body: fs.createReadStream(file_path) };

  try {
    if (existing_file && existing_file.id) {
      core.info(`Updating existing file '${file_name}' (ID: ${existing_file.id})`);
      const res = await drive.files.update({
        fileId: existing_file.id,
        media,
        requestBody: { name: file_name },
        fields: "id",
      });
      core.info(`Updated file '${file_name}' (ID: ${res.data.id})`);
    } else {
      core.info(`Creating new file '${file_name}' in folder ${folder_id}`);
      const res = await drive.files.create({
        requestBody: { name: file_name, parents: [folder_id] },
        media,
        fields: "id",
      });
      core.info(`Uploaded file '${file_name}' (ID: ${res.data.id})`);
    }
    return true;
  } catch (error: unknown) {
    const err = error as any;
    core.warning(`Failed to process '${file_name}' in folder ${folder_id}: ${err.message}`);
    return false;
  }
}

// Delete untracked file or folder
async function delete_untracked(id: string, name: string, is_folder: boolean = false): Promise<boolean> {
  try {
    await drive.files.update({
      fileId: id,
      requestBody: { trashed: true },
    });
    core.info(`Moved untracked ${is_folder ? "folder" : "file"} to Trash: ${name}`);
    return true;
  } catch (error: unknown) {
    const err = error as any;
    core.warning(`Failed to trash untracked ${is_folder ? "folder" : "file"} '${name}' (ID: ${id}): ${err.message}`);
    return false;
  }
}

// Request ownership transfer with response logging
async function request_ownership_transfer(file_id: string, current_owner_email: string) {
  try {
    const service_account_email = credentials_json.client_email;
    core.info(`Requesting ownership transfer of item ${file_id} from ${current_owner_email} to ${service_account_email}`);
    const response = await drive.permissions.create({
      fileId: file_id,
      requestBody: {
        role: "owner",
        type: "user",
        emailAddress: service_account_email,
      },
      transferOwnership: true,
      sendNotificationEmail: true,
      emailMessage: `Please approve ownership transfer of item ${file_id} to ${service_account_email} for sync cleanup`,
    });
    core.info(`Ownership transfer response for item ${file_id}: ${JSON.stringify(response.data)}`);
    ownership_transfer_requested_ids.add(file_id);
  } catch (error: unknown) {
    const err = error as any;
    core.warning(`Failed to request ownership transfer for item ${file_id}: ${err.message}`);
  }
}

// Download file from Drive
async function download_file(file_id: string, local_path: string): Promise<void> {
  try {
    const dir = path.dirname(local_path);
    await fs_promises.mkdir(dir, { recursive: true });
    const res = await drive.files.get({ fileId: file_id, alt: "media" }, { responseType: "stream" });
    const writer = fs.createWriteStream(local_path);
    return new Promise((resolve, reject) => {
      res.data
        .pipe(writer)
        .on("finish", () => {
          core.info(`Downloaded file ${file_id} to ${local_path}`);
          resolve();
        })
        .on("error", (err) => {
          core.error(`Error downloading file ${file_id}: ${err.message}`);
          reject(err);
        });
    });
  } catch (error) {
    core.error(`Failed to download file ${file_id}: ${(error as Error).message}`);
    throw error;
  }
}

// Git execution helper
async function execGit(command: string, args: string[]): Promise<void> {
  try {
    await exec("git", [command, ...args]);
  } catch (error) {
    core.error(`Git command failed: git ${command} ${args.join(" ")} - ${(error as Error).message}`);
    throw error;
  }
}

async function create_pull_request_with_retry(
  octokit: Octokit,
  params: { owner: string; repo: string; title: string; head: string; body: string },
  max_retries = 3,
  initial_delay = 1000 // Renamed for clarity
) {
  let current_delay = initial_delay; // Use a separate variable for delay logic
  for (let attempt = 0; attempt < max_retries; attempt++) {
    try {
      // Fetch repository info to get the default branch *inside* the loop
      // to ensure the base is correct even if retrying after a delay.
      const repo_info = await octokit.rest.repos.get({
        owner: params.owner,
        repo: params.repo,
      });
      const default_branch = repo_info.data.default_branch;
      core.info(`Default branch for ${params.owner}/${params.repo} is ${default_branch}`);

      // Create the pull request using octokit.rest
      core.info(`Attempting to create PR: head=${params.head} base=${default_branch}`);
      await octokit.rest.pulls.create({
        owner: params.owner,
        repo: params.repo,
        title: params.title,
        head: params.head,
        base: default_branch, // Use fetched default branch
        body: params.body,
      });
      core.info(`Pull request created successfully! (head: ${params.head}, base: ${default_branch})`);
      return; // Success, exit the function
    } catch (error: unknown) {
      // Check if the error is an object and has a status property
      const http_error = error as { status?: number; message?: string };
      // Specifically retry on 404 (branch might not be fully propagated)
      // or 422 (sometimes happens if base/head refs are briefly unavailable)
      if ((http_error?.status === 404 || http_error?.status === 422) && attempt < max_retries - 1) {
        core.warning(`Attempt ${attempt + 1} failed with status ${http_error.status}. Retrying in ${current_delay}ms... Error: ${http_error.message || error}`);
        await new Promise(resolve => setTimeout(resolve, current_delay));
        current_delay *= 2; // Exponential backoff
      } else {
        core.error(`Failed to create pull request after ${attempt + 1} attempts.`);
        if (http_error?.message) {
          core.error(`Error details: Status ${http_error?.status}, Message: ${http_error.message}`);
        }
        throw error; // If it's not a retriable error or retries are exhausted, fail
      }
    }
  }
}

// Handle Drive changes with PR creation
async function handle_drive_changes(folder_id: string) { // folder_id is already passed in
  // *** Create a unique temporary state branch name using the folder_id ***
  const original_state_branch = `original-state-${folder_id}-${process.env.GITHUB_RUN_ID}`;
  await execGit("checkout", ["-b", original_state_branch]); // Use unique name

  const local_files = await list_local_files(".");
  // Convert local paths to lowercase for case-insensitive comparison (like Windows/macOS sometimes behave)
  const local_map = new Map(local_files.map(f => [f.relative_path.toLowerCase(), f]));

  const { files: drive_files } = await list_drive_files_recursively(folder_id);
  // Convert drive paths to lowercase for case-insensitive comparison
  const drive_map = new Map(Array.from(drive_files).map(([path, item]) => [path.toLowerCase(), item]));

  const new_files: { path: string; id: string }[] = [];
  const modified_files: { path: string; id: string }[] = [];
  const deleted_files: string[] = [];

  // Compare Drive files against local files
  for (const [drive_path_lower, drive_item] of drive_map) {
    const local_file = local_map.get(drive_path_lower);
    // Find the original case path from the Drive item name if possible, otherwise use lower case path
    const drive_path_original_case = drive_item.name ? path.join(path.dirname(drive_path_lower), drive_item.name) : drive_path_lower;

    if (!local_file) {
      // File exists in Drive, not locally -> New file from Drive
      new_files.push({ path: drive_path_original_case, id: drive_item.id });
    } else if (local_file.hash !== drive_item.hash) {
      // File exists in both, but hashes differ -> Modified file from Drive
      core.info(`File ${local_file.relative_path} differs: local=${local_file.hash}, drive=${drive_item.hash}`);
      modified_files.push({ path: local_file.relative_path, id: drive_item.id }); // Use local path for consistency
    }
    // Remove processed files from local_map to find deleted ones later
    local_map.delete(drive_path_lower);
  }

  // Any remaining files in local_map were not found in Drive -> Deleted file from Drive
  for (const [local_path_lower, local_file] of local_map) {
    // Check ignore list using the original relative path
    const is_ignored = config.ignore.some(pattern => new RegExp(pattern.replace(/\*/g, ".*")).test(local_file.relative_path));
    if (!is_ignored) {
      deleted_files.push(local_file.relative_path); // Use original case path for git rm
    } else {
      core.info(`Skipping deletion of ignored file: ${local_file.relative_path}`);
    }
  }


  let changes_made = false;
  for (const { path: file_path, id } of new_files) {
    core.info(`Downloading new file from Drive: ${file_path} (ID: ${id})`);
    await download_file(id, file_path);
    await execGit("add", [file_path]);
    changes_made = true;
  }
  for (const { path: file_path, id } of modified_files) {
    core.info(`Downloading modified file from Drive: ${file_path} (ID: ${id})`);
    await download_file(id, file_path);
    await execGit("add", [file_path]);
    changes_made = true;
  }
  for (const file_path of deleted_files) {
    core.info(`Removing file deleted in Drive: ${file_path}`);
    // Ensure the file actually exists locally before trying to remove
    if (fs.existsSync(file_path)) {
      await fs_promises.unlink(file_path).catch((err) => { core.warning(`Failed to unlink ${file_path}: ${err.message}`) });
    } else {
      core.info(`File ${file_path} already removed locally.`);
    }
    // Use git rm --ignore-unmatch in case unlink failed or file wasn't tracked
    await execGit("rm", ["--ignore-unmatch", file_path]);
    changes_made = true;
  }

  if (changes_made) {
    const commit_messages: string[] = [];
    if (new_files.length > 0) {
      commit_messages.push(`drive-add: Add ${new_files.map(f => f.path).join(", ")}`);
    }
    if (modified_files.length > 0) {
      commit_messages.push(`drive-update: Update ${modified_files.map(f => f.path).join(", ")}`);
    }
    if (deleted_files.length > 0) {
      commit_messages.push(`drive-remove: Remove ${deleted_files.join(", ")}`);
    }

    if (commit_messages.length > 0) {
      // Configure Git identity
      await execGit("config", ["--local", "user.email", "github-actions[bot]@users.noreply.github.com"]);
      await execGit("config", ["--local", "user.name", "github-actions[bot]"]);

      // *** Create a unique head branch name using the folder_id ***
      // Sanitize folder_id slightly for branch name (replace common problematic chars)
      const sanitized_folder_id = folder_id.replace(/[^a-zA-Z0-9_-]/g, '_');
      const head_branch = `sync-from-drive-${sanitized_folder_id}-${process.env.GITHUB_RUN_ID}`;

      // Check if there are staged changes before committing
      try {
        await exec("git", ["diff", "--cached", "--quiet"]);
        // If the above command succeeds (exit code 0), there are no staged changes.
        core.info("No changes staged for commit. Skipping commit and PR creation for this target.");
      } catch (error) {
        // If the above command fails (non-zero exit code), there are staged changes. Proceed with commit.
        core.info("Changes detected, proceeding with commit.");
        await execGit("commit", ["-m", commit_messages.join("\n")]);
        await execGit("checkout", ["-b", head_branch]); // Use unique name

        // Use --force push. This is needed if a previous run for the SAME folder_id/run_id failed after push but before PR/cleanup.
        // It ensures the latest state from Drive for this sync attempt gets pushed.
        await execGit("push", ["--force", "origin", head_branch]);

        const [owner, repo] = process.env.GITHUB_REPOSITORY!.split("/");

        core.info(`Preparing to create PR for owner: ${owner}, repo: ${repo}, head: ${head_branch}`);

        // Construct parameters for the new function
        const pr_params = {
          owner: owner,
          repo: repo,
          title: `Sync changes from Google Drive (${folder_id})`, // Add folder ID to title for clarity
          head: head_branch, // The branch that was just pushed
          body: `This PR syncs changes detected in Google Drive folder ${folder_id}:\n` +
            (new_files.length > 0 ? `- Added: ${new_files.map(f => `\`${f.path}\``).join(", ")}\n` : "") +
            (modified_files.length > 0 ? `- Updated: ${modified_files.map(f => `\`${f.path}\``).join(", ")}\n` : "") +
            (deleted_files.length > 0 ? `- Removed: ${deleted_files.join(", ")}\n` : ""),
        };

        // Call the refined function with retry logic
        try {
          await create_pull_request_with_retry(octokit, pr_params);
          core.info(`Pull request creation initiated successfully for branch ${head_branch}.`);
        } catch (pr_error) {
          core.setFailed(`Failed to create pull request for branch ${head_branch}: ${(pr_error as Error).message}`);
          // Consider if cleanup needs to be different on PR failure. Currently, it proceeds.
        }
      } // End of try-catch for git diff
    } else {
      core.info("No commit messages generated, likely no effective changes detected.");
    }
  } else {
    core.info("No changes detected between local state and Drive for this target.");
  }


  // *** Cleanup uses the unique temporary state branch name ***
  // Check if main branch exists before checking out
  try {
    await execGit("rev-parse", ["--verify", "main"]);
    await execGit("checkout", ["main"]);
  } catch (error) {
    core.warning("Could not checkout 'main', attempting to checkout default branch from origin...");
    try {
      // Fetch origin to ensure we know about remote branches
      await execGit("fetch", ["origin"]);
      // Find the default branch (HEAD points to it)
      const default_branch_output = await getExecOutput("git", ["remote", "show", "origin"], { silent: true });
      if (default_branch_output.exitCode === 0) { // Check the exit code from the result object
        // Access stdout from the result object
        const match = default_branch_output.stdout.match(/HEAD branch:\s*(.+)/);
        if (match && match[1]) {
          const default_branch = match[1].trim();
          core.info(`Checking out default branch: ${default_branch}`);
          await execGit("checkout", [default_branch]);
        } else {
          core.warning("Could not determine default branch from 'git remote show origin' output. Skipping checkout.");
          core.info(`stdout was: ${default_branch_output.stdout}`); // Log output for debugging
        }
      } else {
        core.warning(`'git remote show origin' failed with exit code ${default_branch_output.exitCode}. Skipping checkout.`);
        core.warning(`stderr was: ${default_branch_output.stderr}`); // Log error for debugging
      }
    } catch (fetchError) {
      // This catch might be less likely now with ignoreReturnCode, but keep for other potential errors
      core.error(`Failed during fetch/checkout attempt: ${(fetchError as Error).message}`);
    }
  }

  // Resetting should happen *after* checking out the target branch (main/default)
  // This reset isn't strictly necessary anymore with the unique original-state branch,
  // but it ensures the working directory is clean relative to main/default.
  await execGit("reset", ["--hard", `HEAD`]); // Reset to the current HEAD (main/default)

  // Delete the unique temporary state branch
  await execGit("branch", ["-D", original_state_branch]);
}

// Main sync function
async function sync_to_drive() {
  const local_files = await list_local_files(".");
  if (local_files.length === 0) {
    core.setFailed("No files found in repository to sync");
    return;
  }

  for (const target of config.targets.forks) {
    const folder_id = target.drive_folder_id;
    core.info(`Starting sync process for Drive folder: ${folder_id}`);

    await handle_drive_changes(folder_id);
    await accept_ownership_transfers(folder_id);

    let folder_map: Map<string, string>;
    let drive_files: Map<string, DriveItem>;
    let drive_folders: Map<string, DriveItem>;

    try {
      const drive_data = await list_drive_files_recursively(folder_id);
      drive_files = drive_data.files;
      drive_folders = drive_data.folders;
      folder_map = await build_folder_structure(folder_id, local_files, drive_folders);
    } catch (error: unknown) {
      const err = error as any;
      core.warning(`Failed to initialize sync for folder ${folder_id}: ${err.message}`);
      continue;
    }

    const drive_link = `https://drive.google.com/drive/folders/${folder_id}`;
    core.setOutput("link", drive_link);

    const local_file_map = new Map(local_files.map(f => [f.relative_path, f]));
    for (const [relative_path, local_file] of local_file_map) {
      const file_name = path.basename(relative_path);
      const dir_path = path.dirname(relative_path) || "";
      const target_folder_id = folder_map.get(dir_path) || folder_id;
      const drive_file = drive_files.get(relative_path);

      if (!drive_file) {
        core.info(`New file in GitHub, uploading to Drive: ${relative_path}`);
        await upload_file(local_file.path, target_folder_id);
      } else if (drive_file.hash !== local_file.hash) {
        core.info(`GitHub file newer, updating Drive (Drive was older): ${relative_path}`);
        await upload_file(local_file.path, target_folder_id, { id: drive_file.id, name: file_name });
      }
      drive_files.delete(relative_path);
    }


    // *** Add logging for ignore check during untracked file removal ***
    if (target.on_untrack === "remove") {
      for (const [file_path, file_info] of drive_files) {
        // Convert to lower case for comparison consistency if needed, but use original path for logging/ignore check
        const file_path_lower = file_path.toLowerCase();

        // Check ignore patterns against the original file path from Drive
        const is_ignored = config.ignore.some(pattern => {
          // Basic glob-like conversion: * -> .*, ? -> . (adjust if more complex patterns needed)
          const regexPattern = pattern.replace(/\*/g, ".*").replace(/\?/g, ".");
          // Ensure pattern matches whole path segments if needed (e.g., using ^ and $ anchors if necessary)
          // Example: Check if the file_path starts with the pattern (if pattern represents a directory)
          // Or if the pattern exactly matches the file_path
          return new RegExp(`^${regexPattern}$`).test(file_path);
        });

        if (is_ignored) {
          core.info(`Untracked file/folder in Drive is ignored by config: ${file_path}`);
          drive_files.delete(file_path); // Remove from map so it's not processed further
          continue; // Skip ownership check and deletion for ignored items
        }

        // Check ownership only if not ignored
        if (!file_info.owned) {
          const current_owner = file_info.permissions.find((p: DrivePermission) => p.role === "owner")?.emailAddress;
          if (current_owner && current_owner !== credentials_json.client_email) {
            core.warning(`Untracked file/folder in Drive not owned by service account and not ignored: ${file_path}. Owner: ${current_owner}`);
            await request_ownership_transfer(file_info.id, current_owner);
            drive_files.delete(file_path); // Remove from map as ownership transfer requested
            continue; // Skip deletion attempt for now
          } else {
            core.info(`Untracked file/folder in Drive has no owner or is owned by service account: ${file_path}. Proceeding with deletion check.`);
          }
        } else {
          core.info(`Untracked file/folder in Drive is owned by service account: ${file_path}. Proceeding with deletion check.`);
        }

        // Delete the untracked item (only if owned or owner check passed)
        core.info(`Untracked file/folder in Drive will be removed: ${file_path}`);
        if (await delete_untracked(file_info.id, file_path)) { // Pass original path for logging
          drive_files.delete(file_path); // Remove from map after successful deletion
        } else {
          // Keep it in the map if deletion failed, maybe log differently?
          core.warning(`Failed to delete untracked file/folder from Drive: ${file_path}`);
        }
      }
    } else if (target.on_untrack === 'ignore' || target.on_untrack === 'request') {
      // Log if untracked files exist but won't be removed
      if (drive_files.size > 0) {
        core.info(`Found ${drive_files.size} untracked file(s)/folder(s) in Drive for folder ${folder_id}. Action 'on_untrack' is set to '${target.on_untrack}'.`);
        // Optionally list them if needed for debugging
        // for (const [file_path] of drive_files) {
        //    core.info(` - Untracked: ${file_path}`);
        // }
        if (target.on_untrack === 'request') {
          core.warning(`Ownership transfer requests might be needed for untracked items if not owned by the service account.`);
          // Add logic similar to 'remove' block to request transfer if needed, but don't delete
          for (const [file_path, file_info] of drive_files) {
            const is_ignored = config.ignore.some(pattern => new RegExp(pattern.replace(/\*/g, ".*")).test(file_path));
            if (is_ignored) continue;
            if (!file_info.owned) {
              const current_owner = file_info.permissions.find((p: DrivePermission) => p.role === "owner")?.emailAddress;
              if (current_owner && current_owner !== credentials_json.client_email) {
                await request_ownership_transfer(file_info.id, current_owner);
              }
            }
          }
        }
      }
    }


    core.info(`Sync completed for folder ${folder_id}`);
  }
}

// Run the action
sync_to_drive().catch((error: unknown) => {
  const err = error as Error;
  core.error(`Unexpected failure in sync_to_drive: ${err.message}`);
  core.setFailed(`Sync failed unexpectedly: ${err.message}`);
});
