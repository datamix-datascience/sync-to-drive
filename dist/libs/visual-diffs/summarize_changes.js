import * as core from "@actions/core";
import { GoogleGenAI } from "@google/genai";
// Initialize Gemini API client
function initializeGeminiAPI() {
    const apiKey = core.getInput("gemini_api_key", { required: true });
    if (!apiKey) {
        throw new Error("Gemini API key is missing. Please configure the gemini_api_key input.");
    }
    return new GoogleGenAI({ apiKey });
}
// Function to get PR changes
async function getPRChanges(octokit, owner, repo, pr_number) {
    try {
        const { data: files } = await octokit.pulls.listFiles({
            owner,
            repo,
            pull_number: pr_number,
        });
        let changesText = "";
        for (const file of files) {
            changesText += `File: ${file.filename}\n`;
            changesText += `Status: ${file.status}\n`;
            changesText += `Changes: +${file.additions} -${file.deletions}\n\n`;
            if (file.patch) {
                changesText += `Patch:\n${file.patch}\n\n`;
            }
        }
        return changesText;
    }
    catch (error) {
        core.error(`Failed to get PR changes: ${error.message}`);
        throw error;
    }
}
// Function to generate summary using Gemini
async function generateSummary(genAI, changes) {
    try {
        const response = await genAI.models.generateContent({
            model: "gemini-2.0-flash-001",
            contents: `以下のプルリクエストの変更内容を日本語で簡潔に要約してください。技術的な変更点を重視して説明してください：\n\n${changes}`,
        });
        if (!response.text) {
            throw new Error("No summary generated from Gemini API");
        }
        return response.text;
    }
    catch (error) {
        core.error(`Failed to generate summary: ${error.message}`);
        throw error;
    }
}
// Function to post summary as PR comment
async function postSummaryToPR(octokit, owner, repo, pr_number, summary) {
    try {
        await octokit.issues.createComment({
            owner,
            repo,
            issue_number: pr_number,
            body: `## 🤖 変更内容の要約\n\n${summary}`,
        });
        core.info("Successfully posted summary to PR");
    }
    catch (error) {
        core.error(`Failed to post summary to PR: ${error.message}`);
        throw error;
    }
}
// Main function to summarize PR changes
export async function summarizePRChanges(octokit, owner, repo, pr_number) {
    try {
        core.info("Initializing Gemini API...");
        const genAI = initializeGeminiAPI();
        core.info("Getting PR changes...");
        const changes = await getPRChanges(octokit, owner, repo, pr_number);
        core.info("Generating summary...");
        const summary = await generateSummary(genAI, changes);
        core.info("Posting summary to PR...");
        await postSummaryToPR(octokit, owner, repo, pr_number, summary);
        core.info("Successfully summarized PR changes!");
    }
    catch (error) {
        core.error(`Failed to summarize PR changes: ${error.message}`);
        throw error;
    }
}
