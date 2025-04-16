# Sync to Drive

A GitHub Action to recursively sync files between a source repository and one or more Google Drive folders using a Google Service Account. It supports bidirectional synchronization, handling Google Docs, ignoring files, managing untracked items, and creating Pull Requests for changes originating from Drive.

## Features

-   **Bidirectional Sync:**
    -   **Local → Drive (on `push`):** Uploads files/folders from the repo to Drive, preserving structure.
    -   **Drive → Local (configurable trigger):** Detects changes in Drive (new/modified files, deletions) and creates a Pull Request in the source repository with these changes.
-   **Multiple Drive Targets:** Syncs to multiple Google Drive folders (defined as "forks") configured in `sync.json`.
-   **Ignore Patterns:** Excludes files/folders matching glob patterns defined in `sync.json` and also respects patterns found in the repository's `.gitignore` file.
-   **Google Doc Handling:** Represents Google Docs (Docs, Sheets, Slides, etc.) as local `.type.json.txt` shortcut files containing the Drive URL and ID, avoiding direct content sync.
-   **Untracked File Handling (Drive):** When syncing Local -> Drive (on `push`), options to handle files/folders found in Drive but not in the repo:
    -   `ignore`: Leave untracked items untouched.
    -   `remove`: Move untracked items *owned by the service account* to the Drive Trash.
    -   `request`: If an untracked item is *not owned* by the service account, initiate an ownership transfer request to the current owner.
-   **Ownership Management:**
    -   Automatically accepts pending ownership transfers to the service account on every run.
    -   Can request ownership transfer for untracked files (see `on_untrack: request`).
-   **Hash-Based Updates (Local → Drive):** Only uploads/updates files to Drive when their content (MD5 hash) changes or if the filename needs correction. Overwrites existing Drive file content on hash mismatch.
-   **Pull Request Integration (Drive → Local):** Automatically creates/updates a Pull Request when changes are detected originating from Google Drive, allowing review before merging into the repository.

## Configuration (`sync.json`)

Place a `sync.json` file in the root of your source repository to define the sync behavior.

-   `source.repo` (string): The source repository's Git URL (e.g., `git@github.com:yourusername/resources.git`). Purely informational for documentation.
-   `ignore` (array of strings): Glob patterns specifying files/folders to exclude from syncing (e.g., `*.log`, `node_modules/**`). Patterns from `.gitignore` are also automatically included.
-   `targets.forks` (array of objects): List of target Google Drive folders. Each object configures a target:
    -   `drive_folder_id` (string): The ID of the target Google Drive folder.
    -   `drive_url` (string): The full URL of the Drive folder (for reference).
    -   `on_untrack` (string, `"ignore" | "remove" | "request"`): How to handle items found in Drive but not in the source repo during a `push`-triggered sync.
        -   `"ignore"`: Leaves untracked items untouched.
        -   `"remove"`: Moves untracked items **owned by the service account** to Drive Trash. Skips items not owned by the service account.
        -   `"request"`: If an untracked item is **not owned** by the service account, requests ownership transfer from the current owner via email notification. Does nothing to items already owned by the service account.
    -   **Note:** The `on_conflict` setting from previous versions is removed. Conflict handling is now implicit: Local -> Drive always overwrites content on hash mismatch and corrects Drive filenames; Drive -> Local changes are always proposed via Pull Request.

```json
{
  "source": {
    "repo": "git@github.com:yourusername/resources.git"
  },
  "ignore": [
    "*.log",
    "node_modules/**",
    ".git/",
    "dist/"
  ],
  "targets": {
    "forks": [
      {
        "drive_folder_id": "123_folder_id_alpha",
        "drive_url": "https://drive.google.com/drive/folders/123_folder_id_alpha",
        "on_untrack": "ignore"
      },
      {
        "drive_folder_id": "456_folder_id_beta",
        "drive_url": "https://drive.google.com/drive/folders/456_folder_id_beta",
        "on_untrack": "remove"
      },
      {
        "drive_folder_id": "789_folder_id_gamma",
        "drive_url": "https://drive.google.com/drive/folders/789_folder_id_gamma",
        "on_untrack": "request"
      }
    ]
  }
}
```

## Usage

