# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Patch Claude Desktop to use correct tray icon on Linux.
#
# The official Linux .deb has native Linux tray-icon logic: a `switch` on a
# build-time icon-type constant ("ico"/"template-image"/"png"; "png" on Linux
# builds), whose png case picks the icon per desktop environment and theme.
#
# v1.30096.1 extracted that switch into its own filename helper that RETURNS
# the icon name (previously it assigned to a `let` in the tray-update
# function), and added a fallback parameter that the crash-containment
# wrapper passes as `!0` on a retry:
#
#   function yer(e){switch(`png`){
#     case`ico`: return!e&&ELEC.nativeTheme.shouldUseDarkColors?`Tray-Win32-Dark.ico`:`Tray-Win32.ico`;
#     case`template-image`: return`TrayIconTemplate.png`;
#     case`png`: return e||AL()===`gnome`||ELEC.nativeTheme.shouldUseDarkColors?`TrayIconLinux-Dark.png`:`TrayIconLinux.png`
#   }}
#
# (v1.26832.0 had reshaped it before that: string literals became backticks and
# the switch scrutinee is the constant-folded literal `png` rather than a
# build-time variable. We anchor on the three case bodies, which is the one
# shape that survived both refactors.)
#
# That heuristic is wrong for us: it only forces the dark icon on GNOME, and
# otherwise follows nativeTheme. But Linux system trays are almost universally
# dark (KDE, Xfce, status-notifier hosts, ...) regardless of the app/desktop
# theme, so on a light theme outside GNOME upstream picks the dark-on-dark
# TrayIconLinux.png and the icon is invisible. We deliberately OVERRIDE the
# native heuristic: rewrite the png case so it returns TrayIconLinux-Dark.png
# (the light glyph) on Linux, keeping upstream's expression as the non-Linux
# fallback. (Minified names like yer/AL change every release - the regex uses
# [\w$]+ wildcards; the icon files ship in the official .deb.)

import std/os
import std/nre

const INJECTED = """process.platform==="linux"?"TrayIconLinux-Dark.png":"""

proc apply*(input: string): string =
  # Idempotency: positively assert OUR rewritten png case is present, rather
  # than merely that the upstream shape is gone.
  if input.contains(
    re"""case["`]png["`]:return process\.platform==="linux"\?"TrayIconLinux-Dark\.png":"""
  ):
    echo "  [OK] tray icon theme logic: already patched (skipped)"
    result = input
    return

  # Match the switch that maps the build-time icon flavor to a filename,
  # anchored on all three case bodies so we pin the one correct site, and
  # capture the png case's expression so we can keep it as the non-Linux
  # branch. Group 1 = everything up to and including `case`png`:return `,
  # group 2 = upstream's png expression (incl. the fallback-param prefix).
  # Variable names may contain $ (valid JS identifier), so use [\w$]+.
  # Quoting is minifier-dependent (double quotes <=1.24012.x, backticks since
  # 1.26832.0), so every literal accepts either via ["`].
  let pattern =
    re"""(switch\((?:[\w$]+|["`][\w-]+["`])\)\{case["`]ico["`]:return\s*(?:!?[\w$]+&&)?[\w$]+(?:\.[\w$]+)*\.nativeTheme\.shouldUseDarkColors\?["`]Tray-Win32-Dark\.ico["`]:["`]Tray-Win32\.ico["`];case["`]template-image["`]:return\s*["`]TrayIconTemplate\.png["`];case["`]png["`]:return)\s*((?:[\w$]+\|\|)?[\w$]+(?:\.[\w$]+)*\(\)===["`]gnome["`]\|\|[\w$]+(?:\.[\w$]+)*\.nativeTheme\.shouldUseDarkColors\?["`]TrayIconLinux-Dark\.png["`]:["`]TrayIconLinux\.png["`])\}"""
  var count = 0
  result = input.replace(
    pattern,
    proc(m: RegexMatch): string =
      inc count
      # Force the dark (light-glyph) Linux icon on Linux; Linux trays are
      # universally dark, and upstream's AL()==="gnome"||shouldUseDarkColors
      # heuristic otherwise returns the dark-on-dark TrayIconLinux.png.
      # A space after `return` keeps the injected keyword-adjacent token legal;
      # upstream's expression is parenthesised so it stays the else branch.
      m.captures[0] & " " & INJECTED & "(" & m.captures[1] & ")}",
  )
  if count != 1:
    echo "  [FAIL] tray icon theme logic: " & $count & " matches, expected 1"
    quit(1)
  echo "  [OK] tray icon theme logic: 1 match"

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
