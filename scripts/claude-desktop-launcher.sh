#!/usr/bin/env bash
# Claude Desktop launcher for Linux
#
# Handles Wayland/X11 detection, Electron flags, GPU fallback, and stale lock cleanup.
# Works across all packaging formats (Arch, RPM, DEB, AppImage, Nix).
#
# Environment variables:
#   CLAUDE_USE_XWAYLAND=1    - Force XWayland instead of native Wayland (escape hatch
#                              for users on Electron <40 that can't update; see below)
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
# PATH
# ---------------------------------------------------------------------------
# Guarantee a usable PATH. When Claude is launched from a .desktop file
# (GNOME/XFCE/KDE menu), the systemd --user scope can start with an EMPTY PATH -
# the display-manager-spawned graphical session and the systemd user manager
# often carry no PATH. That breaks any feature that resolves a binary via $PATH;
# in particular the native Cowork VM backend probes for `qemu-system-x86_64` by
# walking process.env.PATH, so an empty PATH makes Cowork report "VM not
# supported" and the workspace Download button do nothing - even though qemu is
# installed. (Terminal launches are unaffected: they inherit the shell's PATH.)
# We export an explicit PATH that always includes the standard system bindirs
# (where qemu/virtiofsd live), appended to whatever the launcher inherited, and
# propagate it into the scope with --setenv at exec time.
#
# This runs FIRST, before anything else in the file: the launcher itself shells
# out to mkdir, find, ps, python3, gsettings, gdbus and setsid long before it
# reaches the exec, and with an inherited empty PATH the very first `mkdir` in
# the Logging block below died with "command not found" and the app never
# started at all.
_claude_path="${PATH:-}"
for _d in /usr/local/bin /usr/bin /bin /usr/local/sbin /usr/sbin /sbin; do
    case ":${_claude_path}:" in
        *":${_d}:"*) : ;;                       # already present
        *) _claude_path="${_claude_path:+${_claude_path}:}${_d}" ;;
    esac
done
export PATH="$_claude_path"

# RHEL 9 / Rocky / Alma ship QEMU only as /usr/libexec/qemu-kvm, so upstream's
# PATH walk for qemu-system-<arch> fails and Cowork reports "requires QEMU" with
# qemu-kvm installed. The rpm ships qemu-shim/qemu-system-<arch> symlinks to it
# (the helper's command line boots unchanged on RHEL qemu-kvm). Append that dir
# only when no executable qemu-system-<arch> is on PATH (same X_OK walk as the
# app), qemu-kvm exists and the shim is installed; a real QEMU always wins.
_cowork_qemu_shim_path() {
    local path=$1 arch=$2 qemu_kvm=$3 shim_dir=$4 bin _d
    case "$arch" in
        x86_64) bin=qemu-system-x86_64 ;;
        aarch64 | arm64) bin=qemu-system-aarch64 ;;
        *) echo "$path"; return 0 ;;
    esac
    local IFS=:
    for _d in $path; do
        [[ -n "$_d" && -x "$_d/$bin" && ! -d "$_d/$bin" ]] && { echo "$path"; return 0; }
    done
    if [[ -x "$qemu_kvm" && -x "$shim_dir/$bin" ]]; then
        echo "${path:+${path}:}${shim_dir}"
    else
        echo "$path"
    fi
}
# _claude_path too: the systemd scope exec passes it via --setenv=PATH.
_claude_path="$(_cowork_qemu_shim_path "$PATH" "$(uname -m)" /usr/libexec/qemu-kvm /usr/lib/claude-desktop/qemu-shim)"
PATH="$_claude_path"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
# Defined up here (before any caller) because functions like _appimage_integrate
# run during early startup and call log(); bash resolves a called function's name
# at call time, so a later definition would print "log: command not found" (#142).

LOG_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/claude-desktop"
# Never fatal. Under `set -e` an unwritable ~/.cache (root-owned after one
# `sudo claude-desktop`, a full disk, a quota) made this the first thing that
# ran and the last: the launcher exited 1 before anything else, and from a
# desktop icon the user saw an app that simply does not open. Logging is a
# convenience; it must not be able to stop the app from starting.
mkdir -p "$LOG_DIR" 2>/dev/null || true
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

# The group's redirect covers the append's OWN failure too: bash applies
# redirections left to right, so `>> "$LOG_FILE" 2>/dev/null` would still print
# "No such file or directory" to the real stderr before the suppression took
# effect. An unwritable log must be completely silent, not merely non-fatal.
log() { { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG_FILE"; } 2>/dev/null || true; }

# ---------------------------------------------------------------------------
# Profile resolution
# ---------------------------------------------------------------------------
# A profile gives an instance its own userData dir (and therefore SingletonLock,
# logins, logs, spaces.json, custom themes), its own cowork + Quick Entry
# sockets, its own Claude Code config dir, and its own systemd scope name.
#
# Resolution order (strongest first):
#   1. --profile=<name> or --profile <name> on argv - overwrites whatever is set
#   2. CLAUDE_PROFILE env var (so child processes inherit the running profile)
#   3. Invocation basename matching `claude-desktop-<name>` (symlink-launched),
#      consulted only when the env var is empty
#
# So an exported CLAUDE_PROFILE BEATS the basename: running claude-desktop-work
# from a shell that exports CLAUDE_PROFILE=personal launches `personal`. That is
# deliberate - a profile's own child processes must stay in their profile - but
# it is the opposite of what a symlink's name suggests, so pass --profile
# explicitly when you need to be sure.
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
            # Exported like its neighbours below: the SSO URL re-exec replaces
            # this process, and an unexported value would not survive it.
            export CLAUDE_DISABLE_SYSTEMD_SCOPE=1
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
        # `|| _marker=""` because 2>/dev/null hides find's message but not its
        # status: with pipefail, a missing or unreadable runtime dir (su - user,
        # a container, a non-systemd session) failed the assignment and set -e
        # exited 1 with no output at all - every claude:// link, and so every
        # SSO callback, silently did nothing.
        _marker=$(find "$_runtime_dir" -maxdepth 1 -type f \
            -name 'claude-desktop-pending-auth-*' -mmin -5 \
            -printf '%T@ %p\n' 2>/dev/null \
            | sort -nr | head -1 | awk '{print $2}') || _marker=""
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
    # Subcommands that report or clean up need no binary, and refusing them here
    # meant the tools for diagnosing and undoing a broken install were exactly
    # the ones a broken install disabled: --diagnose could not run, and
    # --delete-profile / --unintegrate could not remove the symlinks and
    # .desktop files left behind after the package was uninstalled.
    case "${1:-}" in
        --help|-h|--version|-V|--list-profiles|--diagnose|--unintegrate|\
        --uninstall-gnome-hotkey|--install-gnome-hotkey|--delete-profile|--delete-profile=*)
            echo >&2 'claude-desktop: Electron binary not found; continuing (this subcommand does not need it).'
            ;;
        *)
            echo >&2 'claude-desktop: Claude Desktop Electron binary not found.'
            echo >&2 "Searched: /usr/lib/claude-desktop/${APP_ID}, /usr/lib/claude-desktop-bin/${APP_ID}"
            echo >&2 'Set CLAUDE_ELECTRON=/path/to/claude to override.'
            exit 1
            ;;
    esac
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

