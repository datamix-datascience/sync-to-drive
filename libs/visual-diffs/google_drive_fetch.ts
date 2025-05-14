import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { drive_v3 } from 'googleapis';
import {
  is_readable_stream,
  // Remove GOOGLE_DRIVE_EXPORTABLE_TO_PDF_TYPES as the logic changes
  NATIVE_PDF_TYPE
} from './types.js';

// Step 1: Define mappings from convertible source types to target native types
const CONVERTIBLE_TO_NATIVE_MAP: { [key: string]: string } = {
  // Microsoft Office Types -> Google Workspace Types
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'application/vnd.google-apps.document', // .docx -> Google Docs
  'application/msword': 'application/vnd.google-apps.document',                                                    // .doc -> Google Docs
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'application/vnd.google-apps.presentation', // .pptx -> Google Slides
  'application/vnd.ms-powerpoint': 'application/vnd.google-apps.presentation',                                             // .ppt -> Google Slides
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'application/vnd.google-apps.spreadsheet',     // .xlsx -> Google Sheets
  'application/vnd.ms-excel': 'application/vnd.google-apps.spreadsheet',                                                  // .xls -> Google Sheets

  // OpenDocument Types -> Google Workspace Types
  'application/vnd.oasis.opendocument.text': 'application/vnd.google-apps.document',         // .odt -> Google Docs
  'application/vnd.oasis.opendocument.presentation': 'application/vnd.google-apps.presentation', // .odp -> Google Slides
  'application/vnd.oasis.opendocument.spreadsheet': 'application/vnd.google-apps.spreadsheet',  // .ods -> Google Sheets

  // Other Common Types -> Google Workspace Types (Example: text/plain)
  'text/plain': 'application/vnd.google-apps.document',        // .txt -> Google Docs (can be useful)
  'application/rtf': 'application/vnd.google-apps.document', // .rtf -> Google Docs
};

// Step 2: Define native Google Workspace types that can be directly exported
const NATIVE_GOOGLE_WORKSPACE_EXPORTABLE_TYPES = [
  'application/vnd.google-apps.document',     // Google Docs
  'application/vnd.google-apps.presentation', // Google Slides
  'application/vnd.google-apps.spreadsheet',  // Google Sheets
  'application/vnd.google-apps.drawing',      // Google Drawings
  // Note: Forms, Scripts, etc. might not export well to PDF via API
];


/**
 * Fetches a file from Google Drive, exporting or converting as needed to get a PDF.
 * Saves the result to a temporary path.
 *
 * @param drive - Initialized Google Drive API client.
 * @param file_id - The ID of the Drive file to fetch.
 * @param mime_type - The MIME type of the Drive file.
 * @param temp_pdf_path - The local path where the fetched PDF should be saved.
 * @returns Promise<boolean> - True if fetch and save were successful, false otherwise.
 */
