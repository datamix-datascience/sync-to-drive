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
exports.delete_untracked = delete_untracked;
const core = __importStar(require("@actions/core"));
const auth_1 = require("./auth");
// Delete Untracked (Moves to Trash)
async function delete_untracked(id, name, is_folder = false) {
    const item_type = is_folder ? "folder" : "file";
    core.info(`Attempting to move ${item_type} to Trash: '${name}' (ID: ${id})`);
    try {
        await auth_1.drive.files.update({
            fileId: id,
            requestBody: { trashed: true },
            // Add fields to potentially get confirmation, although not strictly necessary
            // fields: "id, name, trashed"
        });
        core.info(`Moved untracked ${item_type} to Trash: ${name} (ID: ${id})`);
        return true;
    }
    catch (error) {
        const err = error;
        // Handle specific errors
        if (err.code === 403) {
            core.error(`Permission denied trying to trash ${item_type} '${name}' (ID: ${id}). Service account needs 'writer' or 'owner' role.`);
        }
        else if (err.code === 404) {
            // This is not necessarily an error in the context of untracked items
            core.warning(`Untracked ${item_type} '${name}' (ID: ${id}) not found, possibly already deleted or moved.`);
            return true; // Consider it success if it's already gone
        }
        else {
            core.warning(`Failed to trash untracked ${item_type} '${name}' (ID: ${id}): ${err.message}`);
        }
        // Log API details if available
        if (err.response?.data) {
            core.warning(`API Error Details: ${JSON.stringify(err.response.data)}`);
        }
        return false; // Indicate failure
    }
}
