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
exports.execute_git = execute_git;
const core = __importStar(require("@actions/core"));
const exec_1 = require("@actions/exec");
// Exec Git Helper
async function execute_git(command, args, options = {}) {
    core.debug(`Executing: git ${command} ${args.join(" ")} ${options.cwd ? `(in ${options.cwd})` : ''}`);
    try {
        const result = await (0, exec_1.getExecOutput)("git", [command, ...args], {
            ignoreReturnCode: options.ignoreReturnCode ?? false,
            silent: options.silent ?? false,
            cwd: options.cwd // Pass current working directory if specified
        });
        // Only fail if ignoreReturnCode is false AND exit code is non-zero
        if (!options.ignoreReturnCode && result.exitCode !== 0) {
            core.error(`Git command failed: git ${command} ${args.join(" ")} - Exit Code: ${result.exitCode}`);
            core.error(`stderr: ${result.stderr}`);
            throw new Error(`Git command failed with exit code ${result.exitCode}. Stderr: ${result.stderr}`);
        }
        // Log output even on non-zero exit code if not silent, as it might be informative
        core.debug(`Git command finished: git ${command} - Exit Code: ${result.exitCode}`);
        if (result.stdout) {
            core.debug(`stdout: ${result.stdout}`);
        }
        // Log stderr only if it's not silent OR if it's an actual error (non-zero exit)
        if (result.stderr && (!options.silent || result.exitCode !== 0)) {
            core.debug(`stderr: ${result.stderr}`);
        }
        return result;
    }
    catch (error) {
        // Catch errors thrown by getExecOutput itself (e.g., command not found)
        // or the re-thrown error from above
        core.error(`Error executing git command: git ${command} ${args.join(" ")}: ${error.message}`);
        // Attempt to log stderr/stdout if they exist on the error object
        if (error.stderr)
            core.error(`stderr: ${error.stderr}`);
        if (error.stdout)
            core.debug(`stdout (on error): ${error.stdout}`);
        throw error; // Re-throw the original error
    }
}
