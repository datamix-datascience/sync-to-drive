import * as core from '@actions/core';
import * as fs from 'fs/promises';
import * as path from 'path';
import { convert_json_to_svg, init_wasm_logging } from '@gist-rs/gslides-tools';
import { slides_v1 } from 'googleapis'; // Import Presentation type

let wasm_initialized = false;

/**
 * Converts Google Slides presentation JSON to an SVG string.
 * Initializes the WASM module on first call.
 *
 * @param presentation_json - The Google Slides presentation object.
 * @returns The SVG string or null if conversion fails.
 */
export async function generate_slide_svg(
  presentation_json: slides_v1.Schema$Presentation
): Promise<string | null> {
  core.info(`   - Converting fetched Slides JSON to SVG...`);
  try {
    if (!wasm_initialized) {
      core.info("   - Initializing WASM module for SVG conversion...");
      await init_wasm_logging(); // Initialize WASM logging/panic hook
      wasm_initialized = true;
      core.info("   - WASM module initialized.");
    }

    // gslides_rs expects the presentation object stringified
    const presentation_json_string = JSON.stringify(presentation_json);
    const svg_string = convert_json_to_svg(presentation_json_string);
    core.info(`   - Successfully generated SVG string (length: ${svg_string.length}).`);
    return svg_string;

  } catch (error: unknown) {
    core.error(`   - Failed during Slides JSON to SVG conversion: ${(error as Error).message}`);
    if ((error as Error).stack) {
      core.error((error as Error).stack || "Unknown Error"); // Log stack for WASM errors
    }
    return null;
  }
}

/**
 * Writes the generated SVG string to a file.
 * Ensures the output directory exists.
 *
 * @param svg_string - The SVG content.
 * @param output_svg_path - The absolute path where the SVG file should be saved.
 * @returns Boolean indicating success.
 */
export async function write_svg_file(
  svg_string: string,
  output_svg_path: string
): Promise<boolean> {
  try {
    const output_dir = path.dirname(output_svg_path);
    core.info(`   - Ensuring output directory exists: ${output_dir}`);
    await fs.mkdir(output_dir, { recursive: true });

    core.info(`   - Writing SVG file to: ${output_svg_path}`);
    await fs.writeFile(output_svg_path, svg_string);
    core.info(`   - Successfully wrote SVG file.`);
    return true;
  } catch (error) {
    core.error(`   - Failed to write SVG file to ${output_svg_path}: ${(error as Error).message}`);
    return false;
  }
}
