# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Custom keyboard shortcuts for Voice mode, New voice chat, Read aloud, and
# Send now on queued messages (issues #350, #352).
#
# Injects js/custom_shortcuts_main.js (with js/custom_shortcuts_page.js embedded)
# after the bundle's "use strict"; prologue (at the head if absent).
#
# Settings are persisted under `customShortcuts` in
# <userData>/claude-desktop-extra.json (.jsonc overrides and locks per field)
# and configured in Settings -> Extra -> Custom Shortcuts (plus the Community
# Features switch). Off and unbound by default; leaving shortcuts off or clear
# leaves upstream behavior untouched.
#
# The page executor relies on remote claude.ai anchors checked at runtime and
# logged as "[cdb-shortcuts] ..." (baseline/CUSTOM_SHORTCUTS_ANCHORS.md).

import std/[os, strutils, json]

const MAIN_JS = staticRead("../../js/custom_shortcuts_main.js")
const PAGE_JS = staticRead("../../js/custom_shortcuts_page.js")

const MARKER = "/*__CDB_CUSTOM_SHORTCUTS__*/"
const PLACEHOLDER = "\"__CDB_SHORTCUTS_PAGE_SRC__\""
const STRICT = "\"use strict\";"
const DEFINE_MARKER = "globalThis.__cdbCustomShortcuts = Object.freeze("

const MARKERS =
  [MARKER, "\"cdb-shortcuts:pref-read\"", "\"cdb-shortcuts:bind\"", DEFINE_MARKER]

proc injection(): string =
  if MAIN_JS.count(PLACEHOLDER) != 1 or MAIN_JS.count(MARKER) != 1 or
      MAIN_JS.count(DEFINE_MARKER) != 1:
    raise
      newException(ValueError, "custom_shortcuts_main.js lost a placeholder or marker")
  if PLACEHOLDER in PAGE_JS or MARKER in PAGE_JS:
    raise
      newException(ValueError, "custom_shortcuts_page.js contains a reserved marker")
  result = MAIN_JS.replace(PLACEHOLDER, escapeJson(PAGE_JS))
  if PLACEHOLDER in result:
    raise newException(ValueError, "placeholder survived substitution")

proc markersPresent(s: string): int =
  for m in MARKERS:
    if m in s:
      inc result

proc apply*(input: string): string =
  const EXPECTED_PATCHES = 1
  var patchesApplied = 0
  let code = injection()

  let present = markersPresent(input)
  if present == MARKERS.len:
    if input.count(MARKER) != 1 or input.count(code) != 1:
      raise newException(ValueError, "injection stale or duplicated")
    echo "  [OK] Custom shortcuts: injection already present (idempotent)"
    return input
  elif present > 0:
    raise newException(
      ValueError,
      "partial injection detected (" & $present & "/" & $MARKERS.len &
        " markers) -- refusing to patch on top",
    )

  if input.startsWith(STRICT):
    result = STRICT & code & input[STRICT.len .. ^1]
  else:
    result = code & input

  if markersPresent(result) == MARKERS.len and result.count(MARKER) == 1 and
      result.count(code) == 1:
    inc patchesApplied

  if patchesApplied != EXPECTED_PATCHES:
    raise newException(
      ValueError, $patchesApplied & "/" & $EXPECTED_PATCHES & " sub-patches applied"
    )
  echo "  [OK] Custom shortcuts: main module injected (1/1)"

when isMainModule:
  if paramCount() != 1:
    quit("Usage: add_feature_custom_shortcuts <index.js>", 1)
  let file = paramStr(1)
  echo "=== Patch: add_feature_custom_shortcuts ==="
  if not fileExists(file):
    quit("  [FAIL] File not found: " & file, 1)
  try:
    let input = readFile(file)
    let output = apply(input)
    if output != input:
      writeFile(file, output)
  except ValueError as e:
    quit("  [FAIL] Custom shortcuts: " & e.msg, 1)
