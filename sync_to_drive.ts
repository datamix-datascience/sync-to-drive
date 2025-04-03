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
  on_untrack: "ignore" | "remove";  // Removed on_conflict
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
}

interface DriveFilesListResponse {
  files?: DriveFile[];
  nextPageToken?: string;
}

// Load config from target repo
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

// Compute file hash
async function compute_hash(file_path: string): Promise<string> {
  const content = await fsPromises.readFile(file_path);
  return createHash("sha1").update(content).digest("hex");
}

// List local files recursively with ignore patterns
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

// List Drive files recursively
async function list_drive_files(folder_id: string): Promise<Map<string, { id: string; hash: string }>> {
  const file_map = new Map<string, { id: string; hash: string }>();
  const res = await drive.files.list({
    q: `'${folder_id}' in parents`,
    fields: "files(id, name, md5Checksum)",
  }) as { data: DriveFilesListResponse };

  for (const file of res.data.files || []) {
    if (file.name && file.id) {
      file_map.set(file.name, { id: file.id, hash: file.md5Checksum || "" });
    }
  }
  return file_map;
}

// Ensure folder exists in Drive
async function ensure_folder(parent_id: string, folder_name: string): Promise<string> {
  core.info(`Ensuring folder '${folder_name}' under parent '${parent_id}'`);
  try {
    let allFiles: DriveFile[] = [];
    let nextPageToken: string | undefined = undefined;

    do {
      core.info(`Listing files under '${parent_id}' (pageToken: ${nextPageToken || 'none'})`);
      const res = await drive.files.list({
        q: `'${parent_id}' in parents`,
        fields: "nextPageToken, files(id, name, mimeType)",
        spaces: "drive",
        pageToken: nextPageToken,
        pageSize: 1000,
      }) as { data: DriveFilesListResponse };

      allFiles = allFiles.concat(res.data.files || []);
      nextPageToken = res.data.nextPageToken;
    } while (nextPageToken);

    core.info(`Total files found under '${parent_id}': ${JSON.stringify(allFiles)}`);

    const existingFolder = allFiles.find(file =>
      file.mimeType === "application/vnd.google-apps.folder" &&
      file.name?.toLowerCase() === folder_name.toLowerCase()
    );
    if (existingFolder && existingFolder.id) {
      core.info(`Folder '${folder_name}' already exists with ID: ${existingFolder.id}`);
      return existingFolder.id;
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
    if (err.response) {
      core.error(`API response: ${JSON.stringify(err.response.data)}`);
    }
    throw err;
  }
}

// Build folder structure once
async function build_folder_structure(root_folder_id: string, local_files: FileInfo[]): Promise<Map<string, string>> {
  const folder_map = new Map<string, string>();  // Path -> Folder ID
  folder_map.set("", root_folder_id);  // Root path maps to root folder

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
async function upload_file(file_path: string, folder_id: string, existing_file?: { id: string; name: string }) {
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
  } catch (error: unknown) {
    const err = error as Error;
    core.error(`Failed to process '${file_name}': ${err.message}`);
    throw err;
  }
}

// Delete untracked file
async function delete_untracked(file_id: string, file_name: string) {
  await drive.files.delete({ fileId: file_id });
  core.info(`Deleted untracked file: ${file_name}`);
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
    const drive_files = await list_drive_files(folder_id);
    const drive_link = `https://drive.google.com/drive/folders/${folder_id}`;
    core.setOutput("link", drive_link);

    try {
      // Build folder structure once
      const folder_map = await build_folder_structure(folder_id, local_files);
      core.info(`Folder structure built: ${JSON.stringify([...folder_map])}`);

      // Sync files
      const local_file_map = new Map<string, FileInfo>();
      for (const file of local_files) {
        local_file_map.set(file.relative_path, file);
      }

      for (const [relative_path, local_file] of local_file_map) {
        const file_name = path.basename(relative_path);
        const dir_path = path.dirname(relative_path) || "";
        const target_folder_id = folder_map.get(dir_path) || folder_id;
        const drive_file = drive_files.get(file_name);

        if (!drive_file) {
          await upload_file(local_file.path, target_folder_id);
        } else if (drive_file.hash !== local_file.hash) {
          await upload_file(local_file.path, target_folder_id, { id: drive_file.id, name: file_name });
        }
        drive_files.delete(file_name);
      }

      if (drive_files.size > 0) {
        if (target.on_untrack === "remove") {
          for (const [file_name, file_info] of drive_files) {
            await delete_untracked(file_info.id, file_name);
          }
        } else {
          core.info(`Leaving ${drive_files.size} untracked files in folder ${folder_id}`);
        }
      }
      core.info(`Sync completed for folder ${folder_id}`);
    } catch (error: unknown) {
      const err = error as Error;
      core.error(`Sync failed for folder ${folder_id}: ${err.message}`);
      throw err;
    }
  }
}

// Run the action
sync_to_drive().catch((error: unknown) => {
  const err = error as Error;
  core.setFailed(`Sync failed: ${err.message}`);
});
