export interface FileInfo {
  path: string;         // Full absolute path
  hash: string;
  relative_path: string; // Path relative to the root_dir
}
