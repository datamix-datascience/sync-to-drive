import * as core from "@actions/core";
import { GoogleGenAI, createUserContent } from "@google/genai";
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
// Function to get diff images
async function getDiffImages(files) {
    const diffImages = files
        .filter((file) => file.filename.startsWith("_diff_") && file.filename.endsWith(".png"))
        .map(async (file) => {
        // Download image from GitHub
        const response = await fetch(file.raw_url);
        const arrayBuffer = await response.arrayBuffer();
        const base64Data = Buffer.from(arrayBuffer).toString("base64");
        return {
            inlineData: {
                mimeType: "image/png",
                data: base64Data,
            },
        };
    });
    return Promise.all(diffImages);
}
// Function to generate summary using Gemini
async function generateSummary(genAI, changes, images) {
    try {
        const response = await genAI.models.generateContent({
            model: "gemini-2.0-flash",
            contents: createUserContent([
                `以下のプルリクエストの変更内容と、スライドのプレビュー画像を確認して要約してください。
日本語と英語の両方で出力してください。

フォーマット：
[日本語での要約]
変更内容をここに記述

[English Summary]
Describe changes here

変更内容：
1. ファイルの変更点：
${changes}

2. スライドの変更点：
添付された画像はスライドの差分を表しています。画像の内容から変更点を説明してください。`,
                ...images,
            ]),
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
            body: `## 🤖 変更内容の要約 / Change Summary\n\n${summary}`,
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
        const { data: pr } = await octokit.pulls.listFiles({
            owner,
            repo,
            pull_number: pr_number,
        });
        const changes = await getPRChanges(octokit, owner, repo, pr_number);
        const images = await getDiffImages(pr);
        core.info("Generating summary...");
        const summary = await generateSummary(genAI, changes, images);
        core.info("Posting summary to PR...");
        await postSummaryToPR(octokit, owner, repo, pr_number, summary);
        core.info("Successfully summarized PR changes!");
    }
    catch (error) {
        core.error(`Failed to summarize PR changes: ${error.message}`);
        throw error;
    }
}
