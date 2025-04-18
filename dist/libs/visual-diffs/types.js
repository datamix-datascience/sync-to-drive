// Constants for Google Workspace types and PDF
export const GOOGLE_WORKSPACE_EXPORTABLE_TYPES = [
    "application/vnd.google-apps.document",
    "application/vnd.google-apps.presentation",
    "application/vnd.google-apps.spreadsheet",
    "application/vnd.google-apps.drawing",
];
export const NATIVE_PDF_TYPE = "application/pdf";
// Helper type guard for stream checking (remains the same)
export function is_readable_stream(data) {
    return (data !== null && typeof data === "object" && typeof data.pipe === "function");
}
