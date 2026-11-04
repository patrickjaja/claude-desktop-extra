# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Left-click on the tray icon toggles the app on Linux.
#
# Upstream (2.9939.4, tray setup in an index chunk) builds the tray with only a
# tooltip and a context menu:
#
#   Y9=new a.Tray(a.nativeImage.createFromPath(r)),Y9.setToolTip(...),...,
#   Y9.setContextMenu(Z9)
#
# and never attaches a `click` listener. On macOS/Windows the OS opens the
# context menu on click, so nothing is lost there. On Linux, Electron's tray is
# a StatusNotifierItem: the tray host (KDE Plasma, waybar, Quickshell, ...)
# calls the item's Activate method on left-click, Electron turns that into the
# Tray `click` event, and with no listener the click is dropped. The only way
# back into a hidden window is right-click -> "Show App".
#
# We register a `click` listener right after the Tray is constructed. It
# toggles the main window:
#
#   - main window visible, not minimized and focused -> `close()` it. That
#     runs upstream's own close handler, which hides into the tray (leaving
#     fullscreen first), exactly like the window's close button.
#   - anything else (hidden, minimized, or behind another app) -> the "Show
#     App" menu item's own handler (upstream's restore/focus/show routine,
#     `UJ` in 2.9939.4).
#
#   Y9=new a.Tray(...),/*__cdb_tray_click_v2__*/process.platform==="linux"&&(
#     globalThis.__cdbTrayBlurHook||(globalThis.__cdbTrayBlurHook=1,
#       a.app.on("browser-window-blur",(e,w)=>{w.__cdbTrayBlurAt=Date.now()})),
#     Y9.on("click",()=>{let w=jo;w&&!w.isDestroyed()&&w.isVisible()&&
#       !w.isMinimized()&&(w.isFocused()||Date.now()-(w.__cdbTrayBlurAt||0)<400)
#       ?w.close():UJ()})),Y9.setToolTip(...)
#
# Tray hosts that take keyboard focus when clicked would blur the window just
# before `click` arrives, so a window that lost focus less than 400 ms earlier
# still counts as focused. The blur hook is app-wide and registered once: the
# tray is re-created when the tray setting changes, the window may be re-created
# too.
#
# Every name is captured from the bundle, never hardcoded: the Electron
# namespace and the tray variable from the constructor site, the handler from
# the "Show App" item (anchored on its stable i18n message, not its minified
# name), and the main-window variable from the first `let` of that handler (or
# of the restore routine it wraps). The menu builder and the tray setup live in
# the same chunk, so all are in scope.
#
# Hosts that open the menu on left-click instead of calling Activate (an item
# with ItemIsMenu=true, which Electron does not set) are unaffected.
#
# Idempotency: the injected listener (marker + `.on("click"` + the captured
# handler) is present exactly once -> already applied.

import std/[os, strformat, strutils]
import regex

const MARKER = "/*__cdb_tray_click_v2__*/"
const EXPECTED_PATCHES = 1

# "Show App" item of the tray context menu: `{label:X().formatMessage(
# {defaultMessage:"Show App",id:"..."}),click:UJ}`, since v4.16336.0
# `click:()=>zyi()`. Group 0 = handler name (bare form), group 1 = handler
# name (arrow form); exactly one of them matches.
let showAppRe = re2(
  """\{label:[\w$]+\(\)\.formatMessage\(\{defaultMessage:["`]Show App["`],id:["`][^"`]+["`]\}\),click:(?:([\w$]+)|\(\)=>([\w$]+)\(\))\}"""
)
# Tray construction inside the comma expression of the tray-update function:
# `Y9=new a.Tray(a.nativeImage.createFromPath(r)),`. Group 0 = tray variable,
# group 1 = Electron namespace.
let trayRe = re2(
  """([\w$]+)=new ([\w$]+)\.Tray\([\w$]+\.nativeImage\.createFromPath\([\w$]+\)\),"""
)
let doneRe = re2(
  """([\w$]+)=new [\w$]+\.Tray\([\w$]+\.nativeImage\.createFromPath\([\w$]+\)\),/\*__cdb_tray_click_v2__\*/process\.platform==="linux"&&\(globalThis\.__cdbTrayBlurHook\|\|\(globalThis\.__cdbTrayBlurHook=1,[\w$]+\.app\.on\("browser-window-blur",\(e,w\)=>\{w\.__cdbTrayBlurAt=Date\.now\(\)\}\)\),([\w$]+)\.on\("click",\(\)=>\{let w=[\w$]+;[^}]*\?w\.close\(\):[\w$]+\(\)\}\)\),"""
)

# The restore routine's first `let` reads the main window:
# `function UJ(){let e=jo;`, since v4.16336.0 after one call statement
# (`function aX(){fL();let e=V;`). Group 0 = main-window variable.
proc showFnRe(showFn: string): Regex2 =
  re2("function " & escapeRe(showFn) & """\(\)\{(?:[\w$]+\(\);)?let [\w$]+=([\w$]+);""")