1.  **Create Google Service Account & Credentials**:
    -   Go to [Google Cloud Console](https://console.cloud.google.com/).
    -   Create/select a project, **Enable the Google Drive API**.
    -   Create a Service Account (IAM & Admin > Service Accounts).
    -   Create a JSON key for the Service Account and download `credentials.json`. **Keep this secure!**
    -   **Share Target Drive Folders**: Share each target Google Drive folder with the Service Account's email address (e.g., `your-sa@your-project.iam.gserviceaccount.com`) granting it **"Editor" permissions**.

2.  **Encode Credentials**:
    -   Convert the **entire content** of `credentials.json` into a single Base64 string.
    -   Linux: `base64 -w 0 credentials.json`
    -   macOS: `base64 -i credentials.json`
    -   Copy the output.

3.  **Set Up Repository Secrets**:
    -   In your source GitHub repository, go to Settings > Secrets and Variables > Actions.
    -   Add a secret named `DRIVE_CREDENTIALS` with the Base64 encoded string from Step 2.
    -   Add the default `GITHUB_TOKEN` secret (usually available automatically, but permissions need setting in the workflow).

4.  **Configure Repository**:
    -   Add the `sync.json` file (as described above) to the root of your source repository.
    -   Ensure a `.gitignore` file exists if you want its patterns respected.
    -   Create a workflow file (e.g., `.github/workflows/sync_to_drive.yml`):

     ```yaml
     name: Sync To/From Google Drive

     on:
       push:
         branches:
           - main # Sync Local -> Drive on pushes to main
       workflow_dispatch: # Allow manual trigger to sync Drive -> Local PR
       # schedule:
       #   - cron: '0 */6 * * *' # Optional: Periodically check Drive for changes

     jobs:
       sync:
         runs-on: ubuntu-latest
         # Required permissions for checking out code, committing/pushing PR branch, creating PR
         permissions:
           contents: write
           pull-requests: write
         steps:
           - name: Checkout Repository
             uses: actions/checkout@v4
             with:
               # Fetch full history to find correct base for PR if needed
               fetch-depth: 0

           - name: Set up Node.js
             uses: actions/setup-node@v4
             with:
               node-version: "20" # Use Node.js version compatible with the action

           - name: Sync Files with Google Drive
             uses: datamix-datascience/sync-to-drive@v1 # Use desired version
             with:
               credentials: ${{ secrets.DRIVE_CREDENTIALS }}
               github_token: ${{ secrets.GITHUB_TOKEN }}
               # Pass the event name to control sync direction logic
               trigger_event_name: ${{ github.event_name }}
               # Optional: Specify a different config path
               # config_path: './path/to/sync.json'
     ```

5.  **Commit and Run**:
    -   Commit `sync.json` and the workflow file.
    -   Push to the specified branch (e.g., `main`) to trigger the Local -> Drive sync.
    -   Manually trigger via `workflow_dispatch` or wait for `schedule` to check for Drive -> Local changes.
    -   Monitor the workflow in the "Actions" tab. Check Drive folders and look for Pull Requests in the repository.

## Example Scenario Walkthrough

Consider a repo with `sync.json` targeting Folder `alpha` (`on_untrack: remove`) and Folder `beta` (`on_untrack: request`).

-   **Scenario 1: Push to `main` branch**
    -   Local files `doc.txt` and `image.png` are pushed.
    -   **Outgoing Sync:**
        -   `doc.txt` and `image.png` are uploaded/updated in both `alpha` and `beta` Drive folders. If they existed with different content, they are overwritten. If names differed, they are renamed in Drive.
    -   **Untracked Handling:**
        -   Drive Folder `alpha` contains `old_report.pdf` (owned by SA) and `shared_doc` (owned by someone else). `old_report.pdf` is moved to Trash. `shared_doc` is skipped (cannot remove).
        -   Drive Folder `beta` contains `team_spreadsheet` (owned by someone else). An ownership transfer request is sent to the owner.
    -   **Ownership Acceptance:** Any pending transfers *to* the SA in `alpha` or `beta` are accepted.
    -   **Incoming Check:** Compares Drive state *after* sync with the repo state. If no *other* changes occurred in Drive concurrently, no PR is created.

-   **Scenario 2: Manual `workflow_dispatch` Trigger**
    -   **Outgoing Sync & Untracked:** Skipped.
    -   **Ownership Acceptance:** Runs as usual.
    -   **Incoming Check:**
        -   Compares current Drive state (folders `alpha`, `beta`) with the `main` branch state.
        -   Suppose `image.png` was deleted from Drive `alpha`, and a Google Doc `Meeting Notes` was added to Drive `beta`.
        -   A new branch (e.g., `sync-from-drive-alpha-123...`) is created.
        -   Changes are committed: `git rm image.png`, add `Meeting Notes.document.json.txt`.
        -   Branch is pushed, and a PR is created/updated targeting `main` proposing these changes.

-   **Scenario 3: Google Doc Handling**
    -   A Google Sheet "Budget" exists in Drive.
    -   On an incoming sync (`workflow_dispatch`), the file `Budget.sheet.json.txt` is created locally and added to the PR.
    -   If `Budget.sheet.json.txt` exists locally and is pushed (`push` trigger), the action ensures the "Budget" Google Sheet in Drive is named correctly but does *not* upload the `.json.txt` file content.

## Development

To contribute or modify the action:

1.  Clone the `sync-to-drive` repository.
2.  Install dependencies: `npm install`.
3.  Edit TypeScript source files (e.g., `src/index.ts`, `src/libs/**/*.ts`).
4.  Build the JavaScript distribution: `npm run build`.
5.  Test changes (e.g., point a test workflow to your fork/branch).
6.  Commit, push, and tag a new release:
    ```bash
    # Make changes, commit, push...
    chmod +x release.sh
    ./release.sh v1.1.0 # Use semantic versioning
    ```
