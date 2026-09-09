#!/usr/bin/env bash
# Claude Desktop launcher for Linux
#
# Handles Wayland/X11 detection, Electron flags, GPU fallback, and stale lock cleanup.
# Works across all packaging formats (Arch, RPM, DEB, AppImage, Nix).
#
# Environment variables:
#   CLAUDE_USE_XWAYLAND=1    - Force XWayland instead of native Wayland (escape hatch
#                              for users on Electron <40 that can't update; see below)
#   CLAUDE_MENU_BAR          - Menu bar mode: auto (default), visible, hidden
#   CLAUDE_GPU_BACKEND=angle-gl - Render via ANGLE's GL backend instead of the
#                              native Wayland/GBM path (keeps GPU acceleration;
#                              fixes GPU-process crashes on some drivers, e.g.
#                              Intel xe - try before CLAUDE_DISABLE_GPU)
#   CLAUDE_DISABLE_GPU=1     - Disable GPU compositing (fixes white screen on some systems)
#   CLAUDE_DISABLE_GPU=full  - Disable GPU entirely (more aggressive fallback)
#   CLAUDE_PASSWORD_STORE    - Force --password-store=<value>; 'auto' disables
#                              the launcher's Secret Service detection (issue #191)
#   CLAUDE_ELECTRON          - Override path to Electron binary
#   CLAUDE_APP_ASAR          - Deprecated, ignored (Electron auto-loads the
#                              exe-adjacent resources/app.asar)
#   CLAUDE_DISABLE_SYSTEMD_SCOPE=1
#                            - Skip the systemd --user --scope wrapper (for
#                              sandboxes without access to the systemd private
#                              socket; portal app identity may not resolve)
#   CLAUDE_KEEP_TTY=1        - Do not detach from the controlling terminal even
#                              when launched as a background job on one. Only
#                              affects startx/xinit-style sessions; see the
#                              tty-detach block in the Launch section
#   CLAUDE_NATIVE_TITLEBAR=1 - Restore the native titlebar on Linux
#                              (frame:true + titleBarStyle:"default"). Default
#                              is the integrated titlebar with overlay. Also
#                              via --native-titlebar.
#   CLAUDE_NO_WINDOW_CONTROLS=1
#                            - Frameless window with no window-control buttons
#                              (frame:false + hasShadow:false, no overlay).
#                              Removes the 4 px border Chromium paints around
#                              frameless windows on xfwm4/i3/Awesome. Close or
#                              minimize via your WM (e.g. Alt+F4). Also via
#                              --no-window-controls.

set -euo pipefail

# APP_ID is the bundled Electron binary basename only - cosmetic (argv[0] /
# /proc/self/exe). It is intentionally NOT the .desktop filename (see DESKTOP_ID
# below) and NOT the systemd scope name anymore (the scope now uses DESKTOP_ID so
# xdg-desktop-portal's cgroup→.desktop resolution finds the renamed file; see the
# Launch section).
#
# IMPORTANT: APP_ID is NOT the window's WM_CLASS / Wayland app_id either. That
# value is "com.anthropic.Claude" (verified via xprop/wmctrl) and comes from
# Chromium's GetXdgAppId(), which reads the app's desktopName
# ("com.anthropic.Claude.desktop" in app.asar package.json - upstream's own) and
# ignores the binary basename / --class / argv[0].
APP_ID='claude'

# The .desktop filename is a SEPARATE identity (DESKTOP_ID), computed below once
# the profile is known. The default-profile launcher ships as
# "com.anthropic.Claude.desktop" so the filename equals the window's Wayland
# app_id ("com.anthropic.Claude"). On native Wayland there is no WM_CLASS, so
# GNOME/KDE match the window to its .desktop entry by app_id == .desktop filename;
# a mismatched filename makes the dock/Alt-Tab icon fall back to a generic one
# (issue #148). StartupWMClass (also "com.anthropic.Claude", set in every .desktop
# we write) covers X11/XWayland. So BOTH match keys agree: filename == app_id
# (Wayland) and StartupWMClass == app_id (X11). The reverse-DNS id also lets
# xdg-desktop-portal persist Computer Use grants on KDE. See the DESKTOP_ID
# assignment after profile resolution below.

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
# Defined up here (before any caller) because functions like _appimage_integrate
# run during early startup and call log(); bash resolves a called function's name
# at call time, so a later definition would print "log: command not found" (#142).

LOG_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/claude-desktop"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/launcher.log"
# Only written when we detach from a controlling terminal (see the tty-detach
# block in the Launch section). Terminal launches keep the caller's stdio.
STDIO_LOG="$LOG_DIR/stdout.log"

# Rotate the logs if they grow too large. log() only ever appends (one or
# more lines per launch), so without a cap the file grows unboundedly over
# weeks of use; stdout.log collects the app's own (far chattier) output on
# detached launches. We keep a single rotated backup each (.old). This block
# runs on every startup and must never abort the launcher itself, so every
# step is guarded: a missing file or an odd stat must not stop Claude from
# opening. See issue #132 (the unbounded-growth half; the O(n^2) awk hang it
# also describes belongs to a different project and does not exist here).
_LOG_MAX_BYTES=$((2 * 1024 * 1024))  # 2 MiB
for _lf in "$LOG_FILE" "$STDIO_LOG"; do
    [[ -f $_lf ]] || continue
    _log_size=$(stat -c %s "$_lf" 2>/dev/null || echo 0)
    if [[ $_log_size =~ ^[0-9]+$ ]] && (( _log_size > _LOG_MAX_BYTES )); then
        mv -f "$_lf" "$_lf.old" 2>/dev/null || true
    fi
done

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG_FILE"; }

# ---------------------------------------------------------------------------
# Profile resolution
# ---------------------------------------------------------------------------
# A profile gives an instance its own userData dir (and therefore SingletonLock,
# logins, logs, spaces.json, custom themes), its own cowork + Quick Entry
# sockets, its own Claude Code config dir, and its own systemd scope name.
#
# Resolution order (later wins):
#   1. CLAUDE_PROFILE env var (so child processes inherit)
#   2. Invocation basename matching `claude-desktop-<name>` (symlink-launched)
#   3. --profile=<name> or --profile <name> on argv
#
# The bare name `default` is reserved and means "no suffix; paths unchanged
# from the v1 single-instance layout". Empty is the same as default. Valid
# profile names match [a-zA-Z0-9_-]+.

_invocation_basename="${0##*/}"
if [[ -z "${CLAUDE_PROFILE:-}" && "$_invocation_basename" =~ ^claude-desktop-([a-zA-Z0-9_-]+)$ ]]; then
    CLAUDE_PROFILE="${BASH_REMATCH[1]}"
fi

# Strip launcher-only flags from argv before subcommand dispatch and Electron
# pass-through:
#   --profile=NAME / --profile NAME: sets CLAUDE_PROFILE
#   --no-systemd-scope:              sets CLAUDE_DISABLE_SYSTEMD_SCOPE=1
#   --native-titlebar:               sets CLAUDE_NATIVE_TITLEBAR=1
#   --no-window-controls:            sets CLAUDE_NO_WINDOW_CONTROLS=1
#   --1p / --3p:                     persist deploymentMode before launch
_deployment_mode=""
_filtered_args=()
while (( $# > 0 )); do
    case "$1" in
        --profile=*)
            CLAUDE_PROFILE="${1#--profile=}"
            shift
            ;;
        --profile)
            shift
            if (( $# == 0 )); then
                echo >&2 'claude-desktop: --profile requires an argument'
                exit 2
            fi
            CLAUDE_PROFILE="$1"
            shift
            ;;
        --no-systemd-scope)
            CLAUDE_DISABLE_SYSTEMD_SCOPE=1
            shift
            ;;
        --native-titlebar)
            export CLAUDE_NATIVE_TITLEBAR=1
            shift
            ;;
        --no-window-controls)
            export CLAUDE_NO_WINDOW_CONTROLS=1
            shift
            ;;
        --1p|--3p)
            _deployment_mode="${1#--}"
            shift
            ;;
        --boot-1p-once)
            echo >&2 'claude-desktop: --boot-1p-once was removed upstream (official .deb builds no longer read it).'
            echo >&2 'Use --1p or --3p instead: persists deploymentMode until switched back.'
            exit 2
            ;;
        *)
            _filtered_args+=("$1")
            shift
            ;;
    esac
