# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Give the Quick Entry BrowserWindow its own Wayland app_id (and X11
# WM_CLASS) so it can be addressed independently from the main Claude
# window - primarily so GNOME shell-extension users can blacklist the
# Quick Entry pill without also disabling effects on the main chat
# window.
#
# ============================================================================
# Problem
# ============================================================================
# The Quick Entry is a transparent, frameless second BrowserWindow
# hardcoded to 606 x 470 px so a small pill can grow vertically for
# multi-line input. At rest most of that area is transparent, so only
# the renderer-drawn pill should be visible.
#
# GNOME shell extensions that add uniform rounded corners + drop
# shadow (Rounded Window Corners Reborn, Unite, ...) decorate every
# window by attaching a child actor filled with a solid opaque
# background and a CSS `box-shadow`, clipped to a rounded rectangle
# the size of the window. On opaque windows the app's own pixels
# cover that decoration, so only the soft shadow spilling past the
# edges is visible. On the transparent Quick Entry the decoration
# shows through the transparent area: the user sees a large opaque
# rectangle with a shadow, and the real pill floating in its
# top-left corner (issue #39).
#
# The extensions let users exclude windows via a `WM_CLASS` /
# Wayland `app_id` blacklist, but Electron assigns app_id
# process-wide, so the main Claude window and Quick Entry share
# `claude` and can only be blacklisted
# together. The user loses rounded corners on the main window just
# to hide the opaque rectangle behind Quick Entry, or keeps the
# rectangle.
#
# ============================================================================
# Why other "quieter" fixes don't work on Wayland
# ============================================================================
# Several obvious workarounds have been tried and rejected:
#
#  - **Setting `type: "toolbar"` (or "notification", "dock", ...) on the
#    BrowserWindow options.** On X11 this sets
#    `_NET_WM_WINDOW_TYPE_TOOLBAR`, which Mutter exposes as
#    `Meta.WindowType.TOOLBAR`, which the extension skips because it
#    only decorates NORMAL/DIALOG/MODAL_DIALOG windows. On native
#    Wayland, however, Chromium/Ozone does not translate Electron's
#    `type` option into anything visible to Mutter: the xdg_toplevel
#    is created like a normal window and Mutter maps it to
#    `Meta.WindowType.NORMAL`. Verified by running the extension in
#    debug mode and observing `win.windowType = 0` (= NORMAL) on the
#    Quick Entry.
#
#  - **Shrinking the BrowserWindow to exactly the card size** so there
#    is no empty area for the extension to paint over. Works
#    cosmetically, but breaks multi-line input (user would have to
#    scroll inside the textarea) and needs CSS/JS patches to keep the
#    card's first line aligned with the logo when the textarea grows.
#    Has a visible 8 px content shift at the 40 -> 56 px textarea
#    transition that cannot be eliminated without further CSS hacks.
#    Also does nothing to stop the extension from (uselessly)
#    re-painting on every resize.
#
#  - **Calling `xdotool set_window --class`** after creation. Works
#    only on X11/XWayland. Native Wayland has no protocol for a client
#    to change another window's app_id.
#
#  - **Spawning Quick Entry as a separate Electron process with a
#    different binary symlink name.** Was considered. Much more
#    invasive (two processes, IPC, spawn latency) and only needed if
#    the CHROME_DESKTOP trick below doesn't work - which turned out
#    not to be the case.
#
# ============================================================================
# What actually controls the Wayland app_id
# ============================================================================
# Chromium derives the window id from `GetXdgAppId()` in
# `chrome/browser/shell_integration_linux.cc`:
#
#     std::optional<std::string> GetXdgAppId() {
#       auto name = GetDesktopName();  // reads $CHROME_DESKTOP
#       if (!name) return {};
#       if (name->ends_with(".desktop"))
#         name->resize(size(*name) - 8);
#       return *name;
#     }
#
# Electron's NativeWindowViews constructor copies that value into the widget
# params (`params.wayland_app_id` on Wayland, the WM_CLASS on X11), so each
# window keeps the id that `CHROME_DESKTOP` held while ITS constructor ran.
# Electron sets `CHROME_DESKTOP` from package.json `desktopName` before the
# main script runs (`com.anthropic.Claude` since v1.19367.0), and
# `app.setDesktopName()` writes the same env var, so we set both.
#
# ============================================================================
# Fix
# ============================================================================
# The Quick Entry `new E.BrowserWindow(opts)` is rewritten to construct
# through a small wrapper:
#
#     X||(X=new ((function(B,A){return function(o){
#         const prev=process.env.CHROME_DESKTOP;
#         try{ CHROME_DESKTOP = setDesktopName = "claude-quick-entry.desktop";
#              return new B(o) }
#         finally{ restore prev (env + setDesktopName) }
#     }})(E.BrowserWindow,E.app))({titleBarStyle:"hidden",...}),...)
#
#  - The swap happens inside the constructor call, after the options object
#    was evaluated, and the PREVIOUS value is restored in `finally`, i.e.
#    immediately after the native window exists, and also when the
#    constructor throws.
#  - The restore puts back whatever was active before - the package.json
#    `desktopName`, or a per-profile name another patch set at startup - so
#    no package.json read or profile-suffix logic is needed here.
#  - If `CHROME_DESKTOP` was unset before (not possible in a packaged
#    Electron run, which always sets it), the restore deletes the env var
#    again; `setDesktopName` has no "unset" form, so it is not called.
#  - `new` of a function that returns an object yields that object, so `X`
#    is the real BrowserWindow; the `X||(...)` short-circuit, the comma
#    chain and its value are unchanged.
#
# An earlier version reset the name in the window's `ready-to-show` handler.
# On native Wayland `ready-to-show` never fires for the transparent Quick
# Entry window (see fix_quick_entry_ready_wayland.nim), so the reset never ran
# and every window created later inherited `claude-quick-entry`.
#
# ============================================================================
# How users act on this
# ============================================================================
# With the patch in place, GNOME shell-extension users who see the
# opaque-rectangle symptom can simply add
#     claude-quick-entry
# to the extension's blacklist (Rounded Window Corners Reborn,
# Unite, Blur My Shell, ...). The Quick Entry then renders with no
# compositor-side shadow or rounded-corner paint, so the transparent
# empty area around the card is actually transparent. The main Claude
# window is unaffected because its app_id is unchanged.
#
# Users who don't run such an extension see no difference at all.
#
# ============================================================================
# Pattern anchor
# ============================================================================
# `([\w$]+)||(([\w$]+)=new ([\w$]+).BrowserWindow({titleBarStyle:"hidden"`
# The `||` short-circuit plus the exact options prefix is only present for
# the Quick Entry constructor in the bundle. nim-regex lacks backreferences,
# so the two window-variable captures are compared in the callback.

