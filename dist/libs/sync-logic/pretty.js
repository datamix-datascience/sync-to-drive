import { MIME_TYPE_TO_EXTENSION } from "../google-drive/file_types.js";
/**
 * Formats the Pull Request body with details about synced changes.
 * Now accepts DriveItems directly for added/updated list.
 */
export function format_pr_body(folder_id, run_id, added_updated_drive_items, // Changed parameter type
removed_local_paths // Changed parameter name for clarity
) {
    const pr_body_lines = [
        `This PR syncs changes detected in Google Drive folder [${folder_id}](https://drive.google.com/drive/folders/${folder_id}).`,
        `Based on the state fetched during workflow run \`${run_id}\`.`
    ];
    // Sort added/updated items alphabetically by name
    added_updated_drive_items.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
    if (added_updated_drive_items.length > 0) {
        pr_body_lines.push(''); // Add blank line
        pr_body_lines.push('**Detected Additions/Updates in Drive:**');
        added_updated_drive_items.forEach((item) => {
            // Use webViewLink if available, otherwise just show the name/id
            const link = item.webViewLink;
            // Display name, fall back to ID if name is missing
            const extension = MIME_TYPE_TO_EXTENSION[item.mimeType];
            const name_display = `\`[${extension}] ${item.name || item.id}\``;
            const line = link ? `*   [${name_display}](${link})` : `*   ${name_display}`;
            pr_body_lines.push(line);
        });
    }
    // Sort removed paths alphabetically
    const sorted_removed_paths = Array.from(removed_local_paths).sort((a, b) => a.localeCompare(b));
    if (sorted_removed_paths.length > 0) {
        pr_body_lines.push(''); // Add blank line
        pr_body_lines.push('**Local Files/Folders Removed (Not Found in Drive):**');
        sorted_removed_paths.forEach(p => {
            pr_body_lines.push(`*   \`${p}\``); // Use backticks for code formatting
        });
    }
    pr_body_lines.push(''); // Add blank line
    pr_body_lines.push(`*Source Drive Folder ID: \`${folder_id}\`*`);
    // pr_body_lines.push(`*Workflow Run ID: ${run_id}*`); // Included in intro now
    return pr_body_lines.join('\n');
}