done
if (( ${#_filtered_args[@]} > 0 )); then
    set -- "${_filtered_args[@]}"
else
    set --
fi

if [[ "${CLAUDE_PROFILE:-}" == "default" ]]; then
    unset CLAUDE_PROFILE
fi
if [[ -n "${CLAUDE_PROFILE:-}" ]]; then
    if ! [[ "$CLAUDE_PROFILE" =~ ^[a-zA-Z0-9_-]+$ ]]; then
        echo >&2 "claude-desktop: invalid profile name '$CLAUDE_PROFILE' (allowed: [a-zA-Z0-9_-])"
        exit 2
    fi
    profile_suffix="-${CLAUDE_PROFILE}"
    export CLAUDE_PROFILE
    # Relocate Claude Code's config dir so a profile's spawned `claude`
    # processes don't share state with the user's other profiles. Honored by
    # the @anthropic-ai/claude-code CLI (settings.json, projects/, sessions,
    # plugins). Inherited by child_process.spawn unless the JS explicitly
    # overrides env. Only set when a profile is active so default behavior
    # is unchanged. See anthropics/claude-code#2986 for known caveats.
    if [[ -z "${CLAUDE_CONFIG_DIR:-}" ]]; then
        export CLAUDE_CONFIG_DIR="$HOME/.claude${profile_suffix}"
    fi
else
    profile_suffix=""
fi

# Per-profile Electron userData (also resolves SingletonLock to the per-profile
# dir, so logins/logs/spaces.json/custom themes are auto-isolated). Must be
# computed early because subcommands like --diagnose reference it before the
# launch flow's SingletonLock cleanup block runs.
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/Claude${profile_suffix}"

# .desktop filename identity (see the DESKTOP_ID note in the APP_ID header).
# Default profile → "com.anthropic.Claude"; named → "com.anthropic.Claude-<name>".
# Distinct from APP_ID (the cosmetic binary/scope basename, still "claude").
DESKTOP_ID="com.anthropic.Claude${profile_suffix}"

# ---------------------------------------------------------------------------
# URL handler profile routing (SSO callback dispatch)
# ---------------------------------------------------------------------------
# When the system XDG handler fires `claude-desktop %u` for a claude:// URL
# (e.g. an SSO auth callback), the default profile would normally consume the
# URL, breaking login flows initiated from a named profile.
#
# The companion patch `fix_profile_url_routing.nim` makes each running profile
# write a marker file at $XDG_RUNTIME_DIR/claude-desktop-pending-auth-<name>
# whenever it opens an auth-ish URL via shell.openExternal. Here we look for
# the most recent fresh marker (<5 min old) and re-exec the launcher under
# that profile, so Electron's second-instance event delivers the URL to the
# right window.
#
# Skipped if a profile is already explicitly set, or if no claude:// URL is
# present in argv. See README.md ("SSO and URL routing" subsection) for
# semantics, limitations, and known failure modes.

if [[ -z "${CLAUDE_PROFILE:-}" ]]; then
    _claude_url=""
    for _a in "$@"; do
        case "$_a" in
            claude://*|claude-desktop://*)
                _claude_url="$_a"
                break
                ;;
        esac
    done
    if [[ -n "$_claude_url" ]]; then
        _runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
        # Most recently modified marker, max 5 min old, name validates as profile.
        _marker=$(find "$_runtime_dir" -maxdepth 1 -type f \
            -name 'claude-desktop-pending-auth-*' -mmin -5 \
            -printf '%T@ %p\n' 2>/dev/null \
            | sort -nr | head -1 | awk '{print $2}')
        if [[ -n "$_marker" && -f "$_marker" ]]; then
            _routed_profile="${_marker##*/claude-desktop-pending-auth-}"
            if [[ "$_routed_profile" =~ ^[a-zA-Z0-9_-]+$ ]]; then
                rm -f "$_marker"
                # The default profile uses the literal string "default" as
                # its marker suffix so its callbacks beat any stale named-
                # profile markers (otherwise an old work-profile marker
                # would hijack the default profile's SSO login). Don't
                # re-exec when the winning marker is the default profile —
                # we're already on it (no --profile flag was passed).
                if [[ "$_routed_profile" != "default" ]]; then
                    # Re-exec under the routed profile. The exec replaces
                    # this process so we don't need any further cleanup.
                    # The receiving profile will see the URL via its
                    # second-instance handler (or as initial argv if it
                    # isn't running yet).
                    exec "$0" "--profile=$_routed_profile" "$@"
                fi
            fi
        fi
    fi
fi

# ---------------------------------------------------------------------------
# Deployment-mode selector (--1p / --3p)
# ---------------------------------------------------------------------------
# The app's bootstrap (index.pre.js) decides 1p vs 3p BEFORE the main window
# exists: it loads /etc/claude-desktop/managed-settings.json if present,
# otherwise the applied local-settings entry in <userData>-3p/configLibrary/,
# and boots 3p (relocating userData to <userData>-3p) when that config carries
# an inference block - unless the persisted key `deploymentMode` in
# <userData>-3p/claude_desktop_config.json equals "1p". The upstream one-shot
# flag --boot-1p-once was removed in the official .deb, so that persisted key
# is the only user-side switch left. --1p/--3p write it before launch.
#
# Notes:
#  - Persistent, not one-shot: plain launches keep the last choice.
#  - Cannot override a managed config with authentication.disableClaudeAiSignIn
#    (enterprise-enforced 3p wins over the "1p" key by design).
#  - Placed after the SSO profile-routing re-exec so a routed launch writes to
#    the final profile's dir. Takes effect on the next full app start - if an
#    instance is already running, quit it first.
if [[ -n "$_deployment_mode" ]]; then
    _mode_dir="${config_dir}-3p"
    _mode_file="${_mode_dir}/claude_desktop_config.json"
    mkdir -p "$_mode_dir"
    if [[ -f "$_mode_file" ]]; then
        if command -v python3 >/dev/null 2>&1; then
            python3 - "$_mode_file" "$_deployment_mode" <<'PY'
import json, sys
path, mode = sys.argv[1], sys.argv[2]
try:
    with open(path) as f:
        data = json.load(f)
except (ValueError, OSError):
    data = {}
if not isinstance(data, dict):
    data = {}
data["deploymentMode"] = mode
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
        else
            echo >&2 "claude-desktop: --${_deployment_mode} needs python3 to edit ${_mode_file} - not found"
            exit 2
        fi
    else
        printf '{\n  "deploymentMode": "%s"\n}\n' "$_deployment_mode" > "$_mode_file"
    fi
    echo "[launcher] deploymentMode=${_deployment_mode} persisted to ${_mode_file}" >&2
fi

# ---------------------------------------------------------------------------
# Path discovery (supports Arch, RPM, DEB, AppImage layouts)
# ---------------------------------------------------------------------------

ELECTRON_BIN="${CLAUDE_ELECTRON:-}"

# The bundled Electron binary is named after APP_ID (cosmetic argv[0] / scope
# hint). NOTE: the binary basename does NOT set the window WM_CLASS - that comes
# from the app's desktopName ("com.anthropic.Claude"); see the APP_ID header
# above and issue #148.
#
# The app itself is NEVER passed on the command line: the official build's
# OnlyLoadAppFromAsar fuse makes Electron load the exe-adjacent
# resources/app.asar and nothing else, so the binary's directory fully
# determines the app (the install trees ship them adjacent, and per-profile
# dirs mirror resources/ as a sibling symlink).
#
# When a profile is active, prefer the user-local copy at
# ~/.local/lib/claude-desktop/<APP_ID>-<profile> created by --create-profile.
# (Intent was a per-profile WM_CLASS via the basename for separate icons/Alt-Tab
# groups; in practice all profiles still report "com.anthropic.Claude" because
# the shared app.asar desktopName wins - distinct per-profile WM_CLASS would need
# a per-profile desktopName/CHROME_DESKTOP override, as in fix_quick_entry_app_id.nim.)
if [[ -z "$ELECTRON_BIN" ]]; then
    candidates=()
    if [[ -n "$profile_suffix" ]]; then
        candidates+=("$HOME/.local/lib/claude-desktop/${APP_ID}${profile_suffix}")
    fi
    candidates+=(
        "/usr/lib/claude-desktop/${APP_ID}"
        # Legacy path: Arch installs before the claude-desktop-extra rename.
        "/usr/lib/claude-desktop-bin/${APP_ID}"
    )
    for candidate in "${candidates[@]}"; do
        if [[ -x "$candidate" ]]; then
            ELECTRON_BIN="$candidate"
            break
        fi
    done
fi

if [[ -z "$ELECTRON_BIN" || ! -x "$ELECTRON_BIN" ]]; then
    echo >&2 'claude-desktop: Claude Desktop Electron binary not found.'
    echo >&2 "Searched: /usr/lib/claude-desktop/${APP_ID}, /usr/lib/claude-desktop-bin/${APP_ID}"
    echo >&2 'Set CLAUDE_ELECTRON=/path/to/claude to override.'
    exit 1
fi

# Informational: the asar Electron will auto-load. The hard existence check
# happens right before exec (after any per-profile refresh has run).
APP_ASAR="$(dirname "$ELECTRON_BIN")/resources/app.asar"

if [[ -n "${CLAUDE_APP_ASAR:-}" && "${CLAUDE_APP_ASAR}" != "$APP_ASAR" ]]; then
    echo >&2 "claude-desktop: CLAUDE_APP_ASAR is deprecated and ignored - Electron auto-loads $APP_ASAR"
    echo >&2 '  (to run a different app.asar, place it in a directory tree next to its own Electron binary and set CLAUDE_ELECTRON)'
fi

# ---------------------------------------------------------------------------
# CLI subcommands: --install-gnome-hotkey / --uninstall-gnome-hotkey / --toggle /
#                  --reload-theme / --diagnose
# ---------------------------------------------------------------------------
# Early-exit subcommands intercepted BEFORE Electron is launched. These do
# not bring up the app - they configure the environment or report diagnostics.
#
# `--toggle` tries the fast socket path first (~5-25 ms). If the socket is
# unavailable (app not running), it falls through to launch Electron with
# --toggle in argv so the patched second-instance / first-instance handler
# can fire the Quick Entry show function.
#
# `--reload-theme` sends the `reload-theme` command over the same socket
# (patches/core/fix_quick_entry_cli_toggle.nim sub-patch D) and prints the
# one-line JSON reply. If the socket is unusable but the app is running, it
# falls through to Electron's second-instance path with --reload-theme in
# argv; if the app is not running at all it exits 1 instead of starting it.
#
# Slot path for the gsettings GNOME custom keybinding. Stable across runs so
# --install/--uninstall can find it.
GNOME_HOTKEY_SLOT='/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/claude-desktop-quick-entry/'
GNOME_HOTKEY_ROOT='org.gnome.settings-daemon.plugins.media-keys'
GNOME_HOTKEY_DEFAULT='<Primary><Alt>space'

# Check that the session looks like GNOME (or at least has gnome-settings-daemon
# handling custom keybindings). Returns 0 if ok, 1 with a stderr message if not.
_require_gnome_gsettings() {
    if ! command -v gsettings &>/dev/null; then
        echo >&2 'claude-desktop: gsettings not found. This command requires GNOME / gnome-settings-daemon.'
        return 1
    fi
    if ! gsettings list-keys "$GNOME_HOTKEY_ROOT" 2>/dev/null | grep -q '^custom-keybindings$'; then
        echo >&2 "claude-desktop: schema '$GNOME_HOTKEY_ROOT' not available. This command requires GNOME."
        return 1
    fi
}

_install_gnome_hotkey() {
    local accel="${1:-$GNOME_HOTKEY_DEFAULT}"
    _require_gnome_gsettings || return 1

    # Python helper: safely parse the Python-list string from `gsettings get`
    # and append our slot if absent. Prints the new value as a Python list.
    local new_array
    if ! new_array=$(
        gsettings get "$GNOME_HOTKEY_ROOT" custom-keybindings \
        | python3 -c "
import ast, sys
raw = sys.stdin.read().strip()
# gsettings prints '@as []' for empty, otherwise a Python-list literal
if raw.startswith('@as '):
    raw = raw[len('@as '):]
try:
    arr = ast.literal_eval(raw)
except (ValueError, SyntaxError):
    print('PARSE_ERROR', file=sys.stderr)
    sys.exit(2)
slot = '$GNOME_HOTKEY_SLOT'
if slot not in arr:
    arr.append(slot)
print(repr(arr))
"
    ); then
        echo >&2 'claude-desktop: failed to parse existing custom-keybindings array'
        return 1
    fi

    gsettings set "$GNOME_HOTKEY_ROOT" custom-keybindings "$new_array"
    # Per-slot schema writes. Use ':' form to scope the schema to our slot.
    gsettings set "${GNOME_HOTKEY_ROOT}.custom-keybinding:${GNOME_HOTKEY_SLOT}" name 'Claude Desktop Quick Entry'
    gsettings set "${GNOME_HOTKEY_ROOT}.custom-keybinding:${GNOME_HOTKEY_SLOT}" command 'claude-desktop --toggle'
    gsettings set "${GNOME_HOTKEY_ROOT}.custom-keybinding:${GNOME_HOTKEY_SLOT}" binding "$accel"

    echo "Installed GNOME hotkey: $accel → claude-desktop --toggle"
    echo "Test it by pressing $accel from any window (Claude does not need to be focused)."
    echo "To change the accelerator later: claude-desktop --install-gnome-hotkey '<Super>space'"
    echo "To remove: claude-desktop --uninstall-gnome-hotkey"
    return 0
}

_uninstall_gnome_hotkey() {
    _require_gnome_gsettings || return 1

    local new_array
    if ! new_array=$(
        gsettings get "$GNOME_HOTKEY_ROOT" custom-keybindings \
        | python3 -c "
import ast, sys
raw = sys.stdin.read().strip()
if raw.startswith('@as '):
    raw = raw[len('@as '):]
try:
    arr = ast.literal_eval(raw)
except (ValueError, SyntaxError):
    print('PARSE_ERROR', file=sys.stderr)
    sys.exit(2)
slot = '$GNOME_HOTKEY_SLOT'
arr = [x for x in arr if x != slot]
print(repr(arr))
"
    ); then
        echo >&2 'claude-desktop: failed to parse existing custom-keybindings array'
        return 1
    fi

    gsettings set "$GNOME_HOTKEY_ROOT" custom-keybindings "$new_array"
    # Reset per-slot schema to drop our name/command/binding.
    gsettings reset-recursively "${GNOME_HOTKEY_ROOT}.custom-keybinding:${GNOME_HOTKEY_SLOT}" 2>/dev/null || true

    echo "Removed GNOME hotkey slot: $GNOME_HOTKEY_SLOT"
    return 0
}

_profile_paths() {
    # Outputs the four files associated with a profile to stdout, one per line.
    # Order: electron-symlink, launcher-symlink, desktop-file, config-dir.
    # The .desktop filename is the app IDENTITY (com.anthropic.Claude-<name>),
    # NOT the launcher-binary/symlink name (claude-desktop-<name>) - those are
    # deliberately different axes (see the APP_ID / DESKTOP_ID header).
    local name="$1"
    echo "$HOME/.local/lib/claude-desktop/${APP_ID}-${name}"
    echo "$HOME/.local/bin/claude-desktop-${name}"
    echo "$HOME/.local/share/applications/com.anthropic.Claude-${name}.desktop"
    echo "${XDG_CONFIG_HOME:-$HOME/.config}/Claude-${name}"
}

# Try to materialise a per-profile Electron binary at $2, taking the cheapest
# option that produces a real (not-symlink) inode at the destination so that
# /proc/self/exe resolves to the per-profile path. Sets the global _link_kind
# to a human-readable label. Returns 0 on success, 1 on failure.
_materialise_profile_binary() {
    local src="$1" dst="$2"
    _link_kind=""
    if ln "$src" "$dst" 2>/dev/null; then
        _link_kind="hardlink (~0 disk used)"
        return 0
    fi
    if cp --reflink=always "$src" "$dst" 2>/dev/null; then
        _link_kind="reflink (CoW, ~0 disk used)"
        return 0
    fi
    if cp "$src" "$dst" 2>/dev/null; then
        _link_kind="copy ($(du -h "$dst" | cut -f1))"
        return 0
    fi
    rm -f "$dst"
    return 1
}

# Refresh the per-profile directory's sibling symlinks. Electron's
# RPATH=$ORIGIN looks for libffmpeg.so etc as siblings of the binary, and
# Chromium reads its .pak / locales / resources / version from the same
# directory. We populate them as symlinks back to the system install. This
# function is idempotent: it (re)creates only links that are missing or
# point at the wrong target, and skips the per-profile binary itself plus
# any other profile binaries that already live there.
_mirror_profile_siblings() {
    local src_dir="$1" dst_dir="$2" orig_bn="$3"
    local entry bn target
    for entry in "$src_dir"/*; do
        [[ -e "$entry" ]] || continue
        bn="$(basename "$entry")"
        [[ "$bn" == "$orig_bn" ]] && continue
        case "$bn" in "${APP_ID}-"*) continue ;; esac
        target="$(readlink "$dst_dir/$bn" 2>/dev/null || true)"
        if [[ "$target" != "$entry" ]]; then
            rm -f "$dst_dir/$bn"
            ln -s "$entry" "$dst_dir/$bn"
        fi
    done
}

# Resolve the canonical (system-installed) Electron binary, ignoring any
# per-profile copy. Mirrors the path-discovery candidate list. Returns the
# first executable hit on stdout, or empty if none found.
# (The claude-desktop-bin path is legacy: Arch installs before the
# claude-desktop-extra rename.)
_canonical_electron_bin() {
    local c
    for c in \
        "/usr/lib/claude-desktop/${APP_ID}" \
        "/usr/lib/claude-desktop-bin/${APP_ID}" \
        "/usr/lib/claude-desktop/electron"; do
        if [[ -x "$c" ]]; then
            echo "$c"
            return 0
        fi
    done
    return 1
}

# At every launch under a named profile, repair the per-profile install if it
# has gone stale. Triggers:
#   - Canonical binary newer than per-profile copy (package upgrade refreshed
#     /usr/lib/claude-desktop/<APP_ID> while ~/.local/lib still points
#     at the old version → version mismatch with app.asar at runtime).
#   - Per-profile binary present but no longer executable (e.g. NixOS rebuild
#     replaced the store path; symlinks pointing into /nix/store dangle).
#   - Any sibling symlink target missing (same Nix scenario, or AppImage
#     mount-point churn).
# When a refresh runs, it leaves a one-line note on stderr so the user can
# correlate post-upgrade hiccups. Failures fall through to whatever the
# next launch attempt sees; no fatal exit.
_refresh_profile_binary_if_stale() {
    [[ -z "$profile_suffix" ]] && return 0
    local profile_bin="$HOME/.local/lib/claude-desktop/${APP_ID}${profile_suffix}"
    [[ -e "$profile_bin" ]] || return 0  # not yet --create-profile'd
    local canonical
    canonical="$(_canonical_electron_bin)" || return 0  # no system install? bail

    local need_refresh=0 reason=""
    if [[ ! -x "$profile_bin" ]]; then
        need_refresh=1; reason="per-profile binary not executable (Nix store moved?)"
    elif [[ "$canonical" -nt "$profile_bin" ]]; then
        need_refresh=1; reason="canonical Electron is newer (package upgrade?)"
    else
        # Walk siblings; if any symlink dangles, full refresh.
        local entry bn target
        for entry in "$(dirname "$profile_bin")"/*; do
            [[ -L "$entry" ]] || continue
            target="$(readlink "$entry" 2>/dev/null)"
            if [[ -z "$target" || ! -e "$target" ]]; then
                need_refresh=1; reason="sibling symlink dangling: $entry"
                break
            fi
        done
    fi

    (( need_refresh )) || return 0
    log "Refreshing stale profile '$CLAUDE_PROFILE': $reason"
    echo >&2 "claude-desktop: refreshing stale per-profile binary ($reason)"

    rm -f "$profile_bin"
    if ! _materialise_profile_binary "$canonical" "$profile_bin"; then
        echo >&2 "claude-desktop: failed to refresh per-profile binary; falling back to canonical for this launch"
        return 1
    fi
    _mirror_profile_siblings "$(dirname "$canonical")" "$(dirname "$profile_bin")" "$(basename "$canonical")"
    log "Refreshed via $_link_kind"
    return 0
}

# ---------------------------------------------------------------------------
# AppImage desktop integration (protocol handler + app menu entry)
# ---------------------------------------------------------------------------
_APPIMAGE_DESKTOP_FILE="$HOME/.local/share/applications/${DESKTOP_ID}.desktop"
_APPIMAGE_ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"

_appimage_integrate() {
    local appimage_path="${CLAUDE_APPIMAGE_PATH:-}"
    local quiet="${1:-}"

    if [[ -z "$appimage_path" ]]; then
        if [[ "$quiet" != "quiet" ]]; then
            echo >&2 "claude-desktop: not running as AppImage (CLAUDE_APPIMAGE_PATH unset)."
            echo >&2 "  This command is only needed for AppImage installs."
        fi
        return 1
    fi

    if [[ ! -f "$appimage_path" ]]; then
        log "AppImage integrate: path does not exist: $appimage_path"
        if [[ "$quiet" != "quiet" ]]; then
            echo >&2 "claude-desktop: AppImage not found at $appimage_path"
        fi
        return 1
    fi

    if [[ -f "/usr/share/applications/${DESKTOP_ID}.desktop" ]]; then
        log "AppImage integrate: system .desktop exists - skipping"
        if [[ "$quiet" != "quiet" ]]; then
            echo "System package already provides ${DESKTOP_ID}.desktop - AppImage integration skipped."
            echo "(The system package's protocol handler takes priority.)"
        fi
        return 0
    fi

    local desired_exec="Exec=${appimage_path} %u"

    if [[ -f "$_APPIMAGE_DESKTOP_FILE" ]]; then
        local current_exec
        current_exec=$(grep '^Exec=' "$_APPIMAGE_DESKTOP_FILE" 2>/dev/null | head -1)
        if [[ "$current_exec" == "$desired_exec" ]]; then
            log "AppImage integrate: .desktop up to date ($appimage_path)"
            if [[ "$quiet" != "quiet" ]]; then
                echo "Desktop integration already up to date."
                echo "  File: $_APPIMAGE_DESKTOP_FILE"
                echo "  Exec: $appimage_path %u"
            fi
            return 0
        fi
        log "AppImage integrate: updating .desktop (path changed)"
    fi

    mkdir -p "$(dirname "$_APPIMAGE_DESKTOP_FILE")"

    # Content aligned to the official .deb's .desktop (issue #148), adapted for
    # AppImage: Exec= and the Action Exec lines point at the AppImage path
    # instead of /usr/bin/claude-desktop. We keep %u (not the official %U) on the
    # main Exec= so it matches $desired_exec in the up-to-date check above;
    # the launcher handles a single claude:// URL either way.
    cat > "$_APPIMAGE_DESKTOP_FILE" <<DESKTOP_EOF
[Desktop Entry]
Name=Claude
Comment=Desktop application for Claude.ai
GenericName=AI Assistant
Keywords=AI;Chat;Assistant;Claude;Code;LLM;
${desired_exec}
Icon=claude-desktop
Type=Application
StartupNotify=true
StartupWMClass=com.anthropic.Claude
SingleMainWindow=true
Categories=Utility;Development;
MimeType=x-scheme-handler/claude;
Actions=NewChat;NewCode;

[Desktop Action NewChat]
Name=New chat
Exec=${appimage_path} claude://claude.ai/new

[Desktop Action NewCode]
Name=New Claude Code session
Exec=${appimage_path} claude://code/new
DESKTOP_EOF

    local appimage_icon=""
    local here="${CLAUDE_ELECTRON%/*}"
    if [[ -n "$here" ]]; then
        local appdir="${here}/../../.."
        if [[ -f "$appdir/claude-desktop.png" ]]; then
            appimage_icon="$appdir/claude-desktop.png"
        elif [[ -f "$appdir/usr/share/icons/hicolor/256x256/apps/claude-desktop.png" ]]; then
            appimage_icon="$appdir/usr/share/icons/hicolor/256x256/apps/claude-desktop.png"
        fi
    fi
    if [[ -n "$appimage_icon" && -f "$appimage_icon" ]]; then
        mkdir -p "$_APPIMAGE_ICON_DIR"
        cp "$appimage_icon" "$_APPIMAGE_ICON_DIR/claude-desktop.png" 2>/dev/null || true
    fi

    if command -v update-desktop-database &>/dev/null; then
        update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
    fi

    if command -v xdg-mime &>/dev/null; then
        xdg-mime default "${DESKTOP_ID}.desktop" x-scheme-handler/claude 2>/dev/null || true
    fi

    log "AppImage integrate: registered ${_APPIMAGE_DESKTOP_FILE} -> ${appimage_path}"
    if [[ "$quiet" != "quiet" ]]; then
        echo "Desktop integration installed."
        echo "  File: $_APPIMAGE_DESKTOP_FILE"
        echo "  Exec: $appimage_path %u"
        echo "  Protocol: claude:// -> Claude Desktop (AppImage)"
        echo
        echo "The claude:// protocol handler is now active."
        echo "To remove: claude-desktop --unintegrate"
    fi
    return 0
}

_appimage_unintegrate() {
    local removed=0

    if [[ -f "$_APPIMAGE_DESKTOP_FILE" ]]; then
        local exec_line
        exec_line=$(grep '^Exec=' "$_APPIMAGE_DESKTOP_FILE" 2>/dev/null | head -1)
        if [[ "$exec_line" == *".AppImage"* ]]; then
            rm -f "$_APPIMAGE_DESKTOP_FILE"
            echo "Removed: $_APPIMAGE_DESKTOP_FILE"
            removed=$((removed + 1))
        else
            echo >&2 "claude-desktop: $_APPIMAGE_DESKTOP_FILE does not point to an AppImage - not removing."
            echo >&2 "  Current Exec=: $exec_line"
            return 1
        fi
    fi

    local icon_file="$_APPIMAGE_ICON_DIR/claude-desktop.png"
    if [[ -f "$icon_file" ]]; then
        rm -f "$icon_file"
        echo "Removed: $icon_file"
        removed=$((removed + 1))
    fi

    if (( removed == 0 )); then
        echo "No AppImage integration found to remove."
        return 0
    fi

    if command -v update-desktop-database &>/dev/null; then
        update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
    fi

    echo "Desktop integration removed."
    return 0
}

_create_profile() {
    local name="$1"
    if [[ -z "$name" || "$name" == "default" ]]; then
        echo >&2 "claude-desktop: profile name must be non-empty and not 'default'"
        return 2
    fi
    if ! [[ "$name" =~ ^[a-zA-Z0-9_-]+$ ]]; then
        echo >&2 "claude-desktop: invalid profile name '$name' (allowed: [a-zA-Z0-9_-])"
        return 2
    fi

    local launcher_path
    launcher_path="$(readlink -f "$0" 2>/dev/null || echo "$0")"
    if [[ ! -x "$launcher_path" ]]; then
        echo >&2 "claude-desktop: cannot resolve launcher path ($0)"
        return 1
    fi
    if [[ "$ELECTRON_BIN" == "electron" || ! -x "$ELECTRON_BIN" ]]; then
        echo >&2 "claude-desktop: cannot resolve bundled Electron binary; --create-profile requires an installed package"
        return 1
    fi

    local electron_bin_path="$HOME/.local/lib/claude-desktop/${APP_ID}-${name}"
    local launcher_link="$HOME/.local/bin/claude-desktop-${name}"
    local desktop_file="$HOME/.local/share/applications/com.anthropic.Claude-${name}.desktop"

    if [[ -e "$electron_bin_path" || -e "$launcher_link" || -e "$desktop_file" ]]; then
        echo >&2 "claude-desktop: profile '$name' already exists. Use --delete-profile=$name first to recreate."
        return 1
    fi

    mkdir -p "$(dirname "$electron_bin_path")" "$(dirname "$launcher_link")" "$(dirname "$desktop_file")"

    # The per-profile Electron binary is a real file (not a symlink) so
    # /proc/self/exe resolves to the per-profile path (distinct argv[0] / scope).
    # This mirrors how Chrome does multi-channel (google-chrome-stable /
    # google-chrome-beta are real copies). NOTE: this alone does NOT give each
    # profile a distinct WM_CLASS - Chromium's app_id comes from the shared
    # app.asar desktopName ("com.anthropic.Claude"), not the binary basename, so the
    # WM still groups all profiles as one app. See issue #148 / the discovery
    # comment above for the per-profile-desktopName follow-up.
    #
    # Strategy: hardlink first (zero-cost, same fs only), reflink second
    # (zero-cost on btrfs/xfs), copy fallback (typically ~200 MB per profile).
    if ! _materialise_profile_binary "$ELECTRON_BIN" "$electron_bin_path"; then
        echo >&2 "claude-desktop: failed to materialise per-profile binary at $electron_bin_path"
        return 1
    fi
    local link_kind="$_link_kind"

    # Mirror the other files in the Electron install dir back as symlinks so
    # the per-profile binary can find its sibling shared libraries
    # (RPATH=$ORIGIN looks for libffmpeg.so etc.) and Chromium can
    # find its data files (.pak, locales/, resources/, version, icudtl.dat).
    # Profile-agnostic: shared across all profiles in the lib dir.
    _mirror_profile_siblings \
        "$(dirname "$ELECTRON_BIN")" \
        "$(dirname "$electron_bin_path")" \
        "$(basename "$ELECTRON_BIN")"

    ln -s "$launcher_path" "$launcher_link"

    # Try to find the default-profile system .desktop to inherit Icon=, etc.
    # The installed default file is "com.anthropic.Claude.desktop" (upstream's
    # own identity), not "${APP_ID}.desktop" - APP_ID is only the binary/scope
    # basename. The legacy "claude-desktop.desktop" name is also probed so a
    # profile created on a not-yet-upgraded install still finds a source.
    local source_desktop=""
    for c in \
        "/usr/share/applications/com.anthropic.Claude.desktop" \
        "$HOME/.local/share/applications/com.anthropic.Claude.desktop" \
        "/usr/share/applications/claude-desktop.desktop" \
        "$HOME/.local/share/applications/claude-desktop.desktop"; do
        if [[ -f "$c" ]]; then
            source_desktop="$c"
            break
        fi
    done

    # Use an absolute Exec= path so the entry works without ~/.local/bin in
    # PATH and so GNOME Shell's Overview accepts it. Pass --profile=NAME
    # directly to the system launcher rather than relying on the per-profile
    # symlink basename, since the symlink isn't on PATH for GNOME Shell.
    local exec_line="Exec=${launcher_path} --profile=${name} %u"

    if [[ -n "$source_desktop" ]]; then
        # Rewrite Name and Exec; drop MimeType= so the claude:// scheme remains
        # owned by the system .desktop. The launcher routes incoming URLs to the
        # right profile via the auth marker; if named profiles also claimed the
        # scheme, xdg-mime ordering would short-circuit our routing for whichever
        # entry got picked first. Also strip the Actions= key and every [Desktop
        # Action ...] block: their Exec= lines hardcode the default `claude-desktop`
        # binary, so a named profile's right-click "New chat" would open in the
        # default profile. Simpler to drop them than to rewrite each per-action Exec.
        #
        # StartupWMClass is left as the inherited "com.anthropic.Claude" on
        # purpose: the window's live app_id is "com.anthropic.Claude" for every
        # profile (the shared app.asar desktopName wins), so a per-profile
        # WMClass would never match the window. A distinct per-profile app_id
        # needs a per-profile desktopName override (out of scope for #148).
        awk -v name="$name" -v execline="$exec_line" '
            BEGIN { FS=OFS="="; drop=0 }
            /^\[Desktop Action / { drop=1; next }   # drop the whole action block
            /^\[Desktop Entry\]/ { drop=0 }
            drop { next }
            /^Name=/     { print "Name=Claude (" name ")"; next }
            /^Exec=/     { print execline; next }
            /^MimeType=/ { next }
            /^Actions=/  { next }
            { print }
        ' "$source_desktop" > "$desktop_file"
    else
        cat > "$desktop_file" <<EOF
[Desktop Entry]
Name=Claude ($name)
${exec_line}
Terminal=false
Type=Application
Icon=claude-desktop
StartupWMClass=com.anthropic.Claude
Categories=Utility;Development;
EOF
    fi

    if command -v update-desktop-database &>/dev/null; then
        update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
    fi

    echo "Created profile '$name'."
    echo "  Electron binary:  $electron_bin_path  ($link_kind)"
    echo "  Launcher symlink: $launcher_link"
    echo "  Desktop file:     $desktop_file"
    echo
    echo "Launch from your application menu (entry: 'Claude ($name)'),"
    echo "or run:    $launcher_path --profile=$name"
    if [[ ":$PATH:" == *":$HOME/.local/bin:"* ]]; then
        echo "or:        claude-desktop-$name"
    fi
    return 0
}

_delete_profile() {
    local name="$1"
    if [[ -z "$name" || "$name" == "default" ]]; then
        echo >&2 "claude-desktop: cannot delete default; profile name required"
        return 2
    fi
    if ! [[ "$name" =~ ^[a-zA-Z0-9_-]+$ ]]; then
        echo >&2 "claude-desktop: invalid profile name '$name'"
        return 2
    fi

    local electron_link="$HOME/.local/lib/claude-desktop/${APP_ID}-${name}"
    local launcher_link="$HOME/.local/bin/claude-desktop-${name}"
    local desktop_file="$HOME/.local/share/applications/com.anthropic.Claude-${name}.desktop"
    # Legacy per-profile .desktop name from before the app-identity alignment;
    # removed too so profiles created by an older launcher clean up fully.
    local legacy_desktop_file="$HOME/.local/share/applications/claude-desktop-${name}.desktop"

    local removed=0
    for f in "$electron_link" "$launcher_link" "$desktop_file" "$legacy_desktop_file"; do
        if [[ -L "$f" || -f "$f" ]]; then
            rm -f "$f"
            echo "Removed: $f"
            # NOTE: do NOT use ((removed++)) here -- post-increment returns
            # the OLD value, which is 0 on the first hit. Under `set -e` that
            # makes the whole script exit (treating 0 as a failed command),
            # so only the first artifact would ever get removed per call.
            # Use arithmetic assignment to always return non-zero exit status.
            removed=$((removed + 1))
        fi
    done

    if (( removed == 0 )); then
        echo >&2 "claude-desktop: profile '$name' has no installed entry points (nothing to remove)"
    fi

    if command -v update-desktop-database &>/dev/null; then
        update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
    fi

    echo
    echo "User data preserved at: ${XDG_CONFIG_HOME:-$HOME/.config}/Claude-${name}"
    echo "Code config preserved at: $HOME/.claude-${name}"
    echo "Remove those manually if you also want to delete login state and history."
    return 0
}

_list_profiles() {
    local lib_dir="$HOME/.local/lib/claude-desktop"
    echo "default  (config: ${XDG_CONFIG_HOME:-$HOME/.config}/Claude)"
    if [[ ! -d "$lib_dir" ]]; then
        return 0
    fi
    local prefix="${APP_ID}-"
    local found=0
    for link in "$lib_dir"/${prefix}*; do
        [[ -L "$link" || -f "$link" ]] || continue
        local base="${link##*/}"
        local name="${base#$prefix}"
        # Skip stray entries that don't match our naming
        [[ "$name" =~ ^[a-zA-Z0-9_-]+$ ]] || continue
        echo "$name  (config: ${XDG_CONFIG_HOME:-$HOME/.config}/Claude-${name})"
        found=1
    done
    if (( found == 0 )); then
        echo "(no named profiles installed; create one with --create-profile=NAME)"
    fi
}

_diagnose() {
    echo '=== claude-desktop --diagnose ==='
    echo
    echo '--- Session ---'
    echo "XDG_SESSION_TYPE = ${XDG_SESSION_TYPE:-(unset)}"
    echo "XDG_CURRENT_DESKTOP = ${XDG_CURRENT_DESKTOP:-(unset)}"
    # XDG_SESSION_DESKTOP is DM-dependent (SDDM/GDM may set plasma / an absolute
    # path / nothing) and is NOT what our CU DE-detection keys off — we use
    # XDG_CURRENT_DESKTOP. Surfaced here so a mismatch between the two is visible
    # when triaging KDE-Wayland routing reports (issue #194).
    echo "XDG_SESSION_DESKTOP = ${XDG_SESSION_DESKTOP:-(unset)}"
    # The mode is resolved from env/flag OR the extra config before the launch
    # flow reaches here, so ${_titlebar_source} / ${_no_controls_source} name
    # where it actually came from.
    if [[ "${CLAUDE_NATIVE_TITLEBAR:-}" == '1' ]]; then
        echo "Titlebar = native (${_titlebar_source:-CLAUDE_NATIVE_TITLEBAR=1})"
    elif [[ "${CLAUDE_NO_WINDOW_CONTROLS:-}" == '1' ]]; then
        echo "Titlebar = frameless, no window controls (${_no_controls_source:-CLAUDE_NO_WINDOW_CONTROLS=1})"
    else
        echo "Titlebar = integrated (default)"
    fi
    echo "WAYLAND_DISPLAY = ${WAYLAND_DISPLAY:-(unset)}"
    echo "DISPLAY = ${DISPLAY:-(unset)}"
    echo
    echo '--- Binaries ---'
    echo "ELECTRON_BIN = $ELECTRON_BIN"
    # Don't run the binary — it IS the Claude app and launching it spawns
    # a new instance. Read the bundled version file instead.
    if [[ -n ${_electron_real:-} ]]; then
        local _vfile="$(dirname "$_electron_real")/version"
        if [[ -r $_vfile ]]; then
            echo "electron version file = $(<"$_vfile")"
        else
            echo "electron version file = (missing at $_vfile; parsed major=$electron_major)"
        fi
    fi
    echo "systemd-run = $(command -v systemd-run || echo '(missing)')"
    if [[ -n "${XDG_RUNTIME_DIR:-}" && -S "${XDG_RUNTIME_DIR}/systemd/private" ]]; then
        echo "systemd user socket = ${XDG_RUNTIME_DIR}/systemd/private (present)"
    else
        echo "systemd user socket = (missing or unreachable; scope wrap will be skipped)"
    fi
    echo "gsettings = $(command -v gsettings || echo '(missing)')"
    echo "gdbus = $(command -v gdbus || echo '(missing)')"
    echo
    echo '--- App identity ---'
    echo "APP_ID = $APP_ID"
    echo "CLAUDE_PROFILE = ${CLAUDE_PROFILE:-(unset → default)}"
    echo "config_dir = $config_dir"
    echo "DESKTOP_ID = $DESKTOP_ID"
    # The system-installed default .desktop is the portal-identity anchor that
    # the systemd scope (app-com.anthropic.Claude-...scope) resolves back to. It
    # is the default "com.anthropic.Claude.desktop"; named-profile .desktop files
    # live user-local under ~/.local/share/applications/com.anthropic.Claude-<name>.desktop.
    local desktop_file="/usr/share/applications/com.anthropic.Claude.desktop"
    [[ -f $desktop_file ]] || desktop_file="/usr/share/applications/claude-desktop.desktop"
    if [[ -f $desktop_file ]]; then
        echo ".desktop file: $desktop_file (found)"
    else
        echo ".desktop file: $desktop_file (MISSING - portal identity will fail)"
    fi
    if [[ -n "${CLAUDE_APPIMAGE_PATH:-}" ]]; then
        echo "CLAUDE_APPIMAGE_PATH = $CLAUDE_APPIMAGE_PATH"
        if [[ -f "$_APPIMAGE_DESKTOP_FILE" ]]; then
            local _ai_exec
            _ai_exec=$(grep '^Exec=' "$_APPIMAGE_DESKTOP_FILE" 2>/dev/null | head -1)
            echo "AppImage .desktop: $_APPIMAGE_DESKTOP_FILE (found)"
            echo "  Exec = $_ai_exec"
            if [[ "$_ai_exec" == *"$CLAUDE_APPIMAGE_PATH"* ]]; then
                echo "  Status: UP TO DATE"
            else
                echo "  Status: STALE (path mismatch)"
            fi
        else
            echo "AppImage .desktop: $_APPIMAGE_DESKTOP_FILE (MISSING - run --integrate)"
        fi
        if command -v xdg-mime &>/dev/null; then
            local _handler
            _handler=$(xdg-mime query default x-scheme-handler/claude 2>/dev/null || echo '(not set)')
            echo "claude:// handler = $_handler"
        fi
    else
        echo "CLAUDE_APPIMAGE_PATH = (unset - not an AppImage)"
    fi
    echo "APP_ASAR = $APP_ASAR"
    echo
    echo '--- xdg-desktop-portal GlobalShortcuts ---'
    if command -v gdbus &>/dev/null; then
        local portal_ver
        portal_ver=$(gdbus call --session --dest org.freedesktop.portal.Desktop \
            --object-path /org/freedesktop/portal/desktop \
            --method org.freedesktop.DBus.Properties.Get \
            org.freedesktop.portal.GlobalShortcuts version 2>&1 || echo '(failed)')
        echo "Portal version = $portal_ver"
    else
        echo '(gdbus not installed — cannot probe portal)'
    fi
    if command -v gsettings &>/dev/null; then
        echo
        echo '--- Registered portal shortcut apps (GNOME) ---'
        local apps
        apps=$(gsettings get org.gnome.settings-daemon.global-shortcuts applications 2>/dev/null || echo '(schema missing)')
        echo "org.gnome.settings-daemon.global-shortcuts applications = $apps"
        if [[ $apps == '@as []' ]]; then
            echo '(no app has completed the portal BindShortcuts+approval flow; expected on a fresh install)'
        fi
        echo
        echo '--- GNOME custom-keybinding slot ---'
        local cks
        cks=$(gsettings get "$GNOME_HOTKEY_ROOT" custom-keybindings 2>/dev/null || echo '(schema missing)')
        echo "custom-keybindings = $cks"
        if [[ $cks == *"$GNOME_HOTKEY_SLOT"* ]]; then
            echo 'claude-desktop hotkey slot: INSTALLED'
            echo "  name    = $(gsettings get "${GNOME_HOTKEY_ROOT}.custom-keybinding:${GNOME_HOTKEY_SLOT}" name 2>&1)"
            echo "  command = $(gsettings get "${GNOME_HOTKEY_ROOT}.custom-keybinding:${GNOME_HOTKEY_SLOT}" command 2>&1)"
            echo "  binding = $(gsettings get "${GNOME_HOTKEY_ROOT}.custom-keybinding:${GNOME_HOTKEY_SLOT}" binding 2>&1)"
        else
            echo 'claude-desktop hotkey slot: NOT INSTALLED'
            echo '(run: claude-desktop --install-gnome-hotkey)'
        fi
    fi
    echo
    echo '--- Computer Use ---'
    # The package version pins every bundled bit (bridges, Electron, app.asar).
    local _cu_pkg _cu_res _cu_b _cu_sum=''
    # New package name first; claude-desktop-bin covers pre-rename installs.
    _cu_pkg="$(pacman -Q claude-desktop-extra 2>/dev/null \
        || pacman -Q claude-desktop-bin 2>/dev/null \
        || dpkg-query -W -f='claude-desktop-extra ${Version}\n' claude-desktop-extra 2>/dev/null \
        || dpkg-query -W -f='claude-desktop-bin ${Version}\n' claude-desktop-bin 2>/dev/null \
        || rpm -q claude-desktop-extra 2>/dev/null \
        || rpm -q claude-desktop-bin 2>/dev/null \
        || echo '(no system package: AppImage/Nix/manual)')"
    echo "package = $_cu_pkg"
    _cu_res="$(dirname "$ELECTRON_BIN")/resources"
    for _cu_b in x11-bridge wlroots-bridge gnome-portal-bridge kwin-portal-bridge; do
        if [[ -x "$_cu_res/$_cu_b" ]]; then _cu_sum+=" $_cu_b"; else _cu_sum+=" $_cu_b(MISSING)"; fi
    done
    echo "bundled bridges =$_cu_sum"
    if [[ "$(printf %s "${XDG_CURRENT_DESKTOP:-}" | tr '[:upper:]' '[:lower:]')" == *kde* ]] \
        && [[ "${XDG_SESSION_TYPE:-}" == 'wayland' || -n "${WAYLAND_DISPLAY:-}" ]]; then
        local _kv _kmaj _kmin
        _kv="$(timeout 2 kwin_wayland --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1 || true)"
        if [[ -n "$_kv" ]]; then
            _kmaj="${_kv%%.*}"; _kmin="${_kv#*.}"; _kmin="${_kmin%%.*}"
            if (( _kmaj > 6 || (_kmaj == 6 && _kmin >= 6) )); then
                echo "KWin = $_kv (>= 6.6: native kwin-portal-bridge route)"
            else
                echo "KWin = $_kv (< 6.6: ydotool/spectacle fallback - update Plasma for the native route)"
            fi
        else
            echo 'KWin = (version probe failed)'
        fi
        # End-to-end KWin-scripting self-test: portal-free, never pops a
        # consent dialog; window titles are not printed (only a byte count).
        if [[ -x "$_cu_res/kwin-portal-bridge" ]]; then
            local _st_out _st_rc=0
            _st_out="$(timeout 10 "$_cu_res/kwin-portal-bridge" windows 2>&1)" || _st_rc=$?
            if [[ "$_st_rc" == 0 ]]; then
                echo "kwin-portal-bridge windows = ok (${#_st_out} bytes)"
            else
                echo "kwin-portal-bridge windows = FAILED (exit $_st_rc)"
                printf '%s\n' "$_st_out" | head -3 | sed 's/^/  /'
            fi
        fi
    fi
    if [[ "$(printf %s "${XDG_CURRENT_DESKTOP:-}" | tr '[:upper:]' '[:lower:]')" == *gnome* ]] \
        && [[ "${XDG_SESSION_TYPE:-}" == 'wayland' || -n "${WAYLAND_DISPLAY:-}" ]]; then
        echo "GNOME Shell = $(timeout 2 gnome-shell --version 2>/dev/null || echo '(probe failed)')"
        echo "PipeWire = $(timeout 2 pipewire --version 2>/dev/null | head -1 || echo '(probe failed)')"
        # Portal-free monitor enumeration: the same `screens` call the screenshot
        # path makes before every capture, and the first thing to hang when the
        # bridge cannot talk to Mutter (issue #232). Never pops a consent dialog.
        # session-start is deliberately NOT probed here - it would.
        if [[ -x "$_cu_res/gnome-portal-bridge" ]]; then
            local _gs_out _gs_rc=0 _gs_t0 _gs_ms
            _gs_t0=$(date +%s%3N)
            _gs_out="$(timeout 10 "$_cu_res/gnome-portal-bridge" screens 2>&1)" || _gs_rc=$?
            _gs_ms=$(( $(date +%s%3N) - _gs_t0 ))
            if [[ "$_gs_rc" == 0 ]]; then
                echo "gnome-portal-bridge screens = ok (${#_gs_out} bytes, ${_gs_ms}ms)"
                printf '%s\n' "$_gs_out" | head -5 | sed 's/^/  /'
            else
                echo "gnome-portal-bridge screens = FAILED (exit $_gs_rc after ${_gs_ms}ms)"
                printf '%s\n' "$_gs_out" | head -5 | sed 's/^/  /'
                echo '  (exit 124 = timed out. Computer Use capture cannot work until this succeeds.)'
            fi
        fi
    fi
    echo
    echo '--- Cowork VM capability (replicates the app probe) ---'
    # Mirrors the native Cowork backend's capability probe. If any of qemuPath /
    # firmwarePath / virtiofsdPath / kvm is missing, the app reports "VM not
    # supported" and the workspace Download does nothing. The resource base is
    # the exe-adjacent resources/ dir (= process.resourcesPath at runtime).
    local _res_base
    _res_base="$(dirname "$ELECTRON_BIN")/resources"
    local _arch _qemu_bin
    case "$(uname -m)" in
        aarch64|arm64) _arch=arm64; _qemu_bin=qemu-system-aarch64 ;;
        *)             _arch=x64;   _qemu_bin=qemu-system-x86_64 ;;
    esac
    echo "PATH (as diagnose sees it) = ${PATH:-(empty!)}"
    # qemuPath: first on PATH that is executable
    local _qemu_path=''
    if command -v "$_qemu_bin" &>/dev/null; then _qemu_path="$(command -v "$_qemu_bin")"; fi
    echo "qemuPath = ${_qemu_path:-NOT FOUND on PATH ($_qemu_bin)}"
    # firmwarePath: first readable OVMF/AAVMF CODE candidate (must match the
    # app's patched firmware array: CLAUDE_OVMF_CODE_PATH override first, then
    # the fixed paths - see fix_cowork_firmware_paths_linux.nim)
    local _fw='' _c
    local _fw_candidates=()
    [[ -n ${CLAUDE_OVMF_CODE_PATH:-} ]] && _fw_candidates+=("$CLAUDE_OVMF_CODE_PATH")
    if [[ $_arch == arm64 ]]; then
        _fw_candidates+=(/usr/share/AAVMF/AAVMF_CODE.fd)
    else
        _fw_candidates+=(/usr/share/edk2/ovmf/OVMF_CODE.fd /usr/share/edk2/x64/OVMF_CODE.4m.fd /usr/share/edk2/x64/OVMF_CODE.fd /usr/share/OVMF/OVMF_CODE_4M.fd /usr/share/OVMF/OVMF_CODE.fd)
    fi
    for _c in "${_fw_candidates[@]}"; do
        if [[ -r $_c ]]; then _fw="$_c"; break; fi
    done
    echo "firmwarePath = ${_fw:-NOT FOUND (install edk2-ovmf / ovmf, or set CLAUDE_OVMF_CODE_PATH)}"
    if [[ -n $_fw ]]; then
        local _vars="${_fw/OVMF_CODE/OVMF_VARS}"; _vars="${_vars/AAVMF_CODE/AAVMF_VARS}"
        echo "  -> derived VARS = $_vars ($([[ -r $_vars ]] && echo present || echo MISSING))"
    fi
    # virtiofsdPath: CLAUDE_VIRTIOFSD_PATH override first, then system paths
    # (incl. NixOS /run/current-system/sw/bin - PR #178). The bundled copy under
    # resources/ counts ONLY on Ubuntu 22.x - the app gates its bundled
    # fallback on os-release id=ubuntu && version 22.* (jammy's apt has no
    # standalone virtiofsd package; the bundled candidate is probed with X_OK).
    # Listing it unconditionally here made --diagnose report "SHOULD pass" on
    # systems where the real probe returns virtiofsdPath=null (issue #177, NixOS).
    local _vfs=''
    local _vfs_candidates=()
    [[ -n ${CLAUDE_VIRTIOFSD_PATH:-} ]] && _vfs_candidates+=("$CLAUDE_VIRTIOFSD_PATH")
    _vfs_candidates+=(/usr/libexec/virtiofsd /usr/lib/virtiofsd /usr/lib/qemu/virtiofsd /run/current-system/sw/bin/virtiofsd /usr/bin/virtiofsd)
    for _c in "${_vfs_candidates[@]}"; do
        if [[ -r $_c ]]; then _vfs="$_c"; break; fi
    done
    local _is_ubuntu22=''
    [[ "$( { . /etc/os-release 2>/dev/null || . /usr/lib/os-release 2>/dev/null; } && echo "${ID:-} ${VERSION_ID:-}")" == 'ubuntu 22.'* ]] && _is_ubuntu22=1
    if [[ -z $_vfs && -n $_is_ubuntu22 && -x "$_res_base/virtiofsd" ]]; then
        _vfs="$_res_base/virtiofsd"
    fi
    echo "virtiofsdPath = ${_vfs:-NOT FOUND (install a system virtiofsd or set CLAUDE_VIRTIOFSD_PATH; the bundled copy only counts on Ubuntu 22.x)}"
    if [[ -z $_vfs && -r "$_res_base/virtiofsd" ]]; then
        echo "  (bundled $_res_base/virtiofsd exists but is IGNORED by the app - only used as a fallback on Ubuntu 22.x)"
    fi
    # helper + smol image (upstream resources/ layout)
    echo "helperBinaryPath = $([[ -x $_res_base/cowork-linux-helper ]] && echo "$_res_base/cowork-linux-helper" || echo MISSING)"
    echo "smolBinPath = $([[ -r $_res_base/smol-bin.$_arch.img ]] && echo "$_res_base/smol-bin.$_arch.img" || echo MISSING)"
    # kvm + vsock (app checks R_OK|W_OK)
    echo "/dev/kvm = $([[ -r /dev/kvm && -w /dev/kvm ]] && echo ok || { [[ -e /dev/kvm ]] && echo 'NO PERMISSION (add user to kvm group + relogin)' || echo 'MISSING (enable virtualization in BIOS)'; })"
    echo "/dev/vhost-vsock = $([[ -r /dev/vhost-vsock && -w /dev/vhost-vsock ]] && echo ok || { [[ -e /dev/vhost-vsock ]] && echo 'NO PERMISSION' || echo 'MISSING (sudo modprobe vhost_vsock)'; })"
    if [[ -n $_qemu_path && -n $_fw && -n $_vfs && -r /dev/kvm && -w /dev/kvm && -r /dev/vhost-vsock && -w /dev/vhost-vsock ]]; then
        echo "=> capability probe SHOULD pass (Cowork supported)"
    else
        echo "=> capability probe WOULD FAIL - fix the NOT-FOUND/MISSING item(s) above"
    fi
    echo
    echo '--- Recent launcher log (last 10 lines) ---'
    local logf="${XDG_CACHE_HOME:-$HOME/.cache}/claude-desktop/launcher.log"
    if [[ -f $logf || -f $logf.old ]]; then
        # Read across the rotated backup so the last 10 lines survive a
        # rotation that just happened at startup. cat exits non-zero when one
        # of the files is missing (no .old before the first rotation) - under
        # set -euo pipefail that would abort --diagnose, hence the || true.
        cat "$logf.old" "$logf" 2>/dev/null | tail -10 || true
    else
        echo '(no launcher.log yet)'
    fi
}

