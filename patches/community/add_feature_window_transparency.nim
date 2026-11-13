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
# window is left to the compositor (Hyprland, KWin, ...). Pop-out windows
# follow the main window.
#
# Three sub-patches:
#   A. js/window_transparency.js injected at the head of the main bundle:
#      the options hooks, the theme-flip guards, the CSS injection with its live
#      transparency swap, and the Settings IPC handlers.
#   B. The main window's options literal gets `...globalThis.__cdbWinTransExtra()`
#      spliced in right after upstream's `backgroundColor:<fn>(<arg>),opacity:<v>,`
#      pair, where <arg> is empty or one `{key:var}` object (v3.1623.0:
#      `backgroundColor:fQn({signedIn:c}),opacity:1,icon:`; earlier builds
#      called it with no argument). It spreads AFTER backgroundColor, so its
#      `transparent` and `backgroundColor` keys win (last key wins in a JS
#      object literal), and the pair itself is left untouched:
#      patches/linux/fix_native_frame.nim matches
#      `backgroundColor:<fn>(<arg>),opacity:` too. The window FACTORY is
#      deliberately not rewritten - fix_profile_window_title and
#      fix_window_bounds anchor on its exact shape.
#   C. Pop-out windows: the window manager's window.open handler (v5.1231.2)
#        let{frameName:r,url:i}=t,a=this.pendingWindows.get(r);
#        if(i==="about:blank"&&a){if(a.ownerWebContentsId!==e.id)return ...;
#        let t=this.buildConstructorOptions(a.props,e),n=this.getDefaultWindowOptions();
#        return{action:"allow",overrideBrowserWindowOptions:{...n,...t,webPreferences:{...},show:!1}}}
#      gets its options literal wrapped as
#        (globalThis.__cdbWinTransPopout||function(w,f,o){return o})(e,r,{...})
#      - <opener webContents>, <frame name>, the untouched literal. The
#      function returns the same object unless the main window is transparent
#      (js/window_transparency.js); the `||` keeps the literal when the module
#      is missing. buildConstructorOptions always emits `transparent` and
#      `frame` AFTER the defaults, so the keys cannot go into the defaults; the
#      result has to be rewritten. Every identifier is a wildcard, and the
#      identities between them (frame name, url, registration, opener, the two
#      spreads) are checked after the match, so a reshaped handler fails loud.
#
# transparent is a BrowserWindow constructor option, so toggling needs an app
# RESTART. The main window requires a frameless window and is skipped when the
# native titlebar is on; pop-outs then stay opaque as well.
#
# Break risk: LOW for A (stable "use strict"; head anchor). B anchors on the key
# order `backgroundColor:<fn>(<arg>),opacity:<v>,icon:` in the main window's
# options literal - the same backgroundColor/opacity pair fix_native_frame
# anchors on - with every identifier a wildcard; a reorder fails loud (match
# count != 1). C anchors on the window manager's open handler, a small stable
# class method; a change to its shape fails loud (match count != 1 or an
# identity check fails).

import std/[os, strformat, strutils]
import regex

const PAGE_JS = staticRead("../../js/window_transparency.js")

const MARKER = "__CDB_WINTRANS__"
const HOOK = "...globalThis.__cdbWinTransExtra(),"
const POPOUT_FN = "(globalThis.__cdbWinTransPopout||function(w,f,o){return o})"
const POPOUT_HOOK = "overrideBrowserWindowOptions:" & POPOUT_FN & "("
const EXPECTED_PATCHES = 3 # head injection + options-literal spread + pop-out wrap

# Groups: 0 frameName var, 1 url var, 2 registration var, 3 pendingWindows.get
# arg, 4 url var compared to about:blank, 5 registration tested, 6 registration
# whose owner is checked, 7 opener in the owner check, 8 constructor-options
# var, 9 registration whose props are built, 10 opener passed to
# buildConstructorOptions, 11 defaults var, 12 the options literal, 13 its
# first spread (defaults), 14 its second spread (constructor options).
let popoutPattern = re2(
  """let\{frameName:([\w$]+),url:([\w$]+)\}=[\w$]+,([\w$]+)=this\.pendingWindows\.get\(([\w$]+)\);""" &
    """if\(([\w$]+)==="about:blank"&&([\w$]+)\)\{if\(([\w$]+)\.ownerWebContentsId!==([\w$]+)\.id\)return[^;]*;""" &
    """let ([\w$]+)=this\.buildConstructorOptions\(([\w$]+)\.props,([\w$]+)\),([\w$]+)=this\.getDefaultWindowOptions\(\);""" &
    """return\{action:"allow",overrideBrowserWindowOptions:(\{\.\.\.([\w$]+),\.\.\.([\w$]+),webPreferences:\{[^{}]*\},show:!1\})\}"""
)

