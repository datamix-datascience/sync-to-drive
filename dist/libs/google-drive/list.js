import * as core from "@actions/core";
import { drive, credentials_json } from "./auth.js";
import * as path from "path";
// List Drive Files Recursively
export async function list_drive_files_recursively(folder_id, base_path = "") {
    const file_map = new Map();
    const folder_map = new Map();
    let all_items = [];
    let next_page_token;
    core.info(`Listing items in Drive folder ID: ${folder_id} (relative path: '${base_path || '/'}')`);
    try {
        do {
            const res = await drive.files.list({
                q: `'${folder_id}' in parents and trashed = false`,
                fields: "nextPageToken, files(id, name, mimeType, md5Checksum, owners(emailAddress))",
                spaces: "drive",
                pageToken: next_page_token,
                pageSize: 1000,
            });
            all_items = all_items.concat(res.data.files || []);
            next_page_token = res.data.nextPageToken;
            core.debug(`Fetched page of items from folder ${folder_id}. Next page token: ${next_page_token ? 'yes' : 'no'}`);
        } while (next_page_token);
    }
    catch (error) {
        core.error(`Failed to list files in Drive folder ${folder_id}: ${error.message}`);
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
        let permissions = [];
        try {
            const perm_res = await drive.permissions.list({
                fileId: item.id,
                fields: "permissions(id, role, emailAddress, pendingOwner)",
            });
            permissions = perm_res.data.permissions || [];
        }
        catch (permError) {
            core.warning(`Could not list permissions for item ${item.id} ('${item.name}'): ${permError.message}`);
            // Continue processing the item even if permissions fail
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
            }
            catch (recursiveError) {
                core.error(`Error processing subfolder ${item.id} ('${item.name}'): ${recursiveError.message}. Skipping subtree.`);
                // Continue processing other items in the current folder
            }
        }
        else {
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
