#!/usr/bin/env bash
# Check every Computer Use bridge in a directory against the bridge CLI
# contract (docs/computer-use-bridge-contract.md).
#
#   scripts/check-bridge-contract.sh <dir>
#   scripts/check-bridge-contract.sh --x11-caps <x11-bridge binary>
#
# Checks each executable `*-bridge` in <dir>. Every command runs with an empty
# environment (PATH kept), a throwaway HOME / XDG_STATE_HOME / XDG_RUNTIME_DIR,
# no display and an unreachable session bus, so it cannot touch the caller's
# grant or open a portal session. CI runs it on the freshly built bridges and on
# the bundled resources/ of the tarball. Needs python3 for the JSON checks (CI
# only; the launcher itself never needs it).
#
# x11-bridge must also have what the app needs on X11 (issue #327): doctor
# `capabilities.screenshot_mask_ignore: true` (masked screenshots look through
# Claude's own overlays) and a `capabilities.compositing` key (without it the
# app keeps the "Claude is using your computer" glow off on every X11
# session). An older bridge passes the contract but would ship that silently.
# `--x11-caps <file>` runs only this check on one binary; build-patched-tarball.sh
# calls it on the bundled x11-bridge, so local builds and CI fail alike. A
# binary that cannot run on this host (the aarch64 one on an x86_64 builder)
# is checked by the doctor field names compiled into it instead.
#
# wlroots-bridge must report how it masks (issue #329): doctor top-level keys
# `screenshot_mask_mode` ("toplevel" | "output", null when no compositor was
# reached - always the case here) and `screenshot_mask_protocol` (a string or
# null), present even without a compositor, and the per-kept-window
# `coveredBy` field of its masked zoom report (a string compiled into the
# binary). The values need a live compositor; the keys and the report field
# do not. `--wlroots-caps <file>` runs only this check;
# build-patched-tarball.sh calls it on the bundled wlroots-bridge. A binary
# that cannot run here is checked by the field names compiled into it.
#
# Exit: 0 when every check passed, 1 when any failed, 2 on bad usage.

set -uo pipefail

