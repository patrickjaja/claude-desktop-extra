# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Per-profile window identity (issue #319).
#
# Problem: every profile's windows carry the same Wayland app_id / X11
# WM_CLASS (com.anthropic.Claude), so taskbars and Alt-Tab group a named
# profile under the default profile's .desktop file instead of its own
# com.anthropic.Claude-<name>.desktop (own icon, own group).
#
# Fix: a head script (js/profile_app_identity.js), inserted right after the
# bundle's "use strict" like fix_profile_url_routing.nim. For a named profile
# whose .desktop exists in an XDG applications dir, it sets CHROME_DESKTOP and
# app.setDesktopName to <base>-<name>.desktop before upstream builds any
# window, and pins app.{is,set,remove}AsDefaultProtocolClient to the base name
# for the duration of each call, so the claude:// handler is never handed to a
# named profile. The default profile, invalid names and non-Linux return before
# touching anything.
#
# Order: like the other head-script patches it goes right after a leading
# "use strict" or, when an earlier patch already prepended, at the very top;
# whichever order they run in, every head script is an independent IIFE ahead
# of upstream's code.

import std/[os, strutils]

const IDENTITY_JS = staticRead("../../js/profile_app_identity.js")

# Only our injected script contains this line (a named function expression,
# so it creates no global binding).
const MARKER = "function __cdbProfileAppIdentity(){"

static:
  doAssert IDENTITY_JS.startsWith(";(" & MARKER),
    "js/profile_app_identity.js must start with the marker"
  doAssert IDENTITY_JS.count(MARKER) == 1

proc apply*(input: string): string =
  result = input

  let hits = result.count(MARKER)
  if hits == 1 and IDENTITY_JS in result:
    echo "  [OK] profile app identity head script already present (idempotent)"
    return
  if hits != 0:
    raise newException(
      ValueError, "marker found " & $hits & "x but not our exact head script - re-audit"
    )

  # Earlier head-script patches (basename order) prepend ahead of the bundle's
  # "use strict", so the staged file may not start with it any more; both
  # placements run before upstream's code.
  let strictPrefix = "\"use strict\";"
  if result.startsWith(strictPrefix):
    result = strictPrefix & IDENTITY_JS & result[strictPrefix.len .. ^1]
  else:
    result = IDENTITY_JS & result
  if result.count(MARKER) != 1 or IDENTITY_JS notin result:
    raise newException(ValueError, "head script not present after insertion")
  echo "  [OK] profile app identity head script inserted at the bundle head"

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_profile_app_identity <path_to_index.js>"
    quit(1)

  let filePath = paramStr(1)
  echo "=== Patch: fix_profile_app_identity ==="
  echo "  Target: " & filePath

  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)

  let input = readFile(filePath)
  var output: string
  try:
    output = apply(input)
  except ValueError as e:
    echo "  [FAIL] " & e.msg
    quit(1)

  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] Profile app identity head script installed"
