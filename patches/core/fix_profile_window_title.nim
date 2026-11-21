# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Suffix the main window title with the active profile name when CLAUDE_PROFILE
# is set. "Claude" → "Claude (work)" so users can tell windows apart in
# Alt-Tab, taskbar tooltips, and screenshots without relying on icon shape.
#
# How it works:
#   - The main window goes through one factory. Since v6.28899.2 the window
#     is constructed at its single call site and handed in:
#       f=(e=>NAME(new ELECTRON.BrowserWindow(e)))(<options builder>({...}))
#       function NAME(arg){return WIN=arg,TAG(WIN.webContents,X.MAIN_WINDOW),...}
#     (up to v5.11492.5: `function NAME(arg){return WIN=new
#     ELECTRON.BrowserWindow(arg),...}`).
#   - Since v4.16336.0 the main window's OS title is static: it is built with
#     `title:<fn>()` (which returns "Claude"), a helper preventDefaults its
#     page-title-updated, and the conversation title goes to the in-app title
#     bar (dispatchUpdateTitleBar), not to win.setTitle. (v2.19675.1 to
#     v4.4212.0 called win.setTitle(composed) on navigation instead.)
#   - We inject a tiny comma-expression right after the factory's
#     `return WIN=arg,` that, when CLAUDE_PROFILE is set, wraps THIS window's
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
# variable shortly after its construction (see CTOR_PATTERN).
const PREVENT_HELPER =
  re2"""function ([\w$]+)\(([\w$]+)\)\{([\w$]+)\.on\(["`]page-title-updated["`],\(?([\w$]+)\)?=>\{?([\w$]+)\.preventDefault\(\)\}?\)\)\}"""

# How far after the main-window construction the helper call may sit
# (1.7 KB in v4.16336.0, 2.7 KB in v6.28899.2).
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

# Since v6.28899.2 the main window is constructed at its one call site and
# handed to the factory:
#   f=(e=>BEe(new u.BrowserWindow(e)))(kOr({...}))
# Groups: 0 = WIN (the caller's local), 1 = arrow param, 2 = FACTORY,
# 3 = ELECTRON, 4 = arrow param again (must equal group 1).
const CTOR_PATTERN =
  re2"(?:^|[^\w$.])([\w$]+)=\(([\w$]+)=>([\w$]+)\(new ([\w$]+)\.BrowserWindow\(([\w$]+)\)\)\)\("

proc countMainWindowTitleLocks(s, factory: string): int =
  ## Main-window constructions `WIN=(p=>FACTORY(new E.BrowserWindow(p)))(`
  ## followed (within PREVENT_CALL_WINDOW) by a call of a page-title-updated
  ## preventDefault helper on WIN.
  var helpers: seq[string]
  for m in s.findAll(PREVENT_HELPER):
    if s[m.group(1)] == s[m.group(2)] and s[m.group(3)] == s[m.group(4)]:
      helpers.add s[m.group(0)]
  if helpers.len == 0:
    return 0
  for m in s.findAll(CTOR_PATTERN):
    if s[m.group(2)] != factory or s[m.group(1)] != s[m.group(4)]:
      continue
    let win = s[m.group(0)]
    let a = m.boundaries.b
    let b = min(s.len, a + PREVENT_CALL_WINDOW)
    for h in helpers:
      if s.hasCall(h, win, a, b):
        inc result
        break

# The factory (v6.28899.2):
#   function BEe(e){return oo=e,Ar(oo.webContents,kr.MAIN_WINDOW),SEe(oo),oo}
# Groups: 0 = NAME, 1 = ARG, 2 = WIN (a dotted path up to v5: exports.mainWindow),
# 3 = ARG again (must equal group 1). The MAIN_WINDOW tagging call on WIN must
# follow in the factory body (checked in findFactory).
const FACTORY_HEAD =
  re2"function ([\w$]+)\(([\w$]+)\)\{return ([\w$]+(?:\.[\w$]+)*)=([\w$]+),"

# How far after the factory head the MAIN_WINDOW tagging call may sit. Right
# after the head on a pristine bundle; this patch's own injection (about 1.3 KB)
# sits in between on an already patched one.
const TAG_WINDOW = 4000

type Factory = tuple[name, arg, win: string, headEnd: int]

