import * as core from "@actions/core";
import * as fs from "fs";
import * as fs_promises from "fs/promises";
import * as path from "path";
import { drive } from "./auth.js";
import { DriveItem } from "./types.js";
// Note: We no longer need anything else from shortcuts.ts for link file creation
// Import the specific function and map we need
import { GOOGLE_DOC_MIME_TYPES, LINK_FILE_MIME_TYPES, MIME_TYPE_TO_EXTENSION, get_link_file_suffix } from "./file_types.js";

// Download File Content (Only for non-Google Docs - binary files)
async function download_file_content(file_id: string, local_path: string): Promise<void> {
  core.info(`Downloading Drive file content ID ${file_id} to local path ${local_path}`);
  try {
    const dir = path.dirname(local_path);
    await fs_promises.mkdir(dir, { recursive: true });

    const res = await drive.files.get(
      { fileId: file_id, alt: "media" },
      { responseType: "stream" }
    );

    if (!res.data || typeof (res.data as any).pipe !== 'function') {
      throw new Error(`Drive API did not return a readable stream for file ID ${file_id}.`);
    }

    const writer = fs.createWriteStream(local_path);

    return new Promise((resolve, reject) => {
      (res.data as NodeJS.ReadableStream)
        .pipe(writer)
        .on("finish", () => {
          core.info(`Successfully downloaded content for file ${file_id} to ${local_path}`);
          resolve();
        })
        .on("error", (err) => {
          core.error(`Error writing downloaded file content ${file_id} to ${local_path}: ${err.message}`);
          fs.unlink(local_path, unlinkErr => {
            if (unlinkErr && unlinkErr.code !== 'ENOENT') {
              core.warning(`Failed to clean up partial download ${local_path}: ${unlinkErr.message}`);
            }
            reject(err);
          });
        });
    });
  } catch (error) {
    const err = error as any;
    if (err.code === 404) { core.error(`Failed to download file content ${file_id}: File not found.`); }
    else if (err.code === 403) { core.error(`Failed to download file content ${file_id}: Permission denied.`); }
    else if (err.message?.includes('downloading Google Docs')) { core.error(`Failed to download file content ${file_id}: Cannot directly download Google Docs format.`); }
    else { core.error(`Failed to download file content ${file_id}: ${err.message}`); }
    if (err.response?.data) { core.error(`API Error Details: ${JSON.stringify(err.response.data)}`); }
    throw error;
  }
}

// --- handle_download_item using the consolidated link function ---
/**
 * Handles downloading/representing a Drive item locally.
 * Always creates a .gdrive.json file using create_gdrive_link_file.
 * Downloads content *only* if it's not a Google Workspace type.
 * @param drive_item The Drive item metadata.
 * @param local_path_base The intended local path for the *content* file.
 * @returns An object containing the paths of the created files.
 */
export async function handle_download_item(
  drive_item: DriveItem,
  target_content_local_path: string
): Promise<{ linkFilePath?: string; contentFilePath?: string }> {
  core.debug(`Handling download for Drive item: ${drive_item.name} (ID: ${drive_item.id}, MIME: ${drive_item.mimeType})`);
  if (!drive_item.id || !drive_item.name || !drive_item.mimeType) {
    core.error(`Drive item ${drive_item.id || drive_item.name || '(unknown)'} is missing required fields (id, name, mimeType). Skipping.`);
    return {}; // Return empty if essential info is missing
  }

  const is_google_doc = GOOGLE_DOC_MIME_TYPES.includes(drive_item.mimeType);
  const needs_link_file = LINK_FILE_MIME_TYPES.includes(drive_item.mimeType);
  let linkFilePath: string | undefined;
  let contentFilePath: string | undefined;

  // Create a link file (e.g., .doc.gdrive.json) for Google Docs and PDFs
  if (needs_link_file) {
    const link_suffix = get_link_file_suffix(drive_item.mimeType);
    // Use the DRIVE ITEM's name for the link file base name
    const base_name = drive_item.name; // Assumes name doesn't contain path separators like '/'
    const link_file_name = `${base_name}${link_suffix}`;
    // Place it in the same directory as the target content file
    const content_dir = path.dirname(target_content_local_path);
    const link_file_path = path.join(content_dir, link_file_name);

    core.info(`Creating/Updating GDrive link file: ${link_file_path} for '${drive_item.name}' (ID: ${drive_item.id})`);
    const link_data = {
      id: drive_item.id,
      mimeType: drive_item.mimeType,
      name: drive_item.name,
      modifiedTime: drive_item.modifiedTime
    };
    await fs.promises.mkdir(content_dir, { recursive: true }); // Ensure dir exists
    await fs.promises.writeFile(link_file_path, JSON.stringify(link_data, null, 2));
    linkFilePath = link_file_path;
  }

  // Handle content download
  if (is_google_doc) {
    core.info(`File '${drive_item.name}' (ID: ${drive_item.id}) is a Google Doc type. Skipping content download.`);
  } else {
    // Download content for PDFs and other binary files
    core.info(`File '${drive_item.name}' (ID: ${drive_item.id}) is not a Google Doc type. Downloading content.`);
    try {
      // Ensure directory exists before downloading
      const content_dir = path.dirname(target_content_local_path);
      await fs.promises.mkdir(content_dir, { recursive: true });

      core.debug(`Downloading Drive file content ID ${drive_item.id} to local path ${target_content_local_path}`);
      const response = await drive.files.get(
        { fileId: drive_item.id, alt: "media" },
        { responseType: "stream" }
      );
      const dest = fs.createWriteStream(target_content_local_path);
      await new Promise<void>((resolve, reject) => {
        if (!response.data || typeof (response.data as any).pipe !== 'function') {
          return reject(new Error(`Drive API did not return a readable stream for file ID ${drive_item.id}.`));
        }
        (response.data as NodeJS.ReadableStream).pipe(dest);
        dest.on("finish", resolve);
        dest.on("error", (err) => reject(err));
      });
      core.debug(`Successfully downloaded content for file ${drive_item.id} to ${target_content_local_path}`);
      contentFilePath = target_content_local_path;
    } catch (error) {
      core.error(`Failed to download content for ${drive_item.name} (ID: ${drive_item.id}): ${(error as Error).message}`);
      // Attempt to cleanup partial download
      await fs.promises.rm(target_content_local_path, { force: true, recursive: false }).catch(() => { });
      throw error;
    }
  }

  return { linkFilePath, contentFilePath };
}

