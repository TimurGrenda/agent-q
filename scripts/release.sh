#!/usr/bin/env bash
# release.sh — Bump semver version, update CHANGELOG, commit, and tag.
#
# Usage: bash scripts/release.sh <major|minor|patch>
# NOTE: Requires GNU sed (Linux). Not portable to BSD/macOS sed.

# Exit on error, undefined variable, or pipe failure.
set -euo pipefail

DENO_JSON="deno.json"
CHANGELOG="CHANGELOG.md"

# --- Validate argument ---

if [[ $# -ne 1 ]] || [[ "$1" != "major" && "$1" != "minor" && "$1" != "patch" ]]; then
    echo "Usage: bash scripts/release.sh <major|minor|patch>" >&2
    exit 1
fi

BUMP_TYPE="$1"

# --- Check working tree is clean ---

# --porcelain gives machine-readable output; non-empty means dirty tree.
if [[ -n "$(git status --porcelain)" ]]; then
    echo "Error: working tree is not clean. Commit or stash changes first." >&2
    exit 1
fi

# --- Read current version from deno.json ---

# Extract the "version" field value using grep + sed (no jq dependency).
# grep finds the line; sed strips everything except the version string.
CURRENT_VERSION="$(grep --max-count=1 '"version"' "$DENO_JSON" | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"

if [[ -z "$CURRENT_VERSION" ]]; then
    echo "Error: could not read version from $DENO_JSON" >&2
    exit 1
fi

# Validate strict semver format (digits only, no pre-release suffixes).
if [[ ! "$CURRENT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Error: version '$CURRENT_VERSION' in $DENO_JSON is not strict semver (X.Y.Z)." >&2
    exit 1
fi

# --- Split version into components ---

# Use IFS to split on dots into an array.
# -r prevents backslash mangling; -a reads into an array.
# Bash read has no long form for -r.  shellcheck:ok
IFS='.' read -ra VERSION_PARTS <<< "$CURRENT_VERSION"
MAJOR="${VERSION_PARTS[0]}"
MINOR="${VERSION_PARTS[1]}"
PATCH="${VERSION_PARTS[2]}"

# --- Bump the appropriate component ---

case "$BUMP_TYPE" in
    major)
        MAJOR=$((MAJOR + 1))
        MINOR=0  # Reset minor on major bump.
        PATCH=0  # Reset patch on major bump.
        ;;
    minor)
        MINOR=$((MINOR + 1))
        PATCH=0  # Reset patch on minor bump.
        ;;
    patch)
        PATCH=$((PATCH + 1))
        ;;
esac

NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"

# --- Update deno.json version field ---

# Replace the version string in-place. Match the exact old version to avoid
# accidentally replacing version-like strings elsewhere in the file.
sed --in-place "s/\"version\": \"${CURRENT_VERSION}\"/\"version\": \"${NEW_VERSION}\"/" "$DENO_JSON"

# Verify the replacement actually happened (sed exits 0 even on no match).
if ! grep --quiet "\"version\": \"${NEW_VERSION}\"" "$DENO_JSON"; then
    echo "Error: failed to update version in $DENO_JSON (sed pattern did not match)." >&2
    exit 1
fi

# --- Update CHANGELOG.md ---

# Verify the Unreleased heading exists before modifying.
if ! grep --quiet '## \[Unreleased\]' "$CHANGELOG"; then
    echo "Error: $CHANGELOG does not contain a '## [Unreleased]' heading." >&2
    exit 1
fi

# Get today's date in YYYY-MM-DD format (UTC).
TODAY="$(date --utc +"%Y-%m-%d")"

# Insert a blank line + new version heading after the [Unreleased] line.
# sed a\ appends text after the matched line. "\\\\n" inserts a leading blank
# line: bash "\\\\n" -> sed sees "\\n" -> sed interprets as newline.
sed --in-place "/## \[Unreleased\]/a\\\\n## [${NEW_VERSION}] - ${TODAY}" "$CHANGELOG"

# Insert skeleton Keep-a-Changelog subsection headers under [Unreleased].
# This gives the next developer ready-made sections to add entries under.
# Each -e appends one header after the [Unreleased] line; "\\\\n" produces a
# leading blank line (bash "\\\\n" -> sed "\\n" -> newline).
sed --in-place \
    -e "/## \[Unreleased\]/a\\\\n### Added" \
    -e "/## \[Unreleased\]/a\\\\n### Changed" \
    -e "/## \[Unreleased\]/a\\\\n### Fixed" \
    -e "/## \[Unreleased\]/a\\\\n### Removed" \
    "$CHANGELOG"

# --- Commit and tag ---

# Stage only the two files we changed.
git add "$DENO_JSON" "$CHANGELOG"

# Create a release commit.
git commit --message "release: v${NEW_VERSION}"

# Create an annotated tag with the version as the message.
git tag --annotate "v${NEW_VERSION}" --message "v${NEW_VERSION}"

echo "Released v${NEW_VERSION} (was v${CURRENT_VERSION})"
