#!/bin/bash
#
# Build AppImage from the pre-patched Claude Desktop tarball.
#
# The tarball (produced by scripts/build-patched-tarball.sh from the official
# Linux .deb) ships the official Claude Desktop tree VERBATIM under
# claude-desktop/ (Electron runtime + resources/app.asar already patched + our CU
# bridges under resources/), plus launcher/, icons/, and copyright. We do NOT
# download or verify a separate Electron zip.
#
# Usage: ./build-appimage.sh [--arch x86_64|aarch64] <tarball_path> <output_dir>
#
# Requirements: wget (appimagetool/runtime download), appimagetool (or auto-downloaded),
#               zsyncmake (for delta updates)
#
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Parse optional --arch flag (default: x86_64)
APPIMAGE_ARCH="x86_64"
if [ "${1:-}" = "--arch" ]; then
    APPIMAGE_ARCH="$2"
    shift 2
fi

case "$APPIMAGE_ARCH" in
    x86_64|aarch64) ;;
    *)
        log_error "Unsupported architecture: $APPIMAGE_ARCH (supported: x86_64, aarch64)"
        exit 1
        ;;
esac

# Parse positional arguments
TARBALL_PATH="$1"
OUTPUT_DIR="$2"

if [ -z "$TARBALL_PATH" ] || [ -z "$OUTPUT_DIR" ]; then
    echo "Usage: $0 [--arch x86_64|aarch64] <tarball_path> <output_dir>"
    echo ""
    echo "Arguments:"
    echo "  --arch        Target architecture (default: x86_64, also: aarch64)"
    echo "  tarball_path  Path to claude-desktop-VERSION-linux.tar.gz"
    echo "  output_dir    Directory to write AppImage"
    echo ""
    echo "Output:"
    echo "  <output_dir>/Claude_Desktop-<version>-<arch>.AppImage"
    exit 1
fi

if [ ! -f "$TARBALL_PATH" ]; then
    log_error "Tarball not found: $TARBALL_PATH"
    exit 1
fi

# Extract version from tarball filename (handles both -linux.tar.gz and -linux-aarch64.tar.gz)
VERSION=$(basename "$TARBALL_PATH" | sed -E 's/claude-desktop-([0-9]+\.[0-9]+\.[0-9]+)-linux(-aarch64)?\.tar\.gz/\1/')
log_info "Building AppImage for version: $VERSION (arch: $APPIMAGE_ARCH)"

# Create work directory
WORK_DIR=$(mktemp -d)
APPDIR="$WORK_DIR/Claude_Desktop.AppDir"
mkdir -p "$APPDIR"

cleanup() {
    rm -rf "$WORK_DIR"
}
trap cleanup EXIT

# Download appimagetool if not available
# appimagetool must match the HOST architecture (it runs on the build machine)
HOST_ARCH=$(uname -m)
if ! command -v appimagetool &> /dev/null; then
    log_info "Downloading appimagetool (host: ${HOST_ARCH})..."
    APPIMAGETOOL="$WORK_DIR/appimagetool"
    wget -q -O "$APPIMAGETOOL" \
        "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-${HOST_ARCH}.AppImage"
    chmod +x "$APPIMAGETOOL"
else
    APPIMAGETOOL="appimagetool"
fi

# Extract tarball (ships the official Claude Desktop tree verbatim under
# claude-desktop/, with our patched resources/app.asar + CU bridges)
log_info "Extracting Claude Desktop tarball..."
mkdir -p "$WORK_DIR/tarball"
tar -xzf "$TARBALL_PATH" -C "$WORK_DIR/tarball"

# Install the official Claude Desktop tree VERBATIM (from the tarball's
# claude-desktop/ dir): the Electron runtime, resources/app.asar (our patched
# build) + app.asar.unpacked + upstream app resources + our CU bridges. The tree
# is verbatim except the entrypoint is ALREADY renamed to "claude", app.asar is
# our patched build, and the bridges are added. Electron auto-loads the
# exe-adjacent resources/app.asar (OnlyLoadAppFromAsar fuse), so no resources/
# remapping and no binary rename are needed here.
log_info "Installing Claude Desktop tree..."
mkdir -p "$APPDIR/usr/lib/claude-desktop"
cp -r "$WORK_DIR/tarball/claude-desktop/"* "$APPDIR/usr/lib/claude-desktop/"

