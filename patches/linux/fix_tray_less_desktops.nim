# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Tray-less desktops: close-to-tray and hidden launches need a tray host.
#
# Upstream (2.7032.0, main window creation in an index chunk) does two things
# that assume a clickable tray icon, and never checks that a tray host exists:
#
#   - close handler: `if(!Vb("menuBarEnabled")){P.info("Quitting app on main
#     window close since tray is disabled"),VA();return}e.preventDefault();
#     ... d.hide()`. The setting defaults to true, so close = hide.
#   - window creation: `show:i&&!u` where i is false for a `--startup` launch
#     (upstream's own XDG autostart entry passes --startup), so the window is
#     born hidden.
#
# The bundle has no StatusNotifierWatcher / AppIndicator / tray-host probe at
# all. Electron's Linux Tray registers a StatusNotifierItem over D-Bus and, when
# no org.kde.StatusNotifierWatcher owns its name, falls back to a GtkStatusIcon
# (XEmbed, X11 only). On a Wayland session without a watcher (vanilla GNOME
# without the AppIndicator extension, sway/niri without a tray-capable bar)
# neither can show anything, so closing the window leaves an invisible process
# and an autostart launch shows nothing.
#
# We inject js/tray_host_probe.js (async NameHasOwner probe, cached, via
# busctl -> dbus-send -> gdbus from PATH) at two sites:
#
#   A  close handler: widen upstream's own no-tray quit branch to
#        if(!Vb("menuBarEnabled")||globalThis.__cdbTrayHost?.quitOnClose?.()===true)
#      Quitting is upstream's OWN semantics for "no tray" on Linux (that exact
#      branch and log line), so we reuse it rather than invent a minimize.
#   B  right after upstream registers showMainWindow for the new window:
#        ,(<probe>).startup(i,Eq,()=>Vb("menuBarEnabled"))
#      which, when the window was born hidden and there is no tray to reach it
#      from (no watcher on Wayland, or the tray switched off in settings),
#      calls upstream's own showMainWindow.
#
# With a watcher on the bus, with the probe still pending or unable to answer,
# and on X11 (XEmbed trays are invisible to the bus), upstream behavior is
# unchanged.
#
# Idempotency: both injected shapes present -> already applied (2/2). Exactly
# one present -> partially patched input -> FAIL.

import std/[os, strformat, strutils]
import regex

const PROBE_SRC = staticRead("../../js/tray_host_probe.js")
const MARKER = "/*__cdb_tray_host_v1__*/"
const EXPECTED_PATCHES = 2

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

const CLOSE_INJ = "||" & MARKER & "globalThis.__cdbTrayHost?.quitOnClose?.()===true"

let closeRe = re2(
  """(if\(!([\w$]+)\(["`]menuBarEnabled["`]\))(\)\{[\w$]+\.info\(["`]Quitting app on main window close since tray is disabled["`]\))"""
)
let closeDoneRe = re2(
  """if\(!([\w$]+)\(["`]menuBarEnabled["`]\)\|\|/\*__cdb_tray_host_v1__\*/globalThis\.__cdbTrayHost\?\.quitOnClose\?\.\(\)===true\)\{[\w$]+\.info\(["`]Quitting app on main window close since tray is disabled["`]\)"""
)
let showOptRe = re2"""show:([\w$]+)&&![\w$]+,backgroundColor:"""
let showMainRe = re2"""[\w$]+\([\w$]+,\{showMainWindow:([\w$]+)\}\)"""
let startupDoneRe = re2(
  """\{showMainWindow:[\w$]+\}\),/\*__cdb_tray_host_v1__\*/\(\(\(\) =>[\s\S]*?\)\(\)\)\.startup\([\w$]+,[\w$]+,\(\)=>[\w$]+\("menuBarEnabled"\)\)"""
)

proc allMatches(s: string, r: Regex2): seq[RegexMatch2] =
  for m in findAll(s, r):
    result.add m

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0

  let closeDone = allMatches(input, closeDoneRe).len
  let startupDone = allMatches(input, startupDoneRe).len
  if closeDone > 1 or startupDone > 1:
    raise newException(
      ValueError,
      &"fix_tray_less_desktops: injected shapes duplicated (close={closeDone}, startup={startupDone})",
    )
  if closeDone == 1 and startupDone == 1:
    echo "  [OK] A close handler: tray-host quit branch already present"
    echo "  [OK] B window creation: hidden-launch show hook already present"
    return input
  if closeDone + startupDone == 1:
    raise newException(
      ValueError,
      &"fix_tray_less_desktops: partially patched input (close={closeDone}, startup={startupDone}) - re-extract a pristine bundle",
    )

  # ── locate all three upstream sites on the pristine input ─────────────────
  let closeMs = allMatches(input, closeRe)
  if closeMs.len != 1:
    echo &"  [FAIL] A close handler 'tray is disabled' branch: {closeMs.len} matches (want 1)"
    raise newException(ValueError, "fix_tray_less_desktops: close anchor moved")
  let showMs = allMatches(input, showOptRe)
  if showMs.len != 1:
    echo &"  [FAIL] B main window `show:<gate>&&!<early>,backgroundColor:`: {showMs.len} matches (want 1)"
    raise newException(ValueError, "fix_tray_less_desktops: show-option anchor moved")
  let smMs = allMatches(input, showMainRe)
  if smMs.len != 1:
    echo &"  [FAIL] B `{{showMainWindow:<fn>}}` registration: {smMs.len} matches (want 1)"
    raise
      newException(ValueError, "fix_tray_less_desktops: showMainWindow anchor moved")

  let cm = closeMs[0]
  let sm = showMs[0]
  let rm = smMs[0]
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
  let settingFn = input[cm.group(1)]

  # Apply the later site (A) first so the earlier offsets stay valid.
  let aStart = cm.group(0).b + 1
  result = result[0 ..< aStart] & CLOSE_INJ & result[aStart .. ^1]
  echo &"  [OK] A close handler: quits when no tray host (setting reader {settingFn})"
  inc patchesApplied

  let bEnd = rm.boundaries.b + 1
  let hook =
    "," & MARKER & "(" & probeExpr() & ").startup(" & gateVar & "," & showFn & ",()=>" &
    settingFn & "(\"menuBarEnabled\"))"
  result = result[0 ..< bEnd] & hook & result[bEnd .. ^1]
  echo &"  [OK] B window creation: hidden launch shown when no tray (gate {gateVar}, show {showFn})"
  inc patchesApplied

  # Positive end-state: both injected shapes are now present exactly once.
  let cOut = allMatches(result, closeDoneRe).len
  let sOut = allMatches(result, startupDoneRe).len
  if cOut != 1 or sOut != 1:
    echo &"  [FAIL] injected shapes in output: close={cOut}, startup={sOut} (want 1 each)"
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
