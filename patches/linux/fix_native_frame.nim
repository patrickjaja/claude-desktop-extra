# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Make Claude Desktop use the integrated (Windows-style) titlebar on Linux
# by default: min/max/close are drawn as an overlay inside the web content
# and the tab strip / menu / nav buttons share that bar. Upstream's Linux
# build instead opens a native window because the titleBarOverlay property is
# gated on a win32-only boolean, and the helper that pushes theme updates is
# gated the same way.
#
# Two patches together do the job:
#   1. Open the main BrowserWindow with frame:false + a real titleBarOverlay
#      style object on Linux (plus hasShadow + autoHideMenuBar).
#   2. Keep Anthropic's plain window background in the overlay style in
#      Linux integrated mode, instead of the value upstream feeds through its
#      alpha-blend helper. Electron on Wayland has painted that blended value
#      as a grey strip, so without this gate the overlay looks like a grey
#      block. Since v3.1623.0 the helper hoists the color into one ternary
#      (`o=e==="main"&&pQn()||RI(),s=n?<light/dark>:r?e0n(o):o`), so the gate
#      is injected before `r?e0n(o):o` and Linux integrated mode takes `o`.
#
# A third sub-patch carries the native and bare modes to the pop-out windows
# (see the POPOUT_MARKER block at the end of apply()).
#
# (A third sub-patch used to widen upstream's win32-only gate on the
# setTitleBarOverlay theme-update call. Upstream dropped that gate in
# v1.13576.0 - the call is unconditional, so Linux windows receive theme
# updates natively and there is nothing left to inject. The remaining
# assert-only check was removed at v1.32352.1 per the no-guard policy.)
#
# Three mutually exclusive Linux titlebar modes, all decided at RUNTIME from
# two env vars, so one patched asar serves every mode:
#
#   native      nativeTitlebar / -TITLEBAR=1    frame:true + titleBarStyle
#               (highest precedence)            "default".
#   bare        noWindowControls / -CONTROLS=1  frame:false, NO overlay,
#               (and not native)                hasShadow:false.
#   integrated  neither (default)               frame:false + themed overlay.
#
# Each mode is requested by a config key in claude-desktop-extra.json (toggled
# in Settings -> Extra -> Community) OR by its launcher env var / flag
# (`--native-titlebar`, `--no-window-controls`), whichever is set. Neither can
# apply live: `setTitleBarOverlay(false)` throws and there is no `setFrame`, so
# the settings rows tell the user a restart is needed.
#
# Since Electron 44.5.0 (electron#54391; bundled 44.7.0 from v2.37337.1)
# Chromium no longer paints that border on these WMs - measured on xfwm4:
# the window is exactly its content size with no _GTK_FRAME_EXTENTS - so bare
# mode is now purely "no window-control buttons". History below.
#
# Why bare mode existed: on window managers where Chromium refused to set
# _GTK_FRAME_EXTENTS - xfwm4 (hardcoded carve-out in X11Window::
# CanSetDecorationInsets, see electron/electron#52024) and WMs that do not
# advertise the hint at all (i3, Awesome) - Chromium paints a 4 px client-side
# border inside frameless windows, colored from the GTK headerbar. Chromium
# gates that paint on
#
#   wants_frame_ = !IsTranslucent() && (HasShadow() || IsWindowControlsOverlayEnabled())
#
# so it only clears when the overlay is off AND hasShadow is false. BOTH are
# required: measured on Electron 44.3.0, dropping the overlay while leaving the
# default shadow still paints the band. That is why bare mode sets hasShadow
# explicitly - removing it silently brings the border back. Bare mode keeps the
# resize band's input region, so dragging window edges still resizes; the cost
# is that there are no window-control buttons (close/minimize via the WM).
#
# Anthropic's bundle is minified and renames identifiers between releases.
# We capture the main window's background call at patch time via [\w$]+
# wildcards so the generated code references the current names, and match
# everything else by shape. We fail loudly if any capture is missing.
#
# Quick Entry's BrowserWindow is matched by `transparent:!0,frame:!1` and
# has no titleBarOverlay -- none of the patterns below touch it.