x11_caps_only=''
wl_caps_only=''
if (( $# == 2 )) && [[ "$1" == --x11-caps && -f "$2" ]]; then
    x11_caps_only="$2"
elif (( $# == 2 )) && [[ "$1" == --wlroots-caps && -f "$2" ]]; then
    wl_caps_only="$2"
elif (( $# != 1 )) || [[ ! -d "$1" ]]; then
    echo >&2 "usage: $0 <dir-with-bridges> | --x11-caps <x11-bridge> | --wlroots-caps <wlroots-bridge>"
    exit 2
fi
dir="${1}"
command -v python3 >/dev/null 2>&1 || { echo >&2 "$0: python3 is required"; exit 2; }

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

passes=0
fails=0
pass() { echo "PASS $1"; passes=$((passes + 1)); }
fail() { echo "FAIL $1${2:+ - $2}"; fails=$((fails + 1)); }

# JSON checks. Mode and arguments on argv, the bridge's stdout on stdin.
# Prints nothing and exits 0 when the JSON fits; prints why and exits 1 when not.
# `doctor` additionally prints session_supported (true/false) on success.
read -r -d '' PY <<'EOF'
import json, sys

mode = sys.argv[1]
raw = sys.stdin.read()
try:
    v = json.loads(raw)
except ValueError as e:
    print("stdout is not one JSON value: %s" % e)
    sys.exit(1)
if not isinstance(v, dict):
    print("expected a JSON object, got %s" % type(v).__name__)
    sys.exit(1)

NOOP = {"ok": True, "ended": False, "daemon": "none", "token_removed": False, "token_path": None}
problems = []

def is_bool(x): return isinstance(x, bool)
def is_num(x): return isinstance(x, (int, float)) and not isinstance(x, bool)
def is_str(x): return isinstance(x, str)
def is_str_or_null(x): return x is None or isinstance(x, str)

def expect(key, check, what):
    if key not in v:
        problems.append("missing key %r" % key)
    elif not check(v[key]):
        problems.append("%r must be %s, got %s" % (key, what, json.dumps(v[key])))

if mode == "doctor":
    name = sys.argv[2]
    expect("contract", is_num, "a number")
    expect("bridge", is_str, "a string")
    expect("version", is_str, "a string")
    expect("backend", is_str, "a string")
    expect("session_match", is_bool, "a bool")
    expect("backend_reachable", is_bool, "a bool")
    expect("backend_error", is_str_or_null, "a string or null")
    expect("session_supported", is_bool, "a bool")
    expect("restore_token_present", is_bool, "a bool")
    expect("restore_token_path", is_str_or_null, "a string or null")
    expect("daemon_running", is_bool, "a bool")
    expect("session_socket", is_str_or_null, "a string or null")
    if not problems:
        if v["contract"] != 1:
            problems.append("contract must be 1, got %s" % json.dumps(v["contract"]))
        if v["bridge"] != name:
            problems.append("bridge must be %r (the file name), got %r" % (name, v["bridge"]))
        if not v["session_supported"]:
            for key, want in (("restore_token_present", False), ("restore_token_path", None),
                              ("session_socket", None)):
                if v[key] != want:
                    problems.append("%r must be %s without a session, got %s"
                                    % (key, json.dumps(want), json.dumps(v[key])))
elif mode == "x11-caps":
    caps = v.get("capabilities")
    if not isinstance(caps, dict):
        problems.append("no capabilities object")
    else:
        if caps.get("screenshot_mask_ignore") is not True:
            problems.append("capabilities.screenshot_mask_ignore must be true (masked screenshots must look through Claude's own overlays)")
        if "compositing" not in caps:
            problems.append("capabilities.compositing is missing (the app would keep the glow off on every X11 session)")
        elif caps["compositing"] not in (True, False, None):
            problems.append("capabilities.compositing must be true, false or null")
elif mode == "wlroots-caps":
    if "screenshot_mask_mode" not in v:
        problems.append("screenshot_mask_mode is missing (an older wlroots-bridge: masked screenshots on Hyprland cut the approved window away under a full-output layer)")
    elif v["screenshot_mask_mode"] not in ("toplevel", "output", None):
        problems.append("screenshot_mask_mode must be \"toplevel\", \"output\" or null, got %s" % json.dumps(v["screenshot_mask_mode"]))
    if "screenshot_mask_protocol" not in v:
        problems.append("screenshot_mask_protocol is missing")
    elif not is_str_or_null(v["screenshot_mask_protocol"]):
        problems.append("screenshot_mask_protocol must be a string or null")
    elif v.get("screenshot_mask_mode") == "toplevel" and not v["screenshot_mask_protocol"]:
        problems.append("screenshot_mask_mode \"toplevel\" needs a screenshot_mask_protocol")
elif mode == "ax-features":
    feats = v.get("ax_features")
    if not isinstance(feats, list) or not all(isinstance(f, str) for f in feats):
        problems.append("expected {\"ax_features\": [<string>, ...]}, got %s" % json.dumps(v))
    else:
        for f in sys.argv[2:]:
            if f not in feats:
                problems.append("missing feature %r" % f)
        if "action.expect" in feats and "find.identity" not in feats:
            problems.append("action.expect is listed without find.identity")
        for f in ("action.ensure", "action.scroll_to", "action.set_value"):
            if f in feats and "action.expect" not in feats:
                problems.append("%s is listed without action.expect" % f)
elif mode == "session-end":
    if v.get("ok") is not True: problems.append("ok must be true")
    if v.get("ended") is not False: problems.append("ended must be false with no daemon")
    if v.get("daemon") != "none": problems.append("daemon must be \"none\" with no daemon")
elif mode in ("forget-empty", "forget-planted"):
    supported = sys.argv[2] == "true"
    if not supported:
        if v != NOOP:
            problems.append("a bridge without a session must answer exactly %s, got %s"
                            % (json.dumps(NOOP), json.dumps(v)))
    else:
        if v.get("ok") is not True: problems.append("ok must be true")
        if v.get("ended") is not False: problems.append("ended must be false with no daemon")
        if v.get("daemon") != "none": problems.append("daemon must be \"none\" with no daemon")
        want = mode == "forget-planted"
        if v.get("token_removed") is not want:
            problems.append("token_removed must be %s" % json.dumps(want))
        if not is_str_or_null(v.get("token_path", 0)):
            problems.append("token_path must be a string or null")
else:
    problems.append("unknown mode %r" % mode)

if problems:
    print("; ".join(problems))
    sys.exit(1)
if mode == "doctor":
    print("true" if v["session_supported"] else "false")
EOF

json_check() {  # mode [arg] <<< json
    python3 -I -c "$PY" "$@"
}

# A fresh sandbox: prints its path. home/, state/ and run/ start empty.
sandbox() {
    local sb
    sb="$(mktemp -d "$scratch/sb.XXXXXX")"
    mkdir -p "$sb/home" "$sb/state" "$sb/run"
    chmod 700 "$sb/run"
    printf '%s\n' "$sb"
}

# Run a bridge in sandbox $1: sets OUT, ERR, RC.
OUT='' ERR='' RC=0
run_bridge() {
    local sb="$1" bin="$2"
    shift 2
    RC=0
    OUT="$(timeout -s KILL 30 env -i PATH="$PATH" HOME="$sb/home" \
        XDG_STATE_HOME="$sb/state" XDG_RUNTIME_DIR="$sb/run" \
        DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent \
        "$bin" "$@" 2>"$sb/stderr" </dev/null)" || RC=$?
    ERR="$(head -c 300 "$sb/stderr")"
}

# Anything a command left in the sandbox (state or runtime dirs, HOME).
leftovers() {
    find "$1/home" "$1/state" "$1/run" -mindepth 1 2>/dev/null | sed "s|^$1/||" | head -5 | tr '\n' ' '
}

# Accessibility features every bridge must offer (`ax-features`, see the
# "Accessibility feature negotiation" section of the contract doc). This is the
# set the bundled JS relies on for the full tool surface: keep it in sync with
# js/cu_ax_tools.js.
AX_REQUIRED=(find.v1 action.click action.focus action.set_text find.identity
    action.expect find.window_ref find.deadline find.root find.skeleton
    action.ensure action.scroll_to action.set_value)

check_ax_features() {
    local bin="$1" name sb why f missing=''
    name="${bin##*/}"
    sb="$(sandbox)"
    run_bridge "$sb" "$bin" ax-features
    if [[ "$RC" == 0 ]]; then
        if why="$(json_check ax-features "${AX_REQUIRED[@]}" <<< "$OUT")"; then
            pass "$name: ax-features lists all ${#AX_REQUIRED[@]} required features, coupling rules hold"
        else
            fail "$name: ax-features" "$why"
        fi
    elif [[ "$RC" == 126 || "$RC" == 127 ]] || ! "$bin" --version >/dev/null 2>&1; then
        # Not runnable here (foreign architecture, glibc): the feature names
        # are string literals in the binary. A strings check only.
        for f in "${AX_REQUIRED[@]}"; do
            grep -aqF -- "$f" "$bin" || missing+="$f "
        done
        if [[ -z "$missing" ]]; then
            pass "$name: ax-features: all required feature names present in the binary (strings check, not runnable on this host)"
        else
            fail "$name: ax-features" "missing feature ${missing% } in the binary (strings check, not runnable on this host)"
        fi
    else
        fail "$name: ax-features" "exit $RC (want 0 and {\"ax_features\": [...]}): ${ERR:0:120}"
    fi
}

# x11-bridge capabilities the app relies on (issue #327); see the header.
check_x11_caps() {
    local bin="$1" sb why
    sb="$(sandbox)"
    run_bridge "$sb" "$bin" doctor
    if [[ "$RC" == 0 ]]; then
        if why="$(json_check x11-caps <<< "$OUT")"; then
            pass "x11-bridge: doctor capabilities.screenshot_mask_ignore + compositing"
        else
            fail "x11-bridge: doctor capabilities" "$why"
        fi
    elif [[ "$RC" == 126 || "$RC" == 127 ]] || ! "$bin" --version >/dev/null 2>&1; then
        # Not runnable here (foreign architecture): the serde field names are
        # string literals in the static binary.
        if grep -aq screenshot_mask_ignore "$bin" && grep -aq compositing_error "$bin"; then
            pass "x11-bridge: capabilities screenshot_mask_ignore + compositing present in the binary (not runnable on this host)"
        else
            fail "x11-bridge: doctor capabilities" "the binary has no screenshot_mask_ignore / compositing (older x11-bridge; not runnable on this host)"
        fi
    else
        fail "x11-bridge: doctor capabilities" "doctor exited $RC: ${ERR:0:120}"
    fi
}

# wlroots-bridge mask report the app relies on (issue #329); see the header.
check_wl_caps() {
    local bin="$1" sb why
    sb="$(sandbox)"
    run_bridge "$sb" "$bin" doctor
    if [[ "$RC" == 0 ]]; then
        if why="$(json_check wlroots-caps <<< "$OUT")"; then
            pass "wlroots-bridge: doctor screenshot_mask_mode + screenshot_mask_protocol"
        else
            fail "wlroots-bridge: doctor mask mode" "$why"
        fi
        if grep -aq coveredBy "$bin"; then
            pass "wlroots-bridge: masked zoom report has coveredBy"
        else
            fail "wlroots-bridge: masked zoom report" "the binary has no coveredBy (older wlroots-bridge: no per-window shown / reason / coveredBy)"
        fi
    elif [[ "$RC" == 126 || "$RC" == 127 ]] || ! "$bin" --version >/dev/null 2>&1; then
        # Not runnable here (foreign architecture): the serde field names are
        # string literals in the static binary.
        if grep -aq screenshot_mask_mode "$bin" && grep -aq screenshot_mask_protocol "$bin" && grep -aq coveredBy "$bin"; then
            pass "wlroots-bridge: screenshot_mask_mode, screenshot_mask_protocol and coveredBy present in the binary (not runnable on this host)"
        else
            fail "wlroots-bridge: mask report" "the binary has no screenshot_mask_mode / screenshot_mask_protocol / coveredBy (older wlroots-bridge; not runnable on this host)"
        fi
    else
        fail "wlroots-bridge: doctor mask mode" "doctor exited $RC: ${ERR:0:120}"
    fi
}

if [[ -n "$x11_caps_only" ]]; then
    echo "== x11-bridge capabilities ($x11_caps_only)"
    check_x11_caps "$x11_caps_only"
    echo
    echo "x11-bridge capabilities: $passes passed, $fails failed"
    (( fails == 0 ))
    exit
fi
if [[ -n "$wl_caps_only" ]]; then
    echo "== wlroots-bridge mask report ($wl_caps_only)"
    check_wl_caps "$wl_caps_only"
    echo
    echo "wlroots-bridge mask report: $passes passed, $fails failed"
    (( fails == 0 ))
    exit
fi

check_bridge() {
    local bin="$1" name sb why supported='' first sub
    name="${bin##*/}"
    echo "== $name ($bin)"

    sb="$(sandbox)"
    run_bridge "$sb" "$bin" --version
    first="${OUT%%$'\n'*}"
    if [[ "$RC" == 0 && "$first" =~ ^"$name "[0-9]+\.[0-9]+\.[0-9]+ ]]; then
        pass "$name: --version ($first)"
    else
        fail "$name: --version" "exit $RC, stdout '${first:0:80}' (want '$name <semver>')"
    fi

    sb="$(sandbox)"
    run_bridge "$sb" "$bin" doctor
    if [[ "$RC" != 0 ]]; then
        fail "$name: doctor" "exit $RC (must exit 0 even without a display or session bus): ${ERR:0:120}"
    elif supported="$(json_check doctor "$name" <<< "$OUT")"; then
        pass "$name: doctor (contract 1, required keys, session_supported=$supported)"
    else
        fail "$name: doctor" "$supported"
        supported=''
    fi

    [[ "$name" == x11-bridge ]] && check_x11_caps "$bin"
    [[ "$name" == wlroots-bridge ]] && check_wl_caps "$bin"

    sb="$(sandbox)"
    run_bridge "$sb" "$bin" session-end
    if [[ "$RC" != 0 ]]; then
        fail "$name: session-end" "exit $RC: ${ERR:0:120}"
    elif why="$(json_check session-end <<< "$OUT")"; then
        pass "$name: session-end with no daemon"
    else
        fail "$name: session-end" "$why"
    fi

    if [[ -z "$supported" ]]; then
        fail "$name: forget-session" "skipped: doctor did not say whether the bridge has a session"
    else
        sb="$(sandbox)"
        run_bridge "$sb" "$bin" forget-session
        if [[ "$RC" != 0 ]]; then
            fail "$name: forget-session with nothing stored" "exit $RC: ${ERR:0:120}"
        elif ! why="$(json_check forget-empty "$supported" <<< "$OUT")"; then
            fail "$name: forget-session with nothing stored" "$why"
        elif [[ -n "$(leftovers "$sb")" ]]; then
            fail "$name: forget-session with nothing stored" "created $(leftovers "$sb")"
        else
            pass "$name: forget-session with nothing stored (idempotent, creates nothing)"
        fi

        sb="$(sandbox)"
        mkdir -p "$sb/state/$name"
        echo '{"token":"planted-by-check-bridge-contract"}' > "$sb/state/$name/restore-token.json"
        echo keep > "$sb/state/$name/keep.txt"
        run_bridge "$sb" "$bin" forget-session
        if [[ "$RC" != 0 ]]; then
            fail "$name: forget-session with a stored grant" "exit $RC: ${ERR:0:120}"
        elif ! why="$(json_check forget-planted "$supported" <<< "$OUT")"; then
            fail "$name: forget-session with a stored grant" "$why"
        elif [[ ! -f "$sb/state/$name/keep.txt" ]]; then
            fail "$name: forget-session with a stored grant" "deleted a sibling file of the token"
        elif [[ "$supported" == true && -e "$sb/state/$name/restore-token.json" ]]; then
            fail "$name: forget-session with a stored grant" "reported success but the token file is still there"
        elif [[ "$supported" == false && ! -f "$sb/state/$name/restore-token.json" ]]; then
            fail "$name: forget-session with a stored grant" "a bridge without a session deleted the file"
        elif [[ "$supported" == true ]]; then
            pass "$name: forget-session with a stored grant (token removed, sibling kept)"
        else
            pass "$name: forget-session with a stored grant (no session: exact no-op, file untouched)"
        fi
    fi

    check_ax_features "$bin"

    for sub in screens windows session-start; do
        sb="$(sandbox)"
        run_bridge "$sb" "$bin" "$sub" --help
        if [[ "$RC" == 0 ]]; then pass "$name: $sub --help"; else fail "$name: $sub --help" "exit $RC"; fi
    done

    sb="$(sandbox)"
    run_bridge "$sb" "$bin" pointer-move --x -5 --y -5 --help
    if [[ "$RC" == 0 ]]; then
        pass "$name: negative coordinates are accepted (pointer-move --x -5 --y -5 --help)"
    else
        fail "$name: negative coordinates" "pointer-move --x -5 --y -5 --help exited $RC: ${ERR:0:120}"
    fi

    sb="$(sandbox)"
    run_bridge "$sb" "$bin" no-such-subcommand-cdb
    if [[ "$RC" == 2 ]]; then pass "$name: unknown subcommand exits 2"; else fail "$name: unknown subcommand" "exit $RC, want 2"; fi
}

found=0
for bin in "$dir"/*-bridge; do
    [[ -f "$bin" && -x "$bin" ]] || continue
    found=$((found + 1))
    check_bridge "$bin"
done
if (( found == 0 )); then
    fail "no executable *-bridge in $dir"
fi

echo
echo "$found bridge(s): $passes passed, $fails failed"
(( fails == 0 ))