# Echo the command that starts THIS launcher again, for entries that outlive the
# current process: the "Start at login" autostart entry (CLAUDE_LAUNCHER, read
# by patches/linux/fix_startup_settings.nim P4) and the named-profile entry
# points written by --create-profile. $1 is the launcher's $0.
#
#   1. AppImage: the .AppImage file itself (the FUSE mount path changes every run).
#   2. A CLAUDE_LAUNCHER set by a package wrapper, kept as given. On Nix the
#      launcher runs behind a makeWrapper script, and `readlink -f "$0"` lands on
#      the UNWRAPPED store copy: an entry pointing there starts without the
#      wrapper's environment (no CLAUDE_ELECTRON, so "Electron binary not
#      found") and dangles after garbage collection. The wrapper sets the bare
#      name, which resolves through PATH to whatever the current generation is.
#   3. Our own resolved path.
# Returns 1 when none of them is runnable.
_resolve_launcher_self() {
    local self="$1" resolved
    if [[ -n "${CLAUDE_APPIMAGE_PATH:-}" ]]; then
        echo "$CLAUDE_APPIMAGE_PATH"
        return 0
    fi
    if [[ -n "${CLAUDE_LAUNCHER:-}" ]]; then
        local runnable=0
        if [[ "$CLAUDE_LAUNCHER" == */* ]]; then
            [[ -x "$CLAUDE_LAUNCHER" ]] && runnable=1
        else
            type -P "$CLAUDE_LAUNCHER" &>/dev/null && runnable=1
        fi
        if (( runnable )); then
            echo "$CLAUDE_LAUNCHER"
            return 0
        fi
        log "CLAUDE_LAUNCHER=$CLAUDE_LAUNCHER is not runnable; using the launcher's own path"
    fi
    resolved="$(readlink -f "$self" 2>/dev/null || echo "$self")"
    [[ -x "$resolved" ]] || return 1
    echo "$resolved"
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
    # Mirroring a directory onto itself would rm each link and recreate it
    # pointing at its own path. That is reachable whenever --create-profile runs
    # with a profile already active, because the source is then the per-profile
    # directory rather than the install tree.
    if [[ "$(cd "$src_dir" 2>/dev/null && pwd -P)" == "$(cd "$dst_dir" 2>/dev/null && pwd -P)" ]]; then
        return 0
    fi
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
    # Drop links to files this version no longer ships. The staleness check
    # treats any dangling sibling as "needs refresh", and the loop above only
    # visits names that still exist upstream - so without this a single removed
    # file (libEGL.so, or a pre-rename LICENSE path) makes every later launch
    # re-materialise the binary forever.
    for entry in "$dst_dir"/*; do
        [[ -L "$entry" ]] || continue
        bn="$(basename "$entry")"
        [[ "$bn" == "$orig_bn" ]] && continue
        case "$bn" in "${APP_ID}"*) continue ;; esac
        [[ -e "$entry" ]] || rm -f "$entry"
    done
}

# Resolve the canonical Electron binary, ignoring any per-profile copy.
# CLAUDE_ELECTRON comes first: it is how Nix and the AppImage name their tree,
# and a system path would make a mixed install silently re-copy the profile
# from the OTHER package. Then the path-discovery candidate list. Returns the
# first executable hit on stdout, or empty if none found.
# (The claude-desktop-bin path is legacy: Arch installs before the
# claude-desktop-extra rename.)
_canonical_electron_bin() {
    local c
    if [[ -n "${CLAUDE_ELECTRON:-}" && -x "$CLAUDE_ELECTRON" \
        && "$CLAUDE_ELECTRON" != "$HOME/.local/lib/claude-desktop/"* ]]; then
        echo "$CLAUDE_ELECTRON"
        return 0
    fi
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
#   - Any sibling symlink target missing (same Nix scenario after GC).
#   - The per-profile dir mirrors a different install than the canonical one
#     (a NixOS rebuild before GC: store files all carry mtime 1, so the -nt
#     check never fires while the old store path still exists).
# The AppImage is skipped entirely: its tree lives on a FUSE mount whose path
# changes every launch, so a per-profile mirror of it breaks on the next run.
# When a refresh runs, it leaves a one-line note on stderr so the user can
# correlate post-upgrade hiccups. Failures fall through to whatever the
# next launch attempt sees; no fatal exit.
_refresh_profile_binary_if_stale() {
    [[ -z "$profile_suffix" ]] && return 0
    [[ -n "${CLAUDE_APPIMAGE_PATH:-}" ]] && return 0
    local profile_bin="$HOME/.local/lib/claude-desktop/${APP_ID}${profile_suffix}"
    [[ -e "$profile_bin" ]] || return 0  # not yet --create-profile'd
    local canonical
    canonical="$(_canonical_electron_bin)" || return 0  # no system install? bail

    local need_refresh=0 reason=""
    if [[ ! -x "$profile_bin" ]]; then
        need_refresh=1; reason="per-profile binary not executable (Nix store moved?)"
    elif [[ "$canonical" -nt "$profile_bin" ]]; then
        need_refresh=1; reason="canonical Electron is newer (package upgrade?)"
    elif [[ "$(readlink "$(dirname "$profile_bin")/resources" 2>/dev/null || true)" \
            != "$(dirname "$canonical")/resources" ]]; then
        need_refresh=1; reason="per-profile files mirror a different install than $(dirname "$canonical")"
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

    # Materialise beside the old binary and rename over it, so a refresh that
    # fails leaves the working binary in place. Deleting first meant a full disk,
    # a quota, or a read-only home turned a stale binary into NO binary - and
    # since the deletion outlives the launch, every later launch lost the
    # per-profile identity too and --create-profile refused to repair it.
    local _staged="${profile_bin}.new.$$"
    rm -f "$_staged"
    if ! _materialise_profile_binary "$canonical" "$_staged"; then
        echo >&2 "claude-desktop: could not refresh the per-profile binary; keeping the existing one for this launch"
        return 1
    fi
    if ! mv -f "$_staged" "$profile_bin"; then
        rm -f "$_staged"
        echo >&2 "claude-desktop: could not replace the per-profile binary; keeping the existing one for this launch"
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
    # $ELECTRON_BIN, not $CLAUDE_ELECTRON: the latter is the raw env var, which
    # is unset unless the AppImage AppRun exported it, and a bare expansion of an
    # unset name is fatal under `set -u` - which aborted --integrate after the
    # .desktop was written but before the claude:// handler was registered.
    local here="${ELECTRON_BIN%/*}"
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

    # The AppImage's Electron tree is a FUSE mount at a new path every run, so a
    # per-profile copy of it would break from the second launch. --profile=NAME
    # still isolates the profile's state without one.
    if [[ -n "${CLAUDE_APPIMAGE_PATH:-}" ]]; then
        echo >&2 "claude-desktop: --create-profile is not available in the AppImage (its files move on every launch)."
        echo >&2 "  Run the AppImage with --profile=$name instead: the profile gets its own login, logs and settings,"
        echo >&2 "  and shares the default profile's taskbar entry."
        return 1
    fi

    # launcher_path is what the entry points run: a path, or on a wrapped
    # install (Nix) the wrapper's bare command name. See _resolve_launcher_self.
    local launcher_path launcher_target
    if ! launcher_path="$(_resolve_launcher_self "$0")"; then
        echo >&2 "claude-desktop: cannot resolve launcher path ($0)"
        return 1
    fi
    if [[ "$launcher_path" == */* ]]; then
        launcher_target="$launcher_path"
    else
        launcher_target="$(type -P "$launcher_path")"
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

    # The per-profile command. A symlink named claude-desktop-<name> selects the
    # profile through the launcher's own basename, which only works when the
    # launcher sees that name. A package wrapper (Nix makeWrapper) execs the
    # launcher by its store path and hides it, so wrapped installs get a
    # two-line script that passes --profile explicitly instead.
    if [[ -n "${CLAUDE_LAUNCHER:-}" && "$launcher_path" == "$CLAUDE_LAUNCHER" ]]; then
        printf '#!/bin/sh\nexec %q --profile=%q "$@"\n' "$launcher_target" "$name" > "$launcher_link"
        chmod +x "$launcher_link"
    else
        ln -s "$launcher_target" "$launcher_link"
    fi

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

# Credential-store probes. Defined HERE, well above the password-store
# decision further down, because --diagnose answers from the argv case and
# returns long before that block is ever reached: a function defined after
# the case would not exist yet when --diagnose calls it.
_secret_service_available() {
    # Owned or activatable org.freedesktop.secrets on the session bus.
    # busctl list shows both running and activatable names.
    #
    # Each probe falls through to the next when it cannot answer: busctl being
    # installed is not the same as busctl reaching the bus, and treating "the
    # first tool we found said no" as the answer would report a keyring-less
    # session on a machine that has one.
    if command -v busctl &>/dev/null; then
        busctl --user --no-pager list 2>/dev/null \
            | grep -q '^org\.freedesktop\.secrets\b' && return 0
    fi
    if command -v dbus-send &>/dev/null; then
        {
            dbus-send --session --print-reply --dest=org.freedesktop.DBus \
                /org/freedesktop/DBus org.freedesktop.DBus.ListNames 2>/dev/null
            dbus-send --session --print-reply --dest=org.freedesktop.DBus \
                /org/freedesktop/DBus org.freedesktop.DBus.ListActivatableNames 2>/dev/null
        } | grep -q '"org\.freedesktop\.secrets"' && return 0
    fi
    if command -v gdbus &>/dev/null; then
        gdbus call --session --dest org.freedesktop.DBus \
            --object-path /org/freedesktop/DBus \
            --method org.freedesktop.DBus.ListActivatableNames 2>/dev/null \
            | grep -q 'org\.freedesktop\.secrets' && return 0
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
    #
    # Each tool falls through to the next, like _secret_service_available: an
    # installed busctl that cannot reach the bus (no systemd user bus) says
    # "no" about every name, and that must not end the probe. A probe that ran
    # into its 5 s timeout DID reach kwalletd (it hung, see above), so the other
    # tools would only hang the same way: that version is settled as "no".
    local _v _svc _obj _t0 _probed=0
    for _v in 6 5; do
        _svc="org.kde.kwalletd${_v}"
        _obj="/modules/kwalletd${_v}"
        if command -v busctl &>/dev/null; then
            _probed=1; _t0=$SECONDS
            busctl --user --no-pager --timeout=5 call \
                "$_svc" "$_obj" org.kde.KWallet wallets &>/dev/null && return 0
            (( SECONDS - _t0 < 4 )) || continue
        fi
        if command -v dbus-send &>/dev/null; then
            _probed=1; _t0=$SECONDS
            dbus-send --session --print-reply --reply-timeout=5000 \
                --dest="$_svc" "$_obj" org.kde.KWallet.wallets &>/dev/null && return 0
            (( SECONDS - _t0 < 4 )) || continue
        fi
        if command -v gdbus &>/dev/null; then
            _probed=1
            gdbus call --session --timeout 5 --dest "$_svc" \
                --object-path "$_obj" --method org.kde.KWallet.wallets &>/dev/null && return 0
        fi
    done
    # No way to probe - keep Chromium's KDE default untouched.
    (( _probed )) || return 0
    return 1
}

# The password-store decision, asked as a question so that both the launch path
# and --diagnose get the same answer from one implementation. Sets three globals
# rather than echoing, because the reason has to survive alongside the verdict:
#
#   _pw_state   native    Chromium already maps this desktop to a real keyring
#               libsecret Chromium would pick nothing usable, but a Secret
#                         Service is on the bus - force gnome-libsecret
#               none      no keyring at all; Chromium falls back to basic_text,
#                         safeStorage reports encryption unavailable and the
#                         sign-in does not survive a restart
#   _pw_detail  the sentence explaining that verdict
#   _pw_note    the kwallet fallback note, or empty
#
# It does NOT honour an explicit --password-store argument or
# CLAUDE_PASSWORD_STORE; those are handled by the caller, which is why
# --diagnose reports them separately.
_pw_state=''
_pw_detail=''
_pw_note=''
_pw_store_detect() {
    _pw_note=''
    local _de_keyring_native='' _de_is_kde='' _de
    local -a _de_parts
    # Skip desktops Chromium already maps to a keyring backend (GNOME-family ->
    # libsecret, KDE -> kwallet). KDE is verified below, since that mapping is a
    # dead end without kwalletd.
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
        _pw_note="kwalletd does not answer on the session bus - KDE's kwallet backend would yield no encryption, falling back to Secret Service detection"
        _de_keyring_native=''
    fi
    if [[ -n "$_de_keyring_native" ]]; then
        _pw_state='native'
        _pw_detail="XDG_CURRENT_DESKTOP='${XDG_CURRENT_DESKTOP:-}' already gets a keyring backend from Chromium"
        return 0
    fi
    if _secret_service_available; then
        _pw_state='libsecret'
        _pw_detail="Secret Service detected on session bus; XDG_CURRENT_DESKTOP='${XDG_CURRENT_DESKTOP:-}' gets no keyring backend from Chromium - adding --password-store=gnome-libsecret"
        return 0
    fi
    _pw_state='none'
    _pw_detail="no org.freedesktop.secrets provider on the session bus (XDG_CURRENT_DESKTOP='${XDG_CURRENT_DESKTOP:-}') - sign-in will NOT persist across restarts; install and unlock a keyring (gnome-keyring, kwalletd, KeePassXC) and relaunch"
    return 0
}

# ---------------------------------------------------------------------------
# --diagnose helpers: probe the host the way the APP does
# ---------------------------------------------------------------------------
# Each helper prints one report line and, when the finding breaks a feature on
# THIS session, appends a sentence to the caller's _diag_problems array (bash
# dynamic scoping: _diagnose declares it local). Absolute paths are arguments
# rather than literals so the harness can point them at fake tools.

# Does the app treat this session as Wayland? Same test as upstream's own
# (XDG_SESSION_TYPE when set and non-empty, else WAYLAND_DISPLAY), applied to
# the value the launcher hands the app, i.e. after _normalize_session_type.
_diag_app_is_wayland() {
    if [[ -n "${XDG_SESSION_TYPE:-}" ]]; then
        [[ "$XDG_SESSION_TYPE" == 'wayland' ]]
    else
        [[ -n "${WAYLAND_DISPLAY:-}" ]]
    fi
}

# Resolve a host tool the way the patched app does: the literal upstream path
# when that file exists (fs.existsSync, not an exec check), else the bare name
# for PATH lookup. Echoes the command the app will exec.
_diag_app_tool_cmd() {
    local abs="$1" name="$2"
    if [[ -e "$abs" ]]; then echo "$abs"; else echo "$name"; fi
}

# One host tool.
#   $1 mode: fallback = upstream execs $3, our patch falls back to PATH
#            abs      = only the literal $3 works (nothing falls back)
#            path     = resolved through PATH
#   $2 tool name, $3 absolute path (or ''), $4 1 = this session needs it,
#   $5 what it is for, $6 consequence when it is missing
_diag_cap() {
    local mode="$1" name="$2" abs="$3" needed="$4" what="$5" miss="$6" p=''
    case "$mode" in
        fallback)
            if [[ -e "$abs" ]]; then
                echo "[ok]   $name = $abs (upstream path) - $what"; return 0
            fi
            p="$(command -v "$name" 2>/dev/null || true)"
            if [[ -n "$p" ]]; then
                echo "[ok]   $name = $p (not at $abs; works through our PATH fallback) - $what"; return 0
            fi
            ;;
        abs)
            if [[ -x "$abs" ]]; then
                echo "[ok]   $name = $abs - $what"; return 0
            fi
            p="$(command -v "$name" 2>/dev/null || true)"
            [[ -n "$p" ]] && miss="$miss (found $p, but only $abs is used)"
            ;;
        path)
            p="$(command -v "$name" 2>/dev/null || true)"
            if [[ -n "$p" ]]; then
                echo "[ok]   $name = $p - $what"; return 0
            fi
            ;;
    esac
    if [[ "$needed" == 1 ]]; then
        echo "[MISS] $name = MISSING - $miss"
        _diag_problems+=("$name missing: $miss")
    else
        echo "[--]   $name = missing, not needed on this session - $what"
    fi
}

