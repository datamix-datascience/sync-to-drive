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
  mimeType?: string;
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
const credentials_input = core.getInput("credentials", { required: true }); // Use a consistent name
const credentials_json = JSON.parse(Buffer.from(credentials_input, "base64").toString());
const auth = new google.auth.JWT(
  credentials_json.client_email,
  undefined,
  credentials_json.private_key,
  ["https://www.googleapis.com/auth/drive"]
);
const drive = google.drive({ version: "v3", auth });

// GitHub API setup
const github_token_input = core.getInput('github_token', { required: true })
const octokit = new Octokit({ auth: github_token_input });

// --- Get Trigger Event Name ---
const trigger_event_name = core.getInput('trigger_event_name', { required: true });

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
  const git_ignore_path = path.join(root_dir, '.gitignore');
  let ignore_patterns = config.ignore.concat([".git/**"]); // Start with config ignores

  // Read .gitignore if it exists
  if (fs.existsSync(git_ignore_path)) {
    try {
      const gitignore_content = await fs_promises.readFile(git_ignore_path, 'utf-8');
      const gitignore_lines = gitignore_content.split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#')); // Remove empty lines and comments
      // Simple conversion: make suitable for glob (this might need refinement for complex .gitignore patterns)
      const glob_patterns = gitignore_lines.map(line => {
        if (line.endsWith('/')) return line + '**'; // Directory
        // Treat plain file/dir names as potential dirs unless they contain wildcards
        if (!line.includes('*') && !line.includes('?') && !line.endsWith('/') && !line.startsWith('!')) return line + '/**';
        return line;
      });
      ignore_patterns = ignore_patterns.concat(glob_patterns);
      core.debug(`Added patterns from .gitignore: ${glob_patterns.join(', ')}`);
    } catch (error) {
      core.warning(`Could not read or parse .gitignore: ${(error as Error).message}`);
    }
  }
  core.info(`Using ignore patterns: ${ignore_patterns.join(', ')}`);


  const all_files = await glob("**", {
    cwd: root_dir,
    nodir: false,
    dot: true, // Include dotfiles (like .github)
    ignore: ignore_patterns, // Use combined ignore list
    follow: false, // Don't follow symlinks
    absolute: false, // Keep paths relative to root_dir
  });

  for (const relative_path of all_files) {
    const full_path = path.join(root_dir, relative_path);
    try {
      const stats = await fs_promises.lstat(full_path); // Use lstat to avoid following symlinks if any slip through
      if (stats.isFile()) {
        const hash = await compute_hash(full_path);
        files.push({ path: full_path, hash, relative_path });
      } else if (stats.isDirectory()) {
        // core.debug(`Ignoring directory: ${relative_path}`);
      } else {
        core.debug(`Ignoring non-file item: ${relative_path}`);
      }
    } catch (error) {
      // Ignore errors like permission denied or file disappearing during glob
      core.warning(`Could not stat file ${full_path}: ${(error as Error).message}`);
    }
  }
  core.info(`Found ${files.length} local files to potentially sync.`);
  return files;
}

// Accept Pending Ownership Transfers
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

    // Check children recursively ONLY if the current item is a folder
    const file_meta = await drive.files.get({ fileId: file_id, fields: 'mimeType' });
    if (file_meta.data.mimeType === 'application/vnd.google-apps.folder') {
      core.debug(`Checking children of folder ${file_id} for ownership transfers.`);
      let children_page_token: string | undefined;
      do {
        const children_res = await drive.files.list({
          q: `'${file_id}' in parents and trashed = false`, // Ensure we only list non-trashed children
          fields: "nextPageToken, files(id, mimeType)", // Only need ID and type
          pageToken: children_page_token,
          pageSize: 500, // Adjust page size as needed
        });
        for (const child of children_res.data.files || []) {
          if (child.id) {
            await accept_ownership_transfers(child.id); // Recursive call
          }
        }
        children_page_token = children_res.data.nextPageToken || undefined;
      } while (children_page_token);
    }

  } catch (error: unknown) {
    const err = error as any;
    // Reduce severity for common "not found" or permission errors during recursive checks
    if (err.code === 404 || err.code === 403) {
      core.debug(`Skipping ownership transfer check for item ${file_id} (may not exist or no permission): ${err.message}`);
    } else {
      core.warning(`Failed to process ownership transfers for item ${file_id}: ${err.message}`);
    }
  }
}