# ---------------------------------------------------------------------------
# Per-profile binary maintenance (runs once per launch, named profiles only)
# ---------------------------------------------------------------------------

# Auto-heal stale per-profile installs after package upgrades or NixOS rebuilds.
# Also refresh ELECTRON_BIN if path discovery had to fall back to the canonical
# (e.g. dangling per-profile from a moved Nix store path) — we want the next
# launch step to use the freshly materialised per-profile binary so WM_CLASS /
# Wayland app_id reflect the profile.
if [[ -n "$profile_suffix" ]]; then
    _refresh_profile_binary_if_stale || true
    _profile_bin="$HOME/.local/lib/claude-desktop/${APP_ID}${profile_suffix}"
    if [[ -x "$_profile_bin" && "$ELECTRON_BIN" != "$_profile_bin" ]]; then
        ELECTRON_BIN="$_profile_bin"
    fi

    # Silent-degradation hint: --profile=NAME isolates state but the
    # WM_CLASS / Wayland app_id stays as the default unless --create-profile
    # has materialised a per-profile binary. Most users will want both.
    # Suppress with CLAUDE_PROFILE_QUIET=1.
    if [[ ! -e "$_profile_bin" && -z "${CLAUDE_PROFILE_QUIET:-}" ]]; then
        echo >&2 "claude-desktop: profile '$CLAUDE_PROFILE' has isolated state but no per-profile WM identity."
        echo >&2 "  Windows will share the default profile's taskbar entry. To fix:"
        echo >&2 "    claude-desktop --create-profile=$CLAUDE_PROFILE"
        echo >&2 "  (suppress this message with CLAUDE_PROFILE_QUIET=1)"
    fi
