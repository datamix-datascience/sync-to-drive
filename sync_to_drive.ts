import * as core from "@actions/core";
import { google } from "googleapis";
import * as fsPromises from "fs/promises";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { glob } from "glob";

// Config types
interface SyncConfig {
  source: { repo: string };
  ignore: string[];
  targets: { forks: DriveTarget[] };
}

interface DriveTarget {
  drive_folder_id: string;
  drive_url: string;
  on_untrack: "ignore" | "remove";
}

interface FileInfo {
  path: string;
  hash: string;
  relative_path: string;
}

interface DriveFile {
  id?: string;
  name?: string;
  mime_type?: string;
  md5_checksum?: string;
  owners?: { email_address: string }[];
}

interface DriveFilesListResponse {
  files?: DriveFile[];
  next_page_token?: string;
}

interface DrivePermission {
  id: string;
  role: string;
  pending_owner?: boolean;
  email_address?: string;
}

interface DrivePermissionsListResponse {
  permissions?: DrivePermission[];
  next_page_token?: string;
}

interface UntrackedItem {
  id: string;
  path: string;
  url: string;
  name: string;
  owner_email: string;
  ownership_transfer_requested: boolean;
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

// Track ownership transfer requests
const ownership_transfer_requested_ids = new Set<string>();

// Compute file hash
async function compute_hash(file_path: string): Promise<string> {
  const content = await fsPromises.readFile(file_path);
  return createHash("sha1").update(content).digest("hex");
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
    const stats = await fsPromises.stat(full_path);
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
      next_page_token = res.data.next_page_token;
    } while (next_page_token);

