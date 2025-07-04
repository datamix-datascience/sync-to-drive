# Sync to Drive GitHub Action

Synchronizes files between a GitHub repository and Google Drive folder(s) using a Service Account. Features bidirectional sync, Pull Request generation for Drive changes, and optional visual diffs.

## Core Logic & Features

1.  **Setup:** Reads `sync.json`, authenticates with Google Drive (Service Account) and GitHub (`GITHUB_TOKEN`).
2.  **Sync Direction (Based on `trigger_event_name`):**
    *   **`push` trigger:** Performs Local → Drive sync *then* Drive → Local PR check.
    *   **Other triggers (e.g., `workflow_dispatch`, `schedule`):** Performs Drive → Local PR check only.
3.  **Local → Drive Sync (`push` only):**
    *   Lists local files (respects `sync.json` ignores + `.gitignore`).
    *   Lists Drive files/folders once.
    *   Creates missing folders in Drive.
    *   Uploads/updates files to Drive based on hash/name changes. Overwrites Drive content.
    *   **Google Workspace/PDF Handling:** Creates/Updates metadata link files (`[name]--[id].[type].gdrive.json`) locally for these types. Skips uploading these link files *to* Drive but updates the corresponding Drive item's name if needed.
    *   **Untracked Handling:** Processes items in Drive but not the repo based on `on_untrack` config (`ignore`, `remove` [if SA owned], `request` [if not SA owned]).
4.  **Ownership Management:** Accepts pending ownership transfers *to* the Service Account (runs on all triggers, optimized for `push`).
5.  **Drive → Local Sync (All triggers):**
    *   Lists current Drive content.
    *   Compares Drive state to the repository's base branch state.
    *   Creates/updates a Pull Request on a dedicated branch (`sync-from-drive-<folderId>`) proposing these changes:
        *   New/modified Drive files result in downloaded content or updated `.gdrive.json` link files. For Google Slides, an `.export.svg` file is also generated in the `visual_diff_output_dir` to provide a readable preview.
        *   Local files/folders (not ignored) absent from Drive are staged for removal.
        *   The PR description details *these* primary sync changes.
6.  **Visual Diff Generation (Optional, All triggers, if PR exists/updated):**
    *   Runs *after* the Drive → Local sync creates/updates the PR.
    *   Checks out the PR branch.
    *   Identifies `.gdrive.json` files that were `added`, `modified`, `renamed`, or `removed` *in the PR diff*.
    *   **Generates/Updates:** For link files existing on the branch, fetches the Drive file as PDF, converts to PNGs (using `mupdf`), and saves to `visual_diff_output_dir` (e.g., `_diff_/path/to/Document--ID.doc/`). Replaces existing PNGs for that file.
    *   **Cleans Up:** If a link file was `removed` in the PR diff (and thus absent from the branch), deletes the corresponding PNG subfolder (e.g., `_diff_/path/to/Document--ID.doc/`).
    *   Commits PNG additions/updates/deletions to the *same* PR branch with a `[skip visual-diff]` tag in the commit message. This commit message details the PNGs generated and folders cleaned.

## Configuration (`sync.json`)

Place `sync.json` in your repository root.

-   `source.repo`: (String, informational) Git URL of the source repo.
-   `ignore`: (Array of Strings) Glob patterns to ignore (e.g., `*.log`). `.gitignore` is also respected.
-   `targets.forks`: (Array of Objects) Each object defines a Drive target:
    -   `drive_folder_id`: (String) Target Drive folder ID.
    -   `drive_url`: (String, informational) URL of the Drive folder.
    -   `on_untrack`: (String: `"ignore" | "remove" | "request"`) Action for items in Drive but not repo during `push` sync.
        -   `"ignore"`: Do nothing.
        -   `"remove"`: Trash item if owned by Service Account.
        -   `"request"`: Request ownership if not owned by Service Account.

```json
{
  "source": { "repo": "git@github.com:user/repo.git" },
  "ignore": ["*.log", "node_modules/**", "_build/"],
  "targets": {
    "forks": [
      {
        "drive_folder_id": "YOUR_DRIVE_FOLDER_ID",
        "drive_url": "https://drive.google.com/drive/folders/YOUR_DRIVE_FOLDER_ID",
        "on_untrack": "request"
      }
    ]
  }
}
```

## Inputs

