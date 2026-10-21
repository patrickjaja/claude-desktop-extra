# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# "Extra" area inside the claude.ai Settings modal (Themes + Community Features +
# Models + Anthropic Features + Deployment).
#
# The Settings modal is rendered by the REMOTE claude.ai SPA inside the mainView
# WebContentsView, so the UI cannot be a React route of ours: it is injected into
# the live page. This patch is the main-process half of that.
#
#   * ipcMain handlers: cdb-extra:themes-list / :paths / :reveal / :diag,
#     cdb-flags:catalog / :read / :set / :unset, cdb-glow:read / :set,
#     cdb-deploy:read / :mode / :set / :apply / :raw / :save-raw, cdb-app:relaunch.
#     cdb-themes:apply and cdb-themes:active are NOT registered here - they are
#     owned by add_feature_theme_picker.nim and the page calls them directly.
#   * the writer of the 1P/3P deployment mode and of the third-party configuration
#     the app boots from. Both files are upstream's own and user-level - the
#     persisted deploymentMode key in <userData>-3p/claude_desktop_config.json and
#     the applied entry of <userData>-3p/configLibrary - so no patch to the
#     bootstrap and no root is needed. /etc/claude-desktop/managed-settings.json
#     is only ever READ (it needs root and, when valid, wins over both).
#     The pinned key catalog in js/extra_settings_main.js is version-sensitive:
#     re-extract it from the bundle's schema on an upstream bump.
#   * the single writer of growthbookOverrides in <userData>/claude-desktop-extra.json
#     (atomic tmp+rename). The .jsonc is human-owned and never created or
#     rewritten here; entries a user put there win per flag id, and the UI shows
#     those toggles as disabled with that reason instead of pretending otherwise.
#   * page installation on every http(s) dom-ready: insertCSS (never CSP-gated,
#     no external asset) plus one executeJavaScript whose return value is logged.
#
# The renderer reaches all of this through the fixed-method cdbExtra bridge added
# by add_feature_extra_settings_bridge.nim (a separate .nim because the
# orchestrator stages every @patch-target in isolation - a patch can only touch
# the file named in its own header).
#
# Cross-patch state is read lazily via globalThis: same-anchor prefix injections
# stack in reverse order, so this code RUNS BEFORE add_feature_custom_themes
# installs globalThis.__cdbThemes. Handlers tolerate a missing registry.
#
# Break risk: VERY LOW on the desktop side - no regex against minified app code,
# only the stable "use strict"; prefix and standard Electron APIs. The real
# fragility is the remote Settings markup: the page script anchors on semantics
# only ([role=dialog] plus the visible text of known nav items), never on a
# generated class name, and every failure is soft (one diagnostic line, then
# nothing - Ctrl+Shift+T stays the robust fallback).

import std/[os, strutils, json]
# `regex` (pure Nim) rather than std/nre: nre dlopens the legacy libpcre.so.3 at
# runtime, which Ubuntu 24.04 - the CI test host - no longer ships (PCRE2 only),
# so an nre-built binary exits 1 before it reads its input. Every other patch
# that the feature-test harnesses execute uses `regex` for exactly this reason.
import regex

const MAIN_JS = staticRead("../../js/extra_settings_main.js")
const PAGE_JS = staticRead("../../js/extra_settings_page.js")
const PAGE_CSS = staticRead("../../js/extra_settings_page.css")

# The page script and its stylesheet are spliced into the main-process IIFE as
# JS string literals (escapeJson yields a quoted, fully escaped literal). The
# placeholders are plain strings in the .js so it passes node --check unpatched.
const EXTRA_JS = MAIN_JS.replace("\"__CDB_EX_PAGE_SRC__\"", escapeJson(PAGE_JS)).replace(
    "\"__CDB_EX_PAGE_CSS__\"", escapeJson(PAGE_CSS)
  )

const EXPECTED_PATCHES = 2

# Positive end-state markers (Rule 6): the build tag, one handler name per panel
# from the main half, and one class name from the page half - so a partially
# spliced payload cannot report success.
const MARKERS =
  ["__cdb_extra_settings", "\"cdb-flags:set\"", "\"cdb-deploy:mode\"", "cdbx-navgroup"]

proc markersPresent(s: string): int =
  for m in MARKERS:
    if m in s:
      result.inc

