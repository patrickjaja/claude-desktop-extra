#!/bin/bash
#
# Build a pre-patched tarball from the OFFICIAL Claude Desktop Linux .deb.
#
# Anthropic now ships an official Linux .deb (amd64 + arm64) via the apt repo at
# https://downloads.claude.ai/claude-desktop/apt/stable/ . It already bundles
# Electron, chrome-sandbox, a Linux node-pty + @ant/claude-native binding, the
# tray icons, ion-dist, fonts, cowork-linux-helper, virtiofsd and smol-bin.x64.img.
# We no longer download/verify Electron or rebuild node-pty for Linux — we ingest
# the .deb, apply our Linux JS patches to app.asar, and repack into a distributable
# tarball that the per-distro packagers (deb/rpm/appimage/nix/AUR) consume.
#
# Usage:
#   ./scripts/build-patched-tarball.sh <deb-path-OR-apt-Packages-URL> <output_dir>
#
#   Arg 1 is EITHER a local .deb file, OR an apt Packages index URL such as
#     https://downloads.claude.ai/claude-desktop/apt/stable/dists/stable/main/binary-amd64/Packages
#   When a URL is given we parse the highest Version stanza (Filename + SHA256),
#   download the .deb, and verify its SHA256 against the index. With GPG verify on
#   (default) we also verify the signed Release that the Packages index chains to.
#
# Environment:
#   SKIP_SMOKE_TEST=1        Skip the Electron smoke test (default in local wrappers).
#   KWIN_PORTAL_BRIDGE_BIN   Path to a pre-built kwin-portal-bridge to bundle.
#   X11_BRIDGE_BIN           Path to a pre-built x11-bridge (static musl) to bundle.
#   WLROOTS_BRIDGE_BIN       Path to a pre-built wlroots-bridge (static musl) to bundle.
#   GNOME_PORTAL_BRIDGE_BIN  Path to a pre-built gnome-portal-bridge to bundle.
#   CLAUDE_DEB_ARCH          amd64|arm64 — which arch to pick when arg1 is a URL (default amd64).
#   CLAUDE_GPG_VERIFY        1 (default) | 0 — verify the signed Release when arg1 is a URL.
#   CLAUDE_DESKTOP_GPG_KEY   Override the bundled Anthropic signing key (.asc).
#   CLAUDE_DESKTOP_APT_URL   Override the apt repo base (default derived from the Packages URL).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PATCHES_DIR="$PROJECT_DIR/patches"

# If patches dir is read-only (e.g. CI bind-mount), copy to a writable location
# so Nim can write .nimcache and compiled binaries alongside the sources.
if [ -d "$PATCHES_DIR" ] && ! touch "$PATCHES_DIR/.write-test" 2>/dev/null; then
    WRITABLE_PATCHES="$(mktemp -d)/patches"
    cp -r "$PATCHES_DIR" "$WRITABLE_PATCHES"
    # Also copy js/ dir (Nim patches embed snippets via staticRead with ../js/ paths)
    [ -d "$PROJECT_DIR/js" ] && cp -r "$PROJECT_DIR/js" "$(dirname "$WRITABLE_PATCHES")/js"
    PATCHES_DIR="$WRITABLE_PATCHES"
else
    rm -f "$PATCHES_DIR/.write-test" 2>/dev/null || true
fi

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Parse arguments
DEB_SOURCE="${1:-}"
OUTPUT_DIR="${2:-}"

if [ -z "$DEB_SOURCE" ] || [ -z "$OUTPUT_DIR" ]; then
    echo "Usage: $0 <deb-path-OR-apt-Packages-URL> <output_dir>"
    echo ""
    echo "Arguments:"
    echo "  deb-path-or-url  Path to a local claude-desktop_*.deb, OR an apt Packages index URL"
    echo "  output_dir       Directory to write the tarball and build-info.txt"
    echo ""
    echo "Output:"
    echo "  <output_dir>/claude-desktop-<version>-linux.tar.gz          (amd64)"
    echo "  <output_dir>/claude-desktop-<version>-linux-aarch64.tar.gz  (arm64)"
    exit 1
fi

# Check dependencies. We crack the .deb with `ar` + `tar` (NOT dpkg-deb, which is
# absent on Arch). asar/python3 for patching; gpg/gpgv only when verifying a URL.
log_info "Checking dependencies..."
MISSING_DEPS=()
for dep in ar tar asar python3; do
    if ! command -v "$dep" &> /dev/null; then
        MISSING_DEPS+=("$dep")
    fi