-   `credentials` (**required**): Base64 encoded Google Service Account JSON key.
-   `github_token` (**required**): GitHub token (e.g., `secrets.GITHUB_TOKEN`). Needs `contents: write` and `pull-requests: write`.
-   `trigger_event_name` (**required**): Trigger event name (e.g., `${{ github.event_name }}`).
-   `config_path` (optional): Path to `sync.json`. Default: `./sync.json`.
-   `enable_visual_diffs` (optional): `true` to enable PNG generation. Default: `false`.
-   `visual_diff_output_dir` (optional): Base directory for generated preview files (PNGs from visual diffs, SVGs from Google Slides). Default: `_diff_`.
-   `visual_diff_link_suffix` (optional): Suffix of link files for diffing. Default: `.gdrive.json`.
-   `visual_diff_dpi` (optional): Resolution for generated PNGs. Default: `72`.
-   `git_user_name` (optional): Git user name for commits. Default: `github-actions[bot]`.
-   `git_user_email` (optional): Git user email for commits. Default: `github-actions[bot]@users.noreply.github.com`.

## Outputs

-   `drive_link_<safe_folder_id>`: URL to the processed Google Drive folder.

## Usage

1.  **Create Service Account:** Enable Drive API, create Service Account, download JSON key, share Drive folder(s) with SA email (Editor role).
2.  **Encode Credentials:** Base64 encode the *entire content* of the JSON key file (`base64 -w 0 credentials.json` on Linux).
3.  **Repo Setup:**
    *   Add Base64 credentials as GitHub secret `DRIVE_CREDENTIALS`.
    *   Add `sync.json` to repo root.
    *   Create workflow file (e.g., `.github/workflows/sync.yml`):

    ```yaml
    name: Sync To/From Google Drive

    on:
      push:
        branches:
          - main # Or your primary branch for Local -> Drive
      workflow_dispatch: # Manual trigger for Drive -> Local PR

    jobs:
      sync:
        runs-on: ubuntu-latest
        permissions:
          contents: write      # Needed to checkout, commit, push PR branch
          pull-requests: write # Needed to create/update PR
        steps:
          - name: Checkout Repository
            uses: actions/checkout@v4
            with:
              fetch-depth: 0 # Required for comparing against base branch

          # Node setup might be needed if action relies on it directly
          # - name: Set up Node.js
          #   uses: actions/setup-node@v4
          #   with:
          #     node-version: "20"

          - name: Sync Files with Google Drive
            uses: datamix-datascience/sync-to-drive@v1 # Use correct action ref
            with:
              credentials: ${{ secrets.DRIVE_CREDENTIALS }}
              github_token: ${{ secrets.GITHUB_TOKEN }}
              trigger_event_name: ${{ github.event_name }}
              enable_visual_diffs: true # Optional
              # visual_diff_output_dir: '_previews_' # Optional
    ```
4.  **Run:** Commit and push. Monitor Actions tab. Check Drive and repository PRs.

## Development

1.  Clone repo.
2.  `npm install`
3.  Edit source files (`src/**/*.ts`).
4.  Build JS: `npm run build`.
5.  Commit, push, tag release (`./release.sh vX.Y.Z`).

## Slide Comparison Feature

This action includes a functionality to visually compare Google Slides changes and automatically comment on PRs with the differences.

### Key Features

- Automatically compares visual diffs (PNG images) of Google Slides
- Uses Gemini API to summarize changes between images in natural language
- Identifies modified, new, and deleted slides
- Posts a clear summary of changes as a comment on the PR

### Configuration

Configure the following parameters in your workflow YAML file:

```yaml
- uses: peopledot/sync-to-drive@main
  with:
    # Basic settings (omitted)...
    
    # Visual Diff settings
    enable_visual_diffs: "true"
    visual_diff_output_dir: "_diff_"
    
    # Slide comparison settings (new feature)
    enable_slide_compare: "true"
    gemini_api_key: ${{ secrets.GEMINI_API_KEY }}
```

### Required Settings

1. `enable_visual_diffs`: Set to "true" (required as image generation is needed)
2. `enable_slide_compare`: Set to "true" to enable the slide comparison feature
3. `gemini_api_key`: API key for Gemini API usage (obtain from [Google AI Studio](https://makersuite.google.com/))

### Example PR Comment

Comments are automatically posted to PRs in the following format:

```markdown
# Visual Differences Summary

## presentation--GoogleDriveID.slides

### Slide 0001

**Changes:**
The slide title has been changed from "Old Title" to "New Title".
The background color has changed from blue to green, and the bullet points have increased from 3 to 4 items.
```