# Does NAME have an owner on the bus? $1 = session|system. Echoes
# present / absent / unknown. Same tools, order and parsing as
# js/tray_host_probe.js: a tool that is missing or cannot answer falls through.
_diag_bus_owner() {
    local bus="$1" name="$2" out
    local ubus='--user' dbus='--session'
    [[ "$bus" == system ]] && { ubus='--system'; dbus='--system'; }
    if command -v busctl &>/dev/null; then
        out="$(timeout 3 busctl "$ubus" --no-pager --timeout=2 call org.freedesktop.DBus \
            /org/freedesktop/DBus org.freedesktop.DBus NameHasOwner s "$name" 2>/dev/null || true)"
        [[ "$out" =~ ^b\ +true ]] && { echo present; return 0; }
        [[ "$out" =~ ^b\ +false ]] && { echo absent; return 0; }
    fi
    if command -v dbus-send &>/dev/null; then
        out="$(timeout 3 dbus-send "$dbus" --print-reply --reply-timeout=2000 \
            --dest=org.freedesktop.DBus /org/freedesktop/DBus \
            org.freedesktop.DBus.NameHasOwner "string:$name" 2>/dev/null || true)"
        [[ "$out" =~ boolean\ +true ]] && { echo present; return 0; }
        [[ "$out" =~ boolean\ +false ]] && { echo absent; return 0; }
    fi
    if command -v gdbus &>/dev/null; then
        out="$(timeout 3 gdbus call "$dbus" --timeout 2 --dest org.freedesktop.DBus \
            --object-path /org/freedesktop/DBus \
            --method org.freedesktop.DBus.NameHasOwner "$name" 2>/dev/null || true)"
        [[ "$out" =~ ^\(true ]] && { echo present; return 0; }
        [[ "$out" =~ ^\(false ]] && { echo absent; return 0; }
    fi
    echo unknown
}

# The app's GlobalShortcuts portal probe, argument for argument: upstream
# (2.7032.0, the function behind "[globalShortcut] GlobalShortcuts portal
# availability") runs `busctl --user --timeout=2 get-property
# org.freedesktop.portal.Desktop /org/freedesktop/portal/desktop
# org.freedesktop.portal.GlobalShortcuts version` with a 3 s exec timeout and
# calls the portal available when stdout matches /\bu\s+\d+/.
# $1 = the busctl command the app resolves. Echoes "yes <version>" or
# "no (<reason>)".
_diag_portal_probe_app() {
    local out rc=0
    out="$(timeout 3 "$1" --user --timeout=2 get-property org.freedesktop.portal.Desktop \
        /org/freedesktop/portal/desktop org.freedesktop.portal.GlobalShortcuts version 2>&1)" || rc=$?
    if [[ "$rc" == 0 && "$out" =~ (^|[^[:alnum:]_])u[[:space:]]+([0-9]+) ]]; then
        echo "yes ${BASH_REMATCH[2]}"
    elif [[ "$rc" == 124 ]]; then
        echo "no (no answer within 3 s)"
    elif [[ "$rc" == 126 || "$rc" == 127 ]]; then
        echo "no (cannot exec $1)"
    else
        echo "no ($(printf '%s\n' "$out" | head -1))"
    fi
}

# Runs-at-all check for one Computer Use bridge, the one js/cu_mode_preamble.js
# makes before selecting it: `--version` must exit 0 within 3 s. Echoes
# "ok <version line>" or "FAIL <cause>[ - <hint>]" with the preamble's hints.
# The causes are read from the exec error text: timeout's execvp retries an
# ENOEXEC file through /bin/sh, which reports "cannot execute binary file".
_diag_bridge_runs() {
    local bin="$1" env_var="$2" out rc=0 hint='' cause first
    out="$(timeout -s KILL 3 "$bin" --version 2>&1 </dev/null)" || rc=$?
    if [[ "$rc" == 0 ]]; then
        echo "ok $(printf '%s\n' "$out" | head -1)"; return 0
    fi
    first="$(printf '%s\n' "$out" | sed '/^[[:space:]]*$/d' | head -1)"
    if [[ "$rc" == 137 || "$rc" == 124 ]]; then
        cause="no answer to --version within 3 s"; hint="the bridge hangs at startup"
    elif [[ "$rc" == 126 || "$rc" == 127 ]] && [[ "$out" == *'Exec format error'* || "$out" == *'cannot execute binary file'* ]]; then
        cause="exec format error"; hint="the binary was built for another CPU architecture than this $(uname -m) system"
    elif [[ "$rc" == 126 || "$rc" == 127 ]] && [[ "$out" == *'Permission denied'* ]]; then
        cause="permission denied"; hint="the file system is mounted noexec, or the file is not executable"
    elif [[ "$rc" == 126 || "$rc" == 127 ]] && [[ "$out" == *'required file not found'* || "$out" == *'No such file or directory'* || "$out" == *'bad interpreter'* ]]; then
        cause="exec failed with ENOENT although the file exists"
        hint="its ELF interpreter (dynamic loader) is missing - a binary built for another distro. On NixOS set $env_var to a Nix-built bridge, or enable programs.nix-ld"
    else
        cause="exit $rc${first:+: $first}"
        if [[ "$out" =~ pw_stream_get_nsec|libpipewire ]]; then
            hint="needs PipeWire >= 1.0.5 (Ubuntu 24.04+, Fedora 40+, Debian 13+); this system's PipeWire is older or missing"
        elif [[ "$out" =~ GLIBC_([0-9]+\.[0-9]+) ]]; then
            hint="needs glibc >= ${BASH_REMATCH[1]}; this system's glibc is older (the gnome/kwin bridges need Ubuntu 24.04+, Fedora 40+, Debian 13+)"
        elif [[ "$out" =~ error\ while\ loading\ shared\ libraries:\ ([^:[:space:]]+) ]]; then
            hint="missing shared library ${BASH_REMATCH[1]} - install the distro package that provides it"
        elif [[ "$out" =~ symbol\ lookup\ error|undefined\ symbol ]]; then
            hint="a system library is older than the one the bridge was built against"
        fi
    fi
    echo "FAIL $cause${hint:+ - $hint}"
}

_diagnose() {
    local -a _diag_problems=()
    echo '=== claude-desktop --diagnose ==='
    echo
    echo '--- Session ---'
    # _normalize_session_type has already run: this is the value the app gets.
    # The raw one is what the session exported, before the launcher fixed it.
    echo "XDG_SESSION_TYPE = ${XDG_SESSION_TYPE:-(unset)} (as passed to the app; raw from the session: ${_cdb_raw_session_type:-(unset)})"
    echo "XDG_CURRENT_DESKTOP = ${XDG_CURRENT_DESKTOP:-(unset)}"
    # XDG_SESSION_DESKTOP is DM-dependent (SDDM/GDM may set plasma / an absolute
    # path / nothing) and is NOT what our CU DE-detection keys off — we use
    # XDG_CURRENT_DESKTOP. Surfaced here so a mismatch between the two is visible
    # when triaging KDE-Wayland routing reports (issue #194).
    echo "XDG_SESSION_DESKTOP = ${XDG_SESSION_DESKTOP:-(unset)}"
    # The mode is resolved from env/flag OR the extra config before the launch
    # flow reaches here, so ${_titlebar_source} / ${_no_controls_source} name
    # where it actually came from.
    # The saved switches are read by the APP, from its own userData dir; they are
    # reported here so a triage log shows what is stored next to what is forced.
    # No single filename here: the two files are merged PER KEY, so naming one
    # would misreport where a value came from. List what was read instead.
    local _files=''
    [[ -n "${_cdb_extra_jsonc:-}" ]] && _files="claude-desktop-extra.jsonc"
    [[ -n "${_cdb_extra_json:-}" ]] && _files="${_files:+$_files + }claude-desktop-extra.json"
    echo "Extra config read = ${_files:-(none present)} in $config_dir"
    echo "Saved nativeTitlebar = $([[ -n "${_saved_native:-}" ]] && echo true || echo false)"
    echo "Saved noWindowControls = $([[ -n "${_saved_no_controls:-}" ]] && echo true || echo false)"
    if [[ "${CLAUDE_NATIVE_TITLEBAR:-}" == '1' ]]; then
        echo "Titlebar = native (${_titlebar_source:-CLAUDE_NATIVE_TITLEBAR=1})"
    elif [[ "${CLAUDE_NO_WINDOW_CONTROLS:-}" == '1' ]]; then
        echo "Titlebar = frameless, no window controls (${_no_controls_source:-CLAUDE_NO_WINDOW_CONTROLS=1})"
    elif [[ -n "${CLAUDE_NATIVE_TITLEBAR:-}" || -n "${CLAUDE_NO_WINDOW_CONTROLS:-}" ]]; then
        # Set but not to "1" - an explicit off, which the app honours as an
        # override in its own right, so it is not "no override set".
        echo "Titlebar = forced OFF by CLAUDE_NATIVE_TITLEBAR='${CLAUDE_NATIVE_TITLEBAR:-}' CLAUDE_NO_WINDOW_CONTROLS='${CLAUDE_NO_WINDOW_CONTROLS:-}' (overrides any saved switch)"
    elif [[ -n "${_saved_native:-}" || -n "${_saved_no_controls:-}" ]]; then
        # No override, but a switch IS stored - say so rather than reporting
        # "integrated", which is what the launcher sees and not what will open.
        echo "Titlebar = decided by the app from the saved switch above (no override set)"
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
    # Without a keyring Chromium falls back to basic_text, safeStorage reports
    # encryption unavailable and the sign-in does not survive a restart - the
    # app then goes through /login on every launch. That is invisible from the
    # outside, so name the backend, the probes behind it and the override that
    # would change it.
    echo '--- Credential store ---'
    local _pw_forced='' _pw_arg
    for _pw_arg in "$@"; do
        [[ "$_pw_arg" == --password-store=* ]] && _pw_forced="$_pw_arg"
    done
    echo "CLAUDE_PASSWORD_STORE = ${CLAUDE_PASSWORD_STORE:-(unset)}"
    echo "org.freedesktop.secrets on session bus = $(_secret_service_available && echo yes || echo no)"
    echo "kwalletd answers on session bus = $(_kwallet_available && echo yes || echo no)"
    if [[ -n "$_pw_forced" ]]; then
        echo "Detection = SKIPPED (explicit $_pw_forced on the command line wins)"
    elif [[ "${CLAUDE_PASSWORD_STORE:-}" == 'auto' ]]; then
        echo "Detection = DISABLED (CLAUDE_PASSWORD_STORE=auto - Chromium chooses)"
    elif [[ -n "${CLAUDE_PASSWORD_STORE:-}" ]]; then
        echo "Detection = OVERRIDDEN (--password-store=${CLAUDE_PASSWORD_STORE})"
    else
        _pw_store_detect
        [[ -n "$_pw_note" ]] && echo "Note: $_pw_note"
        case "$_pw_state" in
            native)    echo "Verdict = no flag added; $_pw_detail" ;;
            libsecret) echo "Verdict = --password-store=gnome-libsecret; $_pw_detail" ;;
            none)      echo "Verdict = NO KEYRING - $_pw_detail" ;;
        esac
    fi
    echo
    echo '--- xdg-desktop-portal GlobalShortcuts ---'
    # The app's own probe decides whether Wayland global shortcuts (Quick
    # Entry) are even attempted: when it says no, every registration returns
    # registration-failed before Electron is asked. Run it exactly the way the
    # app does, with the busctl the app resolves, then cross-check with gdbus.
    local _app_busctl _app_portal _gd_portal='' _gd_ver=''
    _app_busctl="$(_diag_app_tool_cmd /usr/bin/busctl busctl)"
    _app_portal="$(_diag_portal_probe_app "$_app_busctl")"
    if _diag_app_is_wayland; then
        echo "App probe (runs on this session) = $_app_portal [via $_app_busctl]"
    else
        echo "App probe = $_app_portal [via $_app_busctl] - not used: the app skips it when XDG_SESSION_TYPE is not wayland (X11 key grabs instead)"
    fi
    if command -v gdbus &>/dev/null; then
        _gd_portal=$(timeout 5 gdbus call --session --dest org.freedesktop.portal.Desktop \
            --object-path /org/freedesktop/portal/desktop \
            --method org.freedesktop.DBus.Properties.Get \
            org.freedesktop.portal.GlobalShortcuts version 2>&1 || true)
        echo "gdbus cross-check = $(printf '%s\n' "${_gd_portal:-(no output)}" | head -1)"
        [[ "$_gd_portal" =~ uint32\ ([0-9]+) ]] && _gd_ver="${BASH_REMATCH[1]}"
        if [[ -n "$_gd_ver" && "$_app_portal" != yes* ]]; then
            echo "  DISAGREE: gdbus reaches the portal (version $_gd_ver) but the app's busctl probe does not - the app will treat the portal as missing"
        elif [[ -z "$_gd_ver" && "$_app_portal" == yes* ]]; then
            echo "  DISAGREE: the app's busctl probe answers but gdbus does not - the app's verdict is the one that counts"
        fi
    else
        echo 'gdbus cross-check = (gdbus not installed)'
    fi
    if _diag_app_is_wayland && [[ "$_app_portal" != yes* ]]; then
        _diag_problems+=("GlobalShortcuts portal probe fails the way the app runs it ($_app_portal): Wayland global shortcuts and the Quick Entry hotkey are disabled; bind claude-desktop --toggle in your compositor instead")
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
    # Runs-at-all: the same `--version` check js/cu_mode_preamble.js makes
    # before it selects a bridge, resolved the same way (the *_BRIDGE_BIN
    # override when executable, else resources/). A bridge the app would not
    # consult on this session is still checked, but only reported.
    local _cu_desk _cu_wl='' _cu_bin _cu_env _cu_use _cu_run
    _cu_desk="$(printf %s "${XDG_CURRENT_DESKTOP:-}" | tr '[:upper:]' '[:lower:]')"
    [[ "${XDG_SESSION_TYPE:-}" == 'wayland' || -n "${WAYLAND_DISPLAY:-}" ]] && _cu_wl=1
    for _cu_b in x11-bridge wlroots-bridge gnome-portal-bridge kwin-portal-bridge; do
        case "$_cu_b" in
            x11-bridge)          _cu_env=X11_BRIDGE_BIN
                                 _cu_use=''; [[ -n "$_cu_wl" || -n "${DISPLAY:-}" || "${XDG_SESSION_TYPE:-}" == x11 ]] && _cu_use=1 ;;
            wlroots-bridge)      _cu_env=WLROOTS_BRIDGE_BIN
                                 _cu_use=''; [[ -n "$_cu_wl" && ( -n "${SWAYSOCK:-}" || -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" || -n "${NIRI_SOCKET:-}" ) ]] && _cu_use=1 ;;
            gnome-portal-bridge) _cu_env=GNOME_PORTAL_BRIDGE_BIN
                                 _cu_use=''; [[ -n "$_cu_wl" && "$_cu_desk" == *gnome* ]] && _cu_use=1 ;;
            kwin-portal-bridge)  _cu_env=KWIN_PORTAL_BRIDGE_BIN
                                 _cu_use=''; [[ -n "$_cu_wl" && "$_cu_desk" == *kde* ]] && _cu_use=1 ;;
        esac
        _cu_bin="${!_cu_env:-}"
        [[ -n "$_cu_bin" && -x "$_cu_bin" ]] || _cu_bin="$_cu_res/$_cu_b"
        if [[ ! -x "$_cu_bin" ]]; then
            echo "$_cu_b runs = MISSING ($_cu_bin)"
            [[ -n "$_cu_use" ]] && _diag_problems+=("$_cu_b missing at $_cu_bin: Computer Use cannot use it on this session - reinstall the package")
            continue
        fi
        _cu_run="$(_diag_bridge_runs "$_cu_bin" "$_cu_env")"
        if [[ "$_cu_run" == ok* ]]; then
            echo "$_cu_b runs = ${_cu_run}${_cu_use:+ (used on this session)}"
        else
            echo "$_cu_b runs = CANNOT RUN - ${_cu_run#FAIL }${_cu_use:+ (used on this session)}"
            [[ -n "$_cu_use" ]] && _diag_problems+=("$_cu_b at $_cu_bin cannot run: ${_cu_run#FAIL }")
        fi
    done
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
        _diag_problems+=("Cowork VM unavailable: the capability probe would fail (see the Cowork section: qemu, firmware, virtiofsd, /dev/kvm, /dev/vhost-vsock)")
    fi
    echo
    echo '--- Host capabilities (what the app execs, resolved the way it does) ---'
    # One line per host tool: found at the upstream path, found on PATH only
    # (works through our fallback patch), or MISSING with what breaks. A tool
    # this session does not need is listed but not counted as a problem.
    local _hc_wl='' _hc_desk _hc_ss='' _hc_kw='' _hc_py=1 _hc_owner _hc_n
    _diag_app_is_wayland && _hc_wl=1
    _hc_desk="$(printf %s "${XDG_CURRENT_DESKTOP:-}" | tr '[:upper:]' '[:lower:]')"
    _secret_service_available && _hc_ss=1
    [[ "$_hc_desk" == *kde* ]] && _kwallet_available && _hc_kw=1
    command -v python3 &>/dev/null || _hc_py=0
    _diag_cap fallback busctl /usr/bin/busctl "$([[ -n $_hc_wl || $_hc_desk == *kde* ]] && echo 1 || echo 0)" \
        'GlobalShortcuts portal probe (Wayland hotkeys / Quick Entry) and KDE kwalletd pre-flight' \
        'the app reads "no GlobalShortcuts portal": Wayland global shortcuts and the Quick Entry hotkey are disabled'
    if [[ ! -e /usr/bin/busctl && "$_hc_desk" == *kde* ]]; then
        echo '       note: the pre-launch KWallet "no wallet" check (index.pre.js) only runs /usr/bin/busctl and is skipped here'
    fi
    _diag_cap fallback secret-tool /usr/bin/secret-tool "${_hc_ss:-0}" \
        'Chrome cookie import from the GNOME keyring / libsecret' \
        'Chrome cookie import skips keyring-encrypted cookies (install libsecret-tools / libsecret)'
    _diag_cap fallback kwallet-query /usr/bin/kwallet-query "${_hc_kw:-0}" \
        'Chrome cookie import from KWallet' \
        'Chrome cookie import skips KWallet-encrypted cookies (install kwallet / kwalletmanager)'
    _diag_cap fallback sqlite3 /usr/bin/sqlite3 1 \
        'Recent Projects (reads the editors'"'"' state databases)' \
        'Recent Projects stays empty (install sqlite3 / sqlite)'
    _diag_cap path xdg-open '' 1 \
        'opening links and "Open in" targets' \
        'links and "Open in ..." do nothing (install xdg-utils)'
    _diag_cap abs gjs /usr/bin/gjs "$([[ $_hc_desk == *gnome* ]] && echo 1 || echo 0)" \
        'GNOME Shell search provider (Activities search)' \
        'the GNOME search provider cannot start; Claude results never appear in Activities search (install gjs)'
    _diag_cap path python3 '' 1 \
        'launcher: --install-gnome-hotkey, --1p/--3p, --toggle fallback client' \
        '--install-gnome-hotkey and --1p/--3p fail (install python3)'
    _diag_cap path socat '' "$(( _hc_py == 0 ))" \
        'launcher: fast socket client for --toggle / --reload-theme (python3 also works)' \
        'with no python3 either, --toggle / --reload-theme cannot reach a running app over its socket (install socat or python3)'
    # Keep awake: only needed when no desktop service owns the inhibit call
    # Chromium makes (fix_keep_awake_linux / js/keep_awake_inhibit.js).
    local _hc_native=''
    for _hc_n in org.gnome.SessionManager org.freedesktop.PowerManagement; do
        [[ "$(_diag_bus_owner session "$_hc_n")" == present ]] && { _hc_native="$_hc_n"; break; }
    done
    if [[ -n "$_hc_native" ]]; then
        echo "[--]   systemd-inhibit = not needed: $_hc_native handles \"Keep computer awake\""
    else
        _diag_cap path systemd-inhibit '' 1 \
            'logind idle inhibitor for "Keep computer awake" (no org.gnome.SessionManager / org.freedesktop.PowerManagement on this bus)' \
            '"Keep computer awake" does nothing on this session (needs systemd-logind)'
    fi
    # Tray host (js/tray_host_probe.js asks the same question).
    _hc_owner="$(_diag_bus_owner session org.kde.StatusNotifierWatcher)"
    case "$_hc_owner" in
        present) echo '[ok]   tray host = org.kde.StatusNotifierWatcher on the session bus - close-to-tray and hidden autostart work' ;;
        absent)
            if [[ -n "$_hc_wl" ]]; then
                echo '[MISS] tray host = no org.kde.StatusNotifierWatcher - on Wayland closing the window quits and an autostart launch shows the window (install AppIndicator support or a tray-capable bar)'
                _diag_problems+=('no tray host (org.kde.StatusNotifierWatcher) on this Wayland session: closing the window quits the app and autostart shows the window instead of starting hidden')
            else
                echo '[--]   tray host = no org.kde.StatusNotifierWatcher; on X11 Electron falls back to an XEmbed tray icon (works with an XEmbed tray such as xfce4-panel, tint2, i3bar)'
            fi
            ;;
        *) echo '[??]   tray host = unknown (no bus tool could answer); the app keeps upstream tray behavior' ;;
    esac
    # Bluetooth: Chromium's Web Bluetooth talks to BlueZ (org.bluez, system bus).
    _hc_owner="$(_diag_bus_owner system org.bluez)"
    if [[ "$_hc_owner" == present ]]; then
        echo '[ok]   bluetoothd = org.bluez on the system bus - Hardware Buddy BLE scan'
    else
        local _hc_bt=''
        for _hc_n in /usr/lib/bluetooth/bluetoothd /usr/libexec/bluetooth/bluetoothd /usr/sbin/bluetoothd; do
            [[ -x "$_hc_n" ]] && { _hc_bt="$_hc_n"; break; }
        done
        if [[ -n "$_hc_bt" ]]; then
            echo "[--]   bluetoothd = installed ($_hc_bt) but org.bluez is $_hc_owner on the system bus - only needed for a Hardware Buddy (systemctl enable --now bluetooth)"
        else
            echo '[--]   bluetoothd = missing - only needed for a Hardware Buddy (BLE scan finds nothing without BlueZ)'
        fi
    fi
    echo "[..]   qemu / firmware / virtiofsd = see the Cowork section above"
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
    echo
    echo '--- Problems found ---'
    if (( ${#_diag_problems[@]} == 0 )); then
        echo 'none'
    else
        local _p
        for _p in "${_diag_problems[@]}"; do echo "- $_p"; done
    fi
}

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

# The two blocks below write to disk (a per-profile binary refresh can copy
# ~200 MB into ~/.local/lib; the AppImage integration writes a .desktop file
# and an icon). They sit AFTER the subcommand case so --help and the other
# early-exit subcommands never run them, and they skip --diagnose, which is
# deferred past this point but is a read-only report as well.

# ---------------------------------------------------------------------------
# Per-profile binary maintenance (runs once per launch, named profiles only)
# ---------------------------------------------------------------------------

# Auto-heal stale per-profile installs after package upgrades or NixOS rebuilds.
# Also refresh ELECTRON_BIN if path discovery had to fall back to the canonical
# (e.g. dangling per-profile from a moved Nix store path) — we want the next
# launch step to use the freshly materialised per-profile binary so WM_CLASS /
# Wayland app_id reflect the profile.
# The AppImage never uses a per-profile binary (see _refresh_profile_binary_if_stale).
if [[ -z "${_diagnose_requested:-}" && -n "$profile_suffix" && -z "${CLAUDE_APPIMAGE_PATH:-}" ]]; then
    _refresh_profile_binary_if_stale || true
    _profile_bin="$HOME/.local/lib/claude-desktop/${APP_ID}${profile_suffix}"
    if [[ -x "$_profile_bin" ]]; then
        ELECTRON_BIN="$_profile_bin"
    elif [[ "$ELECTRON_BIN" == "$_profile_bin" ]]; then
        # The per-profile binary was chosen during resolution but is not usable
        # now. Launching it would exec a path that is not there, so fall back to
        # the canonical binary: the profile keeps its isolated state and only the
        # per-profile WM identity is lost for this launch.
        ELECTRON_BIN=''
        for candidate in "/usr/lib/claude-desktop/${APP_ID}" "/usr/lib/claude-desktop-bin/${APP_ID}"; do
            [[ -x "$candidate" ]] && { ELECTRON_BIN="$candidate"; break; }
        done
        if [[ -n "$ELECTRON_BIN" ]]; then
            echo >&2 "claude-desktop: per-profile binary unavailable, using $ELECTRON_BIN for this launch"
            log "per-profile binary unavailable; falling back to $ELECTRON_BIN"
        fi
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
if [[ -z "${_diagnose_requested:-}" && -n "${CLAUDE_APPIMAGE_PATH:-}" ]]; then
    _appimage_integrate quiet || true
fi

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

# --diagnose is exempt: it is deferred to after this point (it needs
# platform_mode and electron_major), and it is the one subcommand people run
# over SSH or from a VT precisely because the GUI will not come up.
if [[ -z "${_diagnose_requested:-}" && -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
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
#
# Sets platform_mode to x11, wayland or xwayland. XWayland is only possible
# when an X server is actually there, and $DISPLAY is the one honest signal for
# that - not the compositor's name. Niri has no built-in XWayland but runs
# xwayland-satellite, which exports DISPLAY; a compositor without any XWayland
# leaves it unset, and --ozone-platform=x11 with no DISPLAY opens no window.
_resolve_platform_mode() {
    platform_mode=x11
    [[ -n "${WAYLAND_DISPLAY:-}" ]] || return 0
    platform_mode=wayland
    if [[ "${CLAUDE_USE_XWAYLAND:-}" == '1' ]]; then
        if [[ -n "${DISPLAY:-}" ]]; then
            platform_mode=xwayland
        else
            log 'CLAUDE_USE_XWAYLAND=1 ignored: DISPLAY is unset, so there is no XWayland server (on Niri, start xwayland-satellite)'
        fi
    fi
}

# A compositor started from a TTY (sway, Hyprland, niri run by hand or from a
# login shell) often leaves XDG_SESSION_TYPE=tty, or unset, while
# WAYLAND_DISPLAY is live. The app and its Computer Use backends read
# XDG_SESSION_TYPE to pick a Wayland or X11 path, so align it with the socket
# that is actually there. An explicit x11 is left alone.
_normalize_session_type() {
    [[ -n "${WAYLAND_DISPLAY:-}" ]] || return 0
    case "${XDG_SESSION_TYPE:-}" in
        wayland|x11) return 0 ;;
    esac
    log "XDG_SESSION_TYPE='${XDG_SESSION_TYPE:-}' with WAYLAND_DISPLAY set: exporting XDG_SESSION_TYPE=wayland"
    export XDG_SESSION_TYPE=wayland
}

_cdb_raw_session_type="${XDG_SESSION_TYPE:-}"  # for --diagnose
_normalize_session_type
platform_mode=x11
_resolve_platform_mode
if [[ "$platform_mode" != x11 ]] && (( electron_major > 0 && electron_major < 40 )); then
    warn_msg="Electron $electron_major has a broken GlobalShortcutsPortal (electron/electron#49806, fixed in 40+/41+). Global hotkeys will only work when Claude Desktop has focus. Update your Electron package; Arch: sudo pacman -Syu electron. Escape hatch if you can't update: CLAUDE_USE_XWAYLAND=1."
    log "$warn_msg"
    echo >&2 "claude-desktop: $warn_msg"
fi

# ---------------------------------------------------------------------------
# Build Electron arguments
# ---------------------------------------------------------------------------

# Titlebar mode: the launcher only carries an explicitly expressed intent.
#
# Both modes are also Settings -> Extra -> Community toggles, persisted as
# `nativeTitlebar` / `noWindowControls` in <userData>/claude-desktop-extra.json
# (the .jsonc variant wins and locks them). The BrowserWindow patch reads those
# keys itself, from the userData dir the app actually uses, so the launcher does
# not resolve them at all: it passes on `--native-titlebar` /
# `--no-window-controls` and the two environment variables, and nothing else.
#
# The launcher used to read that config too, in order to derive the env vars and
# from them three Chromium arguments. All three are gone from the bundled
# Electron 44 - `--disable-features=CustomTitlebar`,
# `--enable-features=WaylandWindowDecorations` and ELECTRON_USE_SYSTEM_TITLE_BAR
# are not switch, feature or variable names it knows, so they had stopped doing
# anything. What actually opens the native window is `frame:true` in
# patches/linux/fix_native_frame.nim, decided app-side. Reading the config here
# bought nothing and cost a real bug: it read the 1p dir unconditionally, so a
# 3p deployment (userData relocated to <userData>-3p) had its saved switch
# ignored. Leaving the decision entirely to the app fixes that.
#
# An explicitly set env var (or the CLI flag, which sets one) is an override in
# BOTH directions: CLAUDE_NATIVE_TITLEBAR=0 forces the mode off even when the
# saved switch is on. js/window_controls_pref.js reads the variable three-state
# to honour exactly that, and defers to the saved switch when it is unset.
_titlebar_source='CLAUDE_NATIVE_TITLEBAR=1'
_no_controls_source='CLAUDE_NO_WINDOW_CONTROLS=1'

# Echo whichever of the requested keys resolves to boolean true across the two
# config files, $1 (.jsonc) then $2 (.json). The merge is PER KEY, not per file:
# .jsonc wins for a key it defines and .json supplies the rest, which is exactly
# what js/window_controls_pref.js does and what the .jsonc header documents.
# Picking the first file that merely EXISTS was wrong - the .jsonc template ships
# with the app, so its presence hid every switch the Extra panel had written to
# .json. Degrades silently to "no keys": no python3, an unreadable file and
# malformed JSON are all treated as absent, because a broken config file must
# never stop the app from starting. Always returns 0 so `set -e` cannot trip.
_cdb_extra_true_keys() {
    local _jsonc="$1" _json="$2"
    shift 2
    command -v python3 >/dev/null 2>&1 || return 0
    python3 - "$_jsonc" "$_json" "$@" 2>/dev/null <<'PY' || true
import json, sys

paths, keys = sys.argv[1:3], sys.argv[3:]
raws = []
for path in paths:
    if not path:
        raws.append("")
        continue
    try:
        with open(path, encoding="utf-8") as fh:
            raws.append(fh.read())
    except OSError:
        raws.append("")

# Strip // and /* */ comments so the .jsonc variant parses, skipping anything
# inside a string literal so a URL or a Windows path is left intact.
def strip_comments(raw):
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
    return "".join(out)


def parse(raw):
    if not raw:
        return {}
    try:
        data = json.loads(strip_comments(raw))
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


# Index 0 is the .jsonc and wins for any key it defines; index 1 is the .json.
layers = [parse(r) for r in raws]

# `is True` on purpose: only a real JSON `true` counts. The string "true" and
# the number 1 are NOT on, so a hand-edited config cannot half-enable a mode
# here while the app's own boolean read says off.
for key in keys:
    for layer in layers:
        if isinstance(layer.get(key), bool):
            if layer[key] is True:
                print(key)
            break

PY
    return 0
}

# Both files, resolved in THIS shell so the diagnostic can name them (a
# subshell's assignments would be lost). Neither is required.
_cdb_extra_jsonc=''
_cdb_extra_json=''
[[ -f "$config_dir/claude-desktop-extra.jsonc" && -r "$config_dir/claude-desktop-extra.jsonc" ]] \
    && _cdb_extra_jsonc="$config_dir/claude-desktop-extra.jsonc"
[[ -f "$config_dir/claude-desktop-extra.json" && -r "$config_dir/claude-desktop-extra.json" ]] \
    && _cdb_extra_json="$config_dir/claude-desktop-extra.json"
_cdb_extra_src="${_cdb_extra_jsonc:-$_cdb_extra_json}"

_cdb_extra_keys=' '
if [[ -n "$_cdb_extra_jsonc" || -n "$_cdb_extra_json" ]]; then
    _cdb_extra_keys=" $(_cdb_extra_true_keys "$_cdb_extra_jsonc" "$_cdb_extra_json" \
        nativeTitlebar noWindowControls | tr '\n' ' ')"
fi

# The saved switches are NOT turned into env vars here - the app reads them
# itself, from the right userData dir. They are resolved only so --diagnose can
# report what is stored alongside what is forced.
_saved_native=''
_saved_no_controls=''
case "$_cdb_extra_keys" in *' nativeTitlebar '*)  _saved_native=1 ;; esac
case "$_cdb_extra_keys" in *' noWindowControls '*) _saved_no_controls=1 ;; esac

# Titlebar modes are mutually exclusive and the native frame wins. Enforced
# app-side too (fix_native_frame.nim's bare mode tests !NATIVE_ON), so this only
# keeps the launcher's own arguments and logging self-consistent.
if [[ "${CLAUDE_NATIVE_TITLEBAR:-}" == '1' && "${CLAUDE_NO_WINDOW_CONTROLS:-}" == '1' ]]; then
    log "Titlebar: native ($_titlebar_source) and no window controls ($_no_controls_source) are mutually exclusive; using native"
    unset CLAUDE_NO_WINDOW_CONTROLS
    _no_controls_source=''
fi

ELECTRON_ARGS=()

# Titlebar mode: integrated (default) vs bare (frameless, no controls) vs
# native (opt-out). All three are BrowserWindow decisions made app-side; the
# launcher only logs which one an explicit flag or variable asked for.
#
# Chromium collapses duplicate switches into a map where the LAST one wins, so
# every feature name has to go through these two lists and be emitted once. The
# launcher used to pass two separate --disable-features= on a Wayland + native
# titlebar launch, and only ordering luck decided that the survivor was the
# Vulkan workaround rather than the titlebar one - appending another
# --disable-features anywhere above would have silently cost Wayland users their
# window. User-supplied values are folded in below for the same reason.
_disable_features=()
_enable_features=()

if [[ "${CLAUDE_NATIVE_TITLEBAR:-}" == '1' ]]; then
    # No Chromium argument to add: `frame:true` in fix_native_frame.nim is what
    # opens the native window. The CustomTitlebar feature this used to disable
    # does not exist in the bundled Electron.
    log "Titlebar: native ($_titlebar_source)"
elif [[ "${CLAUDE_NO_WINDOW_CONTROLS:-}" == '1' ]]; then
    log "Titlebar: frameless, no window controls ($_no_controls_source)"
else
    log 'Titlebar: integrated (default)'
fi


# Enable Chromium Web Bluetooth so the Hardware Buddy (Nibblet BLE) in-app scan
# can enumerate devices. On macOS/Windows Web Bluetooth is on by default, but on
# Linux Chromium gates it behind the WebBluetooth Blink feature at the PROCESS
# level - a per-webContents webPreference does not turn it on, only this switch
# does (verified: without it navigator.bluetooth is undefined in the renderer;
# with it requestDevice works). Harmless for users without a Buddy - it only
# exposes the API; nothing scans until the user opens the Buddy window.
ELECTRON_ARGS+=('--enable-blink-features=WebBluetooth')

# Chromium's setuid sandbox is orthogonal to the display backend, so the
# decision is made here once rather than per session type. Every package we ship
# gives Electron a working sandbox: the .deb, .rpm and pacman packages install
# chrome-sandbox 4755 root (CI's smoke test fails the build otherwise) and the
# Nix package uses the nixpkgs electron derivation, which carries its own
# wrapper. The AppImage is the exception - its payload is a FUSE mount, which
# cannot carry a SUID bit - so it, and only it, needs the sandbox turned off.
#
# This used to be added for EVERY Wayland and XWayland launch, which silently
# disabled the sandbox for remote claude.ai content on packages that had a
# perfectly good one. CLAUDE_DISABLE_SANDBOX=1 is the escape hatch if a session
# turns out to need it.
if [[ -n "${CLAUDE_APPIMAGE_PATH:-}" ]]; then
    log 'AppImage: adding --no-sandbox (a FUSE mount cannot carry SUID)'
    ELECTRON_ARGS+=('--no-sandbox')
elif [[ "${CLAUDE_DISABLE_SANDBOX:-}" == '1' ]]; then
    log 'Sandbox disabled by CLAUDE_DISABLE_SANDBOX=1'
    ELECTRON_ARGS+=('--no-sandbox')
fi

case $platform_mode in
    x11)
        log 'X11 session detected'
        ;;
    xwayland)
        log 'Using X11 backend via XWayland (CLAUDE_USE_XWAYLAND=1)'
        ELECTRON_ARGS+=('--ozone-platform=x11')
        ;;
    wayland)
        log 'Using native Wayland backend'
        # GlobalShortcutsPortal only. UseOzonePlatform and
        # WaylandWindowDecorations are both retired feature names that the
        # bundled Electron no longer knows - Ozone is the only path now, and
        # server-side decorations are decided by the compositor.
        _enable_features+=('GlobalShortcutsPortal')
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
            _disable_features+=('Vulkan')
            log 'Vulkan disabled for Wayland surface compatibility (set CLAUDE_ENABLE_VULKAN=1 to keep it)'
        else
            log 'Vulkan kept on Wayland (CLAUDE_ENABLE_VULKAN=1)'
        fi
        ;;
