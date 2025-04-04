# Sync to Drive

A GitHub Action to recursively sync files from a repository to one or more Google Drive folders using a Google Service Account. Unlike simple upload actions, this tool supports advanced synchronization features such as ignoring files via glob patterns, handling conflicts with rename or override options, and managing untracked files in Drive.

## Features
- **Recursive Sync**: Uploads files and folders while preserving the repository structure.
- **Multiple Drive Targets**: Syncs to multiple Google Drive folders (forks) defined in `sync.json`.
- **Ignore Patterns**: Excludes files matching glob patterns (e.g., `*.log`, `node_modules/**`).
- **Conflict Resolution**: Choose to rename conflicting files (e.g., `__my__.<name>`) or override them per target folder.
- **Untracked File Handling**: Option to ignore or remove files in Drive that aren’t in the repo.
- **Hash-Based Updates**: Only updates files when their content changes, using SHA1 hashes.

## Configuration (`sync.json`)
Place a `sync.json` file in the root of your target repository to define the sync behavior. The file includes the following fields:

- `source.repo` (string): The repository URL (e.g., git@github.com:yourusername/resources.git). Used for documentation; not required for the action to function.
- `ignore` (array of strings): Glob patterns to exclude files/folders from syncing. Examples include `*.log` (ignore log files) and `node_modules/**` (ignore node_modules and its subdirectories).
- `targets.forks` (array of objects): List of Google Drive folders to sync to. Each object has:
  - `drive_folder_id` (string): The Google Drive folder ID (from the URL).
  - `drive_url` (string): The full URL (for reference).
  - `on_conflict` (string, "rename" or "override"):
    - "rename": Renames existing Drive files to `__my__.<filename>` before uploading the new version.
    - "override": Overwrites the existing Drive file directly.
  - `on_untrack` (string, "ignore" or "remove"):
    - "ignore": Leaves files in Drive that aren’t in the repo untouched.
    - "remove": Deletes untracked files from Drive.

```json
{
  "source": {
    "repo": "git@github.com:yourusername/resources.git"
  },
  "ignore": [
    "*.log",
    ".gitignore",
    "node_modules/**"
  ],
  "targets": {
    "forks": [
      {
        "drive_folder_id": "123456",
        "drive_url": "https://drive.google.com/drive/folders/123456",
        "on_conflict": "rename",
        "on_untrack": "ignore"
      },
      {
        "drive_folder_id": "789012",
        "drive_url": "https://drive.google.com/drive/folders/789012",
        "on_conflict": "override",
        "on_untrack": "remove"
      }
    ]
  }
}
```

## Usage
1. **Create a Google Service Account**:
   - Go to [Google Cloud Console](https://console.cloud.google.com/).
   - Create a project, enable the Google Drive API, and generate a Service Account.
   - Download the JSON key file (e.g., `credentials.json`).
   - Share your target Drive folders with the Service Account email (e.g., `something@project-id.iam.gserviceaccount.com`) with "Editor" permissions.

2. **Encode Credentials**:
   - Convert the JSON key to base64:
     ```bash
     base64 -i credentials.json | pbcopy
     ```

3. **Set Up Your Repository**:
   - In your target repo (e.g., `resources`), add a `sync.json` file with the structure described above.
   - Create a workflow file at `.github/workflows/sync_to_drive.yml`:
     ```yaml
     name: sync_to_drive

     on:
       push:
         branches:
           - main

     jobs:
       sync:
         runs-on: ubuntu-latest
         steps:
           - name: checkout_repo
             uses: actions/checkout@v4

           - name: setup_node
             uses: actions/setup-node@v4
             with:
               node-version: "20"

           - name: sync_to_drive
             uses: datamix-datascience/sync-to-drive@v1
             with:
               credentials: ${{ secrets.DRIVE_CREDENTIALS }}
     ```

4. **Add Secrets**:
   - In your target repo, go to Settings > Secrets and Variables > Actions.
   - Add a secret named `DRIVE_CREDENTIALS` with the base64-encoded JSON from step 2.

5. **Push and Test**:
   - Commit and push to the `main` branch.
   - Check the "Actions" tab to monitor the sync.
   - Verify files in your Drive folders (e.g., `123456`, `789012`).

## Example
### Target Repo Structure
```
resources/
├── .github/
│   └── workflows/
│       └── sync_to_drive.yml
├── sync.json
├── bar/
│   └── foo.txt
└── baz.txt
```

### Behavior
- **Initial Push**:
  - Both Drive folders (`123456`, `789012`) get `bar/foo.txt` and `baz.txt`.
- **Modify `foo.txt` and Push**:
  - `123456`: `bar/__my__.foo.txt` and updated `bar/foo.txt` (rename mode).
  - `789012`: Updated `bar/foo.txt

` (override mode).
- **Add `untracked.txt` to Drive**:
  - `123456`: `untracked.txt` remains (ignore mode).
  - `789012`: `untracked.txt` is deleted (remove mode).

## Development
To modify the action:
1. Clone `sync-to-drive`.
2. Install dependencies: `npm install`.
3. Edit `sync_to_drive.ts`.
4. Build: `npm run build`.
5. Push changes and tag a new release:
  ```
  chmod +x release.sh
  ./release.sh v2
  ```

## TODO
- Add code to open a github issue with title `[UNTRACKED] ${owner_email.split("@")[0]}'s files` and body with checkbox item contain file detail with clickable [file_path/file_name](file_url) so we can tick update and close the issue later when it get tracked.
