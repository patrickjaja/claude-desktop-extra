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

  # Patch 1: main BrowserWindow options. We splice six runtime-conditional
  # options into the existing comma-list right after titleBarOverlay:
  #   titleBarStyle:    "default" in native mode, "hidden" otherwise.
  #   titleBarOverlay:  Anthropic-themed style object in integrated mode,
  #                     false in bare mode (this is what disables the window
  #                     controls), upstream var (true on win32, false
  #                     elsewhere) otherwise.
  #   frame:            false in BOTH frameless modes, true otherwise.
  #   hasShadow:        false in bare mode only - load-bearing, see the header.
  #   autoHideMenuBar:  true on Linux (Alt brings the GTK menu bar back).
  #
  # We deliberately do NOT splice an `icon:` here. Upstream passes its own
  # `icon:` LATER in the same object literal, and the last key wins, so ours was
  # silently discarded from the day it was written. Upstream's icon.png ships in
  # the tree we repackage, so there is nothing to fix - only dead code to not
  # write. See the shadowing guard below.
  let overlayStyle =
    "{color:" & bgCall & ",symbolColor:" & electron &
    ".nativeTheme.shouldUseDarkColors?\"#fff\":\"#000\",height:36}"
  var n = 0
  # v1.26832.0: `"hidden"` became a template literal and the titleBarOverlay
  # value is the constant-folded `!0` rather than a win32-only variable, so the
  # value slot accepts a boolean literal as well as an identifier chain.
  result = result.replace(
    re2"""titleBarStyle:["`]hidden["`],titleBarOverlay:(!\d|[\w$]+(?:\.[\w$]+)*)""",
    proc(m: RegexMatch2, s: string): string =
      inc n
      "/*__CDB_NATIVE_FRAME__*/titleBarStyle:" & LINUX_NATIVE &
        "?\"default\":\"hidden\"," & "titleBarOverlay:(" & LINUX_INTEGRATED & ")?" &
        overlayStyle & ":(" & LINUX_BARE & ")?!1:" & s[m.group(0)] & ",frame:!(" &
        LINUX_FRAMELESS & ")," & "hasShadow:!(" & LINUX_BARE & ")," &
        "autoHideMenuBar:process.platform===\"linux\"",
  )
  if n != 1:
    raise newException(ValueError, &"main window pattern: {n}/1")
  echo &"  [OK] main window options: {n}"

  # Guard: upstream's options object continues PAST our splice point, and in a
  # JS object literal the LAST key wins. Upstream already passes its own `icon:`
  # after us - which is exactly why we no longer inject one. If a future release
  # also passes `frame`, `hasShadow`, `titleBarStyle`, `titleBarOverlay` or
  # `autoHideMenuBar` after us, our value would be silently discarded: no build
  # failure, no runtime error, just a window opening in the wrong mode. That is
  # the worst failure shape this project has, so make it loud here instead.
  block:
    let mi = result.find("/*__CDB_NATIVE_FRAME__*/")
    if mi < 0:
      raise newException(ValueError, "own marker missing right after patch 1")
    let tail = result[mi ..< min(mi + 3000, result.len)]
    let wp = tail.find("webPreferences:")
    if wp < 0:
      raise newException(
        ValueError,
        "options object shape changed: no webPreferences: within 3000 chars " &
          "of our injection, so the shadowing guard cannot delimit the object",
      )
    let opts = tail[0 ..< wp]
    for key in [
      "titleBarStyle:", "titleBarOverlay:", "frame:", "hasShadow:", "autoHideMenuBar:"
    ]:
      var hits = 0
      var at = 0
      while true:
        let j = opts.find(key, at)
        if j < 0:
          break
        inc hits
        at = j + 1
      if hits != 1:
        raise newException(
          ValueError,
          &"option {key} appears {hits}x in the main-window options object - " &
            "upstream likely passes its own now, which would shadow ours " &
            "(later key wins). Re-audit before shipping.",
        )
    # The captured background call is emitted into this object; its argument
    # (e.g. `c` in `{signedIn:c}`) is only in scope if it came from here.
    if ("backgroundColor:" & bgCall & ",") notin opts:
      raise newException(
        ValueError,
        &"captured {bgCall} is not in the main-window options object we patched",
      )
    echo "  [OK] no upstream duplicate shadows our injected options"

  # Patch 2: overlay color inside the helper that builds the titleBarOverlay
  # style for main and popout windows. Since v3.1623.0 it hoists the color into
  # one declarator chain:
  #   o=e==="main"&&pQn()||RI(),s=n?<dark>?"#f9f8f4":"#141412":r?e0n(o):o;
  # (since v4.16336.0 without the `e==="main"&&` guard: `a=AXn()||oF(),...`).
  # `o` is the plain window background, `e0n(o)` upstream's alpha-blend that
  # has painted as a grey strip on Linux Wayland. Gate the blend off in Linux
  # integrated mode: `r?e0n(o):o` -> `!(LINUX_INTEGRATED)&&r?e0n(o):o`, which
  # parses as `(!(...)&&r)?e0n(o):o`. Only existing locals are used, so it does
  # not matter which code-split chunk the helper lives in.
  #
  # nim-regex has no backreferences: the three `o` captures (declarator, blend
  # argument, else branch) and the `s` captures (declarator, `{color:s`) are
  # compared here instead.
  n = 0
  var mismatch = ""
  result = result.replace(
    re2"""(([\w$]+)=(?:[\w$]+===["`]main["`]&&)?[\w$]+\(\)\|\|[\w$]+\(\),([\w$]+)=[\w$]+\?[\w$]+\.nativeTheme\.shouldUseDarkColors\?["`]#[0-9a-fA-F]+["`]:["`]#[0-9a-fA-F]+["`]:)([\w$]+\?[\w$]+\(([\w$]+)\):([\w$]+);return [\w$]+\.nativeTheme\.shouldUseDarkColors\?\{color:([\w$]+),)""",
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
  # The schema-map entry `popoutTitleBarOverlay:A_,` has no call parens, so it
  # does not match.
  block:
    let pFn =
      re2"""function ([\w$]+)\(\)\{return [\w$]+\(\)\?\{status:["`]unsupported["`],reason:["`][^"`]*["`],unsupportedCode:["`]([\w]+)["`]\}:\{status:["`]supported["`]\}\}"""
    let callRe = re2"""popoutTitleBarOverlay:([\w$]+)\(\),"""
    var fns: seq[(string, string)]
    for m in result.findAll(pFn):
      fns.add (result[m.group(0)], result[m.group(1)])
    var calls = 0
    var target = ""
    for m in result.findAll(callRe):
      inc calls
      target = result[m.group(0)]
    if calls != 1:
      raise
        newException(ValueError, &"popoutTitleBarOverlay call site: {calls}/1 matches")
    var code = ""
    var found = 0
    for (name, c) in fns:
      if name == target:
        inc found
        code = c
    if found != 1:
      raise newException(
        ValueError,
        &"popoutTitleBarOverlay: upstream status function {target} not found " &
          &"in the expected shape ({found}/1) - re-audit",
      )
    result = result.replace(
      callRe,
      proc(m: RegexMatch2, s: string): string =
        POPOUT_MARKER & "popoutTitleBarOverlay:(" & LINUX & "&&(" & NATIVE_ON & "||" &
          BARE_ON & "))?{status:\"unsupported\",reason:\"" &
          "Pop-out title bar overlay is not used in the native or bare title bar mode\"," &
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
