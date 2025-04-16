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
exports.create_pull_request_with_retry = create_pull_request_with_retry;
const core = __importStar(require("@actions/core"));
// Create PR with Retry - Handles existing PRs
async function create_pull_request_with_retry(octokit, // Pass the initialized Octokit instance
params, max_retries = 3, initial_delay = 5000 // 5 seconds
) {
    let current_delay = initial_delay;
    // --- 1. Get default branch ---
    let base_branch = params.base; // Use provided base first
    try {
        const repo_info = await octokit.rest.repos.get({ owner: params.owner, repo: params.repo });
        base_branch = repo_info.data.default_branch;
        core.info(`Target repository default branch: ${base_branch}. Using this as base.`);
    }
    catch (repoError) {
        core.warning(`Could not fetch repository info to confirm default branch. Using provided base '${params.base}'. Error: ${repoError.message}`);
        // Proceed with the provided base branch
    }
    const head_ref = `${params.owner}:${params.head}`; // Use owner:branch format for head when checking/creating
    for (let attempt = 0; attempt < max_retries; attempt++) {
        try {
            // --- 2. Check for existing PR ---
            core.info(`Checking for existing PR: head=${head_ref} base=${base_branch}`);
            const existing_prs = await octokit.rest.pulls.list({
                owner: params.owner,
                repo: params.repo,
                head: head_ref, // Use owner:branch format
                base: base_branch,
                state: 'open',
            });
            if (existing_prs.data.length > 0) {
                const existing_pr = existing_prs.data[0];
                core.info(`Existing pull request found (Number: ${existing_pr.number}). Updating it.`);
                // --- 3a. Update existing PR ---
                const update_response = await octokit.rest.pulls.update({
                    owner: params.owner,
                    repo: params.repo,
                    pull_number: existing_pr.number,
                    title: params.title, // Update title and body
                    body: params.body,
                    base: base_branch, // Ensure base is correct
                    // Note: Cannot update 'head' branch of an existing PR via this call
                });
                core.info(`Pull request updated successfully: ${update_response.data.html_url}`);
                return { url: update_response.data.html_url, number: update_response.data.number };
            }
            else {
                core.info(`No existing pull request found. Creating new PR: head=${params.head} base=${base_branch}`);
                // --- 3b. Create new PR ---
                // When creating, just use the branch name for 'head'
                const create_response = await octokit.rest.pulls.create({
                    owner: params.owner,
                    repo: params.repo,
                    title: params.title,
                    head: params.head, // Just branch name is usually sufficient here
                    base: base_branch,
                    body: params.body,
                    // maintainer_can_modify: true, // Optional: allow maintainers to push to the branch
                });
                core.info(`Pull request created successfully: ${create_response.data.html_url}`);
                return { url: create_response.data.html_url, number: create_response.data.number };
            }
        }
        catch (error) {
            const http_error = error;
            core.warning(`PR operation attempt ${attempt + 1} failed.`);
            if (http_error?.status)
                core.warning(`Status: ${http_error.status}`);
            if (http_error?.message)
                core.warning(`Message: ${http_error.message}`);
            if (http_error?.response?.data)
                core.warning(`API Response Data: ${JSON.stringify(http_error.response.data)}`);
            // Specific error handling: 422 often means branch not ready or PR already exists (race condition)
            // 404 might mean repo/branch not found (less likely here if push succeeded)
            // 403 Permission issue
            if ((http_error?.status === 422 || http_error?.status === 404 || http_error?.status === 403) && attempt < max_retries - 1) {
                core.warning(`Retrying PR operation in ${current_delay / 1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, current_delay));
                current_delay *= 2; // Exponential backoff
            }
            else if (http_error?.status === 422 && http_error?.message?.includes("No commits between")) {
                core.info(`PR creation/update skipped: No commits between ${base_branch} and ${params.head}.`);
                return null; // Not an error, just nothing to PR
            }
            else {
                core.error(`Failed to create or update pull request after ${attempt + 1} attempts.`);
                // Log the final error before throwing
                if (http_error?.message)
                    core.error(`Final Error: ${http_error.message}`);
                throw error; // Re-throw the last error
            }
        }
    }
    // Should not be reachable if max_retries > 0, but satisfies compiler
    core.error("Exceeded max retries for PR operation.");
    return null;
}