import std/[os, strutils]
import regex

const QE_DESKTOP = "claude-quick-entry.desktop"

# The constructor wrapper. Constant text: the minified names are passed in as
# arguments after it, so the idempotency check can look for this exact string.
const WRAPPER =
  "function(__cdbQeB,__cdbQeApp){return function(__cdbQeOpts){" &
  "const __cdbQePrevDesktop=process.env.CHROME_DESKTOP;" & "try{" &
  "process.env.CHROME_DESKTOP=\"" & QE_DESKTOP & "\";" &
  "typeof __cdbQeApp.setDesktopName===\"function\"&&__cdbQeApp.setDesktopName(\"" &
  QE_DESKTOP & "\");" & "return new __cdbQeB(__cdbQeOpts)" & "}finally{" & "try{" &
  "if(typeof __cdbQePrevDesktop===\"string\"){" &
  "process.env.CHROME_DESKTOP=__cdbQePrevDesktop;" &
  "typeof __cdbQeApp.setDesktopName===\"function\"&&__cdbQeApp.setDesktopName(__cdbQePrevDesktop)" &
  "}else delete process.env.CHROME_DESKTOP" & "}catch(__cdbQeRestoreErr){" &
  "try{(globalThis.__cdbDiag||console.log)(\"[quick-entry] app_id restore failed: \"+__cdbQeRestoreErr)}catch(_){}" &
  "}" & "}" & "}}"

# Legacy end states of earlier versions of this patch. Never accepted as done.
const LEGACY_MARKERS = ["__qeAppIdReadErr", "||(process.env.CHROME_DESKTOP="]

proc apply*(input: string): string =
  result = input

  for marker in LEGACY_MARKERS:
    if marker in result:
      echo "  [FAIL] Legacy Quick Entry app_id patch shape found (" & marker &
        ") -- re-extract a pristine bundle"
      quit(1)

  # Idempotency: OUR wrapper must sit exactly once on the Quick Entry
  # constructor, called with <electron>.BrowserWindow and <electron>.app and
  # followed by the Quick Entry options prefix.
  let wrapped = "=new ((" & WRAPPER & ")("
  let wrappedCount = result.count(wrapped)
  if wrappedCount > 0:
    let idx = result.find(wrapped)
    let tail = result[idx + wrapped.len .. min(idx + wrapped.len + 160, result.high)]
    if wrappedCount == 1 and
        tail.startsWith(
          re2"""[\w$]+\.BrowserWindow,[\w$]+\.app\)\)\(\{titleBarStyle:["`]hidden"""
        ):
      echo "  [OK] Quick Entry app_id swap + constructor-time restore already present (idempotent)"
      return result
    echo "  [FAIL] Quick Entry app_id wrapper found " & $wrappedCount &
      "x but not in the expected shape -- re-audit"
    quit(1)

  # v1.26832.0 switched the minifier to backtick literals for a while; the
  # quote character is captured and re-emitted verbatim.
  let pattern = re2(
    r"""([\w$]+)\|\|\(([\w$]+)=new ([\w$]+)\.BrowserWindow\(\{titleBarStyle:(["`])hidden"""
  )
  var count = 0
  result = result.replace(
    pattern,
    proc(m: RegexMatch2, s: string): string =
      let w1 = s[m.group(0)]
      let w2 = s[m.group(1)]
      let electronVar = s[m.group(2)]
      let q = s[m.group(3)]
      if w1 != w2:
        return s[m.boundaries]
      inc count
      w1 & "||(" & w2 & "=new ((" & WRAPPER & ")(" & electronVar & ".BrowserWindow," &
        electronVar & ".app))({titleBarStyle:" & q & "hidden",
  )
  if count != 1:
    echo "  [FAIL] Expected 1 Quick Entry constructor, got " & $count
    quit(1)
  if result.count(wrapped) != 1:
    echo "  [FAIL] Quick Entry app_id wrapper not present after rewrite"
    quit(1)
  echo "  [OK] Quick Entry constructed as " & QE_DESKTOP &
    ", previous CHROME_DESKTOP restored right after the constructor: " & $count &
    " match(es)"

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_quick_entry_app_id <file>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_quick_entry_app_id ==="
  echo "  Target: " & filePath
  let input = readFile(filePath)
  let output = apply(input)
  writeFile(filePath, output)
  echo "  [PASS] Quick Entry app_id swap patched"