esac

# Emit exactly one switch of each kind, folding in anything the user passed so
# our entries are not silently discarded by Chromium's last-wins rule. A user
# who passed --disable-features=Foo used to drop our Vulkan workaround (no window
# on Wayland); one who passed --enable-features=Bar used to drop
# GlobalShortcutsPortal (global hotkeys stopped working, with no message).
# Folded in AND removed from the forwarded arguments: user args are appended
# after ELECTRON_ARGS, so leaving the original in place would let it win the
# last-wins race again and undo the merge we just did.
_user_args=()
for _uarg in "$@"; do
    case "$_uarg" in
        --disable-features=*) IFS=',' read -ra _uf <<< "${_uarg#*=}"; _disable_features+=("${_uf[@]}") ;;
        --enable-features=*)  IFS=',' read -ra _uf <<< "${_uarg#*=}"; _enable_features+=("${_uf[@]}") ;;
        *) _user_args+=("$_uarg") ;;
    esac
done
if (( ${#_user_args[@]} > 0 )); then
    set -- "${_user_args[@]}"
else
    set --
fi
_join_features() {
    local -n _arr="$1"
    local _seen=' ' _out='' _f
    for _f in ${_arr[@]+"${_arr[@]}"}; do
        [[ -z "$_f" ]] && continue
        case "$_seen" in *" $_f "*) continue ;; esac
        _seen="$_seen$_f "
        _out="${_out:+$_out,}$_f"
    done
    printf '%s' "$_out"
}
_df="$(_join_features _disable_features)"
_ef="$(_join_features _enable_features)"
[[ -n "$_df" ]] && ELECTRON_ARGS+=("--disable-features=$_df")
[[ -n "$_ef" ]] && ELECTRON_ARGS+=("--enable-features=$_ef")

# Now that platform_mode and electron_major are known, service the --diagnose
# subcommand if requested. Exits here — does not launch Electron.
if [[ -n ${_diagnose_requested:-} ]]; then
    echo "platform_mode = $platform_mode"
    echo "electron_major = $electron_major"
    # Note: CLAUDE_DISABLE_GPU flags are appended after this point, so they are
    # not reflected here; the platform/Vulkan/titlebar flags are.
    echo "electron_args = ${ELECTRON_ARGS[*]}"
    # "$@" so the credential-store section can see an explicit
    # --password-store= the caller passed alongside --diagnose.
    _diagnose "$@"
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
#
# The probes and the decision itself live near the top of this file, next to
# _diagnose(), so that --diagnose can report the very same answer this block
# acts on rather than a second implementation of the same rules.

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
            _pw_store_detect
            [[ -n "$_pw_note" ]] && log "$_pw_note"
            case "$_pw_state" in
                libsecret)
                    log "$_pw_detail"
                    ELECTRON_ARGS+=('--password-store=gnome-libsecret')
                    ;;
                none)
                    # Chromium then falls back to basic_text, which yields no
                    # usable key: safeStorage reports encryption unavailable and
                    # the sign-in is not persisted, so the app goes through
                    # /login on every start. Say so here - the silence was the
                    # reason this state could not be told apart from a probe
                    # that never ran.
                    log "$_pw_detail"
                    ;;
            esac
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

