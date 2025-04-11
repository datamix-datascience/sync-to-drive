export interface UntrackedItem {
  id: string;
  path: string; // Relative path
  url: string; // Drive URL
  name: string;
  owner_email: string;
  ownership_transfer_requested: boolean; // Track if request was made this run
}
