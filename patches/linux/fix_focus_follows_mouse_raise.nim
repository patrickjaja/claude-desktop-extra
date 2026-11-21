# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Stop the app raising itself when it gains focus without a raise
# (focus-follows-mouse on KWin, Cinnamon, ...; anthropics/claude-code#75905).
#
# Upstream moves keyboard focus into the window's WebContentsView from the
# window's `focus` event (since v6.28899.2 through one shared helper, see B).
# On Linux,
# Electron's WebContents::Focus() first calls `owner_window()->Focus(true)`,
# i.e. `Widget::Activate()`, which has no "already active" check: on Wayland it
# sends an xdg_activation token + `activate`, on X11 `_NET_ACTIVE_WINDOW`, and
# the window manager treats both as a raise request. With focus-follows-mouse
# the WM focuses the window on pointer entry WITHOUT raising it, the `focus`
# event fires, and the app re-activates (raises) itself on every hover.
#
# Three sub-patches:
#   0. `__cdbFocusNoRaise(win, contents)` helper, injected after "use strict".
#      Off Linux, or when the window is not already active, it is a plain
#      `contents.focus()`. When the window is already active it skips the call
#      if the view already holds focus (Chromium restores the last focused view
#      on activation), and otherwise re-checks once after the activation
#      settles before falling back to the stock call.
#      Startup: the window maps without focus (KWin answers the launch
#      activation with "not-granted"), and upstream's initial focus call runs
#      before the view has loaded, so the view never holds focus and the first
#      focus-follows-mouse activation would take the raising fallback. The
#      helper therefore focuses the view once more 500 ms after its first load,
#      while the window is still visible and inactive. That activation request
#      carries no input serial and is denied like the launch one (no raise), but
#      the view's focus is stored and restored on the first hover. It is skipped
#      once the window has been active, because a request then could carry a
#      valid serial and be granted.
#   A. The main window's focus function calls it instead of `.focus()` on its
#      direct path (startup and non-focus-event callers).
#   B. Upstream's shared focus-handler helper (v6.28899.2:
#      `function kv(e,t){!e.isFocused()||t.isFocused()||t.focus()}`, used by
#      the main window, the main-view pop-outs, artifact pop-ups and the
#      full-screen view cover) calls it instead of its final `.focus()`.
#      Upstream's helper absorbed the "window not active" and "contents already
#      focused" skips; what stays ours is the deferred re-check when the window
#      is active but the contents do not hold focus yet, and the startup
#      prefocus (A).
#
# Scope is deliberately limited to calls made from `focus` handlers. Every
# other activation path (tray "Show App", second-instance, notifications,
# teach-mode restore) keeps stock Electron behaviour: those run while the
# window is NOT active and must raise it (issue #233, fix_dock_bounce.nim).

import std/[os, strformat, strutils]
import regex

const EXPECTED_PATCHES = 3

# Bumped whenever the helper's shape changes, so idempotency asserts THIS
# version's end-state rather than "some helper is present".
const HELPER_MARKER = "__cdb_focusnoraise_v1__"

