# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Fix app not quitting after cleanup completes.
#
# After the will-quit handler calls preventDefault() and runs cleanup,
# calling app.quit() again becomes a no-op on Linux. The will-quit event
# never fires again, leaving the app stuck.
#
# Solution: Use app.exit(0) instead of app.quit() after cleanup is complete.
# Since all cleanup handlers have already run (mcp-shutdown, quick-entry-cleanup,
# prototype-cleanup), we can safely force exit. Using setImmediate ensures
# the exit happens in the next event loop tick.
#
# Upstream (v2.7032.0) arms its own "Quit watchdog" on the same success path:
# an unref'd 15 s timer (5 s unpackaged) that forces app.exit(0) if the event
# loop is still alive. So without this patch a stuck quit still ends, just up
# to ~15 s later (and reports desktop_quit_watchdog_fired). Re-check on each
# bump whether the second app.quit() still stalls on Linux at all; if it no
# longer does, this patch only shortens an already-bounded wait.

import std/[os, strutils]
import regex

proc apply*(input: string): string =
  # Original pattern: clearTimeout(n)}XX&&YY.app.quit()}
  # Variables change between versions (e.g., S_&&he -> TS&&ce)
  # Note: [\w$]+ is used because minified JS names can contain $ (e.g., f$, u$)
  # The XX&&YY.app.quit() doesn't work after preventDefault() on Linux
  # Replace with setImmediate + app.exit(0) for reliable exit
  let pattern = re2"(clearTimeout\([\w$]+\)\})([\w$]+)&&([\w$]+)(\.app\.quit\(\))"
  # Our end state (positive idempotency marker, AGENTS.md Rule 6).
  let patternDone =
    re2"clearTimeout\([\w$]+\)\}if\([\w$]+\)\{setImmediate\(\(\)=>[\w$]+\.app\.exit\(0\)\)\}"
  let count = input.findAll(pattern).len
  let done = input.findAll(patternDone).len
  if count == 0 and done == 1:
    echo "  [OK] app.quit -> app.exit: already applied (idempotent)"
    return input
  if count != 1 or done != 0:
    if ".app.quit()" in input:
      echo "  [INFO] Found '.app.quit()' in file but pattern didn't match exactly once"
    echo "  [FAIL] app.quit pattern: " & $count & " upstream and " & $done &
      " patched sites, expected exactly 1 upstream site"
    quit(1)
  result = input.replace(
    pattern,
    proc(m: RegexMatch2, s: string): string =
      let grp0 = s[m.group(0)] # clearTimeout(n)}
      let flagVar = s[m.group(1)] # XX
      let electronVar = s[m.group(2)] # YY
      # group(3) is .app.quit() -- we discard it
      grp0 & "if(" & flagVar & "){setImmediate(()=>" & electronVar & ".app.exit(0))}",
  )
  echo "  [OK] app.quit -> app.exit: 1 match"

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_app_quit <file>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_app_quit ==="
  echo "  Target: " & filePath
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
  echo "  [PASS] App quit patched successfully"
