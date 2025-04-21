import { MIME_TYPE_TO_EXTENSION } from "../google-drive/file_types.js";
/**
 * Gets a safe, short label representing the MIME type, suitable for display.
 * Prioritizes known extensions, falls back to the part after the last '/',
 * and sanitizes the result. Uses snake_case internally.
 * @param mime_type The MIME type string.
 * @returns A safe string label (e.g., "doc", "pdf", "spreadsheet", "unknown").
 */
function get_safe_mime_type_label(mime_type) {
    if (!mime_type) {
        return "unknown";
    }
    // 1. Check known extensions first
    const known_extension = MIME_TYPE_TO_EXTENSION[mime_type];
    if (known_extension) {
        return known_extension;
    }
    // 2. Fallback: Extract part after last '/' and sanitize
    const last_slash_index = mime_type.lastIndexOf('/');
    let fallback_label = mime_type;
    if (last_slash_index !== -1 && last_slash_index < mime_type.length - 1) {
        fallback_label = mime_type.substring(last_slash_index + 1);
    }
    // Sanitize: Replace common problematic characters and patterns
    fallback_label = fallback_label
        .replace(/^vnd\.google-apps\./, '') // Remove common prefix
        .replace(/[^a-zA-Z0-9._-]/g, '_') // Replace non-alphanumeric (allow . _ -) with _
        .toLowerCase(); // Consistent casing
    // Return sanitized fallback, or 'file' if somehow empty
    return fallback_label || "file";
}
/**
 * Formats the Pull Request body with details about synced changes using snake_case.
 */
export function format_pr_body(folder_id, run_id, added_updated_drive_items, removed_local_paths) {
    const pr_body_lines = [
        `This PR syncs changes detected in Google Drive folder [${folder_id}](https://drive.google.com/drive/folders/${folder_id}).`,
        `Based on the state fetched during workflow run \`${run_id}\`.`
    ];
    // Sort added/updated items alphabetically by name (using DriveItem's camelCase properties)
    added_updated_drive_items.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
    if (added_updated_drive_items.length > 0) {
        pr_body_lines.push(''); // Add blank line
        pr_body_lines.push('**Detected Additions/Updates in Drive:**');
        added_updated_drive_items.forEach((item) => {
            const link = item.webViewLink; // Keep camelCase from DriveItem
            const extension_label = get_safe_mime_type_label(item.mimeType); // Call snake_case helper
            const name_display = `\`[${extension_label}] ${item.name || item.id}\``;
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
    return pr_body_lines.join('\n');
}
