# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# GitHub alert callouts in the claude.ai chat (community switch).
#
# Markdown written for GitHub, GitLab, Obsidian and several editors marks a
# blockquote's first line with [!NOTE], [!TIP], [!IMPORTANT], [!WARNING] or
# [!CAUTION]. claude.ai renders that as a plain quote with the marker shown as
# literal text. This patch injects a main-process module that runs a page script
# in every claude.ai / claude.com and 3P app://localhost chat page (skipping
# /setup-desktop-3p): it strips the marker, groups the child elements under it,
# and paints them as a callout whose colour, label and optional icon come from
# a stylesheet inserted with insertCSS.
#
# One sub-patch:
#   A  js/github_alerts_main.js, with js/github_alerts_page.js and
#      js/github_alerts.css embedded as strings, injected after the bundle's
#      "use strict"; (the panel tabs injection point; at the head if the
#      prologue is gone).
#
# Both settings are read on every page load, so a switch applies without a
# restart: githubAlerts (the feature, off by default) and githubAlertIcons
# (icon row, off by default). The Extra settings handlers call
# globalThis.__cdbGithubAlertsRefresh() after a change.
#
# The page's DOM anchors are remote claude.ai code that no build can see; they
# are re-checked at run time and logged as "[cdb-gh-alerts] ..." in
# claude.ai-web.log (main-process lines go to claude-patches.log as
# "[github-alerts] ..."). Editable surfaces (.ProseMirror, contenteditable,
# textarea), document prose and upstream-handled alert/reply blocks are skipped,
# and turning the switch off restores the stripped markers in place.
#
# Idempotency: a rerun requires the exact current injection to be present once.

import std/[os, strutils]

const MAIN_JS = staticRead("../../js/github_alerts_main.js")
const PAGE_JS = staticRead("../../js/github_alerts_page.js")
const PAGE_CSS = staticRead("../../js/github_alerts.css")
const MARKER = "/*__CDB_GITHUB_ALERTS__*/"
const PLACEHOLDER_PAGE = "\"__CDB_GH_ALERTS_PAGE_SRC__\""
const PLACEHOLDER_CSS = "\"__CDB_GH_ALERTS_CSS__\""
const STRICT = "\"use strict\";"

proc escapeJs(s: string): string =
  result = s
  result = result.replace("\\", "\\\\")
  result = result.replace("\"", "\\\"")
  result = result.replace("\n", "\\n")
  result = result.replace("\r", "")

proc injection(): string =
  if MAIN_JS.count(PLACEHOLDER_PAGE) != 1 or MAIN_JS.count(PLACEHOLDER_CSS) != 1 or
      MAIN_JS.count(MARKER) != 1:
    raise newException(ValueError, "main module lost a placeholder or its marker")
  for c in PAGE_JS:
    if ord(c) > 127:
      raise newException(ValueError, "page module must be ASCII")
  for c in PAGE_CSS:
    if ord(c) > 127:
      raise newException(ValueError, "stylesheet must be ASCII")
  result = MAIN_JS
  result = result.replace(PLACEHOLDER_PAGE, "\"" & escapeJs(PAGE_JS) & "\"")
  result = result.replace(PLACEHOLDER_CSS, "\"" & escapeJs(PAGE_CSS) & "\"")

proc apply*(input: string): string =
  const EXPECTED_PATCHES = 1
  var patchesApplied = 0
  let code = injection()
  if MARKER in input:
    # Positive end state: our exact, current injection, once. Later prefix
    # injections (panel tabs, ...) may sit between it and the prologue.
    if input.count(MARKER) != 1 or input.count(code) != 1:
      raise newException(ValueError, "injection stale or duplicated")
    echo "  [OK] GitHub alerts: injection already present (idempotent)"
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
  echo "  [OK] GitHub alerts: main module injected (1/1)"

when isMainModule:
  if paramCount() != 1:
    quit("Usage: add_feature_github_alerts <index.js>", 1)
  let file = paramStr(1)
  echo "=== Patch: add_feature_github_alerts ==="
  if not fileExists(file):
    quit("  [FAIL] File not found: " & file, 1)
  try:
    let input = readFile(file)
    let output = apply(input)
    if output != input:
      writeFile(file, output)
  except ValueError as e:
    quit("  [FAIL] GitHub alerts: " & e.msg, 1)