fi

# ---------------------------------------------------------------------------
# AppImage auto-integration (protocol handler + menu entry)
# ---------------------------------------------------------------------------
if [[ -n "${CLAUDE_APPIMAGE_PATH:-}" ]]; then
    _appimage_integrate quiet || true
fi

case "${1:-}" in
    --help|-h)
        cat <<'HELP'
Usage: claude-desktop [OPTION]

Launch Claude Desktop, or run a subcommand.

Options:
  --toggle                  Toggle Quick Entry overlay (~5-25 ms via Unix
                            socket when app is running; launches app on cold
                            start). Bind this to a global keyboard shortcut.
  --toggle-quick-entry      Alias for --toggle (backward-compatible).
  --reload-theme            Ask the running app to re-read its theme config and
                            re-apply it (prints a one-line JSON result). Exits 1
                            if Claude Desktop is not running.
  --install-gnome-hotkey [ACCEL]
                            Install a GNOME custom keybinding for Quick Entry.
                            Default accelerator: <Primary><Alt>space
                            Example: claude-desktop --install-gnome-hotkey '<Super>space'
  --uninstall-gnome-hotkey  Remove the GNOME custom keybinding.
  --diagnose                Print session type, Electron version, portal status,
                            GNOME hotkey slot, and recent launcher log. Paste
                            output into issue reports.
  --profile=NAME            Launch (or target subcommand at) a named profile.
                            Each profile has its own login, logs, and Claude
                            Code config. Can also be selected by invoking via
                            a 'claude-desktop-NAME' symlink. Omit for default.
  --create-profile=NAME     Create profile NAME: installs user-local symlinks
                            (~/.local/bin/claude-desktop-NAME, ~/.local/lib/...)
                            and a .desktop file with a per-profile WMClass so
                            the window manager treats it as a separate app.
                            User data is not created until first launch.
  --delete-profile=NAME     Remove the entry points for profile NAME. User data
                            (~/.config/Claude-NAME, ~/.claude-NAME) is preserved.
  --list-profiles           List installed profiles.
  --integrate               Register the claude:// protocol handler and add an
                            application menu entry (AppImage only). Happens
                            automatically on every launch; use this to force
                            registration or verify the current state.
  --unintegrate             Remove the AppImage protocol handler registration
                            and menu entry. Does not affect system packages.
  --1p / --3p               Select the deployment mode for this and future
                            launches by persisting `deploymentMode` in
                            ~/.config/Claude-3p/claude_desktop_config.json
                            (per-profile: Claude-NAME-3p). Replaces the
                            upstream --boot-1p-once flag, which the official
                            .deb removed. --1p forces personal claude.ai mode
                            even while a 3p inference config is still stored;
                            --3p switches back. Quit any running instance
                            first. Cannot override an enterprise config that
                            sets authentication.disableClaudeAiSignIn.
  --native-titlebar          Restore the native window frame instead of the
                            integrated (overlay) titlebar. Same as setting
                            CLAUDE_NATIVE_TITLEBAR=1.
  --no-window-controls      Drop the window-control buttons from the
                            integrated titlebar. Removes the 4 px frame
                            Chromium draws around frameless windows on
                            xfwm4/i3/Awesome; close and minimize via your WM
                            (e.g. Alt+F4). Same as setting
                            CLAUDE_NO_WINDOW_CONTROLS=1.
  --no-systemd-scope        Skip the systemd --user --scope wrapper for this
                            launch. Use in sandboxes (bwrap, distrobox, ...)
                            where the systemd private socket is unreachable.
                            Same as setting CLAUDE_DISABLE_SYSTEMD_SCOPE=1.
  --help, -h                Show this help message.

