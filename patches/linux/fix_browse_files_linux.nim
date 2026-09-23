# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Enable directory browsing in the browseFiles dialog on Linux.
#
# The upstream code only includes "openDirectory" in the Electron dialog properties
# when running on macOS (darwin). On Linux, the dialog is limited to "openFile" +
# "multiSelections", which prevents users from selecting directories.
#
# Electron fully supports "openDirectory" on Linux, so we add a
# process.platform==="linux" check alongside the existing darwin check.

import std/[os]
import regex

proc apply*(input: string): string =
  # Pattern: the ternary that gates openDirectory behind darwin-only
  #
  # Original: process.platform===`darwin`?[`openFile`,`openDirectory`,`multiSelections`]:[`openFile`,`multiSelections`]
  # Patched:  process.platform===`darwin`||process.platform==="linux"?[`openFile`,…]:[`openFile`,…]
  #
  # All tokens here are stable Electron/Node API names (no minified variables),
  # but the quoting is minifier-dependent: v1.26832.0 emits backtick template
  # literals where earlier builds emitted double quotes, so every string literal
  # is matched with the quote-agnostic ["`] class. The property arrays are
  # captured verbatim and re-emitted unchanged, so we never rewrite upstream's
  # quoting - only the platform test is extended.
  #
  # Idempotency: positively assert OUR injected `||process.platform==="linux"`
  # sits at this exact site (not merely that the darwin-only form is gone).
  let alreadyPatched =
    re2"""process\.platform===["`]darwin["`]\|\|process\.platform==="linux"\?\[["`]openFile["`],["`]openDirectory["`]"""
  var am: RegexMatch2
  if input.find(alreadyPatched, am):
    echo "  [OK] browseFiles openDirectory: already patched (skipped)"
    return input

  let pattern =
    re2"""(process\.platform===["`]darwin["`])(\?\[["`]openFile["`],["`]openDirectory["`],["`]multiSelections["`]\]:\[["`]openFile["`],["`]multiSelections["`]\])"""

  var count = 0
  result = input.replace(
    pattern,
    proc(m: RegexMatch2, s: string): string =
      inc count
      s[m.group(0)] & "||process.platform===\"linux\"" & s[m.group(1)],
  )
  if count != 1:
    echo "  [FAIL] browseFiles openDirectory: " & $count & " matches, expected 1"
    quit(1)
  echo "  [OK] browseFiles openDirectory: 1 match"

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_browse_files_linux <path_to_index.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_browse_files_linux ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] Browse files dialog patched successfully"
  else:
    echo "  [PASS] Browse files dialog already patched for Linux"
