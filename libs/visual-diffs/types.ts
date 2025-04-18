import { Octokit } from "@octokit/rest";
import { drive_v3 } from "googleapis";

export interface GenerateVisualDiffsParams {
  octokit: Octokit;
  drive: drive_v3.Drive;
  pr_number: number;
  head_branch: string;
  head_sha: string; // Need SHA to fetch correct file versions
  // base_sha: string; // Base SHA will be fetched inside the function now
  owner: string;
  repo: string;
  output_base_dir: string;
  link_file_suffix: string;
  resolution_dpi: number;
  git_user_name: string;
  git_user_email: string;
  // Added for Gemini
  gemini_api_key?: string; // Optional API Key
  gemini_model_name?: string; // Optional Model Name
}

// Define the structure for link file info
export interface LinkFileInfo {
  path: string; // Relative path in the repo, e.g., "docs/MySlide.gdrive.json"
  base_name: string; // Base name derived from path, e.g., "MySlide"
  // status?: 'added' | 'modified' | 'deleted' | 'renamed'; // Optional: Store status later
}

// Constants for Google Workspace types and PDF
export const GOOGLE_WORKSPACE_EXPORTABLE_TYPES = [
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.presentation",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.drawing",
];
export const NATIVE_PDF_TYPE = "application/pdf";

// Helper type guard for stream checking (remains the same)
export function is_readable_stream(data: any): data is NodeJS.ReadableStream {
  return (
    data !== null && typeof data === "object" && typeof data.pipe === "function"
  );
}
