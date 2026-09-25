#!/bin/bash
#
# Local build script for claude-desktop-extra (cross-distro).
#
# Ingests the OFFICIAL Claude Desktop Linux .deb (which already bundles Electron,
# node-pty, chrome-sandbox, tray icons, ion-dist, ...), applies the Linux JS
# patches, builds a pre-patched tarball, then produces an Arch package with
# makepkg and optionally installs it.
#
# Usage: ./scripts/build-local.sh [--deb PATH | --version X] [--install] [--smoke-test] [--pkgrel N]
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_DIR/build"

# Default apt Packages index (amd64). Override via CLAUDE_DESKTOP_APT_URL.
APT_BASE="${CLAUDE_DESKTOP_APT_URL:-https://downloads.claude.ai/claude-desktop/apt/stable}"
APT_PACKAGES_URL="$APT_BASE/dists/stable/main/binary-amd64/Packages"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Parse arguments
INSTALL_AFTER_BUILD=false
SKIP_SMOKE_TEST="${SKIP_SMOKE_TEST:-1}"
PKGREL=""
DEB_PATH=""
DEB_VERSION=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --install|-i)
            INSTALL_AFTER_BUILD=true
            shift
            ;;
        --smoke-test)
            SKIP_SMOKE_TEST=0
            shift
            ;;
        --pkgrel|-r)
            PKGREL="$2"
            shift 2
            ;;
        --deb)
            DEB_PATH="$2"
            shift 2
            ;;
        --version)
            DEB_VERSION="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --deb <PATH>          Use a local official .deb instead of downloading"
            echo "  --version <X>         Download a specific version from the apt repo"
            echo "  --install, -i         Install the package after building"
            echo "  --smoke-test          Run Electron smoke test (skipped by default)"
            echo "  --pkgrel, -r <REL>    Override package release number (default: 1)"
            echo "  --help, -h            Show this help message"
            echo ""
            echo "This script:"
            echo "  1. Resolves the official Claude Desktop Linux .deb (local, pinned, or latest)"
            echo "  2. Applies Linux patches using build-patched-tarball.sh"
            echo "  3. Creates a .pkg.tar.zst package"
            echo "  4. Optionally installs it"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--deb PATH | --version X] [--install] [--pkgrel <REL>] [--smoke-test]"
            exit 1
            ;;
    esac
done

# Check dependencies. ar (binutils) cracks the .deb; no 7z/dpkg-deb needed.
log_info "Checking build dependencies..."
MISSING_DEPS=()
for dep in curl ar tar asar python3 makepkg; do
    if ! command -v "$dep" &> /dev/null; then
        MISSING_DEPS+=("$dep")
    fi
