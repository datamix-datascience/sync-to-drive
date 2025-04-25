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
    // Prepare authentication headers (for private repositories)
    const headers = {};
    if (process.env.GITHUB_TOKEN) {
        console.log("Adding GitHub token for authenticated fetch");
        // Set authentication header according to GitHub API best practices
        headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
        // Add Accept header to fetch raw content from GitHub API
        headers["Accept"] = "application/vnd.github.v3.raw";
    }
    // Convert raw.githubusercontent.com URL format to api.github.com format
    let apiUrl = url;
    const rawGithubMatch = url.match(/https:\/\/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\/([^\/]+)\/(.+)/);
    if (rawGithubMatch) {
        const [, owner, repo, ref, path] = rawGithubMatch;
        // Separate query parameters from path
        let cleanPath = path;
        // Remove query parameters starting with ? or %3F
        if (cleanPath.includes("?")) {
            cleanPath = cleanPath.split("?")[0];
        }
        if (cleanPath.includes("%3F")) {
            cleanPath = cleanPath.split("%3F")[0];
        }
        apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${cleanPath}?ref=${ref}`;
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
            // Get the original Content-Type
            const originalContentType = res.headers.get("content-type") || "application/octet-stream";
            // Convert to MIME type supported by Gemini API
            // Convert responses from GitHub API such as application/vnd.github.v3.raw; charset=utf-8
            let mimeType = originalContentType;
            // Handle special MIME types from GitHub API
            if (mimeType.includes("application/vnd.github.v3.raw")) {
                // Determine by image file path extension
                if (url.toLowerCase().endsWith(".png")) {
                    mimeType = "image/png";
                }
                else if (url.toLowerCase().match(/\.(jpg|jpeg)$/)) {
                    mimeType = "image/jpeg";
                }
                else if (url.toLowerCase().endsWith(".webp")) {
                    mimeType = "image/webp";
                }
                else {
                    // Default to image/png
                    mimeType = "image/png";
                }
            }
            // Remove charset part (not supported by Gemini API)
            if (mimeType.includes(";")) {
                mimeType = mimeType.split(";")[0].trim();
            }
            console.log(`Original content type: ${originalContentType}, using: ${mimeType}`);
            const buffer = Buffer.from(await res.arrayBuffer());
            return { data: buffer.toString("base64"), mimeType: mimeType };
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
        "The first image shows the document before changes, the second image shows after changes. Please summarize what changes were made. Please provide the output in both English and Japanese.",
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
 * Summarizes the content of a newly added image using Gemini API.
 */
export async function summarizeNewImage(url) {
    // Initialize the Gemini client; ensure GEMINI_API_KEY env var is set
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    // Fetch and encode the image
    console.log(`Fetching new image to analyze from URL: ${url.substring(0, 50)}...`);
    const image = await fetchBase64(url);
    console.log(`New image fetched successfully, MIME type: ${image.mimeType}`);
    // Prepare the multimodal prompt
    const contents = createUserContent([
        "This is a newly added document. Please summarize its content. Please provide the output in both English and Japanese.",
        { inlineData: { mimeType: image.mimeType, data: image.data } },
    ]);
    // Call Gemini model
    console.log(`Calling Gemini model for new image analysis...`);
    const response = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents,
    });
    console.log("New image content summary:");
    console.log(response.text);
    return response.text || "Could not analyze image content";
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
        // Split and encode path as URI components
        // '/path/to/file.png' → encoding each segment like '/path/to/file.png'
        const encodedPath = filePath
            .split("/")
            .map((segment) => {
            // Avoid double encoding if already encoded
            try {
                // Remove query parameters starting with ? or %3F
                let cleanSegment = segment;
                if (cleanSegment.includes("?")) {
                    cleanSegment = cleanSegment.split("?")[0];
                }
                if (cleanSegment.includes("%3F")) {
                    cleanSegment = cleanSegment.split("%3F")[0];
                }
                return encodeURIComponent(decodeURIComponent(cleanSegment));
            }
            catch (e) {
                // Remove query parameters starting with ? or %3F
                let cleanSegment = segment;
                if (cleanSegment.includes("?")) {
                    cleanSegment = cleanSegment.split("?")[0];
                }
                if (cleanSegment.includes("%3F")) {
                    cleanSegment = cleanSegment.split("%3F")[0];
                }
                return encodeURIComponent(cleanSegment);
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
            // Get file metadata (more efficient than content)
            const { data: baseContent } = await octokit.repos.getContent({
                owner,
                repo,
                path: filePath, // Using original path
                ref: baseCommit,
            });
            // Skip if multiple files are returned
            if (!Array.isArray(baseContent)) {
                beforeExists = true;
                // Get direct download URL
                beforeDownloadUrl = baseContent.download_url || "";
                console.log(`File exists in base commit: ${baseCommit}, download URL: ${beforeDownloadUrl}`);
            }
        }
        catch (error) {
            console.log(`File ${filePath} does not exist in base commit ${baseCommit}: ${error.message}`);
        }
        try {
            // Get file metadata (more efficient than content)
            const { data: headContent } = await octokit.repos.getContent({
                owner,
                repo,
                path: filePath, // Using original path
                ref: headCommit,
            });
            // Skip if multiple files are returned
            if (!Array.isArray(headContent)) {
                afterExists = true;
                // Get direct download URL
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
        // Use download URLs directly provided by GitHub API (authentication remains valid)
        // If direct URL not available, use API URL
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
        // Format slide name
        let formattedSlideName = slideName;
        let fileType = "";
        // Split filename and extension (at first ".")
        const nameParts = slideName.split(".");
        if (nameParts.length > 1) {
            // Use extension part as file type
            fileType = nameParts[nameParts.length - 1];
            // Get the first part
            formattedSlideName = nameParts[0];
        }
        // Split at "--" and get the first part (remove ID)
        if (formattedSlideName.includes("--")) {
            formattedSlideName = formattedSlideName.split("--")[0];
        }
        commentParts.push(`## [${fileType}] ${formattedSlideName}\n`);
        // Process each file (slide)
        for (const file of files) {
            try {
                const slidePage = file.split("/").pop() || "";
                // Use encoded file path
                const encodedFile = file
                    .split("/")
                    .map((segment) => {
                    // Remove query parameters if present
                    let cleanSegment = segment;
                    if (cleanSegment.includes("?")) {
                        cleanSegment = cleanSegment.split("?")[0];
                    }
                    if (cleanSegment.includes("%3F")) {
                        cleanSegment = cleanSegment.split("%3F")[0];
                    }
                    return encodeURIComponent(cleanSegment);
                })
                    .join("/");
                console.log(`Processing slide: ${file} (encoded: ${encodedFile})`);
                const urls = await getBeforeAfterUrls(owner, repo, prNumber, file);
                if (urls && (urls.before || urls.after)) {
                    commentParts.push(`### Page ${slidePage.replace(".png", "")}\n`);
                    // Apply encoding to URLs
                    const encodedBefore = urls.before
                        ? urls.before.replace(/\/([^/]+)$/, (match, fileName) => {
                            // Remove query parameters if present
                            let cleanFileName = fileName;
                            if (cleanFileName.includes("?")) {
                                cleanFileName = cleanFileName.split("?")[0];
                            }
                            if (cleanFileName.includes("%3F")) {
                                cleanFileName = cleanFileName.split("%3F")[0];
                            }
                            return `/${encodeURIComponent(cleanFileName)}`;
                        })
                        : "";
                    const encodedAfter = urls.after
                        ? urls.after.replace(/\/([^/]+)$/, (match, fileName) => {
                            // Remove query parameters if present
                            let cleanFileName = fileName;
                            if (cleanFileName.includes("?")) {
                                cleanFileName = cleanFileName.split("?")[0];
                            }
                            if (cleanFileName.includes("%3F")) {
                                cleanFileName = cleanFileName.split("%3F")[0];
                            }
                            return `/${encodeURIComponent(cleanFileName)}`;
                        })
                        : "";
                    if (encodedBefore && encodedAfter) {
                        // Both before and after exist - compare them
                        try {
                            const diffSummary = await summarizeImageDiff(encodedBefore, encodedAfter);
                            commentParts.push("**Changes:**\n");
                            commentParts.push(diffSummary + "\n");
                            // Removed image links
                        }
                        catch (compareError) {
                            console.error(`Failed to compare images: ${compareError.message}`);
                            commentParts.push("**Error comparing images:**\n");
                            commentParts.push(`Could not generate comparison due to error: ${compareError.message}\n`);
                        }
                    }
                    else if (encodedAfter) {
                        // Only after exists - new slide
                        commentParts.push("**New Page Added**\n");
                        // Summarize content of newly added image
                        try {
                            console.log(`Analyzing new image content for: ${file}`);
                            const contentSummary = await summarizeNewImage(encodedAfter);
                            console.log(`New image content summary generated successfully.`);
                            commentParts.push("**Content:**\n");
                            commentParts.push(contentSummary + "\n");
                        }
                        catch (contentError) {
                            console.error(`Failed to analyze new image content: ${contentError.message}`);
                            commentParts.push("**Error analyzing image content:**\n");
                            commentParts.push(`Could not generate content summary due to error: ${contentError.message}\n`);
                        }
                    }
                    else if (encodedBefore) {
                        // Only before exists - deleted slide
                        commentParts.push("**Page Deleted**\n");
                    }
                }
            }
            catch (fileError) {
                console.error(`Error processing file ${file}: ${fileError.message}`);
                commentParts.push(`### Error processing page ${file.split("/").pop()?.replace(".png", "") || ""}\n`);
                commentParts.push(`Could not process this page due to error: ${fileError.message}\n`);
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
