# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Tray-less desktops: a hidden (--startup) launch needs a tray host.
#
# Upstream creates the main window with `show:i&&...` where i is false for a
# `--startup` launch (upstream's own XDG autostart entry passes --startup), so
# the window is born hidden and only the tray icon can bring it back. Nothing
# shows it when no tray icon exists: on a Wayland session without an
# org.kde.StatusNotifierWatcher (vanilla GNOME without the AppIndicator
# extension, sway/niri without a tray-capable bar), or with the tray switched
# off in settings, an autostart launch is an invisible process.
#
# Closing the main window on a desktop without a tray host is handled by
# upstream itself (its close handler quits when no tray icon is shown).
#
# We inject js/tray_host_probe.js (async NameHasOwner probe, cached, via
# busctl -> dbus-send -> gdbus from PATH) right after upstream registers
# showMainWindow for the new window:
#     ,(<probe>).startup(i,<showMainWindow>,()=><settings>("menuBarEnabled"))
# which, when the window was born hidden and there is no tray to reach it from
# (no watcher on Wayland, or the tray switched off in settings), calls
# upstream's own showMainWindow. With a watcher on the bus, with the probe
# still pending or unable to answer, and on X11 (XEmbed trays are invisible to
# the bus), upstream behavior is unchanged.
#
# The settings reader name is read (not modified) from upstream's close
# handler `if(!<settings>("menuBarEnabled")){...tray is disabled...}`, which
# also pins that all sites sit in the same window-creation function. Since
# v2.31226.0 the condition is a comma expression that calls
# `e.preventDefault()` first (`if(e.preventDefault(),!<settings>(...))`); any
# such leading calls are accepted.
#
# Idempotency: the injected startup hook present exactly once, and it is the
# only marker in the input -> already applied (1/1). Any other marker state
# (duplicated hook, a stray marker) -> FAIL.

import std/[os, strformat, strutils]
import regex

const PROBE_SRC = staticRead("../../js/tray_host_probe.js")
const MARKER = "/*__cdb_tray_host_v1__*/"
const EXPECTED_PATCHES = 1

# The probe file is a bare expression behind one leading block comment; the
# comment is documentation only and is not shipped into the bundle.
proc probeExpr(): string =
  let s = PROBE_SRC
  let endC = s.find("*/")
  if not s.startsWith("/*") or endC < 0:
    raise newException(ValueError, "tray_host_probe.js: missing leading block comment")
  result = s[endC + 2 .. ^1].strip()
  if not result.startsWith("(() =>") or not result.endsWith(")()"):
    raise newException(ValueError, "tray_host_probe.js: not a bare IIFE expression")

# Read-only anchor: captures the settings reader, never rewritten.
let settingRe = re2(
  """if\((?:[\w$]+(?:\.[\w$]+)*\([^()]*\),)*!([\w$]+)\(["`]menuBarEnabled["`]\)\)\{[\w$]+\.info\(["`]Quitting app on main window close since tray is disabled["`]\)"""
)
let showOptRe = re2"""show:([\w$]+)&&![\w$]+,backgroundColor:"""
# `koo(c,{showMainWindow:aX,reopen:()=>u.app.emit("activate",{},!0)})` since
# v4.16336.0 (before: `{showMainWindow:<fn>}` alone). Further members are
# `key:<ident>` or `key:()=><call>(<args without parens>)`.
const EXTRA_MEMBERS = """(?:,[\w$]+:(?:[\w$]+|\(\)=>[\w$]+(?:\.[\w$]+)*\([^()]*\)))*"""
let showMainRe =
  re2("""[\w$]+\([\w$]+,\{showMainWindow:([\w$]+)""" & EXTRA_MEMBERS & """\}\)""")
let startupDoneRe = re2(
  """\{showMainWindow:[\w$]+""" & EXTRA_MEMBERS &
    """\}\),/\*__cdb_tray_host_v1__\*/\(\(\(\) =>[\s\S]*?\)\(\)\)\.startup\([\w$]+,[\w$]+,\(\)=>[\w$]+\("menuBarEnabled"\)\)"""
)