done
if [ ${#MISSING_DEPS[@]} -ne 0 ]; then
    log_error "Missing dependencies: ${MISSING_DEPS[*]}"
    echo "Install them with: sudo pacman -S curl binutils base-devel python"
    echo "For asar: yay -S asar (or npm install -g @electron/asar)"
    exit 1
fi

# Create build directory
log_info "Setting up build directory..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# ─────────────────────────────────────────────────────────────────────────────
# Resolve the .deb source for the ingest script:
#   --deb PATH    → local .deb
#   --version X   → that version's .deb from the apt repo (download in ingest)
#   default       → version pinned in .upstream-version if present in the index,
#                   else the latest available version.
# build-patched-tarball.sh handles the actual download + SHA256/GPG verification.
# ─────────────────────────────────────────────────────────────────────────────
DEB_ARG=""
if [ -n "$DEB_PATH" ]; then
    if [ ! -f "$DEB_PATH" ]; then
        log_error "--deb file not found: $DEB_PATH"
        exit 1
    fi
    log_info "Using local .deb: $DEB_PATH"
    DEB_ARG="$DEB_PATH"
elif [ -n "$DEB_VERSION" ]; then
    log_info "Will fetch version $DEB_VERSION from apt repo"
    DEB_ARG="$APT_BASE/dists/stable/main/binary-amd64/Packages"
    export CLAUDE_DESKTOP_WANT_VERSION="$DEB_VERSION"
else
    # Pin to .upstream-version if it exists in the index; the ingest picks the
    # latest if no explicit version is requested. We only print the pin here for
    # the operator; build-patched-tarball.sh picks the highest available version.
    PIN_FILE="$PROJECT_DIR/.upstream-version"
    if [ -f "$PIN_FILE" ]; then
        log_info "Pinned (.upstream-version): $(tr -d '[:space:]' < "$PIN_FILE") — ingest fetches latest from apt"
    fi
    DEB_ARG="$APT_PACKAGES_URL"
fi

# Prefer the pre-built static musl x11-bridge if present (the CI/local convention
# is to ship the musl binary so it runs across distros). build-patched-tarball.sh
# falls back to `cargo build --release --target x86_64-unknown-linux-musl` otherwise.
X11_BRIDGE_MUSL="$PROJECT_DIR/../computer-use/x11-bridge/target/x86_64-unknown-linux-musl/release/x11-bridge"
if [ -z "${X11_BRIDGE_BIN:-}" ] && [ -f "$X11_BRIDGE_MUSL" ]; then
    export X11_BRIDGE_BIN="$X11_BRIDGE_MUSL"
    log_info "Using pre-built x11-bridge: $X11_BRIDGE_BIN"
fi

# Same convention for the two Wayland bridges: prefer pre-built binaries.
WLROOTS_BRIDGE_MUSL="$PROJECT_DIR/../computer-use/wlroots-bridge/target/x86_64-unknown-linux-musl/release/wlroots-bridge"
if [ -z "${WLROOTS_BRIDGE_BIN:-}" ] && [ -f "$WLROOTS_BRIDGE_MUSL" ]; then
    export WLROOTS_BRIDGE_BIN="$WLROOTS_BRIDGE_MUSL"
    log_info "Using pre-built wlroots-bridge: $WLROOTS_BRIDGE_BIN"
fi

GNOME_PORTAL_BRIDGE_REL="$PROJECT_DIR/../computer-use/gnome-portal-bridge/target/release/gnome-portal-bridge"
if [ -z "${GNOME_PORTAL_BRIDGE_BIN:-}" ] && [ -f "$GNOME_PORTAL_BRIDGE_REL" ]; then
    export GNOME_PORTAL_BRIDGE_BIN="$GNOME_PORTAL_BRIDGE_REL"
    log_info "Using pre-built gnome-portal-bridge: $GNOME_PORTAL_BRIDGE_BIN"
fi

KWIN_PORTAL_BRIDGE_REL="$PROJECT_DIR/../computer-use/kwin-portal-bridge/target/release/kwin-portal-bridge"
if [ -z "${KWIN_PORTAL_BRIDGE_BIN:-}" ] && [ -f "$KWIN_PORTAL_BRIDGE_REL" ]; then
    export KWIN_PORTAL_BRIDGE_BIN="$KWIN_PORTAL_BRIDGE_REL"
    log_info "Using pre-built kwin-portal-bridge: $KWIN_PORTAL_BRIDGE_BIN"
fi

# Build the patched tarball (ingest the .deb)
log_info "Building patched tarball from official .deb..."
SKIP_SMOKE_TEST="$SKIP_SMOKE_TEST" "$SCRIPT_DIR/build-patched-tarball.sh" "$DEB_ARG" "$BUILD_DIR"

# Read build info
# shellcheck disable=SC1091
source "$BUILD_DIR/build-info.txt"
log_info "Built version: $VERSION (electron ${ELECTRON_VERSION:-unknown})"
log_info "Tarball: $TARBALL"
log_info "SHA256: $SHA256"

# Generate PKGBUILD
log_info "Generating PKGBUILD..."
"$SCRIPT_DIR/generate-pkgbuild.sh" "$VERSION" "$SHA256" "file://$TARBALL" ${PKGREL:+"$PKGREL"} > "$BUILD_DIR/PKGBUILD"

# makepkg reads the install= file relative to the PKGBUILD dir, so copy it in.
cp "$PROJECT_DIR/packaging/arch/claude-desktop-extra.install" "$BUILD_DIR/claude-desktop-extra.install"

# Build the package with makepkg.
#
# The claude-desktop tarball is a LOCAL build artifact we regenerate every run:
# its bytes (and sha256) change each build, so any cached copy is stale and
# makepkg would fail it against the freshly-generated sha256sum. makepkg keys the
# cache entry on its download filename (claude-desktop-<pkgver>-<pkgrel>-linux.tar.gz,
# which includes the pkgrel and need not match the artifact's real basename), so
# we purge every cached claude-desktop tarball before the build and let makepkg
# re-copy the fresh one from the file:// source. There is no longer a separately
# downloaded Electron zip to cache — Electron ships inside the tarball.
log_info "Building Arch package..."
SRCDEST_DIR="$PROJECT_DIR/cache"
mkdir -p "$SRCDEST_DIR"
rm -f "$SRCDEST_DIR"/claude-desktop-*-linux.tar.gz "$SRCDEST_DIR"/claude-desktop-*-linux-aarch64.tar.gz
cd "$BUILD_DIR"
SRCDEST="$SRCDEST_DIR" makepkg -sf --noconfirm

# Find the built package
PKG_FILE=$(ls claude-desktop-extra-*.pkg.tar.zst 2>/dev/null | head -1)

if [ -z "$PKG_FILE" ]; then
    log_error "Build failed - no package file found"
    exit 1
fi

log_info "Package built successfully: $BUILD_DIR/$PKG_FILE"

# Install if requested
if [ "$INSTALL_AFTER_BUILD" = true ]; then
    log_info "Installing package..."
    sudo pacman -U --noconfirm "$BUILD_DIR/$PKG_FILE"
    log_info "Installation complete! Run 'claude-desktop' to start."
else
    echo ""
    log_info "To install the package, run:"
    echo "  sudo pacman -U $BUILD_DIR/$PKG_FILE"
fi

echo ""
log_info "Build complete!"
