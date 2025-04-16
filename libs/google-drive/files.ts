import * as core from "@actions/core";
import * as fs from "fs";
import * as fs_promises from "fs/promises";
import * as path from "path";
import { drive } from "./auth";
import { DriveItem } from "./types";
// Keep GOOGLE_DOC_MIME_TYPES needed for handle_download_item logic
// Note: We no longer need anything else from shortcuts.ts for link file creation
import { GOOGLE_DOC_MIME_TYPES } from "./file_types";

// --- Consolidated Helper Function to Create Generic Link Files ---
/**
 * Creates a .gdrive.json file containing essential Drive metadata.
 * @param drive_item The Drive item metadata.
 * @param local_content_path The intended local path for the *content* file.
 *                           The link file will be placed alongside it using the Drive name.
 * @returns The full path to the created .gdrive.json file.
 * @throws If essential drive_item properties (id, mimeType, name) are missing.
 */
async function create_gdrive_link_file(drive_item: DriveItem, local_content_path: string): Promise<string> {
  // Input validation
  if (!drive_item.id || !drive_item.mimeType || !drive_item.name) {
    core.error(`Drive item is missing required fields (id, mimeType, name): ${JSON.stringify(drive_item)}`);
    throw new Error(`Cannot create link file for Drive item with missing id, mimeType, or name.`);
  }

  // Minimal required data for the downstream visual diff action
  const link_data = {
    id: drive_item.id,
    mimeType: drive_item.mimeType,
    name: drive_item.name, // Include name for better context/debugging
  };
  const link_file_content = JSON.stringify(link_data, null, 2);

  // Determine link file path based on the *content* path's directory and the *Drive* name
  const content_dir = path.dirname(local_content_path);
  // Use the exact Drive name as the base for the link file to ensure uniqueness
  const base_name = drive_item.name;
  const link_file_name = `${base_name}.gdrive.json`; // Standard suffix
  const link_file_path = path.join(content_dir, link_file_name);

  core.info(`Creating/Updating GDrive link file: ${link_file_path} for '${drive_item.name}' (ID: ${drive_item.id})`);
  try {
    // Ensure directory exists before writing
    await fs_promises.mkdir(content_dir, { recursive: true });
    await fs_promises.writeFile(link_file_path, link_file_content, { encoding: 'utf-8' });
    core.debug(` -> Link file content: ${link_file_content}`);
    return link_file_path;
  } catch (error) {
    core.error(`Failed to write link file ${link_file_path}: ${(error as Error).message}`);
    throw error; // Re-throw to indicate failure
  }
}


// Download File Content (Only for non-Google Docs - binary files)
// (No changes needed in this function itself)
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
  local_path_base: string
): Promise<{ linkFilePath: string; contentFilePath?: string }> {
  let linkFilePath: string | null = null;
  try {
    // Step 1: Always create the link file using the single, consolidated function
    linkFilePath = await create_gdrive_link_file(drive_item, local_path_base);

    // Step 2: Download content *only* if it's not a Google Doc type
    if (GOOGLE_DOC_MIME_TYPES.includes(drive_item.mimeType || "")) {
      core.info(`File '${drive_item.name}' (ID: ${drive_item.id}) is a Google Doc type. Skipping content download.`);
      return { linkFilePath }; // Only link file was created
    } else {
      core.info(`File '${drive_item.name}' (ID: ${drive_item.id}) is not a Google Doc type. Downloading content.`);
      await download_file_content(drive_item.id, local_path_base);
      return { linkFilePath, contentFilePath: local_path_base }; // Both were created/attempted
    }
  } catch (error) {
    core.error(`Failed to handle download/linking for Drive item '${drive_item.name || drive_item.id}': ${(error as Error).message}`);
    // Rethrow the error, the caller should decide how to proceed
    throw error;
  }
}


// --- upload_file (already correct from previous answer) ---
/**
 * Uploads a local file to Google Drive, skipping .gdrive.json files.
 * Can create a new file or update an existing one.
 * @param local_file_path Absolute path to the local file.
 * @param target_folder_id Drive Folder ID where the file should be uploaded.
 * @param existing_drive_file Optional info for updating an existing file.
 * @returns Object with the Drive file ID and success status.
 */
export async function upload_file(
  local_file_path: string,
  target_folder_id: string,
  existing_drive_file?: { id: string; name: string }
): Promise<{ id: string; success: boolean }> {
  const local_file_name = path.basename(local_file_path);

  // Skip uploading the .gdrive.json files themselves
  if (local_file_name.endsWith('.gdrive.json')) {
    core.info(`Skipping upload of GDrive link file: ${local_file_name}`);
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
      }
      core.info(`Updating existing file content '${local_file_name}' (ID: ${fileId}) in folder ${target_folder_id}`);
      const res = await drive.files.update({
        fileId: fileId, media: media, requestBody: Object.keys(requestBody).length > 0 ? requestBody : undefined, fields: "id, name, md5Checksum",
      });
      fileId = res.data.id!;
      core.info(`Updated file '${res.data.name}' (ID: ${fileId}). New hash: ${res.data.md5Checksum || 'N/A'}`);
    } else { // create
      core.info(`Creating new file '${local_file_name}' in folder ${target_folder_id}`);
      const res = await drive.files.create({
        requestBody: { name: local_file_name, parents: [target_folder_id] }, media: media, fields: "id, name, md5Checksum",
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
    return { id: operation === 'update' ? fileId || '' : '', success: false };
  }
}
