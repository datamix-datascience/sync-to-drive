import * as core from "@actions/core";
import * as fs_promises from "fs/promises";
import * as fs from "fs";
import * as path from "path";
import { glob } from "glob";
import { FileInfo } from "./types.js";
import { compute_hash } from "./hash.js";
import { config } from "../config.js"; // Import config for ignore patterns

// List local files
export async function list_local_files(root_dir: string): Promise<FileInfo[]> {
  const files: FileInfo[] = [];
  const git_ignore_path = path.join(root_dir, '.gitignore');
  let ignore_patterns = config.ignore.concat([".git/**"]); // Start with config ignores

  // Read .gitignore if it exists
  if (fs.existsSync(git_ignore_path)) {
    try {
      const gitignore_content = await fs_promises.readFile(git_ignore_path, 'utf-8');
      const gitignore_lines = gitignore_content.split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#')); // Remove empty lines and comments
      // Simple conversion: make suitable for glob (this might need refinement for complex .gitignore patterns)
      const glob_patterns = gitignore_lines.map(line => {
        if (line.endsWith('/')) return line + '**'; // Directory
        // Treat plain file/dir names as potential dirs unless they contain wildcards
        if (!line.includes('*') && !line.includes('?') && !line.endsWith('/') && !line.startsWith('!')) return line + '/**';
        return line;
      });
      ignore_patterns = ignore_patterns.concat(glob_patterns);
      core.debug(`Added patterns from .gitignore: ${glob_patterns.join(', ')}`);
    } catch (error) {
      core.warning(`Could not read or parse .gitignore: ${(error as Error).message}`);
    }
  }
  core.info(`Using ignore patterns: ${ignore_patterns.join(', ')}`);

  const all_files = await glob("**", {
    cwd: root_dir,
    nodir: false,
    dot: true, // Include dotfiles (like .github)
    ignore: ignore_patterns, // Use combined ignore list
    follow: false, // Don't follow symlinks
    absolute: false, // Keep paths relative to root_dir
  });

  for (const relative_path of all_files) {
    const full_path = path.join(root_dir, relative_path);
    try {
      const stats = await fs_promises.lstat(full_path); // Use lstat to avoid following symlinks if any slip through
      if (stats.isFile()) {
        const hash = await compute_hash(full_path);
        files.push({ path: full_path, hash, relative_path });
      } else if (stats.isDirectory()) {
        // core.debug(`Ignoring directory: ${relative_path}`);
      } else {
        core.debug(`Ignoring non-file item: ${relative_path}`);
      }
    } catch (error) {
      // Ignore errors like permission denied or file disappearing during glob
      core.warning(`Could not stat file ${full_path}: ${(error as Error).message}`);
    }
  }
  core.info(`Found ${files.length} local files to potentially sync.`);
  return files;
}
