# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Suffix the main window title with the active profile name when CLAUDE_PROFILE
# is set. "Claude" → "Claude (work)" so users can tell windows apart in
# Alt-Tab, taskbar tooltips, and screenshots without relying on icon shape.
#
# How it works:
#   - The main window is constructed by the unsuffixed-named function
#     `function NAME(arg){return WIN=new ELECTRON.BrowserWindow(arg),...}`.
#   - Since v4.16336.0 the main window's OS title is static: it is built with
#     `title:<fn>()` (which returns "Claude"), a helper preventDefaults its
#     page-title-updated, and the conversation title goes to the in-app title
#     bar (dispatchUpdateTitleBar), not to win.setTitle. (v2.19675.1 to
#     v4.4212.0 called win.setTitle(composed) on navigation instead.)
#   - We inject a tiny comma-expression right after the BrowserWindow
#     construction that, when CLAUDE_PROFILE is set, wraps THIS window's
#     setTitle so every title (ours or upstream's) ends with " (PROFILE)"
#     exactly once and re-applies the current title. Electron's native
#     page-title-updated path bypasses JS setTitle, so the patch also
#     asserts upstream's preventDefault on that event is still attached to
#     the main window. "Claude" -> "Claude (work)".
#
# Pop-out windows (popped-out Code sessions, chats, artifact shells, idle pool
# windows) are not created by that factory: the main view opens them with
# `window.open("about:blank", <frame name>)` and upstream's window manager
# adopts the resulting child BrowserWindow, whose OS title is the page's
# document.title verbatim. With a profile set, the same injection also installs
# ONE `app.on("web-contents-created")` listener that watches each webContents'
# `did-create-window` and, for a child that is an about:blank window opened by
# the MAIN frame of an app-origin page (the same `opener === mainFrame` test
# upstream's own did-create-window handler applies; origins via
# globalThis.__cdbSenderGuard, a missing guard fails closed), wraps that
# window's setTitle like the main window's and listens for the BrowserWindow's
# own page-title-updated (the event Electron emits on the window; it is the
# one preventDefault stops, as in the main-window path) so every later page
# title keeps the suffix exactly once. A title the window already has at
# creation is suffixed once right away.
# Anything else (no opener, a subframe opener, a foreign origin) is left alone.
#
# Default profile (CLAUDE_PROFILE unset) → no listener attached, no behavior
# change.
#
# Break risk: LOW. Targets the standard Electron BrowserWindow API with
# flexible regex on minified variable names.
#
# Uses the `regex` package (pure Nim) like the other patches: std/nre dlopens
# PCRE1 at run time, which ubuntu-24.04 (the CI harness runner) does not ship.
# `regex` has no backreferences: "same identifier" captures are equality
# checks on the groups, and the window variable is spliced in literally.

import std/[os, strformat, strutils]
import regex

const SENTINEL = "__cdb_titleHook"
const POPOUT_SENTINEL = "__cdb_popoutTitleHook"

# Runs once with the suffix (" (work)"). Installed from the main-window
# factory, i.e. after upstream's `ready`, so __cdbDiag exists.
const POPOUT_HOOK =
  """((__cdb_s)=>{if(globalThis.__cdb_popoutTitleHook)return;globalThis.__cdb_popoutTitleHook=true;""" &
  """const __cdb_el=require("electron");""" &
  """const __cdb_wrap=(w)=>{const o=w.setTitle.bind(w);""" &
  """const f=(t)=>{t=String(t??"");return o(t.endsWith(__cdb_s)?t:t+__cdb_s)};w.setTitle=f;""" &
  """w.on("page-title-updated",(ev,t)=>{if(!t)return;ev.preventDefault();f(t)});const t0=w.getTitle();if(t0)f(t0)};""" &
  """__cdb_el.app.on("web-contents-created",(_e,__cdb_wc)=>{__cdb_wc.on("did-create-window",(__cdb_c,__cdb_d)=>{""" &
  """try{if(!__cdb_d||__cdb_d.url!=="about:blank")return;const op=__cdb_c.webContents.opener;""" &
  """if(!op||op.parent!==null||op!==__cdb_wc.mainFrame)return;""" &
  """const g=globalThis.__cdbSenderGuard;if(!g||!g.originAllowed(op.url))return;__cdb_wrap(__cdb_c)}catch(_x){}})});""" &
  """try{(globalThis.__cdbDiag||console.log)("[profile-title] pop-out windows of the main view carry the profile suffix:"+__cdb_s)}catch(_x){}})"""

# Precondition: a helper `function H(e){e.on("page-title-updated",(e=>{
# e.preventDefault()}))}` (groups: 0 = H, 1 = param, 2 = receiver, 3 = event
# param, 4 = event receiver; 1 == 2 and 3 == 4), called with the main window
# variable shortly after `WIN=FACTORY({...})`.
const PREVENT_HELPER =
  re2"""function ([\w$]+)\(([\w$]+)\)\{([\w$]+)\.on\(["`]page-title-updated["`],\(?([\w$]+)\)?=>\{?([\w$]+)\.preventDefault\(\)\}?\)\)\}"""

# How far after the main-window construction the helper call may sit
# (1.7 KB in v4.16336.0).
const PREVENT_CALL_WINDOW = 12000

proc isIdentChar(c: char): bool =
  c in {'a' .. 'z', 'A' .. 'Z', '0' .. '9', '_', '$'}

proc hasCall(s, callee, arg: string, a, b: int): bool =
  ## `callee(arg)` as a standalone call (no identifier or `.` right before
  ## the callee) somewhere in s[a ..< b].
  let needle = callee & "(" & arg & ")"
  var i = s.find(needle, a)
  while i >= 0 and i < b:
    if i == 0 or not (isIdentChar(s[i - 1]) or s[i - 1] == '.'):
      return true
    i = s.find(needle, i + 1)
  false

