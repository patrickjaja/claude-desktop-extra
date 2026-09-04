# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Suppress taskbar attention-flashing (_NET_WM_STATE_DEMANDS_ATTENTION) on Linux.
#
# Two sub-patches:
#   1. An early monkey-patch block that neuters `flashFrame(true)` and keeps
#      clearing any residual attention flag while a window is blurred.
#   2. A Linux early-return in `requestUserAttention()`. Since v1.46388.2 the
#      method returns a boolean ("attention was requested") that callers chain
#      with `&&` to register remote-attention tags, so the guard returns `!1`
#      (false): on Linux nothing was flashed, so nothing is left to release.
#
# Scope is deliberately limited to the attention/flash APIs. The window
# activation primitives -- `BrowserWindow.show/focus/moveTop`, `app.focus`,
# `webContents.focus` -- are left at stock Electron behaviour, because they are
# the only way a background context can bring the main window to the front:
# upstream's `second-instance` handler, the tray "Show App" item and our own
# Computer Use teach-mode restore all reveal the window through
# `show()` + `focus()` at a moment when nothing of the app is focused. Wrapping
# those in an "only if already focused" guard silently disables every one of
# those paths (issue #233).
#
# Anthropic's bundle is minified and renames identifiers between releases, so
# the requestUserAttention anchor uses [\w$]+ wildcards and fails loudly rather
# than silently skipping.

import std/[os, strformat, strutils]
import regex

const EXPECTED_PATCHES = 2

# Bumped whenever the guard's shape changes, so idempotency can positively
# assert THIS version's end-state rather than "some guard is present".
const GUARD_MARKER = "__cdb_flashguard_v2__"

const LINUX_FLASH_GUARD =
  """;(function(){
if(process.platform!=="linux")return;
/*""" & GUARD_MARKER &
  """*/
var _e=require("electron");

/* 1. flashFrame: only allow flashFrame(false) to clear attention */
var _origFlash=_e.BrowserWindow.prototype.flashFrame;
_e.BrowserWindow.prototype.flashFrame=function(f){
if(!f&&!this.isDestroyed())return _origFlash.call(this,false);
};

/* 2. Keep clearing a residual attention flag while any window is blurred */
_e.app.whenReady().then(function(){
var _t=null;
function _clear(){
_e.BrowserWindow.getAllWindows().forEach(function(w){
if(!w.isDestroyed())try{_origFlash.call(w,false)}catch(_){}
});
}
_e.app.on("browser-window-blur",function(){
_clear();
if(_t)clearInterval(_t);
_t=setInterval(_clear,500);
});
_e.app.on("browser-window-focus",function(){
if(_t){clearInterval(_t);_t=null;}
});
});
})();"""

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0
  var applied: seq[string] = @[]

  # ── 1. Early flash guard ──────────────────────────────────────────────────
  # Idempotency asserts OUR current guard marker. A bundle carrying the old
  # activation-suppressing guard (its `_bwShowInactive` shim) must never be
  # mistaken for a patched one - that combination means the staged input was
  # already patched by a different version and the result would be wrong.
  if GUARD_MARKER in result:
    echo "  [INFO] Linux flash guard already injected (" & GUARD_MARKER & ")"
    applied.add("flash-guard(skip)")
    patchesApplied += 1
  elif "_bwShowInactive" in result:
    echo "  [FAIL] Input carries the superseded activation-suppressing guard"
    echo "         (_bwShowInactive present). Re-extract a clean bundle."
  else:
    if result.startsWith("\"use strict\";"):
      result =
        "\"use strict\";" & LINUX_FLASH_GUARD & result[len("\"use strict\";") .. ^1]
      echo "  [OK] Linux flash guard injected after \"use strict\""
      applied.add("flash-guard")
    else:
      result = LINUX_FLASH_GUARD & result
      echo "  [OK] Linux flash guard prepended"
      applied.add("flash-guard(prepend)")
    patchesApplied += 1

  # ── 2. No-op requestUserAttention on Linux ────────────────────────────────
  if "requestUserAttention(){if(process.platform===\"linux\")return!1;" in result:
    echo "  [INFO] requestUserAttention already guarded"
    applied.add("rua-guard(skip)")
    patchesApplied += 1
  else:
    # v1.26832.0 dropped the hoisted `var <tmp>;` that older minifiers emitted
    # in front of the guard expression, so the prefix is optional now.
    # v1.46388.2 turned the body into a `return <ternary>` that yields whether
    # the frame was flashed, so an optional `return ` is accepted in front of
    # the focus check. The injected guard returns `!1` in both shapes: for the
    # old void body the value is simply ignored.
    let ruaPattern =
      re2"(requestUserAttention\(\)\{)((?:return )?(?:var [\w$]+;)?this\.isAppFocusedAndVisible\(\)\|\|)"
    var ruaCount = 0
    result = result.replace(
      ruaPattern,
      proc(m: RegexMatch2, s: string): string =
        inc ruaCount
        s[m.group(0)] & "if(process.platform===\"linux\")return!1;" & s[m.group(1)],
    )
    if ruaCount > 0:
      echo &"  [OK] requestUserAttention Linux guard: {ruaCount} match(es)"
      applied.add(&"rua-guard({ruaCount})")
      patchesApplied += 1
    else:
      echo "  [FAIL] requestUserAttention pattern not matched"

  if patchesApplied < EXPECTED_PATCHES:
    raise newException(
      ValueError,
      &"fix_dock_bounce: Only {patchesApplied}/{EXPECTED_PATCHES} patches applied",
    )

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_dock_bounce <file>"
    quit(1)
  let file = paramStr(1)
  echo "=== Patch: fix_dock_bounce ==="
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
