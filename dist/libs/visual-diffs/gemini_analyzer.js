// Placeholder for Gemini analysis logic
import * as core from "@actions/core";
import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory, } from "@google/generative-ai";
import * as fs from "fs";
// Function to convert local file path to a GoogleGenerativeAI.Part object
// Based on Gemini documentation example
function fileToGenerativePart(filePath, mimeType) {
    core.debug(`Reading file for Gemini: ${filePath}`);
    return {
        inlineData: {
            data: Buffer.from(fs.readFileSync(filePath)).toString("base64"),
            mimeType,
        },
    };
}
/**
 * Analyzes the visual difference between two images using the Gemini API.
 * Handles cases where one image might be missing (e.g., added/deleted files/pages).
 *
 * @param base_png_path Path to the base image (or null if added).
 * @param head_png_path Path to the head image (or null if deleted).
 * @param api_key Gemini API Key.
 * @param model_name The Gemini model to use (e.g., "gemini-1.5-flash-latest").
 * @returns A Promise resolving to a string containing the analysis description, or null if analysis fails.
 */
export async function analyze_image_diff_with_gemini(base_png_path, head_png_path, api_key, model_name = "gemini-1.5-flash-latest" // Default model
) {
    if (!api_key) {
        core.warning("Gemini API key is missing. Cannot perform analysis.");
        return null;
    }
    if (!base_png_path && !head_png_path) {
        core.warning("Both base and head image paths are null. Cannot perform analysis.");
        return null;
    }
    core.info(`Analyzing difference with Gemini (Model: ${model_name})`);
    core.info(` -> Base Image: ${base_png_path ?? "N/A (Added)"}`);
    core.info(` -> Head Image: ${head_png_path ?? "N/A (Deleted)"}`);
    try {
        const genAI = new GoogleGenerativeAI(api_key);
        const model = genAI.getGenerativeModel({
            model: model_name,
            // Simple safety settings - adjust as needed
            safetySettings: [
                {
                    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
                    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
                },
            ],
        });
        const parts = [];
        let prompt = "";
        if (base_png_path && head_png_path) {
            // Standard diff case
            prompt =
                "あなたは優秀なUI/UXデザイナーです。添付された2つの画像（変更前と変更後）を比較し、見た目の差分とそれがユーザー体験に与える影響について簡潔に説明してください。差分がない場合は「差分はありません」とだけ回答してください。差分がある場合は、箇条書きで3点以内にまとめてください。";
            parts.push({ text: "変更前の画像:" });
            parts.push(fileToGenerativePart(base_png_path, "image/png"));
            parts.push({ text: "変更後の画像:" });
            parts.push(fileToGenerativePart(head_png_path, "image/png"));
        }
        else if (head_png_path) {
            // Added file/page case
            prompt =
                "あなたは優秀なUI/UXデザイナーです。添付された画像は新しく追加されたものです。この画像の内容と、ユーザー体験にどのような意味を持つかについて簡潔に説明してください。箇条書きで3点以内にまとめてください。";
            parts.push({ text: "追加された画像:" });
            parts.push(fileToGenerativePart(head_png_path, "image/png"));
        }
        else if (base_png_path) {
            // Deleted file/page case - Return a simple message without calling the API for deletions.
            core.info("Returning standard message for deleted image.");
            return "画像が削除されました。";
        }
        core.info(`Prompting Gemini...`);
        const result = await model.generateContent([prompt, ...parts]);
        const response = result.response;
        if (!response) {
            throw new Error("Gemini API returned no response.");
        }
        // Handle potential safety blocks
        if (response.promptFeedback?.blockReason) {
            core.error(`Gemini request blocked: ${response.promptFeedback.blockReason}`);
            if (response.promptFeedback.safetyRatings) {
                core.error(`Safety Ratings: ${JSON.stringify(response.promptFeedback.safetyRatings)}`);
            }
            return `*エラー: Geminiによる分析が安全上の理由でブロックされました (${response.promptFeedback.blockReason})*`;
        }
        const analysis_text = response.text();
        core.info(`Gemini analysis received: ${analysis_text.substring(0, 100)}...`); // Log first 100 chars
        return analysis_text;
    }
    catch (error) {
        core.error(`Gemini analysis failed: ${error.message}`);
        if (error.response) {
            core.error(`Gemini API Error Details: ${JSON.stringify(error.response)}`);
        }
        else if (error.message.includes("429")) {
            return `*エラー: Gemini APIのレート制限に達しました。しばらく待ってから再試行してください。*`;
        }
        else if (error.message.includes("API key not valid")) {
            return `*エラー: 提供されたGemini APIキーが無効です。*`;
        }
        return `*エラー: Geminiによる分析中に問題が発生しました。* (${error.message})`; // Return error message for comment
    }
}
/**
 * Formats the analysis results into a markdown string for the PR comment.
 *
 * @param analysis_results Array of analysis result objects.
 * @param repo_url URL of the repository (used for linking files - optional but helpful).
 * @param head_sha SHA of the head commit (used for linking files - optional but helpful).
 * @returns A markdown formatted string.
 */
export function format_pr_comment(analysis_results, repo_url, head_sha) {
    let comment_body = "## ✨ Visual Diff Analysis ✨\n\n";
    comment_body += "Gemini先生による画像差分の分析結果だよ！📝\n\n";
    if (analysis_results.length === 0) {
        comment_body += "_分析対象の変更はありませんでした。_\n";
        return comment_body;
    }
    // Group results by file path
    const results_by_file = {};
    for (const result of analysis_results) {
        if (!results_by_file[result.filePath]) {
            results_by_file[result.filePath] = [];
        }
        results_by_file[result.filePath].push({
            page: result.page,
            analysis: result.analysis,
        });
    }
    for (const filePath in results_by_file) {
        const file_results = results_by_file[filePath];
        // Attempt to create a link to the file at the specific commit
        const file_link = repo_url && head_sha
            ? `[\`${filePath}\`](${repo_url}/blob/${head_sha}/${filePath})`
            : `\`${filePath}\``;
        comment_body += `### ${file_link}\n`;
        // Sort results: File status (Added/Removed/etc.) first, then by page number
        file_results.sort((a, b) => {
            if (a.page === 0 && b.page !== 0)
                return -1; // File status comes first
            if (a.page !== 0 && b.page === 0)
                return 1;
            return a.page - b.page; // Then sort by page number
        });
        for (const result of file_results) {
            if (result.page === 0) {
                // File level status (Added/Removed)
                comment_body += `- ${result.analysis || "*不明なステータス*"}\n`;
            }
            else {
                // Page level analysis
                // Indent page analysis slightly
                comment_body += `  - **ページ ${result.page}:** ${result.analysis || "*分析結果なし*"}\n`;
            }
        }
        comment_body += "\n"; // Add space between files
    }
    comment_body += "\n---\n*Powered by Google Gemini & Peopledot Inc.*";
    return comment_body;
}
