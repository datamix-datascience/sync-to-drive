import { GoogleGenAI, createUserContent } from "@google/genai";
import { Octokit } from "@octokit/rest";
import fetch from "node-fetch";

/**
 * Fetches an image from a URL and converts it to base64 along with its MIME type.
 */
export async function fetchBase64(
  url: string
): Promise<{ data: string; mimeType: string }> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch image: ${res.status} ${res.statusText}`);
  }
  const contentType =
    res.headers.get("content-type") || "application/octet-stream";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { data: buffer.toString("base64"), mimeType: contentType };
}

/**
 * Summarizes the differences between two images using Gemini API.
 */
export async function summarizeImageDiff(
  url1: string,
  url2: string
): Promise<string> {
  // Initialize the Gemini client; ensure GEMINI_API_KEY env var is set
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

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
export async function getBeforeAfterUrls(
  owner: string,
  repo: string,
  prNumber: number,
  filePath: string
): Promise<{ before: string; after: string } | null> {
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

    // Check if the file exists in the base and head
    let beforeExists = false;
    let afterExists = false;

    try {
      await octokit.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref: baseCommit,
      });
      beforeExists = true;
    } catch (error) {
      console.log(
        `File ${filePath} does not exist in base commit ${baseCommit}`
      );
    }

    try {
      await octokit.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref: headCommit,
      });
      afterExists = true;
    } catch (error) {
      console.log(
        `File ${filePath} does not exist in head commit ${headCommit}`
      );
    }

    // If the file doesn't exist in either commit, return null
    if (!beforeExists && !afterExists) {
      return null;
    }

    // Construct raw GitHub URLs
    const baseUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${baseCommit}/${filePath}`;
    const headUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${headCommit}/${filePath}`;

    return {
      before: beforeExists ? baseUrl : "",
      after: afterExists ? headUrl : "",
    };
  } catch (error) {
    console.error("Error getting PR details:", error);
    return null;
  }
}

/**
 * Gets all changed image files in a PR.
 */
export async function getChangedImageFiles(
  owner: string,
  repo: string,
  prNumber: number,
  diffDir: string = "_diff_"
): Promise<string[]> {
  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
  });

  try {
    // Get the list of files changed in the PR
    const { data: files } = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
    });

    // Filter files that are images in the diff directory
    return files
      .filter(
        (file) =>
          file.filename.startsWith(diffDir + "/") &&
          file.filename.endsWith(".png") &&
          (file.status === "added" ||
            file.status === "modified" ||
            file.status === "changed")
      )
      .map((file) => file.filename);
  } catch (error) {
    console.error("Error getting changed files:", error);
    return [];
  }
}

/**
 * Generates a comment with image differences for a PR.
 */
export async function generatePRComment(
  owner: string,
  repo: string,
  prNumber: number,
  diffDir: string = "_diff_"
): Promise<string> {
  // Get all changed image files
  const changedFiles = await getChangedImageFiles(
    owner,
    repo,
    prNumber,
    diffDir
  );
  if (changedFiles.length === 0) {
    return "No image changes detected in this PR.";
  }

  // Group files by their parent directory (slide deck)
  const filesByDirectory: Record<string, string[]> = {};
  for (const file of changedFiles) {
    const dir = file.substring(0, file.lastIndexOf("/"));
    if (!filesByDirectory[dir]) {
      filesByDirectory[dir] = [];
    }
    filesByDirectory[dir].push(file);
  }

  let commentParts: string[] = ["# Visual Differences Summary\n"];

  // Process each directory (slide deck)
  for (const [dir, files] of Object.entries(filesByDirectory)) {
    const slideName = dir.split("/").pop() || "";
    commentParts.push(`## ${slideName}\n`);

    // Process each file (slide)
    for (const file of files) {
      const slidePage = file.split("/").pop() || "";
      const urls = await getBeforeAfterUrls(owner, repo, prNumber, file);

      if (urls && (urls.before || urls.after)) {
        commentParts.push(`### Slide ${slidePage.replace(".png", "")}\n`);

        if (urls.before && urls.after) {
          // Both before and after exist - compare them
          const diffSummary = await summarizeImageDiff(urls.before, urls.after);
          commentParts.push("**Changes:**\n");
          commentParts.push(diffSummary + "\n");

          // Add links to the images
          commentParts.push(
            `<details><summary>Before/After Images</summary>\n\n`
          );
          commentParts.push(`**Before:**\n`);
          commentParts.push(`![Before](${urls.before})\n\n`);
          commentParts.push(`**After:**\n`);
          commentParts.push(`![After](${urls.after})\n`);
          commentParts.push(`</details>\n`);
        } else if (urls.after) {
          // Only after exists - new slide
          commentParts.push("**New Slide**\n");
          commentParts.push(`![New Slide](${urls.after})\n`);
        } else if (urls.before) {
          // Only before exists - deleted slide
          commentParts.push("**Deleted Slide**\n");
          commentParts.push(`![Deleted Slide](${urls.before})\n`);
        }
      }
    }
  }

  return commentParts.join("\n");
}

/**
 * Posts a comment to a PR with image differences.
 */
export async function postPRComment(
  owner: string,
  repo: string,
  prNumber: number,
  comment: string
): Promise<void> {
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
  } catch (error) {
    console.error("Error posting comment:", error);
  }
}
