#!/usr/bin/env bash
#
# Bump the atomic-agent version, commit, and create a git tag.
#
# Usage:
#   ./scripts/release.sh patch        # 0.1.0 → 0.1.1
#   ./scripts/release.sh minor        # 0.1.0 → 0.2.0
#   ./scripts/release.sh major        # 0.1.0 → 1.0.0
#   ./scripts/release.sh 1.2.3        # explicit version
#
# The script will:
#   1. Update version in package.json
#   2. Create a commit: "atomic-agent: release v<version>"
#   3. Create an annotated git tag: v<version>
#
# After running, push with:
#   git push && git push --tags
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG="$APP_DIR/package.json"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <patch|minor|major|X.Y.Z>"
  exit 1
fi

BUMP="$1"

# Read current version from package.json.
CURRENT=$(node -p "require('$PKG').version")
echo "Current version: $CURRENT"

# Parse semver components.
IFS='.' read -r CUR_MAJOR CUR_MINOR CUR_PATCH <<< "$CURRENT"

case "$BUMP" in
  patch)
    NEW_VERSION="$CUR_MAJOR.$CUR_MINOR.$((CUR_PATCH + 1))"
    ;;
  minor)
    NEW_VERSION="$CUR_MAJOR.$((CUR_MINOR + 1)).0"
    ;;
  major)
    NEW_VERSION="$((CUR_MAJOR + 1)).0.0"
    ;;
  *)
    # Validate explicit version format (X.Y.Z).
    if [[ ! "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "Error: version must be 'patch', 'minor', 'major', or a valid semver (X.Y.Z)"
      exit 1
    fi
    NEW_VERSION="$BUMP"
    ;;
esac

TAG="v$NEW_VERSION"

# Check that the tag doesn't already exist.
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: tag $TAG already exists"
  exit 1
fi

# Check for uncommitted changes (outside of package files which we're about to modify).
if ! git diff --quiet -- ':!package.json' ':!package-lock.json'; then
  echo "Error: you have uncommitted changes. Commit or stash them first."
  exit 1
fi

echo "Bumping: $CURRENT → $NEW_VERSION (tag: $TAG)"

# Update version in package.json using node (preserves formatting).
node -e "
  const fs = require('fs');
  const path = '$PKG';
  const raw = fs.readFileSync(path, 'utf-8');
  const updated = raw.replace(
    /\"version\":\s*\"[^\"]+\"/,
    '\"version\": \"$NEW_VERSION\"'
  );
  fs.writeFileSync(path, updated);
"

# Verify the change.
VERIFY=$(node -p "require('$PKG').version")
if [[ "$VERIFY" != "$NEW_VERSION" ]]; then
  echo "Error: version update failed (got $VERIFY, expected $NEW_VERSION)"
  exit 1
fi

echo "Updated package.json → $NEW_VERSION"

# Sync package-lock.json with the new version.
echo "Running npm install to update package-lock.json..."
(cd "$APP_DIR" && npm install --package-lock-only)

# Commit and tag.
git add "$PKG" "$APP_DIR/package-lock.json"
git commit -m "atomic-agent: release $TAG"
git tag -a "$TAG" -m "Atomic Agent $TAG"

echo ""
echo "Done! Created commit and tag $TAG."
echo ""
echo "Next steps:"
echo "  git push && git push --tags"
echo ""
echo "This will trigger the CI workflow to build and create a draft GitHub Release."
echo "After the build completes, go to GitHub Releases and publish the draft."