proc apply*(input: string): string =
  result = input

  # Compile-time splice sanity: neither placeholder may survive into the bundle.
  if "__CDB_EX_PAGE_SRC__" in EXTRA_JS or "__CDB_EX_PAGE_CSS__" in EXTRA_JS:
    echo "  [FAIL] page src/css placeholder was not substituted -- js/extra_settings_main.js drifted"
    quit(1)

  # Our own payload must never contain sub-patch B's end-state shape, or that
  # sub-patch would read its own idempotency marker out of sub-patch A's output.
  var guardMatch: RegexMatch2
  if EXTRA_JS.find(re2"""\}globalThis\.__cdbRelaunchApp=""", guardMatch):
    echo "  [FAIL] js/extra_settings_main.js contains the relaunch-capture end-state shape -- " &
      "sub-patch B's idempotency check would false-positive"
    quit(1)

  var patchesApplied = 0

  # ── Sub-patch A: the Extra settings IIFE ───────────────────────────────
  # Idempotency: assert OUR injected end-state, never merely the absence of
  # something else.
  let present = markersPresent(result)
  if present == MARKERS.len:
    echo "  [OK] Extra settings area already injected (" & $present & "/" & $MARKERS.len &
      " markers present)"
    patchesApplied.inc
  elif present > 0:
    echo "  [FAIL] Partial injection detected (" & $present & "/" & $MARKERS.len &
      " markers) -- refusing to patch on top; re-audit the bundle"
    quit(1)
  else:
    let strictPrefix = "\"use strict\";"
    if result.startsWith(strictPrefix):
      result = strictPrefix & EXTRA_JS & result[strictPrefix.len .. ^1]
      echo "  [OK] Extra settings IIFE inserted after \"use strict\""
    else:
      result = EXTRA_JS & result
      echo "  [OK] Extra settings IIFE prepended"

    let found = markersPresent(result)
    if found < MARKERS.len:
      for m in MARKERS:
        if m notin result:
          echo "  [FAIL] marker missing after injection: " & m
      echo "  [FAIL] Only " & $found & "/" & $MARKERS.len &
        " markers present -- aborting"
      quit(1)
    echo "  [OK] " & $found & "/" & $MARKERS.len & " end-state markers verified"
    patchesApplied.inc

  # ── Sub-patch B: publish upstream's relaunch primitive ─────────────────
  # `cdb-app:relaunch` used `app.relaunch(); app.exit(0)`, which emits neither
  # "before-quit" nor "will-quit" and therefore skips every registered
  # onQuitCleanup handler: the Cowork VM is killed instead of stopped, MCP child
  # processes are cut off, and the main window's geometry is never persisted.
  # Upstream's own primitive is
  #   function nfi(e=[]){a.app.isPackaged?sA(!0,e):Uk(e)}
  # where sA sets the latch that bypasses the before-quit veto interceptor,
  # stashes the relaunch args and calls app.quit() so the cleanup pass runs and
  # the relaunch happens at the end of it. Capture it onto globalThis so
  # js/extra_settings_main.js (a different chunk) can reach it; that file keeps
  # the old exit(0) path as a fallback, so a moved anchor degrades to the
  # previous behaviour rather than a dead button.
  block:
    const RELAUNCH_ASSIGN = "globalThis.__cdbRelaunchApp="
    # Idempotency must key off OUR injected END-STATE, and that end-state has to
    # be distinguishable from any MENTION of the same global. sub-patch A has
    # already spliced js/extra_settings_main.js into `result` by this point, and
    # that file reads the global by name - so a bare substring search would start
    # reporting "already patched" the day anyone writes an assignment to it
    # there, leaving the bundle silently uncaptured on a green build. Anchor on
    # the injection's structural neighbour instead: the closing brace of the
    # captured function declaration immediately followed by the assignment.
    let landedPat = re2"""\}globalThis\.__cdbRelaunchApp=[\w$]+;"""
    var landed: RegexMatch2
    if result.find(landedPat, landed):
      echo "  [OK] relaunch capture already present (idempotent)"
      patchesApplied.inc
    else:
      # `regex` has no backreferences, so the parameter is captured at each of its
      # three positions and the three are compared explicitly below - the same
      # idiom add_feature_files_quick_open_worker uses for its method params.
      # v3.1623.0 put an optional local between the signature and the ternary:
      #   function FHa(e=[]){let t=G().type==="3p"&&ou()==="1p"?[...e,j$t]:e;
      #                      a.app.isPackaged?Mj(!0,t):fj(t)}
      # (3p mode appends a marker arg), so both arms forward that local, not the
      # parameter. Group 2 is the optional `let <local>=<expr>;` prefix (empty on
      # the older shape); the arms must forward the local when it is present and
      # the parameter otherwise.
      let relaunchPat =
        re2"""function ([\w$]+)\(([\w$]+)=\[\]\)\{((?:let [\w$]+=[^;{}]*;)?)[\w$]+\.app\.isPackaged\?[\w$]+\(!0,([\w$]+)\):[\w$]+\(([\w$]+)\)\}"""
      # Count first: a second matching site after a re-minify would mean we are
      # guessing which one to capture.
      let hits = findAll(result, relaunchPat)
      if hits.len != 1:
        echo "  [FAIL] relaunchApp capture: " & $hits.len &
          " matches (expected exactly 1) -- re-audit the bundle"
        quit(1)
      let m = hits[0]
      let fnName = result[m.group(0)]
      let param = result[m.group(1)]
      let prefix = result[m.group(2)]
      var forwarded = param
      if prefix.len > 0:
        let localPat = re2"""^let ([\w$]+)="""
        var lm: RegexMatch2
        if not prefix.find(localPat, lm):
          echo "  [FAIL] relaunchApp capture: cannot read the local declared in `" &
            prefix & "`"
          quit(1)
        forwarded = prefix[lm.group(0)]
      if result[m.group(3)] != forwarded or result[m.group(4)] != forwarded:
        echo "  [FAIL] relaunchApp capture: the two arms forward (" & result[m.group(3)] &
          ", " & result[m.group(4)] & ") but the forwarded value is `" & forwarded &
          "` -- wrong site"
        quit(1)
      result =
        result[0 ..< m.boundaries.a] & result[m.boundaries] & RELAUNCH_ASSIGN & fnName &
        ";" & result[m.boundaries.b + 1 .. ^1]
      if not result.find(landedPat, landed):
        echo "  [FAIL] relaunchApp capture did not land"
        quit(1)
      echo "  [OK] relaunch capture: upstream relaunchApp published as globalThis.__cdbRelaunchApp"
      patchesApplied.inc

  if patchesApplied < EXPECTED_PATCHES:
    echo "  [FAIL] Only " & $patchesApplied & "/" & $EXPECTED_PATCHES &
      " patches applied"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_feature_extra_settings <path_to_index.js>"
    quit(1)

  let filePath = paramStr(1)
  echo "=== Patch: add_feature_extra_settings ==="
  echo "  Target: " & filePath

  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)

  let input = readFile(filePath)
  let output = apply(input)

  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] Extra settings area (Themes + Community Features + Models + Anthropic Features + Deployment) added"
  else:
    echo "  [WARN] No changes made"
