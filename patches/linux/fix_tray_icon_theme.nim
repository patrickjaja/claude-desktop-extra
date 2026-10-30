# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Opt-in "always white" Linux tray glyph, plus a live refresh hook (issue #305).
#
# The official Linux .deb has native Linux tray-icon logic: a `switch` on a
# build-time icon-type constant ("ico"/"template-image"/"png"; "png" on Linux
# builds) in its own filename helper, whose png case picks the glyph. The
# fallback parameter is `!0` when the crash-containment wrapper retries:
#
#   function wto(e){switch("png"){
#     case"ico": return!e&&u.nativeTheme.shouldUseDarkColors?"Tray-Win32-Dark.ico":"Tray-Win32.ico";
#     case"template-image": return"TrayIconTemplate.png";
#     case"png": return e||NO()==="gnome"||u.nativeTheme.shouldUseDarkColors?"TrayIconLinux-Dark.png":"TrayIconLinux.png"
#   }}
#
# (v1.26832.0 to v1.46388.2 used backticks for every literal; both quotings are
# accepted. We anchor on the three case bodies, the one shape that survived the
# v1.26832.0 and v1.30096.1 refactors.)
#
# Upstream's choice is kept: white (TrayIconLinux-Dark.png) on GNOME and in
# dark mode, black (TrayIconLinux.png) in light mode. shouldUseDarkColors
# follows Claude's Appearance setting (upstream sets nativeTheme.themeSource),
# so a dark panel with a light Claude theme, or a bar that reports no color
# scheme, gets the black glyph on a dark background. The Community switch
# "Always use the white tray icon" (`trayIconAlwaysWhite`, off by default)
# covers that case:
#
#   A. the png case becomes
#        return process.platform==="linux"&&globalThis.__cdbTrayAlwaysWhite?.()?"TrayIconLinux-Dark.png":(<upstream>)
#      __cdbTrayAlwaysWhite is defined by js/extra_settings_main.js, which
#      add_feature_extra_settings.nim splices in after the stub's "use strict";
#      - it runs before the stub requires any chunk, so before the tray is
#      built. A missing helper makes `?.()` undefined and upstream decides.
#   B. globalThis.__cdbTrayRefresh re-runs the tray update, so flipping the
#      switch changes the glyph without a restart. It calls upstream's
#      crash-containment wrapper, the same entry point upstream's own
#      nativeTheme "updated" handler uses:
#        function xto(){...try{Tto(!1)}catch(e){Sto(e);try{...Tto(!0)}catch{...}}...}
#      where Tto is the update function (it resolves the selector's file,
#      `r=<path>.join(<dir>(),<selector>(e))`, and only calls setImage when
#      `r!==<last>`). Calling Tto directly would skip the wrapper's cleanup and
#      fallback retry when it throws mid-create, leaving a broken tray until
#      the next restart.
#
# Minified names (wto/NO/Tto change every release) are captured with [\w$]+
# wildcards, never hardcoded. Both icon files ship in the official .deb.
#
# Uses the `regex` package (pure Nim) like the other patches: std/nre dlopens
# PCRE1 at run time, which ubuntu-24.04 (the CI harness runner) does not ship.

import std/[os, strutils]
import regex

const EXPECTED_PATCHES = 2 # A, B

const INJECTED_A =
  """process.platform==="linux"&&globalThis.__cdbTrayAlwaysWhite?.()?"TrayIconLinux-Dark.png":"""

# Idempotency (A): positively assert OUR rewritten png case is present, rather
# than merely that the upstream shape is gone.
const ALREADY_A =
  re2"""case["`]png["`]:return process\.platform==="linux"&&globalThis\.__cdbTrayAlwaysWhite\?\.\(\)\?"TrayIconLinux-Dark\.png":\("""

