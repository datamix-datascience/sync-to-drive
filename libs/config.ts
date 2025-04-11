import * as core from "@actions/core";
import { readFileSync } from "fs";

// Config types
export interface DriveTarget {
  drive_folder_id: string;
  drive_url: string;
  on_untrack: "ignore" | "remove" | "request";
}

export interface SyncConfig {
  source: { repo: string };
  ignore: string[];
  targets: { forks: DriveTarget[] };
}

// Load config
let config: SyncConfig;
try {
  config = JSON.parse(readFileSync("sync.json", "utf-8"));
} catch (error) {
  core.setFailed("Failed to load sync.json: " + (error as Error).message);
  // Exit in the main script, not here, to allow potential cleanup or specific handling
  throw new Error("sync.json loading failed"); // Re-throw to signal failure
}

export { config };
