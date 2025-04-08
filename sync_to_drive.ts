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
        if (!line.includes('*') && !line.includes('?')) return line + '/**'; // Treat plain file/dir names as potential dirs
        return line;
      });
      ignore_patterns = ignore_patterns.concat(glob_patterns);
      core.info(`Added patterns from .gitignore: ${glob_patterns.join(', ')}`);
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


// ... (accept_ownership_transfers remains the same) ...
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


// ... (list_drive_files_recursively remains the same) ...
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
  let all_items: DriveFile[] = []; // Renamed for clarity
  let next_page_token: string | undefined;

  core.info(`Listing items in Drive folder ID: ${folder_id} (relative path: '${base_path || '/'}')`);

  try {
    do {
      const res = await drive.files.list({
        // Use corpus=user and includeItemsFromAllDrives=true if dealing with Shared Drives
        // driveId: 'YOUR_SHARED_DRIVE_ID', // Required if folder_id is in a Shared Drive
        // corpora: 'drive', // Specify the corpus if using driveId
        // includeItemsFromAllDrives: true, // Required if using driveId
        // supportsAllDrives: true, // Required if using driveId
        q: `'${folder_id}' in parents and trashed = false`, // Ensure we only list non-trashed items
        fields: "nextPageToken, files(id, name, mimeType, md5Checksum, owners(emailAddress))",
        spaces: "drive", // Keep this if not using Shared Drives specifically
        pageToken: next_page_token,
        pageSize: 1000, // Max page size
      }) as { data: DriveFilesListResponse };

      all_items = all_items.concat(res.data.files || []);
      next_page_token = res.data.nextPageToken;
      core.debug(`Fetched page of items from folder ${folder_id}. Next page token: ${next_page_token ? 'yes' : 'no'}`);
    } while (next_page_token);
  } catch (error) {
    core.error(`Failed to list files in Drive folder ${folder_id}: ${(error as Error).message}`);
    // Depending on the error, you might want to throw or return empty maps
    throw error; // Re-throw for now
  }


  core.info(`Processing ${all_items.length} items found in folder ID: ${folder_id}`);
  const service_account_email = credentials_json.client_email;

  for (const item of all_items) {
    if (!item.name || !item.id) {
      core.warning(`Skipping item with missing name or ID in folder ${folder_id}. Data: ${JSON.stringify(item)}`);
      continue;
    }
    // Normalize path separators, especially if running on Windows vs Linux
    const relative_path = base_path ? path.join(base_path, item.name).replace(/\\/g, '/') : item.name.replace(/\\/g, '/');
    const owned = item.owners?.some(owner => owner.emailAddress === service_account_email) || false;

    // Fetch permissions only if needed later (e.g., for ownership transfer or deletion checks)
    // Deferring this can save API calls if ownership isn't immediately required.
    // For simplicity here, we fetch them now. Consider optimizing if API limits are hit.
    let permissions: DrivePermission[] = [];
    try {
      const perm_res = await drive.permissions.list({
        fileId: item.id,
        fields: "permissions(id, role, emailAddress, pendingOwner)",
      }) as { data: DrivePermissionsListResponse };
      permissions = perm_res.data.permissions || [];
    } catch (permError) {
      core.warning(`Could not list permissions for item ${item.id} ('${item.name}'): ${(permError as Error).message}`);
      // Decide how to handle this - maybe assume not owned if permissions can't be read?
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
        // Merge results from subfolder
        subfolder_data.files.forEach((value, key) => file_map.set(key, value));
        subfolder_data.folders.forEach((value, key) => folder_map.set(key, value));
      } catch (recursiveError) {
        core.error(`Error processing subfolder ${item.id} ('${item.name}'): ${(recursiveError as Error).message}. Skipping subtree.`);
        // Continue with other items in the current folder
      }
    } else {
      // It's a file
      // core.debug(`Found file: '${relative_path}' (ID: ${item.id}), Hash: ${item.md5Checksum || 'N/A'}`);
      // md5Checksum is not always present for Google Docs types. Hash comparison might fail.
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

// Ensure folder (reuse existing if possible)
async function ensure_folder(parent_id: string, folder_name: string): Promise<string> {
  core.info(`Ensuring folder '${folder_name}' under parent '${parent_id}'`);
  try {
    let all_files: DriveFile[] = [];
    let next_page_token: string | undefined;
    const query = `'${parent_id}' in parents and mimeType = 'application/vnd.google-apps.folder' and name = '${folder_name.replace(/'/g, "\\'")}' and trashed = false`;
    core.debug(`Querying for existing folder: ${query}`);

    // More efficient query to find the specific folder
    const res = await drive.files.list({
      q: query,
      fields: "files(id, name)", // Only need ID and name
      spaces: "drive",
      pageSize: 1, // We only expect one or zero results
      // Add shared drive parameters if necessary
      // includeItemsFromAllDrives: true,
      // supportsAllDrives: true,
      // corpora: 'allDrives', // or 'drive' if parent_id is in a specific shared drive
      // driveId: 'YOUR_SHARED_DRIVE_ID' // if applicable
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
      // Add shared drive parameters if necessary
      // supportsAllDrives: true,
    });
    if (!folder.data.id) {
      throw new Error(`Folder creation API call did not return an ID for '${folder_name}'.`);
    }
    core.info(`Created folder '${folder_name}' with ID: ${folder.data.id}`);
    return folder.data.id;
  } catch (error: unknown) {
    const err = error as any;
    core.error(`Failed to ensure folder '${folder_name}' under '${parent_id}': ${err.message}`);
    // Log more details for debugging API errors
    if (err.response?.data) {
      core.error(`API Error Details: ${JSON.stringify(err.response.data)}`);
    }
    throw err; // Re-throw to stop the process for this target
  }
}

// ... (build_folder_structure remains the same) ...
async function build_folder_structure(
  root_folder_id: string,
  local_files: FileInfo[],
  existing_folders: Map<string, DriveItem> // Pass existing folders found recursively
): Promise<Map<string, string>> {
  const folder_map = new Map<string, string>(); // Map<relative_path, folder_id>
  folder_map.set("", root_folder_id); // Root maps to the starting folder ID

  // Create a set of all unique directory paths required by local files
  const required_dir_paths = new Set<string>();
  for (const file of local_files) {
    // Get directory part of the relative path
    const dir = path.dirname(file.relative_path);
    if (dir && dir !== '.') { // Ignore root directory '.'
      // Add the directory and all its parent paths
      const parts = dir.split(path.sep);
      let current_cumulative_path = "";
      for (const part of parts) {
        current_cumulative_path = current_cumulative_path ? path.join(current_cumulative_path, part) : part;
        // Normalize path separators for consistency
        required_dir_paths.add(current_cumulative_path.replace(/\\/g, '/'));
      }
    }
  }

  // Sort paths to ensure parent directories are processed before children
  const sorted_paths = Array.from(required_dir_paths).sort();
  core.info(`Required folder paths based on local files: ${sorted_paths.join(', ')}`);


  for (const folder_path of sorted_paths) {
    if (folder_map.has(folder_path)) {
      core.debug(`Folder path '${folder_path}' already processed.`);
      continue; // Already created or found
    }

    const parts = folder_path.split('/'); // Use normalized separator
    const folder_name = parts[parts.length - 1];
    const parent_path = parts.slice(0, -1).join('/');
    const parent_folder_id = folder_map.get(parent_path);

    if (!parent_folder_id) {
      // This should not happen if paths are sorted correctly, but handle defensively
      core.error(`Cannot find parent folder ID for path '${folder_path}' (parent path '${parent_path}' missing from map). Skipping.`);
      continue;
    }

    // Check if this folder already exists from the initial recursive scan
    const existing_drive_folder = existing_folders.get(folder_path);
    let current_folder_id: string;

    if (existing_drive_folder?.id) {
      core.info(`Using existing Drive folder '${folder_path}' with ID: ${existing_drive_folder.id}`);
      current_folder_id = existing_drive_folder.id;
    } else {
      // Folder doesn't exist in Drive yet, create it
      core.info(`Creating missing folder '${folder_name}' under parent ID ${parent_folder_id} (for path '${folder_path}')`);
      try {
        current_folder_id = await ensure_folder(parent_folder_id, folder_name);
      } catch (error) {
        core.error(`Failed to create folder structure at '${folder_path}'. Stopping structure build for this target.`);
        // Propagate the error or handle it based on desired robustness
        throw error;
      }
    }
    folder_map.set(folder_path, current_folder_id);
  }

  core.info(`Built/Verified folder structure. Path-to-ID map size: ${folder_map.size}`);
  return folder_map;
}

// ... (upload_file remains the same) ...
async function upload_file(file_path: string, folder_id: string, existing_file?: { id: string; name: string }): Promise<{ id: string; success: boolean }> {
  const file_name = path.basename(file_path);
  const media = { body: fs.createReadStream(file_path) };
  let fileId = existing_file?.id; // Initialize with existing ID if available

  try {
    if (existing_file?.id) {
      // Check if name needs updating (case changes, etc.)
      const requestBody: { name?: string; mimeType?: string } = {}; // Define type for requestBody
      if (existing_file.name !== file_name) {
        requestBody.name = file_name;
        core.info(`Updating file name for '${existing_file.name}' to '${file_name}' (ID: ${existing_file.id})`);
      }
      // Add mimeType if needed, but usually not required for update
      // requestBody.mimeType = mime.getType(file_path) || 'application/octet-stream';

      core.info(`Updating existing file content '${file_name}' (ID: ${existing_file.id}) in folder ${folder_id}`);
      const res = await drive.files.update({
        fileId: existing_file.id,
        media: media,
        requestBody: Object.keys(requestBody).length > 0 ? requestBody : undefined, // Only send requestBody if name changed
        fields: "id, name, md5Checksum", // Get updated info
        // Add shared drive parameters if necessary
        // supportsAllDrives: true,
      });
      fileId = res.data.id!; // Use the returned ID
      core.info(`Updated file '${res.data.name}' (ID: ${fileId}). New hash: ${res.data.md5Checksum || 'N/A'}`);
    } else {
      core.info(`Creating new file '${file_name}' in folder ${folder_id}`);
      const res = await drive.files.create({
        requestBody: {
          name: file_name,
          parents: [folder_id]
          // mimeType: mime.getType(file_path) || 'application/octet-stream', // Set explicit MIME type
        },
        media: media,
        fields: "id, name, md5Checksum", // Get info of created file
        // Add shared drive parameters if necessary
        // supportsAllDrives: true,
      });
      if (!res.data.id) {
        throw new Error(`File creation API call did not return an ID for '${file_name}'.`);
      }
      fileId = res.data.id; // Use the returned ID
      core.info(`Uploaded file '${res.data.name}' (ID: ${fileId}). Hash: ${res.data.md5Checksum || 'N/A'}`);
    }
    return { id: fileId!, success: true };
  } catch (error: unknown) {
    const err = error as any;
    core.warning(`Failed to process '${file_name}' in folder ${folder_id}: ${err.message}`);
    if (err.response?.data) {
      core.warning(`API Error Details: ${JSON.stringify(err.response.data)}`);
    }
    // Return failure status but include ID if it was known (e.g., during update failure)
    return { id: fileId || '', success: false };
  }
}


// ... (delete_untracked remains the same) ...
async function delete_untracked(id: string, name: string, is_folder: boolean = false): Promise<boolean> {
  core.info(`Attempting to move ${is_folder ? "folder" : "file"} to Trash: '${name}' (ID: ${id})`);
  try {
    await drive.files.update({
      fileId: id,
      requestBody: { trashed: true },
      // Add shared drive parameters if necessary
      // supportsAllDrives: true,
    });
    core.info(`Moved untracked ${is_folder ? "folder" : "file"} to Trash: ${name}`);
    return true;
  } catch (error: unknown) {
    const err = error as any;
    // Check for specific errors like insufficient permissions
    if (err.code === 403) {
      core.error(`Permission denied trying to trash ${is_folder ? "folder" : "file"} '${name}' (ID: ${id}). Check service account permissions.`);
    } else if (err.code === 404) {
      core.warning(`Untracked ${is_folder ? "folder" : "file"} '${name}' (ID: ${id}) not found, possibly already deleted.`);
      return true; // Treat as success if already gone
    } else {
      core.warning(`Failed to trash untracked ${is_folder ? "folder" : "file"} '${name}' (ID: ${id}): ${err.message}`);
    }
    if (err.response?.data) {
      core.warning(`API Error Details: ${JSON.stringify(err.response.data)}`);
    }
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
      transferOwnership: true, // This is key
      sendNotificationEmail: true, // Notify the current owner
      emailMessage: `Automated Sync: Please approve ownership transfer of this item to the sync service (${service_account_email}) for management. Item ID: ${file_id}`,
      // Add shared drive parameters if necessary
      // supportsAllDrives: true,
    });
    // The response here confirms the *request* was made, not that it was accepted.
    // The 'pendingOwner' field will be true on the permission until accepted.
    core.info(`Ownership transfer request sent for item ${file_id}. Response: ${JSON.stringify(response.data)}`);
    ownership_transfer_requested_ids.add(file_id); // Track that we requested it
  } catch (error: unknown) {
    const err = error as any;
    // Handle specific errors
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

// ... (download_file remains the same) ...
async function download_file(file_id: string, local_path: string): Promise<void> {
  core.info(`Downloading Drive file ID ${file_id} to local path ${local_path}`);
  try {
    const dir = path.dirname(local_path);
    // Ensure directory exists
    await fs_promises.mkdir(dir, { recursive: true });

    // Use drive.files.get with alt: 'media'
    const res = await drive.files.get(
      { fileId: file_id, alt: "media" /*, supportsAllDrives: true // if needed */ },
      { responseType: "stream" } // Crucial for downloading file content
    );

    const writer = fs.createWriteStream(local_path);

    // Pipe the download stream to the file writer
    return new Promise((resolve, reject) => {
      res.data
        .pipe(writer)
        .on("finish", () => {
          core.info(`Successfully downloaded file ${file_id} to ${local_path}`);
          resolve();
        })
        .on("error", (err) => {
          core.error(`Error writing downloaded file ${file_id} to ${local_path}: ${err.message}`);
          // Attempt to clean up partially downloaded file
          fs.unlink(local_path, unlinkErr => {
            if (unlinkErr) core.warning(`Failed to clean up partial download ${local_path}: ${unlinkErr.message}`);
            reject(err); // Reject with the original download error
          });
        });
    });
  } catch (error) {
    const err = error as any;
    // Handle specific errors like 404 Not Found or 403 Forbidden
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
    throw error; // Re-throw the error to signal failure
  }
}


// ... (execGit remains the same) ...
async function execGit(command: string, args: string[], options: { ignoreReturnCode?: boolean, silent?: boolean } = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  core.debug(`Executing: git ${command} ${args.join(" ")}`);
  try {
    // Use getExecOutput to capture stdout/stderr and control error handling
    const result = await getExecOutput("git", [command, ...args], {
      ignoreReturnCode: options.ignoreReturnCode ?? false, // Default to false (throw on error)
      silent: options.silent ?? false, // Default to false (show output)
      // Consider adding CWD if not always running from workspace root
      // cwd: process.cwd()
    });

    if (!options.ignoreReturnCode && result.exitCode !== 0) {
      // Should be caught by getExecOutput unless ignoreReturnCode=true, but double-check
      core.error(`Git command failed: git ${command} ${args.join(" ")} - Exit Code: ${result.exitCode}`);
      core.error(`stderr: ${result.stderr}`);
      throw new Error(`Git command failed with exit code ${result.exitCode}`);
    }
    core.debug(`Git command finished: git ${command} - Exit Code: ${result.exitCode}`);
    core.debug(`stdout: ${result.stdout}`);
    if (result.stderr) {
      core.debug(`stderr: ${result.stderr}`);
    }

    return result; // Return the full result object

  } catch (error: any) {
    // getExecOutput throws on non-zero exit code if ignoreReturnCode is false
    core.error(`Error executing git command: git ${command} ${args.join(" ")}`);
    if (error.stderr) {
      core.error(`stderr: ${error.stderr}`);
    }
    if (error.stdout) {
      core.debug(`stdout (on error): ${error.stdout}`);
    }
    // Re-throw the original error which includes details
    throw error;
  }
}


async function create_pull_request_with_retry(
  octokit: Octokit,
  params: { owner: string; repo: string; title: string; head: string; base: string; body: string },
  max_retries = 3,
  initial_delay = 5000 // *** Increased initial delay to 5 seconds ***
) {
  let current_delay = initial_delay;
  for (let attempt = 0; attempt < max_retries; attempt++) {
    try {
      // Fetch repository info inside the loop remains a good practice
      const repo_info = await octokit.rest.repos.get({
        owner: params.owner,
        repo: params.repo,
      });
      const base_branch = repo_info.data.default_branch; // Use default as base
      core.info(`Target repository default branch: ${base_branch}`);

      // *** Use explicit owner:branch format for head ***
      const head_ref = `${params.owner}:${params.head}`;
      core.info(`Attempt ${attempt + 1}: Creating PR: head=${head_ref} base=${base_branch}`);

      await octokit.rest.pulls.create({
        owner: params.owner,
        repo: params.repo,
        title: params.title,
        head: head_ref, // Explicit format
        base: base_branch, // Use fetched default branch
        body: params.body,
      });
      core.info(`Pull request created successfully! (head: ${head_ref}, base: ${base_branch})`);
      return; // Success
    } catch (error: unknown) {
      const http_error = error as { status?: number; message?: string; response?: { data?: any } };
      core.warning(`PR creation attempt ${attempt + 1} failed.`);
      if (http_error?.status) {
        core.warning(`Status: ${http_error.status}`);
      }
      if (http_error?.message) {
        core.warning(`Message: ${http_error.message}`);
      }
      if (http_error?.response?.data) {
        core.warning(`API Response Data: ${JSON.stringify(http_error.response.data)}`);
      }


      // Retry on 404 (branch propagation) or 422 (validation, maybe temporary)
      if ((http_error?.status === 404 || http_error?.status === 422) && attempt < max_retries - 1) {
        core.warning(`Retrying in ${current_delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, current_delay));
        current_delay *= 2; // Exponential backoff
      } else {
        core.error(`Failed to create pull request after ${attempt + 1} attempts.`);
        // Throw the last error encountered
        throw error;
      }
    }
  }
}

// Handle Drive changes with PR creation
async function handle_drive_changes(folder_id: string) {
  core.info(`Handling potential incoming changes from Drive folder: ${folder_id}`);

  // *** 1. Create a temporary branch to store the original state ***
  // Ensure GITHUB_RUN_ID is available, fallback if needed (though usually present)
  const run_id = process.env.GITHUB_RUN_ID || Date.now();
  const original_state_branch = `original-state-${folder_id}-${run_id}`;
  const current_branch_result = await execGit('rev-parse', ['--abbrev-ref', 'HEAD'], { silent: true });
  const initial_branch = current_branch_result.stdout.trim();
  core.info(`Current branch is '${initial_branch}'. Creating temporary state branch '${original_state_branch}'`);
  await execGit("checkout", ["-b", original_state_branch]);

  // *** 2. List local and Drive files ***
  // Use forward slashes for path consistency internally
  const local_files_list = await list_local_files(".");
  const local_map = new Map(local_files_list.map(f => [f.relative_path.replace(/\\/g, '/'), f]));
  core.info(`Found ${local_map.size} relevant local files.`);

  let drive_files: Map<string, DriveItem>;
  let drive_folders: Map<string, DriveItem>; // Keep track of folders too

  try {
    const drive_data = await list_drive_files_recursively(folder_id);
    // Normalize Drive paths to use forward slashes
    drive_files = new Map(Array.from(drive_data.files.entries()).map(([p, item]) => [p.replace(/\\/g, '/'), item]));
    drive_folders = new Map(Array.from(drive_data.folders.entries()).map(([p, item]) => [p.replace(/\\/g, '/'), item]));
    core.info(`Found ${drive_files.size} files and ${drive_folders.size} folders in Drive.`);
  } catch (error) {
    core.error(`Failed to list Drive content for folder ${folder_id}: ${(error as Error).message}. Aborting Drive change handling for this target.`);
    // Clean up temporary branch before returning
    await execGit("checkout", [initial_branch]);
    await execGit("branch", ["-D", original_state_branch]);
    return; // Stop processing for this target
  }

  const new_files: { path: string; id: string }[] = [];
  const modified_files: { path: string; id: string; local_hash: string; drive_hash?: string }[] = [];
  const deleted_files: string[] = []; // Store relative paths of files deleted in Drive

  // *** 3. Compare Drive state to local state ***
  for (const [drive_path, drive_item] of drive_files) {
    const local_file = local_map.get(drive_path);

    if (!local_file) {
      // File exists in Drive, not locally (and not ignored locally) -> New file FROM Drive
      core.info(`New file detected in Drive: ${drive_path} (ID: ${drive_item.id})`);
      new_files.push({ path: drive_path, id: drive_item.id });
    } else {
      // File exists in both places. Compare hashes.
      // Handle potential missing md5Checksum for Google Docs
      if (drive_item.hash && local_file.hash !== drive_item.hash) {
        core.info(`Modified file detected in Drive (hash mismatch): ${drive_path}`);
        core.info(` -> Local hash: ${local_file.hash}, Drive hash: ${drive_item.hash}`);
        modified_files.push({ path: drive_path, id: drive_item.id, local_hash: local_file.hash, drive_hash: drive_item.hash });
      } else if (!drive_item.hash && !drive_item.mimeType?.startsWith('application/vnd.google-apps')) {
        // File exists but Drive hash is missing (and it's not a Google Doc type where this is expected)
        // This might indicate an issue or a very large file where hash calculation failed/skipped.
        // Decide policy: Treat as modified? Log warning?
        core.warning(`Drive file ${drive_path} exists locally but has no md5Checksum in Drive. Cannot verify modification. Skipping update from Drive for this file.`);
      } else {
        // Hashes match or it's a Google Doc type (can't compare hash) - assume no change originating from Drive needed.
        // core.debug(`File ${drive_path} matches or is Google Doc type. No change needed from Drive.`);
      }
      // Remove processed file from local_map to find deletions later
      local_map.delete(drive_path);
    }
  }

  // *** 4. Identify files deleted in Drive ***
  // Any remaining files in local_map were present locally but NOT found in Drive.
  for (const [local_path_remaining, _local_file_info] of local_map) {
    // No need for ignore check here, list_local_files already handled ignores.
    // If it's in local_map, it wasn't ignored.
    core.info(`File deleted in Drive detected: ${local_path_remaining}`);
    deleted_files.push(local_path_remaining);
  }

  // *** 5. Apply changes locally and stage them ***
  let changes_staged = false;
  for (const { path: file_path, id } of new_files) {
    try {
      core.info(`Downloading new file from Drive: ${file_path} (ID: ${id})`);
      await download_file(id, file_path); // Use original case path for download destination
      await execGit("add", [file_path]);
      changes_staged = true;
    } catch (error) {
      core.error(`Failed to download or stage new file ${file_path}: ${(error as Error).message}`);
    }
  }
  for (const { path: file_path, id } of modified_files) {
    try {
      core.info(`Downloading modified file from Drive: ${file_path} (ID: ${id})`);
      await download_file(id, file_path);
      await execGit("add", [file_path]);
      changes_staged = true;
    } catch (error) {
      core.error(`Failed to download or stage modified file ${file_path}: ${(error as Error).message}`);
    }
  }
  for (const file_path of deleted_files) {
    try {
      core.info(`Removing local file deleted in Drive: ${file_path}`);
      // Use git rm which handles staging the deletion.
      // --ignore-unmatch prevents errors if file was already deleted locally somehow.
      await execGit("rm", ["--ignore-unmatch", file_path]);
      // Check if the rm command actually did something (staged a change)
      // This is tricky, git status might be needed. Simpler: assume change if command succeeded.
      changes_staged = true; // Assume rm might have staged something if it didn't error
    } catch (error) {
      core.error(`Failed to stage deletion of ${file_path}: ${(error as Error).message}`);
    }
  }

  // *** 6. Commit, Push, and Create PR if changes were staged ***
  if (changes_staged) {
    // Check git status to be absolutely sure there are changes to commit
    const status_result = await execGit('status', ['--porcelain']);
    if (!status_result.stdout.trim()) {
      core.info("Git status clean after applying changes. No commit needed.");
      changes_staged = false; // Correct the flag if nothing was actually changed/staged
    }
  }


  if (changes_staged) {
    core.info("Changes detected from Drive. Proceeding with commit and PR.");
    const commit_messages: string[] = ["Sync changes from Google Drive"]; // Main title
    if (new_files.length > 0) {
      commit_messages.push(`- Added: ${new_files.map(f => f.path).join(", ")}`);
    }
    if (modified_files.length > 0) {
      commit_messages.push(`- Updated: ${modified_files.map(f => f.path).join(", ")}`);
    }
    if (deleted_files.length > 0) {
      commit_messages.push(`- Removed: ${deleted_files.join(", ")}`);
    }
    commit_messages.push(`\nSource Drive Folder ID: ${folder_id}`); // Add context

    try {
      // Configure Git identity
      await execGit("config", ["--local", "user.email", "github-actions[bot]@users.noreply.github.com"]);
      await execGit("config", ["--local", "user.name", "github-actions[bot]"]);

      // Commit the changes
      await execGit("commit", ["-m", commit_messages.join("\n")]);

      // Create a unique head branch name for the PR
      const sanitized_folder_id = folder_id.replace(/[^a-zA-Z0-9_-]/g, '_');
      const head_branch = `sync-from-drive-${sanitized_folder_id}-${run_id}`;
      core.info(`Creating PR branch: ${head_branch}`);
      await execGit("checkout", ["-b", head_branch]);

      // Push the new branch (use --force carefully, maybe only needed if retrying same run ID)
      // Using a unique run_id in branch name makes --force less critical but safer for retries.
      core.info(`Pushing branch ${head_branch} to origin...`);
      await execGit("push", ["--force", "origin", head_branch]);

      const [owner, repo] = process.env.GITHUB_REPOSITORY!.split("/");
      core.info(`Preparing to create PR for ${owner}/${repo}, head: ${head_branch}`);

      const pr_title = `Sync changes from Google Drive (${folder_id})`;
      const pr_body = `This PR syncs changes detected in Google Drive folder [${folder_id}](https://drive.google.com/drive/folders/${folder_id}):\n` +
        (new_files.length > 0 ? `*   **Added:** ${new_files.map(f => `\`${f.path}\``).join(", ")}\n` : "") +
        (modified_files.length > 0 ? `*   **Updated:** ${modified_files.map(f => `\`${f.path}\``).join(", ")}\n` : "") +
        (deleted_files.length > 0 ? `*   **Removed:** ${deleted_files.join(", ")}\n` : "") +
        `\n*Workflow Run ID: ${run_id}*`;

      const pr_params = {
        owner: owner,
        repo: repo,
        title: pr_title,
        head: head_branch, // Branch name only for same-repo head format
        base: initial_branch, // Base the PR against the branch the workflow started on
        body: pr_body,
      };

      // Call the PR creation function with retry logic
      await create_pull_request_with_retry(octokit, pr_params);
      core.info(`Pull request creation initiated for branch ${head_branch}.`);

    } catch (error) {
      core.setFailed(`Failed during commit, push, or PR creation for Drive changes: ${(error as Error).message}`);
      // Attempt cleanup even on failure
    }

  } else {
    core.info("No effective changes detected originating from Drive. No PR needed for incoming changes.");
  }

  // *** 7. Cleanup: Go back to the original branch and delete the temporary state branch ***
  core.info(`Cleaning up temporary branches. Checking out initial branch '${initial_branch}'`);
  try {
    await execGit("checkout", [initial_branch]);
    core.info(`Deleting temporary state branch '${original_state_branch}'`);
    await execGit("branch", ["-D", original_state_branch]);
  } catch (checkoutError) {
    core.warning(`Failed to checkout initial branch '${initial_branch}' or delete temporary branch '${original_state_branch}'. Manual cleanup might be needed. Error: ${(checkoutError as Error).message}`);
    // Attempt to recover by checking out main/default if initial branch failed
    try {
      core.warning("Attempting checkout of 'main'");
      await execGit("checkout", ["main"]);
      core.info(`Deleting temporary state branch '${original_state_branch}'`);
      await execGit("branch", ["-D", original_state_branch], { ignoreReturnCode: true }); // Ignore error if already deleted
    } catch (mainCheckoutError) {
      core.error("Could not checkout 'main' either. Workspace might be in an inconsistent state.");
    }
  }
}


// *** Main sync function ***
async function sync_to_drive() {
  const [owner, repo] = process.env.GITHUB_REPOSITORY!.split("/");
  core.info(`Syncing repository: ${owner}/${repo}`);

  // Initial local file listing (respecting .gitignore and config.ignore)
  const initial_local_files = await list_local_files(".");
  if (initial_local_files.length === 0) {
    core.warning("No relevant local files found to sync based on ignore rules. Nothing to push to Drive.");
    // Decide if you still want to check for incoming changes
    // return; // Option to exit early
  } else {
    core.info(`Found ${initial_local_files.length} initial local files for potential sync.`);
  }

  for (const target of config.targets.forks) {
    const folder_id = target.drive_folder_id;
    const on_untrack_action = target.on_untrack || "ignore"; // Default to ignore
    core.startGroup(`Processing Target Drive Folder: ${folder_id} (Untrack Action: ${on_untrack_action})`);
    core.info(`Drive URL: ${target.drive_url || `https://drive.google.com/drive/folders/${folder_id}`}`);


    try {
      // *** Step 1: Handle Incoming Changes from Drive (Download to local, create PR if needed) ***
      // This function now handles checkout, comparison, download, commit, push, PR creation
      await handle_drive_changes(folder_id);

      // *** Step 2: Accept Pending Ownership Transfers (Optional but recommended) ***
      core.info("Checking for and accepting pending ownership transfers...");
      await accept_ownership_transfers(folder_id); // Accept for the root and recursively

      // *** Step 3: Sync Outgoing Changes (Local -> Drive) ***
      core.info("Processing outgoing changes (local -> Drive)...");

      // Re-list local files *after* potential updates from handle_drive_changes
      // This ensures we push the merged state (original + drive changes) to Drive
      const current_local_files = await list_local_files(".");
      const current_local_map = new Map(current_local_files.map(f => [f.relative_path.replace(/\\/g, '/'), f]));
      core.info(`Found ${current_local_map.size} local files after handling Drive changes.`);


      // List Drive content *again* to get the latest state after potential deletions/uploads
      // This might seem redundant but ensures accuracy for the outgoing sync part
      core.info("Re-listing Drive content for outgoing sync comparison...");
      let drive_files_map: Map<string, DriveItem>;
      let drive_folders_map: Map<string, DriveItem>;
      try {
        const drive_data = await list_drive_files_recursively(folder_id);
        drive_files_map = new Map(Array.from(drive_data.files.entries()).map(([p, item]) => [p.replace(/\\/g, '/'), item]));
        drive_folders_map = new Map(Array.from(drive_data.folders.entries()).map(([p, item]) => [p.replace(/\\/g, '/'), item]));
        core.info(`Found ${drive_files_map.size} files and ${drive_folders_map.size} folders in Drive for outgoing sync.`);
      } catch (listError) {
        core.error(`Failed to list Drive content before outgoing sync for folder ${folder_id}: ${(listError as Error).message}. Skipping outgoing sync.`);
        core.endGroup();
        continue; // Skip to next target
      }


      // Build/verify folder structure in Drive based on current local files
      core.info("Ensuring Drive folder structure matches local structure...");
      let folder_path_to_id_map: Map<string, string>;
      try {
        folder_path_to_id_map = await build_folder_structure(folder_id, current_local_files, drive_folders_map);
      } catch (structureError) {
        core.error(`Failed to build Drive folder structure for ${folder_id}: ${(structureError as Error).message}. Skipping outgoing sync.`);
        core.endGroup();
        continue; // Skip to next target
      }


      // Upload/Update local files to Drive
      core.info("Uploading/updating files from local to Drive...");
      const files_to_keep_in_drive = new Set<string>(); // Track files that should remain

      for (const [relative_path, local_file] of current_local_map) {
        files_to_keep_in_drive.add(relative_path); // Mark this path as active
        const drive_file = drive_files_map.get(relative_path);
        const file_name = path.basename(relative_path);
        const dir_path = path.dirname(relative_path);
        // Handle root directory case ('.') -> map to empty string for lookup
        const parent_dir_lookup = (dir_path === '.') ? "" : dir_path.replace(/\\/g, '/');
        const target_folder_id = folder_path_to_id_map.get(parent_dir_lookup);


        if (!target_folder_id) {
          core.warning(`Could not find target folder ID for local file '${relative_path}' (parent path '${parent_dir_lookup}'). Skipping upload.`);
          continue;
        }

        if (!drive_file) {
          core.info(`New file in Git Repo, uploading to Drive: ${relative_path}`);
          await upload_file(local_file.path, target_folder_id);
        } else {
          // Compare hashes if Drive file hash is available
          if (drive_file.hash && drive_file.hash !== local_file.hash) {
            core.info(`Local file changed, updating Drive: ${relative_path} (Local: ${local_file.hash}, Drive: ${drive_file.hash})`);
            await upload_file(local_file.path, target_folder_id, { id: drive_file.id, name: file_name });
          } else if (!drive_file.hash && drive_file.mimeType && !drive_file.mimeType.startsWith('application/vnd.google-apps')) { // Check mimeType exists before accessing
            // Drive hash missing, potentially large file or issue. Re-upload to be safe? Or skip?
            // Policy: Let's try updating it. If it's unchanged, Drive API might handle it efficiently.
            core.info(`Local file exists, Drive hash missing. Attempting update: ${relative_path}`);
            await upload_file(local_file.path, target_folder_id, { id: drive_file.id, name: file_name });
          } else {
            // Hashes match or it's a Google Doc type - no upload needed.
            // Also handles case where mimeType is missing for some reason
            // core.debug(`File ${relative_path} hasn't changed locally or is Google Doc/Unknown Type. No upload needed.`);
          }
          // Check if file name needs updating (e.g., case change) even if content is same
          // Check hash equality *only if both exist*. If drive_file.hash is missing, we might have updated above.
          const hashes_match_or_drive_missing = !drive_file.hash || (local_file.hash === drive_file.hash);
          if (drive_file.name !== file_name && hashes_match_or_drive_missing) {
            core.info(`Updating filename in Drive for ${relative_path} from '${drive_file.name}' to '${file_name}'`);
            try {
              await drive.files.update({
                fileId: drive_file.id,
                requestBody: { name: file_name },
                // supportsAllDrives: true // if needed
              });
            } catch (renameError) {
              core.warning(`Failed to rename file ${drive_file.id} to '${file_name}': ${(renameError as Error).message}`);
            }
          }
        }
      }

      // *** Step 4: Handle Untracked Files/Folders in Drive ***
      core.info(`Handling untracked items in Drive based on action: '${on_untrack_action}'...`);

      // Identify items in Drive that are NOT in the current local file list (files_to_keep_in_drive)
      const untracked_drive_files = Array.from(drive_files_map.entries())
        .filter(([path, _item]) => !files_to_keep_in_drive.has(path));
      const untracked_drive_folders = Array.from(drive_folders_map.entries())
        // Keep folders only if they are NOT required by any current local file path
        .filter(([path, _item]) => !Array.from(files_to_keep_in_drive).some(localPath => localPath.startsWith(path + '/')));


      core.info(`Found ${untracked_drive_files.length} untracked files and ${untracked_drive_folders.length} potentially untracked folders in Drive.`);

      const all_untracked_items = [
        ...untracked_drive_files.map(([path, item]) => ({ path, item, isFolder: false })),
        ...untracked_drive_folders.map(([path, item]) => ({ path, item, isFolder: true }))
      ];


      if (all_untracked_items.length > 0) {
        if (on_untrack_action === "ignore") {
          core.info(`Ignoring ${all_untracked_items.length} untracked item(s) in Drive as per config.`);
          // Optionally log the items being ignored:
          // all_untracked_items.forEach(u => core.debug(` - Ignored untracked ${u.isFolder ? 'folder' : 'file'}: ${u.path}`));
        } else {
          // Process for 'remove' or 'request'
          for (const { path: untracked_path, item: untracked_item, isFolder } of all_untracked_items) {
            core.info(`Processing untracked ${isFolder ? 'folder' : 'file'} in Drive: ${untracked_path} (ID: ${untracked_item.id})`);

            // Check ownership BEFORE deciding action
            if (!untracked_item.owned) {
              const current_owner = untracked_item.permissions?.find(p => p.role === 'owner')?.emailAddress;
              if (current_owner && current_owner !== credentials_json.client_email) {
                core.warning(`Untracked item '${untracked_path}' is owned by ${current_owner}. Requesting ownership transfer.`);
                await request_ownership_transfer(untracked_item.id, current_owner);
                // Whether action is 'remove' or 'request', we request transfer if not owned.
                // If action is 'remove', we skip deletion this time, hoping transfer succeeds for next run.
                continue; // Skip deletion/further processing for this item this run
              } else {
                // No owner found or owned by someone unexpected, but not the specific service account.
                // This is an odd state. Log it. Maybe treat as owned for deletion? Or skip?
                // Explicitly type 'o' here
                const ownerEmailsFromPermissions = untracked_item.permissions
                  ?.filter(p => p.role === 'owner') // Filter for permissions with role 'owner'
                  .map(p => p.emailAddress || 'Unknown Email') // Get their email address
                  .join(',') || 'None found in permissions'; // Join emails or provide fallback text
                core.warning(`Untracked item '${untracked_path}' has unclear ownership (Owners: ${ownerEmails}, Permissions: ${JSON.stringify(untracked_item.permissions)}).`);
                // Policy Decision: Skip deletion if ownership is unclear? Or attempt deletion if owned by service account is false?
                // Let's skip deletion if not explicitly owned by the service account.
                if (on_untrack_action === 'remove') {
                  core.warning(`Skipping removal of '${untracked_path}' due to unclear ownership.`);
                  continue;
                }
              }
            } else {
              // Item IS owned by the service account.
              core.info(`Untracked item '${untracked_path}' is owned by the service account.`);
              if (on_untrack_action === "remove") {
                core.info(`Proceeding with removal (moving to trash) of owned untracked item '${untracked_path}'.`);
                await delete_untracked(untracked_item.id, untracked_path, isFolder);
              } else if (on_untrack_action === "request") {
                // Action is 'request', but we already own it. Nothing to request. Log it.
                core.info(`Untracked item '${untracked_path}' is already owned. No action needed for 'request' strategy.`);
              }
            }
          }
        }
      } else {
        core.info("No untracked items found in Drive for this target.");
      }


    } catch (error) {
      core.error(`Unhandled error during sync process for Drive folder ${folder_id}: ${(error as Error).message}`);
      // Optionally set job status to failure here if needed
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
  core.error(err.stack || "No stack trace available."); // Log stack trace for debugging
  core.setFailed(`Sync failed: ${err.message}`);
});
