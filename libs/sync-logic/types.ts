import { DriveItem } from "../google-drive/types.js";

export interface UntrackedItem {
  id: string;
  path: string; // Relative path
  url: string; // Drive URL
  name: string;
  owner_email: string;
  ownership_transfer_requested: boolean; // Track if request was made this run
}

// Define type for successfully processed items for PR body generation
export type SuccessfullyProcessedItem = {
  path: string; // The original conceptual Drive path (e.g., "docs/My Doc")
  item: DriveItem; // The DriveItem object containing webViewLink etc.
};
