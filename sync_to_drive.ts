import * as core from "@actions/core";
import { google } from "googleapis";
import * as fs_promises from "fs/promises";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { glob } from "glob";
import { exec } from "@actions/exec";
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
      folder_map.set(relative_path, { id: file.id, owned, permissions });
      const subfolder_data = await list_drive_files_recursively(file.id, relative_path);
      for (const [sub_path, sub_file] of subfolder_data.files) {
        file_map.set(sub_path, sub_file);
      }
      for (const [sub_path, sub_folder] of subfolder_data.folders) {
        folder_map.set(sub_path, sub_folder);
      }
    } else {
      file_map.set(relative_path, { id: file.id, hash: file.md5Checksum || "", owned, permissions });
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

async function createPullRequestWithRetry(octokit, params, maxRetries = 3, delay = 1000) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Fetch repository info to get the default branch
      const repoInfo = await octokit.repos.get({
        owner: params.owner,
        repo: params.repo,
      });
      const defaultBranch = repoInfo.data.default_branch;

      // Create the pull request
      await octokit.pulls.create({
        owner: params.owner,
        repo: params.repo,
        title: params.title,
        head: params.head,
        base: defaultBranch,
        body: params.body,
      });
      console.log("Pull request created successfully!");
      return;
    } catch (error) {
      if ((error as any)["status"] === 404 && attempt < maxRetries - 1) {
        console.log(`Attempt ${attempt + 1} failed with 404. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2; // Double the delay for the next attempt
      } else {
        throw error; // If it’s not a 404 or retries are exhausted, fail
      }
    }
  }
}

// Handle Drive changes with PR creation
async function handle_drive_changes(folder_id: string) {
  await execGit("checkout", ["-b", "original-state"]);
  const local_files = await list_local_files(".");
  const local_map = new Map(local_files.map(f => [f.relative_path.toLowerCase(), f]));

  const { files: drive_files } = await list_drive_files_recursively(folder_id);
  const drive_map = new Map(Array.from(drive_files).map(([path, item]) => [path.toLowerCase(), item]));

  const new_files: { path: string; id: string }[] = [];
  const modified_files: { path: string; id: string }[] = [];
  const deleted_files: string[] = [];

  for (const [drive_path, drive_item] of drive_map) {
    const local_file = local_map.get(drive_path);
    if (!local_file) {
      new_files.push({ path: drive_path, id: drive_item.id });
    } else if (local_file.hash !== drive_item.hash) {
      console.log(`File ${drive_path} differs: local=${local_file.hash}, drive=${drive_item.hash}`);
      modified_files.push({ path: drive_path, id: drive_item.id });
    }
  }

  for (const [local_path] of local_map) {
    if (!drive_map.has(local_path)) {
      deleted_files.push(local_path);
    }
  }

  let changes_made = false;
  for (const { path: file_path, id } of new_files) {
    await download_file(id, file_path);
    await execGit("add", [file_path]);
    changes_made = true;
  }
  for (const { path: file_path, id } of modified_files) {
    await download_file(id, file_path);
    await execGit("add", [file_path]);
    changes_made = true;
  }
  for (const file_path of deleted_files) {
    await fs_promises.unlink(file_path).catch(() => { });
    await execGit("rm", [file_path]);
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

      const head = `sync-from-drive-${process.env.GITHUB_RUN_ID}`;

      await execGit("commit", ["-m", commit_messages.join("\n")]);
      await execGit("checkout", ["-b", head]);
      await execGit("push", ["origin", head]);

      const [owner, repo] = process.env.GITHUB_REPOSITORY!.split("/");

      const repo_info = await octokit.repos.get({
        owner,
        repo,
      });
      const base = repo_info.data.default_branch;

      core.info("owner:" + owner);
      core.info("repo:" + repo);
      core.info("base:" + base);
      core.info("head:" + head);

      await octokit.rest.pulls.create({
        owner,
        repo,
        title: "Sync changes from Google Drive",
        head,
        base,
        body: "This PR syncs changes detected in Google Drive:\n" +
          (new_files.length > 0 ? `- Added: ${new_files.map(f => f.path).join(", ")}\n` : "") +
          (modified_files.length > 0 ? `- Updated: ${modified_files.map(f => f.path).join(", ")}\n` : "") +
          (deleted_files.length > 0 ? `- Removed: ${deleted_files.join(", ")}\n` : ""),
      });
      core.info("Pull request created for Drive changes");
    }
  }

  await execGit("checkout", ["original-state"]);
  await execGit("reset", ["--hard"]);
  await execGit("checkout", ["main"]);
  await execGit("branch", ["-D", "original-state"]);
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

    if (target.on_untrack === "remove") {
      for (const [file_path, file_info] of drive_files) {
        const is_ignored = config.ignore.some(pattern => new RegExp(pattern.replace(/\*/g, ".*")).test(file_path));
        if (is_ignored) continue;
        if (!file_info.owned) {
          const current_owner = file_info.permissions.find((p: DrivePermission) => p.role === "owner")?.emailAddress;
          if (current_owner && current_owner !== credentials_json.client_email) {
            await request_ownership_transfer(file_info.id, current_owner);
            continue;
          }
        }
        if (await delete_untracked(file_info.id, file_path)) {
          drive_files.delete(file_path);
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
