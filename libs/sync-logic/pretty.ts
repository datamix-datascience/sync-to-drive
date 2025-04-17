import { SuccessfullyProcessedItem } from "./types.js";

/**
 * Formats the Pull Request body with details about synced changes.
 */
export function format_pr_body(
  folder_id: string,
  run_id: string,
  added_updated_items: SuccessfullyProcessedItem[],
  removed_paths: Set<string>
): string {
  const pr_body_lines: string[] = [
    `This PR syncs changes detected in Google Drive folder [${folder_id}](https://drive.google.com/drive/folders/${folder_id}).`,
  ];

  // Sort added/updated items alphabetically by path
  added_updated_items.sort((a, b) => a.path.localeCompare(b.path));

  if (added_updated_items.length > 0) {
    pr_body_lines.push(''); // Add blank line
    pr_body_lines.push('**Added/Updated:**');
    added_updated_items.forEach(({ path, item }) => {
      // Use webViewLink if available, otherwise just show the path
      const link = item.webViewLink;
      const path_display = `\`${path}\``; // Use backticks for code formatting
      const line = link ? `*   [${path_display}](${link})` : `*   ${path_display}`;
      pr_body_lines.push(line);
    });
  }

  // Sort removed paths alphabetically
  const sorted_removed_paths = Array.from(removed_paths).sort((a, b) => a.localeCompare(b));

  if (sorted_removed_paths.length > 0) {
    pr_body_lines.push(''); // Add blank line
    pr_body_lines.push('**Removed:**');
    sorted_removed_paths.forEach(p => {
      pr_body_lines.push(`*   \`${p}\``); // Use backticks for code formatting
    });
  }

  pr_body_lines.push(''); // Add blank line
  pr_body_lines.push(`*Source Drive Folder ID: ${folder_id}*`);
  pr_body_lines.push(`*Workflow Run ID: ${run_id}*`);

  return pr_body_lines.join('\n');
}
