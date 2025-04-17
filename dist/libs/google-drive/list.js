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
                // *** Add 'webViewLink' to the requested fields ***
                fields: "nextPageToken, files(id, name, mimeType, md5Checksum, modifiedTime, owners(emailAddress), webViewLink)",
                spaces: "drive",
                pageToken: next_page_token,
                pageSize: 1000, // Fetch up to 1000 items per request
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
        // Check for required fields (ID and name are crucial)
        if (!item.name || !item.id) {
            core.warning(`Skipping item with missing name or ID in folder ${folder_id}. Data: ${JSON.stringify(item)}`);
            continue;
        }
        const relative_path = base_path ? path.join(base_path, item.name).replace(/\\/g, '/') : item.name.replace(/\\/g, '/');
        // Check ownership based on the owners field returned by the API
        const owned = item.owners?.some(owner => owner.emailAddress === service_account_email) || false;
        let permissions = [];
        try {
            // Fetch permissions separately if needed (e.g., for ownership transfer logic)
            // Note: Getting permissions for every item can significantly increase API calls.
            // Consider fetching them only when ownership is unknown or relevant for an action.
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
        const drive_item_data = {
            id: item.id,
            name: item.name,
            mimeType: item.mimeType || "unknown", // Ensure mimeType is always a string
            modifiedTime: item.modifiedTime, // Assume modifiedTime exists based on fields requested
            hash: item.md5Checksum, // md5Checksum (may be null for Google Docs etc)
            owned,
            permissions,
            // *** Assign the webViewLink from the API response ***
            webViewLink: item.webViewLink, // Will be undefined if not returned by API
        };
        if (item.mimeType === "application/vnd.google-apps.folder") {
            core.debug(`Found folder: '${relative_path}' (ID: ${item.id})`);
            folder_map.set(relative_path, drive_item_data);
            try {
                // Recursively list content of the subfolder
                const subfolder_data = await list_drive_files_recursively(item.id, relative_path);
                // Merge results from the subfolder into the main maps
                subfolder_data.files.forEach((value, key) => file_map.set(key, value));
                subfolder_data.folders.forEach((value, key) => folder_map.set(key, value));
            }
            catch (recursiveError) {
                core.error(`Error processing subfolder ${item.id} ('${item.name}'): ${recursiveError.message}. Skipping subtree.`);
                // Continue processing other items in the current folder
            }
        }
        else {
            // It's a file, add it to the file map
            file_map.set(relative_path, drive_item_data);
        }
    }
    return { files: file_map, folders: folder_map };
}
