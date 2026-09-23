# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Fix updater state missing `version` property on Linux.
#
# On Linux, auto-update is disabled (no update URL for Linux), so the updater
# state stays permanently at {status: "idle"} which has no `version` or
# `versionNumber` property. The "ready" state includes both, and the web
# frontend may call `.includes()` on `version` without null-checking, causing:
#
#   TypeError: Cannot read properties of undefined (reading 'includes')
#
# This patch adds `version:"",versionNumber:""` to the idle state return so
# downstream code always has a defined string to work with.

import std/[os]
import regex

proc apply*(input: string): string =
  # Check if already patched.
  # Since v1.26832.0 the minifier emits template literals for most string
  # literals (case`idle`) and the state enum is reached through a namespace
  # alias (D.r.Idle), so accept either quoting and one-or-more member hops.
  let already =
    re2"""case["`]idle["`]:return\{status:[\w$]+(?:\.[\w$]+)+,version:"",versionNumber:""\}"""
  if input.contains(already):
    echo "  [OK] Updater idle state: already patched (skipped)"
    return input

  # Pattern: case"idle":return{status:<var>.Idle}  (or case`idle` / <ns>.<var>.Idle)
  # We need to add version:"",versionNumber:"" before the closing brace.
  let pattern = re2"""(case["`]idle["`]:return\{status:[\w$]+(?:\.[\w$]+)+)\}"""
  var count = 0
  result = input.replace(
    pattern,
    proc(m: RegexMatch2, s: string): string =
      inc count
      s[m.group(0)] & """,version:"",versionNumber:""}""",
  )
  if count == 1:
    echo "  [OK] Updater idle state: added version/versionNumber (1 match)"
  else:
    echo "  [FAIL] Updater idle state: " & $count & " matches, expected 1"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_updater_state_linux <path_to_index.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_updater_state_linux ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
