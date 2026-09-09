# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Titlebar-mode opt-ins: exposes the launcher's two titlebar flags as persisted
# settings in claude-desktop-extra.json (both default FALSE), switched from
# Settings -> Extra -> Community Features.
#
#   `nativeTitlebar`    / CLAUDE_NATIVE_TITLEBAR=1     -> the system frame
#   `noWindowControls`  / CLAUDE_NO_WINDOW_CONTROLS=1  -> frameless, no buttons
#
# Two modules are injected at the head of the main bundle, in this order:
#   1. js/window_controls_pref.js - installs globalThis.__cdbNativeTb() and
#      globalThis.__cdbNoWinCtl(), the synchronous, memoized, never-throwing
#      readers, plus the shared globalThis.__cdbWinCtlPref surface (mode table,
#      file names, JSONC-aware readers). patches/linux/fix_native_frame.nim
#      calls both when it builds the BrowserWindow options.
#   2. js/window_controls_main.js - the four IPC handlers for the two Settings
#      rows (cdb-wc:native-read/-set, cdb-wc:pref-read/-set), reusing (1) for
#      every file decision.
#
# Order is load-bearing: (2) reads globalThis.__cdbWinCtlPref at evaluation
# time and refuses to register anything if it is missing. Both are evaluated as
# ONE string, so file order IS evaluation order.
#
# The two readers are independent and DUMB - each answers only "is my mode
# requested" (env var OR config key). Ranking the modes against each other
# (native beats bare beats the default integrated titlebar) is the window
# patch's job, not this one's.
#
# Both modes need an app RESTART (frame / titleBarStyle / hasShadow are
# BrowserWindow constructor options on Linux - setTitleBarOverlay(false) throws
# and there is no setFrame), which is why the readers may memoize.
#
# Break risk: VERY LOW - no regex on minified app code, only the stable
# "use strict"; bundle-head anchor and standard Electron/Node APIs.

import std/[os, strutils, strformat]

const PREF_JS = staticRead("../../js/window_controls_pref.js")
const MAIN_JS = staticRead("../../js/window_controls_main.js")

# One marker per injected module, so a HALF-injected bundle (one module present,
# the other lost to a bad edit or a partially applied patch) is a loud failure
# instead of an [OK] backed by a false premise (AGENTS.md Rule 6).
const MARKERS = ["__CDB_WINCTL_PREF__", "__CDB_WINCTL_MAIN__"]
const EXPECTED_PATCHES = 2 # pref reader + IPC half

proc buildInjection(): string =
  # The reader MUST come first - see the order note above.
  PREF_JS & "\n;\n" & MAIN_JS & "\n;\n"

# Each marker must appear EXACTLY once. Counting occurrences rather than
# testing membership catches a double injection (two copies of a module) as
# well as a missing one; both are broken, and only "exactly one of each" is the
# end-state this patch promises.
proc countMarkers(s: string): int =
  result = 0
  for m in MARKERS:
    if s.count(m) == 1:
      result.inc

proc apply*(input: string): string =
  result = input

  # Idempotency: positive end-state assertion - our OWN markers must be there,
  # not merely "the pre-patch shape is gone" (AGENTS.md Rule 6).
  let present = countMarkers(result)
  if present == EXPECTED_PATCHES:
    echo "  [OK] window controls: both modules already present (idempotent)"
    return
  if present != 0:
    echo &"  [FAIL] window controls: bundle is half-patched ({present}/{EXPECTED_PATCHES} markers) - re-audit"
    quit(1)

  # POSITIONAL anchor, not a counted one: "use strict"; occurs once per chunk
  # (164 times across the staged bundle at v1.49585.0), so the invariant that
  # matters is that the STAGED FILE STARTS with it. Injecting anywhere else
  # would push the directive out of first-statement position and silently drop
  # the whole bundle out of strict mode, so a head that no longer matches is a
  # loud failure rather than a fallback prepend.
  let strictPrefix = "\"use strict\";"
  if not result.startsWith(strictPrefix):
    echo "  [FAIL] window controls: staged bundle no longer starts with \"use strict\"; - re-audit the anchor"
    quit(1)
  result = strictPrefix & buildInjection() & result[strictPrefix.len .. ^1]
  echo "  [OK] window controls injected after \"use strict\""

  let applied = countMarkers(result)
  if applied < EXPECTED_PATCHES:
    echo &"  [FAIL] Only {applied}/{EXPECTED_PATCHES} window-controls modules present exactly once after patching"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_feature_window_controls <path_to_index.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: add_feature_window_controls ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo &"  [PASS] window controls applied ({EXPECTED_PATCHES}/{EXPECTED_PATCHES} modules)"
  else:
    if countMarkers(output) != EXPECTED_PATCHES:
      echo "  [FAIL] No changes made and the injected modules are absent"
      quit(1)
    echo "  [OK] Already applied (no changes needed)"
