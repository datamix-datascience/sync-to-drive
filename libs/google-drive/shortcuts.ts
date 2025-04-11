import * as core from "@actions/core";
import * as fs_promises from "fs/promises";
import * as path from "path";
import { DriveItem } from "./types";

export const GOOGLE_DOC_MIME_TYPES = [
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
  "application/vnd.google-apps.form",
  "application/vnd.google-apps.drawing",
  "application/vnd.google-apps.script",
  "application/vnd.google-apps.fusiontable",
  "application/vnd.google-apps.site",
  "application/vnd.google-apps.map"
];

export const MIME_TYPE_TO_EXTENSION: { [mimeType: string]: string } = {
  "application/vnd.google-apps.document": "document",
  "application/vnd.google-apps.spreadsheet": "sheet",
  "application/vnd.google-apps.presentation": "presentation",
  "application/vnd.google-apps.form": "form",
  "application/vnd.google-apps.drawing": "drawing",
  "application/vnd.google-apps.script": "script",
  "application/vnd.google-apps.fusiontable": "fusiontable",
  "application/vnd.google-apps.site": "site",
  "application/vnd.google-apps.map": "map"
};

export async function create_google_doc_shortcut_file(drive_item: DriveItem, local_path: string): Promise<string> { // Return the created path
  const file_name = path.basename(local_path);
  const file_extension = path.extname(local_path);
  const base_name = path.basename(local_path, file_extension);

  const shortcut_data = {
    type: drive_item.mimeType,
    drive_url: `https://drive.google.com/drive/d/${drive_item.id}/view?usp=sharing`,
    drive_file_id: drive_item.id,
    mime_type: drive_item.mimeType,
    description: "This file is a shortcut to a Google Drive document. To view or edit the document, open the Drive URL in a web browser."
  };
  const shortcut_file_content = JSON.stringify(shortcut_data, null, 2);

  const type_extension = MIME_TYPE_TO_EXTENSION[drive_item.mimeType!] || 'googledoc';
  // Important: Construct the shortcut name based on the *original* base name, not necessarily the input `local_path`'s base name
  // This handles cases where local_path might already *be* a shortcut filename.
  const drive_base_name = drive_item.name; // Use name from Drive
  const shortcut_file_name = `${drive_base_name}.${type_extension}.json.txt`;
  // Place it in the directory derived from the input `local_path`
  const shortcut_file_path = path.join(path.dirname(local_path), shortcut_file_name);

  core.info(`Creating Google Doc shortcut file: ${shortcut_file_path} for '${drive_item.name}' (Drive ID: ${drive_item.id})`);
  await fs_promises.writeFile(shortcut_file_path, shortcut_file_content, { encoding: 'utf-8' });
  return shortcut_file_path; // Return the actual path created
}
