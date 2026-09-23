# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
# Patch Quick Entry to spawn on cursor's monitor and auto-focus input.
# Three sub-patches: default position function (1), position restore (3),
# show/focus fix (4). (Patch 2, the saved-monitor fallback lookup, was retired
# 2026-09-23: it sits behind the early return Patch 3 creates, so it never ran.)

import std/[os, strformat, strutils]
import regex

# Resolve the bundled x11-bridge binary (cached in globalThis.__qeX11Bridge).
# The bridge ships at a FIXED location: the package's resources/ dir (=
# process.resourcesPath; the asar is exe-adjacent in every install), like
# upstream's own bundled binaries. Candidates: the CU preamble's resolution
# (if fix_computer_use_linux already ran), the X11_BRIDGE_BIN escape hatch,
# then that bundled dir. Returns null when nothing resolves.
proc x11BridgeExpr(): string =
  "(()=>{if(globalThis.__qeX11Bridge!==void 0)return globalThis.__qeX11Bridge;" &
    "const fs=require(\"fs\"),pa=require(\"path\");" &
    "const cands=[globalThis.__cuX11BridgeBin,process.env.X11_BRIDGE_BIN," &
    "pa.join(process.resourcesPath,\"x11-bridge\")];" &
    "for(const c of cands){if(!c)continue;try{fs.accessSync(c,fs.constants.X_OK);return globalThis.__qeX11Bridge=c}catch(e){}}" &
    "return globalThis.__qeX11Bridge=null})()"

# Cursor position cascade: hyprctl on Hyprland (compositor-native coords;
# hyprctl always ships with Hyprland itself, no extra package), the bundled
# x11-bridge on X11/XWayland, Electron's getCursorScreenPoint as last resort.
proc cursorIife(electronVar: string): string =
  "(()=>{" & "if(process.platform===\"linux\"){" & "const cp=require(\"child_process\");" &
    "if(process.env.HYPRLAND_INSTANCE_SIGNATURE){try{" &
    "const r=cp.execFileSync(\"hyprctl\",[\"cursorpos\"]," &
    "{timeout:100,encoding:\"utf-8\"});" & "const m=r.match(/(-?\\d+),\\s*(-?\\d+)/);" &
    "if(m){if(!globalThis.__qeCursorLogged){globalThis.__qeCursorLogged=true;(globalThis.__cdbDiag||console.log)(\"[quick-entry] cursor: using hyprctl\")}return{x:parseInt(m[1]),y:parseInt(m[2])}}" &
    "}catch(e){}}" & "const xb=" & x11BridgeExpr() & ";" &
    "if(xb&&process.env.DISPLAY){try{" &
    "const j=JSON.parse(cp.execFileSync(xb,[\"cursor-position\"]," &
    "{timeout:200,encoding:\"utf-8\"}));" &
    "if(Number.isFinite(j.x)&&Number.isFinite(j.y)){if(!globalThis.__qeCursorLogged){globalThis.__qeCursorLogged=true;(globalThis.__cdbDiag||console.log)(\"[quick-entry] cursor: using x11-bridge\")}return{x:j.x,y:j.y}}" &
    "}catch(e){}}" &
    "if(!globalThis.__qeCursorLogged){globalThis.__qeCursorLogged=true;(globalThis.__cdbDiag||console.warn)(\"[quick-entry] cursor: x11-bridge/hyprctl unavailable -- falling back to Electron API (may show on wrong monitor)\")}" &
    "}" & "return " & electronVar & ".screen.getCursorScreenPoint()" & "})()"