// --- upload_file ---
/**
 * Uploads a local file to Google Drive, skipping link files (e.g., *.doc.gdrive.json).
 * Can create a new file or update an existing one.
 * @param local_file_path Absolute path to the local file.
 * @param target_folder_id Drive Folder ID where the file should be uploaded.
 * @param existing_drive_file Optional info for updating an existing file.
 * @returns Object with the Drive file ID and success status.
 */
// Pre-compile regex for checking link files
const known_extensions = Object.values(MIME_TYPE_TO_EXTENSION).join('|');
const link_file_upload_regex = new RegExp(`\\.(${known_extensions})\\.gdrive\\.json$`);

export async function upload_file(
  local_file_path: string,
  target_folder_id: string,
  existing_drive_file?: { id: string; name: string }
): Promise<{ id: string; success: boolean }> {
  const local_file_name = path.basename(local_file_path);

  // Skip uploading the link files themselves using the new pattern
  if (link_file_upload_regex.test(local_file_name)) {
    core.info(`Skipping upload of GDrive link file: ${local_file_name}`);
    // If we were updating, return the existing ID. Otherwise empty string.
    return { id: existing_drive_file?.id || '', success: true };
  }

  const media = { body: fs.createReadStream(local_file_path) };
  let fileId = existing_drive_file?.id;
  let operation: 'update' | 'create' = existing_drive_file?.id ? 'update' : 'create';

  try {
    if (operation === 'update' && fileId) {
      const requestBody: { name?: string } = {};
      if (existing_drive_file!.name !== local_file_name) {
        requestBody.name = local_file_name;
        core.info(`Updating file name for '${existing_drive_file!.name}' to '${local_file_name}' (ID: ${fileId})`);
      } else {
        core.info(`Updating existing file content '${local_file_name}' (ID: ${fileId}) in folder ${target_folder_id}`);
      }
      const res = await drive.files.update({
        fileId: fileId,
        media: media,
        // Only include requestBody if it has keys (i.e., name change)
        requestBody: Object.keys(requestBody).length > 0 ? requestBody : undefined,
        fields: "id, name, md5Checksum", // Always request fields
      });
      fileId = res.data.id!;
      core.info(`Updated file '${res.data.name}' (ID: ${fileId}). New hash: ${res.data.md5Checksum || 'N/A'}`);
    } else { // create
      core.info(`Creating new file '${local_file_name}' in folder ${target_folder_id}`);
      const res = await drive.files.create({
        requestBody: { name: local_file_name, parents: [target_folder_id] },
        media: media,
        fields: "id, name, md5Checksum",
      });
      if (!res.data.id) { throw new Error(`File creation API call did not return an ID for '${local_file_name}'.`); }
      fileId = res.data.id;
      core.info(`Uploaded file '${res.data.name}' (ID: ${fileId}). Hash: ${res.data.md5Checksum || 'N/A'}`);
    }
    return { id: fileId!, success: true };
  } catch (error: unknown) {
    const err = error as any;
    core.warning(`Failed to ${operation} file '${local_file_name}' in folder ${target_folder_id}: ${err.message}`);
    if (err.response?.data) { core.warning(`API Error Details: ${JSON.stringify(err.response.data)}`); }
    // Ensure we return an ID if it was an update attempt, even if it failed
    return { id: operation === 'update' ? fileId || '' : '', success: false };
  }
}
