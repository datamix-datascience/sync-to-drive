import { GoogleGenAI, createUserContent } from "@google/genai";
import { Octokit } from "@octokit/rest";
import fetch from "node-fetch";
/**
 * Fetches an image from a URL and converts it to base64 along with its MIME type.
 * Includes retry logic for transient failures.
 * Now with added authentication for private repositories.
 */
export async function fetchBase64(url) {
    const maxRetries = 3;
    const retryDelay = 2000; // 2 seconds between retries
    // 認証用ヘッダーを準備（プライベートリポジトリ対応）
    const headers = {};
    if (process.env.GITHUB_TOKEN) {
        console.log("Adding GitHub token for authenticated fetch");
        // GitHub APIのベストプラクティスに合わせて認証ヘッダーを設定
        headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
        // GitHub APIからrawコンテンツを取得するためのAcceptヘッダーを追加
        headers["Accept"] = "application/vnd.github.v3.raw";
    }
    // raw.githubusercontent.com形式のURLをapi.github.com形式に変換
    let apiUrl = url;
    const rawGithubMatch = url.match(/https:\/\/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\/([^\/]+)\/(.+)/);
    if (rawGithubMatch) {
        const [, owner, repo, ref, path] = rawGithubMatch;
        apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
        console.log(`URL converted from raw to API format: ${apiUrl}`);
    }
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`Fetching image (attempt ${attempt}/${maxRetries}): ${apiUrl}`);
            const res = await fetch(apiUrl, { headers });
            if (!res.ok) {
                const errorMsg = `Failed to fetch image: ${res.status} ${res.statusText}`;
                console.log(`Response headers: ${JSON.stringify([...res.headers.entries()].reduce((obj, [key, val]) => ({ ...obj, [key]: val }), {}))}`);
                if (attempt < maxRetries) {
                    console.log(`${errorMsg} - Retrying in ${retryDelay / 1000} seconds...`);
                    await new Promise((resolve) => setTimeout(resolve, retryDelay));
                    continue;
                }
                throw new Error(errorMsg);
            }
            const contentType = res.headers.get("content-type") || "application/octet-stream";
            const buffer = Buffer.from(await res.arrayBuffer());
            return { data: buffer.toString("base64"), mimeType: contentType };
        }
        catch (error) {
            if (attempt < maxRetries) {
                console.log(`Error during fetch attempt ${attempt}: ${error.message} - Retrying in ${retryDelay / 1000} seconds...`);
                await new Promise((resolve) => setTimeout(resolve, retryDelay));
            }
            else {
                console.error(`All ${maxRetries} fetch attempts failed for URL: ${url}`);
                throw error; // Re-throw the last error after all retries fail
            }
        }
    }
    // This should never execute because the last failure will throw in the catch block
    throw new Error(`Failed to fetch image after ${maxRetries} attempts: ${url}`);
}
/**
 * Summarizes the differences between two images using Gemini API.
 */
export async function summarizeImageDiff(url1, url2) {
    // Initialize the Gemini client; ensure GEMINI_API_KEY env var is set
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    // Fetch and encode both images
    const image1 = await fetchBase64(url1);
    const image2 = await fetchBase64(url2);
    // Prepare the multimodal prompt
    const contents = createUserContent([
        "以下の2つの画像の違いを要約してください。",
        { inlineData: { mimeType: image1.mimeType, data: image1.data } },
        { inlineData: { mimeType: image2.mimeType, data: image2.data } },
    ]);
    // Call Gemini model
    const response = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents,
    });
    console.log("Difference summary:");
    console.log(response.text);
    return response.text || "No differences detected";
}
/**
 * Gets image URLs for before and after versions of a file in a PR.
 */
