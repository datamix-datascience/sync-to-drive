export const GOOGLE_DOC_MIME_TYPES = [
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
  "application/vnd.google-apps.drawing",
  "application/vnd.google-apps.script",
  // not PDFable?
  "application/vnd.google-apps.form",
  "application/vnd.google-apps.fusiontable",
  "application/vnd.google-apps.site",
  "application/vnd.google-apps.map"
];

export const MIME_TYPE_TO_EXTENSION: { [mimeType: string]: string } = {
  "application/vnd.google-apps.document": "doc",
  "application/vnd.google-apps.spreadsheet": "sheet",
  "application/vnd.google-apps.presentation": "slides",
  "application/vnd.google-apps.form": "form",
  "application/vnd.google-apps.drawing": "drawing",
  "application/vnd.google-apps.script": "script",
  "application/vnd.google-apps.fusiontable": "fusiontable",
  "application/vnd.google-apps.site": "site",
  "application/vnd.google-apps.map": "map",
  "application/pdf": "pdf"
};

export const LINK_FILE_MIME_TYPES = [
  ...GOOGLE_DOC_MIME_TYPES,
  "application/pdf"
];

/**
 * Gets the type-specific extension suffix for a link file (e.g., ".doc.gdrive.json").
 * @param mime_type The MIME type of the Drive file.
 * @returns The suffix string including the leading dot.
 */
function get_link_type_suffix(mime_type: string | undefined): string {
  if (!mime_type) return '.gdrive.json'; // Fallback for unknown type
  const extension = MIME_TYPE_TO_EXTENSION[mime_type];
  return extension ? `.${extension}.gdrive.json` : '.gdrive.json';
}

/**
 * Constructs the full unique link file name using the Drive file ID.
 * Format: [base_name]--[file_id].[type_extension].gdrive.json
 * @param base_name Original base name of the file (without type extension).
 * @param file_id The Google Drive file ID.
 * @param mime_type The MIME type of the Drive file.
 * @returns The constructed link file name string.
 */
export function construct_link_file_name(base_name: string, file_id: string, mime_type: string | undefined): string {
  const type_suffix = get_link_type_suffix(mime_type); // Gets e.g., ".doc.gdrive.json"
  // Sanitize base_name slightly (replace multiple dashes potentially caused by ID format) - might need refinement
  // Keep file_id as is, assuming it's URL-safe enough for filenames.
  const safe_base_name = base_name.replace(/--+/g, '-');
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
