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
#      style object on Linux (plus autoHideMenuBar + icon).
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
# Both behaviors gate on CLAUDE_NATIVE_TITLEBAR: unset (or anything
# other than "1") = integrated mode; "1" = restore the GTK frame. The
# launcher's `--native-titlebar` flag sets the env var.
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

const ICON = "/usr/share/icons/hicolor/256x256/apps/claude-desktop.png"
const LINUX_NATIVE =
  "process.platform===\"linux\"&&process.env.CLAUDE_NATIVE_TITLEBAR===\"1\""
const LINUX_INTEGRATED =
  "process.platform===\"linux\"&&process.env.CLAUDE_NATIVE_TITLEBAR!==\"1\""

proc capture(s: string, pat: Regex2, name: string): string =
  ## Capture group 1 of `pat` from `s`, or raise with `name` in the message.
  var m: RegexMatch2
  if not s.find(pat, m):
    raise newException(ValueError, "fix_native_frame: " & name & " not found")
  s[m.group(0)]

proc apply*(input: string): string =
  if "CLAUDE_NATIVE_TITLEBAR" in input:
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

  # Patch 1: main BrowserWindow options. We splice five runtime-conditional
  # options into the existing comma-list right after titleBarOverlay:
  #   titleBarStyle:    "default" on Linux opt-out, "hidden" otherwise.
  #   titleBarOverlay:  Anthropic-themed style object on Linux integrated,
  #                     upstream var (true on win32, false elsewhere) otherwise.
  #   frame:            false on Linux integrated, true otherwise.
  #   autoHideMenuBar:  true on Linux (Alt brings the GTK menu bar back).
  #   icon:             Linux PNG path on Linux, undefined elsewhere.
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
      "titleBarStyle:" & LINUX_NATIVE & "?\"default\":\"hidden\"," & "titleBarOverlay:(" &
        LINUX_INTEGRATED & ")?" & overlayStyle & ":" & s[m.group(0)] & ",frame:!(" &
        LINUX_INTEGRATED & ")," & "autoHideMenuBar:process.platform===\"linux\"," &
        "icon:process.platform===\"linux\"?\"" & ICON & "\":void 0",
  )
  if n != 1:
    raise newException(ValueError, &"main window pattern: {n}/1")
  echo &"  [OK] main window options: {n}"

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