# Since v4.16336.0 the "Show App" handler is a wrapper that runs an updater
# hook first and the restore routine last: `function zyi(){zvi(),aX()}`.
# Group 0 = the last callee (the restore routine).
proc showWrapperRe(showFn: string): Regex2 =
  re2("function " & escapeRe(showFn) & """\(\)\{(?:[\w$]+\(\),)+([\w$]+)\(\)\}""")

proc allMatches(s: string, r: Regex2): seq[RegexMatch2] =
  for m in findAll(s, r):
    result.add m

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0

  let done = allMatches(input, doneRe)
  if done.len == 1:
    if input[done[0].group(0)] != input[done[0].group(1)]:
      raise newException(
        ValueError, "fix_tray_left_click: injected listener is on a different variable"
      )
    echo "  [OK] tray left-click listener already present (idempotent)"
    return input
  if done.len > 1:
    raise newException(
      ValueError, &"fix_tray_left_click: injected listener duplicated ({done.len})"
    )
  if input.find(MARKER) >= 0:
    raise newException(
      ValueError,
      "fix_tray_left_click: marker present but listener shape not found - re-extract a pristine bundle",
    )

  let showMs = allMatches(input, showAppRe)
  if showMs.len != 1:
    echo &"  [FAIL] tray menu \"Show App\" item: {showMs.len} matches (want 1)"
    raise newException(ValueError, "fix_tray_left_click: Show App anchor moved")
  let trayMs = allMatches(input, trayRe)
  if trayMs.len != 1:
    echo &"  [FAIL] `<v>=new <ns>.Tray(<ns>.nativeImage.createFromPath(<p>)),`: {trayMs.len} matches (want 1)"
    raise newException(ValueError, "fix_tray_left_click: Tray constructor anchor moved")

  let showGroup =
    if showMs[0].group(0).a >= 0:
      showMs[0].group(0)
    else:
      showMs[0].group(1)
  let showFn = input[showGroup]
  let trayVar = input[trayMs[0].group(0)]
  let ns = input[trayMs[0].group(1)]
  # The main window is read by the handler itself or, when the handler is a
  # wrapper, by the restore routine it calls last.
  var restoreFn = showFn
  var winMs = allMatches(input, showFnRe(restoreFn))
  if winMs.len == 0:
    let wrapMs = allMatches(input, showWrapperRe(showFn))
    if wrapMs.len == 1:
      restoreFn = input[wrapMs[0].group(0)]
      winMs = allMatches(input, showFnRe(restoreFn))
  if winMs.len != 1:
    echo &"  [FAIL] `function {restoreFn}(){{[<call>();]let <e>=<win>;`: {winMs.len} matches (want 1)"
    raise newException(ValueError, "fix_tray_left_click: Show App handler shape moved")
  let winVar = input[winMs[0].group(0)]

  let at = trayMs[0].boundaries.b + 1
  let inj =
    MARKER & "process.platform===\"linux\"&&(globalThis.__cdbTrayBlurHook||" &
    "(globalThis.__cdbTrayBlurHook=1," & ns &
    ".app.on(\"browser-window-blur\",(e,w)=>{w.__cdbTrayBlurAt=Date.now()}))," & trayVar &
    ".on(\"click\",()=>{let w=" & winVar &
    ";w&&!w.isDestroyed()&&w.isVisible()&&!w.isMinimized()&&" &
    "(w.isFocused()||Date.now()-(w.__cdbTrayBlurAt||0)<400)?w.close():" & showFn &
    "()})),"
  result = result[0 ..< at] & inj & result[at .. ^1]
  echo &"  [OK] tray left-click -> toggle (tray {trayVar}, window {winVar}, show {showFn})"
  inc patchesApplied

  # Positive end-state: the injected listener is present exactly once.
  if allMatches(result, doneRe).len != 1:
    echo "  [FAIL] injected listener not found in output"
    raise newException(ValueError, "fix_tray_left_click: end-state assertion failed")

  if patchesApplied < EXPECTED_PATCHES:
    echo &"  [FAIL] Only {patchesApplied}/{EXPECTED_PATCHES} patches applied"
    raise newException(ValueError, "fix_tray_left_click: incomplete")

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_tray_left_click <path_to_index.js>"
    quit(1)
  let file = paramStr(1)
  echo "=== Patch: fix_tray_left_click ==="
  echo &"  Target: {file}"
  if not fileExists(file):
    echo &"  [FAIL] File not found: {file}"
    quit(1)
  let input = readFile(file)
  var output: string
  try:
    output = apply(input)
  except ValueError as e:
    echo "  [FAIL] " & e.msg
    quit(1)
  if output != input:
    writeFile(file, output)
    echo "  [PASS] Tray left-click listener injected"
  else:
    echo "  [PASS] No changes needed (already applied)"
