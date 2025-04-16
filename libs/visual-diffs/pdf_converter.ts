import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import * as mupdfjs from 'mupdf/mupdfjs';
import { ColorSpace } from 'mupdf/mupdfjs';

export async function convert_pdf_to_pngs(
  pdf_file_path: string,
  output_image_dir: string,
  resolution_dpi: number
): Promise<string[]> {
  const generated_files: string[] = [];
  let doc: mupdfjs.PDFDocument | null = null; // Explicitly type doc

  try {
    const buffer = await fs.promises.readFile(pdf_file_path);
    doc = mupdfjs.PDFDocument.openDocument(buffer, "application/pdf");
    const page_count = doc.countPages();
    await fs.promises.mkdir(output_image_dir, { recursive: true });
    const scale = resolution_dpi / 72; // Standard PDF DPI is 72
    const matrix = mupdfjs.Matrix.scale(scale, scale);

    core.info(`   - Found ${page_count} page(s) in PDF.`);

    for (let i = 0; i < page_count; i++) {
      const page_number = i + 1;
      core.debug(`   - Processing page ${page_number}...`);
      const page = doc.loadPage(i);
      const pixmap = page.toPixmap(matrix, ColorSpace.DeviceRGB, false, true);
      const png_image_data = pixmap.asPNG(); // Note: Typo in draft, should be asPNG()
      const output_png_path = path.join(output_image_dir, `${String(page_number).padStart(4, '0')}.png`);

      core.debug(`   - Writing PNG to: ${output_png_path}`);
      await fs.promises.writeFile(output_png_path, png_image_data);
      generated_files.push(output_png_path);

      // Clean up MuPDF objects for the current page
      page.destroy();
      pixmap.destroy();
    }

    core.info(`   - Successfully generated ${generated_files.length} PNG file(s).`);
    return generated_files;
  } catch (error: unknown) {
    core.error(`Error during PDF to PNG conversion for ${pdf_file_path}: ${(error as Error).message}`);
    // Return whatever files were generated before the error
    return generated_files;
  } finally {
    // Ensure the main document object is destroyed
    if (doc) {
      core.debug(`   - Destroying MuPDF document object.`);
      doc.destroy();
    }
  }
}
