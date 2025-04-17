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
export const MIME_TYPE_TO_EXTENSION = {
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
 * Generates the appropriate suffix for a .gdrive link file based on MIME type.
 * e.g., ".doc.gdrive.json", ".pdf.gdrive.json"
 * Falls back to ".gdrive.json" if the type is unknown or not mapped.
 * @param mime_type The MIME type of the Drive file.
 * @returns The file suffix string.
 */
export function get_link_file_suffix(mime_type) {
    if (!mime_type)
        return '.gdrive.json'; // Fallback for unknown type
    const extension = MIME_TYPE_TO_EXTENSION[mime_type];
    if (extension) {
        return `.${extension}.gdrive.json`;
    }
    // If it's a type that needs a link file but isn't explicitly mapped, use default.
    // This shouldn't happen if LINK_FILE_MIME_TYPES and the map are consistent.
    return '.gdrive.json';
}