    const service_account_email = credentials_json.client_email;
    const pending_permissions = permissions.filter(
      p => p.email_address === service_account_email && p.pending_owner
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
      fields: "files(id, mime_type)",
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
  files: Map<string, { id: string; hash: string; owned: boolean; permissions: DrivePermission[] }>;
  folders: Map<string, { id: string; owned: boolean; permissions: DrivePermission[] }>;
}> {
  const file_map = new Map<string, { id: string; hash: string; owned: boolean; permissions: DrivePermission[] }>();
  const folder_map = new Map<string, { id: string; owned: boolean; permissions: DrivePermission[] }>();
  let all_files: DriveFile[] = [];
  let next_page_token: string | undefined;

  do {
    const res = await drive.files.list({
      q: `'${folder_id}' in parents`,
      fields: "nextPageToken, files(id, name, mime_type, md5_checksum, owners(email_address))",
      spaces: "drive",
      pageToken: next_page_token,
      pageSize: 1000,
    }) as { data: DriveFilesListResponse };

    all_files = all_files.concat(res.data.files || []);
    next_page_token = res.data.next_page_token;
  } while (next_page_token);

  const service_account_email = credentials_json.client_email;
  for (const file of all_files) {
    if (!file.name || !file.id) continue;
    const relative_path = base_path ? path.join(base_path, file.name) : file.name;
    const owned = file.owners?.some(owner => owner.email_address === service_account_email) || false;

    const perm_res = await drive.permissions.list({
      fileId: file.id,
      fields: "permissions(id, role, email_address, pending_owner)",
    }) as { data: DrivePermissionsListResponse };
    const permissions = perm_res.data.permissions || [];

    if (file.mime_type === "application/vnd.google-apps.folder") {
      folder_map.set(relative_path, { id: file.id, owned, permissions });
      const subfolder_data = await list_drive_files_recursively(file.id, relative_path);
      for (const [sub_path, sub_file] of subfolder_data.files) {
        file_map.set(sub_path, sub_file);
      }
      for (const [sub_path, sub_folder] of subfolder_data.folders) {
        folder_map.set(sub_path, sub_folder);
      }
    } else {
      file_map.set(relative_path, { id: file.id, hash: file.md5_checksum || "", owned, permissions });
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
      const res = await drive.files.list({
        q: `'${parent_id}' in parents ${folder_name}`,
        fields: "nextPageToken, files(id, name, mime_type)",
        spaces: "drive",
        pageToken: next_page_token,
        pageSize: 1000,
      }) as { data: DriveFilesListResponse };

      all_files = all_files.concat(res.data.files || []);
      next_page_token = res.data.next_page_token;
    } while (next_page_token);

    const existing_folder = all_files.find(file =>
      file.mime_type === "application/vnd.google-apps.folder" &&
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
async function build_folder_structure(root_folder_id: string, local_files: FileInfo[]): Promise<Map<string, string>> {
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
        current_folder_id = await ensure_folder(current_folder_id, part);
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

// List untracked files (only files, not folders)
async function list_untracked_files(
  drive_files: Map<string, { id: string; hash: string; owned: boolean; permissions: DrivePermission[] }>
): Promise<UntrackedItem[]> {
  const untracked_items: UntrackedItem[] = [];

  for (const [file_path, file_info] of drive_files) {
    const is_ignored = config.ignore.some(pattern =>
      new RegExp(pattern.replace(/\*/g, ".*")).test(file_path)
    );
    if (is_ignored) {
      continue;
    }

    const owner = file_info.permissions.find(p => p.role === "owner");
    const owner_email = owner?.email_address || "unknown";
    untracked_items.push({
      id: file_info.id,
      path: file_path,
      url: `https://drive.google.com/file/d/${file_info.id}`,
      name: path.basename(file_path),
      owner_email,
      ownership_transfer_requested: ownership_transfer_requested_ids.has(file_info.id),
    });
  }

  return untracked_items;
}

// Main sync function
async function sync_to_drive() {
  const local_files = await list_local_files(".");
  core.info(`Files to sync: ${JSON.stringify(local_files.map(f => f.relative_path))}`);
  if (local_files.length === 0) {
    core.setFailed("No files found in repository to sync (after applying ignore patterns)");
    return;
  }

  for (const target of config.targets.forks) {
    core.info(`Processing target: ${JSON.stringify(target)}`);
    const folder_id = target.drive_folder_id;

    await accept_ownership_transfers(folder_id);

    let folder_map: Map<string, string>;
    let drive_files: Map<string, { id: string; hash: string; owned: boolean; permissions: DrivePermission[] }>;
    let drive_folders: Map<string, { id: string; owned: boolean; permissions: DrivePermission[] }>;

    try {
      folder_map = await build_folder_structure(folder_id, local_files);
      const drive_data = await list_drive_files_recursively(folder_id);
      drive_files = drive_data.files;
      drive_folders = drive_data.folders;
    } catch (error: unknown) {
      const err = error as any;
      core.warning(`Failed to initialize sync for folder ${folder_id}: ${err.message}`);
      continue;
    }

    const drive_link = `https://drive.google.com/drive/folders/${folder_id}`;
    core.setOutput("link", drive_link);

    core.info(`Folder structure built: ${JSON.stringify([...folder_map])}`);
    core.info(`Existing Drive files: ${JSON.stringify([...drive_files])}`);
    core.info(`Existing Drive folders: ${JSON.stringify([...drive_folders])}`);

    const local_file_map = new Map<string, FileInfo>();
    for (const file of local_files) {
      local_file_map.set(file.relative_path, file);
    }

    for (const [relative_path, local_file] of local_file_map) {
      const file_name = path.basename(relative_path);
      const dir_path = path.dirname(relative_path) || "";
      const target_folder_id = folder_map.get(dir_path) || folder_id;
      const drive_file = drive_files.get(relative_path);

      if (!drive_file) {
        await upload_file(local_file.path, target_folder_id);
      } else if (drive_file.hash !== local_file.hash) {
        await upload_file(local_file.path, target_folder_id, { id: drive_file.id, name: file_name });
      }
      drive_files.delete(relative_path);
    }

    let untracked_files_list: UntrackedItem[] = [];
    if (target.on_untrack === "remove") {
      for (const [file_path, file_info] of drive_files) {
        const is_ignored = config.ignore.some(pattern =>
          new RegExp(pattern.replace(/\*/g, ".*")).test(file_path)
        );
        if (is_ignored) {
          continue;
        }

        core.info(`Attempting to trash file '${file_path}' (ID: ${file_info.id}, Owned: ${file_info.owned})`);
        if (!file_info.owned) {
          const current_owner = file_info.permissions.find(p => p.role === "owner")?.email_address;
          if (current_owner && current_owner !== credentials_json.client_email) {
            await request_ownership_transfer(file_info.id, current_owner);
            continue;
          }
        }
        await delete_untracked(file_info.id, file_path);
      }

      for (const [folder_path, folder_info] of drive_folders) {
        if (!folder_map.has(folder_path)) {
          const has_tracked_files = Array.from(drive_files.keys()).some(file_path =>
            file_path.startsWith(folder_path + "/")
          );
          if (!has_tracked_files) {
            core.info(`Attempting to trash folder '${folder_path}' (ID: ${folder_info.id}, Owned: ${folder_info.owned})`);
            if (!folder_info.owned) {
              const current_owner = folder_info.permissions.find(p => p.role === "owner")?.email_address;
              if (current_owner && current_owner !== credentials_json.client_email) {
                await request_ownership_transfer(folder_info.id, current_owner);
                continue;
              }
            }
            await delete_untracked(folder_info.id, folder_path, true);
          }
        }
      }
    }

    untracked_files_list = await list_untracked_files(drive_files);
    if (untracked_files_list.length > 0) {
      core.warning(`Untracked files remaining in folder ${folder_id}:\n${JSON.stringify(untracked_files_list, null, 2)}`);
    } else {
      core.info(`No untracked files remaining in folder ${folder_id}`);
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
