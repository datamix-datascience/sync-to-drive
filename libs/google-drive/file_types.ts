import {
  GOOGLE_DRIVE_EXPORTABLE_TO_PDF_TYPES,
  NATIVE_PDF_TYPE,
} from "../visual-diffs/types.js";

export const GOOGLE_DOC_MIME_TYPES = [
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
  "application/vnd.google-apps.drawing",
  "application/vnd.google-apps.script",
  // Export as PDF not support
  "application/vnd.google-apps.form",
  "application/vnd.google-apps.fusiontable",
  "application/vnd.google-apps.site",
  "application/vnd.google-apps.map",
  "application/vnd.google-apps.vid", // Google Vids (link-only)
  "application/vnd.google-apps.video", // Generic Google Video (link-only)
  // Common Video Types (link-only)
  "video/mp4",
  "video/mpeg",
  "video/quicktime", // .mov
  "video/webm",
  "video/x-msvideo", // .avi
  "video/x-matroska", // .mkv
  // Common Audio Types (link-only)
  "audio/aac",
  "audio/mpeg", // .mp3
  "audio/wav",
  "audio/ogg",
  "audio/flac",
  // Common Compressed Types (link-only)
  "application/zip",
  "application/vnd.rar",
  "application/x-7z-compressed",
  "application/gzip",
  "application/x-bzip2",
  "application/x-tar",
  "application/java-archive", // .jar
  "application/epub+zip",
];

export const MIME_TYPE_TO_EXTENSION: { [mime_type: string]: string } = {
  // Google App Types
  "application/vnd.google-apps.document": "doc",
  "application/vnd.google-apps.spreadsheet": "sheet",
  "application/vnd.google-apps.presentation": "slides",
  "application/vnd.google-apps.form": "form",
  "application/vnd.google-apps.drawing": "drawing",
  "application/vnd.google-apps.script": "script",
  "application/vnd.google-apps.fusiontable": "fusiontable",
  "application/vnd.google-apps.site": "site",
  "application/vnd.google-apps.map": "map",
  "application/vnd.google-apps.script+json": "json", // Apps Script JSON export
  "application/vnd.google-apps.vid": "mp4", // Google Vids export

  // Common Export/Download Types from Google Workspace Docs
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/rtf": "rtf",
  "text/plain": "txt",
  "application/zip": "zip", // Used for HTML exports
  "application/epub+zip": "epub",
  "text/markdown": "md",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/x-vnd.oasis.opendocument.spreadsheet": "ods",
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",

  // Video, Audio, and Compressed file types (often treated as link-only)
  "application/vnd.google-apps.video": "video",
  "video/mp4": "mp4",
  "video/mpeg": "mpeg",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-msvideo": "avi",
  "video/x-matroska": "mkv",
  "audio/aac": "aac",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "application/vnd.rar": "rar",
  "application/x-7z-compressed": "7z",
  "application/gzip": "gz",
  "application/x-bzip2": "bz2",
  "application/x-tar": "tar",
  "application/java-archive": "jar",

  // Notebooks
  "application/vnd.google.colaboratory": "ipynb",
};

// Define which types should have a .gdrive.json link file created.
// This should include Google Docs (only link), PDFs (link + content),
// AND other office/exportable types (link + content) if we want visual diffs for them.
export const LINK_FILE_MIME_TYPES = [
  ...GOOGLE_DOC_MIME_TYPES, // Create link files for Google types (no content download)
  ...GOOGLE_DRIVE_EXPORTABLE_TO_PDF_TYPES.filter(
    (type) => !GOOGLE_DOC_MIME_TYPES.includes(type),
  ), // Add exportable types like DOCX, PPTX etc. (link + content download)
  NATIVE_PDF_TYPE, // Ensure native PDF is included (link + content download)
];

/**
 * Gets the type-specific extension suffix for a link file (e.g., ".doc.gdrive.json").
 * @param mime_type The MIME type of the Drive file.
 * @returns The suffix string including the leading dot.
 */
function get_link_type_suffix(mime_type: string | undefined): string {
  if (!mime_type) return ".gdrive.json"; // Fallback for unknown type
  const extension = MIME_TYPE_TO_EXTENSION[mime_type];
  return extension ? `.${extension}.gdrive.json` : ".gdrive.json";
}

/**
 * Constructs the full unique link file name using the Drive file ID.
 * Format: [base_name]--[file_id].[type_extension].gdrive.json
 * @param base_name Original base name of the file (without type extension).
 * @param file_id The Google Drive file ID.
 * @param mime_type The MIME type of the Drive file.
 * @returns The constructed link file name string.
 */
export function construct_link_file_name(
  base_name: string,
  file_id: string,
  mime_type: string | undefined,
): string {
  const type_suffix = get_link_type_suffix(mime_type); // Gets e.g., ".doc.gdrive.json"
  // Sanitize base_name slightly (replace multiple dashes potentially caused by ID format) - might need refinement
  // Keep file_id as is, assuming it's URL-safe enough for filenames.
  const safe_base_name = base_name.replace(/--+/g, "-");
  return `${safe_base_name}--${file_id}${type_suffix}`;
}

/**
 * Generates the appropriate suffix for a .gdrive link file based on MIME type.
 * e.g., ".doc.gdrive.json", ".pdf.gdrive.json"
 * Falls back to ".gdrive.json" if the type is unknown or not mapped.
 * @param mime_type The MIME type of the Drive file.
 * @returns The file suffix string.
 * @deprecated Use construct_link_file_name for full name generation. Use get_link_type_suffix internally if needed.
 */
export function get_link_file_suffix(mime_type: string | undefined): string {
  return get_link_type_suffix(mime_type);
}