done
if [ ${#MISSING_DEPS[@]} -ne 0 ]; then
    log_error "Missing dependencies: ${MISSING_DEPS[*]}"
    echo "Install them with: sudo pacman -S binutils tar python (ar ships with binutils)"
    echo "For asar: yay -S asar (or npm install -g @electron/asar)"
    exit 1
fi

# Create output directory and a private work dir. Absolutize OUTPUT_DIR so
# paths derived from it survive the cd-subshells below.
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
WORK_DIR="$OUTPUT_DIR/work"
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

# ─────────────────────────────────────────────────────────────────────────────
# Step 1: Resolve a local .deb path (download + verify from apt if a URL was given)
# ─────────────────────────────────────────────────────────────────────────────
DEB_PATH=""
if [ -f "$DEB_SOURCE" ]; then
    DEB_PATH="$(realpath "$DEB_SOURCE")"
    log_info "Using local .deb: $DEB_PATH"
elif [[ "$DEB_SOURCE" =~ ^https?:// ]]; then
    log_info "Resolving .deb from apt Packages index: $DEB_SOURCE"
    # The apt repo base is everything up to /dists/ (where Filename paths are relative).
    # CLAUDE_DESKTOP_APT_URL can override it explicitly.
    APT_BASE="${CLAUDE_DESKTOP_APT_URL:-${DEB_SOURCE%%/dists/*}}"
    DEB_ARCH="${CLAUDE_DEB_ARCH:-amd64}"

    PKGFILE="$WORK_DIR/Packages"
    log_info "Fetching Packages index..."
    curl -fsSL "$DEB_SOURCE" -o "$PKGFILE"

    # Parse the highest Version stanza for the requested arch → Filename + SHA256.
    # apt Packages is a deb822 file (blank-line-separated stanzas). We pick the
    # numerically-highest Version of package "claude-desktop" matching the arch
    # (or the pinned CLAUDE_DESKTOP_WANT_VERSION). Capture first so a python exit
    # is caught by our own check rather than aborting on read's EOF under set -e.
    PKG_QUERY="$(python3 - "$PKGFILE" "$DEB_ARCH" "${CLAUDE_DESKTOP_WANT_VERSION:-}" <<'PY'
import sys
from functools import cmp_to_key

path, want_arch = sys.argv[1], sys.argv[2]
want_version = sys.argv[3] if len(sys.argv) > 3 else ""
with open(path, encoding="utf-8") as f:
    blob = f.read()

def parse(stanza):
    d = {}
    for line in stanza.splitlines():
        if line[:1].isspace() or ":" not in line:
            continue
        k, _, v = line.partition(":")
        d[k.strip()] = v.strip()
    return d

def vercmp(a, b):
    # Adequate for X.Y.Z(.W) upstream versions used here.
    pa = [int(x) for x in a.replace("-", ".").split(".") if x.isdigit()]
    pb = [int(x) for x in b.replace("-", ".").split(".") if x.isdigit()]
    return (pa > pb) - (pa < pb)

cands = []
for stanza in blob.split("\n\n"):
    d = parse(stanza)
    if d.get("Package") == "claude-desktop" and d.get("Architecture") == want_arch:
        if "Version" in d and "Filename" in d and "SHA256" in d:
            cands.append(d)

if not cands:
    sys.stderr.write(f"No claude-desktop {want_arch} stanza in {path}\n")
    sys.exit(1)

if want_version:
    pinned = [c for c in cands if c["Version"] == want_version]
    if not pinned:
        avail = ", ".join(sorted({c["Version"] for c in cands}))
        sys.stderr.write(f"Version {want_version} ({want_arch}) not in index. Available: {avail}\n")
        sys.exit(1)
    best = pinned[0]
else:
    best = max(cands, key=cmp_to_key(lambda x, y: vercmp(x["Version"], y["Version"])))
print(best["Version"], best["Filename"], best["SHA256"])
PY
)" || { log_error "Failed to resolve a $DEB_ARCH .deb from the Packages index"; exit 1; }
    read -r DEB_VERSION DEB_FILENAME DEB_SHA256 <<< "$PKG_QUERY"
    if [ -z "${DEB_VERSION:-}" ] || [ -z "${DEB_FILENAME:-}" ] || [ -z "${DEB_SHA256:-}" ]; then
        log_error "Could not resolve a $DEB_ARCH .deb from the Packages index"
        exit 1
    fi
    log_info "Selected version $DEB_VERSION ($DEB_ARCH)"

    # GPG: verify the signed Release the Packages index chains into. The .deb's
    # SHA256 (Packages) → Packages' SHA256 (Release) → Release signature (gpg).
    if [ "${CLAUDE_GPG_VERIFY:-1}" = "1" ]; then
        GPG_KEY="${CLAUDE_DESKTOP_GPG_KEY:-$PROJECT_DIR/packaging/claude-desktop-archive-keyring.asc}"
        if [ ! -f "$GPG_KEY" ]; then
            log_error "GPG key not found at $GPG_KEY (set CLAUDE_DESKTOP_GPG_KEY or CLAUDE_GPG_VERIFY=0)"
            exit 1
        fi
        # dists/<suite>/ holds Release + Release.gpg (and InRelease). Derive the
        # suite dir from the Packages URL: .../dists/<suite>/main/binary-<arch>/Packages
        DISTS_DIR="${DEB_SOURCE%/main/*}"   # → .../dists/<suite>
        log_info "Verifying signed Release (gpg)..."
        curl -fsSL "$DISTS_DIR/Release"     -o "$WORK_DIR/Release"
        curl -fsSL "$DISTS_DIR/Release.gpg" -o "$WORK_DIR/Release.gpg"
        # Verify the SHA256 in our trusted index file appears in the signed Release,
        # so the Packages we parsed is the one Release vouches for. Then gpgv the sig.
        PKG_SHA="$(sha256sum "$PKGFILE" | cut -d' ' -f1)"
        if ! grep -qiE "^[[:space:]]*${PKG_SHA}[[:space:]]" "$WORK_DIR/Release"; then
            log_error "Packages SHA256 ($PKG_SHA) not present in the signed Release — chain broken"
            exit 1
        fi
        # Dearmor the ASCII key into a binary keyring, then gpgv the detached sig
        # against it (the standard apt-secure pattern — no trust DB, no keyserver).
        TMP_GNUPG="$(mktemp -d)"
        KEYRING="$WORK_DIR/claude-desktop.gpg"
        gpg --homedir "$TMP_GNUPG" --batch --yes --dearmor -o "$KEYRING" "$GPG_KEY" 2>/dev/null
        if ! gpgv --keyring "$KEYRING" "$WORK_DIR/Release.gpg" "$WORK_DIR/Release" 2>"$WORK_DIR/gpgv.log"; then
            cat "$WORK_DIR/gpgv.log" >&2
            rm -rf "$TMP_GNUPG"
            log_error "Release signature verification FAILED"
            exit 1
        fi
        rm -rf "$TMP_GNUPG"
        log_info "Release signature OK; Packages index chains to it"
    else
        log_warn "GPG verification disabled (CLAUDE_GPG_VERIFY=0) — trusting HTTPS only"
    fi

    DEB_PATH="$WORK_DIR/claude-desktop_${DEB_VERSION}_${DEB_ARCH}.deb"
    log_info "Downloading .deb: $APT_BASE/$DEB_FILENAME"
    curl -fsSL "$APT_BASE/$DEB_FILENAME" -o "$DEB_PATH"

    GOT_SHA="$(sha256sum "$DEB_PATH" | cut -d' ' -f1)"
    if [ "$GOT_SHA" != "$DEB_SHA256" ]; then
        log_error ".deb SHA256 mismatch!"
        log_error "  expected (Packages): $DEB_SHA256"
        log_error "  got:                 $GOT_SHA"
        exit 1
    fi
    log_info ".deb SHA256 verified against Packages index"
else
    log_error "Argument 1 is neither a local file nor an http(s) URL: $DEB_SOURCE"
    exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 2: Crack the .deb (ar → data.tar.* → tar). No dpkg-deb dependency.
# ─────────────────────────────────────────────────────────────────────────────
log_info "Extracting .deb (ar + tar)..."
AR_DIR="$WORK_DIR/ar"
mkdir -p "$AR_DIR"
( cd "$AR_DIR" && ar x "$(realpath "$DEB_PATH")" )

# control.tar.* → read Version + Architecture from DEBIAN/control
CONTROL_DIR="$WORK_DIR/control"
mkdir -p "$CONTROL_DIR"
CONTROL_TAR="$(ls "$AR_DIR"/control.tar.* 2>/dev/null | head -1)"
[ -n "$CONTROL_TAR" ] || { log_error "control.tar.* not found in .deb"; exit 1; }
tar -xf "$CONTROL_TAR" -C "$CONTROL_DIR"

VERSION="$(awk -F': ' '/^Version:/{print $2; exit}' "$CONTROL_DIR/control" | tr -d '[:space:]')"
DEB_ARCH="$(awk -F': ' '/^Architecture:/{print $2; exit}' "$CONTROL_DIR/control" | tr -d '[:space:]')"
[ -n "$VERSION" ] || { log_error "Could not read Version from .deb control"; exit 1; }
log_info "Detected version: $VERSION (arch: $DEB_ARCH)"

# data.tar.* → the filesystem tree (usr/lib/claude-desktop/, usr/share/...).
# tar auto-detects xz/zst/gz.
DATA_DIR="$WORK_DIR/data"
mkdir -p "$DATA_DIR"
DATA_TAR="$(ls "$AR_DIR"/data.tar.* 2>/dev/null | head -1)"
[ -n "$DATA_TAR" ] || { log_error "data.tar.* not found in .deb"; exit 1; }
tar -xf "$DATA_TAR" -C "$DATA_DIR"

LIB_DIR="$DATA_DIR/usr/lib/claude-desktop"
RES_DIR="$LIB_DIR/resources"
if [ ! -f "$RES_DIR/app.asar" ]; then
    log_error "app.asar not found at $RES_DIR — is this a valid Claude Desktop .deb?"
    exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 3: Stage the verbatim upstream tree and patch app.asar in place.
# The tarball ships the .deb's usr/lib/claude-desktop/ tree unchanged except:
#   - the Electron entrypoint binary is renamed claude-desktop → claude
#     (APP_ID; the launcher and every packager expect this name)
#   - resources/app.asar is our patched build
#   - our CU bridge binaries are added to resources/
# Electron auto-loads the exe-adjacent resources/app.asar (OnlyLoadAppFromAsar
# fuse), so process.resourcesPath and app.isPackaged behave exactly as on the
# stock Anthropic .deb — no path-redirect patches, no argv asar.
# ─────────────────────────────────────────────────────────────────────────────
log_info "Staging verbatim upstream tree..."
TREE_DIR="$WORK_DIR/tree"
rm -rf "$TREE_DIR"
cp -r "$LIB_DIR" "$TREE_DIR"

# The Electron entrypoint binary is named "claude-desktop" in the .deb; rename it
# once here so every packager ships the same tree without post-processing.
if [ ! -f "$TREE_DIR/claude-desktop" ]; then
    log_error "Electron binary 'claude-desktop' missing from $LIB_DIR"
    exit 1
fi
mv "$TREE_DIR/claude-desktop" "$TREE_DIR/claude"

# Record the bundled Electron version for traceability.
ELECTRON_VERSION="$(cat "$TREE_DIR/version" 2>/dev/null | tr -d '[:space:]' || true)"
[ -n "$ELECTRON_VERSION" ] && log_info "Bundled Electron version: $ELECTRON_VERSION"

# Patch workspace: extract app.asar for patching (the sibling app.asar.unpacked
# in the tree provides the unpacked files during extraction).
log_info "Extracting app.asar..."
APP_DIR="$WORK_DIR/app"
mkdir -p "$APP_DIR"
asar extract "$TREE_DIR/resources/app.asar" "$APP_DIR/app.asar.contents"

# App identity: we ride upstream's own desktopName ("com.anthropic.Claude.desktop")
# rather than pinning our own. Chromium derives the window's Wayland app_id / X11
# WM_CLASS from package.json desktopName (GetXdgAppId, when $CHROME_DESKTOP is
# unset and no --class is passed - both true in our launcher). Every .desktop file
# we ship (deb/rpm/AUR/AppImage/Nix, the launcher's per-profile entries,
# StartupWMClass, and the claude:// xdg-mime handler) is built around that same
# "com.anthropic.Claude" identity, so window/icon matching and xdg-desktop-portal
# activation routing agree on the upstream reverse-DNS id (which, unlike the old
# single-segment "claude-desktop", also lets KDE persist Computer Use grants).
# We do NOT touch productName ("Claude"), so userData stays ~/.config/Claude.
# This tripwire fails loud if upstream renames desktopName again, so our fixed
# .desktop filenames cannot silently desync from the live window app_id.
log_info "Asserting upstream desktopName app identity..."
PKG_JSON="$APP_DIR/app.asar.contents/package.json"
if ! grep -q '"desktopName": *"com.anthropic.Claude.desktop"' "$PKG_JSON"; then
    log_error "package.json desktopName is not \"com.anthropic.Claude.desktop\" - upstream changed the app identity; re-audit the .desktop filenames + StartupWMClass + launcher DESKTOP_ID (see the launcher APP_ID/DESKTOP_ID header)"
    exit 1
fi
log_info "desktopName is upstream com.anthropic.Claude.desktop (no pin)"

# Compile Nim patches (native build or Docker fallback)
log_info "Compiling Nim patches..."
"$SCRIPT_DIR/compile-nim-patches.sh" "$PATCHES_DIR"

# Challenge every patch against the still-pristine bundle BEFORE applying
# (CONSTRAINTS.md P1/P2): a patch whose end state upstream already ships
# changes nothing, and its "already patched" branch would keep the build
# green while we carry a dead patch. Audit it, then git rm it.
log_info "Probing for patches upstream already absorbed..."
if ! python3 "$SCRIPT_DIR/check-upstream-absorbed.py" --patches "$PATCHES_DIR" \
    "$APP_DIR/app.asar.contents" "$TREE_DIR/resources/ion-dist"; then
    log_error "Absorption probe failed - see CONSTRAINTS.md P1 (audit, then remove the patch)"
    exit 1
fi

# Apply all patches via orchestrator
log_info "Applying patches..."
if ! python3 "$SCRIPT_DIR/apply_patches.py" "$PATCHES_DIR" "$APP_DIR"; then
    log_error "One or more patches failed to apply"
    exit 1
fi

# Validate JavaScript syntax after patching
log_info "Validating JavaScript syntax..."
SYNTAX_FAILED=false
for js_file in "$APP_DIR/app.asar.contents/.vite/build/"*.js; do
    [ -f "$js_file" ] || continue
    if ! node --check "$js_file" 2>/dev/null; then
        log_error "Syntax error in $(basename "$js_file")"
        SYNTAX_FAILED=true
    fi
done
for js_file in "$APP_DIR/app.asar.contents/.vite/renderer/"*"/assets/"*.js; do
    [ -f "$js_file" ] || continue
    if ! node --check "$js_file" 2>/dev/null; then
        log_error "Syntax error in $(basename "$js_file")"
        SYNTAX_FAILED=true
    fi
done
if [ "$SYNTAX_FAILED" = true ]; then
    log_error "JavaScript syntax validation FAILED - patched files have syntax errors"
    exit 1
fi
log_info "JavaScript syntax validation passed"

# Drop upstream's V8 bytecode compile-cache (new in v1.34493.1). index.pre.js
# feeds each .jsc to `new vm.Script(..., {cachedData})`; V8 validates it against
# the source and silently recompiles on mismatch, so patched code runs correctly
# either way. But we patch the two files the cache covers, so 5.04 MB of the
# 5.05 MB is guaranteed rejected - dead weight in every artifact and a pointless
# 5 MB read at startup. A missing directory is already handled upstream (the
# readdirSync sits in a try/catch that yields []).
if [ -d "$APP_DIR/app.asar.contents/compile-cache" ]; then
    log_info "Dropping upstream compile-cache ($(du -sh "$APP_DIR/app.asar.contents/compile-cache" | cut -f1)) - invalidated by our patches"
    rm -rf "$APP_DIR/app.asar.contents/compile-cache"
fi

# Repack app.asar into the tree.
# --unpack keeps native .node files and any spawn-helper in app.asar.unpacked/ and
# flags them in the asar header so Electron redirects require() to the unpacked copy.
# (The .deb's node-pty uses the prebuilds/<platform>-<arch>/ layout, which loads
# from the unpacked dir; we preserve whatever the .deb shipped.)
log_info "Repacking app.asar..."
( cd "$APP_DIR" && asar pack app.asar.contents app.asar --unpack "{**/*.node,**/spawn-helper}" )
rm -rf "$APP_DIR/app.asar.contents"
rm -rf "$TREE_DIR/resources/app.asar" "$TREE_DIR/resources/app.asar.unpacked"
mv "$APP_DIR/app.asar" "$TREE_DIR/resources/app.asar"
if [ -d "$APP_DIR/app.asar.unpacked" ]; then
    mv "$APP_DIR/app.asar.unpacked" "$TREE_DIR/resources/app.asar.unpacked"
fi

# Windows-only tray .ico files are dead weight on Linux.
find "$TREE_DIR/resources" -maxdepth 1 \( -name "*.exe" -o -name "*.dll" -o -name "*.ico" \) -delete 2>/dev/null || true

# Ensure claude-ssh binaries are executable (if shipped)
chmod +x "$TREE_DIR/resources/claude-ssh/claude-ssh-"* 2>/dev/null || true

# Apply ion-dist patches (the SPA has content-hashed filenames, so the patch finds
# its target file dynamically by grepping for a unique pattern).
ION_DIST_DIR="$TREE_DIR/resources/ion-dist"
ION_DIST_PATCH="$PATCHES_DIR/linux/fix_ion_dist_linux"
if [ -d "$ION_DIST_DIR" ] && [ -x "$ION_DIST_PATCH" ]; then
    log_info "Applying ion-dist patches..."
    if ! "$ION_DIST_PATCH" "$ION_DIST_DIR"; then
        log_error "ion-dist patch failed"
        exit 1
    fi
elif [ -d "$ION_DIST_DIR" ]; then
    log_warn "ion-dist found but patch binary not available - skipping"
else
    log_warn "ion-dist not found in upstream resources - skipping"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 4: Assemble the tarball (claude-desktop/ verbatim tree + icons/ + launcher/).
# ─────────────────────────────────────────────────────────────────────────────
log_info "Creating tarball structure..."
TARBALL_DIR="$WORK_DIR/tarball"
mkdir -p "$TARBALL_DIR/icons" "$TARBALL_DIR/launcher"
mv "$TREE_DIR" "$TARBALL_DIR/claude-desktop"
TREE_DIR="$TARBALL_DIR/claude-desktop"

# Launcher script
cp "$SCRIPT_DIR/claude-desktop-launcher.sh" "$TARBALL_DIR/launcher/claude-desktop"
chmod +x "$TARBALL_DIR/launcher/claude-desktop"

# Bundle kwin-portal-bridge into resources/ (= process.resourcesPath) for KDE Wayland
# Computer Use. STAYS — Computer Use is a kept feature.
if [ -n "${KWIN_PORTAL_BRIDGE_BIN:-}" ] && [ -f "${KWIN_PORTAL_BRIDGE_BIN:-}" ]; then
    log_info "Bundling kwin-portal-bridge from $KWIN_PORTAL_BRIDGE_BIN"
    cp "$KWIN_PORTAL_BRIDGE_BIN" "$TREE_DIR/resources/kwin-portal-bridge"
    chmod +x "$TREE_DIR/resources/kwin-portal-bridge"
elif command -v cargo &>/dev/null && [ -d "$PROJECT_DIR/../computer-use/kwin-portal-bridge" ]; then
    log_info "Building kwin-portal-bridge from source..."
    if (cd "$PROJECT_DIR/../computer-use/kwin-portal-bridge" && cargo build --release 2>&1 | tail -3); then
        cp "$PROJECT_DIR/../computer-use/kwin-portal-bridge/target/release/kwin-portal-bridge" "$TREE_DIR/resources/kwin-portal-bridge"
        chmod +x "$TREE_DIR/resources/kwin-portal-bridge"
        log_info "kwin-portal-bridge built and bundled"
    else
        log_warn "kwin-portal-bridge build failed — skipping (KDE Wayland Computer Use will require manual install)"
    fi
else
    log_warn "kwin-portal-bridge not available — skipping (KDE Wayland Computer Use will require manual install)"
fi

# Bundle x11-bridge into resources/ (= process.resourcesPath) for X11 / XWayland
# Computer Use. First-party replacement for xdotool/scrot/import/wmctrl on X11.
# We bundle the static MUSL build so it runs across distros regardless of glibc.
X11_BRIDGE_MUSL_REL="target/x86_64-unknown-linux-musl/release/x11-bridge"
X11_BRIDGE_SRC_DIR="$PROJECT_DIR/../computer-use/x11-bridge"
if [ -n "${X11_BRIDGE_BIN:-}" ] && [ -f "${X11_BRIDGE_BIN:-}" ]; then
    log_info "Bundling x11-bridge from $X11_BRIDGE_BIN"
    cp "$X11_BRIDGE_BIN" "$TREE_DIR/resources/x11-bridge"
    chmod +x "$TREE_DIR/resources/x11-bridge"
elif command -v cargo &>/dev/null && [ -d "$X11_BRIDGE_SRC_DIR" ]; then
    log_info "Building x11-bridge (static musl) from source ($X11_BRIDGE_SRC_DIR)..."
    if (cd "$X11_BRIDGE_SRC_DIR" && cargo build --release --target x86_64-unknown-linux-musl 2>&1 | tail -3); then
        cp "$X11_BRIDGE_SRC_DIR/$X11_BRIDGE_MUSL_REL" "$TREE_DIR/resources/x11-bridge"
        chmod +x "$TREE_DIR/resources/x11-bridge"
        log_info "x11-bridge built and bundled"
    else
        log_warn "x11-bridge build failed — skipping (X11 Computer Use will require manual install)"
    fi
else
    log_warn "x11-bridge not available — skipping (X11 Computer Use will require manual install)"
fi

# Bundle wlroots-bridge into resources/ (= process.resourcesPath) for wlroots
# Wayland (Sway/Hyprland/Niri) Computer Use. First-party replacement for
# ydotool/grim/hyprctl/swaymsg+jq/niri on wlroots sessions. Static MUSL build
# so it runs across distros regardless of glibc (incl. NixOS).
WLROOTS_BRIDGE_MUSL_REL="target/x86_64-unknown-linux-musl/release/wlroots-bridge"
WLROOTS_BRIDGE_SRC_DIR="$PROJECT_DIR/../computer-use/wlroots-bridge"
if [ -n "${WLROOTS_BRIDGE_BIN:-}" ] && [ -f "${WLROOTS_BRIDGE_BIN:-}" ]; then
    log_info "Bundling wlroots-bridge from $WLROOTS_BRIDGE_BIN"
    cp "$WLROOTS_BRIDGE_BIN" "$TREE_DIR/resources/wlroots-bridge"
    chmod +x "$TREE_DIR/resources/wlroots-bridge"
elif command -v cargo &>/dev/null && [ -d "$WLROOTS_BRIDGE_SRC_DIR" ]; then
    log_info "Building wlroots-bridge (static musl) from source ($WLROOTS_BRIDGE_SRC_DIR)..."
    if (cd "$WLROOTS_BRIDGE_SRC_DIR" && cargo build --release --target x86_64-unknown-linux-musl 2>&1 | tail -3); then
        cp "$WLROOTS_BRIDGE_SRC_DIR/$WLROOTS_BRIDGE_MUSL_REL" "$TREE_DIR/resources/wlroots-bridge"
        chmod +x "$TREE_DIR/resources/wlroots-bridge"
        log_info "wlroots-bridge built and bundled"
    else
        log_warn "wlroots-bridge build failed — skipping (wlroots Wayland Computer Use will require manual install)"
    fi
else
    log_warn "wlroots-bridge not available — skipping (wlroots Wayland Computer Use will require manual install)"
fi

# Bundle gnome-portal-bridge into resources/ (= process.resourcesPath) for GNOME
# Wayland Computer Use. First-party replacement for ydotool + the portal-python/
# gnome-screenshot/gdbus screenshot cascade. Glibc-dynamic (links libpipewire),
# floor 2.35 (ubuntu:jammy) — NOT usable as-is on NixOS (mirrors kwin-portal-bridge).
GNOME_PORTAL_BRIDGE_REL="target/release/gnome-portal-bridge"
GNOME_PORTAL_BRIDGE_SRC_DIR="$PROJECT_DIR/../computer-use/gnome-portal-bridge"
if [ -n "${GNOME_PORTAL_BRIDGE_BIN:-}" ] && [ -f "${GNOME_PORTAL_BRIDGE_BIN:-}" ]; then
    log_info "Bundling gnome-portal-bridge from $GNOME_PORTAL_BRIDGE_BIN"
    cp "$GNOME_PORTAL_BRIDGE_BIN" "$TREE_DIR/resources/gnome-portal-bridge"
    chmod +x "$TREE_DIR/resources/gnome-portal-bridge"
elif command -v cargo &>/dev/null && [ -d "$GNOME_PORTAL_BRIDGE_SRC_DIR" ]; then
    log_info "Building gnome-portal-bridge from source ($GNOME_PORTAL_BRIDGE_SRC_DIR)..."
    if (cd "$GNOME_PORTAL_BRIDGE_SRC_DIR" && cargo build --release 2>&1 | tail -3); then
        cp "$GNOME_PORTAL_BRIDGE_SRC_DIR/$GNOME_PORTAL_BRIDGE_REL" "$TREE_DIR/resources/gnome-portal-bridge"
        chmod +x "$TREE_DIR/resources/gnome-portal-bridge"
        log_info "gnome-portal-bridge built and bundled"
    else
        log_warn "gnome-portal-bridge build failed — skipping (GNOME Wayland Computer Use will require manual install)"
    fi
else
    log_warn "gnome-portal-bridge not available — skipping (GNOME Wayland Computer Use will require manual install)"
fi

# Validate launcher with shellcheck (catches shebang issues, syntax errors, common bugs)
if command -v shellcheck &>/dev/null; then
    if ! shellcheck -S error "$TARBALL_DIR/launcher/claude-desktop"; then
        log_error "Launcher failed shellcheck — fix scripts/claude-desktop-launcher.sh"
        exit 1
    fi
    log_info "Launcher passed shellcheck"
else
    log_warn "shellcheck not installed — skipping launcher validation"
fi

# Validate .desktop entry from PKGBUILD.template (generated at install time, not shipped).
if command -v desktop-file-validate &>/dev/null; then
    DESKTOP_TMP="$WORK_DIR/claude-desktop.desktop"
    sed -n '/^\[Desktop Entry\]/,/^EOF$/p' "$PROJECT_DIR/PKGBUILD.template" | head -n -1 > "$DESKTOP_TMP"
    DESKTOP_WARNINGS=$(desktop-file-validate "$DESKTOP_TMP" 2>&1 | grep -c "warning:" || true)
    if [ "$DESKTOP_WARNINGS" -gt 0 ]; then
        log_error ".desktop file has validation warnings:"
        desktop-file-validate "$DESKTOP_TMP" 2>&1 | grep "warning:" >&2
        rm -f "$DESKTOP_TMP"
        exit 1
    fi
    rm -f "$DESKTOP_TMP"
    log_info ".desktop file passed validation"
else
    log_warn "desktop-file-validate not installed — skipping .desktop validation"
fi

# Icons: the .deb ships pre-rendered PNGs at every size under
# usr/share/icons/hicolor/. Mirror that tree into icons/hicolor/ so each
# packager installs all of them; a panel asking for 16x16 gets the file made
# for it instead of a downscaled 256x256.
HICOLOR_SRC="$DATA_DIR/usr/share/icons/hicolor"
ICON_DST="$TARBALL_DIR/icons/hicolor/256x256/apps/claude-desktop.png"
ICON_COUNT=0
if [ -d "$HICOLOR_SRC" ]; then
    while IFS= read -r icon_src; do
        icon_dst="$TARBALL_DIR/icons/hicolor/${icon_src#"$HICOLOR_SRC"/}"
        mkdir -p "$(dirname "$icon_dst")"
        cp "$icon_src" "$icon_dst"
        ICON_COUNT=$((ICON_COUNT + 1))
    done < <(find "$HICOLOR_SRC" -type f -name 'claude-desktop.png' | sort)
fi
if [ "$ICON_COUNT" -gt 0 ]; then
    log_info "Bundled $ICON_COUNT icon size(s) from the .deb"
else
    # Fallback: resources/icon.png (large), resized if ImageMagick is present.
    ICON_FALLBACK="$RES_DIR/icon.png"
    mkdir -p "$(dirname "$ICON_DST")"
    if [ -f "$ICON_FALLBACK" ] && command -v magick &>/dev/null; then
        magick "$ICON_FALLBACK" -resize 256x256 "$ICON_DST"
    elif [ -f "$ICON_FALLBACK" ] && command -v convert &>/dev/null; then
        convert "$ICON_FALLBACK" -resize 256x256 "$ICON_DST"
    elif [ -f "$ICON_FALLBACK" ]; then
        cp "$ICON_FALLBACK" "$ICON_DST"
    else
        log_warn "Icon source not found — package will ship without an icon"
    fi
fi

# Upstream license notice: the official .deb ships it at
# usr/share/doc/claude-desktop/copyright. Put it at the tarball root so every
# packager (PKGBUILD, deb, rpm, appimage, nix) can install it as the package's
# license file. Hard requirement — if upstream ever drops it, investigate.
COPYRIGHT_SRC="$DATA_DIR/usr/share/doc/claude-desktop/copyright"
if [ ! -f "$COPYRIGHT_SRC" ]; then
    log_error "Upstream copyright file not found at $COPYRIGHT_SRC — the official .deb layout changed; re-audit"
    exit 1
fi
cp "$COPYRIGHT_SRC" "$TARBALL_DIR/copyright"

# ─────────────────────────────────────────────────────────────────────────────
# Step 5: Optional Electron smoke test (boots the finished tree; Electron
# auto-loads the exe-adjacent resources/app.asar — no argv asar).
# ─────────────────────────────────────────────────────────────────────────────
if [ "${SKIP_SMOKE_TEST:-0}" = "1" ]; then
    log_warn "Skipping smoke test (SKIP_SMOKE_TEST=1)"
elif command -v xvfb-run &>/dev/null; then
    log_info "Running Electron smoke test (bundled Electron)..."
    # chrome-sandbox is not yet SUID root here (packaging sets 4755), so skip
    # that check — the smoke test runs with --no-sandbox.
    if ! SKIP_SANDBOX_CHECK=1 "$SCRIPT_DIR/smoke-test.sh" "$TREE_DIR/claude"; then
        log_error "Smoke test FAILED - the patched app crashes on startup"
        exit 1
    fi
else
    log_warn "Skipping smoke test (install xorg-server-xvfb to enable)"
fi

# Create the tarball. amd64 → no suffix; arm64 → -aarch64 (matches PKGBUILD/Nix/release naming).
case "$DEB_ARCH" in
    arm64)  TARBALL_FILE="$OUTPUT_DIR/claude-desktop-${VERSION}-linux-aarch64.tar.gz" ;;
    amd64)  TARBALL_FILE="$OUTPUT_DIR/claude-desktop-${VERSION}-linux.tar.gz" ;;
    *)      TARBALL_FILE="$OUTPUT_DIR/claude-desktop-${VERSION}-linux-${DEB_ARCH}.tar.gz" ;;
