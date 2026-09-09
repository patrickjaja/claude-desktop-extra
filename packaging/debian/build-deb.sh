#!/bin/bash
#
# Build a Debian package from the pre-patched Claude Desktop tarball.
#
# The tarball (produced by scripts/build-patched-tarball.sh from the official
# Linux .deb) ships the official Claude Desktop tree VERBATIM under
# claude-desktop/ (Electron runtime + resources/app.asar already patched + our CU
# bridges under resources/), plus launcher/, icons/, and copyright. We assemble
# our own .deb around it; we do NOT download or verify a separate Electron zip.
#
# Usage: ./build-deb.sh [--arch amd64|arm64] <tarball_path> <output_dir> [pkgrel]
#
# Requirements: dpkg-deb, tar, fakeroot (recommended)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Parse optional --arch flag (default: amd64)
DEB_ARCH="amd64"
if [ "${1:-}" = "--arch" ]; then
    DEB_ARCH="$2"
    shift 2
fi

case "$DEB_ARCH" in
    amd64|arm64) ;;
    *)
        log_error "Unsupported architecture: $DEB_ARCH (supported: amd64, arm64)"
        exit 1
        ;;
esac

# Cowork runs its agent workspace in a lightweight KVM VM, which needs QEMU +
# UEFI firmware + virtiofsd on the host. These mirror the official Claude
# Desktop .deb's own Recommends (soft, so apt pulls them by default but they
# never block install on minimal/headless/KVM-less hosts). The official .deb is
# amd64 (qemu-system-x86, ovmf, virtiofsd); on arm64 the QEMU + firmware names
# differ (qemu-system-arm ships qemu-system-aarch64; qemu-efi-aarch64 is the
# AAVMF firmware). /dev/kvm access still needs the user in the "kvm" group.
case "$DEB_ARCH" in
    amd64) COWORK_RECOMMENDS="qemu-system-x86, ovmf, virtiofsd" ;;
    arm64) COWORK_RECOMMENDS="qemu-system-arm, qemu-efi-aarch64, virtiofsd" ;;
esac

# Parse positional arguments
TARBALL_PATH="${1:-}"
OUTPUT_DIR="${2:-}"
PKGREL="${3:-1}"

if [ -z "$TARBALL_PATH" ] || [ -z "$OUTPUT_DIR" ]; then
    echo "Usage: $0 [--arch amd64|arm64] <tarball_path> <output_dir> [pkgrel]"
    echo ""
    echo "Arguments:"
    echo "  --arch        Target architecture (default: amd64, also: arm64)"
    echo "  tarball_path  Path to claude-desktop-VERSION-linux[-aarch64].tar.gz"
    echo "  output_dir    Directory to write .deb package"
    echo "  pkgrel        Package release number (default: 1)"
    echo ""
    echo "Output:"
    echo "  <output_dir>/claude-desktop-extra_<version>-<pkgrel>_<arch>.deb"
    echo "  <output_dir>/claude-desktop-bin_<version>-<pkgrel>_all.deb (transitional)"
    exit 1
fi

if [ ! -f "$TARBALL_PATH" ]; then
    log_error "Tarball not found: $TARBALL_PATH"
    exit 1
fi

# Extract version from tarball filename (handles both -linux.tar.gz and -linux-aarch64.tar.gz)
VERSION=$(basename "$TARBALL_PATH" | sed -E 's/claude-desktop-([0-9]+\.[0-9]+\.[0-9]+)-linux(-aarch64)?\.tar\.gz/\1/')
DEB_VERSION="${VERSION}-${PKGREL}"
log_info "Building Debian package for version: $DEB_VERSION (arch: $DEB_ARCH)"

# Create work directory
WORK_DIR=$(mktemp -d)
DEB_ROOT="$WORK_DIR/claude-desktop-extra_${DEB_VERSION}_${DEB_ARCH}"

cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

# Extract tarball
log_info "Extracting Claude Desktop tarball..."
mkdir -p "$WORK_DIR/tarball"
tar -xzf "$TARBALL_PATH" -C "$WORK_DIR/tarball"

# Create directory structure
log_info "Creating package structure..."
mkdir -p "$DEB_ROOT/DEBIAN"
mkdir -p "$DEB_ROOT/usr/lib/claude-desktop"
mkdir -p "$DEB_ROOT/usr/bin"
mkdir -p "$DEB_ROOT/usr/share/applications"
mkdir -p "$DEB_ROOT/usr/share/icons"

