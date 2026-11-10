# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Links, "Open in ..." and SSO on hosts where xdg-open is only in a
# root-managed folder outside upstream's narrowed PATH (as with the Nix
# package's wrapper, which carries its own xdg-utils).
#
# Since 4.23118 upstream narrows process.env.PATH at startup to fixed system
# dirs. Electron's shell.openExternal / shell.openPath execvp `xdg-open` from
# the live process.env.PATH synchronously inside the call, and fail silently
# when it is not there, so where xdg-open is only in such a folder every link
# does nothing.
#
# This patch inserts js/open_external_tool_path.js as a head script (right
# after "use strict", or at the very top when an earlier head-script patch
# prepended). It wraps both methods on Linux; a call runs untouched unless
# narrowing is in effect, xdg-open is not on the narrowed PATH, and the shared
# resolver (patches/core/add_tool_path_resolver.nim) finds it in a root-owned
# read-only folder. Then the synchronous call runs with process.env.PATH = the
# resolver's TOOL PATH, restored in `finally` on the same tick.

import std/[os, strutils]

const HOOK_JS = staticRead("../../js/open_external_tool_path.js")

# The defining line: only our injected script contains it.
const MARKER = "function __cdbOpenExternalToolPath(){"
const HEAD = ";(function __cdbOpenExternalToolPath(){"

static:
  doAssert HOOK_JS.startsWith(HEAD),
    "js/open_external_tool_path.js must start with " & HEAD
  doAssert HOOK_JS.count(MARKER) == 1

proc apply*(input: string): string =
  result = input

  let hits = result.count(MARKER)
  if hits == 1 and HOOK_JS in result:
    echo "  [OK] openExternal TOOL PATH head script already present (idempotent)"
    return
  if hits != 0:
    raise newException(
      ValueError, "marker found " & $hits & "x but not our exact head script - re-audit"
    )

  let strictPrefix = "\"use strict\";"
  if result.startsWith(strictPrefix):
    result = strictPrefix & HOOK_JS & result[strictPrefix.len .. ^1]
  else:
    result = HOOK_JS & result
  if result.count(MARKER) != 1 or HOOK_JS notin result:
    raise newException(ValueError, "head script not present after insertion")
  echo "  [OK] openExternal TOOL PATH head script inserted at the bundle head"

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_open_external_tool_path <path_to_index.js>"
    quit(1)

  let filePath = paramStr(1)
  echo "=== Patch: fix_open_external_tool_path ==="
  echo "  Target: " & filePath

  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)

  let input = readFile(filePath)
  var output: string
  try:
    output = apply(input)
  except ValueError as e:
    echo "  [FAIL] " & e.msg
    quit(1)

  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] openExternal TOOL PATH head script installed"