# Install full launcher from tarball
log_info "Installing launcher..."
mkdir -p "$APPDIR/usr/bin"
install -m755 "$WORK_DIR/tarball/launcher/claude-desktop" "$APPDIR/usr/bin/claude-desktop"

# Upstream license notice (tarball root, from the official .deb's usr/share/doc).
# Warn-only: pre-2026-07 release tarballs lack it.
if [ -f "$WORK_DIR/tarball/copyright" ]; then
    install -Dm644 "$WORK_DIR/tarball/copyright" \
        "$APPDIR/usr/share/doc/claude-desktop/copyright"
else
    log_warn "tarball has no copyright file (old tarball?) — AppImage ships without usr/share/doc/claude-desktop/copyright"
fi

# Create AppRun (delegates to full launcher with AppImage-specific path overrides)
log_info "Creating AppRun..."
cat > "$APPDIR/AppRun" << 'EOF'
#!/bin/bash
SELF=$(readlink -f "$0")
HERE=${SELF%/*}
export PATH="${HERE}/usr/bin:${PATH}"
# The :+ guard matters: LD_LIBRARY_PATH is unset on virtually every desktop,
# so an unconditional ":${LD_LIBRARY_PATH}" left a trailing empty element,
# which the dynamic loader reads as the current directory - every AppImage
# launch then searched $PWD for shared objects.
export LD_LIBRARY_PATH="${HERE}/usr/lib/claude-desktop${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"

# Tell the launcher where the bundled Electron lives. Electron auto-loads the
# exe-adjacent resources/app.asar (OnlyLoadAppFromAsar fuse), so the launcher no
# longer needs (and ignores) CLAUDE_APP_ASAR.
export CLAUDE_ELECTRON="${HERE}/usr/lib/claude-desktop/claude"

# Pass the stable AppImage path so the launcher can register
# the claude:// protocol handler with the correct Exec= path.
export CLAUDE_APPIMAGE_PATH="${APPIMAGE:-}"

# Support --appimage-update flag for self-updating
if [ "$1" = "--appimage-update" ]; then
    if [ -z "$APPIMAGE" ]; then
        echo "Error: Not running as AppImage (extracted?)"
        exit 1
    fi
    if command -v appimageupdatetool &>/dev/null; then
        exec appimageupdatetool "$APPIMAGE"
    else
        echo "appimageupdatetool not found."
        echo "Install it from: https://github.com/AppImageCommunity/AppImageUpdate"
        echo "Or update manually: https://github.com/patrickjaja/claude-desktop-extra/releases/latest"
        exit 1
    fi
fi

exec "${HERE}/usr/bin/claude-desktop" "$@"
EOF
chmod +x "$APPDIR/AppRun"

# Create desktop file.
# Filename is "com.anthropic.Claude.desktop" to match the live window app_id
# "com.anthropic.Claude" (Chromium's GetXdgAppId() reads the app's desktopName
# "com.anthropic.Claude.desktop" from app.asar - upstream's own - and strips
# ".desktop"; we no longer pin our own). appimagetool matches the AppDir-root
# .desktop's Icon= to an icon file at the root (claude-desktop.png, unchanged),
# so the .desktop filename and the Icon= name are independent. On native Wayland
# there is no WM_CLASS, so KWin/GNOME match by app_id; a mismatched basename gives
# a generic icon + Alt+Tab duplicate (issue #148). Content mirrors the official .deb.
log_info "Creating desktop file..."
mkdir -p "$APPDIR/usr/share/applications"
cat > "$APPDIR/com.anthropic.Claude.desktop" << EOF
[Desktop Entry]
Name=Claude
Comment=Desktop application for Claude.ai
GenericName=AI Assistant
Keywords=AI;Chat;Assistant;Claude;Code;LLM;
Exec=claude-desktop %U
Icon=claude-desktop
Type=Application
StartupNotify=true
StartupWMClass=com.anthropic.Claude
# second-instance just focuses mainWindow; suppress GNOME's default "New Window" item
SingleMainWindow=true
Categories=Utility;Development;
MimeType=x-scheme-handler/claude;
Actions=NewChat;NewCode;
X-AppImage-Version=${VERSION}

[Desktop Action NewChat]
Name=New chat
Exec=claude-desktop claude://claude.ai/new

[Desktop Action NewCode]
Name=New Claude Code session
Exec=claude-desktop claude://code/new
EOF
cp "$APPDIR/com.anthropic.Claude.desktop" "$APPDIR/usr/share/applications/"

# Copy icon
log_info "Installing icon..."
if [ -d "$WORK_DIR/tarball/icons/hicolor" ]; then
    mkdir -p "$APPDIR/usr/share/icons"
    cp -a "$WORK_DIR/tarball/icons/hicolor" "$APPDIR/usr/share/icons/"
    # AppImage looks for the app icon at the AppDir root as well.
    cp "$WORK_DIR/tarball/icons/hicolor/256x256/apps/claude-desktop.png" "$APPDIR/claude-desktop.png"
else
    log_warn "Icon not found in tarball"
fi

# Create .DirIcon symlink
if [ -f "$APPDIR/claude-desktop.png" ]; then
    ln -sf claude-desktop.png "$APPDIR/.DirIcon"
fi

# Build AppImage
log_info "Building AppImage..."
mkdir -p "$OUTPUT_DIR"
APPIMAGE_PATH="$OUTPUT_DIR/Claude_Desktop-${VERSION}-${APPIMAGE_ARCH}.AppImage"

# Set architecture for appimagetool
export ARCH=$APPIMAGE_ARCH

# When cross-building (e.g. aarch64 AppImage on x86_64 host), appimagetool embeds
# its own x86_64 runtime stub, producing an AppImage that won't execute on the target.
# Download the correct runtime for the target architecture and pass --runtime-file.
RUNTIME_FLAG=""
if [ "$APPIMAGE_ARCH" != "$HOST_ARCH" ]; then
    log_info "Cross-building: downloading ${APPIMAGE_ARCH} AppImage runtime..."
    RUNTIME_FILE="$WORK_DIR/runtime-${APPIMAGE_ARCH}"
    wget -q -O "$RUNTIME_FILE" \
        "https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-${APPIMAGE_ARCH}"
    RUNTIME_FLAG="--runtime-file $RUNTIME_FILE"
fi

# Embed update information for AppImage delta updates (gh-releases-zsync transport).
# AppImages shipped before the claude-desktop-extra rename resolve updates through
# the old claude-desktop-bin repo path - the legacy mirror serves them there.
UPDATE_INFO="gh-releases-zsync|patrickjaja|claude-desktop-extra|latest|Claude_Desktop-*-${APPIMAGE_ARCH}.AppImage.zsync"
log_info "Embedding update info: $UPDATE_INFO"

if ! command -v zsyncmake &> /dev/null; then
    log_error "zsyncmake not found (install zsync package). Required for AppImage delta updates."
    exit 1
fi

"$APPIMAGETOOL" $RUNTIME_FLAG -u "$UPDATE_INFO" "$APPDIR" "$APPIMAGE_PATH"

# Calculate SHA256
SHA256=$(sha256sum "$APPIMAGE_PATH" | cut -d' ' -f1)

log_info "AppImage built successfully!"
echo "  Version:  $VERSION"
echo "  Path:     $APPIMAGE_PATH"
echo "  SHA256:   $SHA256"

# Verify .zsync was generated (required for --appimage-update).
# appimagetool writes the .zsync next to the output AppImage in some versions,
# but in others it writes to cwd. Search both locations.
ZSYNC_PATH="${APPIMAGE_PATH}.zsync"
ZSYNC_BASENAME="$(basename "$ZSYNC_PATH")"
if [ ! -f "$ZSYNC_PATH" ] && [ -f "$ZSYNC_BASENAME" ]; then
    log_info "Moving .zsync from cwd to output dir"
    mv "$ZSYNC_BASENAME" "$ZSYNC_PATH"
fi
if [ -f "$ZSYNC_PATH" ]; then
    ZSYNC_SHA256=$(sha256sum "$ZSYNC_PATH" | cut -d' ' -f1)
    log_info "Zsync file: $ZSYNC_PATH (SHA256: $ZSYNC_SHA256)"
else
    log_error ".zsync file was not generated (checked $ZSYNC_PATH and ./$ZSYNC_BASENAME)"
    log_error "appimagetool may have failed to call zsyncmake. Check appimagetool output above."
    exit 1
fi

# Write build info
cat > "$OUTPUT_DIR/appimage-info.txt" << EOF
VERSION="$VERSION"
APPIMAGE="$APPIMAGE_PATH"
SHA256="$SHA256"
EOF
