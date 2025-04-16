// Helper Type Guard (moved here for locality)
export function is_readable_stream(obj) {
    return obj !== null && typeof obj === 'object' && typeof obj.pipe === 'function';
}
// Constants (moved here for locality)
export const GOOGLE_WORKSPACE_EXPORTABLE_TYPES = [
    'application/vnd.google-apps.document',
    'application/vnd.google-apps.presentation',
    'application/vnd.google-apps.spreadsheet',
    'application/vnd.google-apps.drawing',
];
export const NATIVE_PDF_TYPE = 'application/pdf';
