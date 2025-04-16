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
exports.convert_pdf_to_pngs = convert_pdf_to_pngs;
const core = __importStar(require("@actions/core"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const mupdfjs = __importStar(require("mupdf/mupdfjs"));
const mupdfjs_1 = require("mupdf/mupdfjs");
async function convert_pdf_to_pngs(pdf_file_path, output_image_dir, resolution_dpi) {
    const generated_files = [];
    let doc = null; // Explicitly type doc
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
            const pixmap = page.toPixmap(matrix, mupdfjs_1.ColorSpace.DeviceRGB, false, true);
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
    }
    catch (error) {
        core.error(`Error during PDF to PNG conversion for ${pdf_file_path}: ${error.message}`);
        // Return whatever files were generated before the error
        return generated_files;
    }
    finally {
        // Ensure the main document object is destroyed
        if (doc) {
            core.debug(`   - Destroying MuPDF document object.`);
            doc.destroy();
        }
    }
}
