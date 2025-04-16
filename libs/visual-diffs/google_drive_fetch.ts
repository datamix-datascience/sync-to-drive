import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { drive_v3 } from 'googleapis';
import {
  is_readable_stream,
  GOOGLE_WORKSPACE_EXPORTABLE_TYPES,
  NATIVE_PDF_TYPE
} from './types.js';

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
export async function fetch_drive_file_as_pdf(
  drive: drive_v3.Drive,
  file_id: string,
  mime_type: string,
  temp_pdf_path: string
): Promise<boolean> {
  core.info(`   - Preparing to fetch content for ID ${file_id} (Type: ${mime_type})`);
  let response_stream: NodeJS.ReadableStream | null = null;

  try {
    if (GOOGLE_WORKSPACE_EXPORTABLE_TYPES.includes(mime_type)) {
      core.info(`   - Exporting Google Workspace file as PDF...`);
      const response = await drive.files.export(
        { fileId: file_id, mimeType: 'application/pdf' },
        { responseType: 'stream' }
      );
      if (is_readable_stream(response.data)) {
        response_stream = response.data;
      } else {
        throw new Error('Drive export did not return a readable stream.');
      }
    } else if (mime_type === NATIVE_PDF_TYPE) {
      core.info(`   - Downloading native PDF file...`);
      const response = await drive.files.get(
        { fileId: file_id, alt: 'media' },
        { responseType: 'stream' }
      );
      if (is_readable_stream(response.data)) {
        response_stream = response.data;
      } else {
        throw new Error('Drive get/media did not return a readable stream.');
      }
    } else {
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

  } catch (error: unknown) {
    // Log specific Drive API errors
    const gaxiosError = error as { code?: number; message?: string; response?: { data?: any } }; // Type assertion for common error shape
    if (gaxiosError.code === 404) {
      core.error(`   - Fetch failed: Google Drive file ID ${file_id} not found (404).`);
    } else if (gaxiosError.code === 403) {
      core.error(`   - Fetch failed: Permission denied for Google Drive file ID ${file_id} (403). Check Service Account permissions.`);
    } else {
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