// List Drive Files Recursively
async function list_drive_files_recursively(
  folder_id: string,
  base_path: string = ""
): Promise<{
  files: Map<string, DriveItem>;
  folders: Map<string, DriveItem>;
}> {
  const file_map = new Map<string, DriveItem>();
  const folder_map = new Map<string, DriveItem>();
  let all_items: DriveFile[] = [];
  let next_page_token: string | undefined;

  core.info(`Listing items in Drive folder ID: ${folder_id} (relative path: '${base_path || '/'}')`);

  try {
    do {
      const res = await drive.files.list({
        q: `'${folder_id}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType, md5Checksum, owners(emailAddress))",
        spaces: "drive",
        pageToken: next_page_token,
        pageSize: 1000,
      }) as { data: DriveFilesListResponse };

      all_items = all_items.concat(res.data.files || []);
      next_page_token = res.data.nextPageToken;
      core.debug(`Fetched page of items from folder ${folder_id}. Next page token: ${next_page_token ? 'yes' : 'no'}`);
    } while (next_page_token);
  } catch (error) {
    core.error(`Failed to list files in Drive folder ${folder_id}: ${(error as Error).message}`);
    throw error;
  }

  core.info(`Processing ${all_items.length} items found in folder ID: ${folder_id}`);
  const service_account_email = credentials_json.client_email;

  for (const item of all_items) {
    if (!item.name || !item.id) {
      core.warning(`Skipping item with missing name or ID in folder ${folder_id}. Data: ${JSON.stringify(item)}`);
      continue;
    }
    const relative_path = base_path ? path.join(base_path, item.name).replace(/\\/g, '/') : item.name.replace(/\\/g, '/');
    const owned = item.owners?.some(owner => owner.emailAddress === service_account_email) || false;

    let permissions: DrivePermission[] = [];
    try {
      const perm_res = await drive.permissions.list({
        fileId: item.id,
        fields: "permissions(id, role, emailAddress, pendingOwner)",
      }) as { data: DrivePermissionsListResponse };
      permissions = perm_res.data.permissions || [];
    } catch (permError) {
      core.warning(`Could not list permissions for item ${item.id} ('${item.name}'): ${(permError as Error).message}`);
    }

    if (item.mimeType === "application/vnd.google-apps.folder") {
      core.debug(`Found folder: '${relative_path}' (ID: ${item.id})`);
      folder_map.set(relative_path, {
        id: item.id,
        name: item.name,
        mimeType: item.mimeType,
        owned,
        permissions
      });
      try {
        const subfolder_data = await list_drive_files_recursively(item.id, relative_path);
        subfolder_data.files.forEach((value, key) => file_map.set(key, value));
        subfolder_data.folders.forEach((value, key) => folder_map.set(key, value));
      } catch (recursiveError) {
        core.error(`Error processing subfolder ${item.id} ('${item.name}'): ${(recursiveError as Error).message}. Skipping subtree.`);
      }
    } else {
      file_map.set(relative_path, {
        id: item.id,
        name: item.name,
        mimeType: item.mimeType,
        hash: item.md5Checksum,
        owned,
        permissions
      });
    }
  }
  return { files: file_map, folders: folder_map };
}

// Ensure Folder
async function ensure_folder(parent_id: string, folder_name: string): Promise<string> {
  core.info(`Ensuring folder '${folder_name}' under parent '${parent_id}'`);
  try {
    const query = `'${parent_id}' in parents and mimeType = 'application/vnd.google-apps.folder' and name = '${folder_name.replace(/'/g, "\\'")}' and trashed = false`;
    core.debug(`Querying for existing folder: ${query}`);
    const res = await drive.files.list({
      q: query,
      fields: "files(id, name)",
      spaces: "drive",
      pageSize: 1,
    }) as { data: DriveFilesListResponse };
    core.debug(`API response for existing folder query '${folder_name}' under '${parent_id}': ${JSON.stringify(res.data)}`);
    const existing_folder = res.data.files?.[0];

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
    if (!folder.data.id) {
      throw new Error(`Folder creation API call did not return an ID for '${folder_name}'.`);
    }
    core.info(`Created folder '${folder_name}' with ID: ${folder.data.id}`);
    return folder.data.id;
  } catch (error: unknown) {
    const err = error as any;
    core.error(`Failed to ensure folder '${folder_name}' under '${parent_id}': ${err.message}`);
    if (err.response?.data) {
      core.error(`API Error Details: ${JSON.stringify(err.response.data)}`);
    }
    throw err;
  }
}

// Build Folder Structure
async function build_folder_structure(
  root_folder_id: string,
  local_files: FileInfo[],
  existing_folders: Map<string, DriveItem>
): Promise<Map<string, string>> {
  const folder_map = new Map<string, string>();
  folder_map.set("", root_folder_id);

  const required_dir_paths = new Set<string>();
  for (const file of local_files) {
    const dir = path.dirname(file.relative_path);
    if (dir && dir !== '.') {
      const parts = dir.split(path.sep);
      let current_cumulative_path = "";
      for (const part of parts) {
        current_cumulative_path = current_cumulative_path ? path.join(current_cumulative_path, part) : part;
        required_dir_paths.add(current_cumulative_path.replace(/\\/g, '/'));
      }
    }
  }

  const sorted_paths = Array.from(required_dir_paths).sort();
  core.info(`Required folder paths based on local files: ${sorted_paths.join(', ') || 'None'}`);

  for (const folder_path of sorted_paths) {
    if (folder_map.has(folder_path)) {
      core.debug(`Folder path '${folder_path}' already processed.`);
      continue;
    }
    const parts = folder_path.split('/');
    const folder_name = parts[parts.length - 1];
    const parent_path = parts.slice(0, -1).join('/');
    const parent_folder_id = folder_map.get(parent_path);

    if (!parent_folder_id) {
      core.error(`Cannot find parent folder ID for path '${folder_path}' (parent path '${parent_path}' missing from map). Skipping.`);
      continue;
    }

    const existing_drive_folder = existing_folders.get(folder_path);
    let current_folder_id: string;

    if (existing_drive_folder?.id) {
      core.info(`Using existing Drive folder '${folder_path}' with ID: ${existing_drive_folder.id}`);
      current_folder_id = existing_drive_folder.id;
    } else {
      core.info(`Creating missing folder '${folder_name}' under parent ID ${parent_folder_id} (for path '${folder_path}')`);
      try {
        current_folder_id = await ensure_folder(parent_folder_id, folder_name);
      } catch (error) {
        core.error(`Failed to create folder structure at '${folder_path}'. Stopping structure build.`);
        throw error;
      }
    }
    folder_map.set(folder_path, current_folder_id);
  }
  core.info(`Built/Verified folder structure. Path-to-ID map size: ${folder_map.size}`);
  return folder_map;
}

// Upload File
async function upload_file(file_path: string, folder_id: string, existing_file?: { id: string; name: string }): Promise<{ id: string; success: boolean }> {
  const file_name = path.basename(file_path);
  const media = { body: fs.createReadStream(file_path) };
  let fileId = existing_file?.id;

  try {
    if (existing_file?.id) {
      const requestBody: { name?: string } = {};
      if (existing_file.name !== file_name) {
        requestBody.name = file_name;
        core.info(`Updating file name for '${existing_file.name}' to '${file_name}' (ID: ${existing_file.id})`);
      }
      core.info(`Updating existing file content '${file_name}' (ID: ${existing_file.id}) in folder ${folder_id}`);
      const res = await drive.files.update({
        fileId: existing_file.id,
        media: media,
        requestBody: Object.keys(requestBody).length > 0 ? requestBody : undefined,
        fields: "id, name, md5Checksum",
      });
      fileId = res.data.id!;
      core.info(`Updated file '${res.data.name}' (ID: ${fileId}). New hash: ${res.data.md5Checksum || 'N/A'}`);
    } else {
      core.info(`Creating new file '${file_name}' in folder ${folder_id}`);
      const res = await drive.files.create({
        requestBody: { name: file_name, parents: [folder_id] },
        media: media,
        fields: "id, name, md5Checksum",
      });
      if (!res.data.id) {
        throw new Error(`File creation API call did not return an ID for '${file_name}'.`);
      }
      fileId = res.data.id;
      core.info(`Uploaded file '${res.data.name}' (ID: ${fileId}). Hash: ${res.data.md5Checksum || 'N/A'}`);
    }
    return { id: fileId!, success: true };
  } catch (error: unknown) {
    const err = error as any;
    core.warning(`Failed to process '${file_name}' in folder ${folder_id}: ${err.message}`);
    if (err.response?.data) {
      core.warning(`API Error Details: ${JSON.stringify(err.response.data)}`);
    }
    return { id: fileId || '', success: false };
  }
}

// Delete Untracked
async function delete_untracked(id: string, name: string, is_folder: boolean = false): Promise<boolean> {
  core.info(`Attempting to move ${is_folder ? "folder" : "file"} to Trash: '${name}' (ID: ${id})`);
  try {
    await drive.files.update({
      fileId: id,
      requestBody: { trashed: true },
    });
    core.info(`Moved untracked ${is_folder ? "folder" : "file"} to Trash: ${name}`);
    return true;
  } catch (error: unknown) {
    const err = error as any;
    if (err.code === 403) {
      core.error(`Permission denied trying to trash ${is_folder ? "folder" : "file"} '${name}' (ID: ${id}). Check service account permissions.`);
    } else if (err.code === 404) {
      core.warning(`Untracked ${is_folder ? "folder" : "file"} '${name}' (ID: ${id}) not found, possibly already deleted.`);
      return true;
    } else {
      core.warning(`Failed to trash untracked ${is_folder ? "folder" : "file"} '${name}' (ID: ${id}): ${err.message}`);
    }
    if (err.response?.data) {
      core.warning(`API Error Details: ${JSON.stringify(err.response.data)}`);
    }
    return false;
  }
}

// Request Ownership Transfer
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
      emailMessage: `Automated Sync: Please approve ownership transfer of this item to the sync service (${service_account_email}) for management. Item ID: ${file_id}`,
    });
    core.info(`Ownership transfer request sent for item ${file_id}. Response: ${JSON.stringify(response.data)}`);
    ownership_transfer_requested_ids.add(file_id);
  } catch (error: unknown) {
    const err = error as any;
    if (err.message && err.message.includes("Consent is required")) {
      core.error(`Failed to request ownership transfer for item ${file_id}: Owner (${current_owner_email}) must grant consent or domain admin needs to configure settings.`);
    } else if (err.code === 403) {
      core.error(`Permission denied requesting ownership transfer for item ${file_id}. Check service account permissions and Drive sharing settings.`);
    } else {
      core.warning(`Failed to request ownership transfer for item ${file_id}: ${err.message}`);
    }
    if (err.response?.data) {
      core.warning(`API Error Details: ${JSON.stringify(err.response.data)}`);
    }
  }
}