proc countMainWindowTitleLocks(s, factory: string): int =
  ## Main-window constructions `WIN=FACTORY({` followed (within
  ## PREVENT_CALL_WINDOW) by a call of a page-title-updated preventDefault
  ## helper on WIN.
  var helpers: seq[string]
  for m in s.findAll(PREVENT_HELPER):
    if s[m.group(1)] == s[m.group(2)] and s[m.group(3)] == s[m.group(4)]:
      helpers.add s[m.group(0)]
  if helpers.len == 0:
    return 0
  let ctor = re2(r"(?:^|[^\w$.])([\w$]+)=" & escapeRe(factory) & r"\(\{")
  for m in s.findAll(ctor):
    let win = s[m.group(0)]
    let a = m.boundaries.b
    let b = min(s.len, a + PREVENT_CALL_WINDOW)
    for h in helpers:
      if s.hasCall(h, win, a, b):
        inc result
        break

# function NAME(ARG){return WIN=new ELECTRON.BrowserWindow(ARG),
# WIN may be a dotted property path since v1.19367.0 (`exports.mainWindow`).
# Groups: 0 = NAME, 1 = ARG, 2 = WIN, 3 = ELECTRON, 4 = ARG again (must equal
# group 1).
const FACTORY_PATTERN =
  re2"function ([\w$]+)\(([\w$]+)\)\{return ([\w$]+(?:\.[\w$]+)*)=new ([\w$]+)\.BrowserWindow\(([\w$]+)\),"

proc apply*(input: string): string =
  result = input

  if SENTINEL in result:
    if POPOUT_SENTINEL notin result:
      raise newException(
        ValueError,
        "fix_profile_window_title: main-window hook present but the pop-out hook is missing",
      )
    echo "  [INFO] Window title hook already applied"
    echo "  [PASS] No changes needed (already patched)"
    return

  # Precondition: upstream preventDefaults the main window's
  # page-title-updated. Without it Electron applies page titles natively,
  # bypassing our setTitle wrapper, and the suffix would be lost.
  var factories: seq[string]
  for m in result.findAll(FACTORY_PATTERN):
    if result[m.group(1)] == result[m.group(4)]:
      factories.add result[m.group(0)]
  if factories.len != 1:
    echo &"  [FAIL] main-window BrowserWindow factory: {factories.len} matches, expected 1"
    raise
      newException(ValueError, "fix_profile_window_title: factory not found - re-audit")
  let locks = result.countMainWindowTitleLocks(factories[0])
  if locks != 1:
    echo &"  [FAIL] main-window page-title-updated preventDefault: {locks} matches, expected 1"
    raise newException(
      ValueError, "fix_profile_window_title: title lock not found - re-audit"
    )
  echo "  [OK] upstream locks the main-window title (1 match)"

  var hits = 0
  result = result.replace(
    FACTORY_PATTERN,
    proc(m: RegexMatch2, s: string): string =
      let funcName = s[m.group(0)]
      let argName = s[m.group(1)]
      let winVar = s[m.group(2)]
      let electronVar = s[m.group(3)]
      if argName != s[m.group(4)]:
        # Not the `\2` shape: leave the site untouched (nre would not have
        # matched it at all).
        return s[m.boundaries]
      inc hits
      "function " & funcName & "(" & argName & "){return " & winVar & "=new " &
        electronVar & ".BrowserWindow(" & argName & ")," &
        # Profile-aware title injection. Wrapped in a single short-circuit
        # expression so the comma chain still type-checks; evaluates to
        # `false` (no-op) when CLAUDE_PROFILE is unset.
        #
        # Upstream owns the main-window title (it preventDefaults
        # page-title-updated; up to v4.4212.0 it also called win.setTitle()
        # on navigation). A one-shot setTitle could be overwritten, so we
        # wrap THIS window's setTitle: every title, ours or upstream's, gets
        # the suffix exactly once. Other windows keep their own setTitle.
        "process.env.CLAUDE_PROFILE&&((globalThis." & SENTINEL &
        "=true),((__cdb_w,__cdb_s)=>{" & "const __cdb_o=__cdb_w.setTitle.bind(__cdb_w);" &
        "__cdb_w.setTitle=(__cdb_t)=>{__cdb_t=String(__cdb_t??\"\");" &
        "return __cdb_o(__cdb_t.endsWith(__cdb_s)?__cdb_t:__cdb_t+__cdb_s)};" &
        "__cdb_w.setTitle(__cdb_w.getTitle())})(" & winVar &
        ",\" (\"+process.env.CLAUDE_PROFILE+\")\")," & POPOUT_HOOK &
        "(\" (\"+process.env.CLAUDE_PROFILE+\")\")),",
  )

  if hits == 1:
    echo &"  [OK] Main window title hook injected (function={hits} match)"
  elif hits > 1:
    # Defensive: should be exactly one main-window-construction site. If the
    # pattern starts matching multiple BrowserWindow factories, that's a
    # signal upstream changed shape and we should investigate rather than
    # silently inject into windows that already lock their title.
    echo &"  [FAIL] Expected 1 BrowserWindow construction site, got {hits}"
    raise newException(ValueError, "fix_profile_window_title: ambiguous match")
  else:
    echo "  [FAIL] Main window construction pattern not found"
    raise newException(ValueError, "fix_profile_window_title: 0 matches")

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_profile_window_title <file>"
    quit(1)

  let filePath = paramStr(1)
  echo "=== Patch: fix_profile_window_title ==="
  echo "  Target: " & filePath

  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)

  let input = readFile(filePath)
  let output = apply(input)

  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] Profile window title hook installed"
  # If unchanged, apply() already printed [PASS] for the already-applied case.
