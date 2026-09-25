#!/bin/bash
#
# Generate PKGBUILD from template
#
# Usage: ./scripts/generate-pkgbuild.sh <version> <sha256sum> <download_url> [pkgrel]
#
# Electron is no longer a separate source — it ships inside the pre-patched tarball
# (extracted from the official Linux .deb), so there are no Electron version/shasum
# placeholders to fill anymore.
#
set -euo pipefail

VERSION="${1:-}"
SHA256SUM="${2:-}"
DOWNLOAD_URL="${3:-}"
PKGREL="${4:-1}"
MAINTAINER_NAME="${AUR_USERNAME:-Patrick Jaja}"
MAINTAINER_EMAIL="${AUR_EMAIL:-patrickjajaa@gmail.com}"

if [ -z "$VERSION" ]; then
    echo "Usage: $0 <version> <sha256sum> <download_url> [pkgrel]" >&2
    echo "" >&2
    echo "Arguments:" >&2
    echo "  version       Package version (e.g., 1.17377.0)" >&2
    echo "  sha256sum     SHA256 checksum of the tarball" >&2
    echo "  download_url  URL to download the pre-patched tarball" >&2
    echo "  pkgrel        Package release number (default: 1)" >&2
    exit 1
fi

if [ -z "$SHA256SUM" ]; then
    SHA256SUM="SKIP"
fi

# GITHUB_REPOSITORY is set by CI (owner/repo) and auto-flips when the GitHub
# repository is renamed; the default stays the current name for local runs.
GITHUB_REPO="${GITHUB_REPOSITORY:-patrickjaja/claude-desktop-extra}"
if [ -z "$DOWNLOAD_URL" ]; then
    DOWNLOAD_URL="https://github.com/${GITHUB_REPO}/releases/download/v${VERSION}/claude-desktop-${VERSION}-linux.tar.gz"
fi

# aarch64 tarball: env override or derive from x86_64 URL
SHA256SUM_AARCH64="${SHA256SUM_AARCH64:-SKIP}"
if [ -z "${DOWNLOAD_URL_AARCH64:-}" ]; then
    DOWNLOAD_URL_AARCH64=$(echo "$DOWNLOAD_URL" | sed 's/-linux\.tar\.gz/-linux-aarch64.tar.gz/')
fi

# Find the template
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEMPLATE_FILE="$PROJECT_DIR/packaging/arch/PKGBUILD.template"

if [ ! -f "$TEMPLATE_FILE" ]; then
    echo "Error: PKGBUILD.template not found at $TEMPLATE_FILE" >&2
    exit 1
fi

# Generate PKGBUILD by substituting placeholders
sed \
    -e "s/{{VERSION}}/$VERSION/g" \
    -e "s/{{PKGREL}}/$PKGREL/g" \
    -e "s/{{SHA256SUM}}/$SHA256SUM/g" \
    -e "s|{{DOWNLOAD_URL}}|$DOWNLOAD_URL|g" \
    -e "s/{{SHA256SUM_AARCH64}}/$SHA256SUM_AARCH64/g" \
    -e "s|{{DOWNLOAD_URL_AARCH64}}|$DOWNLOAD_URL_AARCH64|g" \
    -e "s/{{MAINTAINER_NAME}}/$MAINTAINER_NAME/g" \
    -e "s/{{MAINTAINER_EMAIL}}/$MAINTAINER_EMAIL/g" \
    "$TEMPLATE_FILE"