// Download File
async function download_file(file_id: string, local_path: string): Promise<void> {
  core.info(`Downloading Drive file ID ${file_id} to local path ${local_path}`);
  try {
    const dir = path.dirname(local_path);
    await fs_promises.mkdir(dir, { recursive: true });
    const res = await drive.files.get(
      { fileId: file_id, alt: "media" },
      { responseType: "stream" }
    );
    const writer = fs.createWriteStream(local_path);
    return new Promise((resolve, reject) => {
      res.data
        .pipe(writer)
        .on("finish", () => {
          core.info(`Successfully downloaded file ${file_id} to ${local_path}`);
          resolve();
        })
        .on("error", (err) => {
          core.error(`Error writing downloaded file ${file_id} to ${local_path}: ${err.message}`);
          fs.unlink(local_path, unlinkErr => {
            if (unlinkErr) core.warning(`Failed to clean up partial download ${local_path}: ${unlinkErr.message}`);
            reject(err);
          });
        });
    });
  } catch (error) {
    const err = error as any;
    if (err.code === 404) {
      core.error(`Failed to download file ${file_id}: File not found in Google Drive.`);
    } else if (err.code === 403) {
      core.error(`Failed to download file ${file_id}: Permission denied. Check service account access.`);
    } else {
      core.error(`Failed to download file ${file_id}: ${err.message}`);
    }
    if (err.response?.data) {
      core.error(`API Error Details: ${JSON.stringify(err.response.data)}`);
    }
    throw error;
  }
}