Environment variables:
  CLAUDE_PROFILE=NAME       Same effect as --profile=NAME. Inherited by Electron
                            and the Claude Code child process so per-profile
                            sockets and config dirs are picked up automatically.
  CLAUDE_NATIVE_TITLEBAR=1  Restore the native window frame (same as --native-titlebar).
  CLAUDE_NO_WINDOW_CONTROLS=1
                            Frameless window with no window-control buttons
                            (same as --no-window-controls).
  CLAUDE_USE_XWAYLAND=1     Force XWayland instead of native Wayland.
  CLAUDE_MENU_BAR=visible   Menu bar mode: auto (default), visible, hidden.
  CLAUDE_GPU_BACKEND=angle-gl Render via ANGLE-GL (keeps GPU accel; fixes
                            GPU-process crashes on some drivers, e.g. Intel xe).
  CLAUDE_DISABLE_GPU=1      Disable GPU compositing (white screen fix).
  CLAUDE_DISABLE_GPU=full   Disable GPU entirely (more aggressive fallback).
  CLAUDE_PASSWORD_STORE=V   Force --password-store=V (e.g. gnome-libsecret,
                            kwallet6, basic). 'auto' disables the launcher's
                            Secret Service detection and keeps Chromium's own
                            choice. Default: on desktops Chromium gives no
                            keyring backend (Hyprland, sway, XFCE, ...), a
                            Secret Service on the session bus is used
                            automatically so sign-in tokens persist.
  CLAUDE_ELECTRON=PATH      Override path to Electron binary. Electron
                            auto-loads the resources/app.asar next to it
                            (there is no way to pass a different asar).
  CLAUDE_DISABLE_SYSTEMD_SCOPE=1
                            Skip the systemd --user --scope wrapper (for
                            sandboxes without access to the systemd private
                            socket; portal app identity may not resolve).
  CLAUDE_KEEP_TTY=1         Keep the controlling terminal even when launched
                            as a background job on one. Default is to setsid
                            away from it, because the app's env extraction
                            spawns an interactive shell that would otherwise
                            SIGTTIN the whole session process group (freezes
                            startx/xinit desktops). Terminal launches are
                            unaffected either way.
  CLAUDE_APPIMAGE_PATH=PATH Set by AppRun when running as AppImage. Used for
                            protocol handler registration. Do not set manually
                            unless running from --appimage-extract.