export async function getBeforeAfterUrls(owner, repo, prNumber, filePath) {
    const octokit = new Octokit({
        auth: process.env.GITHUB_TOKEN,
    });
    try {
        // Get PR details to find base and head commits
        const { data: pr } = await octokit.pulls.get({
            owner,
            repo,
            pull_number: prNumber,
        });
        const baseCommit = pr.base.sha;
        const headCommit = pr.head.sha;
        // パスをURIコンポーネントに分割してエンコード
        // '/path/to/file.png' → '/path/to/file.png'のように各セグメントをエンコード
        const encodedPath = filePath
            .split("/")
            .map((segment) => {
            // すでにエンコードされている場合は二重エンコードを避ける
            try {
                return encodeURIComponent(decodeURIComponent(segment));
            }
            catch (e) {
                return encodeURIComponent(segment);
            }
        })
            .join("/");
        console.log(`Checking file existence: ${filePath} (encoded: ${encodedPath})`);
        // Check if the file exists in the base and head
        let beforeExists = false;
        let afterExists = false;
        let beforeDownloadUrl = "";
        let afterDownloadUrl = "";
        try {
            // ファイルの内容ではなく、メタデータを取得（より効率的）
            const { data: baseContent } = await octokit.repos.getContent({
                owner,
                repo,
                path: filePath, // 元のパスを使用
                ref: baseCommit,
            });
            // 複数ファイルが返ってきた場合は対象外
            if (!Array.isArray(baseContent)) {
                beforeExists = true;
                // ファイルのdirectダウンロードURLを取得
                beforeDownloadUrl = baseContent.download_url || "";
                console.log(`File exists in base commit: ${baseCommit}, download URL: ${beforeDownloadUrl}`);
            }
        }
        catch (error) {
            console.log(`File ${filePath} does not exist in base commit ${baseCommit}: ${error.message}`);
        }
        try {
            // ファイルの内容ではなく、メタデータを取得（より効率的）
            const { data: headContent } = await octokit.repos.getContent({
                owner,
                repo,
                path: filePath, // 元のパスを使用
                ref: headCommit,
            });
            // 複数ファイルが返ってきた場合は対象外
            if (!Array.isArray(headContent)) {
                afterExists = true;
                // ファイルのdirectダウンロードURLを取得
                afterDownloadUrl = headContent.download_url || "";
                console.log(`File exists in head commit: ${headCommit}, download URL: ${afterDownloadUrl}`);
            }
        }
        catch (error) {
            console.log(`File ${filePath} does not exist in head commit ${headCommit}: ${error.message}`);
        }
        // If the file doesn't exist in either commit, return null
        if (!beforeExists && !afterExists) {
            return null;
        }
        // GitHub APIから直接提供されたダウンロードURLを使用（認証がそのまま有効）
        // 直接URLが取得できなかった場合、API URLを使用
        const baseUrl = beforeDownloadUrl ||
            `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${baseCommit}`;
        const headUrl = afterDownloadUrl ||
            `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${headCommit}`;
        console.log(`Generated URLs:
    Before (exists=${beforeExists}): ${baseUrl}
    After (exists=${afterExists}): ${headUrl}`);
        return {
            before: beforeExists ? baseUrl : "",
            after: afterExists ? headUrl : "",
        };
    }
    catch (error) {
        console.error(`Error getting PR details: ${error.message}`);
        if (error.stack) {
            console.debug(error.stack);
        }
        return null;
    }
}
/**
 * Gets all changed image files in a PR.
 */
export async function getChangedImageFiles(owner, repo, prNumber, diffDir = "_diff_") {
    const octokit = new Octokit({
        auth: process.env.GITHUB_TOKEN,
    });
    try {
        console.log(`Attempting to fetch files for PR #${prNumber} in ${owner}/${repo}`);
        // Get the list of files changed in the PR
        const { data: files } = await octokit.pulls.listFiles({
            owner,
            repo,
            pull_number: prNumber,
        });
        console.log(`Successfully fetched ${files.length} files from PR`);
        // Filter files that are images in the diff directory
        return files
            .filter((file) => file.filename.startsWith(diffDir + "/") &&
            file.filename.endsWith(".png") &&
            (file.status === "added" ||
                file.status === "modified" ||
                file.status === "changed"))
            .map((file) => file.filename);
    }
    catch (error) {
        // Check for 404 errors (PR not found or no permissions)
        if (error.status === 404) {
            console.log(`PR #${prNumber} not found or no access permissions. This is normal for some workflows.`);
            return []; // Return empty array instead of failing
        }
        // Check for authentication errors
        if (error.status === 401 || error.status === 403) {
            console.error(`Authentication error: GitHub token may not have sufficient permissions.`);
            console.error(`Required permissions: pull_requests:read, contents:read`);
            return []; // Return empty array
        }
        console.error(`Error getting changed files for PR #${prNumber}:`, error.message);
        if (error.response) {
            console.error(`Status: ${error.response.status}, GitHub message: ${error.response.data?.message || "No message"}`);
        }
        // For debugging purposes, check if the token is available (without revealing it)
        console.log(`GitHub token available: ${!!process.env.GITHUB_TOKEN}`);
        return []; // Return empty array on errors
    }
}
/**
 * Generates a comment with image differences for a PR.
 */