# Match the switch that maps the build-time icon flavor to a filename,
# anchored on all three case bodies so we pin the one correct site, and
# capture the png case's expression so we keep it as the else branch.
# Group 1 = everything up to and including `case"png":return`,
# group 2 = upstream's png expression (incl. the fallback-param prefix).
const PATTERN_A =
  re2"""(switch\((?:[\w$]+|["`][\w-]+["`])\)\{case["`]ico["`]:return\s*(?:!?[\w$]+&&)?[\w$]+(?:\.[\w$]+)*\.nativeTheme\.shouldUseDarkColors\?["`]Tray-Win32-Dark\.ico["`]:["`]Tray-Win32\.ico["`];case["`]template-image["`]:return\s*["`]TrayIconTemplate\.png["`];case["`]png["`]:return)\s*((?:[\w$]+\|\|)?[\w$]+(?:\.[\w$]+)*\(\)===["`]gnome["`]\|\|[\w$]+(?:\.[\w$]+)*\.nativeTheme\.shouldUseDarkColors\?["`]TrayIconLinux-Dark\.png["`]:["`]TrayIconLinux\.png["`])\}"""

# The selector's name, read from its head - the same three case labels, so it
# matches before and after sub-patch A. Group 1 = the selector function.
const SELECTOR_HEAD =
  re2"""function ([\w$]+)\([\w$]+\)\{switch\((?:[\w$]+|["`][\w-]+["`])\)\{case["`]ico["`]:return[^;]*["`]Tray-Win32\.ico["`];case["`]template-image["`]:return\s*["`]TrayIconTemplate\.png["`];case["`]png["`]:return"""

# A function that resolves an icon path from a call of one-argument function:
#   function Tto(e){if(!u.app.isReady())return;let t=$b("menuBarEnabled"),r=n.default.join(wJ(),wto(e));
# Groups: 1 function, 2 its parameter, 3 the path local, 4 the called
# function, 5 the argument. `regex` has no backreferences, so the names that
# must agree (4 = selector, 5 = parameter) are compared in code below.
const UPDATE_HEAD =
  re2"""function ([\w$]+)\(([\w$]+)\)\{[^{}]*?[,;\s]([\w$]+)=[\w$]+(?:\.[\w$]+)*\.join\([\w$]+\(\),([\w$]+)\(([\w$]+)\)\)"""

# The update function only re-sets the image when the path changed:
#   r!==X9&&(Y9.setImage(...
# Group 1 = the compared path local, which must be UPDATE_HEAD's group 3.
const SETIMAGE_GUARD = re2"""([\w$]+)!==[\w$]+&&\(?[\w$]+\.setImage\("""

# Upstream's crash-containment wrapper: a zero-argument function that calls
# the update function with !1 inside a try, then retries it with !0.
# Groups: 1 the wrapper, 2 the function it calls (must be the update function).
const WRAPPER_HEAD = re2"""function ([\w$]+)\(\)\{[^{}]*try\{([\w$]+)\(!1\)\}catch\("""

const HOOK_PREFIX = "globalThis.__cdbTrayRefresh=function(){return "

# Idempotency (B): our assignment immediately followed by the update
# function's declaration. Group 1 = the wrapper it calls, group 2 = the
# declared function; hookLanded() checks that group 1 really is the wrapper
# of group 2.
const ALREADY_B =
  re2"""globalThis\.__cdbTrayRefresh=function\(\)\{return ([\w$]+)\(\)\};function ([\w$]+)\("""

proc bodyEnd(s: string, open: int): int =
  ## End (exclusive) of the function body whose `{` is at `open`: the matching
  ## close brace (string literals skipped), or the next `function ` keyword if
  ## that comes first - a bound, so a guard is never looked for in a neighbour.
  var next = s.find("function ", open + 1)
  if next < 0:
    next = s.len
  var depth = 0
  var i = open
  while i < next:
    let c = s[i]
    if c in {'"', '\'', '`'}:
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
        return i + 1
    inc i
  next

proc wrapperOf(s, update: string): seq[RegexMatch2] =
  ## Zero-arg functions that call `update(!1)` in a try and retry `update(!0)`.
  for m in s.findAll(WRAPPER_HEAD):
    if s[m.group(1)] != update:
      continue
    let open = s.find('{', m.boundaries.a)
    let body = s[open ..< bodyEnd(s, open)]
    if (update & "(!0)") in body:
      result.add m