# Install the official Claude Desktop tree VERBATIM (from the tarball's
# claude-desktop/ dir): the Electron runtime, resources/app.asar (our patched
# build) + app.asar.unpacked + upstream app resources + our CU bridges. The tree
# is verbatim except the entrypoint is ALREADY renamed to "claude", app.asar is
# our patched build, and the bridges are added. Electron auto-loads the
# exe-adjacent resources/app.asar (OnlyLoadAppFromAsar fuse), so no resources/
# remapping and no binary rename are needed here.
log_info "Installing Claude Desktop tree..."
cp -r "$WORK_DIR/tarball/claude-desktop/"* "$DEB_ROOT/usr/lib/claude-desktop/"

# Set SUID permission on chrome-sandbox (required by Chromium's sandbox)
if [ -f "$DEB_ROOT/usr/lib/claude-desktop/chrome-sandbox" ]; then
    chmod 4755 "$DEB_ROOT/usr/lib/claude-desktop/chrome-sandbox"
    log_info "Set SUID permission on chrome-sandbox"
fi

# Install launcher (full launcher from tarball with Wayland/X11 detection,
# GPU fallback, SingletonLock cleanup, and logging)
install -m755 "$WORK_DIR/tarball/launcher/claude-desktop" "$DEB_ROOT/usr/bin/claude-desktop"

# Install desktop file.
# Filename is "com.anthropic.Claude.desktop" to ride upstream's app identity
# "com.anthropic.Claude" (Chromium's GetXdgAppId() reads the app's desktopName,
# now "com.anthropic.Claude.desktop", and strips ".desktop"); we no longer pin it.
# On native Wayland there is no WM_CLASS, so KWin/GNOME match by app_id; a mismatched
# basename gives a generic icon + Alt+Tab duplicate (issue #148). StartupWMClass fixes X11.
# Content mirrors the official Claude Desktop .deb.
cat > "$DEB_ROOT/usr/share/applications/com.anthropic.Claude.desktop" << 'EOF'
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

[Desktop Action NewChat]
Name=New chat
Exec=claude-desktop claude://claude.ai/new

[Desktop Action NewCode]
Name=New Claude Code session
Exec=claude-desktop claude://code/new
EOF

# Install every icon size the tarball carries
if [ -d "$WORK_DIR/tarball/icons/hicolor" ]; then
    cp -a "$WORK_DIR/tarball/icons/hicolor" "$DEB_ROOT/usr/share/icons/"
fi

# Debian policy: ship a copyright file under usr/share/doc/<pkg>/. The tarball
# carries the upstream notice at its root (extracted from the official .deb by
# build-patched-tarball.sh). Warn-only: pre-2026-07 release tarballs lack it.
if [ -f "$WORK_DIR/tarball/copyright" ]; then
    install -Dm644 "$WORK_DIR/tarball/copyright" \
        "$DEB_ROOT/usr/share/doc/claude-desktop-extra/copyright"
else
    log_warn "tarball has no copyright file (old tarball?) - package ships without usr/share/doc/claude-desktop-extra/copyright"
fi

# Calculate installed size (in KB)
INSTALLED_SIZE=$(du -sk "$DEB_ROOT" | cut -f1)

# Create control file.
# Depends mirror the official Claude Desktop .deb's runtime needs (Electron 44 as of v1.49585.0; its NEEDED set is unchanged since Electron 42).
log_info "Creating control file..."
cat > "$DEB_ROOT/DEBIAN/control" << EOF
Package: claude-desktop-extra
Version: ${DEB_VERSION}
Section: utils
Priority: optional
Architecture: ${DEB_ARCH}
Installed-Size: ${INSTALLED_SIZE}
Depends: libgtk-3-0, libnotify4, libnss3, xdg-utils, libatspi2.0-0, libdrm2, libgbm1, libxcb-dri3-0, libsecret-1-0, kde-cli-tools | kde-runtime | trash-cli | libglib2.0-bin | gvfs, libc6 (>= 2.34), libxtst6, libuuid1, xdg-desktop-portal, xdg-desktop-portal-gtk | xdg-desktop-portal-gnome | xdg-desktop-portal-kde
Recommends: libasound2t64 | libasound2 | pulseaudio, libayatana-appindicator3-1 | libappindicator3-1, ca-certificates, gnome-keyring | kwalletd6 | kwalletd5, sqlite3, ${COWORK_RECOMMENDS}
Suggests: imagemagick, socat, ydotool, kde-spectacle, nodejs, bluez
Replaces: claude-desktop-bin (<< ${DEB_VERSION})
Breaks: claude-desktop-bin (<< ${DEB_VERSION})
Maintainer: Claude Desktop Linux Community <claude-desktop-linux@users.noreply.github.com>
Homepage: https://claude.ai
Description: Claude Desktop with extra Linux features
 Claude is an AI assistant created by Anthropic. This package repackages
 the official Claude Desktop Linux build and adds extra features on top:
 Computer Use input/screenshot backends for X11 and Wayland, custom
 themes, multi-profile support, Quick Entry, and the Extra settings hub.
 .
 Note: This is an unofficial community build. Requires an Anthropic account.