// Exec Git Helper
async function execute_git(command: string, args: string[], options: { ignoreReturnCode?: boolean, silent?: boolean } = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  core.debug(`Executing: git ${command} ${args.join(" ")}`);
  try {
    const result = await getExecOutput("git", [command, ...args], {
      ignoreReturnCode: options.ignoreReturnCode ?? false,
      silent: options.silent ?? false,
    });
    if (!options.ignoreReturnCode && result.exitCode !== 0) {
      core.error(`Git command failed: git ${command} ${args.join(" ")} - Exit Code: ${result.exitCode}`);
      core.error(`stderr: ${result.stderr}`);
      throw new Error(`Git command failed with exit code ${result.exitCode}`);
    }
    core.debug(`Git command finished: git ${command} - Exit Code: ${result.exitCode}`);
    core.debug(`stdout: ${result.stdout}`);
    if (result.stderr && !(options.silent && result.exitCode === 0)) { // Avoid logging stderr on success if silent
      core.debug(`stderr: ${result.stderr}`);
    }
    return result;
  } catch (error: any) {
    core.error(`Error executing git command: git ${command} ${args.join(" ")}`);
    if (error.stderr) core.error(`stderr: ${error.stderr}`);
    if (error.stdout) core.debug(`stdout (on error): ${error.stdout}`);
    throw error;
  }
}

