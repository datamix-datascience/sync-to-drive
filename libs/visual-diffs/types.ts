import { drive_v3 } from 'googleapis';
import { Octokit } from '@octokit/rest';

export interface GenerateVisualDiffsParams {
  octokit: Octokit;
  drive: drive_v3.Drive;
  pr_number: number;
  head_branch: string;
  head_sha: string; // Need SHA to fetch correct file versions
  owner: string;
  repo: string;
  output_base_dir: string;
  link_file_suffix: string;
  resolution_dpi: number;
  git_user_name: string;
  git_user_email: string;
}

// Helper Type Guard (moved here for locality)
export function is_readable_stream(obj: any): obj is NodeJS.ReadableStream {
  return obj !== null && typeof obj === 'object' && typeof obj.pipe === 'function';
}

// Constants (moved here for locality)
export const GOOGLE_WORKSPACE_EXPORTABLE_TYPES = [
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.drawing',
];
export const NATIVE_PDF_TYPE = 'application/pdf';
