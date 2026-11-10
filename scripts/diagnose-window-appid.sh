#!/bin/sh
# Diagnose the Wayland app_id / X11 WM_CLASS of every open window.
#
# Used to verify Quick Entry's app_id handling (fix_quick_entry_app_id.nim):
# the main Claude window should report app_id "com.anthropic.Claude" (or
# "com.anthropic.Claude-<name>" for a named profile that has its
# com.anthropic.Claude-<name>.desktop entry) and the Quick Entry window
# "claude-quick-entry"; any window opened after Quick Entry must NOT inherit a
# stale value. See the "Quick Entry app_id" notes in the
# project memory for the full before/after test procedure.
#
# MUST be run from a terminal INSIDE the graphical session - it talks to the
# compositor over the session D-Bus, which is not reachable from ssh/guest
# control without a session bus. Auto-detects KDE (KWin) vs GNOME.
#
# Usage:
#   scripts/diagnose-window-appid.sh [COUNTDOWN_SECONDS]
#
# With a countdown, the snapshot is delayed so you can open the auto-closing
# Quick Entry window (Ctrl+Alt+Space) and have it captured before it dismisses:
#   scripts/diagnose-window-appid.sh 8   # press Ctrl+Alt+Space during countdown
#
# GNOME note: GNOME Shell's Eval endpoint is locked on recent versions, so this
# uses the "Window Calls" extension (window-calls@domandoman.xyz) if present.
# Install it once from https://extensions.gnome.org/extension/4724/window-calls/
# (enable, then log out/in - Wayland cannot hot-reload the Shell), otherwise the
# GNOME path prints instructions instead of a listing.

set -eu

DELAY="${1:-0}"

echo "=== session ==="
echo "TYPE=${XDG_SESSION_TYPE:-unset} DESKTOP=${XDG_CURRENT_DESKTOP:-unset} WAYLAND=${WAYLAND_DISPLAY:-unset}"

if [ "$DELAY" -gt 0 ] 2>/dev/null; then
    echo "You have $DELAY seconds: open the window(s) you want captured now (e.g. Ctrl+Alt+Space for Quick Entry)."
    i="$DELAY"
    while [ "$i" -gt 0 ]; do printf '\r  %2ds...' "$i"; sleep 1; i=$((i - 1)); done
    printf '\r  capturing.\n'
fi

case "${XDG_CURRENT_DESKTOP:-}" in
    *KDE*|*kde*|*plasma*|*Plasma*)
        # KWin: load a scripting snippet that print()s each window; output lands
        # in the kwin_wayland journal.
        JS="$(mktemp --suffix=.js)"
        trap 'rm -f "$JS"' EXIT
        cat > "$JS" <<'EOF'
var ws = workspace;
var wins = ws.windowList ? ws.windowList() : ws.clientList();
for (var i = 0; i < wins.length; i++) {
    var w = wins[i];
    print("APPID_DUMP resourceClass=[" + w.resourceClass + "] resourceName=[" + w.resourceName + "] caption=[" + w.caption + "]");
}
EOF
        ID=$(qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.loadScript "$JS" 2>/dev/null || echo "")
        qdbus6 org.kde.KWin "/Scripting/Script$ID" run 2>/dev/null \
            || qdbus6 org.kde.KWin "/$ID" run 2>/dev/null \
            || qdbus6 org.kde.KWin "/Scripting/Script$ID" org.kde.kwin.Script.run 2>/dev/null \
            || true
        sleep 1
        qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript "$JS" 2>/dev/null || true
        echo "=== windows (KWin) ==="
        journalctl --user -b --since "$((DELAY + 8)) seconds ago" 2>/dev/null | grep "APPID_DUMP" \
            || journalctl -b --since "$((DELAY + 8)) seconds ago" 2>/dev/null | grep "APPID_DUMP" \
            || echo "(no journal lines; try: qdbus6 org.kde.KWin /KWin org.kde.KWin.queryWindowInfo and click a window)"
        ;;
    *GNOME*|*gnome*|*ubuntu*)
        UUID="window-calls@domandoman.xyz"
        echo "=== windows (GNOME / Window Calls) ==="
        OUT=$(gdbus call --session --dest org.gnome.Shell \
            --object-path /org/gnome/Shell/Extensions/Windows \
            --method org.gnome.Shell.Extensions.Windows.List 2>&1) || OUT=""
        case "$OUT" in
            *wm_class*)
                echo "$OUT" \
                    | sed "s/^('//; s/',)$//" \
                    | python3 -c 'import sys,json;[print(w.get("wm_class"),"|",w.get("wm_class_instance"),"|",w.get("title","")) for w in json.load(sys.stdin)]' 2>/dev/null \
                    || echo "$OUT"
                ;;
            *)
                echo "Window Calls not available. Install it once:"
                echo "  https://extensions.gnome.org/extension/4724/window-calls/"
                echo "  then: gnome-extensions enable $UUID  (log out/in after install - Wayland cannot hot-reload the Shell)"
                echo "GNOME Shell's Eval endpoint is locked on recent versions, so no built-in fallback exists."
                ;;
        esac
        ;;
    *)
        # X11 or other: xprop/wmctrl see XWayland + X11 windows.
        echo "=== windows (X11 / wmctrl) ==="
        if command -v wmctrl >/dev/null 2>&1; then
            wmctrl -lx
        else
            echo "wmctrl not found; on X11 run: xprop WM_CLASS  (then click a window)"
        fi
        ;;
esac
