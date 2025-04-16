"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetch_drive_file_as_pdf = fetch_drive_file_as_pdf;
const core = __importStar(require("@actions/core"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const types_1 = require("./types");
/**
 * Fetches a file from Google Drive, exporting Google Workspace types to PDF
 * and downloading native PDFs directly. Saves the result to a temporary path.
 *
 * @param drive - Initialized Google Drive API client.
 * @param file_id - The ID of the Drive file to fetch.
 * @param mime_type - The MIME type of the Drive file.
 * @param temp_pdf_path - The local path where the fetched PDF should be saved.
 * @returns Promise<boolean> - True if fetch and save were successful, false otherwise.
 */
async function fetch_drive_file_as_pdf(drive, file_id, mime_type, temp_pdf_path) {
    core.info(`   - Preparing to fetch content for ID ${file_id} (Type: ${mime_type})`);
    let response_stream = null;
    try {
        if (types_1.GOOGLE_WORKSPACE_EXPORTABLE_TYPES.includes(mime_type)) {
            core.info(`   - Exporting Google Workspace file as PDF...`);
            const response = await drive.files.export({ fileId: file_id, mimeType: 'application/pdf' }, { responseType: 'stream' });
            if ((0, types_1.is_readable_stream)(response.data)) {
                response_stream = response.data;
            }
            else {
                throw new Error('Drive export did not return a readable stream.');
            }
        }
        else if (mime_type === types_1.NATIVE_PDF_TYPE) {
            core.info(`   - Downloading native PDF file...`);
            const response = await drive.files.get({ fileId: file_id, alt: 'media' }, { responseType: 'stream' });
            if ((0, types_1.is_readable_stream)(response.data)) {
                response_stream = response.data;
            }
            else {
                throw new Error('Drive get/media did not return a readable stream.');
            }
        }
        else {
            core.warning(`   - Skipping file: Unsupported MIME type ${mime_type} for PDF conversion.`);
            return false; // Indicate not processed
        }
        // Ensure parent directory for the temp file exists
        await fs.promises.mkdir(path.dirname(temp_pdf_path), { recursive: true });
        // Pipe the stream to the temporary file
        core.info(`   - Writing fetched data to temporary PDF: ${temp_pdf_path}`);
        const dest = fs.createWriteStream(temp_pdf_path);
        await new Promise((resolve, reject) => {
            if (!response_stream) {
                return reject(new Error("Response stream is null (logic error)."));
            }
            response_stream.pipe(dest)
                .on('finish', () => {
                core.info(`   - Successfully saved temporary PDF.`);
                resolve(undefined);
            })
                .on('error', (err) => {
                core.error(`   - Error writing temporary PDF: ${err.message}`);
                // Attempt cleanup before rejecting
                fs.unlink(temp_pdf_path, unlinkErr => {
                    if (unlinkErr && unlinkErr.code !== 'ENOENT') {
                        core.warning(`Failed to clean up partially written temp file ${temp_pdf_path}: ${unlinkErr.message}`);
                    }
                    reject(err); // Reject the promise on stream error
                });
            });
        });
        return true; // Fetch and save successful
    }
    catch (error) {
        // Log specific Drive API errors
        const gaxiosError = error; // Type assertion for common error shape
        if (gaxiosError.code === 404) {
            core.error(`   - Fetch failed: Google Drive file ID ${file_id} not found (404).`);
        }
        else if (gaxiosError.code === 403) {
            core.error(`   - Fetch failed: Permission denied for Google Drive file ID ${file_id} (403). Check Service Account permissions.`);
        }
        else {
            core.error(`   - Fetch failed for file ID ${file_id}: ${gaxiosError.message}`);
            if (gaxiosError?.response?.data) {
                core.error(`   - API Error Details: ${JSON.stringify(gaxiosError.response.data)}`);
            }
        }
        // Attempt to clean up potentially incomplete/empty temp file if write didn't start/finish
        await fs.promises.rm(temp_pdf_path, { force: true, recursive: false }).catch(rmErr => {
            if (rmErr.code !== 'ENOENT') { // Ignore if file doesn't exist
                core.warning(`Failed to remove potentially incomplete temp file ${temp_pdf_path}: ${rmErr.message}`);
            }
        });
        return false; // Indicate failure
    }
}
