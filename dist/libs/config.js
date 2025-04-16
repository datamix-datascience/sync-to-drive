import * as core from "@actions/core";
import { readFileSync } from "fs";
// Load config
let config;
try {
    config = JSON.parse(readFileSync("sync.json", "utf-8"));
}
catch (error) {
    core.setFailed("Failed to load sync.json: " + error.message);
    // Exit in the main script, not here, to allow potential cleanup or specific handling
    throw new Error("sync.json loading failed"); // Re-throw to signal failure
}
export { config };