const EXPECTED_PATCHES = 3

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0

  # Anchors. Each has an upstream shape (apply) and our end-state shape
  # (already applied). Idempotency is a marker set: all three end states
  # present = done, none = apply, anything in between = FAIL (a half-patched
  # or re-shaped input must never report success).
  #
  # Patch 3 anchor: the position-restore function. It reads the saved
  # quickWindowPosition and, when there is none, returns the default-position
  # function (captured as `fb`). v1.26832.0: `let` instead of `const`, the
  # settings store sits behind a chunk namespace, the key is a template literal.
  let restoreHead =
    """(function [\w$]+\(\)\{(?:const|let|var) [\w$]+=[\w$]+(?:\.[\w$]+)*\.get\([`"]quickWindowPosition[`"],null\),[\w$]+=[\w$]+\.screen\.getAllDisplays\(\);if\(!\()"""
  let pattern3 = re2(
    restoreHead &
      """[\w$]+&&[\w$]+\.absolutePointInWorkspace&&[\w$]+\.monitor&&[\w$]+\.relativePointFromMonitor(\)\)return )([\w$]+)\(\)"""
  )
  let pattern3Done = re2(restoreHead & """!1\)\)return ([\w$]+)\(\)""")
  # Patch 4 anchor: the show/position tail of the show function. Upstream uses
  # the same window var twice and the same point var twice; the regex package
  # has no backreferences, so the equality is checked on the captures.
  let pattern4 =
    re2"([\w$]+)\.show\(\)\}return ([\w$]+)\.setPosition\(Math\.round\(([\w$]+)\.x\),Math\.round\(([\w$]+)\.y\)\),!0\}"
  let pattern4Done = re2"[\w$]+\.setBounds\(_b\);[\w$]+\.show\(\);_r\(\);_ff\(\);"

  var m3s: seq[RegexMatch2] = @[]
  for m in result.findAll(pattern3):
    m3s.add m
  var m3Done: seq[RegexMatch2] = @[]
  for m in result.findAll(pattern3Done):
    m3Done.add m
  var m4s: seq[RegexMatch2] = @[]
  for m in result.findAll(pattern4):
    if result[m.group(0)] == result[m.group(1)] and
        result[m.group(2)] == result[m.group(3)]:
      m4s.add m
  let done4 = result.findAll(pattern4Done).len

  # The default-position function, from whichever restore shape is present.
  var fb = ""
  if m3s.len == 1 and m3Done.len == 0:
    fb = result[m3s[0].group(2)]
  elif m3s.len == 0 and m3Done.len == 1:
    fb = result[m3Done[0].group(1)]
  else:
    echo &"  [FAIL] position restore: {m3s.len} upstream and {m3Done.len} patched sites, expected exactly one of them once"
    quit(1)

  # Patch 1 anchor: the default-position function itself, found by NAME (the
  # restore function's fallback), so no other getPrimaryDisplay site in the
  # bundle can match. Its first statement reads the primary display.
  # (`$` is legal in a minified name and a regex anchor: escape it.)
  let fnHead =
    "(function " & fb.replace("$", "\\$") &
    """\(\)\{(?:const|let|var) [\w$]+=)([\w$]+)(\.screen\.)"""
  let pattern1 = re2(fnHead & """getPrimaryDisplay\(\)""")
  let pattern1Done = re2(
    fnHead &
      """getDisplayNearestPoint\(\(\(\)=>\{if\(process\.platform===["`]linux["`]\)"""
  )
  let n1 = result.findAll(pattern1).len
  let done1 = result.findAll(pattern1Done).len

  let doneCount =
    (if m3Done.len == 1: 1 else: 0) + (if done1 == 1: 1 else: 0) +
    (if done4 == 1: 1 else: 0)
  if doneCount == EXPECTED_PATCHES and n1 == 0 and m4s.len == 0:
    echo "  [OK] cursor-display position patches already present (idempotent, 3/3 end states)"
    return result
  if doneCount != 0 or done1 > 1 or done4 > 1:
    echo &"  [FAIL] {doneCount}/{EXPECTED_PATCHES} end states present: input is half-patched or re-shaped; use a fresh extract and re-audit"
    quit(1)

  # Patch 1: default position -> the display under the cursor.
  if n1 != 1:
    echo &"  [FAIL] default position function {fb}(): {n1} matches, expected 1"
    quit(1)
  result = result.replace(
    pattern1,
    proc(m: RegexMatch2, s: string): string =
      let electronVar = s[m.group(1)]
      s[m.group(0)] & electronVar & s[m.group(2)] & "getDisplayNearestPoint(" &
        cursorIife(electronVar) & ")",
  )
  echo &"  [OK] default position function {fb}(): 1 match"
  inc patchesApplied

  # Patch 3: Override position-restore to always use the cursor's display: the
  # saved-position condition becomes `!(!1)`, so it always returns the default
  # position function patched above. (Upstream's saved-monitor lookup behind
  # that early return, including its own getPrimaryDisplay fallback, becomes
  # unreachable and is left untouched.)
  var n3 = 0
  result = result.replace(
    pattern3,
    proc(m: RegexMatch2, s: string): string =
      inc n3
      s[m.group(0)] & "!1" & s[m.group(1)] & s[m.group(2)] & "()",
  )
  if n3 != 1:
    echo &"  [FAIL] position restore override: {n3} matches, expected 1"
    quit(1)
  echo "  [OK] position restore override: 1 match"
  inc patchesApplied

  # Patch 4: Fix show/positioning + focus on Linux.
  # The 50/150/300 ms retries (moveTop + setBounds + focus) are gated behind _isX11.
  # On Wayland the compositor never repositions windows after show(), so the retries
  # were pointless and caused visible jitter on every open. On X11 (WM smart placement)
  # they are still needed to fight back-to-front reordering.
  m4s = @[]
  for m in result.findAll(pattern4):
    if result[m.group(0)] == result[m.group(1)] and
        result[m.group(2)] == result[m.group(3)]:
      m4s.add m
  if m4s.len != 1:
    echo &"  [FAIL] show/focus ordering: {m4s.len} matches, expected 1"
    quit(1)
  let m = m4s[0]
  let w = result[m.group(0)]
  let v = result[m.group(2)]
  let replacement =
    "(()=>{" & "const _b={x:Math.round(" & v & ".x),y:Math.round(" & v & ".y)," &
    "width:" & w & ".getBounds().width,height:" & w & ".getBounds().height};" &
    "const _r=()=>{" & w & ".isDestroyed()||" & w & ".setBounds(_b)};" &
    "const _ef=()=>{if(" & w & ".isDestroyed())return;" & w & ".moveTop();" & w &
    ".focus();" & w & ".focusOnWebView();" & w & ".webContents.focus();" & w &
    ".webContents.executeJavaScript(" &
    "'document.getElementById(\"prompt-input\")?.focus()'" & ").catch(()=>{})};" &
    "const _isX11=process.platform===\"linux\"&&(" &
    "process.env.XDG_SESSION_TYPE===\"x11\"" &
    "||process.argv.some(a=>a===\"--ozone-platform=x11\")" &
    "||(!process.env.XDG_SESSION_TYPE&&!process.env.WAYLAND_DISPLAY));" &
    "const _xf=()=>{if(!_isX11||" & w & ".isDestroyed())return;" & "try{" &
    "const cp=require(\"child_process\");" & "const xb=" & x11BridgeExpr() & ";" &
    "if(!xb){_ef();return}" & "const wid=" & w &
    ".getNativeWindowHandle().readUInt32LE(0);" &
    "cp.execFile(xb,[\"activate-window\",\"--window\",String(wid)]," &
    "{timeout:500},(e)=>{if(!" & w & ".isDestroyed()){_ef()}});" & "}catch(e){_ef()}};" &
    "const _ff=()=>{_ef();if(_isX11){_xf()}};" & w & ".setBounds(_b);" & w & ".show();" &
    "_r();" & "_ff();" & "if(_isX11){" & "setTimeout(()=>{if(!" & w &
    ".isDestroyed()){_r();_ff()}},50);" & "setTimeout(()=>{if(!" & w &
    ".isDestroyed()){_r();_ff()}},150);" & "setTimeout(()=>{if(!" & w &
    ".isDestroyed()){_r();_ff()}},300)" & "}" & "})()}" & "return!0}"
  result = result[0 ..< m.boundaries.a] & replacement & result[m.boundaries.b + 1 .. ^1]
  echo "  [OK] show/focus ordering fix: 1 match"
  inc patchesApplied

  if patchesApplied != EXPECTED_PATCHES:
    echo &"  [FAIL] Only {patchesApplied}/{EXPECTED_PATCHES} patches applied"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_quick_entry_position <file>"
    quit(1)
  let file = paramStr(1)
  echo "=== Patch: fix_quick_entry_position ==="
  echo &"  Target: {file}"
  if not fileExists(file):
    echo &"  [FAIL] File not found: {file}"
    quit(1)
  let input = readFile(file)
  let output = apply(input)
  if output != input:
    writeFile(file, output)
  echo &"  [PASS] {EXPECTED_PATCHES}/{EXPECTED_PATCHES} patches applied"
