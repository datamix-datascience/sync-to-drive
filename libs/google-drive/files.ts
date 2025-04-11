import * as core from "@actions/core";
import * as fs from "fs";
import * as fs_promises from "fs/promises";
import * as path from "path";
import { drive } from "./auth";
import { DriveItem } from "./types";
import {
  create_google_doc_shortcut_file,
  GOOGLE_DOC_MIME_TYPES,
  MIME_TYPE_TO_EXTENSION
} from "./shortcuts";


// Download File Content (Only for non-Google Docs - binary files)
async function download_file_content(file_id: string, local_path: string): Promise<void> {
  core.info(`Downloading Drive file ID ${file_id} to local path ${local_path}`);
  try {
    const dir = path.dirname(local_path);
    await fs_promises.mkdir(dir, { recursive: true }); // Ensure directory exists

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
          // Attempt to clean up partial file
          fs.unlink(local_path, unlinkErr => {
            if (unlinkErr && unlinkErr.code !== 'ENOENT') { // Ignore if already gone
              core.warning(`Failed to clean up partial download ${local_path}: ${unlinkErr.message}`);
            }
            reject(err); // Reject with the original download error
          });
        });
    });
  } catch (error) {
    const err = error as any;
    // Provide more specific error messages
    if (err.code === 404) {
      core.error(`Failed to download file ${file_id}: File not found in Google Drive.`);
    } else if (err.code === 403) {
      core.error(`Failed to download file ${file_id}: Permission denied. Check service account access to this file.`);
    } else if (err.message?.includes('downloading Google Docs')) {
      // This error might occur if trying alt=media on a GDoc
      core.error(`Failed to download file ${file_id}: Cannot directly download Google Docs format. Use export API if needed, or handle as shortcut.`);
    }
    else {
      core.error(`Failed to download file ${file_id}: ${err.message}`);
    }
    if (err.response?.data) {
      core.error(`API Error Details: ${JSON.stringify(err.response.data)}`);
    }
    throw error; // Re-throw
  }
}


// Download Item (Handles both regular files and Google Docs as shortcuts)
export async function handle_download_item(drive_item: DriveItem, local_path_base: string): Promise<string> { // Return the path of the file created/downloaded
  if (GOOGLE_DOC_MIME_TYPES.includes(drive_item.mimeType || "")) {
    core.info(`File '${drive_item.name}' (ID: ${drive_item.id}) is a Google Doc type. Creating shortcut file.`);
    // Use the drive_item name and local_path_base directory
    return await create_google_doc_shortcut_file(drive_item, local_path_base);
  } else {
    // For regular files, the local path IS local_path_base
    await download_file_content(drive_item.id, local_path_base);
    return local_path_base; // Return the path where the file was downloaded
  }
}


// Upload File
export async function upload_file(
  local_file_path: string,
  target_folder_id: string,
  existing_drive_file?: { id: string; name: string } // Pass existing ID and name if updating
): Promise<{ id: string; success: boolean }> {
  const local_file_name = path.basename(local_file_path);

  // Skip uploading placeholder shortcut files that might exist locally
  // Check if the *local* file name matches the shortcut pattern
  const shortcut_match = local_file_name.match(/^(.*)\.([a-zA-Z]+)\.json\.txt$/);
  if (shortcut_match && GOOGLE_DOC_MIME_TYPES.some(mime => MIME_TYPE_TO_EXTENSION[mime] === shortcut_match[2])) {
    core.info(`Skipping upload of local Google Doc shortcut file: ${local_file_name}`);
    // Return existing ID if provided (might be needed for potential rename later), otherwise empty string
    return { id: existing_drive_file?.id || '', success: true };
  }


  const media = { body: fs.createReadStream(local_file_path) };
  let fileId = existing_drive_file?.id;
  let operation: 'update' | 'create' = existing_drive_file?.id ? 'update' : 'create';

  try {
    if (operation === 'update' && fileId) {
      const requestBody: { name?: string } = {};
      // Use the local filename for the update, ensure Drive matches local name
      if (existing_drive_file!.name !== local_file_name) {
        requestBody.name = local_file_name;
        core.info(`Updating file name for '${existing_drive_file!.name}' to '${local_file_name}' (ID: ${fileId})`);
      }

      core.info(`Updating existing file content '${local_file_name}' (ID: ${fileId}) in folder ${target_folder_id}`);
      const res = await drive.files.update({
        fileId: fileId,
        media: media,
        requestBody: Object.keys(requestBody).length > 0 ? requestBody : undefined, // Only include requestBody if name changes
        fields: "id, name, md5Checksum", // Request fields needed
      });
      fileId = res.data.id!; // Should be the same, but confirm
      core.info(`Updated file '${res.data.name}' (ID: ${fileId}). New hash: ${res.data.md5Checksum || 'N/A'}`);

    } else { // operation === 'create'
      core.info(`Creating new file '${local_file_name}' in folder ${target_folder_id}`);
      const res = await drive.files.create({
        requestBody: {
          name: local_file_name,
          parents: [target_folder_id]
        },
        media: media,
        fields: "id, name, md5Checksum", // Request fields needed
      });
      if (!res.data.id) {
        throw new Error(`File creation API call did not return an ID for '${local_file_name}'. Response: ${JSON.stringify(res.data)}`);
      }
      fileId = res.data.id;
      core.info(`Uploaded file '${res.data.name}' (ID: ${fileId}). Hash: ${res.data.md5Checksum || 'N/A'}`);
    }
    return { id: fileId!, success: true };

  } catch (error: unknown) {
    const err = error as any;
    core.warning(`Failed to ${operation} file '${local_file_name}' in folder ${target_folder_id}: ${err.message}`);
    if (err.response?.data) {
      core.warning(`API Error Details: ${JSON.stringify(err.response.data)}`);
    }
    // Return existing ID if update failed, empty if create failed
    return { id: operation === 'update' ? fileId || '' : '', success: false };
  }
}