All other arguments are passed through to Electron.
HELP
        exit 0
        ;;
    --install-gnome-hotkey)
        shift
        _install_gnome_hotkey "$@"
        exit $?
        ;;
    --uninstall-gnome-hotkey)
        shift
        _uninstall_gnome_hotkey
        exit $?
        ;;
    --create-profile=*)
        _create_profile "${1#--create-profile=}"
        exit $?
        ;;
    --create-profile)
        shift
        _create_profile "${1:-}"
        exit $?
        ;;
    --delete-profile=*)
        _delete_profile "${1#--delete-profile=}"
        exit $?
        ;;
    --delete-profile)
        shift
        _delete_profile "${1:-}"
        exit $?
        ;;
    --list-profiles)
        _list_profiles
        exit 0
        ;;
    --integrate)
        _appimage_integrate
        exit $?
        ;;
    --unintegrate)
        _appimage_unintegrate
        exit $?
        ;;
    --toggle|--toggle-quick-entry)
        # Fast Quick Entry toggle via Unix domain socket (~5-25 ms).
        # Falls through to Electron if socket unavailable (cold start).
        # --toggle-quick-entry is the original flag; --toggle is the short alias.
        _SOCK="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/claude-desktop-qe${profile_suffix}.sock"
        if [ -S "$_SOCK" ]; then
            if command -v socat >/dev/null 2>&1; then
                socat /dev/null "UNIX-CLIENT:$_SOCK" 2>/dev/null && exit 0
            fi
            if command -v python3 >/dev/null 2>&1; then
                python3 -c "import socket,sys;s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(0.5);s.connect(sys.argv[1]);s.close()" "$_SOCK" 2>/dev/null && exit 0
            fi
            echo "[launcher] socket exists but no client (socat/python3) found - falling back to Electron" >&2
        fi
        ;;
    --reload-theme)
        # Theme reload trigger (GitHub issue #242). Sends "reload-theme\n" over
        # the Quick Entry socket; the patched server replies with one JSON line
        # ({ok,changed,name,windows}) and closes. Falls through to Electron's
        # second-instance path only when the app is actually running (a reload
        # without a running app is meaningless, so never start it from here).
        _SOCK="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/claude-desktop-qe${profile_suffix}.sock"
        _reply=""
        if [ -S "$_SOCK" ]; then
            if command -v socat >/dev/null 2>&1; then
                # -t 5: keep reading the reply for up to 5 s after stdin EOF.
                _reply="$(printf 'reload-theme\n' | socat -t 5 - "UNIX-CLIENT:$_SOCK" 2>/dev/null)" || _reply=""
            elif command -v python3 >/dev/null 2>&1; then
                _reply="$(python3 -c '
import socket,sys
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(5);s.connect(sys.argv[1])
s.sendall(b"reload-theme\n");s.shutdown(socket.SHUT_WR)
buf=b""
while True:
    d=s.recv(4096)
    if not d: break
    buf+=d
sys.stdout.write(buf.decode("utf-8","replace"))' "$_SOCK" 2>/dev/null)" || _reply=""
            else
                echo "[launcher] socket exists but no client (socat/python3) found - falling back to Electron" >&2
            fi
            if [[ -n "$_reply" ]]; then
                printf '%s\n' "$_reply"
                case "$_reply" in
                    *'"ok":true'*) exit 0 ;;
                    *) exit 1 ;;
                esac
            fi
        fi
        # Socket missing, refused, or silent: only hand over to Electron's
        # second-instance handler when an instance holds the SingletonLock
        # (default, per-profile, and the upstream `-3p` relocated userData).
        _running=""
        for _lock in "$config_dir/SingletonLock" "${config_dir}-3p/SingletonLock" \
                     "${XDG_CONFIG_HOME:-$HOME/.config}/Claude-3p${profile_suffix}/SingletonLock"; do
            if [[ -L "$_lock" ]]; then
                _lock_pid="$(readlink "$_lock" 2>/dev/null)"; _lock_pid="${_lock_pid##*-}"
                if [[ "$_lock_pid" =~ ^[0-9]+$ ]] && kill -0 "$_lock_pid" 2>/dev/null; then
                    _running=1
                    break
                fi
            fi
        done
        if [[ -z "$_running" ]]; then
            echo >&2 'Claude Desktop is not running'
            exit 1
        fi
        echo "[launcher] Quick Entry socket unavailable - delivering --reload-theme via Electron second-instance" >&2
        ;;
    --diagnose)
        shift
        # Run this subcommand even though it references variables (like
        # electron_major, platform_mode) that are set below; we re-read what
        # we need inside _diagnose. Electron version detection happens below
        # because both _diagnose and the normal launch path need it.
        _diagnose_requested=1
        ;;
esac

# ---------------------------------------------------------------------------
# Electron version detection
# ---------------------------------------------------------------------------
# Used below to decide whether native Wayland + GlobalShortcutsPortal is safe.
# electron/electron#49806 is a DBus signal-signature bug that causes global
# shortcuts to register but never deliver Activated events. Fix (#49842) was
# backported to 40.x and 41.x, not to 39.

electron_major=0
_electron_real="$ELECTRON_BIN"
[[ $_electron_real == electron ]] && _electron_real="$(command -v electron 2>/dev/null || true)"
if [[ -n $_electron_real ]]; then
    _version_file="$(dirname "$_electron_real")/version"
    if [[ -r $_version_file ]]; then
        electron_major=$(awk -F. 'NR==1{sub(/^v/,"",$1); print $1+0; exit}' "$_version_file" 2>/dev/null || echo 0)
    fi
    # Fall back to asking Electron itself (slightly slower, always works)
    if (( electron_major == 0 )); then
        electron_major=$("$_electron_real" --version 2>/dev/null | awk -F. 'NR==1{sub(/^v/,"",$1); print $1+0; exit}' || echo 0)
    fi
fi

# ---------------------------------------------------------------------------
# Display check
# ---------------------------------------------------------------------------