esac
log_info "Creating tarball: $TARBALL_FILE"

# SOURCE_DATE_EPOCH pins every mtime tar records. When unset, derive it from the
# newest file mtime in the upstream tree — Anthropic stamps those into the .deb,
# so it is constant for a given input .deb. Restricted to -type f: tar leaves the
# mtime of the directory it extracts INTO at creation time, so counting
# directories reads back the build clock. The `|| true` keeps a failed pipeline
# from aborting the assignment under `set -e`, so the fallback stays reachable.
if [ -z "${SOURCE_DATE_EPOCH:-}" ]; then
    SOURCE_DATE_EPOCH="$(find "$DATA_DIR" -type f -printf '%T@\n' 2>/dev/null | cut -d. -f1 | sort -n | tail -1 || true)"
    [[ "$SOURCE_DATE_EPOCH" =~ ^[0-9]+$ ]] || SOURCE_DATE_EPOCH=0
fi
export SOURCE_DATE_EPOCH
log_info "SOURCE_DATE_EPOCH: $SOURCE_DATE_EPOCH"

# pigz and gzip emit different byte streams for identical input, so the
# compressor is pinned. CLAUDE_ALLOW_PIGZ=1 trades byte-identical output for
# speed on local builds.
if [ "${CLAUDE_ALLOW_PIGZ:-0}" = "1" ] && command -v pigz &>/dev/null; then
    GZIP_PROG="pigz"
    log_warn "Using pigz (CLAUDE_ALLOW_PIGZ=1) — output is NOT byte-reproducible"
