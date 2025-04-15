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
