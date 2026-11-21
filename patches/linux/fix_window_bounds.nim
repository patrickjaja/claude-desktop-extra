# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
# Fix BrowserWindow child view bounds, ready-to-show jiggle, and Quick Entry blur.
# Two patches: bounds fix IIFE injection and Quick Entry blur before hide.
#
# Uses the `regex` package (pure Nim) like the other patches: std/nre dlopens
# PCRE1 at run time, which ubuntu-24.04 (the CI harness runner) does not ship.
# `regex` has no backreferences, so the "same window variable" constraints that
# used to be `\1`/`\2` are a two-stage match (head pins the variable, the full
# pattern is built with it spliced in literally) or an equality check on the
# captured groups.

import std/[os, strformat, strutils]
import regex

const BOUNDS_FIX_JS =
  "(function(__wb_w){" & "if(process.platform!==\"linux\")return;" &
  "var __wb_fcb=function(){" & "if(__wb_w.isDestroyed())return;" &
  "var __wb_cv=__wb_w.contentView;" &
  "if(!__wb_cv||!__wb_cv.children||!__wb_cv.children.length)return;" &
  "var __wb_cs=__wb_w.getContentSize(),__wb_cw=__wb_cs[0],__wb_ch=__wb_cs[1];" &
  "if(__wb_cw<=0||__wb_ch<=0)return;" & "var __wb_cb=__wb_cv.children[0].getBounds();" &
  "if(__wb_cb.width!==__wb_cw||__wb_cb.height!==__wb_ch)" &
  "__wb_cv.children[0].setBounds({x:0,y:0,width:__wb_cw,height:__wb_ch})" & "};" &
  "var __wb_fasc=function(){__wb_fcb();setTimeout(__wb_fcb,16);setTimeout(__wb_fcb,150)};" &
  "[\"maximize\",\"unmaximize\",\"enter-full-screen\",\"leave-full-screen\"]" &
  ".forEach(function(__wb_ev){__wb_w.on(__wb_ev,__wb_fasc)});" & "var __wb_lsz=[0,0];" &
  "__wb_w.on(\"moved\",function(){" & "if(__wb_w.isDestroyed())return;" &
  "var __wb_s=__wb_w.getSize();" & "if(__wb_s[0]!==__wb_lsz[0]||__wb_s[1]!==__wb_lsz[1])" &
  "{__wb_lsz=__wb_s;__wb_fasc()}" & "});" & "__wb_w.once(\"ready-to-show\",function(){" &
  "var __wb_s=__wb_w.getSize();" & "__wb_w.setSize(__wb_s[0]+1,__wb_s[1]+1);" &
  "setTimeout(function(){" & "if(__wb_w.isDestroyed())return;" &
  "__wb_w.setSize(__wb_s[0],__wb_s[1]);" & "__wb_fasc()" & "},50)" & "})" & "})"

# Main window factory. Since v6.28899.2 the window is constructed at its one
# call site and handed in:
#   f=(e=>BEe(new u.BrowserWindow(e)))(kOr({...}))
#   function BEe(e){return oo=e,Ar(oo.webContents,kr.MAIN_WINDOW),SEe(oo),oo}
# (up to v5.11492.5 the factory itself ran `oo=new u.BrowserWindow(e)`).
# The IIFE goes in right before the factory's final `,WIN}`.
# Head groups: 0 = NAME, 1 = ARG, 2 = WIN (a dotted path since v1.19367.0),
# 3 = ARG again (must equal group 1).
const MAIN_WIN_HEAD =
  re2"function ([\w$]+)\(([\w$]+)\)\{return ([\w$]+(?:\.[\w$]+)*)=([\w$]+),"

# The call site that constructs the window and hands it to the factory.
# Groups: 0 = arrow param, 1 = FACTORY, 2 = arrow param again.
const MAIN_WIN_CTOR =
  re2"\(([\w$]+)=>([\w$]+)\(new [\w$]+\.BrowserWindow\(([\w$]+)\)\)\)\("

# How far after the factory head its MAIN_WINDOW tagging call may sit. Right
# after the head on a pristine bundle; fix_profile_window_title (which sorts
# before this patch) injects about 1.3 KB in between.
const TAG_WINDOW = 4000

type MainFactory = tuple[name, win: string, endAt: int, patched: bool]
  ## endAt = offset of the factory's final `,WIN}`; patched = our IIFE on WIN
  ## already sits right before it.

proc boundsCall(win: string): string =
  "," & BOUNDS_FIX_JS & "(" & win & ")"