proc findFactories(s: string): seq[Factory] =
  ## Every `function NAME(ARG){return WIN=ARG,` whose body tags WIN as the
  ## MAIN_WINDOW, and that is handed a freshly constructed BrowserWindow at a
  ## `(p=>NAME(new E.BrowserWindow(p)))` call site.
  for m in s.findAll(FACTORY_HEAD):
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
    let tag = re2(
      r"[\w$]+(?:\.[\w$]+)*\(" & escapeRe(win) &
        r"\.webContents,[\w$]+(?:\.[\w$]+)*\.MAIN_WINDOW\)$"
    )
    if not tail[0 .. t + ".MAIN_WINDOW)".len - 1].contains(tag):
      continue
    var ctors = 0
    for c in s.findAll(CTOR_PATTERN):
      if s[c.group(2)] == name and s[c.group(1)] == s[c.group(4)]:
        inc ctors
    if ctors == 1:
      result.add (name, s[m.group(1)], win, a)

proc hookFor(win: string): string =
  ## The exact text injected after the factory's `return WIN=ARG,`.
  "process.env.CLAUDE_PROFILE&&((globalThis." & SENTINEL & "=true),((__cdb_w,__cdb_s)=>{" &
    "const __cdb_o=__cdb_w.setTitle.bind(__cdb_w);" &
    "__cdb_w.setTitle=(__cdb_t)=>{__cdb_t=String(__cdb_t??\"\");" &
    "return __cdb_o(__cdb_t.endsWith(__cdb_s)?__cdb_t:__cdb_t+__cdb_s)};" &
    "__cdb_w.setTitle(__cdb_w.getTitle())})(" & win &
    ",\" (\"+process.env.CLAUDE_PROFILE+\")\")," & POPOUT_HOOK &
    "(\" (\"+process.env.CLAUDE_PROFILE+\")\")),"

proc apply*(input: string): string =
  result = input

  if SENTINEL in result:
    if POPOUT_SENTINEL notin result:
      raise newException(
        ValueError,
        "fix_profile_window_title: main-window hook present but the pop-out hook is missing",
      )
    # Positive end state (AGENTS.md Rule 6): our exact hook, once, right after
    # the main-window factory's `return WIN=ARG,` - not merely the sentinel
    # somewhere in the bundle.
    let done = result.findFactories()
    if done.len != 1 or result.count(SENTINEL) != 1 or
        not result.continuesWith(hookFor(done[0].win), done[0].headEnd):
      echo "  [FAIL] title hook sentinel present but our hook is not in the main-window factory"
      raise newException(
        ValueError,
        "fix_profile_window_title: sentinel found outside the main-window factory - re-audit",
      )
    echo "  [INFO] Window title hook already applied"
    echo "  [PASS] No changes needed (already patched)"
    return

  # Precondition: upstream preventDefaults the main window's
  # page-title-updated. Without it Electron applies page titles natively,
  # bypassing our setTitle wrapper, and the suffix would be lost.
  let factories = result.findFactories()
  if factories.len != 1:
    echo &"  [FAIL] main-window BrowserWindow factory: {factories.len} matches, expected 1"
    raise
      newException(ValueError, "fix_profile_window_title: factory not found - re-audit")
  let f = factories[0]
  let locks = result.countMainWindowTitleLocks(f.name)
  if locks != 1:
    echo &"  [FAIL] main-window page-title-updated preventDefault: {locks} matches, expected 1"
    raise newException(
      ValueError, "fix_profile_window_title: title lock not found - re-audit"
    )
  echo "  [OK] upstream locks the main-window title (1 match)"

  # Profile-aware title injection right after `return WIN=ARG,`. A single
  # short-circuit expression so the comma chain still type-checks; evaluates
  # to `undefined` (no-op) when CLAUDE_PROFILE is unset.
  #
  # Upstream owns the main-window title (it preventDefaults
  # page-title-updated; up to v4.4212.0 it also called win.setTitle() on
  # navigation). A one-shot setTitle could be overwritten, so we wrap THIS
  # window's setTitle: every title, ours or upstream's, gets the suffix
  # exactly once. Other windows keep their own setTitle.
  let hook = hookFor(f.win)
  result = result[0 ..< f.headEnd] & hook & result[f.headEnd .. ^1]
  if result.count(SENTINEL) != 1 or
      result.count("globalThis." & POPOUT_SENTINEL & "=true") != 1:
    echo "  [FAIL] Main window title hook not present exactly once after injection"
    raise newException(ValueError, "fix_profile_window_title: injection check failed")
  echo &"  [OK] Main window title hook injected (factory {f.name}, window {f.win})"

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
