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
exports.build_folder_structure = build_folder_structure;
const core = __importStar(require("@actions/core"));
const auth_1 = require("./auth");
const path = __importStar(require("path"));
// Ensure Folder
async function ensure_folder(parent_id, folder_name) {
    core.info(`Ensuring folder '${folder_name}' under parent '${parent_id}'`);
    try {
        const query = `'${parent_id}' in parents and mimeType = 'application/vnd.google-apps.folder' and name = '${folder_name.replace(/'/g, "\\'")}' and trashed = false`;
        core.debug(`Querying for existing folder: ${query}`);
        const res = await auth_1.drive.files.list({
            q: query,
            fields: "files(id, name)",
            spaces: "drive",
            pageSize: 1,
        });
        core.debug(`API response for existing folder query '${folder_name}' under '${parent_id}': ${JSON.stringify(res.data)}`);
        const existing_folder = res.data.files?.[0];
        if (existing_folder && existing_folder.id) {
            core.info(`Reusing existing folder '${folder_name}' with ID: ${existing_folder.id}`);
            return existing_folder.id;
        }
        core.info(`Folder '${folder_name}' not found, creating it...`);
        const folder = await auth_1.drive.files.create({
            requestBody: {
                name: folder_name,
                mimeType: "application/vnd.google-apps.folder",
                parents: [parent_id],
            },
            fields: "id",
        });
        if (!folder.data.id) {
            throw new Error(`Folder creation API call did not return an ID for '${folder_name}'.`);
        }
        core.info(`Created folder '${folder_name}' with ID: ${folder.data.id}`);
        return folder.data.id;
    }
    catch (error) {
        const err = error;
        core.error(`Failed to ensure folder '${folder_name}' under '${parent_id}': ${err.message}`);
        if (err.response?.data) {
            core.error(`API Error Details: ${JSON.stringify(err.response.data)}`);
        }
        throw err; // Re-throw to signal failure up the chain
    }
}
// Build Folder Structure
async function build_folder_structure(root_folder_id, local_files, existing_folders // Pass existing folders for efficiency
) {
    const folder_map = new Map();
    folder_map.set("", root_folder_id); // Root path maps to the root folder ID
    const required_dir_paths = new Set();
    for (const file of local_files) {
        // Just get the directory name from the relative path
        const dir = path.dirname(file.relative_path);
        if (dir && dir !== '.') {
            // Add the directory and all its parents to the set
            const parts = dir.split(path.sep);
            let current_cumulative_path = "";
            for (const part of parts) {
                current_cumulative_path = current_cumulative_path ? path.join(current_cumulative_path, part) : part;
                // Ensure consistent path separators (forward slashes)
                required_dir_paths.add(current_cumulative_path.replace(/\\/g, '/'));
            }
        }
    }
    const sorted_paths = Array.from(required_dir_paths).sort();
    core.info(`Required folder paths based on local files: ${sorted_paths.join(', ') || 'None'}`);
    for (const folder_path of sorted_paths) {
        if (folder_map.has(folder_path)) {
            core.debug(`Folder path '${folder_path}' already processed.`);
            continue;
        }
        const parts = folder_path.split('/');
        const folder_name = parts[parts.length - 1];
        const parent_path = parts.slice(0, -1).join('/'); // "" for top-level dirs
        const parent_folder_id = folder_map.get(parent_path);
        if (!parent_folder_id) {
            // This should theoretically not happen if paths are sorted correctly and root is set
            core.error(`Logic error: Cannot find parent folder ID for path '${folder_path}' (parent path '${parent_path}' missing from map). Skipping.`);
            continue;
        }
        const existing_drive_folder = existing_folders.get(folder_path);
        let current_folder_id;
        if (existing_drive_folder?.id) {
            core.info(`Using existing Drive folder '${folder_path}' with ID: ${existing_drive_folder.id}`);
            current_folder_id = existing_drive_folder.id;
            // Ensure the map is updated even if we reuse an existing folder
            folder_map.set(folder_path, current_folder_id);
        }
        else {
            core.info(`Creating missing folder '${folder_name}' under parent ID ${parent_folder_id} (for path '${folder_path}')`);
            try {
                current_folder_id = await ensure_folder(parent_folder_id, folder_name);
                folder_map.set(folder_path, current_folder_id); // Add newly created folder to map
            }
            catch (error) {
                // If a folder fails, we cannot proceed with its children
                core.error(`Failed to create or find folder structure at '${folder_path}'. Stopping structure build for this branch.`);
                // Don't re-throw here, allow sync to continue with other top-level folders if possible
                // But the map won't contain this path or its children.
                continue;
            }
        }
    }
    core.info(`Built/Verified folder structure. Path-to-ID map size: ${folder_map.size}`);
    return folder_map;
}