EOF

# postinst: SUID chrome-sandbox + AppArmor userns profile (mirrors the official
# .deb's postinst) + cache refresh. The AppArmor profile is what lets Chromium's
# namespace sandbox work on Ubuntu 24.04+ where unprivileged userns is restricted.
cat > "$DEB_ROOT/DEBIAN/postinst" << 'EOF'
#!/bin/sh
set -e

PROFILE="/etc/apparmor.d/claude-desktop"
BINARY="/usr/lib/claude-desktop/claude"

# chrome-sandbox must be SUID root for Chromium's setuid sandbox.
if [ -f /usr/lib/claude-desktop/chrome-sandbox ]; then
    chown root:root /usr/lib/claude-desktop/chrome-sandbox
    chmod 4755 /usr/lib/claude-desktop/chrome-sandbox
fi

case "$1" in
  configure)
    # AppArmor userns profile (gated on AppArmor 4.0; unparseable/unnecessary on 3.x).
    if [ -f /etc/apparmor.d/abi/4.0 ]; then
        rm -f "$PROFILE"
        cat > "$PROFILE" <<PROF
abi <abi/4.0>,
include <tunables/global>

profile claude-desktop $BINARY flags=(unconfined) {
  userns,

  include if exists <local/claude-desktop>
}
PROF
        chmod 0644 "$PROFILE"
        if command -v aa-enabled >/dev/null 2>&1 && aa-enabled --quiet 2>/dev/null; then
            apparmor_parser -r -W -T "$PROFILE" || true
        fi
    fi
    ;;
esac

# Rename migration (retire with the transition window): point an APT source
# still on the pre-rename Pages URL at the new repository. Guarded - must
# never fail the dpkg transaction (script runs under set -e).
SOURCES=/etc/apt/sources.list.d/claude-desktop.sources
if [ -f "$SOURCES" ] && grep -q 'patrickjaja.github.io/claude-desktop-bin/' "$SOURCES" 2>/dev/null; then
    if sed -i 's|patrickjaja.github.io/claude-desktop-bin/|patrickjaja.github.io/claude-desktop-extra/|g' "$SOURCES" 2>/dev/null; then
        echo "claude-desktop-extra: migrated APT source to the new repository URL"
    fi
fi

if command -v update-icon-caches >/dev/null 2>&1; then
    update-icon-caches /usr/share/icons/hicolor || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database /usr/share/applications || true
fi
EOF
chmod +x "$DEB_ROOT/DEBIAN/postinst"

# postrm: remove the AppArmor profile (mirrors the official .deb's postrm) + cache refresh.
cat > "$DEB_ROOT/DEBIAN/postrm" << 'EOF'
#!/bin/sh
set -e

PROFILE="/etc/apparmor.d/claude-desktop"

case "$1" in
  remove|purge)
    if [ -f "$PROFILE" ]; then
        if command -v aa-enabled >/dev/null 2>&1 && aa-enabled --quiet 2>/dev/null; then
            apparmor_parser -R "$PROFILE" || true
        fi
        rm -f "$PROFILE"
    fi
    if command -v update-icon-caches >/dev/null 2>&1; then
        update-icon-caches /usr/share/icons/hicolor || true
    fi
    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database /usr/share/applications || true
    fi
    ;;
esac
EOF
chmod +x "$DEB_ROOT/DEBIAN/postrm"