if [[ -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
    echo >&2 'claude-desktop: No display server detected.'
    echo >&2 'Both $DISPLAY and $WAYLAND_DISPLAY are unset.'
    echo >&2 'Run from within an X11 or Wayland session, not a TTY.'
    exit 1
fi

# ---------------------------------------------------------------------------
# Wayland / X11 detection
# ---------------------------------------------------------------------------
# Default: native Wayland on Wayland sessions, X11 on X11 sessions. Native
# Wayland uses xdg-desktop-portal's GlobalShortcuts API (implemented on GNOME,
# KDE, Hyprland).
#
# Known breakage: Electron <40 has a DBus signal-signature bug
# (electron/electron#49806, fixed in #49842 backported to 40.x/41.x). Global
# shortcuts register but Activated events never reach the app. We emit a loud
# warning to nudge users to upgrade instead of silently masking it with
# XWayland.
#
# Escape hatch: CLAUDE_USE_XWAYLAND=1 still forces XWayland for users who
# can't update Electron.

is_wayland=false
[[ -n "${WAYLAND_DISPLAY:-}" ]] && is_wayland=true

# Determine platform mode: x11, wayland, or xwayland
platform_mode=x11
if [[ $is_wayland == true ]]; then
    platform_mode=wayland

    if (( electron_major > 0 && electron_major < 40 )); then
        warn_msg="Electron $electron_major has a broken GlobalShortcutsPortal (electron/electron#49806, fixed in 40+/41+). Global hotkeys will only work when Claude Desktop has focus. Update your Electron package; Arch: sudo pacman -Syu electron. Escape hatch if you can't update: CLAUDE_USE_XWAYLAND=1."
        log "$warn_msg"
        echo >&2 "claude-desktop: $warn_msg"
    fi

    if [[ "${CLAUDE_USE_XWAYLAND:-}" == '1' ]]; then
        # User explicitly wants XWayland — respect it unless compositor can't do it
        platform_mode=xwayland
        desktop="${XDG_CURRENT_DESKTOP:-}"
        desktop="${desktop,,}"
        if [[ -n "${NIRI_SOCKET:-}" || "$desktop" == *niri* ]]; then
            log 'Niri detected — ignoring CLAUDE_USE_XWAYLAND (no XWayland support)'
            platform_mode=wayland
        fi
    fi
fi

# ---------------------------------------------------------------------------
# Build Electron arguments
# ---------------------------------------------------------------------------

# Titlebar mode resolution: env var / CLI flag OR persisted config.
#
# Both modes are also Settings -> Extra -> Community toggles, persisted as
# `nativeTitlebar` / `noWindowControls` in <userData>/claude-desktop-extra.json
# (the .jsonc variant wins and locks them, matching the app's own precedence).
# The BrowserWindow patch reads those keys directly, but the launcher-side
# effects only fire off the env vars: --disable-features=CustomTitlebar,
# ELECTRON_USE_SYSTEM_TITLE_BAR and - the one that actually breaks - the
# WaylandWindowDecorations feature flag. Without resolving the config here, a
# config-driven native frame on Wayland would come up with NO decorations.
#
# We only ever turn a mode ON from the config: an explicitly set env var (or
# the CLI flag, which sets one) always wins and is never overridden or unset,
# including an explicit CLAUDE_NATIVE_TITLEBAR=0 meaning "not native".
#
# Known limitation - 1p userData only. We read $config_dir, the dir this
# launcher passes as --user-data-dir. A 3p deployment relocates userData to
# <userData>-3p, so the Extra page writes claude-desktop-extra.json THERE and a
# 3p user's saved switch is not seen here. Scope of the gap: `noWindowControls`
# is unaffected either way (the launcher contributes no argument for it - bare
# mode is purely a BrowserWindow decision), so this is `nativeTitlebar` only,
# on Wayland only, and costs only the WaylandWindowDecorations feature flag.
# Workaround: pass --native-titlebar or set CLAUDE_NATIVE_TITLEBAR=1, which the
# precedence above deliberately lets win.
#
# Deliberately NOT fixed by also probing "${config_dir}-3p": that inverts the
# precedence for anyone who used 3p once and switched back, because their stale
# -3p file would outrank their live 1p config silently and permanently. And a
# correct 3p decision cannot be faked cheaply here - upstream keys it off
# /etc/claude-desktop/managed-settings.json carrying an inferenceProvider OR a
# user-writable store under <userData>-3p/configLibrary, with a persisted
# `deploymentMode` able to force 1p while 3p config is still on disk. Any
# shortcut we invent diverges from the app's own resolver and mis-reads
# somebody's config, so we stay honest about the gap instead of guessing.
_titlebar_source='CLAUDE_NATIVE_TITLEBAR=1'
_no_controls_source='CLAUDE_NO_WINDOW_CONTROLS=1'

# Echo whichever of the requested keys $1 resolves to boolean true. Degrades
# silently to "no keys": no python3, an unreadable file and malformed JSON are
# all treated as absent, because a broken config file must never stop the app
# from starting. Always returns 0 so `set -e` cannot trip over it.
_cdb_extra_true_keys() {
    local _file="$1"
    shift
    command -v python3 >/dev/null 2>&1 || return 0
    python3 - "$_file" "$@" 2>/dev/null <<'PY' || true
import json, sys

path, keys = sys.argv[1], sys.argv[2:]
try:
    with open(path, encoding="utf-8") as fh:
        raw = fh.read()
except OSError:
    sys.exit(0)

# Strip // and /* */ comments so the .jsonc variant parses, skipping anything
# inside a string literal so a URL or a Windows path is left intact.
out, i, n, in_str = [], 0, len(raw), False
while i < n:
    c = raw[i]
    if in_str:
        out.append(c)
        if c == "\\" and i + 1 < n:
            out.append(raw[i + 1])
            i += 2
            continue
        if c == '"':
            in_str = False
        i += 1
    elif c == '"':
        in_str = True
        out.append(c)
        i += 1
    elif c == "/" and i + 1 < n and raw[i + 1] == "/":
        while i < n and raw[i] != "\n":
            i += 1
    elif c == "/" and i + 1 < n and raw[i + 1] == "*":
        i += 2
        while i + 1 < n and not (raw[i] == "*" and raw[i + 1] == "/"):
            i += 1
        i += 2
    else:
        out.append(c)
        i += 1

try:
    data = json.loads("".join(out))
except ValueError:
    sys.exit(0)
if not isinstance(data, dict):
    sys.exit(0)

# `is True` on purpose: only a real JSON `true` counts. The string "true" and
# the number 1 are NOT on, so a hand-edited config cannot half-enable a mode
# here while the app's own boolean read says off.
for key in keys:
    if data.get(key) is True:
        print(key)
PY
    return 0
}

# Pick the config file in THIS shell, not inside the command substitution below
# (a subshell's variable assignments would be lost), so the log can name it.
_cdb_extra_src=''
for _cdb_extra_f in "$config_dir/claude-desktop-extra.jsonc" \
                    "$config_dir/claude-desktop-extra.json"; do
    if [[ -f "$_cdb_extra_f" && -r "$_cdb_extra_f" ]]; then
        _cdb_extra_src="$_cdb_extra_f"
        break
    fi
done

_cdb_extra_keys=' '
if [[ -n "$_cdb_extra_src" ]]; then
    _cdb_extra_keys=" $(_cdb_extra_true_keys "$_cdb_extra_src" \
        nativeTitlebar noWindowControls | tr '\n' ' ')"
fi

if [[ -z "${CLAUDE_NATIVE_TITLEBAR:-}" && "$_cdb_extra_keys" == *' nativeTitlebar '* ]]; then
    export CLAUDE_NATIVE_TITLEBAR=1
    _titlebar_source="nativeTitlebar in ${_cdb_extra_src##*/}"
fi
if [[ -z "${CLAUDE_NO_WINDOW_CONTROLS:-}" && "$_cdb_extra_keys" == *' noWindowControls '* ]]; then
    export CLAUDE_NO_WINDOW_CONTROLS=1
    _no_controls_source="noWindowControls in ${_cdb_extra_src##*/}"
fi

# Titlebar modes are mutually exclusive; the native frame wins.
if [[ "${CLAUDE_NATIVE_TITLEBAR:-}" == '1' && "${CLAUDE_NO_WINDOW_CONTROLS:-}" == '1' ]]; then
    log "Titlebar: native ($_titlebar_source) and no window controls ($_no_controls_source) are mutually exclusive; using native"
    unset CLAUDE_NO_WINDOW_CONTROLS
    _no_controls_source=''
fi

ELECTRON_ARGS=()

# Titlebar mode: integrated (default) vs bare (frameless, no controls) vs
# native (opt-out).
# In native mode, disable Chromium's CustomTitlebar feature so Electron
# renders the system frame. In integrated and bare mode, keep it enabled so
# titleBarOverlay works.
if [[ "${CLAUDE_NATIVE_TITLEBAR:-}" == '1' ]]; then
    ELECTRON_ARGS+=('--disable-features=CustomTitlebar')
    log "Titlebar: native ($_titlebar_source)"
elif [[ "${CLAUDE_NO_WINDOW_CONTROLS:-}" == '1' ]]; then
    log "Titlebar: frameless, no window controls ($_no_controls_source)"
else
    log 'Titlebar: integrated (default)'
fi

# Force ARGB visuals so `transparent:true` popups (Quick Entry) render their
# outer window transparently on compositors that wouldn't otherwise expose
# alpha. No-op on X11 when already supported. Fixes the "opaque rectangle
# behind the rounded card" symptom (issue #39) on most Wayland configs.
ELECTRON_ARGS+=('--enable-transparent-visuals')

# Enable Chromium Web Bluetooth so the Hardware Buddy (Nibblet BLE) in-app scan
# can enumerate devices. On macOS/Windows Web Bluetooth is on by default, but on
# Linux Chromium gates it behind the WebBluetooth Blink feature at the PROCESS
# level - a per-webContents webPreference does not turn it on, only this switch
# does (verified: without it navigator.bluetooth is undefined in the renderer;
# with it requestDevice works). Harmless for users without a Buddy - it only
# exposes the API; nothing scans until the user opens the Buddy window.
ELECTRON_ARGS+=('--enable-blink-features=WebBluetooth')

case $platform_mode in
    x11)
        log 'X11 session detected'
        if [[ -n "${CLAUDE_APPIMAGE_PATH:-}" ]]; then
            log 'AppImage X11: adding --no-sandbox (FUSE cannot carry SUID)'
            ELECTRON_ARGS+=('--no-sandbox')
        fi
        ;;
    xwayland)
        log 'Using X11 backend via XWayland (CLAUDE_USE_XWAYLAND=1)'
        ELECTRON_ARGS+=('--no-sandbox' '--ozone-platform=x11')
        ;;
    wayland)
        log 'Using native Wayland backend'
        ELECTRON_ARGS+=('--no-sandbox')
        if [[ "${CLAUDE_NATIVE_TITLEBAR:-}" == '1' ]]; then
            ELECTRON_ARGS+=('--enable-features=UseOzonePlatform,WaylandWindowDecorations,GlobalShortcutsPortal')
        else
            ELECTRON_ARGS+=('--enable-features=UseOzonePlatform,GlobalShortcutsPortal')
        fi
        ELECTRON_ARGS+=('--ozone-platform=wayland')
        ELECTRON_ARGS+=('--enable-wayland-ime')
        ELECTRON_ARGS+=('--wayland-text-input-version=3')
        # On GPUs where Chromium (observed on Electron 42) brings up Vulkan - real Intel/AMD/
        # NVIDIA with a recent Mesa driver - it refuses to pair Vulkan with
        # --ozone-platform=wayland: the Wayland surface factory fails and NO window
        # is ever created (silent no-UI startup, seen on Ubuntu/GNOME Wayland).
        # Machines where Chromium never selects Vulkan (VMs, software GL) don't hit
        # this, and disabling the feature there is a harmless no-op. Chromium refuses
        # Vulkan+Wayland outright, so this removes no working render path. x11/
        # xwayland use --ozone-platform=x11 and keep Vulkan. Opt out: CLAUDE_ENABLE_VULKAN=1.
        # log line: wayland_surface_factory.cc "'--ozone-platform=wayland' is not compatible with Vulkan"
        if [[ "${CLAUDE_ENABLE_VULKAN:-}" != '1' ]]; then
            ELECTRON_ARGS+=('--disable-features=Vulkan')
            log 'Vulkan disabled for Wayland surface compatibility (set CLAUDE_ENABLE_VULKAN=1 to keep it)'
        else
            log 'Vulkan kept on Wayland (CLAUDE_ENABLE_VULKAN=1)'
        fi
        ;;
esac

# Now that platform_mode and electron_major are known, service the --diagnose
# subcommand if requested. Exits here — does not launch Electron.
if [[ -n ${_diagnose_requested:-} ]]; then
    echo "platform_mode = $platform_mode"
    echo "electron_major = $electron_major"
    # Note: CLAUDE_DISABLE_GPU flags are appended after this point, so they are
    # not reflected here; the platform/Vulkan/titlebar flags are.
    echo "electron_args = ${ELECTRON_ARGS[*]}"
    _diagnose
    exit 0
fi

# ---------------------------------------------------------------------------
# GPU compositing fallback
# ---------------------------------------------------------------------------
# Some GPU/driver combinations (notably GBM buffer creation failures on
# Wayland, common on Fedora KDE) cause a blank white window.
# See: https://github.com/patrickjaja/claude-desktop-extra/issues/13

# Milder GPU workaround than disabling it outright: route rendering through
# ANGLE's GL backend instead of the native Wayland/GBM path. Some GPU +
# kernel-driver combos (e.g. Intel `xe`) abort Electron's Ozone/Wayland
# GPU-process init ("GPU process isn't usable. Goodbye.") but work fine via
# ANGLE-GL, which keeps GPU acceleration. Try this before CLAUDE_DISABLE_GPU.
case "${CLAUDE_GPU_BACKEND:-}" in
    angle-gl)
        log 'GPU backend set to ANGLE-GL (CLAUDE_GPU_BACKEND=angle-gl)'
        ELECTRON_ARGS+=('--use-gl=angle' '--use-angle=gl')
        ;;
esac

case "${CLAUDE_DISABLE_GPU:-}" in
    1|compositing)
        log 'GPU compositing disabled (CLAUDE_DISABLE_GPU)'
        ELECTRON_ARGS+=('--disable-gpu-compositing')
        ;;
    full)
        log 'GPU fully disabled (CLAUDE_DISABLE_GPU=full)'
        ELECTRON_ARGS+=('--disable-gpu')
        ;;
esac

# ---------------------------------------------------------------------------
# Password store (Secret Service keyring)
# ---------------------------------------------------------------------------
# Chromium picks its os_crypt backend from XDG_CURRENT_DESKTOP. On desktops it
# does not map to a keyring backend (Hyprland, sway, river, niri, COSMIC, ...,
# and also XFCE/LXQt, which it maps to basic_text by policy) it silently falls
# back to basic_text: safeStorage.isEncryptionAvailable() is false, OAuth
# tokens do not persist across launches, and the app tells the user to
# "install a system keyring" they may already be running. When a Secret
# Service is actually available on the session bus (owned or D-Bus
# activatable), pass --password-store=gnome-libsecret so Electron uses it.
# See issue #191.
#
# The same breakage hits KDE, which Chromium maps to kwallet unconditionally:
# when KWallet is switched off (kwalletrc Enabled=false) or not installed, that
# backend yields no encryption either, and users running gnome-keyring as their
# Secret Service under Plasma have to sign in again after every reboot. So KDE
# only counts as keyring-native when kwalletd actually answers on the bus.
#
# One-time side effect on machines previously on basic_text:
# data encrypted with the old hardcoded key cannot be read after the switch,
# so the first launch may require signing in again.
#
#   CLAUDE_PASSWORD_STORE=<value>  force --password-store=<value>
#   CLAUDE_PASSWORD_STORE=auto     disable detection (Chromium's own choice)
#   an explicit --password-store=... argument always wins (detection skipped)

_secret_service_available() {
    # Owned or activatable org.freedesktop.secrets on the session bus.
    # busctl list shows both running and activatable names.
    if command -v busctl &>/dev/null; then
        busctl --user --no-pager list 2>/dev/null \
            | grep -q '^org\.freedesktop\.secrets\b'
        return
    fi
    if command -v dbus-send &>/dev/null; then
        {
            dbus-send --session --print-reply --dest=org.freedesktop.DBus \
                /org/freedesktop/DBus org.freedesktop.DBus.ListNames 2>/dev/null
            dbus-send --session --print-reply --dest=org.freedesktop.DBus \
                /org/freedesktop/DBus org.freedesktop.DBus.ListActivatableNames 2>/dev/null
        } | grep -q '"org\.freedesktop\.secrets"'
        return
    fi
    if command -v gdbus &>/dev/null; then
        gdbus call --session --dest org.freedesktop.DBus \
            --object-path /org/freedesktop/DBus \
            --method org.freedesktop.DBus.ListActivatableNames 2>/dev/null \
            | grep -q 'org\.freedesktop\.secrets'
        return
    fi
    return 1
}

