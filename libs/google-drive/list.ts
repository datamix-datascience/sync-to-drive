import * as core from "@actions/core";
import { drive, credentials_json } from "./auth.js";
import { DriveItem, DriveFile, DriveFilesListResponse, DrivePermission, DrivePermissionsListResponse } from "./types.js";
import * as path from "path";

// Define the structure for the returned files array
export interface DriveFileWithPath {
  path: string;
  item: DriveItem;
}

// List Drive Files Recursively
export async function list_drive_files_recursively(
  folder_id: string,
  base_path: string = ""
): Promise<{
  files: DriveFileWithPath[];
  folders: Map<string, DriveItem>;
}> {
  let all_files_with_paths: DriveFileWithPath[] = [];
  const folder_map = new Map<string, DriveItem>();
  let all_items: DriveFile[] = [];
  let next_page_token: string | undefined;

  core.info(`Listing items in Drive folder ID: ${folder_id} (relative path: '${base_path || '/'}')`);

  try {
    do {
      const res = await drive.files.list({
        q: `'${folder_id}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType, md5Checksum, modifiedTime, owners(emailAddress), webViewLink)", // Keep webViewLink
        spaces: "drive",
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
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
    // Calculate the relative path based on Drive structure
    const relative_path = base_path ? path.join(base_path, item.name).replace(/\\/g, '/') : item.name.replace(/\\/g, '/');
    const owned = item.owners?.some(owner => owner.emailAddress === service_account_email) || false;

    let permissions: DrivePermission[] = [];
    try {
      core.debug(`Listing permissions for item ${item.id} ('${item.name}') with supportsAllDrives: true`);
      const perm_res = await drive.permissions.list({
        fileId: item.id,
        fields: "permissions(id, role, emailAddress, pendingOwner)",
        supportsAllDrives: true,
      }) as { data: DrivePermissionsListResponse };
      permissions = perm_res.data.permissions || [];
    } catch (permError) {
      core.warning(`Could not list permissions for item ${item.id} ('${item.name}'): ${(permError as Error).message}`);
    }

    const drive_item_data: DriveItem = {
      id: item.id,
      name: item.name,
      mimeType: item.mimeType || "unknown",
      modifiedTime: item.modifiedTime!,
      hash: item.md5Checksum,
      owned,
      permissions,
      webViewLink: item.webViewLink,
    };

    if (item.mimeType === "application/vnd.google-apps.folder") {
      core.debug(`Found folder: '${relative_path}' (ID: ${item.id})`);
      // Only add to folder map if not already present (shouldn't happen with unique IDs)
      if (!folder_map.has(relative_path)) {
        folder_map.set(relative_path, drive_item_data);
      } else {
        core.debug(`Folder path '${relative_path}' already processed, skipping recursive call duplication.`);
      }
      try {
        const subfolder_data = await list_drive_files_recursively(item.id, relative_path);
        // Merge results: Append files, merge folders
        all_files_with_paths = all_files_with_paths.concat(subfolder_data.files); // <-- Append to array
        subfolder_data.folders.forEach((value, key) => {
          if (!folder_map.has(key)) { // Prevent overwriting parent folder entries if names clash across levels
            folder_map.set(key, value)
          }
        });
      } catch (recursiveError) {
        core.error(`Error processing subfolder ${item.id} ('${item.name}'): ${(recursiveError as Error).message}. Skipping subtree.`);
      }
    } else {
      // It's a file, add it to the file array
      all_files_with_paths.push({ path: relative_path, item: drive_item_data }); // <-- Add object to array
    }
  }
  return { files: all_files_with_paths, folders: folder_map }; // <-- Return array
}
