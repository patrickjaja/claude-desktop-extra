#!/bin/bash
#
# Local build script for Fedora — builds an installable RPM.
#
# NOTE: build-local.sh is now cross-distro (it ingests the official Linux .deb and
# can target any packaging). This wrapper is kept for muscle memory; it ingests the
# same official .deb and produces an installable RPM via packaging/rpm/build-rpm.sh.
#
# Usage: ./scripts/build-fedora-local.sh [--deb PATH | --version X] [--install] [--smoke-test]
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_DIR/build"

APT_BASE="${CLAUDE_DESKTOP_APT_URL:-https://downloads.claude.ai/claude-desktop/apt/stable}"
APT_PACKAGES_URL="$APT_BASE/dists/stable/main/binary-amd64/Packages"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Parse arguments
INSTALL_AFTER_BUILD=false
SKIP_SMOKE_TEST="${SKIP_SMOKE_TEST:-1}"
REPRODUCIBLE=false
DEB_PATH=""
DEB_VERSION=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --install|-i) INSTALL_AFTER_BUILD=true; shift ;;
        --smoke-test) SKIP_SMOKE_TEST=0; shift ;;
        --reproducible) REPRODUCIBLE=true; shift ;;
        --deb)        DEB_PATH="$2"; shift 2 ;;
        --version)    DEB_VERSION="$2"; shift 2 ;;
        --help|-h)
            echo "Usage: $0 [--deb PATH | --version X] [--install] [--smoke-test] [--reproducible]"
            echo ""
            echo "Options:"
            echo "  --deb <PATH>     Use a local official .deb instead of downloading"
            echo "  --version <X>    Download a specific version from the apt repo"
            echo "  --install, -i    Install the RPM after building"
            echo "  --smoke-test     Run Electron smoke test (skipped by default)"
            echo "  --reproducible   Compress with gzip -n -9 (byte-reproducible, slower) instead of pigz"
            echo "  --help, -h       Show this help message"
            echo ""
            echo "This script:"
            echo "  1. Resolves the official Claude Desktop Linux .deb (local, pinned, or latest)"
            echo "  2. Applies Linux patches using build-patched-tarball.sh"
            echo "  3. Builds an RPM package using packaging/rpm/build-rpm.sh"
            echo "  4. Optionally installs it with dnf"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# Check dependencies. ar (binutils) cracks the upstream .deb; rpmbuild builds ours.
log_info "Checking build dependencies..."
MISSING_DEPS=()
for dep in curl ar tar asar python3 rpmbuild; do
    if ! command -v "$dep" &> /dev/null; then
        MISSING_DEPS+=("$dep")
    fi
done
if [ ${#MISSING_DEPS[@]} -ne 0 ]; then
    log_error "Missing dependencies: ${MISSING_DEPS[*]}"
    echo "Install them with:"
    echo "  sudo dnf install binutils tar curl rpm-build"
    echo "  npm install -g @electron/asar  (if asar is missing)"
    exit 1
fi

# Create build directory
log_info "Setting up build directory..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Resolve the .deb source for the ingest (local / pinned / latest).
DEB_ARG=""
if [ -n "$DEB_PATH" ]; then
    [ -f "$DEB_PATH" ] || { log_error "--deb file not found: $DEB_PATH"; exit 1; }
    log_info "Using local .deb: $DEB_PATH"
    DEB_ARG="$DEB_PATH"
elif [ -n "$DEB_VERSION" ]; then
    log_info "Will fetch version $DEB_VERSION from apt repo"
    export CLAUDE_DESKTOP_WANT_VERSION="$DEB_VERSION"
    DEB_ARG="$APT_PACKAGES_URL"
else
    DEB_ARG="$APT_PACKAGES_URL"
fi

# Compress with pigz when available (about 5x faster than gzip -9). CI calls
# build-patched-tarball.sh directly without this and keeps byte-reproducible
# gzip; --reproducible keeps gzip for local builds too.
if [ "$REPRODUCIBLE" = true ]; then
    unset CLAUDE_ALLOW_PIGZ
elif command -v pigz &> /dev/null; then
    export CLAUDE_ALLOW_PIGZ=1
else
    log_info "Install pigz for a faster local build (using gzip)"
fi

# Build the patched tarball (shared with all distros)
log_info "Building patched tarball from official .deb..."
SKIP_SMOKE_TEST="$SKIP_SMOKE_TEST" "$SCRIPT_DIR/build-patched-tarball.sh" "$DEB_ARG" "$BUILD_DIR"

# Read build info
# shellcheck disable=SC1091
source "$BUILD_DIR/build-info.txt"
log_info "Built version: $VERSION"
log_info "Tarball: $TARBALL"

# Build RPM using existing packaging script
log_info "Building RPM package..."
RPM_OUTPUT="$BUILD_DIR/rpm"
mkdir -p "$RPM_OUTPUT"
"$PROJECT_DIR/packaging/rpm/build-rpm.sh" "$TARBALL" "$RPM_OUTPUT"

# Find the built RPM
RPM_FILE=$(find "$RPM_OUTPUT" -name "*.rpm" -type f | head -1)
if [ -z "$RPM_FILE" ]; then
    log_error "Build failed - no RPM file found"
    exit 1
fi

# Copy RPM to build dir for easy access
cp "$RPM_FILE" "$BUILD_DIR/"
RPM_FILE="$BUILD_DIR/$(basename "$RPM_FILE")"
log_info "RPM built successfully: $RPM_FILE"

# Install if requested
if [ "$INSTALL_AFTER_BUILD" = true ]; then
    log_info "Installing RPM..."
    sudo dnf install -y "$RPM_FILE"
    log_info "Installation complete! Run 'claude-desktop' to start."
else
    echo ""
    log_info "To install the RPM, run:"
    echo "  sudo dnf install $RPM_FILE"
fi

echo ""
log_info "Build complete!"
