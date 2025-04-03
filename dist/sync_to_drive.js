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
const core = __importStar(require("@actions/core"));
const googleapis_1 = require("googleapis");
const fsPromises = __importStar(require("fs/promises"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const glob_1 = require("glob");
// Load config from target repo
let config;
try {
    config = JSON.parse((0, fs_1.readFileSync)("sync-config.json", "utf-8"));
}
catch (error) {
    core.setFailed("Failed to load sync-config.json from target repo");
    process.exit(1);
}
// Google Drive API setup
const credentials = core.getInput("credentials", { required: true });
const credentials_json = JSON.parse(Buffer.from(credentials, "base64").toString());
const auth = new googleapis_1.google.auth.JWT(credentials_json.client_email, undefined, credentials_json.private_key, ["https://www.googleapis.com/auth/drive"]);
const drive = googleapis_1.google.drive({ version: "v3", auth });
// Compute file hash
async function compute_hash(file_path) {
    const content = await fsPromises.readFile(file_path);
    return (0, crypto_1.createHash)("sha1").update(content).digest("hex");
}
// List local files recursively with ignore patterns
async function list_local_files(root_dir) {
    const files = [];
    const all_files = await (0, glob_1.glob)("**", {
        cwd: root_dir,
        nodir: false,
        dot: true,
        ignore: config.ignore,
    });
    for (const relative_path of all_files) {
        const full_path = path.join(root_dir, relative_path);
        const stats = await fsPromises.stat(full_path);
        if (stats.isFile()) {
            const hash = await compute_hash(full_path);
            files.push({ path: full_path, hash, relative_path });
        }
    }
    return files;
}
// List Drive files recursively
async function list_drive_files(folder_id) {
    const file_map = new Map();
    const res = await drive.files.list({
        q: `'${folder_id}' in parents`,
        fields: "files(id, name, md5Checksum)",
    });
    for (const file of res.data.files || []) {
        if (file.name && file.id) {
            file_map.set(file.name, { id: file.id, hash: file.md5Checksum || "" });
        }
    }
    return file_map;
}
// Ensure folder exists in Drive
async function ensure_folder(parent_id, folder_name) {
    const res = await drive.files.list({
        q: `'${parent_id}' in parents name='${folder_name}' mimeType='application/vnd.google-apps.folder'`,
        fields: "files(id)",
    });
    if (res.data.files?.length) {
        return res.data.files[0].id;
    }
    const folder = await drive.files.create({
        requestBody: {
            name: folder_name,
            mimeType: "application/vnd.google-apps.folder",
            parents: [parent_id],
        },
        fields: "id",
    });
    return folder.data.id;
}
// Upload or update file
async function upload_file(file_path, folder_id, existing_file) {
    const file_name = path.basename(file_path);
    const media = { body: fs.createReadStream(file_path) }; // Fixed: use fs instead of fsPromises
    if (existing_file) {
        await drive.files.update({
            fileId: existing_file.id,
            media,
        });
        core.info(`Updated file: ${file_name}`);
    }
    else {
        await drive.files.create({
            requestBody: {
                name: file_name,
                parents: [folder_id],
            },
            media,
            fields: "id",
        });
        core.info(`Uploaded file: ${file_name}`);
    }
}
// Rename conflicting file
async function rename_conflict(file_id, old_name) {
    const new_name = `__my__.${old_name}`;
    await drive.files.update({
        fileId: file_id,
        requestBody: { name: new_name },
    });
    core.info(`Renamed conflicting file to: ${new_name}`);
}
// Delete untracked file
async function delete_untracked(file_id, file_name) {
    await drive.files.delete({ fileId: file_id });
    core.info(`Deleted untracked file: ${file_name}`);
}
// Main sync function
async function sync_to_drive() {
    const local_files = await list_local_files(".");
    if (local_files.length === 0) {
        core.setFailed("No files found in repository to sync (after applying ignore patterns)");
        return;
    }
    for (const target of config.targets.forks) {
        const folder_id = target.drive_folder_id;
        const drive_files = await list_drive_files(folder_id);
        const drive_link = `https://drive.google.com/drive/folders/${folder_id}`;
        core.setOutput("link", drive_link);
        // Initial sync if Drive folder is empty
        if (drive_files.size === 0) {
            core.info(`Folder ${folder_id} is empty, performing initial sync`);
            for (const file of local_files) {
                const parts = file.relative_path.split(path.sep);
                let current_folder_id = folder_id;
                for (let i = 0; i < parts.length - 1; i++) {
                    current_folder_id = await ensure_folder(current_folder_id, parts[i]);
                }
                await upload_file(file.path, current_folder_id);
            }
            core.info(`Initial sync completed for folder ${folder_id}`);
            continue;
        }
        // Non-empty sync: compare hashes
        const local_file_map = new Map();
        for (const file of local_files) {
            local_file_map.set(file.relative_path, file);
        }
        for (const [relative_path, local_file] of local_file_map) {
            const file_name = path.basename(relative_path);
            const drive_file = drive_files.get(file_name);
            const parts = relative_path.split(path.sep);
            let current_folder_id = folder_id;
            for (let i = 0; i < parts.length - 1; i++) {
                current_folder_id = await ensure_folder(current_folder_id, parts[i]);
            }
            if (!drive_file) {
                // New file
                await upload_file(local_file.path, current_folder_id);
            }
            else if (drive_file.hash !== local_file.hash) {
                // Hash differs: handle based on on_conflict
                if (target.on_conflict === "rename") {
                    await rename_conflict(drive_file.id, file_name);
                    await upload_file(local_file.path, current_folder_id);
                }
                else if (target.on_conflict === "override") {
                    await upload_file(local_file.path, current_folder_id, {
                        id: drive_file.id,
                        name: file_name,
                    });
                }
            }
            drive_files.delete(file_name); // Remove processed file
        }
        // Handle untracked files based on on_untrack
        if (drive_files.size > 0) {
            if (target.on_untrack === "remove") {
                for (const [file_name, file_info] of drive_files) {
                    await delete_untracked(file_info.id, file_name);
                }
            }
            else {
                core.info(`Leaving ${drive_files.size} untracked files in folder ${folder_id}`);
            }
        }
        core.info(`Sync completed for folder ${folder_id}`);
    }
}
// Run the action
sync_to_drive().catch((error) => core.setFailed(`Sync failed: ${error.message}`));