# The patched end state of C, asserted for idempotency.
let popoutDone = re2(
  """overrideBrowserWindowOptions:\(globalThis\.__cdbWinTransPopout\|\|function\(w,f,o\)\{return o\}\)\([\w$]+,[\w$]+,\{\.\.\.[\w$]+,\.\.\.[\w$]+,webPreferences:\{[^{}]*\},show:!1\}\)\}"""
)

# Sub-patch C on its own; returns the rewritten text, or raises with the reason.
proc wrapPopoutOptions*(input: string): string =
  let hits = input.findAll(popoutPattern)
  if hits.len != 1:
    raise newException(
      ValueError, &"window manager open handler matched {hits.len}/1 - re-audit"
    )
  let m = hits[0]
  proc g(i: int): string =
    input[m.group(i)]

  if g(0) != g(3) or g(1) != g(4) or g(2) != g(5) or g(2) != g(6) or g(2) != g(9) or
      g(7) != g(10) or g(8) != g(14) or g(11) != g(13):
    raise newException(
      ValueError,
      "window manager open handler: identifiers do not line up (frame name, url, registration, opener or spreads) - re-audit",
    )
  # The wrap passes the opener (10) and the frame name (0) next to the options
  # literal; if the constructor-options variable (8) or the defaults variable
  # (11) shadowed one of them, the emitted call would carry the wrong argument.
  if g(8) == g(0) or g(8) == g(10) or g(11) == g(0) or g(11) == g(10):
    raise newException(
      ValueError,
      "window manager open handler: a spread variable shadows the frame name or the opener - re-audit",
    )
  let lit = m.group(12)
  result =
    input[0 ..< lit.a] & POPOUT_FN & "(" & g(10) & "," & g(0) & "," & input[lit] & ")" &
    input[lit.b + 1 .. ^1]

proc apply*(input: string): string =
  result = input

  # Idempotency: positive end-state assertion - our module, our spread in the
  # main window's options literal and our pop-out wrap must each be present
  # exactly once (AGENTS.md Rule 6).
  let haveModule = result.count(MARKER)
  let haveHook = result.count(HOOK)
  let havePopout = result.count(POPOUT_HOOK)
  if haveModule == 1 and haveHook == 1 and havePopout == 1:
    if result.findAll(popoutDone).len != 1:
      echo "  [FAIL] window transparency: pop-out wrap present but not in the window manager's shape - re-audit"
      quit(1)
    echo "  [OK] window transparency: module, options spread and pop-out wrap already present (idempotent)"
    return
  if haveModule != 0 or haveHook != 0 or havePopout != 0:
    echo &"  [FAIL] window transparency: half-patched bundle (module x{haveModule}, spread x{haveHook}, pop-out wrap x{havePopout}) - re-audit"
    quit(1)

  # Sub-patches B and C first, so the module text injected by A is never searched.
  var n = 0
  result = result.replace(
    re2"""(backgroundColor:[\w$]+(?:\.[\w$]+)*\((?:\{[\w$]+:[\w$]+\})?\),opacity:[^,{}]+,)(icon:)""",
    proc(m: RegexMatch2, s: string): string =
      inc n
      s[m.group(0)] & HOOK & s[m.group(1)],
  )
  if n != 1:
    echo &"  [FAIL] window transparency: main-window options pattern matched {n}/1"
    quit(1)
  echo "  [OK] main-window options: transparency spread added"

  try:
    result = wrapPopoutOptions(result)
  except ValueError as e:
    echo "  [FAIL] window transparency: " & e.msg
    quit(1)
  echo "  [OK] pop-out window options: wrapped in __cdbWinTransPopout"

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
  if result.count(POPOUT_HOOK) == 1 and result.findAll(popoutDone).len == 1:
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
    if output.count(MARKER) != 1 or output.count(POPOUT_HOOK) != 1:
      echo "  [FAIL] No changes made and the injected parts are absent"
      quit(1)
    echo "  [OK] Already applied (no changes needed)"