proc hookLanded(s: string): bool =
  for m in s.findAll(ALREADY_B):
    let wrapper = s[m.group(0)]
    for w in wrapperOf(s, s[m.group(1)]):
      if s[w.group(0)] == wrapper:
        return true
  false

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0

  # ── Sub-patch A: the switch decides first, upstream otherwise ──────────
  if result.contains(ALREADY_A):
    echo "  [OK] tray icon selector: always-white switch already present (skipped)"
    patchesApplied.inc
  else:
    var count = 0
    result = result.replace(
      PATTERN_A,
      proc(m: RegexMatch2, s: string): string =
        inc count
        # A space after `return` keeps the injected token legal; upstream's
        # expression is parenthesised so it stays the whole else branch.
        s[m.group(0)] & " " & INJECTED_A & "(" & s[m.group(1)] & ")}",
    )
    if count != 1:
      echo "  [FAIL] tray icon selector: " & $count & " matches, expected 1"
    elif not result.contains(ALREADY_A):
      echo "  [FAIL] tray icon selector: rewrite did not produce the expected shape"
    else:
      echo "  [OK] tray icon selector: 1 match"
      patchesApplied.inc

  # ── Sub-patch B: publish the crash-contained tray update ───────────────
  if hookLanded(result):
    echo "  [OK] tray refresh hook already present (skipped)"
    patchesApplied.inc
  else:
    let heads = result.findAll(SELECTOR_HEAD)
    if heads.len != 1:
      echo "  [FAIL] tray refresh hook: " & $heads.len &
        " selector functions, expected 1"
    else:
      let selector = result[heads[0].group(0)]
      var sites: seq[RegexMatch2]
      for m in result.findAll(UPDATE_HEAD):
        if result[m.group(3)] == selector and result[m.group(4)] == result[m.group(1)]:
          sites.add m
      if sites.len != 1:
        echo "  [FAIL] tray refresh hook: " & $sites.len &
          " functions resolve the path via " & selector & "(<param>), expected 1"
      else:
        let site = sites[0]
        let fnName = result[site.group(0)]
        let pathVar = result[site.group(2)]
        # The guard must be in the update function's own body.
        let open = result.find('{', site.boundaries.a)
        let stop = bodyEnd(result, open)
        var guard: RegexMatch2
        let guarded =
          result.find(SETIMAGE_GUARD, guard, site.boundaries.b + 1) and
          guard.boundaries.b < stop and result[guard.group(0)] == pathVar
        let wrappers = wrapperOf(result, fnName)
        # Statement position: only `;`, `}` or the start of the file may come
        # before the declaration we insert in front of.
        var before = site.boundaries.a - 1
        while before >= 0 and result[before] in {' ', '\t', '\n', '\r'}:
          dec before
        if not guarded:
          echo "  [FAIL] tray refresh hook: " & fnName & " has no `" & pathVar &
            "!==...&&...setImage(` in its body -- wrong site"
        elif wrappers.len != 1:
          echo "  [FAIL] tray refresh hook: " & $wrappers.len &
            " crash-containment wrappers try " & fnName & "(!1) and retry " & fnName &
            "(!0), expected 1"
        elif before >= 0 and result[before] notin {';', '}'}:
          echo "  [FAIL] tray refresh hook: `" & result[before] & "` before function " &
            fnName & " -- not a statement position"
        else:
          let wrapper = result[wrappers[0].group(0)]
          # Inserted right before the update function's declaration; the
          # wrapper is a hoisted declaration too, so it is already callable.
          let at = site.boundaries.a
          result = result[0 ..< at] & HOOK_PREFIX & wrapper & "()};" & result[at .. ^1]
          if hookLanded(result):
            echo "  [OK] tray refresh hook: globalThis.__cdbTrayRefresh -> " & wrapper &
              " (update " & fnName & ", selector " & selector & ")"
            patchesApplied.inc
          else:
            echo "  [FAIL] tray refresh hook: injection did not produce the expected shape"

  if patchesApplied < EXPECTED_PATCHES:
    echo "  [FAIL] Only " & $patchesApplied & "/" & $EXPECTED_PATCHES &
      " patches applied"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_tray_icon_theme <path_to_index.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_tray_icon_theme ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] Tray icon theme patched successfully"
  else:
    echo "  [PASS] Tray icon theme already patched"
