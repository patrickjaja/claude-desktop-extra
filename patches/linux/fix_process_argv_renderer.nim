# @patch-target: app.asar.contents/.vite/build/mainView.js
# @patch-type: nim
#
# Fix process.argv being undefined in the web renderer.
#
# The preload exposes a filtered process object to the main world with only
# arch, platform, type, and versions. The Claude Code SDK web bundle
# calls process.argv.includes("--debug") during streamInput(), which throws:
#
#   TypeError: Cannot read properties of undefined (reading 'includes')
#
# This prevents Dispatch responses from rendering in the UI.
#
# Fix: Add argv as an empty array to the exposed process object, right before
# exposeInMainWorld. The empty array makes .includes() return false (correct
# behavior -- the renderer is not in debug mode).

import std/[os]
import regex

proc apply*(input: string): string =
  # Idempotency: OUR insertion sits immediately before the expose call and
  # names the same object it exposes (positive end state, AGENTS.md Rule 6).
  let donePattern =
    re2"""([\w$]+)\.argv=\[\];[\w$]+\.contextBridge\.exposeInMainWorld\(["`]process["`],([\w$]+)\)"""
  var doneCount = 0
  for dm in input.findAll(donePattern):
    if input[dm.group(0)] == input[dm.group(1)]:
      inc doneCount
  if doneCount == 1:
    echo "  [OK] process.argv: already patched (skipped)"
    return input

  # Primary: insert <var>.argv=[] just before exposeInMainWorld("process",<var>).
  # Since v1.26832.0 the minifier emits the channel name as a template literal
  # (`process`), so the quote character is matched as a class.
  let exposePattern =
    re2"""([\w$]+\.contextBridge\.exposeInMainWorld\(["`]process["`],)([\w$]+)(\))"""
  let sites = input.findAll(exposePattern)
  if sites.len == 1:
    let m = sites[0]
    let varName = input[m.group(1)]
    let insert = varName & ".argv=[];"
    let pos = m.boundaries.a
    result = input[0 ..< pos] & insert & input[pos .. ^1]
    echo "  [OK] process.argv: added " & varName & ".argv=[] (before exposeInMainWorld)"
    return result

  echo "  [FAIL] process.argv: " & $sites.len &
    " exposeInMainWorld(\"process\") sites, expected 1"
  quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_process_argv_renderer <path_to_mainView.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_process_argv_renderer ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