# Build the package
log_info "Building .deb package..."
mkdir -p "$OUTPUT_DIR"
DEB_PATH="$OUTPUT_DIR/claude-desktop-extra_${DEB_VERSION}_${DEB_ARCH}.deb"

if command -v fakeroot >/dev/null 2>&1; then
    fakeroot dpkg-deb --build "$DEB_ROOT" "$DEB_PATH"
else
    dpkg-deb --build "$DEB_ROOT" "$DEB_PATH"
fi

# --- TRANSITIONAL PACKAGE (claude-desktop-bin -> claude-desktop-extra rename) ---
# Empty dummy package that pulls in claude-desktop-extra so existing
# claude-desktop-bin installs migrate on a plain `apt upgrade`.
# Architecture: all - one copy serves every arch in the repo.
# Retire this block after the rename transition window ends.
build_transitional_deb() {
    local trans_root="$WORK_DIR/claude-desktop-bin_${DEB_VERSION}_all"
    mkdir -p "$trans_root/DEBIAN" "$trans_root/usr/share/doc/claude-desktop-bin"

    cat > "$trans_root/usr/share/doc/claude-desktop-bin/README" << EOF
This package has been renamed to claude-desktop-extra.
claude-desktop-bin is now an empty transitional package and can be
removed once claude-desktop-extra is installed:

    sudo apt autoremove
EOF

    local trans_size
    trans_size=$(du -sk "$trans_root" | cut -f1)

    cat > "$trans_root/DEBIAN/control" << EOF
Package: claude-desktop-bin
Version: ${DEB_VERSION}
Section: oldlibs
Priority: optional
Architecture: all
Installed-Size: ${trans_size}
Depends: claude-desktop-extra (= ${DEB_VERSION})
Maintainer: Claude Desktop Linux Community <claude-desktop-linux@users.noreply.github.com>
Homepage: https://claude.ai
Description: transitional package - renamed to claude-desktop-extra
 The Claude Desktop community build was renamed to claude-desktop-extra.
 This transitional package ensures a smooth upgrade and can be safely
 removed after installation.
EOF

    # postinst: migrate the APT source to the post-rename Pages URL. The old
    # patrickjaja.github.io/claude-desktop-bin/ path is served by the legacy
    # mirror only during the transition window; rewriting it here makes every
    # upgraded install permanent. Guarded and idempotent - a migration hiccup
    # must never fail the dpkg transaction.
    cat > "$trans_root/DEBIAN/postinst" << 'EOF'
#!/bin/sh
set -u
SOURCES=/etc/apt/sources.list.d/claude-desktop.sources
if [ -f "$SOURCES" ] && grep -q 'patrickjaja.github.io/claude-desktop-bin/' "$SOURCES" 2>/dev/null; then
    if sed -i 's|patrickjaja.github.io/claude-desktop-bin/|patrickjaja.github.io/claude-desktop-extra/|g' "$SOURCES" 2>/dev/null; then
        echo "claude-desktop-bin: migrated APT source to the new claude-desktop-extra repository URL"
    fi
fi
exit 0
EOF
    chmod 0755 "$trans_root/DEBIAN/postinst"

    TRANSITIONAL_DEB_PATH="$OUTPUT_DIR/claude-desktop-bin_${DEB_VERSION}_all.deb"
    if command -v fakeroot >/dev/null 2>&1; then
        fakeroot dpkg-deb --build "$trans_root" "$TRANSITIONAL_DEB_PATH"
    else
        dpkg-deb --build "$trans_root" "$TRANSITIONAL_DEB_PATH"
    fi
    log_info "Built transitional package: $TRANSITIONAL_DEB_PATH"
}

TRANSITIONAL_DEB_PATH=""
build_transitional_deb
# --- END TRANSITIONAL PACKAGE ---

# Calculate SHA256
SHA256=$(sha256sum "$DEB_PATH" | cut -d' ' -f1)

log_info "Debian package built successfully!"
echo "  Version:  $DEB_VERSION"
echo "  Path:     $DEB_PATH"
echo "  SHA256:   $SHA256"

# Write build info
cat > "$OUTPUT_DIR/deb-info.txt" << EOF
VERSION="$DEB_VERSION"
DEB="$DEB_PATH"
SHA256="$SHA256"
# Informational only - CI stages the transitional deb via its artifact glob.
TRANSITIONAL_DEB="$TRANSITIONAL_DEB_PATH"
EOF
