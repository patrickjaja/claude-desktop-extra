# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Translucent main window, opt-in (default OFF): `windowTransparency` in
# claude-desktop-extra.json(c), switched from Settings -> Extra -> Community
# Features, or CLAUDE_WINDOW_TRANSPARENCY=1|0; `windowTransparencyLevel`
# (0..0.9, default 0.2, higher = more see-through) /
# CLAUDE_WINDOW_TRANSPARENCY_LEVEL sets how see-through the surfaces are (the
# legacy `windowOpacity` / CLAUDE_WINDOW_OPACITY are still read as 1 - value);
# the Settings row's Transparency slider changes it live. Blur behind the
# window is left to the compositor (Hyprland, KWin, ...).
#
# Two sub-patches:
#   A. js/window_transparency.js injected at the head of the main bundle:
#      the options hook, the theme-flip guards, the CSS injection with its live
#      transparency swap, and the Settings IPC handlers.
#   B. The main window's options literal gets `...globalThis.__cdbWinTransExtra()`
#      spliced in right after upstream's `backgroundColor:<fn>(),opacity:<v>,`
#      pair. It spreads AFTER backgroundColor, so its `transparent` and
#      `backgroundColor` keys win (last key wins in a JS object literal), and the
#      pair itself is left untouched: patches/linux/fix_native_frame.nim matches
#      `backgroundColor:<fn>(),opacity:` too. The window FACTORY is deliberately
#      not rewritten - fix_profile_window_title and fix_window_bounds anchor on
#      its exact shape.
#
# transparent is a BrowserWindow constructor option, so toggling needs an app
# RESTART. It requires a frameless window and is skipped when the native
# titlebar is on.
#
# Break risk: LOW for A (stable "use strict"; head anchor). B anchors on the key
# order `backgroundColor:<fn>(),opacity:<v>,icon:` in the main window's options
# literal - the same backgroundColor/opacity pair fix_native_frame anchors on -
# with every identifier a wildcard; a reorder fails loud (match count != 1).

import std/[os, strformat, strutils]
import regex

const PAGE_JS = staticRead("../../js/window_transparency.js")

const MARKER = "__CDB_WINTRANS__"
const HOOK = "...globalThis.__cdbWinTransExtra(),"
const EXPECTED_PATCHES = 2 # head injection + options-literal spread

proc apply*(input: string): string =
  result = input

  # Idempotency: positive end-state assertion - BOTH our module and our spread
  # in the options literal must be present exactly once (AGENTS.md Rule 6).
  let haveModule = result.count(MARKER)
  let haveHook = result.count(HOOK)
  if haveModule == 1 and haveHook == 1:
    echo "  [OK] window transparency: module and options spread already present (idempotent)"
    return
  if haveModule != 0 or haveHook != 0:
    echo &"  [FAIL] window transparency: half-patched bundle (module x{haveModule}, spread x{haveHook}) - re-audit"
    quit(1)

  # Sub-patch B first, so the module text injected by A is never searched.
  # Since v3.1623.0 the background call takes an argument object
  # (`backgroundColor:fQn({signedIn:c}),opacity:1,icon:`), hence the optional `{...}`.
  var n = 0
  result = result.replace(
    re2"""(backgroundColor:[\w$]+(?:\.[\w$]+)*\((?:\{[^{}]*\})?\),opacity:[^,{}]+,)(icon:)""",
    proc(m: RegexMatch2, s: string): string =
      inc n
      s[m.group(0)] & HOOK & s[m.group(1)],
  )
  if n != 1:
    echo &"  [FAIL] window transparency: main-window options pattern matched {n}/1"
    quit(1)
  echo "  [OK] main-window options: transparency spread added"

  # Sub-patch A: positional anchor, same invariant as add_feature_window_controls:
  # the staged file must START with "use strict"; or injecting would push the
  # directive out of first-statement position.
  let strictPrefix = "\"use strict\";"
  if not result.startsWith(strictPrefix):
    echo "  [FAIL] window transparency: staged bundle no longer starts with \"use strict\"; - re-audit the anchor"
    quit(1)
  result = strictPrefix & PAGE_JS & "\n;\n" & result[strictPrefix.len .. ^1]
  echo "  [OK] window transparency module injected after \"use strict\""

  var applied = 0
  if result.count(MARKER) == 1:
    inc applied
  if result.count(HOOK) == 1:
    inc applied
  if applied < EXPECTED_PATCHES:
    echo &"  [FAIL] Only {applied}/{EXPECTED_PATCHES} window-transparency parts present exactly once after patching"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_feature_window_transparency <path_to_index.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: add_feature_window_transparency ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo &"  [PASS] window transparency applied ({EXPECTED_PATCHES}/{EXPECTED_PATCHES} parts)"
  else:
    if output.count(MARKER) != 1:
      echo "  [FAIL] No changes made and the injected module is absent"
      quit(1)
    echo "  [OK] Already applied (no changes needed)"