proc findMainWindowFactories(s: string): seq[MainFactory] =
  for m in s.findAll(MAIN_WIN_HEAD):
    if s[m.group(1)] != s[m.group(3)]:
      continue
    let name = s[m.group(0)]
    let win = s[m.group(2)]
    let a = m.boundaries.b + 1
    # The first `.MAIN_WINDOW)` after the head, still inside this function (no
    # `function ` keyword in between), must be the tagging call on WIN.
    let tail = s[a ..< min(s.len, a + TAG_WINDOW)]
    let t = tail.find(".MAIN_WINDOW)")
    if t < 0 or tail[0 ..< t].contains("function "):
      continue
    let tagEnd = t + ".MAIN_WINDOW)".len
    let tag = re2(
      r"[\w$]+(?:\.[\w$]+)*\(" & escapeRe(win) &
        r"\.webContents,[\w$]+(?:\.[\w$]+)*\.MAIN_WINDOW\)$"
    )
    if not tail[0 ..< tagEnd].contains(tag):
      continue
    # Trailing setup calls (`,SEe(oo)`) up to the final `,WIN}`: no braces,
    # apart from our own IIFE right before `,WIN}` on a patched bundle.
    let close = "," & win & "}"
    let e = tail.find(close, tagEnd)
    if e < 0:
      continue
    var seg = tail[tagEnd ..< e]
    let patched = seg.endsWith(boundsCall(win))
    if patched:
      seg = seg[0 ..< seg.len - boundsCall(win).len]
    if seg.contains('{') or seg.contains('}'):
      continue
    var ctors = 0
    for c in s.findAll(MAIN_WIN_CTOR):
      if s[c.group(1)] == name and s[c.group(0)] == s[c.group(2)]:
        inc ctors
    if ctors == 1:
      result.add (name, win, a + e, patched)

# Positive end state of Patch 2: the guard function whose single `||` arm blurs
# and then hides the same window. Groups 0 and 1 must be the same variable.
const QE_BLUR_CHECK =
  re2"function [\w$]+\(\)\{[\w$]+\(\)\|\|\(([\w$]+)\.blur\(\),([\w$]+)\.hide\(\)\)\}"

const QE_HIDE_PATTERN =
  re2"(function [\w$]+\(\)\{)([\w$]+\(\))\|\|([\w$]+)(\.hide\(\))\}"

proc apply*(input: string): string =
  result = input
  var applied: seq[string] = @[]

  # 1. Child view bounds fix + ready-to-show jiggle
  let boundsMarker = "__wb_fcb"
  let factories = result.findMainWindowFactories()
  if boundsMarker in result:
    # Positive end state: the IIFE on the main window, right before the
    # factory's final `,WIN}`.
    if factories.len != 1 or not factories[0].patched:
      echo "  [FAIL] bounds-fix marker present but not in the main-window factory"
      raise newException(
        ValueError, "fix_window_bounds: bounds fix marker found outside the factory"
      )
    echo "  [INFO] Window bounds fix already injected"
    applied.add("bounds-fix(skip)")
  else:
    if factories.len == 1:
      let f = factories[0]
      result = result[0 ..< f.endAt] & boundsCall(f.win) & result[f.endAt .. ^1]
      echo &"  [OK] Window bounds fix + size jiggle injected: 1 match(es) (factory {f.name})"
      applied.add("bounds-fix(1)")
    else:
      # Must raise on its own miss - do NOT rely on the `applied.len == 0` guard
      # below, which Patch 2 (Quick Entry blur) independently satisfies, masking a
      # silent Patch 1 miss and shipping broken child-view geometry on Linux.
      echo &"  [FAIL] Main window factory pattern matched {factories.len}/1"
      raise newException(
        ValueError, "fix_window_bounds: Main window factory pattern not matched"
      )

  # 2. Quick Entry blur before hide
  # Positive end state: the exact shape Patch 2 produces - the guard function
  # whose single `||` arm blurs and then hides the same window.
  var alreadyBlurred = false
  for m in result.findAll(QE_BLUR_CHECK):
    if result[m.group(0)] == result[m.group(1)]:
      alreadyBlurred = true
      break

  if alreadyBlurred:
    echo "  [INFO] Quick Entry blur already applied"
    applied.add("qe-blur(skip)")
  else:
    var countQe = 0
    result = result.replace(
      QE_HIDE_PATTERN,
      proc(m: RegexMatch2, s: string): string =
        inc countQe
        let funcDecl = s[m.group(0)]
        let guardCall = s[m.group(1)]
        let winVar = s[m.group(2)]
        let hideCall = s[m.group(3)]
        funcDecl & guardCall & "||(" & winVar & ".blur()," & winVar & hideCall & ")}",
    )
    if countQe == 1:
      echo &"  [OK] Quick Entry blur before hide: {countQe} match"
      applied.add(&"qe-blur({countQe})")
    else:
      echo &"  [FAIL] Quick Entry hide pattern: {countQe} matches, expected 1"
      raise newException(
        ValueError, "fix_window_bounds: Quick Entry hide pattern not matched"
      )

  if applied.len == 0:
    raise newException(ValueError, "fix_window_bounds: No patches could be applied")

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_window_bounds <file>"
    quit(1)
  let file = paramStr(1)
  echo "=== Patch: fix_window_bounds ==="
  echo &"  Target: {file}"
  if not fileExists(file):
    echo &"  [FAIL] File not found: {file}"
    quit(1)
  let input = readFile(file)
  let output = apply(input)
  if output != input:
    writeFile(file, output)
    echo "  [PASS] Patches applied"
  else:
    echo "  [PASS] No changes needed (already patched)"
