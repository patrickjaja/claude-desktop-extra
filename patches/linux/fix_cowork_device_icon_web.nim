# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Cowork device icon in the claude.ai chat header (1P mode, Linux, no switch).
# Upstream shows a device icon in a chat's title row only when the chat is
# linked to a computer or runs on this one; an unlinked chat shows nothing,
# and on a desktop without a device key (no /dev/tpmrm0 access) that is every
# chat. The page script adds a laptop icon where upstream shows none (X badge:
# no device key; amber dot: keyed, this chat not linked) and one "Linux
# details" row to upstream's own device popovers. Every variant opens
# Settings -> Extra -> Cowork (Linux). It never renders next to upstream's icon.
#
# One sub-patch:
#   A  js/cowork_device_icon_web_main.js, with js/cowork_device_icon_web_page.js
#      embedded as a string, injected after the bundle's "use strict"; (the
#      panel tabs injection point; at the head if the prologue is gone).
#      Main runs the page script in claude.ai / claude.com pages on dom-ready.
#
# The page's anchors are remote claude.ai code that no build can see; they are
# checked at run time ("[cdb-cowork-icon] <key>" in claude.ai-web.log and
# claude-patches.log) and listed in baseline/COWORK_HEADER_ICON_ANCHORS.md.
# Device facts and the deep link go through the fixed cdb-cu-status:icon and
# cdb-extra:open-settings channels in js/extra_settings_main.js.
#
# Idempotency: a rerun requires the exact current injection to be present once.

import std/[os, strutils]

const MAIN_JS = staticRead("../../js/cowork_device_icon_web_main.js")
const PAGE_JS = staticRead("../../js/cowork_device_icon_web_page.js")
const MARKER = "/*__CDB_COWORK_ICON_WEB__*/"
const PLACEHOLDER = "\"__CDB_COWORK_ICON_WEB_PAGE_SRC__\""
const STRICT = "\"use strict\";"

proc escapeJs(s: string): string =
  result = s
  result = result.replace("\\", "\\\\")
  result = result.replace("\"", "\\\"")
  result = result.replace("\n", "\\n")
  result = result.replace("\r", "")

proc injection(): string =
  if MAIN_JS.count(PLACEHOLDER) != 1 or MAIN_JS.count(MARKER) != 1:
    raise newException(ValueError, "main module lost its placeholder or marker")
  for c in PAGE_JS:
    if ord(c) > 127:
      raise newException(ValueError, "page module must be ASCII")
  MAIN_JS.replace(PLACEHOLDER, "\"" & escapeJs(PAGE_JS) & "\"")

proc apply*(input: string): string =
  const EXPECTED_PATCHES = 1
  var patchesApplied = 0
  let code = injection()
  if MARKER in input:
    # Positive end state: our exact, current injection, once. Later prefix
    # injections (panel tabs, ...) may sit between it and the prologue.
    if input.count(MARKER) != 1 or input.count(code) != 1:
      raise newException(ValueError, "injection stale or duplicated")
    echo "  [OK] Cowork device icon: injection already present (idempotent)"
    return input
  # A: after the directive prologue, or at the head when there is none.
  if input.startsWith(STRICT):
    result = STRICT & code & input[STRICT.len .. ^1]
  else:
    result = code & input
  if result.count(MARKER) == 1 and result.count(code) == 1:
    inc patchesApplied
  if patchesApplied != EXPECTED_PATCHES:
    raise newException(
      ValueError, $patchesApplied & "/" & $EXPECTED_PATCHES & " sub-patches applied"
    )
  echo "  [OK] Cowork device icon: main module injected (1/1)"

when isMainModule:
  if paramCount() != 1:
    quit("Usage: fix_cowork_device_icon_web <index.js>", 1)
  let file = paramStr(1)
  echo "=== Patch: fix_cowork_device_icon_web ==="
  if not fileExists(file):
    quit("  [FAIL] File not found: " & file, 1)
  try:
    let input = readFile(file)
    let output = apply(input)
    if output != input:
      writeFile(file, output)
  except ValueError as e:
    quit("  [FAIL] Cowork device icon: " & e.msg, 1)
