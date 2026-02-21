#!/usr/bin/env bash
set -euo pipefail

# AgentActa Release Script
# Usage: ./scripts/release.sh [patch|minor|major]

cd "$(dirname "$0")/.."

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}▶${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
err() { echo -e "${RED}✗${NC} $1" >&2; exit 1; }

# Check prerequisites
command -v npm >/dev/null || err "npm not found"
command -v gh >/dev/null || err "gh CLI not found (install: brew install gh)"
[[ -f package.json ]] || err "package.json not found"
[[ -f CHANGELOG.md ]] || err "CHANGELOG.md not found"

# Check git state
[[ -z "$(git status --porcelain)" ]] || err "Working directory not clean. Commit or stash changes first."
[[ "$(git branch --show-current)" == "main" ]] || warn "Not on main branch"

# Get bump type
BUMP_TYPE="${1:-}"
if [[ -z "$BUMP_TYPE" ]]; then
  echo "Release type:"
  echo "  1) patch (bug fixes)"
  echo "  2) minor (new features)"
  echo "  3) major (breaking changes)"
  read -rp "Select [1-3]: " choice
  case "$choice" in
    1) BUMP_TYPE="patch" ;;
    2) BUMP_TYPE="minor" ;;
    3) BUMP_TYPE="major" ;;
    *) err "Invalid choice" ;;
  esac
fi

[[ "$BUMP_TYPE" =~ ^(patch|minor|major)$ ]] || err "Invalid bump type: $BUMP_TYPE"

# Get current and new version
CURRENT_VERSION=$(node -p "require('./package.json').version")
log "Current version: $CURRENT_VERSION"

# Calculate new version
IFS='.' read -r major minor patch <<< "$CURRENT_VERSION"
case "$BUMP_TYPE" in
  major) NEW_VERSION="$((major + 1)).0.0" ;;
  minor) NEW_VERSION="${major}.$((minor + 1)).0" ;;
  patch) NEW_VERSION="${major}.${minor}.$((patch + 1))" ;;
esac

log "New version: $NEW_VERSION"

# Confirm
read -rp "Release v$NEW_VERSION? [y/N] " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }

# Update package.json
log "Updating package.json..."
npm version "$NEW_VERSION" --no-git-tag-version

# Update CHANGELOG.md
log "Updating CHANGELOG.md..."
TODAY=$(date +%Y-%m-%d)
CHANGELOG_ENTRY="## [$NEW_VERSION] - $TODAY"

# Check if there's an [Unreleased] section to convert
if grep -q '## \[Unreleased\]' CHANGELOG.md; then
  sed -i "s/## \[Unreleased\]/$CHANGELOG_ENTRY/" CHANGELOG.md
else
  # Insert new version after # Changelog header
  sed -i "/^# Changelog/a\\
\\
$CHANGELOG_ENTRY\\
\\
### Changed\\
- (describe changes here)\\
" CHANGELOG.md
  warn "Added placeholder changelog entry - please edit CHANGELOG.md before continuing"
  read -rp "Press Enter when CHANGELOG.md is ready..."
fi

# Show diff
echo ""
log "Changes to be committed:"
git diff --stat

echo ""
read -rp "Commit and release? [y/N] " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || { git checkout -- .; echo "Aborted."; exit 0; }

# Commit and tag
log "Committing..."
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: release v$NEW_VERSION"

log "Tagging v$NEW_VERSION..."
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"

# Push
log "Pushing to origin..."
git push origin main --follow-tags

# Publish to npm
log "Publishing to npm..."
npm publish

# Create GitHub release
log "Creating GitHub release..."
# Extract changelog for this version
RELEASE_NOTES=$(awk "/^## \[$NEW_VERSION\]/,/^## \[/" CHANGELOG.md | head -n -1 | tail -n +2)
gh release create "v$NEW_VERSION" \
  --title "v$NEW_VERSION" \
  --notes "$RELEASE_NOTES"

echo ""
echo -e "${GREEN}✓${NC} Released v$NEW_VERSION!"
echo "  - npm: https://www.npmjs.com/package/agentacta"
echo "  - GitHub: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/v$NEW_VERSION"