# Pass through CLAUDE_NATIVE_TITLEBAR if set (env var, not just --flag)
if [[ -n "${CLAUDE_NATIVE_TITLEBAR:-}" ]]; then
    export CLAUDE_NATIVE_TITLEBAR
fi

# Pass through CLAUDE_NO_WINDOW_CONTROLS if set (env var, not just --flag)
if [[ -n "${CLAUDE_NO_WINDOW_CONTROLS:-}" ]]; then
    export CLAUDE_NO_WINDOW_CONTROLS
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
# _resolve_launcher_self keeps a wrapper-set CLAUDE_LAUNCHER (Nix) and prefers
# the .AppImage file over its ephemeral mount point.
if _cdb_launcher_self="$(_resolve_launcher_self "$0")"; then
    export CLAUDE_LAUNCHER="$_cdb_launcher_self"
else
    log "cannot resolve own path ($0); autostart entry will fall back to the Electron binary"
fi

# ---------------------------------------------------------------------------
# SingletonLock cleanup
# ---------------------------------------------------------------------------
# Electron's requestSingleInstanceLock() silently quits if the lock is held.
# A stale lock from a crash blocks all launches with no error message.
# The lock is a symlink whose target encodes "hostname-PID".

# When a profile is active, redirect Electron's userData away from the default
# ~/.config/Claude. This is what isolates SingletonLock, logins, logs, etc.
# For the default profile, omit the flag so behavior is byte-identical to v1.
if [[ -n "$profile_suffix" ]]; then
    mkdir -p "$config_dir"
    ELECTRON_ARGS+=("--user-data-dir=$config_dir")
fi

# Both userData dirs, because a 3p deployment (an inferenceProvider in
# managed-settings.json) makes upstream relocate userData to the `-3p` suffix -
# and a stale lock there blocks every launch just as silently. The
# --reload-theme probe above already walks the same pair.
for lock_file in "$config_dir/SingletonLock" "${config_dir}-3p/SingletonLock"; do
    [[ -L "$lock_file" ]] || continue
    lock_target="$(readlink "$lock_file" 2>/dev/null)" || true
    lock_pid="${lock_target##*-}"
    if [[ "$lock_pid" =~ ^[0-9]+$ ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
        rm -f "$lock_file"
        log "Removed stale SingletonLock (PID $lock_pid no longer running): $lock_file"
    fi
done

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
        # A failed redirect on `exec` terminates a non-interactive shell, so an
        # unwritable stdout.log would stop the launch outright. Fall back to
        # /dev/null: losing the app's output is survivable, not starting is not.
        if ! { exec </dev/null >>"$STDIO_LOG" 2>&1; } 2>/dev/null; then
            exec </dev/null >/dev/null 2>&1
        fi
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