proc allMatches(s: string, r: Regex2): seq[RegexMatch2] =
  for m in findAll(s, r):
    result.add m

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0

  let startupDone = allMatches(input, startupDoneRe).len
  let markers = input.count(MARKER)
  if startupDone > 1 or markers != startupDone:
    raise newException(
      ValueError,
      &"fix_tray_less_desktops: unexpected injected state (hook={startupDone}, markers={markers}) - re-extract a pristine bundle",
    )
  if startupDone == 1:
    echo "  [OK] window creation: hidden-launch show hook already present"
    return input

  # ── locate the three upstream sites on the pristine input ─────────────────
  let showMs = allMatches(input, showOptRe)
  if showMs.len != 1:
    echo &"  [FAIL] main window `show:<gate>&&!<early>,backgroundColor:`: {showMs.len} matches (want 1)"
    raise newException(ValueError, "fix_tray_less_desktops: show-option anchor moved")
  let smMs = allMatches(input, showMainRe)
  if smMs.len != 1:
    echo &"  [FAIL] `{{showMainWindow:<fn>}}` registration: {smMs.len} matches (want 1)"
    raise
      newException(ValueError, "fix_tray_less_desktops: showMainWindow anchor moved")
  let stMs = allMatches(input, settingRe)
  if stMs.len != 1:
    echo &"  [FAIL] close handler 'tray is disabled' branch (settings reader): {stMs.len} matches (want 1)"
    raise
      newException(ValueError, "fix_tray_less_desktops: settings-reader anchor moved")

  let sm = showMs[0]
  let rm = smMs[0]
  let cm = stMs[0]
  # All three must sit in the same main-window creation function: the show
  # gate first, the showMainWindow registration shortly after, the close
  # handler after that. The gate variable and the settings reader are only in
  # scope there.
  let d1 = rm.boundaries.a - sm.boundaries.a
  let d2 = cm.boundaries.a - rm.boundaries.a
  if d1 <= 0 or d1 > 4000 or d2 <= 0 or d2 > 8000:
    echo &"  [FAIL] sites are not in one window-creation function (show->register {d1}, register->close {d2})"
    raise newException(ValueError, "fix_tray_less_desktops: site layout moved")

  let gateVar = input[sm.group(0)]
  let showFn = input[rm.group(0)]
  let settingFn = input[cm.group(0)]

  let bEnd = rm.boundaries.b + 1
  let hook =
    "," & MARKER & "(" & probeExpr() & ").startup(" & gateVar & "," & showFn & ",()=>" &
    settingFn & "(\"menuBarEnabled\"))"
  result = result[0 ..< bEnd] & hook & result[bEnd .. ^1]
  echo &"  [OK] window creation: hidden launch shown when no tray (gate {gateVar}, show {showFn}, settings {settingFn})"
  inc patchesApplied

  # Positive end-state: the injected hook is now present exactly once.
  let sOut = allMatches(result, startupDoneRe).len
  if sOut != 1:
    echo &"  [FAIL] injected startup hook in output: {sOut} (want 1)"
    raise newException(ValueError, "fix_tray_less_desktops: end-state assertion failed")

  if patchesApplied < EXPECTED_PATCHES:
    echo &"  [FAIL] Only {patchesApplied}/{EXPECTED_PATCHES} patches applied"
    raise newException(ValueError, "fix_tray_less_desktops: incomplete")

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_tray_less_desktops <path_to_index.js>"
    quit(1)
  let file = paramStr(1)
  echo "=== Patch: fix_tray_less_desktops ==="
  echo &"  Target: {file}"
  if not fileExists(file):
    echo &"  [FAIL] File not found: {file}"
    quit(1)
  let input = readFile(file)
  var output: string
  try:
    output = apply(input)
  except ValueError as e:
    echo "  [FAIL] " & e.msg
    quit(1)
  if output != input:
    writeFile(file, output)
    echo "  [PASS] Tray-less desktop handling injected"
  else:
    echo "  [PASS] No changes needed (already applied)"