import std/[os, strformat, strutils]
import regex

const LINUX = "process.platform===\"linux\""

# Each mode is requested by a config key OR its launcher env var, resolved at
# window-construction time. `__cdbNativeTb` / `__cdbNoWinCtl` are the memoized
# readers add_feature_window_controls.nim injects (they OR the config key with
# the env var); each call here is DEFENSIVE and falls back to the env var alone,
# so this patch never hard-depends on that one. Without the fallback a missing
# or failed community injection would throw a TypeError while building the main
# window options - i.e. no window at all - instead of degrading to flag-only
# control.
const NATIVE_ON =
  "(globalThis.__cdbNativeTb?!!globalThis.__cdbNativeTb():" &
  "process.env.CLAUDE_NATIVE_TITLEBAR===\"1\")"
const BARE_ON =
  "(globalThis.__cdbNoWinCtl?!!globalThis.__cdbNoWinCtl():" &
  "process.env.CLAUDE_NO_WINDOW_CONTROLS===\"1\")"

# The three modes are mutually exclusive and native WINS, whichever surface each
# request came from - so bare must also test !NATIVE_ON, not just BARE_ON. This
# is the single place the precedence lives; the injected readers stay dumb and
# only answer "is my mode requested".
const LINUX_NATIVE = LINUX & "&&" & NATIVE_ON
# Frameless covers BOTH remaining modes (integrated and bare), so `frame` keeps
# its historical value in integrated mode and bare mode inherits it.
const LINUX_FRAMELESS = LINUX & "&&!" & NATIVE_ON
const LINUX_BARE = LINUX & "&&!" & NATIVE_ON & "&&" & BARE_ON
const LINUX_INTEGRATED = LINUX & "&&!" & NATIVE_ON & "&&!" & BARE_ON

# Patch 2's injection. Unique to that sub-patch (patch 1 emits LINUX_INTEGRATED
# only as `(...)?`), so the idempotency check can assert it positively.
const OVERLAY_GATE = "!(" & LINUX_INTEGRATED & ")&&"

# Sub-patch 3's injection marker, unique to this patch.
const POPOUT_MARKER = "/*__CDB_POPOUT_FRAME__*/"

# The transparent-window reader js/window_transparency.js defines (it answers
# true exactly when the main window is, or is about to be, built transparent):
# a transparent pop-out gets the window manager's frame too. Guarded - absent
# (module not loaded) or throwing means false. Basename order puts
# add_feature_window_transparency BEFORE this patch, but nothing here keys
# idempotency on the name; POPOUT_MARKER is the only end-state check.
const TRANSP_FRAMED =
  "(typeof globalThis.__cdbWinTransPopoutFramed===\"function\"&&" &
  "(()=>{try{return globalThis.__cdbWinTransPopoutFramed()===!0}catch(_){return!1}})())"

# Sub-patch 1a's marker (the builder's titleBarStyle), unique to this patch.
const TBSTYLE_MARKER = "/*__CDB_NATIVE_TBSTYLE__*/"

proc matchBrace(s: string, open: int): int =
  ## Index of the `}` closing the `{` at `open`, skipping string and template
  ## literals (no `${` nesting needed for an options literal); -1 if none.
  var depth = 0
  var i = open
  while i < s.len:
    let c = s[i]
    if c == '"' or c == '\'' or c == '`':
      inc i
      while i < s.len and s[i] != c:
        if s[i] == '\\':
          inc i
        inc i
    elif c == '{':
      inc depth
    elif c == '}':
      dec depth
      if depth == 0:
        return i
    inc i
  -1

proc capture(s: string, pat: Regex2, name: string): string =
  ## Capture group 1 of the single match of `pat` in `s`, or raise with `name`
  ## in the message (no match, or more than one).
  var hits = 0
  var cap = ""
  for m in s.findAll(pat):
    inc hits
    cap = s[m.group(0)]
  if hits != 1:
    raise newException(ValueError, &"fix_native_frame: {name}: {hits}/1 matches")
  cap

