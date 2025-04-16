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
exports.list_local_files = list_local_files;
const core = __importStar(require("@actions/core"));
const fs_promises = __importStar(require("fs/promises"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const glob_1 = require("glob");
const hash_1 = require("./hash");
const config_1 = require("../config"); // Import config for ignore patterns
// List local files
async function list_local_files(root_dir) {
    const files = [];
    const git_ignore_path = path.join(root_dir, '.gitignore');
    let ignore_patterns = config_1.config.ignore.concat([".git/**"]); // Start with config ignores
    // Read .gitignore if it exists
    if (fs.existsSync(git_ignore_path)) {
        try {
            const gitignore_content = await fs_promises.readFile(git_ignore_path, 'utf-8');
            const gitignore_lines = gitignore_content.split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#')); // Remove empty lines and comments
            // Simple conversion: make suitable for glob (this might need refinement for complex .gitignore patterns)
            const glob_patterns = gitignore_lines.map(line => {
                if (line.endsWith('/'))
                    return line + '**'; // Directory
                // Treat plain file/dir names as potential dirs unless they contain wildcards
                if (!line.includes('*') && !line.includes('?') && !line.endsWith('/') && !line.startsWith('!'))
                    return line + '/**';
                return line;
            });
            ignore_patterns = ignore_patterns.concat(glob_patterns);
            core.debug(`Added patterns from .gitignore: ${glob_patterns.join(', ')}`);
        }
        catch (error) {
            core.warning(`Could not read or parse .gitignore: ${error.message}`);
        }
    }
    core.info(`Using ignore patterns: ${ignore_patterns.join(', ')}`);
    const all_files = await (0, glob_1.glob)("**", {
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
                const hash = await (0, hash_1.compute_hash)(full_path);
                files.push({ path: full_path, hash, relative_path });
            }
            else if (stats.isDirectory()) {
                // core.debug(`Ignoring directory: ${relative_path}`);
            }
            else {
                core.debug(`Ignoring non-file item: ${relative_path}`);
            }
        }
        catch (error) {
            // Ignore errors like permission denied or file disappearing during glob
            core.warning(`Could not stat file ${full_path}: ${error.message}`);
        }
    }
    core.info(`Found ${files.length} local files to potentially sync.`);
    return files;
}