_kwallet_available() {
    # Whether kwalletd can actually serve os_crypt. A bus-name check is NOT
    # enough here: org.kde.kwalletd6 stays D-Bus activatable even when KWallet
    # is switched off, and activation then fails ("unit failed"). So probe with
    # a real method call, bounded by a short D-Bus timeout - the app's own
    # kwalletd pre-flight warns that this call can otherwise block behind the
    # wallet-creation wizard when kwalletd runs but has no wallet yet.
    local _v _svc _obj
    for _v in 6 5; do
        _svc="org.kde.kwalletd${_v}"
        _obj="/modules/kwalletd${_v}"
        if command -v busctl &>/dev/null; then
            busctl --user --no-pager --timeout=5 call \
                "$_svc" "$_obj" org.kde.KWallet wallets &>/dev/null && return 0
        elif command -v dbus-send &>/dev/null; then
            dbus-send --session --print-reply --reply-timeout=5000 \
                --dest="$_svc" "$_obj" org.kde.KWallet.wallets &>/dev/null && return 0
        elif command -v gdbus &>/dev/null; then
            gdbus call --session --timeout 5 --dest "$_svc" \
                --object-path "$_obj" --method org.kde.KWallet.wallets &>/dev/null && return 0
        else
            # No way to probe - keep Chromium's KDE default untouched.
            return 0
        fi
    done
    return 1
}

_pw_store_explicit=''
for _arg in "$@"; do
    if [[ "$_arg" == --password-store=* ]]; then
        _pw_store_explicit=1
        break
    fi
done
if [[ -z "$_pw_store_explicit" ]]; then
    case "${CLAUDE_PASSWORD_STORE:-}" in
        '')
            # Skip desktops Chromium already maps to a keyring backend
            # (GNOME-family -> libsecret, KDE -> kwallet). KDE is verified
            # below, since that mapping is a dead end without kwalletd.
            _de_keyring_native=''
            _de_is_kde=''
            IFS=':' read -ra _de_parts <<< "${XDG_CURRENT_DESKTOP:-}"
            for _de in "${_de_parts[@]}"; do
                case "${_de,,}" in
                    kde)
                        _de_keyring_native=1
                        _de_is_kde=1
                        break
                        ;;
                    gnome|unity|deepin|cinnamon|x-cinnamon|pantheon|ukui)
                        _de_keyring_native=1
                        break
                        ;;
                esac
            done
            # Chromium's kwallet mapping is only real if kwalletd answers.
            if [[ -n "$_de_is_kde" ]] && ! _kwallet_available; then
                log "kwalletd does not answer on the session bus - KDE's kwallet backend would yield no encryption, falling back to Secret Service detection"
                _de_keyring_native=''
            fi
            if [[ -z "$_de_keyring_native" ]] && _secret_service_available; then
                log "Secret Service detected on session bus; XDG_CURRENT_DESKTOP='${XDG_CURRENT_DESKTOP:-}' gets no keyring backend from Chromium - adding --password-store=gnome-libsecret"
                ELECTRON_ARGS+=('--password-store=gnome-libsecret')
            fi
            ;;
        auto)
            # Opt-out: let Chromium's own detection run unmodified.
            ;;
        *)
            log "Password store forced via CLAUDE_PASSWORD_STORE=${CLAUDE_PASSWORD_STORE}"
            ELECTRON_ARGS+=("--password-store=${CLAUDE_PASSWORD_STORE}")
            ;;
    esac
fi

# ---------------------------------------------------------------------------
# Environment variables
# ---------------------------------------------------------------------------

export ELECTRON_FORCE_IS_PACKAGED=true

# In native titlebar mode, tell Electron to use the system frame.
# In integrated mode (default), do NOT set this so titleBarOverlay works.
if [[ "${CLAUDE_NATIVE_TITLEBAR:-}" == '1' ]]; then
    export ELECTRON_USE_SYSTEM_TITLE_BAR=1
fi

# Pass through CLAUDE_NATIVE_TITLEBAR if set (env var, not just --flag)
if [[ -n "${CLAUDE_NATIVE_TITLEBAR:-}" ]]; then
    export CLAUDE_NATIVE_TITLEBAR
fi

# Pass through CLAUDE_NO_WINDOW_CONTROLS if set (env var, not just --flag)
if [[ -n "${CLAUDE_NO_WINDOW_CONTROLS:-}" ]]; then
    export CLAUDE_NO_WINDOW_CONTROLS
fi

# Pass through CLAUDE_MENU_BAR if set (auto/visible/hidden)
if [[ -n "${CLAUDE_MENU_BAR:-}" ]]; then
    export CLAUDE_MENU_BAR
fi

# Tell the app which launcher started it, so the XDG autostart entry written by
# the "Start at login" toggle points back HERE instead of at the bundled Electron
# binary. Upstream builds that entry from process.execPath
# (/usr/lib/claude-desktop/claude), which would start the login instance with
# none of the setup below: no --ozone-platform=wayland (XWayland instead of
# native Wayland), no GlobalShortcutsPortal feature flag, no PATH repair (Cowork
# cannot find qemu), no --password-store, no systemd scope (the portal identity
# that persists Computer Use grants), and for a named profile no --user-data-dir.
# patches/linux/fix_startup_settings.nim (P4) reads this, and re-adds
# --profile=<name> from CLAUDE_PROFILE.
if [[ -n "${CLAUDE_APPIMAGE_PATH:-}" ]]; then
    # AppImage: the mount point is ephemeral, the .AppImage file is not.
    export CLAUDE_LAUNCHER="$CLAUDE_APPIMAGE_PATH"
else
    _cdb_launcher_self="$(readlink -f "$0" 2>/dev/null || echo "$0")"
    if [[ -x "$_cdb_launcher_self" ]]; then
        export CLAUDE_LAUNCHER="$_cdb_launcher_self"
    else
        log "cannot resolve own path ($0); autostart entry will fall back to the Electron binary"
    fi
fi

# ---------------------------------------------------------------------------
# SingletonLock cleanup
# ---------------------------------------------------------------------------
# Electron's requestSingleInstanceLock() silently quits if the lock is held.
# A stale lock from a crash blocks all launches with no error message.
# The lock is a symlink whose target encodes "hostname-PID".

lock_file="$config_dir/SingletonLock"

# When a profile is active, redirect Electron's userData away from the default
# ~/.config/Claude. This is what isolates SingletonLock, logins, logs, etc.
# For the default profile, omit the flag so behavior is byte-identical to v1.
if [[ -n "$profile_suffix" ]]; then
    mkdir -p "$config_dir"
    ELECTRON_ARGS+=("--user-data-dir=$config_dir")
fi

if [[ -L "$lock_file" ]]; then
    lock_target="$(readlink "$lock_file" 2>/dev/null)" || true
    lock_pid="${lock_target##*-}"
    if [[ "$lock_pid" =~ ^[0-9]+$ ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
        rm -f "$lock_file"
        log "Removed stale SingletonLock (PID $lock_pid no longer running)"
    fi
fi

# ---------------------------------------------------------------------------
# Launch
# ---------------------------------------------------------------------------

# Hard check: Electron auto-loads the exe-adjacent resources/app.asar. Runs
# after the per-profile refresh so a just-repaired symlink farm passes.
APP_ASAR="$(dirname "$ELECTRON_BIN")/resources/app.asar"
if [[ ! -f "$APP_ASAR" ]]; then
    echo >&2 "claude-desktop: resources/app.asar not found next to $ELECTRON_BIN"
    echo >&2 '  The install is incomplete or the per-profile resources symlink is broken.'
    echo >&2 '  Reinstall the package, or recreate the profile with --create-profile.'
    exit 1
fi

log "Launching: $ELECTRON_BIN (auto-loads $APP_ASAR) ${ELECTRON_ARGS[*]} $*"

# Launch inside a named systemd user scope. The scope name (cgroup,
# app-${DESKTOP_ID}-PID.scope) is the identity signal xdg-desktop-portal uses to
# resolve us back to our .desktop. By the freedesktop convention the middle
# token is the application id == .desktop basename, so it must be DESKTOP_ID
# ("com.anthropic.Claude"), NOT APP_ID ("claude"). The reverse-DNS id (with dots)
# is what lets the portal persist Computer Use grants on KDE; the scope unit
# app-com.anthropic.Claude-PID.scope follows the same convention Flatpak/GNOME use.
# This is separate from the window app_id / X11 WM_CLASS ("claude-desktop", from
# the app's desktopName); that dock-icon match uses StartupWMClass / the .desktop
# filename instead. APP_ID remains only the cosmetic Electron binary basename.
# Fall back to direct exec in environments without user systemd (rare).
# Three gates: explicit opt-out, binary present, runtime dir set, and the
# user-systemd private socket actually reachable. The last check matters in
# sandboxes (bwrap, distrobox, some container setups) where `systemd-run`
# exists but the socket is filtered: without the probe we would `exec` into
# systemd-run and die there, with no fallback. See issue #89.
# Guarantee a usable PATH inside the Electron process. When Claude is launched
# from a .desktop file (GNOME/XFCE/KDE menu), the systemd --user scope can start
# with an EMPTY PATH - the display-manager-spawned graphical session and the
# systemd user manager often carry no PATH. That breaks any feature that resolves
# a binary via $PATH; in particular the native Cowork VM backend probes for
# `qemu-system-x86_64` by walking process.env.PATH, so an empty PATH makes Cowork
# report "VM not supported" and the workspace Download button do nothing - even
# though qemu is installed. (Terminal launches are unaffected: they inherit the
# shell's PATH.) We therefore export an explicit PATH that always includes the
# standard system bindirs (where qemu/virtiofsd live), appended to whatever the
# launcher inherited, and propagate it into the scope with --setenv.
_claude_path="${PATH:-}"
for _d in /usr/local/bin /usr/bin /bin /usr/local/sbin /usr/sbin /sbin; do
    case ":${_claude_path}:" in
        *":${_d}:"*) : ;;                       # already present
        *) _claude_path="${_claude_path:+${_claude_path}:}${_d}" ;;
    esac
done
export PATH="$_claude_path"

# Detach from the controlling terminal when we are a BACKGROUND job on one.
#
# Sessions started with startx/xinit rather than a display manager run the
# whole desktop on a VT: xfce4-session and everything it spawns inherit
# ctty=/dev/ttyN and the session's process group, which is not the terminal's
# foreground group (that stays with the startx shell).
#
# The app's Claude Code integration harvests the user environment by spawning
# an INTERACTIVE login shell (bash -l -i -c '... env'). Bash's job-control
# init sees it is not in the foreground process group of its controlling
# terminal, and raises SIGTTIN against its whole PROCESS GROUP - the group it
# inherited from us. On a startx session that group is the entire desktop, so
# xfce4-session, xfwm4, xfce4-panel, xfdesktop and the rest all enter state T
# and the desktop appears frozen. Xorg is a child of xinit in a different
# group and keeps running, which is why the pointer still moves and VT
# switching still works while nothing else responds; recovery needs an
# external SIGCONT or killing X. Observed on XFCE + startx: main process
# blocked 17-55s per launch, then "[CCD] Shell environment extraction timed
# out". Launching the same binary from a terminal was always fine.
#
# setsid puts us in a new session with NO controlling terminal and a fresh,
# ORPHANED process group; POSIX requires stop signals sent to an orphaned
# process group to be discarded, so the spawned shell just turns job control
# off and returns. Redirecting the inherited tty fds away as well keeps
# isatty(stderr) false, so bash does not attempt job control at all.
#
# Deliberately a no-op for foreground launches: a terminal launch has
# tpgid == pgid and keeps its stdio, live output and Ctrl-C untouched.
# CLAUDE_KEEP_TTY=1 forces the old behaviour.
_needs_tty_detach() {
    local _pgid _tpgid
    _pgid=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')
    _tpgid=$(ps -o tpgid= -p $$ 2>/dev/null | tr -d ' ')
    # tpgid is -1 with no controlling terminal, and equals pgid when we are the
    # foreground job. Neither case can raise SIGTTIN, so leave them alone.
    [[ -n "$_pgid" && -n "$_tpgid" && "$_tpgid" != '-1' && "$_tpgid" != "$_pgid" ]]
}

_setsid=()
if [[ "${CLAUDE_KEEP_TTY:-}" != '1' ]] && _needs_tty_detach; then
    if command -v setsid &>/dev/null; then
        _setsid=(setsid)
        log "background job on a controlling terminal: detaching via setsid, stdio -> $STDIO_LOG"
        exec </dev/null >>"$STDIO_LOG" 2>&1
    else
        log 'WARNING: background job on a controlling terminal but setsid is missing (util-linux); the app env extraction can SIGTTIN the whole session process group'
    fi
fi

if [[ "${CLAUDE_DISABLE_SYSTEMD_SCOPE:-}" != '1' ]] \
    && command -v systemd-run &>/dev/null \
    && [[ -n "${XDG_RUNTIME_DIR:-}" ]] \
    && [[ -S "${XDG_RUNTIME_DIR}/systemd/private" ]]; then
    exec "${_setsid[@]}" systemd-run --user --scope --quiet \
        --unit="app-${DESKTOP_ID}-$$.scope" \
        --description='Claude Desktop' \
        --setenv="PATH=${_claude_path}" \
        -- "$ELECTRON_BIN" "${ELECTRON_ARGS[@]}" "$@"
fi
log 'systemd user scope unavailable (binary missing, socket unreachable, or CLAUDE_DISABLE_SYSTEMD_SCOPE=1): launching without scope; xdg-desktop-portal may fail to identify the app'
exec "${_setsid[@]}" "$ELECTRON_BIN" "${ELECTRON_ARGS[@]}" "$@"
