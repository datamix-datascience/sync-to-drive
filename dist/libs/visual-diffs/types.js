// Helper Type Guard
export function is_readable_stream(obj) {
    return obj !== null && typeof obj === 'object' && typeof obj.pipe === 'function';
}
// Constants
export const GOOGLE_DRIVE_EXPORTABLE_TO_PDF_TYPES = [
    // Google Workspace Native Types
    'application/vnd.google-apps.document', // Google Docs
    'application/vnd.google-apps.presentation', // Google Slides
    'application/vnd.google-apps.spreadsheet', // Google Sheets
    'application/vnd.google-apps.drawing', // Google Drawings
    // Microsoft Office Types
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
    'application/msword', // .doc
    'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
    'application/vnd.ms-powerpoint', // .ppt
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
    'application/vnd.ms-excel', // .xls
    // OpenDocument Types
    'application/vnd.oasis.opendocument.text', // .odt
    'application/vnd.oasis.opendocument.presentation', // .odp
    'application/vnd.oasis.opendocument.spreadsheet', // .ods
    // Other Common Types
    'text/plain', // .txt
    'application/rtf', // .rtf
];
export const NATIVE_PDF_TYPE = 'application/pdf';