const FOCUS_NO_RAISE_HELPER =
  """;(function(){
/*""" & HELPER_MARKER &
  """*/
var _last="",_lastAt=0;
function _log(m){
var n=Date.now();
if(m===_last&&n-_lastAt<1000)return;
_last=m;_lastAt=n;
try{(globalThis.__cdbDiag||function(){})("[focus-no-raise] "+m)}catch(_){}
}
globalThis.__cdbFocusNoRaise=function(w,c){
if(!c||c.isDestroyed())return;
if(process.platform!=="linux"||!w||w.isDestroyed())return c.focus();
if(!w.isFocused()){
if(!c.__cdbFnrPre){
c.__cdbFnrPre=1;
c.once("did-finish-load",function(){
setTimeout(function(){
if(c.__cdbFnrPre!==1||c.isDestroyed()||w.isDestroyed()||w.isFocused()||!w.isVisible())return;
c.__cdbFnrPre=2;
c.focus();
_log("prefocus after first load: view focused="+c.isFocused());
},500);
});
}
return c.focus();
}
c.__cdbFnrPre=2;
if(c.isFocused()){_log("skip: window already active, view already focused");return;}
_log("defer: window already active, view not focused yet");
setTimeout(function(){
if(c.isDestroyed()||w.isDestroyed()||!w.isFocused())return;
if(c.isFocused()){_log("skip: view focus restored after activation");return;}
_log("fallback: webContents.focus() (re-activates the window)");
c.focus();
},0);
};
})();"""

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0

  # ── 0. Helper ──────────────────────────────────────────────────────────────
  if HELPER_MARKER in result:
    echo "  [INFO] focus-no-raise helper already injected (" & HELPER_MARKER & ")"
    patchesApplied += 1
  elif "__cdbFocusNoRaise=" in result:
    echo "  [FAIL] Input carries a different __cdbFocusNoRaise helper version."
    echo "         Re-extract a clean bundle."
  elif result.startsWith("\"use strict\";"):
    result =
      "\"use strict\";" & FOCUS_NO_RAISE_HELPER & result[len("\"use strict\";") .. ^1]
    echo "  [OK] focus-no-raise helper injected after \"use strict\""
    patchesApplied += 1
  else:
    result = FOCUS_NO_RAISE_HELPER & result
    echo "  [OK] focus-no-raise helper prepended"
    patchesApplied += 1

  # ── B. Upstream's focus-handler helper (resolved first: A needs its name) ──
  # v6.28899.2 routes every window `focus` handler (main window, main-view
  # pop-outs, artifact pop-ups, the full-screen view cover) through one helper:
  #   function kv(e,t){!e.isFocused()||t.isFocused()||t.focus()}
  # It already skips the call when the window is not active or the contents
  # already hold focus; the remaining `t.focus()` (window active, contents not
  # focused yet) is the raising call. Up to v5.11492.5 each handler called
  # `.focus()` itself (`c.on("focus",(()=>{n.isDestroyed()||n.focus()}))`).
  # Groups (0-based): 0 = name, 1 = window, 2 = contents, 3 = window (guard),
  # 4 and 5 = contents (guard, call); 1 == 3 and 2 == 4 == 5.
  var helperName = ""
  let kvDone =
    re2"function ([\w$]+)\(([\w$]+),([\w$]+)\)\{!([\w$]+)\.isFocused\(\)\|\|([\w$]+)\.isFocused\(\)\|\|__cdbFocusNoRaise\(([\w$]+),([\w$]+)\)\}"
  var doneHits = 0
  for m in result.findAll(kvDone):
    let w = result[m.group(1)]
    let c = result[m.group(2)]
    if result[m.group(3)] == w and result[m.group(4)] == c and result[m.group(5)] == w and
        result[m.group(6)] == c:
      inc doneHits
      helperName = result[m.group(0)]
  if doneHits == 1:
    echo "  [INFO] focus-handler helper already rewritten"
    patchesApplied += 1
  elif doneHits > 1:
    echo &"  [FAIL] focus-handler helper: rewritten {doneHits}x, expected 1"
  else:
    let kvPat =
      re2"function ([\w$]+)\(([\w$]+),([\w$]+)\)\{!([\w$]+)\.isFocused\(\)\|\|([\w$]+)\.isFocused\(\)\|\|([\w$]+)\.focus\(\)\}"
    var count = 0
    result = result.replace(
      kvPat,
      proc(m: RegexMatch2, s: string): string =
        let w = s[m.group(1)]
        let c = s[m.group(2)]
        if s[m.group(3)] != w or s[m.group(4)] != c or s[m.group(5)] != c:
          return s[m.boundaries]
        inc count
        helperName = s[m.group(0)]
        &"function {helperName}({w},{c}){{!{w}.isFocused()||{c}.isFocused()||__cdbFocusNoRaise({w},{c})}}",
    )
    if count == 1:
      echo &"  [OK] focus-handler helper {helperName} rewritten (1 match)"
      patchesApplied += 1
    else:
      echo &"  [FAIL] focus-handler helper: {count} matches, expected 1"
      helperName = ""

  # ── A. Main window focus function ──────────────────────────────────────────
  # v6.28899.2: called as re(!0) from the main window's `focus` event (through
  # the helper above) and as re() at startup and from other paths, which call
  # `.focus()` directly:
  #   re=(e=!1)=>{...,i=n??r??t;e?kv(f,i):i.focus(),AZi(t),...}
  # The direct call goes through __cdbFocusNoRaise too: at startup it arms the
  # one-time prefocus (see the header). Up to v5.11492.5:
  #   y=()=>{let e=p.webContents;!e||e.isDestroyed()||((To?l.webContents:e).focus(),...
  # Groups (0-based): 0 = flag, 1 = helper, 2 = window, 3 = contents (helper
  # call), 4 = contents (direct call); 1 == helper name, 3 == 4.
  if helperName.len == 0:
    echo "  [FAIL] main window focus function: helper name unknown (sub-patch B failed)"
  else:
    let h = escapeRe(helperName)
    let mainDone = re2(
      r"[\w$]+\?" & h & r"\(([\w$]+),([\w$]+)\):__cdbFocusNoRaise\(([\w$]+),([\w$]+)\),"
    )
    var doneHits = 0
    for m in result.findAll(mainDone):
      if result[m.group(0)] == result[m.group(2)] and
          result[m.group(1)] == result[m.group(3)]:
        inc doneHits
    if doneHits == 1:
      echo "  [INFO] main window focus function already rewritten"
      patchesApplied += 1
    else:
      let mainPat =
        re2(r"([\w$]+)\?" & h & r"\(([\w$]+),([\w$]+)\):([\w$]+)\.focus\(\),")
      var count = 0
      result = result.replace(
        mainPat,
        proc(m: RegexMatch2, s: string): string =
          let w = s[m.group(1)]
          let c = s[m.group(2)]
          if s[m.group(3)] != c:
            return s[m.boundaries]
          inc count
          &"{s[m.group(0)]}?{helperName}({w},{c}):__cdbFocusNoRaise({w},{c}),",
      )
      if count == 1 and doneHits == 0:
        echo "  [OK] main window focus function rewritten (1 match)"
        patchesApplied += 1
      else:
        echo &"  [FAIL] main window focus function: {count} matches (already rewritten: {doneHits}), expected 1"

  if patchesApplied < EXPECTED_PATCHES:
    raise newException(
      ValueError,
      &"fix_focus_follows_mouse_raise: Only {patchesApplied}/{EXPECTED_PATCHES} patches applied",
    )

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_focus_follows_mouse_raise <file>"
    quit(1)
  let file = paramStr(1)
  echo "=== Patch: fix_focus_follows_mouse_raise ==="
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