// Create PR with Retry
async function create_pull_request_with_retry(
  octokit: Octokit,
  params: { owner: string; repo: string; title: string; head: string; base: string; body: string },
  max_retries = 3,
  initial_delay = 5000
) {
  let current_delay = initial_delay;
  for (let attempt = 0; attempt < max_retries; attempt++) {
    try {
      const repo_info = await octokit.rest.repos.get({ owner: params.owner, repo: params.repo });
      const base_branch = repo_info.data.default_branch;
      core.info(`Target repository default branch: ${base_branch}`);
      const head_ref = `${params.owner}:${params.head}`; // Use owner:branch format
      core.info(`Attempt ${attempt + 1}: Creating PR: head=${head_ref} base=${base_branch}`);
      await octokit.rest.pulls.create({
        owner: params.owner,
        repo: params.repo,
        title: params.title,
        head: head_ref, // Use explicit format
        base: base_branch, // Use fetched default branch
        body: params.body,
      });
      core.info(`Pull request created successfully! (head: ${head_ref}, base: ${base_branch})`);
      return;
    } catch (error: unknown) {
      const http_error = error as { status?: number; message?: string; response?: { data?: any } };
      core.warning(`PR creation attempt ${attempt + 1} failed.`);
      if (http_error?.status) core.warning(`Status: ${http_error.status}`);
      if (http_error?.message) core.warning(`Message: ${http_error.message}`);
      if (http_error?.response?.data) core.warning(`API Response Data: ${JSON.stringify(http_error.response.data)}`);

      if ((http_error?.status === 404 || http_error?.status === 422) && attempt < max_retries - 1) {
        core.warning(`Retrying in ${current_delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, current_delay));
        current_delay *= 2;
      } else {
        core.error(`Failed to create pull request after ${attempt + 1} attempts.`);
        throw error;
      }
    }
  }
}

// Handle Drive changes with PR creation - UPDATED
async function handle_drive_changes(
  folder_id: string,
  on_untrack_action: "ignore" | "remove" | "request",
  trigger_event_name: string // <-- Added parameter
) {
  core.info(`Handling potential incoming changes from Drive folder: ${folder_id} (Trigger: ${trigger_event_name}, Untrack action: ${on_untrack_action})`);

  // *** 1. Get original state ***
  const run_id = process.env.GITHUB_RUN_ID || Date.now();
  const original_state_branch = `original-state-${folder_id}-${run_id}`;
  const current_branch_result = await execute_git('rev-parse', ['--abbrev-ref', 'HEAD'], { silent: true });
  const initial_branch = current_branch_result.stdout.trim();
  core.info(`Current branch is '${initial_branch}'. Creating temporary state branch '${original_state_branch}'`);
  const initial_commit_hash = (await execute_git('rev-parse', ['HEAD'], { silent: true })).stdout.trim();
  await execute_git("checkout", ["-b", original_state_branch, initial_commit_hash]);

  // *** 2. List local and Drive files ***
  const local_files_list = await list_local_files(".");
  const local_map = new Map(local_files_list.map(f => [f.relative_path.replace(/\\/g, '/'), f]));
  core.info(`Found ${local_map.size} relevant local files in original state.`);
  const local_lower_to_original_key = new Map(Array.from(local_map.keys()).map(key => [key.toLowerCase(), key]));
  core.debug(`Created lowercase lookup map with ${local_lower_to_original_key.size} entries.`);

  let drive_files: Map<string, DriveItem>;
  let drive_folders: Map<string, DriveItem>;
  try {
    core.info("Listing Drive content for incoming change comparison...");
    const drive_data = await list_drive_files_recursively(folder_id);
    drive_files = new Map(Array.from(drive_data.files.entries()).map(([p, item]) => [p.replace(/\\/g, '/'), item]));
    drive_folders = new Map(Array.from(drive_data.folders.entries()).map(([p, item]) => [p.replace(/\\/g, '/'), item]));
    core.info(`Found ${drive_files.size} files and ${drive_folders.size} folders in Drive.`);
  } catch (error) {
    core.error(`Failed list Drive content for folder ${folder_id} during incoming check: ${(error as Error).message}. Aborting.`);
    await execute_git("checkout", [initial_branch]);
    await execute_git("branch", ["-D", original_state_branch]);
    return;
  }

  const new_files: { path: string; id: string }[] = [];
  const modified_files: { path: string; id: string; local_hash: string; drive_hash?: string }[] = [];
  const deleted_files: string[] = [];
  const found_local_keys = new Set<string>();

  // *** 3. Compare Drive state to local state (Case-Insensitive Lookup) ***
  for (const [drive_path, drive_item] of drive_files) {
    const drive_path_lower = drive_path.toLowerCase();
    const original_local_key = local_lower_to_original_key.get(drive_path_lower);
    const local_file = original_local_key ? local_map.get(original_local_key) : undefined;
    core.debug(`Comparing Drive path: '${drive_path}', Lowercase: '${drive_path_lower}'`);
    if (!local_file || !original_local_key) {
      core.debug(`   Local file NOT FOUND for Drive path: '${drive_path}'`);
      core.info(`New file detected in Drive: ${drive_path} (ID: ${drive_item.id})`);
      new_files.push({ path: drive_path, id: drive_item.id });
    } else {
      core.debug(`   Found matching local key (case-insensitive): '${original_local_key}'`);
      found_local_keys.add(original_local_key);
      if (drive_item.hash && local_file.hash !== drive_item.hash) {
        core.info(`Modified file detected in Drive (hash mismatch): ${drive_path}`);
        core.info(` -> Local hash: ${local_file.hash}, Drive hash: ${drive_item.hash}`);
        modified_files.push({ path: drive_path, id: drive_item.id, local_hash: local_file.hash, drive_hash: drive_item.hash });
      } else if (!drive_item.hash && drive_item.mimeType && !drive_item.mimeType.startsWith('application/vnd.google-apps')) {
        core.warning(`Drive file ${drive_path} exists locally but has no md5Checksum. Cannot verify modification. Skipping update from Drive.`);
      } else { core.debug(`File '${drive_path}' found locally and hashes match or is Google Doc. No modification needed.`); }
    }
  }

  // *** 4. Identify files deleted in Drive ***
  core.debug("Checking for files deleted in Drive...");
  for (const [local_key, _local_file_info] of local_map) {
    if (!found_local_keys.has(local_key)) {
      core.info(`File deleted in Drive detected (was in local state, not found in Drive): ${local_key}`);
      deleted_files.push(local_key);
    }
  }
  core.debug(`Identified ${deleted_files.length} files potentially deleted in Drive.`);

  // *** 5. Apply changes locally and stage them ***
  let changes_staged = false;
  let files_actually_removed: string[] = []; // Track files actually removed for commit msg

  // --- Handle New Files ---
  core.debug(`Applying changes: ${new_files.length} new, ${modified_files.length} modified, ${deleted_files.length} potentially deleted.`);
  for (const { path: file_path, id } of new_files) {
    try { core.info(`Downloading new file from Drive: ${file_path} (ID: ${id})`); await download_file(id, file_path); await execute_git("add", [file_path]); changes_staged = true; }
    catch (error) { core.error(`Failed to download or stage new file ${file_path}: ${(error as Error).message}`); }
  }
  // --- Handle Modified Files ---
  for (const { path: file_path, id } of modified_files) {
    try { core.info(`Downloading modified file from Drive: ${file_path} (ID: ${id})`); await download_file(id, file_path); await execute_git("add", [file_path]); changes_staged = true; }
    catch (error) { core.error(`Failed to download or stage modified file ${file_path}: ${(error as Error).message}`); }
  }

  // --- Handle Deleted Files (CONDITIONAL based on TRIGGER and CONFIG) ---
  if (trigger_event_name === 'push') {
    // On push, NEVER remove local files just because they aren't in Drive yet.
    if (deleted_files.length > 0) {
      core.info(`Found ${deleted_files.length} file(s) present locally but not in Drive. Skipping removal from Git because trigger was 'push'.`);
      deleted_files.forEach(fp => core.info(`  - Skipped removal (push event): ${fp}`));
    }
  } else { // trigger_event_name is 'schedule', 'workflow_dispatch', etc.
    // For schedule/manual triggers, respect the on_untrack setting
    if (on_untrack_action === 'remove') {
      core.info(`Processing ${deleted_files.length} files potentially deleted in Drive (trigger: ${trigger_event_name}, on_untrack: 'remove').`);
      for (const file_path of deleted_files) {
        try {
          core.info(`Removing local file deleted in Drive: ${file_path}`);
          await execute_git("rm", ["--ignore-unmatch", file_path]);
          changes_staged = true;
          files_actually_removed.push(file_path);
        } catch (error) {
          core.error(`Failed to stage deletion of ${file_path}: ${(error as Error).message}`);
        }
      }
    } else {
      // Log if files were detected as deleted but action is not 'remove' on schedule/manual
      if (deleted_files.length > 0) {
        core.info(`Found ${deleted_files.length} file(s) present locally but not in Drive. Skipping removal from Git because 'on_untrack' is '${on_untrack_action}' (trigger: ${trigger_event_name}).`);
        deleted_files.forEach(fp => core.info(`  - Skipped removal (config): ${fp}`));
      }
    }
  }

  // *** 6. Commit, Push, and Create PR if changes were staged ***
  if (changes_staged) {
    const status_result = await execute_git('status', ['--porcelain']);
    if (!status_result.stdout.trim()) {
      core.info("Git status clean after applying changes. No commit needed for incoming changes.");
      changes_staged = false;
    }
  }

  if (changes_staged) {
    core.info("Changes detected originating from Drive. Proceeding with commit and PR.");
    const commit_messages: string[] = ["Sync changes from Google Drive"];
    if (new_files.length > 0) commit_messages.push(`- Added: ${new_files.map(f => f.path).join(", ")}`);
    if (modified_files.length > 0) commit_messages.push(`- Updated: ${modified_files.map(f => f.path).join(", ")}`);
    if (files_actually_removed.length > 0) commit_messages.push(`- Removed: ${files_actually_removed.join(", ")}`);
    commit_messages.push(`\nSource Drive Folder ID: ${folder_id}`);

    try {
      await execute_git("config", ["--local", "user.email", "github-actions[bot]@users.noreply.github.com"]);
      await execute_git("config", ["--local", "user.name", "github-actions[bot]"]);
      await execute_git("commit", ["-m", commit_messages.join("\n")]);
      const sanitized_folder_id = folder_id.replace(/[^a-zA-Z0-9_-]/g, '_');
      const head_branch = `sync-from-drive-${sanitized_folder_id}-${run_id}`;
      core.info(`Creating PR branch: ${head_branch}`);
      await execute_git("checkout", ["-b", head_branch]);
      core.info(`Pushing branch ${head_branch} to origin...`);
      await execute_git("push", ["--force", "origin", head_branch]);

      const [owner, repo] = process.env.GITHUB_REPOSITORY!.split("/");
      const pr_title = `Sync changes from Google Drive (${folder_id})`;
      const pr_body = `This PR syncs changes detected in Google Drive folder [${folder_id}](https://drive.google.com/drive/folders/${folder_id}):\n` +
        (new_files.length > 0 ? `*   **Added:** ${new_files.map(f => `\`${f.path}\``).join(", ")}\n` : "") +
        (modified_files.length > 0 ? `*   **Updated:** ${modified_files.map(f => `\`${f.path}\``).join(", ")}\n` : "") +
        (files_actually_removed.length > 0 ? `*   **Removed:** ${files_actually_removed.map(f => `\`${f}\``).join(", ")}\n` : "") + // Use actual removed files
        `\n*Workflow Run ID: ${run_id}*`;

      const pr_params = { owner, repo, title: pr_title, head: head_branch, base: initial_branch, body: pr_body };
      await create_pull_request_with_retry(octokit, pr_params);
      core.info(`Pull request creation initiated for branch ${head_branch}.`);

    } catch (error) {
      core.setFailed(`Failed during commit, push, or PR creation for Drive changes: ${(error as Error).message}`);
    }
  } else {
    core.info("No effective changes detected originating from Drive to ADD, UPDATE, or REMOVE (based on config/trigger). No PR needed.");
  }

  // *** 7. Cleanup: Go back to the original branch and delete the temporary state branch ***
  core.info(`Cleaning up temporary branches. Checking out initial branch '${initial_branch}'`);
  try {
    await execute_git("checkout", [initial_branch]);
    core.info(`Deleting temporary state branch '${original_state_branch}'`);
    await execute_git("branch", ["-D", original_state_branch]);
  } catch (checkoutError) {
    core.warning(`Failed to checkout initial branch '${initial_branch}' or delete temp branch '${original_state_branch}'. Manual cleanup may be needed. Error: ${(checkoutError as Error).message}`);
    try {
      core.warning("Attempting checkout of 'main'");
      await execute_git("checkout", ["main"]);
      core.info(`Deleting temporary state branch '${original_state_branch}'`);
      await execute_git("branch", ["-D", original_state_branch], { ignoreReturnCode: true });
    } catch (mainCheckoutError) {
      core.error("Could not checkout 'main' either. Workspace might be in an inconsistent state.");
    }
  }
}

// *** Main sync function *** - UPDATED
async function sync_to_drive() {
  const [owner, repo] = process.env.GITHUB_REPOSITORY!.split("/");
  core.info(`Syncing repository: ${owner}/${repo}`);
  core.info(`Triggered by event: ${trigger_event_name}`); // Log the trigger

  // Initial local file listing (still useful)
  const initial_local_files = await list_local_files(".");
  if (initial_local_files.length === 0) { core.warning("No relevant local files found to sync based on ignore rules."); }
  else { core.info(`Found ${initial_local_files.length} initial local files for potential sync.`); }

  for (const target of config.targets.forks) {
    const folder_id = target.drive_folder_id;
    const on_untrack_action = target.on_untrack || "ignore";
    core.startGroup(`Processing Target Drive Folder: ${folder_id} (Untrack Action: ${on_untrack_action})`);
    core.info(`Drive URL: ${target.drive_url || `https://drive.google.com/drive/folders/${folder_id}`}`);

    try {
      // *** STEP 1: Sync Outgoing Changes (Local -> Drive) FIRST ***
      core.info("Step 1: Processing outgoing changes (local -> Drive)...");
      const current_local_files = await list_local_files(".");
      const current_local_map = new Map(current_local_files.map(f => [f.relative_path.replace(/\\/g, '/'), f]));
      core.info(`Found ${current_local_map.size} local files for outgoing sync.`);
      core.info("Listing Drive content for outgoing sync comparison...");
      let drive_files_map_outgoing: Map<string, DriveItem>;
      let drive_folders_map_outgoing: Map<string, DriveItem>;
      try { /* List Drive files/folders */
        const drive_data_outgoing = await list_drive_files_recursively(folder_id);
        drive_files_map_outgoing = new Map(Array.from(drive_data_outgoing.files.entries()).map(([p, item]) => [p.replace(/\\/g, '/'), item]));
        drive_folders_map_outgoing = new Map(Array.from(drive_data_outgoing.folders.entries()).map(([p, item]) => [p.replace(/\\/g, '/'), item]));
        core.info(`Found ${drive_files_map_outgoing.size} files and ${drive_folders_map_outgoing.size} folders in Drive.`);
      } catch (listError) { /* Handle error */
        core.error(`Failed list Drive content before outgoing sync: ${(listError as Error).message}. Skipping outgoing sync.`);
        drive_files_map_outgoing = new Map(); drive_folders_map_outgoing = new Map();
      }
      core.info("Ensuring Drive folder structure matches local structure...");
      let folder_path_to_id_map: Map<string, string>;
      if (current_local_map.size > 0 && drive_folders_map_outgoing) { /* Build structure */
        try { folder_path_to_id_map = await build_folder_structure(folder_id, current_local_files, drive_folders_map_outgoing); }
        catch (structureError) { core.error(`Failed build Drive folder structure: ${(structureError as Error).message}. Skipping upload/update.`); folder_path_to_id_map = new Map(); }
      } else { /* Handle no local files or failed list */
        folder_path_to_id_map = new Map(); folder_path_to_id_map.set("", folder_id); core.info("Skipping folder structure build (no local files or Drive folder listing failed).");
      }
      core.info("Uploading/updating files from local to Drive...");
      const files_synced_to_drive = new Set<string>();
      if (folder_path_to_id_map.size > 0) { /* Upload/Update loop */
        for (const [relative_path, local_file] of current_local_map) {
          files_synced_to_drive.add(relative_path);
          const drive_file = drive_files_map_outgoing.get(relative_path);
          const file_name = path.basename(relative_path);
          const dir_path = path.dirname(relative_path);
          const parent_dir_lookup = (dir_path === '.') ? "" : dir_path.replace(/\\/g, '/');
          const target_folder_id = folder_path_to_id_map.get(parent_dir_lookup);
          if (!target_folder_id) { core.warning(`Could not find target folder ID for local file '${relative_path}'. Skipping upload.`); continue; }
          // --- Upload/Update Logic ---
          if (!drive_file) { await upload_file(local_file.path, target_folder_id); }
          else { /* Update logic */
            if (drive_file.hash && drive_file.hash !== local_file.hash) { await upload_file(local_file.path, target_folder_id, { id: drive_file.id, name: file_name }); }
            else if (!drive_file.hash && drive_file.mimeType && !drive_file.mimeType.startsWith('application/vnd.google-apps')) { await upload_file(local_file.path, target_folder_id, { id: drive_file.id, name: file_name }); }
            const hashes_match_or_drive_missing = !drive_file.hash || (local_file.hash === drive_file.hash);
            if (drive_file.name !== file_name && hashes_match_or_drive_missing) { try { await drive.files.update({ fileId: drive_file.id, requestBody: { name: file_name } }); } catch (renameError) { core.warning(`Failed rename file ${drive_file.id}: ${(renameError as Error).message}`); } }
          }
        }
      } else { core.info("Skipping upload/update phase due to issues in previous steps."); }

      // *** STEP 2: Handle Untracked Files/Folders in Drive ***
      core.info("Step 2: Handling untracked items in Drive...");
      const untracked_drive_files = Array.from(drive_files_map_outgoing.entries()).filter(([p]) => !files_synced_to_drive.has(p));
      const untracked_drive_folders = Array.from(drive_folders_map_outgoing.entries()).filter(([p]) => !Array.from(files_synced_to_drive).some(lp => lp.startsWith(p + '/')));
      core.info(`Found ${untracked_drive_files.length} untracked files and ${untracked_drive_folders.length} potentially untracked folders.`);
      const all_untracked_items = [ /* Combine files and folders */ ...untracked_drive_files.map(([p, i]) => ({ path: p, item: i, isFolder: false })), ...untracked_drive_folders.map(([p, i]) => ({ path: p, item: i, isFolder: true }))];
      if (all_untracked_items.length > 0) { /* Untracked logic */
        if (on_untrack_action === "ignore") { core.info(`Ignoring ${all_untracked_items.length} untracked item(s) in Drive as per config.`); }
        else { /* Process remove/request */
          for (const { path: untracked_path, item: untracked_item, isFolder } of all_untracked_items) {
            core.info(`Processing untracked ${isFolder ? 'folder' : 'file'} in Drive: ${untracked_path} (ID: ${untracked_item.id})`);
            if (!untracked_item.owned) { /* Handle not owned */
              const current_owner = untracked_item.permissions?.find(p => p.role === 'owner')?.emailAddress;
              if (current_owner && current_owner !== credentials_json.client_email) { await request_ownership_transfer(untracked_item.id, current_owner); continue; }
              else { /* Unclear owner */
                const ownerEmails = untracked_item.permissions?.filter(p => p.role === 'owner').map(p => p.emailAddress || 'Unknown').join(',') || 'None';
                core.warning(`Untracked '${untracked_path}' has unclear ownership (Owners: ${ownerEmails}).`);
                if (on_untrack_action === 'remove') { core.warning(`Skipping removal '${untracked_path}' due to unclear ownership.`); continue; }
              }
            } else { /* Handle owned */
              core.info(`Untracked item '${untracked_path}' is owned by the service account.`);
              if (on_untrack_action === "remove") { await delete_untracked(untracked_item.id, untracked_path, isFolder); }
              else if (on_untrack_action === "request") { core.info(`Untracked '${untracked_path}' already owned. No action needed.`); }
            }
          }
        }
      } else { core.info("No untracked items found in Drive for this target."); }

      // *** STEP 3: Accept Pending Ownership Transfers ***
      core.info("Step 3: Checking for and accepting pending ownership transfers...");
      await accept_ownership_transfers(folder_id);

      // *** STEP 4: Handle Incoming Changes from Drive (Drive -> Local PR) ***
      core.info("Step 4: Handling potential incoming changes from Drive (Drive -> Local PR)...");
      // Pass the trigger event name and on_untrack config down
      await handle_drive_changes(folder_id, on_untrack_action, trigger_event_name);

    } catch (error) {
      core.error(`Unhandled error during sync process for Drive folder ${folder_id}: ${(error as Error).message}`);
      // core.setFailed(`Sync failed for folder ${folder_id}`);
    } finally {
      core.setOutput(`drive_link_${folder_id}`, `https://drive.google.com/drive/folders/${folder_id}`);
      core.info(`Sync process finished for Drive folder: ${folder_id}`);
      core.endGroup();
    }
  }
  core.info("All sync targets processed.");
}

// Run the action
sync_to_drive().catch((error: unknown) => {
  const err = error as Error;
  core.error(`Top-level error caught: ${err.message}`);
  core.error(err.stack || "No stack trace available.");
  core.setFailed(`Sync failed: ${err.message}`);
});