else
    GZIP_PROG="gzip"
fi

# --sort=name fixes entry order, which otherwise follows readdir and varies by
# filesystem. --mtime and the ownership flags strip the build environment.
# gzip -n omits the source filename and timestamp from the gzip header.
TAR_FILE="${TARBALL_FILE%.gz}"
( cd "$TARBALL_DIR" && tar \
    --sort=name \
    --format=gnu \
    --owner=0 --group=0 --numeric-owner \
    --mtime="@$SOURCE_DATE_EPOCH" \
    -cf "$TAR_FILE" claude-desktop/ icons/ launcher/ copyright )

# Hash the uncompressed layer too: when this matches across two builds but the
# .gz does not, the divergence is in the compressor rather than the tree.
TAR_SHA256="$(sha256sum "$TAR_FILE" | cut -d' ' -f1)"

# Compress to a temporary name and rename on success, so a failure never leaves
# a truncated archive at the path every packager reads by glob.
"$GZIP_PROG" -n -9 -c "$TAR_FILE" > "$TARBALL_FILE.partial"
mv "$TARBALL_FILE.partial" "$TARBALL_FILE"
rm -f "$TAR_FILE"

# Calculate SHA256
SHA256=$(sha256sum "$TARBALL_FILE" | cut -d' ' -f1)

# Clean up work directory
rm -rf "$WORK_DIR"

# Output results
echo ""
log_info "Build complete!"
echo "  Version:  $VERSION"
echo "  Arch:     $DEB_ARCH"
echo "  Electron: ${ELECTRON_VERSION:-unknown}"
echo "  Tarball:  $TARBALL_FILE"
echo "  SHA256:   $SHA256"
echo "  TAR SHA:  $TAR_SHA256"
echo "  EPOCH:    $SOURCE_DATE_EPOCH"

# Write metadata file for CI / orchestrators
cat > "$OUTPUT_DIR/build-info.txt" << EOF
VERSION="$VERSION"
TARBALL="$TARBALL_FILE"
SHA256="$SHA256"
TAR_SHA256="$TAR_SHA256"
SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH"
ARCH="$DEB_ARCH"
DEB_VERSION="$VERSION"
ELECTRON_VERSION="${ELECTRON_VERSION:-unknown}"
EOF