proc apply*(input: string): string =
  # Assert OUR OWN injected end-state, not merely that the pre-patch shape is
  # gone: a bundle carrying only an older injection must fall through and fail
  # loudly on the patterns below rather than report a false [INFO].
  #
  # The marker MUST be unique to this patch. It used to be "__cdbNoWinCtl",
  # which add_feature_window_controls.nim ALSO injects (it defines that global)
  # - and that patch sorts BEFORE this one in basename order, so on a real
  # build this patch found the other patch's token, reported "already patched"
  # and silently left the main window unpatched: no frameless window, no
  # overlay, upstream's own titlebar, and a GREEN build. Never key idempotency
  # off a token another patch can emit.
  if "__CDB_NATIVE_FRAME__" in input:
    if OVERLAY_GATE notin input:
      raise newException(
        ValueError, "marker present but the overlay-color gate (patch 2) is missing"
      )
    if POPOUT_MARKER notin input:
      raise newException(
        ValueError, "marker present but the pop-out title bar gate (patch 3) is missing"
      )
    if TBSTYLE_MARKER notin input:
      raise newException(
        ValueError,
        "marker present but the builder's titleBarStyle gate (patch 1a) is missing",
      )
    if TRANSP_FRAMED notin input:
      raise newException(
        ValueError,
        "pop-out gate present without the transparent-window frame condition - re-audit",
      )
    echo "  [INFO] already patched"
    return input
  result = input

  # Anthropic identifiers (minified, renamed between releases):
  #   bgCall    the window background color CALL, verbatim: `yL()` up to
  #             v2.42304.2, `fQn({signedIn:c})` since v3.1623.0. The argument
  #             is load-bearing - fQn destructures it, so a bare `fQn()` throws
  #             a TypeError while the options are built (no window at all).
  # bgCall is captured from the main-window options site and only ever emitted
  # back into that same object (patch 1), where its argument is in scope; the
  # shadowing guard below asserts that.
  let bgCall = result.capture(
    re2"""backgroundColor:([\w$]+(?:\.[\w$]+)*\((?:\{[\w$]+:[\w$]+\})?\)),opacity:""",
    "backgroundColor call",
  )
  # The electron alias is NOT captured: the first `X.nativeTheme` in the staged
  # stub+chunks file can live in another chunk with a different alias (v2.9939.4
  # captured `i` while the options site uses `a` -> TypeError, no window).
  # require("electron") is always valid in the main process.
  let electron = "require(\"electron\")"

  # Patch 1: main BrowserWindow options. Since v6.28899.2 they are built in two
  # places (up to v5.11492.5 one literal held `titleBarStyle:"hidden",
  # titleBarOverlay:!0`):
  #   f=(e=>BEe(new u.BrowserWindow(e)))(kOr({...rSe(e),...e2i(),
  #       titleBarOverlay:!0,trafficLightPosition:$wo(),show:i&&!0,
  #       backgroundColor:WWi({signedIn:s}),opacity:+!c},d?void 0:l))
  #   function kOr(e,t){return{...e,title:_yr(),titleBarStyle:"hidden",
  #       icon:..,webPreferences:{preload:...mainWindow.js,..}}}
  # 1a. In the builder: titleBarStyle -> "default" in native mode, "hidden"
  #     otherwise (the builder's keys come after its spread, so the call site
  #     cannot set it).
  # 1b. At the builder's one call site, right after titleBarOverlay:
  #   titleBarOverlay:  Anthropic-themed style object in integrated mode,
  #                     false in bare mode (this is what disables the window
  #                     controls), upstream's value otherwise.
  #   frame:            false in BOTH frameless modes, true otherwise.
  #   hasShadow:        false in bare mode only - load-bearing, see the header.
  #   autoHideMenuBar:  true on Linux (Alt brings the GTK menu bar back).
  #
  # We deliberately do NOT splice an `icon:` here: upstream passes its own
  # `icon:` (in the builder, after the spread), and the last key wins, so ours
  # would be silently discarded. Upstream's icon.png ships in the tree we
  # repackage, so there is nothing to fix. See the shadowing guard below.
  let overlayStyle =
    "{color:" & bgCall & ",symbolColor:" & electron &
    ".nativeTheme.shouldUseDarkColors?\"#fff\":\"#000\",height:36}"

  # 1a. The builder: `function B(e,t){return{...e,title:F(),titleBarStyle:"hidden",`
  # whose literal preloads .vite/build/mainWindow.js.
  var builder = ""
  var builderLit = (a: -1, b: -1) # the builder's returned literal, braces included
  var builders = 0
  for m in result.findAll(
    re2"""function ([\w$]+)\(([\w$]+),[\w$]+\)\{return(\{)\.\.\.([\w$]+),title:[\w$]+\(\),titleBarStyle:["`]hidden["`],"""
  ):
    if result[m.group(1)] != result[m.group(3)]:
      continue
    let lb = m.group(2).a
    let le = result.matchBrace(lb)
    if le < 0 or not result[lb .. le].contains(".vite/build/mainWindow.js"):
      continue
    inc builders
    builder = result[m.group(0)]
    builderLit = (a: lb, b: le)
  if builders != 1:
    raise newException(ValueError, &"main window options builder: {builders}/1")
  block:
    let lit = result[builderLit.a .. builderLit.b]
    let at = lit.find("titleBarStyle:")
    let q = lit[at + "titleBarStyle:".len]
    let oldVal = "titleBarStyle:" & q & "hidden" & q & ","
    if not lit.continuesWith(oldVal, at):
      raise newException(ValueError, "main window options builder: titleBarStyle shape")
    let newLit =
      lit[0 ..< at] & "titleBarStyle:" & LINUX_NATIVE & "?\"default\":\"hidden\"" &
      TBSTYLE_MARKER & "," & lit[at + oldVal.len .. ^1]
    result = result[0 ..< builderLit.a] & newLit & result[builderLit.b + 1 .. ^1]
    builderLit.b += newLit.len - lit.len
  echo &"  [OK] main window options builder {builder}: titleBarStyle follows the native mode"

  # 1b. The builder's one call site `B({...})`.
  var callLit = (a: -1, b: -1)
  var calls = 0
  for m in result.findAll(re2("(?:^|[^\\w$.])" & escapeRe(builder) & "\\((\\{)")):
    inc calls
    let lb = m.group(0).a
    callLit = (a: lb, b: result.matchBrace(lb))
  if calls != 1 or callLit.b < 0:
    raise newException(ValueError, &"main window options builder call: {calls}/1")
  var n = 0
  block:
    let lit = result[callLit.a .. callLit.b]
    let newLit = lit.replace(
      re2"""titleBarOverlay:(!\d|[\w$]+(?:\.[\w$]+)*)([,}])""",
      proc(m: RegexMatch2, s: string): string =
        inc n
        "/*__CDB_NATIVE_FRAME__*/titleBarOverlay:(" & LINUX_INTEGRATED & ")?" &
          overlayStyle & ":(" & LINUX_BARE & ")?!1:" & s[m.group(0)] & ",frame:!(" &
          LINUX_FRAMELESS & ")," & "hasShadow:!(" & LINUX_BARE & ")," &
          "autoHideMenuBar:process.platform===\"linux\"" & s[m.group(1)],
    )
    if n != 1:
      raise newException(ValueError, &"main window pattern: {n}/1")
    result = result[0 ..< callLit.a] & newLit & result[callLit.b + 1 .. ^1]
    callLit.b += newLit.len - lit.len
  echo &"  [OK] main window options: {n}"

  # Guard: in a JS object literal the LAST key wins. The builder spreads the
  # call-site literal first and then sets its own keys, so a key of ours set
  # in BOTH would be silently discarded: no build failure, no runtime error,
  # just a window opening in the wrong mode. That is the worst failure shape
  # this project has, so make it loud here instead.
  block:
    proc hits(lit, key: string): int =
      var at = 0
      while true:
        let j = lit.find(key, at)
        if j < 0:
          break
        inc result
        at = j + 1

    let callObj = result[callLit.a .. callLit.b]
    let builderObj = result[builderLit.a .. builderLit.b]
    for key in ["titleBarOverlay:", "frame:", "hasShadow:", "autoHideMenuBar:"]:
      if callObj.hits(key) != 1 or builderObj.hits(key) != 0:
        raise newException(
          ValueError,
          &"option {key} appears {callObj.hits(key)}x at the call site and " &
            &"{builderObj.hits(key)}x in the options builder - upstream likely " &
            "sets it itself now, which would shadow ours (later key wins). " &
            "Re-audit before shipping.",
        )
    if builderObj.hits("titleBarStyle:") != 1 or callObj.hits("titleBarStyle:") != 0:
      raise newException(
        ValueError,
        &"option titleBarStyle: appears {builderObj.hits(\"titleBarStyle:\")}x in the " &
          &"options builder and {callObj.hits(\"titleBarStyle:\")}x at the call site, " &
          "expected once in the builder only - re-audit",
      )
    # The captured background call is emitted into the call-site literal; its
    # argument (e.g. `s` in `{signedIn:s}`) is only in scope if it came from there.
    if ("backgroundColor:" & bgCall & ",") notin callObj:
      raise newException(
        ValueError,
        &"captured {bgCall} is not in the main-window options object we patched",
      )
    echo "  [OK] no upstream duplicate shadows our injected options"

  # Patch 2: overlay color inside the helper that builds the titleBarOverlay
  # style for main and popout windows. Since v6.28899.2 the window's own theme
  # (`o`) can differ from the app's (`a`), and the color chain reads:
  #   a=u.nativeTheme.shouldUseDarkColors,o=e==="main"&&yo!==void 0?a:zZi(),
  #   s=o===a?GWi()||nW():jWi[o?"dark":"light"],
  #   c=n?o?"#f9f8f4":"#141412":r?QZi(s):s;return o?{color:c,...
  # (v3.1623.0 to v5.11492.5: `a=AXn()||oF(),s=n?<dark>?..:..:r?e0n(a):a;
  # return u.nativeTheme.shouldUseDarkColors?{color:s,...`).
  # `s` is the plain window background, `QZi(s)` upstream's alpha-blend that
  # has painted as a grey strip on Linux Wayland. Gate the blend off in Linux
  # integrated mode: `r?QZi(s):s` -> `!(LINUX_INTEGRATED)&&r?QZi(s):s`, which
  # parses as `(!(...)&&r)?QZi(s):s`. Only existing locals are used, so it does
  # not matter which code-split chunk the helper lives in.
  #
  # nim-regex has no backreferences: the three `o` captures (declarator, blend
  # argument, else branch) and the `s` captures (declarator, `{color:s`) are
  # compared here instead.
  n = 0
  var mismatch = ""
  result = result.replace(
    re2"""(([\w$]+)=[\w$]+===[\w$]+\?[\w$]+\(\)\|\|[\w$]+\(\):[\w$]+\[[\w$]+\?["`]dark["`]:["`]light["`]\],([\w$]+)=[\w$]+\?[\w$]+\?["`]#[0-9a-fA-F]+["`]:["`]#[0-9a-fA-F]+["`]:)([\w$]+\?[\w$]+\(([\w$]+)\):([\w$]+);return [\w$]+\?\{color:([\w$]+),)""",
    proc(m: RegexMatch2, s: string): string =
      inc n
      let bg = s[m.group(1)]
      if s[m.group(4)] != bg or s[m.group(5)] != bg or s[m.group(6)] != s[m.group(2)]:
        mismatch = s[m.boundaries]
      s[m.group(0)] & OVERLAY_GATE & s[m.group(3)],
  )
  if mismatch.len > 0:
    raise newException(
      ValueError, "overlay color: captured locals disagree in: " & mismatch
    )
  if n != 1:
    raise newException(ValueError, &"titleBarOverlay color gate: {n}/1")
  echo &"  [OK] overlay color skips the alpha blend in Linux integrated mode: {n}"

  # Patch 3: pop-out windows. Upstream opens every pop-out (Code session, chat,
  # artifact shell) as a `window.open("about:blank", ...)` child and lets the
  # RENDERER choose its chrome: a hidden title bar + app-drawn caption buttons
  # ("title-bar-overlay") when main reports `popoutTitleBarOverlay` supported,
  # else a real window frame ("os-frame"). Main reports unsupported only under
  # Wayland, so in native and bare mode the pop-outs kept the integrated
  # buttons. Report upstream's own "unsupported" status (its shape and its
  # unsupportedCode, captured from upstream's function) in those two modes; the
  # renderer then picks os-frame. Bare mode is treated like native here: there
  # is no overlay to draw, so a pop-out gets the window manager's frame.
  # Integrated mode calls upstream's function unchanged.
  # The schema-map entry (`popoutTitleBarOverlay:A_,`, since v6.28899.2
  # `popoutTitleBarOverlay:ws(),`) is told apart by its callee, which is not a
  # status function.
  block:
    let pFn =
      re2"""function ([\w$]+)\(\)\{return [\w$]+\(\)\?\{status:["`]unsupported["`],reason:["`][^"`]*["`],unsupportedCode:["`]([\w]+)["`]\}:\{status:["`]supported["`]\}\}"""
    let callRe = re2"""popoutTitleBarOverlay:([\w$]+)\(\),"""
    var fns: seq[(string, string)]
    for m in result.findAll(pFn):
      fns.add (result[m.group(0)], result[m.group(1)])
    # Since v6.28899.2 the schema map's entries are calls too
    # (`popoutTitleBarOverlay:ws(),`), so only a call of a function in the
    # status-function shape counts.
    var calls = 0
    var target = ""
    var code = ""
    for m in result.findAll(callRe):
      let callee = result[m.group(0)]
      var found = 0
      var c = ""
      for (name, fc) in fns:
        if name == callee:
          inc found
          c = fc
      if found == 0:
        continue
      if found != 1:
        raise newException(
          ValueError,
          &"popoutTitleBarOverlay: upstream status function {callee} defined {found}x - re-audit",
        )
      inc calls
      target = callee
      code = c
    if calls != 1:
      raise newException(
        ValueError,
        &"popoutTitleBarOverlay call site of an upstream status function in the expected shape: {calls}/1 - re-audit",
      )
    result = result.replace(
      callRe,
      proc(m: RegexMatch2, s: string): string =
        if s[m.group(0)] != target:
          return s[m.boundaries]
        POPOUT_MARKER & "popoutTitleBarOverlay:(" & LINUX & "&&(" & NATIVE_ON & "||" &
          BARE_ON & "||" & TRANSP_FRAMED & "))?{status:\"unsupported\",reason:\"" &
          "Pop-out title bar overlay is not used in the native or bare title bar mode or while the window is transparent\"," &
          "unsupportedCode:\"" & code & "\"}:" & target & "(),",
    )
    if POPOUT_MARKER notin result:
      raise newException(ValueError, "pop-out title bar gate not injected")
    echo &"  [OK] pop-out windows follow the native and bare title bar modes: {calls}"

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_native_frame <file>"
    quit(1)
  let file = paramStr(1)
  echo "=== Patch: fix_native_frame ==="
  echo "  Target: " & file
  let orig = readFile(file)
  let patched = apply(orig)
  if patched != orig:
    writeFile(file, patched)
    echo "  [PASS] native frame patched"
  else:
    echo "  [PASS] no changes needed"
