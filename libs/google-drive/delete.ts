import * as core from "@actions/core";
import { drive } from "./auth.js";

// Delete Untracked (Moves to Trash)
export async function delete_untracked(id: string, name: string, is_folder: boolean = false): Promise<boolean> {
  const item_type = is_folder ? "folder" : "file";
  core.info(`Attempting to move ${item_type} to Trash: '${name}' (ID: ${id})`);
  try {
    await drive.files.update({
      fileId: id,
      requestBody: { trashed: true },
      supportsAllDrives: true,
      // Add fields to potentially get confirmation, although not strictly necessary
      // fields: "id, name, trashed"
    });
    core.info(`Moved untracked ${item_type} to Trash: ${name} (ID: ${id})`);
    return true;
  } catch (error: unknown) {
    const err = error as any;
    // Handle specific errors
    if (err.code === 403) {
      core.error(`Permission denied trying to trash ${item_type} '${name}' (ID: ${id}). Service account needs 'writer' or 'owner' role.`);
    } else if (err.code === 404) {
      // This is not necessarily an error in the context of untracked items
      core.warning(`Untracked ${item_type} '${name}' (ID: ${id}) not found, possibly already deleted or moved.`);
      return true; // Consider it success if it's already gone
    } else {
      core.warning(`Failed to trash untracked ${item_type} '${name}' (ID: ${id}): ${err.message}`);
    }
    // Log API details if available
    if (err.response?.data) {
      core.warning(`API Error Details: ${JSON.stringify(err.response.data)}`);
    }
    return false; // Indicate failure
  }
}
