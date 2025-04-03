#!/bin/bash

# Default version if not provided
VERSION=${1:-"v1"}

# Ensure we're in the correct directory
if [ ! -f "package.json" ]; then
  echo "Error: package.json not found. Run this script from the sync-to-drive root directory."
  exit 1
fi

# Check for required tools
command -v npm >/dev/null 2>&1 || { echo "Error: npm is required but not installed."; exit 1; }
command -v git >/dev/null 2>&1 || { echo "Error: git is required but not installed."; exit 1; }

# Build the TypeScript code into dist with bundling
echo "Building sync_to_drive.ts to dist/ with esbuild..."
npm install
npm run build

# Check if build succeeded
if [ $? -ne 0 ]; then
  echo "Error: Build failed."
  exit 1
fi

# Ensure dist folder exists and has the compiled file
if [ ! -f "dist/sync_to_drive.js" ]; then
  echo "Error: dist/sync_to_drive.js not found after build."
  exit 1
fi

# Stage all changes (including the dist folder)
echo "Staging changes..."
git add .
git add dist/ -f  # Force-add dist/ in case it's gitignored

# Commit changes (skip if nothing to commit)
if ! git diff --staged --quiet; then
  git commit -m "Prepare release $VERSION"
  if [ $? -ne 0 ]; then
    echo "Error: Commit failed."
    exit 1
  fi
else
  echo "No changes to commit."
fi

# Remove existing tag locally and remotely if it exists
echo "Checking for existing tag $VERSION..."
if git rev-parse "$VERSION" >/dev/null 2>&1; then
  echo "Removing existing local tag $VERSION..."
  git tag -d "$VERSION"
  if [ $? -ne 0 ]; then
    echo "Error: Failed to delete local tag $VERSION."
    exit 1
  fi
  echo "Removing existing remote tag $VERSION..."
  git push origin :refs/tags/"$VERSION"
  if [ $? -ne 0 ]; then
    echo "Error: Failed to delete remote tag $VERSION."
    exit 1
  fi
else
  echo "No existing tag $VERSION found."
fi

# Tag the release
echo "Tagging release $VERSION..."
git tag -a "$VERSION" -m "Release $VERSION"
if [ $? -ne 0 ]; then
  echo "Error: Tagging failed."
  exit 1
fi

# Push changes and tag to remote
echo "Pushing to remote repository..."
git push origin main
git push origin "$VERSION"

if [ $? -ne 0 ]; then
  echo "Error: Push failed. Check your remote configuration or network."
  exit 1
fi

echo "Release $VERSION created and pushed successfully!"
