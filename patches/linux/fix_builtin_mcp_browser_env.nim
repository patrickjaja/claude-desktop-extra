# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Fix built-in MCP servers (e.g. the Microsoft 365 connector) failing to open
# the system browser for OAuth on Linux.
#   (#139: local_auth_browser_open_failed, spawnErrorCode: exit_3)
#
# Root cause:
#   The built-in MCP host is forked via electron utilityProcess.fork with a
#   FILTERED environment allowlist (the vre()/qli helper). On Linux it forwards
#   only ["HOME","LOGNAME","PATH","SHELL","TERM","USER"], stripping DISPLAY,
#   WAYLAND_DISPLAY, XDG_*, DBUS_SESSION_BUS_ADDRESS, BROWSER, etc.
#
#   office365-mcp-stdio.mjs (office365-mcp.mjs before v1.49585.0) opens the
#   OAuth URL with `spawn("xdg-open", [url])` and passes no `env`, so it
#   inherits the stripped MCP-process env. Without the
#   display/session vars, xdg-open's has_display() is false, it skips the
#   x-scheme-handler/https default-browser resolution, falls through to the
#   text-only browser list (www-browser:links2:elinks:links:lynx:w3m), finds
#   none, and exits 3 ("no method available for opening <url>").
#
# Fix:
#   Widen the Linux allowlist so the forwarded env contains the standard
#   freedesktop / X11 / Wayland session variables xdg-open needs. Then xdg-open
#   inside the MCP process behaves exactly as it does from a terminal (where it
#   works), launching the user's configured default browser.
#
#   This is distro- and session-agnostic: it forwards only standard env vars
#   that every Linux desktop session sets the same way (X11, Wayland wlroots/
#   GNOME/KDE, XWayland). vre() already forwards each var only when set, so
#   unset vars are simply omitted.
#
#   The allowlist literal uses real (non-minified) env-var names, so the regex
#   is stable across upstream re-minifies. The allowlist (qli) feeds vre(), and
#   vre() is the base env for ALL stdio MCP server forks -- the built-in MCP
#   host fork AND user-configured stdio servers (the jMt/StdioClientTransport
#   sites, where it merges as {...vre(),...serverParams.env}). Widening it is
#   correct for every one of them: it only ADDS standard session vars that a
#   terminal-launched process already has, and never touches the win32 branch
#   of qli or the other utilityProcess.fork sites (which pass {...process.env}).

import std/[os, strutils]
import regex

# Extra Linux session/display vars to forward into the built-in MCP host env.
# KDE_SESSION_VERSION is critical on KDE (#139 reopened): with
# XDG_CURRENT_DESKTOP=KDE but no KDE_SESSION_VERSION, xdg-open's open_kde()
# falls through to the KDE3-era `kfmclient exec` branch, whose
# kfmclient_fix_exit_code helper returns 0 unconditionally -- a silent no-op
# (browser never opens, but the caller sees "success"). With it set, xdg-open
# uses kde-open5/kde-open (kde-cli-tools, present on every Plasma install) and
# real failures exit loud (4).
const EXTRA_VARS =
  ",\"DISPLAY\",\"WAYLAND_DISPLAY\",\"XAUTHORITY\",\"XDG_CURRENT_DESKTOP\"," &
  "\"XDG_SESSION_TYPE\",\"XDG_SESSION_DESKTOP\",\"DESKTOP_SESSION\"," &
  "\"XDG_RUNTIME_DIR\",\"DBUS_SESSION_BUS_ADDRESS\",\"XDG_DATA_HOME\"," &
  "\"XDG_DATA_DIRS\",\"XDG_CONFIG_HOME\",\"XDG_CONFIG_DIRS\",\"BROWSER\"," &
  "\"KDE_FULL_SESSION\",\"KDE_SESSION_VERSION\",\"GNOME_DESKTOP_SESSION_ID\""

proc apply*(input: string): string =
  # Idempotency: positive end-state check -- OUR injected tail must be present.
  # We key off the head of EXTRA_VARS (always double-quoted, because we emit it)
  # rather than off upstream's trailing "USER" entry, whose quoting is
  # minifier-dependent (v1.26832.0 emits `USER` as a backtick template literal).
  # KDE_SESSION_VERSION is checked separately so an older widened list without it
  # does NOT count as patched, or KDE stays broken.
  if "\"DISPLAY\",\"WAYLAND_DISPLAY\",\"XAUTHORITY\"" in input and
      "\"KDE_SESSION_VERSION\"" in input:
    echo "  [OK] built-in MCP browser env: already patched"
    return input

  # Match the Linux branch of the env allowlist array. The env-var names are
  # NOT minified, so this literal is stable across versions -- only the quoting
  # style moves (double quotes <= v1.24012.9, backticks in v1.26832.0), hence the
  # quote-agnostic ["`] classes. Capture group 0 is the array body up to (but not
  # including) the closing bracket, so we can append the extra vars before
  # re-adding "]".
  let pattern =
    re2"(\[[""`]HOME[""`],[""`]LOGNAME[""`],[""`]PATH[""`],[""`]SHELL[""`],[""`]TERM[""`],[""`]USER[""`])\]"
  var count = 0
  result = input.replace(
    pattern,
    proc(m: RegexMatch2, s: string): string =
      inc count
      s[m.group(0)] & EXTRA_VARS & "]" # ["HOME",...,"USER"] + extras + ]
    ,
  )

  if count == 0:
    if "\"HOME\",\"LOGNAME\"" in input or "`HOME`,`LOGNAME`" in input:
      echo "  [INFO] Found env allowlist but pattern didn't match (structure changed?)"
    echo "  [FAIL] built-in MCP browser env: 0 matches (may need pattern update)"
    quit(1)

  echo "  [OK] built-in MCP browser env: widened allowlist (" & $count & " match(es))"

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_builtin_mcp_browser_env <file>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_builtin_mcp_browser_env ==="
  echo "  Target: " & filePath
  let input = readFile(filePath)
  let output = apply(input)
  writeFile(filePath, output)
  echo "  [PASS] Built-in MCP browser env patched successfully"
