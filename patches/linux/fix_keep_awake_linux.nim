# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Make "Keep computer awake" actually keep Linux awake on desktops without a
# GNOME/fd.o power-management service (Sway, Hyprland, niri, river, i3, ...).
#
# Upstream's keep-awake takes exactly one Electron blocker:
#   UV=a.powerSaveBlocker.start("prevent-app-suspension")   (v2.7032.0 names)
#   ... a.powerSaveBlocker.stop(UV) ...
# On Linux, Chromium implements that blocker only through
# org.gnome.SessionManager.Inhibit with a fallback to
# org.freedesktop.PowerManagement.Inhibit, and silently does nothing when
# neither name has an owner. It never takes a logind inhibitor
# (services/device/wake_lock/power_save_blocker/power_save_blocker_linux.cc).
#
# Three sub-patches:
#   A. inject js/keep_awake_inhibit.js (globalThis.__cdbKeepAwake) after the
#      stub's "use strict". When neither service has an owner, it holds a
#      `systemd-inhibit --what=sleep --mode=block` lock while keep-awake is on.
#   B. wrap the start call: UV=globalThis.__cdbKeepAwake.start(<start call>)
#      (pass-through; upstream's blocker id is returned unchanged)
#   C. wrap the stop call: (globalThis.__cdbKeepAwake.stop(),<stop call>)

import std/[os, strutils]
import regex

const HELPER_JS = staticRead("../../js/keep_awake_inhibit.js")
const MARKER = "__cdb_keep_awake_inhibit_v1__"
const EXPECTED_PATCHES = 3

const StartPattern =
  re2"""([\w$]+)=([\w$]+)\.powerSaveBlocker\.start\((["`])prevent-app-suspension["`]\)"""
const StartApplied =
  re2"""[\w$]+=globalThis\.__cdbKeepAwake\.start\([\w$]+\.powerSaveBlocker\.start\(["`]prevent-app-suspension["`]\)\)"""
const StopPattern = re2"""([\w$]+)\.powerSaveBlocker\.stop\(([\w$]+)\)"""
const StopApplied =
  re2"""\(globalThis\.__cdbKeepAwake\.stop\(\),[\w$]+\.powerSaveBlocker\.stop\([\w$]+\)\)"""

proc countOf(s: string, p: Regex2): int =
  for _ in s.findAll(p):
    inc result

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0

  # --- A: helper injection ---
  if MARKER in result:
    echo "  [OK] A: keep-awake helper already injected (" & MARKER & ")"
    inc patchesApplied
  else:
    if result.startsWith("\"use strict\";"):
      result = "\"use strict\";" & HELPER_JS & result[len("\"use strict\";") .. ^1]
    else:
      result = HELPER_JS & result
    if MARKER in result:
      echo "  [OK] A: keep-awake helper injected"
      inc patchesApplied
    else:
      echo "  [FAIL] A: helper marker absent after injection"

  # --- B: wrap powerSaveBlocker.start("prevent-app-suspension") ---
  let startDone = countOf(result, StartApplied)
  let startRaw = countOf(result, StartPattern)
  if startDone == 1 and startRaw == 0:
    echo "  [OK] B: start site already wrapped (idempotent)"
    inc patchesApplied
  elif startDone == 0 and startRaw == 1:
    result = result.replace(
      StartPattern,
      proc(m: RegexMatch2, s: string): string =
        let q = s[m.group(2)]
        s[m.group(0)] & "=globalThis.__cdbKeepAwake.start(" & s[m.group(1)] &
          ".powerSaveBlocker.start(" & q & "prevent-app-suspension" & q & "))",
    )
    if countOf(result, StartApplied) == 1:
      echo "  [OK] B: start site wrapped"
      inc patchesApplied
    else:
      echo "  [FAIL] B: start wrap did not land"
  else:
    echo "  [FAIL] B: expected exactly 1 powerSaveBlocker.start(prevent-app-suspension), found raw=" &
      $startRaw & " wrapped=" & $startDone

  # --- C: wrap powerSaveBlocker.stop(id) ---
  let stopDone = countOf(result, StopApplied)
  let stopTotal = countOf(result, StopPattern)
  if stopDone == 1 and stopTotal == 1:
    echo "  [OK] C: stop site already wrapped (idempotent)"
    inc patchesApplied
  elif stopDone == 0 and stopTotal == 1:
    result = result.replace(
      StopPattern,
      proc(m: RegexMatch2, s: string): string =
        "(globalThis.__cdbKeepAwake.stop()," & s[m.group(0)] & ".powerSaveBlocker.stop(" &
          s[m.group(1)] & "))",
    )
    if countOf(result, StopApplied) == 1:
      echo "  [OK] C: stop site wrapped"
      inc patchesApplied
    else:
      echo "  [FAIL] C: stop wrap did not land"
  else:
    echo "  [FAIL] C: expected exactly 1 powerSaveBlocker.stop(...), found total=" &
      $stopTotal & " wrapped=" & $stopDone

  if patchesApplied < EXPECTED_PATCHES:
    echo "  [FAIL] Only " & $patchesApplied & "/" & $EXPECTED_PATCHES &
      " sub-patches applied"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_keep_awake_linux <file>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_keep_awake_linux ==="
  echo "  Target: " & filePath
  let output = apply(readFile(filePath))
  writeFile(filePath, output)
  echo "  [PASS] keep-awake logind inhibitor wired"
