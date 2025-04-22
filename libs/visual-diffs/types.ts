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

// Helper Type Guard
export function is_readable_stream(obj: any): obj is NodeJS.ReadableStream {
  return obj !== null && typeof obj === 'object' && typeof obj.pipe === 'function';
}

// Constants
// List of types that Google Drive can inherently represent as PDF (native PDF)
export const NATIVE_PDF_TYPE = 'application/pdf';
