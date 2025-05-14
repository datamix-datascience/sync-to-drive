import * as core from "@actions/core";
import { drive, credentials_json } from "./auth.js";
// Track ownership transfer requests (keep state within this module)
const ownership_transfer_requested_ids = new Set();
export function has_pending_transfer_request(file_id) {
    return ownership_transfer_requested_ids.has(file_id);
}
// Accept Pending Ownership Transfers (Recursive)
export async function accept_ownership_transfers(file_id) {
    try {
        let permissions = [];
        let next_page_token;
        // --- 1. List permissions for the current item ---
        core.debug(`Checking permissions for item ${file_id} to accept ownership.`);
        do {
            const res = await drive.permissions.list({
                fileId: file_id,
                fields: "nextPageToken, permissions(id, role, emailAddress, pendingOwner)",
                pageToken: next_page_token,
            });
            permissions = permissions.concat(res.data.permissions || []);
            next_page_token = res.data.nextPageToken;
        } while (next_page_token);
        // --- 2. Find pending transfers for the service account ---
        const service_account_email = credentials_json.client_email;
        const pending_permissions = permissions.filter(p => p.emailAddress === service_account_email && p.pendingOwner);
        // --- 3. Accept each pending transfer ---
        for (const perm of pending_permissions) {
            core.info(`Accepting ownership transfer for item ${file_id}, permission ID: ${perm.id}`);
            try {
                const updated_permission = await drive.permissions.update({
                    fileId: file_id,
                    permissionId: perm.id,
                    // Transfer ownership needs an empty request body when accepting
                    requestBody: { role: 'owner' },
                    transferOwnership: true, // The key parameter
                    fields: "id, role, pendingOwner", // Request fields for confirmation
                });
                core.info(`Ownership acceptance call returned for item ${file_id}. New Role: ${updated_permission.data.role}, Pending: ${updated_permission.data.pendingOwner}`);
                if (updated_permission.data.role === 'owner' && !updated_permission.data.pendingOwner) {
                    core.info(`Ownership confirmed accepted for item ${file_id}`);
                    ownership_transfer_requested_ids.delete(file_id); // Remove from pending set
                }
                else {
                    core.warning(`Ownership acceptance might not be complete for ${file_id}. Role: ${updated_permission.data.role}, Pending: ${updated_permission.data.pendingOwner}`);
                }
            }
            catch (updateError) {
                core.warning(`Failed to accept ownership for item ${file_id} (Permission ${perm.id}): ${updateError.message}`);
                // Continue to check other permissions or children
            }
        }
        // --- 4. Check children recursively ONLY if the current item is a folder ---
        core.debug(`Checking if item ${file_id} is a folder for recursive ownership check...`);
        const file_meta = await drive.files.get({ fileId: file_id, fields: 'id, name, mimeType', supportsAllDrives: true });
        if (file_meta.data.mimeType === 'application/vnd.google-apps.folder') {
            core.debug(`Item '${file_meta.data.name}' (${file_id}) is a folder. Checking its children.`);
            let children_page_token;
            do {
                const children_res = await drive.files.list({
                    q: `'${file_id}' in parents and trashed = false`,
                    fields: "nextPageToken, files(id, name, mimeType)", // Only need ID and type
                    pageToken: children_page_token,
                    pageSize: 500, // Process children in batches
                    includeItemsFromAllDrives: true,
                    supportsAllDrives: true,
                });
                for (const child of children_res.data.files || []) {
                    if (child.id) {
                        core.debug(`Recursively checking ownership for child '${child.name}' (${child.id})`);
                        await accept_ownership_transfers(child.id); // Recursive call
                    }
                }
                children_page_token = children_res.data.nextPageToken || undefined;
            } while (children_page_token);
        }
        else {
            core.debug(`Item '${file_meta.data.name}' (${file_id}) is not a folder. Skipping child check.`);
        }
    }
    catch (error) {
        const err = error;
        // Reduce noise for common "not found" or permission errors during recursive checks
        if (err.code === 404) {
            core.debug(`Skipping ownership transfer check for item ${file_id} (Not Found): ${err.message}`);
        }
        else if (err.code === 403) {
            core.debug(`Skipping ownership transfer check for item ${file_id} (Permission Denied): ${err.message}`);
        }
        else {
            core.warning(`Failed to process ownership transfers for item ${file_id}: ${err.message}`);
            if (err.response?.data) {
                core.warning(`API Error Details: ${JSON.stringify(err.response.data)}`);
            }
        }
        // Don't re-throw here, allow the process to continue if possible
    }
}
// Request Ownership Transfer
export async function request_ownership_transfer(file_id, current_owner_email) {
    // Avoid spamming requests if one is already considered pending
    if (ownership_transfer_requested_ids.has(file_id)) {
        core.info(`Ownership transfer already requested for item ${file_id}. Skipping.`);
        return;
    }
    try {
        const service_account_email = credentials_json.client_email;
        // First, check if the service account already has *any* permission
        // This helps avoid errors if it's already an editor/viewer
        let existing_permission_id = null;
        try {
            const list_res = await drive.permissions.list({
                fileId: file_id,
                fields: "permissions(id, emailAddress)",
            });
            existing_permission_id = list_res.data.permissions?.find(p => p.emailAddress === service_account_email)?.id || null;
        }
        catch (listError) {
            core.debug(`Could not pre-check permissions for ${file_id} before transfer request: ${listError.message}`);
        }
        core.info(`Requesting ownership transfer of item ${file_id} from ${current_owner_email} to ${service_account_email}`);
        if (existing_permission_id) {
            // If SA already has a role, UPDATE the permission to request ownership
            core.debug(`Service account has existing permission (${existing_permission_id}). Updating role to 'owner' and requesting transfer.`);
            await drive.permissions.update({
                fileId: file_id,
                permissionId: existing_permission_id,
                requestBody: { role: "owner" }, // Just specify the target role
                transferOwnership: true,
                fields: "id, role, pendingOwner", // Request fields for confirmation
            });
        }
        else {
            // If SA has no role, CREATE a new permission requesting ownership
            core.debug(`Service account has no existing permission. Creating permission with role 'owner' and requesting transfer.`);
            await drive.permissions.create({
                fileId: file_id,
                requestBody: {
                    role: "owner",
                    type: "user",
                    emailAddress: service_account_email,
                },
                transferOwnership: true,
                sendNotificationEmail: true, // Keep notification for the owner
                emailMessage: `Automated Sync: Please approve ownership transfer of this item to the sync service (${service_account_email}) for management via GitHub Actions. Item ID: ${file_id}`,
                fields: "id, role, pendingOwner", // Request fields for confirmation
            });
        }
        core.info(`Ownership transfer request initiated for item ${file_id}. Owner (${current_owner_email}) needs to approve.`);
        ownership_transfer_requested_ids.add(file_id); // Mark as requested
    }
    catch (error) {
        const err = error;
        // Handle specific, informative errors
        if (err.code === 400 && err.message?.includes('cannot be transferred')) {
            core.error(`Failed to request ownership transfer for item ${file_id}: Transfer is not permitted for this file type or by domain policy.`);
        }
        else if (err.code === 403 && err.message?.includes('permission to transfer ownership')) {
            core.error(`Failed to request ownership transfer for item ${file_id}: Service account lacks permission to initiate transfer (needs editor access first?) or owner domain prevents transfers.`);
        }
        else if (err.code === 400 && err.message?.includes('invalid sharing request')) {
            // This might happen if the target email is wrong, but JWT should be correct
            core.error(`Failed to request ownership transfer for item ${file_id}: Invalid request (check service account email?).`);
        }
        else {
            core.warning(`Failed to request ownership transfer for item ${file_id}: ${err.message}`);
        }
        if (err.response?.data) {
            core.warning(`API Error Details: ${JSON.stringify(err.response.data)}`);
        }
        // Do not re-throw, allow sync to continue with other items
    }
}