export async function fetch_drive_file_as_pdf(
  drive: drive_v3.Drive,
  file_id: string,
  mime_type: string,
  temp_pdf_path: string
): Promise<boolean> {
  core.info(`   - Preparing to fetch content for ID ${file_id} (Type: ${mime_type})`);
  let response_stream: NodeJS.ReadableStream | null = null;
  let temp_native_file_id: string | null = null; // For cleanup

  try {
    if (NATIVE_GOOGLE_WORKSPACE_EXPORTABLE_TYPES.includes(mime_type)) {
      // --- Direct Export Path (Native Google Types) ---
      core.info(`   - Exporting native Google Workspace file directly as PDF...`);
      core.debug(`     Attempting drive.files.export({ fileId: '${file_id}', mimeType: 'application/pdf' })`);
      const response = await drive.files.export(
        { fileId: file_id, mimeType: 'application/pdf' },
        { responseType: 'stream' }
      );
      if (is_readable_stream(response.data)) {
        response_stream = response.data;
      } else {
        throw new Error(`Drive export for native file ${file_id} did not return a readable stream.`);
      }
      // --- End Direct Export Path ---

    } else if (mime_type === NATIVE_PDF_TYPE) {
      // --- Direct Download Path (Native PDF) ---
      core.info(`   - Downloading native PDF file directly...`);
      core.debug(`     Attempting drive.files.get({ fileId: '${file_id}', alt: 'media', supportsAllDrives: true })`);
      const response = await drive.files.get(
        { fileId: file_id, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream' }
      );
      if (is_readable_stream(response.data)) {
        response_stream = response.data;
      } else {
        throw new Error(`Drive get/media for PDF file ${file_id} did not return a readable stream.`);
      }
      // --- End Direct Download Path ---

    } else if (CONVERTIBLE_TO_NATIVE_MAP[mime_type]) {
      // --- Copy -> Export -> Delete Path (Convertible Non-Native Types) ---
      const target_native_mime_type = CONVERTIBLE_TO_NATIVE_MAP[mime_type];
      core.info(`   - File type '${mime_type}' requires conversion. Copying to native '${target_native_mime_type}' first...`);

      try {
        // Step 1: Copy and Convert
        core.debug(`     Attempting drive.files.copy({ fileId: '${file_id}', requestBody: { mimeType: '${target_native_mime_type}' }, supportsAllDrives: true })`);
        const copy_response = await drive.files.copy({
          fileId: file_id,
          requestBody: {
            // Provide a temporary name to avoid issues, include original ID for traceability
            name: `[TEMP CONVERT] ${file_id} - ${path.basename(temp_pdf_path)}`,
            mimeType: target_native_mime_type,
          },
          fields: 'id, name', // Request ID and name of the new file
          supportsAllDrives: true,
        });

        temp_native_file_id = copy_response.data.id || null;
        if (!temp_native_file_id) {
          throw new Error(`Drive copy operation for ${file_id} did not return a new file ID.`);
        }
        core.info(`   - Created temporary native file: ID ${temp_native_file_id}, Name: '${copy_response.data.name}'`);

        // Step 2: Export the temporary native file
        core.info(`   - Exporting temporary native file '${temp_native_file_id}' as PDF...`);
        core.debug(`     Attempting drive.files.export({ fileId: '${temp_native_file_id}', mimeType: 'application/pdf' })`);
        const export_response = await drive.files.export(
          { fileId: temp_native_file_id, mimeType: 'application/pdf' },
          { responseType: 'stream' }
        );

        if (is_readable_stream(export_response.data)) {
          response_stream = export_response.data;
        } else {
          throw new Error(`Drive export for temporary file ${temp_native_file_id} did not return a readable stream.`);
        }
        // Note: Cleanup (Step 3) happens in the finally block below

      } catch (conversion_error) {
        // Catch errors specifically during the copy or export-from-copy steps
        core.error(`   - Error during copy/convert/export process for ${file_id}: ${(conversion_error as Error).message}`);
        // Re-throw to be caught by the outer catch block for cleanup and return false
        throw conversion_error;
      }
      // --- End Copy -> Export -> Delete Path ---

    } else {
      // --- Unsupported Type Path ---
      core.warning(`   - Skipping file: Unsupported MIME type ${mime_type} for PDF conversion/export.`);
      return false; // Indicate not processed
      // --- End Unsupported Type Path ---
    }

    // --- Write Stream to File (Common for all successful paths) ---
    // Ensure parent directory for the temp file exists
    await fs.promises.mkdir(path.dirname(temp_pdf_path), { recursive: true });

    // Pipe the stream to the temporary file
    core.info(`   - Writing fetched data to temporary PDF: ${temp_pdf_path}`);
    const dest = fs.createWriteStream(temp_pdf_path);

    await new Promise((resolve, reject) => {
      if (!response_stream) {
        return reject(new Error("Response stream is null (logic error after path selection)."));
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
    // If we reach here, writing was successful
    return true; // Fetch and save successful

  } catch (error: unknown) {
    // --- General Error Handling ---
    const gaxiosError = error as { config?: any; code?: number; message?: string; response?: { status?: number; statusText?: string; data?: any; headers?: any } };

    core.error(`   - Error during Drive fetch/conversion process for File ID ${file_id}:`);
    // Log detailed error info (as added previously)
    core.error(`     Message: ${gaxiosError.message}`);
    if (gaxiosError.code) core.error(`     Code: ${gaxiosError.code}`);
    if (gaxiosError.response) {
      core.error(`     Response Status: ${gaxiosError.response.status} ${gaxiosError.response.statusText || ''}`);
      core.error(`     Response Headers: ${JSON.stringify(gaxiosError.response.headers)}`);
      core.error(`     Response Data: ${JSON.stringify(gaxiosError.response.data)}`);
    }
    if (gaxiosError.config) core.error(`     Request Config URL: ${gaxiosError.config.url}`);
    if ((error as Error).stack) core.debug(`     Stack Trace: ${(error as Error).stack}`);

    const status = gaxiosError.response?.status ?? gaxiosError.code;
    if (status === 404) {
      core.error(`   - Fetch/Conversion failed: Google Drive file ID ${file_id} (or its temporary copy) not found.`);
    } else if (status === 403) {
      core.error(`   - Fetch/Conversion failed: Permission denied for Google Drive file ID ${file_id} (or its temporary copy). Check Service Account permissions.`);
    } else {
      core.error(`   - Fetch/Conversion failed for file ID ${file_id}. See details above.`);
    }

    // Attempt to clean up potentially incomplete/empty temp output file
    await fs.promises.rm(temp_pdf_path, { force: true, recursive: false }).catch(rmErr => {
      if (rmErr.code !== 'ENOENT') {
        core.warning(`Failed to remove potentially incomplete output temp file ${temp_pdf_path}: ${rmErr.message}`);
      }
    });
    return false; // Indicate failure
  } finally {
    // --- Cleanup: Delete Temporary Native File (Step 3) ---
    if (temp_native_file_id) {
      core.info(`   - Cleaning up temporary native file: ID ${temp_native_file_id}`);
      try {
        await drive.files.update({
          fileId: temp_native_file_id,
          requestBody: { trashed: true },
          supportsAllDrives: true, // Keep this for consistency
        });
        core.info(`   - Successfully moved temporary native file ${temp_native_file_id} to trash.`);
      } catch (delete_error) {
        core.warning(`   - Failed to move temporary native file ${temp_native_file_id} to trash: ${(delete_error as Error).message}`);
        // Log details if helpful
        const deleteGaxiosError = delete_error as { response?: { data?: any } };
        if (deleteGaxiosError.response?.data) {
          core.warning(`     Deletion API Error Details: ${JSON.stringify(deleteGaxiosError.response.data)}`);
        }
      }
    }
    // --- End Cleanup ---
  }
}
