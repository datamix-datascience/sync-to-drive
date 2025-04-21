// Helper Type Guard (moved here for locality)
export function is_readable_stream(obj) {
  return obj !== null && typeof obj === 'object' && typeof obj.pipe === 'function';
}
// Constants (moved here for locality)
export const GOOGLE_WORKSPACE_EXPORTABLE_TYPES = [
  // Common formats
  'application/pdf',
  'text/plain', // Often for notes or basic text extraction

  // Document specific (from application/vnd.google-apps.document)
  'application/rtf',
  'application/vnd.oasis.opendocument.text', // ODT
  'text/html',
  'application/epub+zip', // EPUB
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // DOCX
  'application/zip', // For exporting HTML with assets

  // Presentation specific (from application/vnd.google-apps.presentation)
  'application/vnd.oasis.opendocument.presentation', // ODP
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // PPTX
  // Note: Exporting slides as images (JPEG, PNG, SVG) often requires specific slide IDs/parameters in the API call,
  // but these are the target MIME types.
  'image/jpeg',
  'image/png',
  'image/svg+xml',

  // Spreadsheet specific (from application/vnd.google-apps.spreadsheet)
  'application/vnd.oasis.opendocument.spreadsheet', // ODS
  'text/tab-separated-values', // TSV
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // XLSX
  'text/csv',
  // 'application/zip', // For exporting sheets as HTML zipped

  // Drawing specific (from application/vnd.google-apps.drawing)
  'image/jpeg',
  'image/png',
  'image/svg+xml',

  // Apps Script specific (from application/vnd.google-apps.script) - If needed
  // 'application/vnd.google-apps.script+json',
];
export const NATIVE_PDF_TYPE = 'application/pdf';
