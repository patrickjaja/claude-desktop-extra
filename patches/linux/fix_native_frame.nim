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
#   2. Force Anthropic's plain window background into the overlay style in
#      Linux integrated mode, instead of the value upstream feeds through its
#      alpha-blend helper. Electron on Wayland has painted that blended value
#      as a grey strip, so without this swap the overlay looks like a grey
#      block. (The literal "#00000000" placeholder this originally targeted is
#      long gone; the swap site is the same style object either way.)
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
# Why bare mode exists: on window managers where Chromium refuses to set
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
# We capture them (background helper, Electron alias, platform gate, and
# transparent placeholder) at patch time via [\w$]+ wildcards so the
# generated code references the current names. We fail loudly if any
# capture is missing.
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

proc capture(s: string, pat: Regex2, name: string): string =
  ## Capture group 1 of `pat` from `s`, or raise with `name` in the message.
  var m: RegexMatch2
  if not s.find(pat, m):
    raise newException(ValueError, "fix_native_frame: " & name & " not found")
  s[m.group(0)]

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
    echo "  [INFO] already patched"
    return input
  result = input

  # Anthropic identifiers (minified, renamed between releases):
  #   bgFn      e.g. "G$" / "T.r" -- window background color, called as bgFn().
  #   electron  e.g. "cA" / "R"   -- alias for require("electron"), used for
  #                                  nativeTheme.shouldUseDarkColors.
  # Both are captured from the main-window options site, which since v1.26832.0
  # lives in index.js itself; they are only ever emitted back into that same
  # site (patch 1). Patch 2 may sit in a *different* code-split chunk (it did
  # v1.26832.0-v1.30096.1) and captures its own local background helper --
  # see there.
  let bgFn = result.capture(
    re2"""backgroundColor:([\w$]+(?:\.[\w$]+)*)\(\),opacity:""",
    "backgroundColor function",
  )
  let electron = result.capture(
    re2"""([\w$]+)\.nativeTheme\.shouldUseDarkColors""", "electron alias"
  )

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
    "{color:" & bgFn & "(),symbolColor:" & electron &
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
    echo "  [OK] no upstream duplicate shadows our injected options"

  # Patch 2: opaque-color swap inside the helper that builds the overlay
  # style. The non-Hb branch uses a background value that upstream may run
  # through an alpha-blend helper; on Linux Wayland that has produced a grey
  # strip instead of the window background. Force the plain background color
  # in Linux integrated mode. Two occurrences: one per theme.
  #
  # This helper can live in a DIFFERENT code-split chunk than the main-window
  # options patched above (it did v1.26832.0-v1.30096.1). `bgFn` captured up
  # there would then not be in scope here -- emitting it would be a
  # ReferenceError at runtime. Capture the helper's own background function
  # from the declarator that feeds the style object instead.
  #
  # Up to v1.40609.0 the helper was an arrow whose declarator chain continued
  # with `,n=<electron>.nativeTheme...`; since v1.46388.2 it is a
  # `function(e)` taking "main"/"popout" (the overlay now also styles popout
  # windows) and the chain ends with `;return <electron>.nativeTheme...`.
  # Accept both joiners.
  let localBg = result.capture(
    re2"""=[\w$]+\?[\w$]+\(([\w$]+)\(\)\):[\w$]+\(\)(?:,[\w$]+=|;return )[\w$]+\.nativeTheme\.shouldUseDarkColors\?\{color:""",
    "titleBarOverlay-helper background function",
  )
  n = 0
  result = result.replace(
    re2"""(\{color:[\w$]+\?["`]#[0-9a-fA-F]+["`]:)([\w$]+)(,symbolColor:)""",
    proc(m: RegexMatch2, s: string): string =
      inc n
      let bgVar = s[m.group(1)]
      s[m.group(0)] & "(" & LINUX_INTEGRATED & ")?" & localBg & "():" & bgVar &
        s[m.group(2)],
  )
  if n != 2:
    raise newException(ValueError, &"titleBarOverlay background swap: {n}/2")
  echo &"  [OK] overlay background -> {localBg}() in Linux integrated mode: {n}"

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
