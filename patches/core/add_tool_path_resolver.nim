# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Shared tool lookup for our main-process patches: globalThis.__cdbToolPath.
#
# Since 4.23118 upstream narrows process.env.PATH in index.pre.js, before any
# of our code loads, to a fixed list of root-owned system dirs, and keeps the
# launch PATH in CLAUDE_DESKTOP_STARTED_PATH. Tools our patches ran by bare
# name (xdg-mime, xdg-open, git, hyprctl, secret-tool, qemu-system-*) now miss
# every root-managed dir outside that list: a NixOS wrapper's store dirs,
# /etc/profiles/per-user/<user>/bin, the rpm's qemu shim dir.
#
# This patch inserts js/tool_path.js as a head script, right after the
# bundle's "use strict" like fix_profile_app_identity.nim (or at the very top
# when an earlier head-script patch already prepended). It defines
# globalThis.__cdbToolPath (Linux only): which(bin) resolves a tool on the
# narrowed dirs plus the started dirs that pass upstream's own trust rule, and
# returns the absolute path to spawn. It changes no upstream behavior and never
# writes process.env.PATH; consumers in other patches use it when present and
# keep their old bare-name code when it is missing.
#
# Order: every consumer looks the global up at call time, and the head script
# runs before any chunk of the main bundle is evaluated.

import std/[os, strutils]

const RESOLVER_JS = staticRead("../../js/tool_path.js")

# The defining line: only our injected script contains it.
const MARKER =
  "Object.defineProperty(globalThis, \"__cdbToolPath\", { value: Object.freeze({"
const HEAD = ";(function __cdbToolPathInit(){"

static:
  doAssert RESOLVER_JS.startsWith(HEAD), "js/tool_path.js must start with " & HEAD
  doAssert RESOLVER_JS.count(MARKER) == 1
  doAssert RESOLVER_JS.count(HEAD) == 1

proc apply*(input: string): string =
  result = input

  let hits = result.count(MARKER)
  if hits == 1 and RESOLVER_JS in result:
    echo "  [OK] tool path resolver head script already present (idempotent)"
    return
  if hits != 0 or HEAD in result:
    raise newException(
      ValueError,
      "resolver marker found " & $hits & "x but not our exact head script - re-audit",
    )

  # Earlier head-script patches (basename order) may have prepended ahead of
  # the bundle's "use strict"; both placements run before upstream's code.
  let strictPrefix = "\"use strict\";"
  if result.startsWith(strictPrefix):
    result = strictPrefix & RESOLVER_JS & result[strictPrefix.len .. ^1]
  else:
    result = RESOLVER_JS & result
  if result.count(MARKER) != 1 or RESOLVER_JS notin result:
    raise newException(ValueError, "head script not present after insertion")
  echo "  [OK] tool path resolver head script inserted at the bundle head"

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_tool_path_resolver <path_to_index.js>"
    quit(1)

  let filePath = paramStr(1)
  echo "=== Patch: add_tool_path_resolver ==="
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
    echo "  [PASS] Tool path resolver head script installed"