export async function generatePRComment(owner, repo, prNumber, diffDir = "_diff_") {
    // Get all changed image files
    const changedFiles = await getChangedImageFiles(owner, repo, prNumber, diffDir);
    if (changedFiles.length === 0) {
        return "No image changes detected in this PR.";
    }
    // Group files by their parent directory (slide deck)
    const filesByDirectory = {};
    for (const file of changedFiles) {
        const dir = file.substring(0, file.lastIndexOf("/"));
        if (!filesByDirectory[dir]) {
            filesByDirectory[dir] = [];
        }
        filesByDirectory[dir].push(file);
    }
    let commentParts = ["# Visual Differences Summary\n"];
    // Process each directory (slide deck)
    for (const [dir, files] of Object.entries(filesByDirectory)) {
        const slideName = dir.split("/").pop() || "";
        commentParts.push(`## ${slideName}\n`);
        // Process each file (slide)
        for (const file of files) {
            try {
                const slidePage = file.split("/").pop() || "";
                // エンコードされたファイルパスを使用する
                const encodedFile = file
                    .split("/")
                    .map((segment) => encodeURIComponent(segment))
                    .join("/");
                console.log(`Processing slide: ${file} (encoded: ${encodedFile})`);
                const urls = await getBeforeAfterUrls(owner, repo, prNumber, file);
                if (urls && (urls.before || urls.after)) {
                    commentParts.push(`### Slide ${slidePage.replace(".png", "")}\n`);
                    // URLにエンコードを適用
                    const encodedBefore = urls.before
                        ? urls.before.replace(/\/([^/]+)$/, (match, fileName) => `/${encodeURIComponent(fileName)}`)
                        : "";
                    const encodedAfter = urls.after
                        ? urls.after.replace(/\/([^/]+)$/, (match, fileName) => `/${encodeURIComponent(fileName)}`)
                        : "";
                    if (encodedBefore && encodedAfter) {
                        // Both before and after exist - compare them
                        try {
                            const diffSummary = await summarizeImageDiff(encodedBefore, encodedAfter);
                            commentParts.push("**Changes:**\n");
                            commentParts.push(diffSummary + "\n");
                            // Add links to the images
                            commentParts.push(`<details><summary>Before/After Images</summary>\n\n`);
                            commentParts.push(`**Before:**\n`);
                            commentParts.push(`![Before](${encodedBefore})\n\n`);
                            commentParts.push(`**After:**\n`);
                            commentParts.push(`![After](${encodedAfter})\n`);
                            commentParts.push(`</details>\n`);
                        }
                        catch (compareError) {
                            console.error(`Failed to compare images: ${compareError.message}`);
                            commentParts.push("**Error comparing images:**\n");
                            commentParts.push(`Could not generate comparison due to error: ${compareError.message}\n`);
                            // Still include the images if possible
                            commentParts.push(`<details><summary>Before/After Images (No comparison available)</summary>\n\n`);
                            commentParts.push(`**Before:**\n`);
                            commentParts.push(`![Before](${encodedBefore})\n\n`);
                            commentParts.push(`**After:**\n`);
                            commentParts.push(`![After](${encodedAfter})\n`);
                            commentParts.push(`</details>\n`);
                        }
                    }
                    else if (encodedAfter) {
                        // Only after exists - new slide
                        commentParts.push("**New Slide Added**\n");
                        commentParts.push(`![New Slide](${encodedAfter})\n`);
                    }
                    else if (encodedBefore) {
                        // Only before exists - deleted slide
                        commentParts.push("**Slide Deleted**\n");
                        commentParts.push(`![Deleted Slide](${encodedBefore})\n`);
                    }
                }
            }
            catch (fileError) {
                console.error(`Error processing file ${file}: ${fileError.message}`);
                commentParts.push(`### Error processing slide ${file.split("/").pop()?.replace(".png", "") || ""}\n`);
                commentParts.push(`Could not process this slide due to error: ${fileError.message}\n`);
            }
        }
    }
    return commentParts.join("\n");
}
/**
 * Posts a comment to a PR with image differences.
 */
export async function postPRComment(owner, repo, prNumber, comment) {
    const octokit = new Octokit({
        auth: process.env.GITHUB_TOKEN,
    });
    try {
        await octokit.issues.createComment({
            owner,
            repo,
            issue_number: prNumber,
            body: comment,
        });
        console.log(`Comment posted to PR #${prNumber}`);
    }
    catch (error) {
        console.error("Error posting comment:", error);
    }
}
