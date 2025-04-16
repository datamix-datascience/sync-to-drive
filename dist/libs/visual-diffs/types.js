"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NATIVE_PDF_TYPE = exports.GOOGLE_WORKSPACE_EXPORTABLE_TYPES = void 0;
exports.is_readable_stream = is_readable_stream;
// Helper Type Guard (moved here for locality)
function is_readable_stream(obj) {
    return obj !== null && typeof obj === 'object' && typeof obj.pipe === 'function';
}
// Constants (moved here for locality)
exports.GOOGLE_WORKSPACE_EXPORTABLE_TYPES = [
    'application/vnd.google-apps.document',
    'application/vnd.google-apps.presentation',
    'application/vnd.google-apps.spreadsheet',
    'application/vnd.google-apps.drawing',
];
exports.NATIVE_PDF_TYPE = 'application/pdf';
