# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Nim port of fix_computer_use_linux.py — produces byte-identical output.
#
# The four JS snippets (regular inline executor, kwin-wayland executor,
# hybrid handler injection, mode preamble) are checked-in plain .js files
# under js/ and shared verbatim with the Python implementation. Nim
# embeds them via staticRead at compile time; Python reads them at runtime.
# No codegen — the .js files are the single source of truth.
#
# All 54 sub-patches use std/nre (PCRE) because many require backreferences.
# "Ask before Computer Use controls an app" (js/cu_consent.js, injected by
# Patch 1 after the executors): sub-patch 6b makes upstream's grants full level
# in the regular executor mode, 6c lets upstream's terminal / file-manager
# warnings classify our canonical app ids by their aliases, and the description
# sub-patches 13a/13b/13b.linux/13e/13f/13g ask globalThis.__cdbCuConsent.text()
# first (empty while the switch is off), with 15b keying the tools list on it.
# Sub-patches 15a-15d add the Linux accessibility tools (issue #306,
# js/cu_ax_tools.js, injected with the executors by Patch 1): upstream's tool
# builder, its tools/list cache key, the teach-mode read-only set and upstream's
# dispatch (kwin mode) each call into that runtime, which answers "nothing" while
# its Settings -> Extra switch is off.
# Sub-patch 4e hooks main's releaseRemoteCuLock IPC (claude.ai's task-end
# event: running->idle, Stop, archive, delete) and hands the id, source and
# the CU lock's current holder to the Linux executor's __cuTaskBoundary.
# Sub-patch 4b hands the new lock holder along with the acquire
# (`__setLockHeld(true, holder)`), and sub-patch 4f exposes upstream's
# remote-session status accessor as globalThis.__cdbRemoteSessionMode (Linux
# only): js/cu_session_check.js (injected by Patch 1 before both executors)
# polls it while a portal session is up for a cloud Cowork holder and ends the
# session when the server reports the turn ended (issue #293).
# Sub-patch 4g rewrites upstream's isBridgeComputerUsePlatform at its
# definition, so device-bridge Computer Use (cloud Cowork, hub chat, Dispatch:
# the tools announce, the call guard, the approval card's app icons) works on a
# Wayland session when js/cu_mode_preamble.js decided a first-party bridge is
# usable (globalThis.__cdbCuWaylandAnnounce, issue #323).
# Sub-patches 16a-16d make upstream's per-app answers follow the active
# backend (js/cu_consent.js): the system-prompt suffix after the tier rules,
# the computerUsePerAppAccess feature, the renderer re-signal when that answer
# changes, and the "Entire screen" pseudo-grant.
# Sub-patch 4h routes the Linux arm of upstream's unhideComputerUseApps (turn-end
# auto-unhide) to the active Linux executor's __unhideApps when it has one, so
# the KWin executor lifts the capture exclusions it set (upstream's own Linux
# unhide only knows windows its own executor hid).
# Sub-patch 17c exposes upstream's "user stopped sharing" abort as
# globalThis.__cdbCuShareEnded, so the executors stop the running turn the
# moment the user clicks Stop sharing (issue #323; js/cu_share_stop.js,
# embedded by Patch 1, watches the portal bridges' stopped-by-user marker).
# Sub-patch 17e exposes upstream's expected-Escape marker as
# globalThis.__cdbCuExpectEscape: the executors call it right before they
# inject a lone Escape, as upstream's own executor wrapper does, so upstream's
# X11 Escape grab (switch "Escape stops Computer Use" off, or its watcher fell
# back to that grab) absorbs the model's Escape instead of stopping the turn.
# The Escape abort itself (17a / 17b / 17d) is the community patch
# add_feature_cu_escape_abort.nim; the executors only call its optional
# globalThis.__cdbCuEscWatch (suspendAround / toolCall / taskEnded).
#
# Idempotency is a MARKER SET (endStateMarkers below): one positive end-state
# pattern per sub-patch, each with its exact expected count. All present =
# already patched (exit 0, no change); none present = apply; anything in
# between = FAIL. After applying, every marker must hit its exact count, so the
# markers double as the patch's post-condition.

import std/[os, strformat, strutils, options]
import std/nre

const LINUX_EXECUTOR_JS = staticRead("../../js/cu_linux_executor.js")
const LINUX_HANDLER_INJECTION_JS = staticRead("../../js/cu_handler_injection.js")
const MODE_PREAMBLE_JS = staticRead("../../js/cu_mode_preamble.js")
const KWIN_EXECUTOR_SOURCE = staticRead("../../js/executor_linux.js")
const AX_TOOLS_JS = staticRead("../../js/cu_ax_tools.js")
const SESSION_CHECK_JS = staticRead("../../js/cu_session_check.js")
const DISPLAY_TARGET_JS = staticRead("../../js/cu_display_target.js")
const CONSENT_JS = staticRead("../../js/cu_consent.js")
const SHARE_STOP_JS = staticRead("../../js/cu_share_stop.js")

# ─── helpers ────────────────────────────────────────────────────────────────

proc replaceFirst(
    content: var string, pattern: Regex, subFn: proc(m: RegexMatch): string
): int =
  ## Replace the first regex match. Returns 1 if replaced, 0 otherwise.
  let maybeMatch = content.find(pattern)
  if maybeMatch.isNone:
    return 0
  let m = maybeMatch.get()
  let bounds = m.matchBounds
  content = content[0 ..< bounds.a] & subFn(m) & content[bounds.b + 1 .. ^1]
  return 1

proc replaceAllRegex(
    content: var string, pattern: Regex, subFn: proc(m: RegexMatch): string
): int =
  ## Replace ALL regex matches. Returns match count.
  var count = 0
  content = content.replace(
    pattern,
    proc(m: RegexMatch): string =
      inc count
      subFn(m),
  )
  return count

proc replaceLiteralFirst(content: var string, needle, sub: string): int =
  ## Replace first literal (non-regex) occurrence. Returns 1 if replaced, 0 otherwise.
  let idx = content.find(needle)
  if idx == -1:
    return 0
  content = content[0 ..< idx] & sub & content[idx + needle.len .. ^1]
  return 1

proc replaceLiteralFirstAny(
    content: var string, needles: openArray[string], sub: string
): int =
  ## Like replaceLiteralFirst, but tries each needle in order and replaces the
  ## first one found. Used for anchors that upstream's minifier re-quotes
  ## between releases (backtick <-> double/single quotes) without changing text.
  for needle in needles:
    if replaceLiteralFirst(content, needle, sub) == 1:
      return 1
  return 0

proc replaceLiteralAll(content: var string, needle, sub: string): int =
  ## Replace all literal occurrences. Returns match count.
  var idx = 0
  while true:
    let found = content.find(needle, idx)
    if found == -1:
      break
    content = content[0 ..< found] & sub & content[found + needle.len .. ^1]
    idx = found + sub.len
    inc result

proc countOccurrences(content, needle: string): int =
  var idx = 0
  while true:
    let found = content.find(needle, idx)
    if found == -1:
      break
    inc result
    idx = found + needle.len

proc findStringMarker(content: string, messages: varargs[string]): int =
  ## Mirrors find_string_marker from the Python source.
  for message in messages:
    for quote in ["\"", "'"]:
      let needle = quote & message & quote
      let idx = content.find(needle)
      if idx != -1:
        return idx
    let idx = content.find(message)
    if idx != -1:
      return idx
  return -1

type FunctionInfo = object
  headerEnd: int
  header: string
  body: string

proc findFunctionBeforeMarker(content: string, markerIndex: int): Option[FunctionInfo] =
  ## Mirrors find_function_before_marker.
  let fnIdx = content.rfind("function ", last = markerIndex - 1)
  if fnIdx == -1:
    return none(FunctionInfo)
  let headerEnd = content.find('{', start = fnIdx, last = markerIndex - 1)
  if headerEnd == -1:
    return none(FunctionInfo)
  return some(
    FunctionInfo(
      headerEnd: headerEnd,
      header: content[fnIdx .. headerEnd],
      body: content[headerEnd + 1 ..< markerIndex],
    )
  )

# ─── kwin-wayland executor transformation ───────────────────────────────────

proc buildKwinLinuxExecutorInjection(): string =
  ## Mirrors build_kwin_linux_executor_injection: transforms ES-module imports
  ## to CommonJS requires, strips `export` keywords, wraps in an IIFE.
  var js = KWIN_EXECUTOR_SOURCE
  js = js.replace(
    "import { execFile as execFileCb, spawnSync } from 'node:child_process'\n",
    "var { execFile: execFileCb, spawnSync } = require(\"node:child_process\");\n",
  )
  js = js.replace(
    "import { execFile as execFileCb } from 'node:child_process'\n",
    "var { execFile: execFileCb } = require(\"node:child_process\");\n",
  )
  js = js.replace(
    "import { screen as electronScreen } from 'electron'\n",
    "var { screen: electronScreen } = require(\"electron\");\n",
  )
  js = js.replace(
    "import { promisify } from 'node:util'\n",
    "var { promisify } = require(\"node:util\");\n",
  )
  # Strip `export ` at the start of any line. Python used re.sub(r"^export\s+", "", ..., flags=re.MULTILINE);
  # std/nre's default mode treats ^/$ as buffer boundaries, so enable multiline via (?m).
  js = js.replace(re"(?m)^export\s+", "")
  result =
    "(function(){\n" & js.strip(leading = false, trailing = true) &
    "\n\nglobalThis.__linuxExecutor = createLinuxExecutor({ hostBundleId: \"com.anthropic.claude\" });\n" &
    # Capture exclusions a crashed or killed previous run left behind (KWin keeps
    # excludeFromCapture until the window closes); lifted once at app start.
    "globalThis.__linuxExecutor.__restoreCaptureExclusions(\"app start\");\n})();\n"

# ─── end-state markers (idempotency + post-condition) ──────────────────────

type EndStateMarker = object
  name: string
  pat: Regex
  expected: int

proc countMatches(content: string, pat: Regex): int =
  for _ in content.findIter(pat):
    inc result

# The orchestrator stages index.js + its chunks as one file, each chunk after a
# `\n/*__CDB_SPLIT__<file name>__*/\n` line. Each part is its own CommonJS
# module at run time.
const CDB_SPLIT = "\n/*__CDB_SPLIT__"

proc partSpan(c: string, at: int): (int, int) =
  ## [start, end) of the staged part containing offset `at`.
  let p = c.rfind(CDB_SPLIT, last = at)
  var e = c.find(CDB_SPLIT, start = at)
  if e == -1:
    e = c.len
  result = ((if p == -1: 0 else: p), e)

proc namedPart(c, fileName: string): string =
  ## The body of the staged part for chunk `fileName`, "" when not staged.
  let head = CDB_SPLIT & fileName & "__*/\n"
  let i = c.find(head)
  if i == -1:
    return ""
  let b = i + head.len
  var e = c.find(CDB_SPLIT, start = b)
  if e == -1:
    e = c.len
  return c[b ..< e]

proc waylandPredicateDefs(content, name: string): int =
  ## How often `name` is defined as upstream's XDG_SESSION_TYPE Wayland check:
  ## `M=()=>{let e=ENV().XDG_SESSION_TYPE;return e?e==="wayland":!!ENV().WAYLAND_DISPLAY}`.
  let nEsc = escapeRe(name)
  let envAcc = """(?:[\w$]+\(\)|process\.env)"""
  let body =
    """\{let ([\w$]+)=""" & envAcc &
    """\.XDG_SESSION_TYPE;return \1\?\1===["'`]wayland["'`]:!!""" & envAcc &
    """\.WAYLAND_DISPLAY\}"""
  countMatches(
    content,
    re("(?:(?<![\\w$.])" & nEsc & "=\\(\\)=>|function " & nEsc & "\\(\\))" & body),
  )

proc exportTarget(part, alias: string): string =
  ## The local an `exports.<alias>` getter of this part returns, "" unless the
  ## getter is defined exactly once.
  let pat = re(
    """Object\.defineProperty\(exports,(["`])""" & escapeRe(alias) &
      """\1,\{enumerable:!0,get:function\(\)\{return ([\w$]+)\}\}\)"""
  )
  var names: seq[string] = @[]
  for m in part.findIter(pat):
    names.add m.captures[1]
  if names.len != 1:
    return ""
  return names[0]

proc requiredChunk(part, ns: string): string =
  ## The chunk file `ns=require("./<file>")` names in this part, "" unless
  ## exactly one such binding.
  let pat = re("(?<![\\w$.])" & escapeRe(ns) & """=require\(["`]\./([^"`]+)["`]\)""")
  var files: seq[string] = @[]
  for m in part.findIter(pat):
    files.add m.captures[0]
  if files.len != 1:
    return ""
  return files[0]

proc bridgeGuardAlias(content: string): string =
  ## The local upstream's device-bridge refusal guard
  ## `if(!<ns>.<alias>())return R("Computer use over the device bridge is not
  ## supported on this platform ...")` calls, resolved through `<ns>=require(...)`
  ## and that chunk's export getter. "" when any step is not exactly one.
  let guardPat =
    re"""if\(!([\w$]+)\.([\w$]+)\(\)\)return [\w$]+\((["'`])Computer use over the device bridge is not supported on this platform"""
  var hits: seq[RegexMatch] = @[]
  for m in content.findIter(guardPat):
    hits.add m
  if hits.len != 1:
    return ""
  let g = hits[0]
  let (ps, pe) = partSpan(content, g.matchBounds.a)
  let file = requiredChunk(content[ps ..< pe], g.captures[0])
  if file == "":
    return ""
  let target = namedPart(content, file)
  if target == "":
    return ""
  return exportTarget(target, g.captures[1])

const CU_PLATFORM_FN_BODY =
  # hasComputerUseExecutor (v2.19675.1+). Upstream added "linux" to its own CU
  # platform Set but drops Wayland sessions whose portal lacks RemoteDesktop v2
  # or Clipboard: `return SET.has(process.platform)&&!(isWayland()&&!portalOk())`.
  """return ([\w$]+)\.has\(process\.platform\)&&!\([\w$]+\(\)&&![\w$]+\(\)\)\}"""

proc cuPlatformSetName(content: string): string =
  ## The Set hasComputerUseExecutor tests, read from the function itself (which
  ## keeps its shape with or without Patch 2's prepended Linux branch). ""
  ## unless the function is found exactly once AND its Set already lists
  ## "linux" (the declaration Patch 2 relies on).
  var names: seq[string] = @[]
  let fnPat = re(
    """function [\w$]+\(\)\{(?:if\(process\.platform==="linux"\)return!0;)?""" &
      CU_PLATFORM_FN_BODY
  )
  for m in content.findIter(fnPat):
    names.add m.captures[0]
  if names.len != 1:
    return ""
  let decl = re(
    "(?<![\\w$.])" & escapeRe(names[0]) &
      """=new Set\(\[(["`])darwin\1,\1win32\1,\1linux\1\]\)"""
  )
  if countMatches(content, decl) != 1:
    return ""
  return names[0]

const CU_X11_ACCESS_SENTENCE =
  # What request_access tells the model on an X11 session (sub-patch 13b.linux):
  # the bridge captures the whole display and input goes to whatever is under
  # it, and the consent card is still the grant the user expects.
  "\"Screenshots capture the whole primary display, not individual apps, and " &
  "clicks and keystrokes go to whatever is under them. Name the apps you intend " &
  "to use in request_access; after the grant a screenshot shows the entire " &
  "display, and open_application brings an app forward. \""

proc endStateMarkers(): seq[EndStateMarker] =
  ## One positive end-state pattern per sub-patch, with its exact count.
  proc lit(name, s: string, expected = 1): EndStateMarker =
    EndStateMarker(name: name, pat: re(escapeRe(s)), expected: expected)

  proc rx(name, s: string, expected = 1): EndStateMarker =
    EndStateMarker(name: name, pat: re(s), expected: expected)

  @[
    rx(
      "1 executors at app ready",
      """app\.on\(["`]ready["`],\(?async\(\)=>\{if\(process\.platform==="linux"\)\{""",
    ),
    rx(
      # js/cu_session_check.js embedded by Patch 1 (#293): its one definition.
      "1 session check embed",
      """globalThis\.__cdbCuSessionCheck\s*=\s*\{""",
    ),
    rx(
      # js/cu_display_target.js embedded by Patch 1: its one definition.
      "1 display target embed",
      """globalThis\.__cdbCuDisplayTarget=\{pick:""",
    ),
    rx(
      # js/cu_consent.js embedded by Patch 1: its one definition.
      "1 consent embed",
      """globalThis\.__cdbCuConsent=\{active:active,""",
    ),
    rx(
      # js/cu_consent.js: the per-app access helper 16b / 16d call.
      "1 shared screen helper",
      """globalThis\.__cdbCuSharedScreen=function\(\)\{""",
    ),
    rx(
      # js/cu_consent.js: the pseudo-grant helper 16d calls.
      "1 screen grant helper",
      """globalThis\.__cdbCuNoScreenGrant=function\(\)\{""",
    ),
    lit(
      "6b full grant level",
      "cuOnlyMode:process.platform===\"linux\"&&!globalThis.__cuKwinMode||process.env.COWORK_CU_ONLY",
    ),
    rx(
      "6c sentinel aliases",
      """\{return ([\w$]+)\(([\w$]+)\)!==null\|\|process\.platform==="linux"&&\(globalThis\.__cdbCuAppIds\?\.aliasesOf\?\.\(\2\)\|\|\[\]\)\.some\(__cdbS=>\1\(__cdbS\)!==null\)\}""",
    ),
    rx(
      "2 CU platform gate",
      "function [\\w$]+\\(\\)\\{if\\(process\\.platform===\"linux\"\\)return!0;" &
        CU_PLATFORM_FN_BODY,
    ),
    lit(
      "2b PLATFORM_CAPABILITIES X11 arm",
      ":process.platform===\"linux\"?{screenshotFiltering:\"none\",platform:\"linux\"}:",
    ),
    rx(
      "4 createDarwinExecutor",
      """\{if\(process\.platform==="linux"&&globalThis\.__linuxExecutor\)return globalThis\.__linuxExecutor;if\(process\.platform!==["`]darwin["`]\)throw""",
    ),
    rx(
      "4d platform executor factory",
      """if\(process\.platform===["`]darwin["`]\)return [\w$]+(?:\.[\w$]+)*\([^;]{1,400}\);if\(process\.platform==="linux"&&globalThis\.__linuxExecutor\)return globalThis\.__linuxExecutor;(?:if\(process\.platform===["`]linux["`]\)return [^;]{1,80};)?throw (?:new )?Error\(["`]computer-use executor not implemented""",
    ),
    rx(
      "4b cu lock acquire",
      """,process\.platform==="linux"&&globalThis\.__linuxExecutor\?\.__setLockHeld\?\.\(!0,[\w$]+\)\.catch\?\.\(""",
    ),
    lit(
      "4b.2 cu lock release",
      ",process.platform===\"linux\"&&globalThis.__linuxExecutor?.__setLockHeld?.(!1).catch?.(",
      2,
    ),
    rx(
      "4e task boundary",
      """releaseRemoteCuLock:\(([\w$]+),([\w$]+)\)=>\{try\{process\.platform==="linux"&&globalThis\.__linuxExecutor\?\.__cuTaskBoundary\?\.\(\1\?\?void 0,\2==="stop_click"\?"stop_click":"renderer",exports\.[\w$]+\.currentHolder\)\?\.catch\?\.\(""",
    ),
    rx(
      "4f session check accessor",
      """refresh:[\w$]+\.refreshRemoteChromeSessionMode\}\}process\.platform==="linux"&&\(globalThis\.__cdbRemoteSessionMode=[\w$]+\);""",
    ),
    rx(
      # The predicate's own definition (isBridgeComputerUsePlatform), so every
      # consumer follows it.
      "4g bridge platform predicate",
      """function [\w$]+\(\)\{return![\w$]+\(\)\|\|process\.platform==="linux"&&globalThis\.__cdbCuWaylandAnnounce===!0\}""",
    ),
    rx(
      "4h unhide routing",
      """if\(process\.platform===["`]linux["`]\)\{if\(typeof globalThis\.__linuxExecutor\?\.__unhideApps==="function"\)\{await globalThis\.__linuxExecutor\.__unhideApps\(([\w$]+)\);return\}let\{unhideComputerUseAppsLinux:([\w$]+)\}=[^{}]{0,300}await \2\(\1\);return\}""",
    ),
    rx(
      "5b screenshot intro note (decl)",
      """,linuxVisibleLastScreenshot=process\.platform==="linux"&&[\w$]+===void 0&&[\w$]+==="screenshot"\?void 0:""",
    ),
    lit("5b screenshot intro note (use)", "lastScreenshot:linuxVisibleLastScreenshot,"),
    rx(
      "6 handleToolCall dispatch",
      """handleToolCall:async\([\w$]+,[\w$]+,[\w$]+,[\w$]+\)=>\{if\(process\.platform==="linux"&&!globalThis\.__cuKwinMode\)\{""",
    ),
    rx(
      "7b teach controller init",
      """\)\{if\(process\.platform==="linux"&&globalThis\.__linuxExecutor\?\.__initTeachController\)\{globalThis\.__linuxExecutor\.__initTeachController\([\w$]+,[\w$]+\);return;\}""",
    ),
    rx(
      "7c side-panel init",
      """\)\{if\(process\.platform==="linux"&&globalThis\.__linuxExecutor\?\.__initDockController\)\{globalThis\.__linuxExecutor\.__initDockController\([\w$]+\);return;\}""",
    ),
    rx(
      "8 teach overlay mouse",
      """\(process\.platform==="linux"\?\([\w$]+\.setIgnoreMouseEvents=function\(\)\{\},globalThis\.__isVM&&[\w$]+\.setOpacity\(\.15\)\):""",
    ),
    rx(
      "9a show handler",
      """function [\w$]+\([\w$]+,[\w$]+\)\{\(process\.platform!=="linux"&&[\w$]+\.setIgnoreMouseEvents\(!0,\{forward:!0\}\)\)""",
    ),
    rx(
      "9b working handler",
      """\(process\.platform!=="linux"&&[\w$]+\.setIgnoreMouseEvents\(!0,\{forward:!0\}\)\),[\w$]+(?:\.[\w$]+)*\.getDispatcher\(""",
    ),
    rx(
      "8a glow overlay",
      """\{if\(process\.platform==="linux"&&globalThis\.__cuKwinMode\)return;[\w$]+(?:\.[\w$]+)*\.on\(["`]cuLockChanged["`],""",
    ),
    lit("10 overlay transparency", "transparent:!globalThis.__isVM"),
    rx(
      "10b overlay display",
      """\{if\(process\.platform==="linux"\)([\w$]+)=null;return \1===null\?""",
    ),
    rx(
      "11 isEnabled gate",
      """function [\w$]+\((?:[\w$]+=\{\})?\)\{if\(process\.platform==="linux"\)return(?: ?!0| globalThis\.__cdbCuHipaa=[\w$]+,![\w$]+\(\));return ?!?(?:[\w$]+(?:\.[\w$]+)*\.has\(process\.platform\)|[\w$]+\(\))(?:\|\|[\w$]+\(\))?\?(?:!1:)?[\w$]+\([\w$]*\)&&[\w$]+(?:\.[\w$]+)*\(["'`]chicagoEnabled["'`]\)(?::!1)?\}""",
    ),
    rx(
      "12 isRegisterable gate",
      """function [\w$]+\((?:[\w$]+=\{\})?\)\{if\(process\.platform==="linux"\)return (?:[\w$]+\([\w$]*\)|!0);return [\w$]+(?:\.[\w$]+)*\(([\w$]+)\)\?(?:![\w$]+\(\)&&)?(?:[\w$]+(?:\.[\w$]+)*\.has\(process\.platform\)|[\w$]+\(\)&&[\w$]+\([\w$]+\))""",
    ),
    rx(
      "13a allowlist gate",
      """(?:=|:\()process\.platform==="linux"\?"":"The frontmost application must be in the session allowlist""",
    ),
    rx(
      "13a.ask input sentence",
      """\(process\.platform==="linux"&&globalThis\.__cdbCuConsent\?\.text\("input"\)\|\|\([\w$]+\.hitTest==="none"\?""",
    ),
    lit(
      "13b request_access prefix",
      "(process.platform===\"linux\"?(globalThis.__cuKwinMode?`This computer is running Linux with KDE Plasma. The file manager is \"Dolphin\". `",
    ),
    lit("13b.linux request_access X11 sentence", CU_X11_ACCESS_SENTENCE),
    lit(
      "13b.ask request_access prefix",
      ":(globalThis.__cdbCuConsent?.text(\"prefix\")||`This computer is running Linux. ",
    ),
    lit(
      "13b.linux.ask request_access sentence",
      "(globalThis.__cdbCuConsent?.text(\"access\")||(globalThis.__cuKwinMode||process.env.XDG_SESSION_TYPE===\"wayland\"?",
    ),
    rx(
      "13b.kwin-alias",
      """[\w$]+=globalThis\.__cuKwinMode\?[\w$]+\.map\(v=>v==="org\.kde\.plasmashell"\?"plasmashell":v\):[\w$]+,""",
    ),
    rx(
      "13b.kwin-alias-teach",
      """\(globalThis\.__cuKwinMode\?[\w$]+\.map\(v=>v==="org\.kde\.plasmashell"\?"plasmashell":v\):[\w$]+\)""",
    ),
    lit(
      "13b.kwin-shell-hint",
      "(globalThis.__cuKwinMode?`The desktop shell is frontmost. Desktop icons, panels, launchers, and widgets belong to Plasma Shell.",
    ),
    rx(
      "13b.kwin-shell-grant",
      """\):globalThis\.__cuKwinMode&&[\w$]+==="linux"\?[\w$]+\.find\(""",
    ),
    rx(
      "13b.kwin-shell-detect",
      """\|\|globalThis\.__cuKwinMode&&\(([\w$]+)==="plasmashell"\|\|\1==="org\.kde\.plasmashell"\)\)return!0;""",
    ),
    lit(
      "13c request_access apps",
      "`Application names as shown in window titles, or WM_CLASS values ",
    ),
    lit(
      "13d open_application app",
      "`Application name or WM_CLASS (e.g. \"firefox\", \"nautilus\").`",
    ),
    lit(
      "13e open_application allowlist",
      "(globalThis.__cdbCuConsent?.text(\"openApp\")||\"On Linux, all applications are directly accessible.\")",
    ),
    lit(
      "13f screenshot description",
      "(globalThis.__cdbCuConsent?.text(\"screenshot\")||\"Take a screenshot of the primary display. All open windows are visible.\")",
    ),
    lit(
      "13g screenshot suffix",
      "(process.platform===\"linux\"?(globalThis.__cdbCuConsent?.text(\"shotSuffix\")||\" The returned image is what subsequent click coordinates are relative to.\")",
    ),
    lit(
      "14a same filesystem",
      "${process.platform===\"linux\"?(globalThis.__cuKwinMode?\"**Same filesystem.**",
      2,
    ),
    lit(
      "14b app names",
      "\"the file manager, image viewer, terminal emulator, system settings\"",
    ),
    lit(
      "14c file manager name",
      "process.platform===\"linux\"?(globalThis.__cuKwinMode?\"Dolphin\":\"Files\"):\"Finder\"",
      2,
    ),
    lit(
      "14d env prompt",
      "${globalThis.__cuKwinMode?' This computer is running Linux with KDE Plasma. The desktop shell is plasmashell.",
      2,
    ),
    lit("1b accessibility tools runtime", "globalThis.__cdbAxTools=function(t){"),
    rx(
      "15a tool builder",
      """\.\.\.\(process\.platform==="linux"&&globalThis\.__cdbAxTools\?\.\([\w$]+\)\|\|\[\]\)\]\}""",
    ),
    rx(
      "15b tools/list cache key",
      """\$\{process\.platform==="linux"&&\(globalThis\.__cdbAxKey\?\.\(\)\|\|""\)\+\(globalThis\.__cdbCuConsent\?\.key\?\.\(\)\|\|""\)\|\|""\}`;""",
    ),
    rx(
      "15c read-only tools",
      """return!\([\w$]+\.has\(([\w$]+)\)\|\|process\.platform==="linux"&&\(\1==="app_ax_find"\|\|\1==="app_list_windows"\)\)\}""",
    ),
    rx(
      "15d.1 dispatch session id",
      """,__cdbAxSid:process\.platform==="linux"\?[\w$]+\.sessionId:void 0\}""",
    ),
    rx(
      "15d.2 dispatch",
      """\{if\(process\.platform==="linux"&&globalThis\.__cdbAxHandles\?\.\([\w$]+\)\)return await globalThis\.__cdbAxCall\([\w$]+,[\w$]+,\{sid:[\w$]+\.__cdbAxSid,ctx:[\w$]+,tier:\(__cdbA,__cdbT\)=>[\w$]+\([\w$]+,__cdbA,__cdbT\)\}\);let [\w$]+=[\w$]+\.executor\.appScoped;""",
    ),
    rx(
      "16a prompt suffix",
      """function [\w$]+\(\)\{if\(process\.platform==="linux"\)\{let __cdbSpx;try\{__cdbSpx=globalThis\.__cdbCuConsent\?\.spSuffix\?\.\(\)\}catch\(__cdbSpe\)\{\}if\(typeof __cdbSpx==="string"\)return __cdbSpx\}return [\w$]+\.[\w$]+\(\)\?[`"]\\n\\nOn this system \(a Linux Wayland session\)""",
    ),
    rx(
      "16b per-app access",
      """computerUsePerAppAccess:\(process\.platform==="linux"&&typeof globalThis\.__cdbCuSharedScreen==="function"\?globalThis\.__cdbCuSharedScreen\(\):[\w$]+\(\)\)\?\{status:"unsupported",reason:"A Wayland session shares the whole screen""",
    ),
    rx(
      "16c features broadcast",
      """function ([\w$]+)\(\)\{for\(let ([\w$]+) of [\w$]+\)\2\(\)\}process\.platform==="linux"&&\(globalThis\.__cdbCuFeaturesChanged=\1\);""",
    ),
    rx(
      # js/cu_share_stop.js embedded by Patch 1: its one definition.
      "1 stop-sharing embed",
      """globalThis\.__cdbCuShareStop=Object\.freeze\(""",
    ),
    rx(
      # The runtime global's defining assignment, after upstream's function.
      "17e expected-Escape marker",
      """function [\w$]+\(\)\{[\w$]+\+\+,setTimeout\(\(?\(\)=>\{[\w$]+>0&&[\w$]+--\}\)?,100\)\}process\.platform==="linux"&&\(globalThis\.__cdbCuExpectEscape=[\w$]+\);""",
    ),
    rx(
      # The runtime global's defining assignment, after upstream's function.
      "17c share-ended abort",
      """\}process\.platform==="linux"&&\(globalThis\.__cdbCuShareEnded=[\w$]+\);""",
    ),
    rx(
      "16e enable card screenshot filtering",
      """screenshotFiltering:\(process\.platform==="linux"&&globalThis\.__cdbCuSharedScreen\?\.\(\)===!1\?globalThis\.__linuxExecutor\?\.capabilities\?\.screenshotFiltering\?\?"mask":[\w$]+\.[\w$]+\.screenshotFiltering\),(?:hostPlatform:[\w$]+\.[\w$]+\.platform,)?featureDisabled:!0""",
      2,
    ),
    rx("7d teach gate", """/\*__cdbTeachKwin\*/"""),
    rx(
      "16d screen pseudo-grant",
      """\{if\(process\.platform==="linux"&&globalThis\.__cdbCuNoScreenGrant\?\.\(\)===!0\|\|[\w$]+\.[\w$]+!==[\w$]+\.[\w$]+\|\|""",
    ),
  ]

# ─── main patch ─────────────────────────────────────────────────────────────

proc apply*(input: string): string =
  var content = input
  let original = input
  var patchesApplied = 0
  var changes = 0
  const EXPECTED_PATCHES = 54

  let gateSet = cuPlatformSetName(content)
  if gateSet == "":
    raise newException(
      ValueError,
      "  [FAIL] CU platform gate (`return SET.has(process.platform)&&!(wayland()&&!portal())`, SET with linux) not found exactly once - re-audit",
    )
  let markers = endStateMarkers()
  var present: seq[string] = @[]
  var absent: seq[string] = @[]
  for mk in markers:
    let n = countMatches(content, mk.pat)
    if n == mk.expected:
      present.add mk.name
    elif n == 0:
      absent.add mk.name
    else:
      raise newException(
        ValueError,
        &"  [FAIL] end-state marker '{mk.name}': {n} matches, expected 0 or {mk.expected} - re-audit",
      )
  if absent.len == 0:
    echo &"  [OK] all {markers.len} end-state markers already present (idempotent, no change)"
    return content
  if present.len > 0:
    raise newException(
      ValueError,
      &"  [FAIL] half-patched input: {present.len}/{markers.len} end states present, missing: {absent.join(\", \")} - use a fresh extract and re-audit",
    )

  # ── Patch 1: inject executors + mode preamble at app.on("ready") ───────
  block:
    let regularJs = LINUX_EXECUTOR_JS.strip()
    let kwinJs = buildKwinLinuxExecutorInjection().strip()
    # The accessibility tools runtime (issue #306) goes after the executors: it
    # hooks the executor's lock/task-boundary methods and asks it for its bridge.
    let axJs = AX_TOOLS_JS.strip()
    # The cloud-session check (issue #293) goes before both executors: each calls
    # globalThis.__cdbCuSessionCheck at run time. The newline only keeps the
    # embed and the executor code that follows on separate lines/statements.
    let sessionJs = SESSION_CHECK_JS.strip()
    # The display auto-target helper (which monitor holds the granted apps'
    # windows) also goes before both executors: each calls
    # globalThis.__cdbCuDisplayTarget from resolvePrepareCapture and
    # findWindowDisplays at run time.
    let displayTargetJs = DISPLAY_TARGET_JS.strip()
    # The consent module ("Ask before Computer Use controls an app") goes last:
    # it reads the executor and the app-id helper only at call time.
    let consentJs = CONSENT_JS.strip()
    # The Stop-sharing marker watch goes before both executors with the
    # session check: each calls globalThis.__cdbCuShareStop at run time.
    let shareStopJs = SHARE_STOP_JS.strip()
    # v1.26832.0 switched minifier: most string literals became backtick
    # template literals (app.on(`ready`)). Accept either quote style here and
    # everywhere else a literal is part of an anchor.
    # v1.32352.1: the minifier now parenthesises function expressions passed as
    # call arguments - `app.on(`ready`,(async()=>{...}))`. Allow the optional
    # `(` before the arrow; we only insert after `{`, so the extra closing paren
    # stays upstream's own.
    let pat = re"""(app\.on\(["`]ready["`],\(?async\(\)=>\{)"""
    let n = replaceFirst(
      content,
      pat,
      proc(m: RegexMatch): string =
        m.captures[0] & "if(process.platform===\"linux\"){" & MODE_PREAMBLE_JS &
          sessionJs & "\n" & shareStopJs & "\n" & displayTargetJs & "\n" &
          "if(globalThis.__cuKwinMode){" & kwinJs & "}else{" & regularJs & "}" & axJs &
          "\n" & consentJs & "}",
    )
    if n >= 1:
      echo &"  [OK] Linux executor: injected session check + regular + kwin-wayland variants ({n} match)"
      inc changes, n
      inc patchesApplied
    else:
      echo "  [FAIL] app.on(\"ready\") pattern: 0 matches"
      raise newException(ValueError, "  [FAIL] app.on(\"ready\") pattern: 0 matches")

  # ── Patch 2: CU platform gate → true on Linux ──────────────────────────
  block:
    # v2.19675.1 ships native Linux CU and put "linux" in its own platform Set,
    # but hasComputerUseExecutor() still returns false on a Wayland session whose
    # portal lacks RemoteDesktop v2 or Clipboard (wlroots, GNOME < 46, older
    # Plasma). Every CU consumer (host adapter, isEnabled, opt-out, status) goes
    # through it, and our bridges cover those sessions, so Linux is always a CU
    # platform - the same end state the old "add linux to the Set" patch had.
    let pat = re("(function [\\w$]+\\(\\)\\{)(" & CU_PLATFORM_FN_BODY & ")")
    let n = replaceFirst(
      content,
      pat,
      proc(m: RegexMatch): string =
        m.captures[0] & "if(process.platform===\"linux\")return!0;" & m.captures[1],
    )
    if n != 1:
      raise newException(
        ValueError, &"  [FAIL] CU platform gate ({gateSet}): {n} matches, expected 1"
      )
    echo &"  [OK] CU platform gate ({gateSet}): Linux always supported (1 match)"
    inc changes
    inc patchesApplied

  # ── Patch 2b: PLATFORM_CAPABILITIES X11 arm → none-filtering preset ───
  block:
    # v3.1623.0 (same shape in v2.42304.2): the `computer-use` session MCP
    # server and the Cowork chat's remote-devices computer_* tools both build
    # their tool definitions from the STATIC preset
    #   PLATFORM_CAPABILITIES = isWayland() ? LINUX_WAYLAND : LINUX
    # and never from the live executor's capabilities. LINUX is
    # {screenshotFiltering:"native"}, so on X11 the model read upstream's
    # "The image is composed from the granted apps' windows only ... blank"
    # screenshot text, refused to screenshot on its own, and sub-patch 13f
    # (the "none" arm) never engaged. Route the X11 arm to a none-filtering
    # preset instead. No `hitTest` key on purpose: the input gate keeps its
    # "frontmost" arm (the one 13a blanks on Linux) and the hitTest-keyed
    # dialog-focus refusals stay off. Upstream's own X11 executor spreads
    # LINUX into its capabilities, so LINUX itself is left untouched.
    let pat =
      re"""(?<![\w$.])([\w$]+)=([\w$]+)\(\)\?([\w$]+):([\w$]+),([\w$]+)=!\2\(\),"""
    var found = 0
    var waylandPreset, nativePreset = ""
    for m in content.findIter(pat):
      inc found
      waylandPreset = m.captures[2]
      nativePreset = m.captures[3]
    if found != 1:
      raise newException(
        ValueError,
        &"  [FAIL] 2b PLATFORM_CAPABILITIES preset (`X=isWayland()?A:B,Y=!isWayland(),`): {found} matches, expected 1",
      )
    let nativeDecl = re(
      "(?<![\\w$.])" & escapeRe(nativePreset) &
        """=\{screenshotFiltering:"native",platform:"linux"\}"""
    )
    let noneDecl = re(
      "(?<![\\w$.])" & escapeRe(waylandPreset) &
        """=\{screenshotFiltering:"none",platform:"linux",hitTest:"none"\}"""
    )
    let nNative = countMatches(content, nativeDecl)
    let nNone = countMatches(content, noneDecl)
    if nNative != 1 or nNone != 1:
      raise newException(
        ValueError,
        &"  [FAIL] 2b PLATFORM_CAPABILITIES preset: {nativePreset} native decl {nNative} match(es), {waylandPreset} wayland decl {nNone} match(es), expected 1 each - re-audit",
      )
    let n = replaceFirst(
      content,
      pat,
      proc(m: RegexMatch): string =
        let c = m.captures
        &"{c[0]}={c[1]}()?{c[2]}:process.platform===\"linux\"?" &
          "{screenshotFiltering:\"none\",platform:\"linux\"}" &
          &":{c[3]},{c[4]}=!{c[1]}(),",
    )
    if n != 1:
      raise newException(
        ValueError,
        &"  [FAIL] 2b PLATFORM_CAPABILITIES preset: {n} rewrites, expected 1",
      )
    echo &"  [OK] 2b PLATFORM_CAPABILITIES ({waylandPreset}/{nativePreset}): X11 uses the none-filtering preset (1 match)"
    inc changes
    inc patchesApplied

  # ── Patch 4: createDarwinExecutor Linux fallback ───────────────────────
  block:
    # v1.26832.0: `throw new Error(` became `throw Error(`, and "darwin" is a
    # backtick literal. Capture the whole throw-guard verbatim and re-emit it so
    # neither variation has to be reproduced by hand.
    let pat =
      re"""(function [\w$]+\([\w$]+\)\{)(if\(process\.platform!==["`]darwin["`]\)throw (?:new )?Error)"""
    let n = replaceFirst(
      content,
      pat,
      proc(m: RegexMatch): string =
        m.captures[0] &
          "if(process.platform===\"linux\"&&globalThis.__linuxExecutor)return globalThis.__linuxExecutor;" &
          m.captures[1],
    )
    if n >= 1:
      echo &"  [OK] createDarwinExecutor: Linux fallback ({n} match)"
      inc changes, n
      inc patchesApplied
    else:
      echo "  [FAIL] createDarwinExecutor pattern: 0 matches"
      raise newException(ValueError, "  [FAIL] createDarwinExecutor pattern: 0 matches")

  # ── Patch 4d: platform executor factory (Cowork/agent path) ────────────
  # As of v1.15200 upstream split the executor factory in two. Patch 4 above
  # handles `createDarwinExecutor` (leading `!=="darwin"` throw). This SECOND
  # factory — `{const{...,hostBundleId:Z()};if(win32)return ...;if(darwin)return
  # ...;throw "computer-use executor not implemented for ${platform}"}` — is the
  # one the Cowork/agent computer-use path actually calls, and it has no linux
  # branch, so on Linux it fell straight to the throw (issue #159). Inject the
  # linux branch immediately before the throw, after the darwin branch.
  block:
    # v1.26832.0: the win32/darwin arms became namespace-object method calls
    # (`s.r(),s.t(t)` / `o.t(t)`), platform literals are backticks, and the throw
    # dropped `new`. Allow dotted callees and either quote style.
    # (Its end-state marker is pinned to the darwin-arm + throw pair, so Patch
    # 4's identical injection in createDarwinExecutor cannot satisfy it.)
    # Anchor on the darwin-return immediately before the throw (unique: exactly
    # one `darwin)return X(Y);throw "...executor not implemented"` site). Insert
    # the linux branch between the darwin branch and the throw. Param/fn vars
    # are minified - keep them as captured wildcards.
    # v2.19675.1 added upstream's own linux arm between the two
    # (`if(linux)return init(),isWayland()?portalExec(t):x11Exec(t);`). Ours
    # goes in front of it, so our bridges keep driving Linux CU and upstream's
    # native executor stays the fallback when no bridge executor was installed.
    # 4.23118.0: the darwin arm's argument became an object literal
    # (`t.Fm({...a,aimPhantomCursor:(e,n,r)=>...,placePhantomCursor:t.ur})`),
    # so the argument is `[^;]{1,400}` (no `;` inside; the throw string pins
    # the site), not a bare identifier.
    # NB: the throw interpolates `${process.platform}` - the placeholder body
    # contains a `.`, so it is `[\w$.]+` (NOT `[\w$]+`, which stops at the dot
    # and never reaches the closing `}` - a silent 0-match trap).
    let pat =
      re"""(if\(process\.platform===["`]darwin["`]\)return [\w$]+(?:\.[\w$]+)*\([^;]{1,400}\);)((?:if\(process\.platform===["`]linux["`]\)return [^;]{1,80};)?throw (?:new )?Error\(`computer-use executor not implemented for \$\{[\w$.]+\}`\))"""
    let n = replaceFirst(
      content,
      pat,
      proc(m: RegexMatch): string =
        m.captures[0] &
          "if(process.platform===\"linux\"&&globalThis.__linuxExecutor)return globalThis.__linuxExecutor;" &
          m.captures[1],
    )
    if n == 1:
      echo &"  [OK] platform executor factory: Linux branch before throw ({n} match)"
      inc changes, n
      inc patchesApplied
    elif n > 1:
      echo &"  [FAIL] platform executor factory: {n} matches (expected 1) - anchor too broad"
      raise newException(
        ValueError,
        &"  [FAIL] platform executor factory: {n} matches (expected 1) - anchor too broad",
      )
    else:
      echo "  [FAIL] platform executor factory: 0 matches (issue #159 throw-site anchor) - re-audit"
      raise newException(
        ValueError,
        "  [FAIL] platform executor factory: 0 matches (issue #159 throw-site anchor) - re-audit",
      )

  # ── Patch 4b (kwin-wayland): cu lock acquire → __setLockHeld(true, holder) ──
  # v1.20186.1 refactored the lock class: `this.holder` became
  # `this.exclusiveHolder`, and acquire() changed from a `this.holder===void
  # 0&&(this.holder=X,emit(...),cb())` guarded expression into an early-return
  # guard shape ending in `return this.exclusiveHolder=X,emit(...),cb(),!0`.
  # The cuLockChanged emit is unchanged; anchor the acquire-side emit and inject
  # __setLockHeld(true) right before it.
  # 4.4212.0 (#293): also pass the holder just assigned (the captured right-hand
  # side of `this.exclusiveHolder=`, `e` in 4.4212.0), so the executor knows the
  # cloud session id it may poll for the turn end (js/cu_session_check.js).
  block:
    # v1.26832.0: the trailing callback became a method call (`e.nn()`) and the
    # event name a backtick literal. Capture the whole emit-and-callback tail and
    # re-emit it verbatim instead of reconstructing it.
    # v4.29.0 added a take counter between the assignment and the emit:
    # `return this.exclusiveHolder=e,this.exclusiveTakes++,this.emit(...)`.
    # Allow (and keep verbatim) zero or more `this.<field>++,` steps there.
    let pat =
      re"""(return this\.exclusiveHolder=([\w$]+),(?:this\.[\w$]+\+\+,)*)(this\.emit\(["`]cuLockChanged["`],\{holder:\2\}\),[\w$]+(?:\.[\w$]+)*\(\),!0)"""
    let hits = countMatches(content, pat)
    var n = 0
    if hits == 1:
      n = replaceFirst(
        content,
        pat,
        proc(m: RegexMatch): string =
          m.captures[0] &
            "process.platform===\"linux\"&&globalThis.__linuxExecutor?.__setLockHeld?.(!0," &
            m.captures[1] &
            ").catch?.(e=>(globalThis.__cdbDiag||console.warn)(\"[linux-executor] failed to start bridge session on lock acquire\",e))," &
            m.captures[2],
      )
    if n == 1:
      echo &"  [OK] 4b cu lock acquire: start bridge session on Linux, hand over the holder ({n} match)"
      inc changes, n
      inc patchesApplied
    else:
      echo &"  [FAIL] 4b cu lock acquire pattern: {hits} matches, expected 1"

  # ── Patch 4b.2: cu lock release → __setLockHeld(false) ─────────────────
  # v1.20186.1: `this.holder` → `this.exclusiveHolder` (see Patch 4b).
  # v1.26832.0 split the release path in two — `releaseExclusive(x)` (display
  # lock only) and `release(x)` (also drops the app lock) — each with its own
  # copy of the clear-and-emit expression. BOTH are genuine "the exclusive CU
  # lock was dropped" sites, so hook every occurrence rather than only the first;
  # __setLockHeld(!1) is idempotent, so a session released through both paths is
  # still correct.
  block:
    let pat =
      re"""(this\.exclusiveHolder===([\w$]+)&&\(this\.exclusiveHolder=void 0,)(this\.emit\(["`]cuLockChanged["`],\{holder:void 0\}\)\))"""
    let n = replaceAllRegex(
      content,
      pat,
      proc(m: RegexMatch): string =
        m.captures[0] &
          "process.platform===\"linux\"&&globalThis.__linuxExecutor?.__setLockHeld?.(!1).catch?.(e=>(globalThis.__cdbDiag||console.warn)(\"[linux-executor] failed to stop bridge session on lock release\",e))," &
          m.captures[2],
    )
    if n == 2:
      echo &"  [OK] cu lock release: stop bridge session on Linux ({n} matches)"
      inc changes, n
      inc patchesApplied
    else:
      echo &"  [FAIL] cu lock release pattern: {n} matches, expected 2 (releaseExclusive + release)"

  # ── Patch 4e: renderer task boundary → __cuTaskBoundary(id, source, holder) ──
  # claude.ai calls main's `releaseRemoteCuLock(id, source)` IPC on a cloud
  # session's running->idle edge, on Stop ("stop_click"), archive and delete
  # (3.6556.2: `releaseRemoteCuLock:(e,t)=>{pBi(e??void 0,t==="stop_click"?
  # "stop_click":"renderer")}`). Upstream ignores it when the id differs from the
  # lock holder byte for byte, although one session has two ids (session_X /
  # cse_X). Before upstream's call we hand the same id and source, plus the
  # lock's current holder, to the Linux executor, which ends its portal session
  # when the id and holder name the same session. Call only: the return value is
  # unused, a throw or a rejected promise is logged and swallowed, upstream's
  # call still runs, and off Linux nothing is evaluated.
  #
  # The holder is read through the lock module's own export getter
  # (`exports.<key>` -> `get:function(){return <lock>}`), found in the SAME chunk
  # part as the handler: each chunk is its own CommonJS module at run time, and
  # a mangled local can never be named `exports`, so the reference cannot be
  # shadowed at the handler site. The lock is the `<name>=new class extends
  # ...{...get currentHolder(){return this.exclusiveHolder}` instance that
  # Patches 4b/4b.2 hook (3.6556.2: `aJ`, exported as `ZC`).
  block:
    let handlerPat =
      re"""(releaseRemoteCuLock:\(([\w$]+),([\w$]+)\)=>\{)([\w$]+\(\2\?\?void 0,\3===(["`])stop_click\5\?\5stop_click\5:\5renderer\5\)\})"""
    let handlerHits = countMatches(content, handlerPat)
    if handlerHits != 1:
      echo &"  [FAIL] 4e releaseRemoteCuLock handler: {handlerHits} matches, expected 1"
    else:
      let hm = content.find(handlerPat).get()
      let at = hm.matchBounds.a
      # The chunk part the handler lives in (the whole file when not staged).
      const SPLIT = "\n/*__CDB_SPLIT__"
      let prevSplit = content.rfind(SPLIT, last = at)
      let partStart = (if prevSplit == -1: 0 else: prevSplit)
      var partEnd = content.find(SPLIT, start = at)
      if partEnd == -1:
        partEnd = content.len
      let part = content[partStart ..< partEnd]
      # A class instance whose body (up to the next `=new class `) has the
      # holder getter. Two steps, not one tempered regex: a lazy scan over a
      # multi-MB line exhausts PCRE's JIT stack.
      let lockPat = re"""(?<![\w$.])([\w$]+)=new class extends [\w$]+(?:\.[\w$]+)*\{"""
      const HOLDER_GETTER = "get currentHolder(){return this.exclusiveHolder}"
      var lockNames: seq[string] = @[]
      for m in part.findIter(lockPat):
        let bodyStart = m.matchBounds.b + 1
        var bodyEnd = part.find("=new class ", start = bodyStart)
        if bodyEnd == -1:
          bodyEnd = part.len
        let getterAt = part.find(HOLDER_GETTER, start = bodyStart)
        if getterAt != -1 and getterAt < bodyEnd:
          lockNames.add m.captures[0]
      if lockNames.len != 1:
        echo &"  [FAIL] 4e CU lock instance in the handler's chunk: {lockNames.len} matches, expected 1"
      else:
        let lockName = lockNames[0]
        let exportPat = re(
          """Object\.defineProperty\(exports,(["`])([A-Za-z_$][\w$]*)\1,\{enumerable:!0,get:function\(\)\{return """ &
            escapeRe(lockName) & """\}\}\)"""
        )
        var exportKeys: seq[string] = @[]
        for m in part.findIter(exportPat):
          exportKeys.add m.captures[1]
        if exportKeys.len != 1:
          echo &"  [FAIL] 4e export getter for lock '{lockName}': {exportKeys.len} matches, expected 1"
        else:
          let exportKey = exportKeys[0]
          let n = replaceFirst(
            content,
            handlerPat,
            proc(m: RegexMatch): string =
              let idParam = m.captures[1]
              let srcParam = m.captures[2]
              m.captures[0] & "try{process.platform===\"linux\"&&" &
                "globalThis.__linuxExecutor?.__cuTaskBoundary?.(" & idParam & "??void 0," &
                srcParam & "===\"stop_click\"?\"stop_click\":\"renderer\",exports." &
                exportKey &
                ".currentHolder)?.catch?.(r=>(globalThis.__cdbDiag||console.warn)(\"[linux-executor] task boundary hook failed\",r))" &
                "}catch(r){(globalThis.__cdbDiag||console.warn)(\"[linux-executor] task boundary hook failed\",r)}" &
                m.captures[3],
          )
          if n == 1:
            echo &"  [OK] 4e task boundary: releaseRemoteCuLock hands id, source and holder (exports.{exportKey} = {lockName}) to the Linux executor (1 match)"
            inc changes, n
            inc patchesApplied
          else:
            echo "  [FAIL] 4e releaseRemoteCuLock handler: replacement did not apply"

  # ── Patch 4f: session check accessor → globalThis.__cdbRemoteSessionMode ──
  # Upstream main reaches its remote-session status check through a lazy
  # accessor (4.4212.0: `ner` in index.chunk-CvhJZ02X.js):
  #   async function ner(){if(AB!==void 0)return AB;let e=await Promise.resolve()
  #   .then((()=>require("./index.chunk-CL5khZ71.js"))).then((e=>e.t));
  #   return{resolve:e.resolveRemoteChromeSessionMode,
  #   refresh:e.refreshRemoteChromeSessionMode}}
  # We assign it, on Linux only, to globalThis.__cdbRemoteSessionMode right after
  # its declaration; js/cu_session_check.js calls `(await it()).refresh(id)` while
  # a portal session is up for a cloud Cowork holder (#293). No call of ours runs
  # here, so nothing changes until the poller asks; off Linux nothing is assigned.
  #
  # refreshRemoteChromeSessionMode(id) (4.4212.0: `Xt` -> `Y` in
  # index.chunk-CL5khZ71.js) GETs `/v1/code/sessions/<id>` (cookie auth, 5 s
  # timeout, one retry on a transient result) and resolves to exactly one of:
  #   HTTP 5xx/429/408, network error, timeout -> {ok:!1,transient:!0}
  #   HTTP 404, or a body without a session    -> {ok:!1,notFound:!0}
  #   any other non-2xx status                 -> {ok:!1}
  #   success -> {ok:!0,mode,scheduledFire,triggerId,ended,coworkRemote,
  #     projectThread,[codeCloud,browserHost],[deviceBound,boundDeviceId],
  #     conversationUuid,terminal,unconfirmedChat,presentedChat,presentedPending,
  #     hubChat,chatTabGroupKey,title}
  # where `ended` is `o.status==="archived"||o.status==="failed"||
  # o.worker_status==="idle"||o.worker_status==="running"&&
  # o.connection_status==="disconnected"`. A non-ok, non-transient result is
  # cached for 30 s and refresh() hands the cached failure back until then; an
  # ok result is dropped from the cache and fetched again.
  #
  # Anchor: the function whose brace-free body ends in the
  # `return{resolve:X.resolveRemoteChromeSessionMode,refresh:X.refreshRemoteChromeSessionMode}}`
  # pair (the export names are the stable part), exactly once, with a require()
  # of the module in that body. The `(?<=[;}])` lookbehind keeps it a statement-
  # level declaration (4.4212.0: `var AB;async function ner(){...`), so the
  # injected statement never lands in expression position.
  block:
    let pat =
      re"""(?<=[;}])(async function ([\w$]+)\(\)\{([^{}]{0,400})return\{resolve:([\w$]+)\.resolveRemoteChromeSessionMode,refresh:\4\.refreshRemoteChromeSessionMode\}\})"""
    let hits = countMatches(content, pat)
    if hits != 1:
      echo &"  [FAIL] 4f session check accessor: {hits} matches, expected 1"
    else:
      let m0 = content.find(pat).get()
      let fnName = m0.captures[1]
      if "require(" notin m0.captures[2]:
        echo &"  [FAIL] 4f session check accessor {fnName}: body does not require() the session module - re-audit"
      else:
        let n = replaceFirst(
          content,
          pat,
          proc(m: RegexMatch): string =
            m.captures[0] &
              "process.platform===\"linux\"&&(globalThis.__cdbRemoteSessionMode=" &
              m.captures[1] & ");",
        )
        if n == 1:
          echo &"  [OK] 4f session check accessor: {fnName} exposed as globalThis.__cdbRemoteSessionMode on Linux (1 match)"
          inc changes, n
          inc patchesApplied
        else:
          echo "  [FAIL] 4f session check accessor: replacement did not apply"

  # ── Patch 4g: isBridgeComputerUsePlatform passes on a usable Wayland bridge ──
  # Upstream's device-bridge Computer Use (cloud Cowork, hub chat, Dispatch)
  # goes through one predicate (4.23118.1: `U2r`, namespace key
  # isBridgeComputerUsePlatform, export alias `EF`, in index.chunk-k6x_9PBk.js):
  #   function U2r(){return!WO()}
  #   var WO=()=>{let e=UO().XDG_SESSION_TYPE;return e?e==="wayland":
  #     !!UO().WAYLAND_DISPLAY}
  # It has three consumers, all wrong for our bridges on Wayland (issue #323):
  #   - the remote-tools announce gate (`E4r`: `return Nb()||!U2r()||
  #     !X("4293378213")?!1:...`, callers: the device bridge build,
  #     cu_gate_reconcile, cu_preference_change) - every computer_* tool was
  #     left out of the announce;
  #   - the device-bridge call guard in the lazy chunk (`if(!e.EF())return R(
  #     "Computer use over the device bridge is not supported on this platform
  #     (on Linux it needs an Xorg session; ...")`) - every call was refused;
  #   - getAppIconForBundleId (`{isBridgeComputerUsePlatform:i}=await ...;
  #     if(!i()||...)return null`) - no app icons on the approval card.
  # So the DEFINITION is rewritten: on Linux it also passes when
  # js/cu_mode_preamble.js decided that a first-party bridge is usable on this
  # session (globalThis.__cdbCuWaylandAnnounce === true, set once per process
  # before the device connects; fallback routes leave it false). Every
  # consumer, present or future, follows. X11, darwin and win32 are unchanged
  # (`!M()` is true there or the global is never true); the HIPAA term and the
  # GrowthBook gate 4293378213 of each consumer stay as upstream wrote them.
  #
  # Anchor: the un-minified namespace key `isBridgeComputerUsePlatform:()=>N`,
  # exactly once. Pre-asserts: N is defined once as `function N(){return!M()}`,
  # M is the XDG_SESSION_TYPE Wayland check, defined once. Post-asserts (fail
  # loud, so a consumer moved onto another predicate breaks the build): the
  # announce gate still calls N, and the device-bridge guard's
  # `<ns>.<alias>()` resolves to N through the export getter of the chunk its
  # `<ns>=require(...)` names.
  block:
    let keyPat = re"""isBridgeComputerUsePlatform:\(\)=>([\w$]+)[,}]"""
    var keyNames: seq[string] = @[]
    for m in content.findIter(keyPat):
      keyNames.add m.captures[0]
    if keyNames.len != 1:
      echo &"  [FAIL] 4g isBridgeComputerUsePlatform namespace key: {keyNames.len} matches, expected 1"
    else:
      let nm = keyNames[0]
      let nmEsc = escapeRe(nm)
      let defPat = re("function " & nmEsc & """\(\)\{return!([\w$]+)\(\)\}""")
      let defHits = countMatches(content, defPat)
      if defHits != 1:
        echo &"  [FAIL] 4g bridge platform predicate: {nm} defined as `return!M()` {defHits} times, expected 1 - re-audit"
      else:
        let mo = content.find(defPat).get().captures[0]
        let moHits = waylandPredicateDefs(content, mo)
        if moHits != 1:
          echo &"  [FAIL] 4g bridge platform predicate: {mo} is not the XDG_SESSION_TYPE Wayland check ({moHits} definitions matched, expected 1) - re-audit"
        else:
          let gatePat = re(
            """function [\w$]+\(\)\{return [\w$]+\(\)\|\|!""" & nmEsc &
              """\(\)\|\|![\w$]+\(["'`]4293378213["'`]\)\?!1:"""
          )
          let gateHits = countMatches(content, gatePat)
          let guardAlias = bridgeGuardAlias(content)
          if gateHits != 1:
            echo &"  [FAIL] 4g announce gate no longer calls {nm}() ({gateHits} matches of `return A()||!{nm}()||!C(\"4293378213\")?!1:`, expected 1) - re-audit"
          elif guardAlias != nm:
            echo &"  [FAIL] 4g device-bridge guard does not resolve to {nm} (resolved: '{guardAlias}') - re-audit"
          else:
            let n = replaceFirst(
              content,
              defPat,
              proc(m: RegexMatch): string =
                "function " & nm & "(){return!" & m.captures[0] &
                  "()||process.platform===\"linux\"&&globalThis.__cdbCuWaylandAnnounce===!0}",
            )
            if n == 1:
              echo &"  [OK] 4g bridge platform predicate: {nm}() = !{mo}() or a usable Linux bridge (announce gate + device-bridge guard + app icons, 1 definition)"
              inc changes, n
              inc patchesApplied
            else:
              echo "  [FAIL] 4g bridge platform predicate: replacement did not apply"

  # ── Patch 4h: turn-end unhide → the Linux executor's __unhideApps ──────
  # Upstream lifts what Computer Use hid during a turn through one function
  # (4.4212.0: `Z9i`, exported as unhideComputerUseApps, in
  # index.chunk-CvhJZ02X.js; callers: releaseTurnScopedState, the turn result /
  # leavingRunning paths and the remote-tools path, each behind the
  # chicagoAutoUnhide setting):
  #   async function Z9i(e){if(e.length!==0){if(process.platform==="win32"){
  #   let{unhideComputerUseAppsWin32:t}=await ...require("./<win chunk>")...;
  #   await t(e);return}if(process.platform==="linux"){
  #   let{unhideComputerUseAppsLinux:t}=await ...require("./<linux chunk>")...;
  #   await t(e);return}await(await e3()).apps.unhide(e)}}
  # Its Linux arm always loads upstream's own Linux executor module, whose
  # unhide only knows windows upstream's executor hid, so the KWin executor's
  # capture exclusions were never lifted through it. We put, at the start of
  # the Linux arm, a call to the active Linux executor's __unhideApps(ids) when
  # it has that method (js/executor_linux.js: restore-prepare-state); without
  # it upstream's own Linux arm runs unchanged. Off Linux nothing changes.
  # (Every turn end also lifts them on the CU lock release, regardless of
  # chicagoAutoUnhide: js/executor_linux.js __setLockHeld(false).)
  #
  # Anchor: the function whose body is `if(P.length!==0){if(process.platform==="win32")
  # {let{unhideComputerUseAppsWin32:..}=...}if(process.platform==="linux"){
  # let{unhideComputerUseAppsLinux:X}=...;await X(P);return}`, exactly once (the
  # export names are the stable part).
  block:
    let pat =
      re"""(async function ([\w$]+)\(([\w$]+)\)\{if\(\3\.length!==0\)\{if\(process\.platform===(["`])win32\4\)\{let\{unhideComputerUseAppsWin32:[\w$]+\}=[^{}]{0,300}\}if\(process\.platform===\4linux\4\)\{)(let\{unhideComputerUseAppsLinux:([\w$]+)\}=[^{}]{0,300}await \6\(\3\);return\})"""
    let hits = countMatches(content, pat)
    if hits != 1:
      echo &"  [FAIL] 4h unhide routing: {hits} matches of upstream's unhide function, expected 1"
    else:
      let fnName = content.find(pat).get().captures[1]
      let n = replaceFirst(
        content,
        pat,
        proc(m: RegexMatch): string =
          m.captures[0] &
            "if(typeof globalThis.__linuxExecutor?.__unhideApps===\"function\"){" &
            "await globalThis.__linuxExecutor.__unhideApps(" & m.captures[2] &
            ");return}" & m.captures[4],
      )
      if n == 1:
        echo &"  [OK] 4h unhide routing: {fnName}'s Linux arm calls the Linux executor's __unhideApps when present (1 match)"
        inc changes, n
        inc patchesApplied
      else:
        echo "  [FAIL] 4h unhide routing: replacement did not apply"

  # ── Patch 5b (kwin-wayland): screenshot intro note workaround ──────────
  block:
    # v1.18286.0 added an abort timeout between the AbortController and the
    # options object: `,I=setTimeout(()=>u.abort(),PXi)` - matched optionally
    # and non-capturing so the AbortController capture index (5) stays stable.
    # The \6 backref pins the setTimeout's abort target to the AbortController
    # var captured just before it (hardening from PR #179 by @boommasterxd).
    #
    # v1.20186.1 rewrote the wrapper prologue that immediately precedes the
    # screenshot-dims decl (added an onTakeoverRequest/approveTakeover takeover
    # flow ending in `||X.call(Y)}}}const <dims>=...` instead of the old
    # `;X()}}const <dims>=...`). The old prologue anchor `;[\w$]+\(\)\}\}const`
    # no longer matches. The screenshot-dims decl itself is unique, so anchor
    # the async header, then lazily skip (up to 12000 chars) straight to that
    # decl - do not try to pin the exact prologue shape.
    #
    # v1.26832.0 rewrote the decl itself: the `X||(a=b.getLastScreenshotDims)==
    # null?void 0:a.call(b)` babel-style optional call collapsed into a plain
    # ternary over a native optional call - `let <dims>=<skip>?void 0:<ctx>.
    # getLastScreenshotDims?.()`. `const` also became `let`.
    #
    # The header anchor is now pinned to `return async(...)` (the dispatcher
    # factory's returned tool handler). Without `return ` the lazy skip also
    # matches two nested `async(e,t)=>{` permission callbacks that sit ~7k
    # chars upstream of the decl, which would capture THEIR `e` as the tool
    # name - a silent mis-binding, not a build failure.
    #
    # v1.30096.1 introduced the grant-tier rework, which hoists three more
    # declarations out of the options object and in between the setTimeout and
    # the object literal (`,b=[...ctx.getAllowedApps()],x=ctx.getGrantFlags(),
    # S=ctx.getUserDeniedBundleIds(),C={...,grants:g(b,S),...}`). Allow any
    # number of such comma-free simple declarations before the options object
    # rather than pinning their shape.
    # v1.32352.1: the minifier parenthesises arrow arguments -
    # `setTimeout((()=>v.abort()),or)` - so the wrapping parens around the
    # abort arrow are optional.
    # v2.37337.1 folded those hoisted grant reads into a zero-arg closure
    # (`,x=()=>{let e=[...ctx.getAllowedApps()],...;return{allowedApps:e,...}}`)
    # that the options object spreads (`S={...x(),readTheGrantsAfresh:x,...`).
    # Its body has braces and commas, so a hoisted decl may also be a
    # `()=>{...}` arrow with at most one nested brace level.
    # v3.1623.0 grew the handler prologue: the header-to-decl gap is 8078
    # chars (7789 in v2.42304.2), past the old 8000 cap, so the skip window is
    # 12000. The `return async(` header is still the only one within 30k
    # chars before the decl, so the wider window cannot pick another handler.
    let seedPat =
      re"""return async\(([\w$]+),[\w$]+\)=>\{[\s\S]{0,12000}?(?:const|let|var) ([\w$]+)=([\w$]+)\?void 0:[\w$]+(?:\.[\w$]+)*\.getLastScreenshotDims\?\.\(\),([\w$]+)=new AbortController(?:,[\w$]+=setTimeout\(\(?\(\)=>\4\.abort\(\)\)?,[\w$]+\))?(?:,[\w$]+=(?:[^{},]{1,200}|\(\)=>\{(?:[^{}]|\{[^{}]{0,400}\}){1,600}\}))*,([\w$]+)=\{"""
    let maybeSeed = content.find(seedPat)
    if maybeSeed.isNone:
      echo "  [FAIL] screenshot intro note: wrapper seed anchor not found"
    else:
      let seed = maybeSeed.get()
      let toolName = seed.captures[0]
      let dimsVar = seed.captures[1]
      let lastVar = seed.captures[2]
      let injection =
        ",linuxVisibleLastScreenshot=process.platform===\"linux\"&&" & lastVar &
        "===void 0&&" & toolName & "===\"screenshot\"?void 0:" & lastVar & "??(" &
        dimsVar & "?{..." & dimsVar & ",base64:\"\"}:void 0)"
      # Split at the comma immediately before the AbortController var so the
      # injection joins the same declaration list. That var is group 4 of the
      # v1.26832.0 seed pattern → nre captures/captureBounds index 3.
      let abortBounds = seed.captureBounds[3]
      let splitPoint = abortBounds.a - 1
      content = content[0 ..< splitPoint] & injection & content[splitPoint ..^ 1]
      inc changes

      let lastScreenshotPat = re(
        "lastScreenshot:" & escapeRe(lastVar) & r"\?\?\(" & escapeRe(dimsVar) &
          r"\?\{\.\.\." & escapeRe(dimsVar) &
          r",base64:(?:\x22\x22|\x60\x60)\}:void 0\),"
      )
      let lsCount = replaceFirst(
        content,
        lastScreenshotPat,
        proc(m: RegexMatch): string =
          "lastScreenshot:linuxVisibleLastScreenshot,",
      )
      if lsCount < 1:
        echo "  [FAIL] screenshot intro note: lastScreenshot anchor not found"
      else:
        inc changes
        inc patchesApplied
        echo "  [OK] screenshot intro note: first wrapper screenshot restored"

  # ── Patch 6: handleToolCall hybrid dispatch (two-step match) ───────────
  block:
    # isEnabled was a bare call `e=>xS()` through v1.17377; v1.18286.0 made it a
    # session-type ternary `A=>A.sessionType==="ccd"?wS():bue()`; v1.20186.1 made
    # the ternary arms METHOD calls on a namespace object
    # `e=>e.sessionType==="ccd"?n.isComputerUseEnabled():n.isComputerUseRegisterable()`.
    # Accept all three (non-capturing): each ternary arm is `X()` or `X.Y()`. The
    # ternary shape is unique to the computer-use tool object (siblings use
    # `e.sessionType==="ccd"` without paired call arms).
    # v1.26832.0 moved `serverName:<ns>.<k>,tools:[],` in front of isEnabled on
    # this object and switched the literals to backticks. Allow a short
    # brace-free property prefix rather than pinning those two keys, and accept
    # either quote style around "ccd".
    # v2.2553.0 gave the handler a leading PER-HANDLER STATE argument: the server
    # def now does `createToolHandler:e=>{let n={altToolModeCalls:new t.vl};
    # return(t,r)=>Cn.handleToolCall(n,t,r,e)}`, so the signature is
    # `(state, toolName, input, session)`. The dispatcher moved onto that state
    # and is memoized there: `let o=e.dispatch??=xn(i,e.altToolModeCalls)`.
    # v2.9939.0 added `&&!e.cliInSandboxVm` to the ccd branch of isEnabled.
    # v2.19675.1 passes `{requireFreshGrowthBook:!1}` to both arms.
    let htcStart =
      re"""(([\w$]+)=\{[^{}]{0,80}isEnabled:[\w$]+=>(?:[\w$]+\.sessionType===["`]ccd["`]\?[\w$]+(?:\.[\w$]+)?\((?:\{[\w$]+:![01]\})?\)(?:&&![\w$]+\.[\w$]+)?:[\w$]+(?:\.[\w$]+)?\((?:\{[\w$]+:![01]\})?\)|[\w$]+\(\)),handleToolCall:async\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)\)=>\{)"""
    let maybeHtc = content.find(htcStart)
    if maybeHtc.isNone:
      echo "  [FAIL] handleToolCall pattern: 0 matches"
      raise newException(ValueError, "  [FAIL] handleToolCall pattern: 0 matches")
    let htc = maybeHtc.get()
    let objName = htc.captures[1]
    let stateParam = htc.captures[2]
    let toolNameParam = htc.captures[3]
    let inputParam = htc.captures[4]
    let sessionParam = htc.captures[5]
    let injectPos = htc.matchBounds.b + 1

    # Capture the WHOLE dispatcher-init expression (not just its factory name) so
    # the teach-mode forward reuses upstream's own memoization verbatim, whatever
    # extra arguments the factory grows.
    let afterBrace = content[injectPos ..< min(injectPos + 2000, content.len)]
    let dispatcherPat =
      re"""(?:const|let|var) [\w$]+=((?:[\w$]+\.[\w$]+\?\?=)?[\w$]+\([^()]{0,120}\)),\{save_to_disk:"""
    let maybeDispatcher = afterBrace.find(dispatcherPat)
    if maybeDispatcher.isNone:
      echo "  [FAIL] handleToolCall dispatcher not found"
      raise newException(ValueError, "  [FAIL] handleToolCall dispatcher not found")
    let dispatcher = maybeDispatcher.get().captures[0]
    # Assert the session param is an ARGUMENT of the dispatcher call, not merely
    # a character somewhere inside it. A bare substring test is worthless here:
    # minified params are single letters, and `i` occurs inside
    # `altToolModeCalls`, so it could never fail and would let a re-minify capture
    # the wrong variable while still reporting [OK].
    if ("(" & sessionParam & ",") notin dispatcher and
        ("(" & sessionParam & ")") notin dispatcher:
      echo &"  [FAIL] handleToolCall dispatcher `{dispatcher}` does not take `{sessionParam}` as its first argument"
      raise newException(
        ValueError, "  [FAIL] handleToolCall dispatcher does not take the session param"
      )
    var handlerJs = LINUX_HANDLER_INJECTION_JS.strip()
    handlerJs = handlerJs.replace("__SELF__", objName)
    handlerJs = handlerJs.replace("__MAKE_DISPATCH__", dispatcher)
    handlerJs = handlerJs.replace("__STATE__", stateParam)
    handlerJs = handlerJs.replace("__TOOL_NAME__", toolNameParam)
    handlerJs = handlerJs.replace("__INPUT__", inputParam)
    handlerJs = handlerJs.replace("__SESSION__", sessionParam)
    handlerJs = handlerJs.replace(
      "if(process.platform===\"linux\"){",
      "if(process.platform===\"linux\"&&!globalThis.__cuKwinMode){",
    )
    content = content[0 ..< injectPos] & handlerJs & content[injectPos ..^ 1]
    echo "  [OK] handleToolCall: regular-mode hybrid dispatch (gated; kwin-wayland falls through to upstream)"
    inc changes
    inc patchesApplied

  # ── Patch 6b: full grant level in the regular executor mode ─────────────
  block:
    # "Ask before Computer Use controls an app" sends request_access through
    # upstream's own handleToolCall (js/cu_handler_injection.js). Upstream
    # grants browsers at level "read" and terminals/IDEs at "click"; only its
    # `cuOnlyMode` context flag proposes and stores "full" for every app (and
    # drops the read/click first-request warnings that go with those levels).
    # The flag is one property of the per-session dispatch context builder:
    #   cuOnlyMode:process.env.COWORK_CU_ONLY!=="0"&&<flag>("3371831021")
    # Linux regular mode sets it whatever the ask switch says (the switch only
    # decides whether a Code session's request_access reaches upstream at all;
    # upstream's own request_access / request_teach_access - teach mode, cloud
    # Cowork - get full-level grants in regular mode either way); kwin mode
    # keeps upstream's levels. Cowork's own cuOnlyMode (the system prompt /
    # tool set one) is a separate value and is not touched.
    let pat = re"""cuOnlyMode:(process\.env\.COWORK_CU_ONLY!==["`]0["`]&&)"""
    let found = countMatches(content, pat)
    if found != 1:
      raise newException(
        ValueError,
        &"  [FAIL] 6b cuOnlyMode context flag (`cuOnlyMode:process.env.COWORK_CU_ONLY!==\"0\"&&`): {found} matches, expected 1 - re-audit",
      )
    let n = replaceFirst(
      content,
      pat,
      proc(m: RegexMatch): string =
        "cuOnlyMode:process.platform===\"linux\"&&!globalThis.__cuKwinMode||" &
          m.captures[0],
    )
    if n != 1:
      raise newException(
        ValueError, &"  [FAIL] 6b cuOnlyMode context flag: {n} rewrites, expected 1"
      )
    echo "  [OK] 6b grant level: full for every approved app in regular mode (1 match)"
    inc changes
    inc patchesApplied

  # ── Patch 6c: sentinel warnings see our canonical app ids ──────────────
  block:
    # Upstream's request_access card marks terminals, file managers and system
    # settings (isSentinel) from executable names ("gnome-terminal-server",
    # "nautilus", "dolphin", ...). The regular executor's app ids are .desktop
    # ids ("org.gnome.Nautilus"), so the predicate also tries the id's aliases
    # (StartupWMClass, Exec, the resolved executable) on Linux. Anchored on the
    # classifier's last return so the predicate right after it is the one.
    let pat =
      re"""(return["`]system_settings["`]\}return null\}function ([\w$]+)\(([\w$]+)\)\{return ([\w$]+)\(\3\)!==null)\}"""
    let found = countMatches(content, pat)
    if found != 1:
      raise newException(
        ValueError,
        &"  [FAIL] 6c sentinel predicate (`return\"system_settings\"}}return null}}function S(e){{return x(e)!==null}}`): {found} matches, expected 1 - re-audit",
      )
    let n = replaceFirst(
      content,
      pat,
      proc(m: RegexMatch): string =
        let c = m.captures
        c[0] & "||process.platform===\"linux\"&&(globalThis.__cdbCuAppIds?.aliasesOf?.(" &
          c[2] & ")||[]).some(__cdbS=>" & c[3] & "(__cdbS)!==null)}",
    )
    if n != 1:
      raise newException(
        ValueError, &"  [FAIL] 6c sentinel predicate: {n} rewrites, expected 1"
      )
    echo "  [OK] 6c sentinel predicate: Linux app ids classified by their aliases (1 match)"
    inc changes
    inc patchesApplied

  var overlayVarOpt: Option[string]

  # ── Patch 7b (kwin-wayland): teach overlay bridge-backed init ──────────
  block:
    let markerIdx = findStringMarker(content, "[cu-teach] controller initialized")
    if markerIdx == -1:
      echo "  [FAIL] teach overlay controller marker: not found"
    else:
      let fnInfoOpt = findFunctionBeforeMarker(content, markerIdx)
      if fnInfoOpt.isNone:
        echo "  [FAIL] teach overlay controller init header: not found"
      else:
        let fnInfo = fnInfoOpt.get
        let headerPat = re"""^function [\w$]+\(([\w$]+),([\w$]+)\)\{$"""
        let headerMatch = fnInfo.header.find(headerPat)
        let bodyOK =
          fnInfo.body.contains(re"""\.on\(["`]teachModeChanged["`]""") and
          fnInfo.body.contains(re"""\.on\(["`]teachStepRequested["`]""")
        if headerMatch.isNone or not bodyOK:
          echo "  [FAIL] teach overlay controller init function shape: unexpected"
        else:
          let manager = headerMatch.get().captures[0]
          let mainWindow = headerMatch.get().captures[1]
          let injected =
            &"if(process.platform===\"linux\"&&globalThis.__linuxExecutor?.__initTeachController){{globalThis.__linuxExecutor.__initTeachController({manager},{mainWindow});return;}}"
          content =
            content[0 .. fnInfo.headerEnd] & injected &
            content[fnInfo.headerEnd + 1 ..^ 1]
          echo "  [OK] teach overlay controller: Linux bridge-backed init"
          inc changes
          inc patchesApplied

  # ── Patch 7c (kwin-wayland): side-panel bridge-backed init ─────────────
  block:
    let markerIdx = findStringMarker(content, "[cu-side-panel] initialized")
    if markerIdx == -1:
      echo "  [FAIL] cu side-panel controller marker: not found"
    else:
      let fnInfoOpt = findFunctionBeforeMarker(content, markerIdx)
      if fnInfoOpt.isNone:
        echo "  [FAIL] cu side-panel controller init header: not found"
      else:
        let fnInfo = fnInfoOpt.get
        let headerPat = re"""^function [\w$]+\(([\w$]+)\)\{$"""
        let headerMatch = fnInfo.header.find(headerPat)
        let bodyOK = fnInfo.body.contains(re"""\.on\(["`]cuLockChanged["`]""")
        if headerMatch.isNone or not bodyOK:
          echo "  [FAIL] cu side-panel controller init function shape: unexpected"
        else:
          let mainWindow = headerMatch.get().captures[0]
          let injected =
            &"if(process.platform===\"linux\"&&globalThis.__linuxExecutor?.__initDockController){{globalThis.__linuxExecutor.__initDockController({mainWindow});return;}}"
          content =
            content[0 .. fnInfo.headerEnd] & injected &
            content[fnInfo.headerEnd + 1 ..^ 1]
          echo "  [OK] cu side-panel: Linux bridge-backed init"
          inc changes
          inc patchesApplied

  # ── Patch 7d (kwin-wayland): teach mode on KDE Wayland ────────────────
  # Upstream turns teach mode off on every Wayland session: its overlay is an
  # Electron click-through window (4.23118.1, k6x_9PBk):
  #   Z2r=!WO()                          CLICK_THROUGH_WINDOWS
  #   function t3r(){return Z2r?f4r()?!0:(e3r??=wx(EU,"teachModeEnabled",!0,O()),e3r):!1}
  #                                      getChicagoTeachModeEnabled
  # so in kwin mode the teach tools were never listed (session server tool
  # builder `teachMode:t.iF()`, local agent `hn=dn&&t.iF()`) and 7b's
  # bridge-backed teach controller never ran. The KWin executor draws teach
  # steps through kwin-portal-bridge's own overlay and says so with
  # `__teachOverlay: true` (js/executor_linux.js). The first term becomes
  # `Z2r || (Linux && kwin mode && that flag)`; the rest of the getter (the
  # override and the server-side teachModeEnabled value) is kept verbatim.
  # Anchor: the getter, exactly once. Cross-checks: its first term is
  # CLICK_THROUGH_WINDOWS (namespace key, once) and is defined once as
  # `=!M()` with M the XDG_SESSION_TYPE Wayland check.
  block:
    let pat =
      re"""function ([\w$]+)\(\)\{return ([\w$]+)\?([\w$]+)\(\)\?!0:\(([\w$]+)\?\?=([\w$]+)\(([\w$]+),["'`]teachModeEnabled["'`],!0,([\w$]+)\(\)\),\4\):!1\}"""
    var hits: seq[RegexMatch] = @[]
    for m in content.findIter(pat):
      hits.add m
    if hits.len != 1:
      echo &"  [FAIL] 7d teach gate (`function G(){{return C?O()?!0:(v??=r(n,\"teachModeEnabled\",!0,o()),v):!1}}`): {hits.len} matches, expected 1"
    else:
      let fnName = hits[0].captures[0]
      let ct = hits[0].captures[1]
      let ctEsc = escapeRe(ct)
      let keyHits =
        countMatches(content, re("""CLICK_THROUGH_WINDOWS:\(\)=>""" & ctEsc & "[,}]"))
      let defPat = re("(?<![\\w$.])" & ctEsc & """=!([\w$]+)\(\)""")
      var defs: seq[string] = @[]
      for m in content.findIter(defPat):
        defs.add m.captures[0]
      if keyHits != 1:
        echo &"  [FAIL] 7d teach gate {fnName}: {ct} is not CLICK_THROUGH_WINDOWS ({keyHits} namespace keys, expected 1) - re-audit"
      elif defs.len != 1 or waylandPredicateDefs(content, defs[0]) != 1:
        echo &"  [FAIL] 7d teach gate {fnName}: {ct} is not defined once as `=!M()` with M the XDG_SESSION_TYPE Wayland check ({defs.len} definitions) - re-audit"
      else:
        let n = replaceFirst(
          content,
          pat,
          proc(m: RegexMatch): string =
            let whole = m.match
            let head = "function " & m.captures[0] & "(){return " & m.captures[1] & "?"
            "function " & m.captures[0] & "(){return(" & m.captures[1] &
              "||/*__cdbTeachKwin*/process.platform===\"linux\"&&globalThis.__cuKwinMode===!0&&globalThis.__linuxExecutor?.__teachOverlay===!0)?" &
              whole[head.len ..^ 1],
        )
        if n == 1:
          echo &"  [OK] 7d teach gate: {fnName}() also on in kwin mode with the bridge's teach overlay ({ct} = !{defs[0]}(), 1 match)"
          inc changes
          inc patchesApplied
        else:
          echo "  [FAIL] 7d teach gate: replacement did not apply"

  # ── Patch 8: teach overlay mouse — tooltip-bounds polling on Linux ─────
  var overlayVar: string
  block:
    let overlayVarPat =
      re"""([\w$]+)\.setAlwaysOnTop\(!0,["`]screen-saver["`]\),\1\.setFullScreenable\(!1\),\1\.setIgnoreMouseEvents\(!0,\{forward:!0\}\)"""
    let maybeOV = content.find(overlayVarPat)
    if maybeOV.isNone:
      echo "  [FAIL] teach overlay mouse: overlay variable pattern not found"
    else:
      overlayVar = maybeOV.get().captures[0]
      overlayVarOpt = some(overlayVar)
      let oldInit = overlayVar & ".setIgnoreMouseEvents(!0,{forward:!0})"
      let newInit =
        "(process.platform===\"linux\"?(" & overlayVar &
        ".setIgnoreMouseEvents=function(){},globalThis.__isVM&&" & overlayVar &
        ".setOpacity(.15)):" & overlayVar & ".setIgnoreMouseEvents(!0,{forward:!0}))"
      if replaceLiteralFirst(content, oldInit, newInit) == 1:
        echo &"  [OK] teach overlay mouse: tooltip-bounds polling for Linux ({overlayVar})"
        inc changes
        inc patchesApplied
      else:
        echo "  [FAIL] teach overlay mouse: replacement failed"

  # ── Patch 9a: neutralize setIgnoreMouseEvents in yJt ───────────────────
  if overlayVarOpt.isSome:
    block:
      let pat =
        re"""(function [\w$]+\([\w$]+,[\w$]+\)\{)([\w$]+)(\.setIgnoreMouseEvents\(!0,\{forward:!0\}\))"""
      let n = replaceFirst(
        content,
        pat,
        proc(m: RegexMatch): string =
          let fnHead = m.captures[0]
          let vvar = m.captures[1]
          let rest = m.captures[2]
          &"{fnHead}(process.platform!==\"linux\"&&{vvar}{rest})",
      )
      if n >= 1:
        echo "  [OK] teach overlay: neutralized setIgnoreMouseEvents in show handler (yJt) for Linux"
        inc changes
        inc patchesApplied
      else:
        echo "  [FAIL] teach overlay: yJt pattern not found"

    # ── Patch 9b: neutralize setIgnoreMouseEvents in SUn ─────────────────
    # v1.26832.0 replaced the raw IPC channel send in the "working" handler
    # (`<ov>.webContents.send("cu-teach:working")`) with a typed dispatcher call
    # (`<ns>.getDispatcher(<ov>.webContents)?.dispatchWorking()`); the channel
    # string "cu-teach:working" no longer exists anywhere in the bundle. The
    # dispatch call is what now discriminates this site from the overlay-creation
    # site, which shares the identical setIgnoreMouseEvents prefix.
    block:
      let ov = overlayVarOpt.get
      let sunPat = re(
        escapeRe(ov) & r"\.setIgnoreMouseEvents\(!0,\{forward:!0\}\)," &
          r"([\w$]+(?:\.[\w$]+)*\.getDispatcher\(" & escapeRe(ov) &
          r"\.webContents\)\?\.dispatchWorking\(\))"
      )
      let sunCount = replaceFirst(
        content,
        sunPat,
        proc(m: RegexMatch): string =
          "(process.platform!==\"linux\"&&" & ov &
            ".setIgnoreMouseEvents(!0,{forward:!0}))," & m.captures[0],
      )
      if sunCount == 1:
        echo "  [OK] teach overlay: neutralized setIgnoreMouseEvents in working handler (SUn) for Linux"
        inc changes
        inc patchesApplied
      else:
        echo "  [FAIL] teach overlay: SUn pattern not found"

  # ── Patch 8a (kwin-wayland): disable glow overlay ──────────────────────
  block:
    # v1.26832.0: the emitter is reached through a module namespace (`N.t.on(...)`)
    # and the event name is a backtick literal. Capture the whole `.on(...)` head
    # and re-emit it instead of rebuilding it from an identifier.
    let pat =
      re"""(function [\w$]+\(([\w$]+),([\w$]+)\)\{)([\w$]+(?:\.[\w$]+)*\.on\(["`]cuLockChanged["`],)"""
    let n = replaceFirst(
      content,
      pat,
      proc(m: RegexMatch): string =
        m.captures[0] &
          "if(process.platform===\"linux\"&&globalThis.__cuKwinMode)return;" &
          m.captures[3],
    )
    if n >= 1:
      echo &"  [OK] cu glow overlay: disabled in kwin-wayland mode ({n} match)"
      inc changes, n
      inc patchesApplied
    else:
      echo "  [FAIL] cu glow overlay pattern: 0 matches"

  # ── Patch 10: teach overlay VM-aware transparency ──────────────────────
  block:
    # Python walks ALL matches and picks the first whose 80-byte prefix contains "workArea".
    let pat =
      re"""(=new [\w$]+\.BrowserWindow\(\{[^}]*?)transparent:!0([^}]*?)backgroundColor:(["`])#00000000\3"""
    var applied = false
    for m in content.findIter(pat):
      let matchStart = m.matchBounds.a
      let preStart = max(0, matchStart - 80)
      let before = content[preStart ..< matchStart]
      if before.contains("workArea"):
        let bounds = m.matchBounds
        let old = content[bounds.a .. bounds.b]
        let quote = content[m.captureBounds[2]]
        var newS = old
        newS = newS.replace("transparent:!0", "transparent:!globalThis.__isVM")
        newS = newS.replace(
          "backgroundColor:" & quote & "#00000000" & quote,
          "backgroundColor:globalThis.__isVM?\"#000000\":\"#00000000\"",
        )
        # Single literal replacement
        discard replaceLiteralFirst(content, old, newS)
        echo "  [OK] teach overlay: VM-aware transparency (transparent on native, dark backdrop on VMs)"
        inc changes
        inc patchesApplied
        applied = true
        break
    if not applied:
      echo "  [FAIL] teach overlay transparency pattern not found"

  # ── Patch 10b: xlr() force primary monitor on Linux ────────────────────
  block:
    let pat =
      re"""(function [\w$]+\(([\w$]+)\)\{)(return \2===null\?[\w$]+\.screen\.getPrimaryDisplay\(\):[\w$]+\.screen\.getAllDisplays\(\)\.find)"""
    let n = replaceFirst(
      content,
      pat,
      proc(m: RegexMatch): string =
        let param = m.captures[1]
        m.captures[0] & &"if(process.platform===\"linux\"){param}=null;" & m.captures[2],
    )
    if n >= 1:
      echo &"  [OK] teach overlay display: forced to primary monitor on Linux ({n} match)"
      inc changes, n
      inc patchesApplied
    else:
      echo "  [FAIL] xlr display resolver pattern: 0 matches (teach may appear on wrong monitor)"

  # ── Patch 11: force the primary CU enable gate → true on Linux ──────────
  block:
    # v1.18286.0 merged the old isEnabled + rj pair into a gate family:
    #   wS(){if(!IRA.has(process.platform))return!1;const A=YiA();
    #        return A!==void 0?A:HiA()&&sr("chicagoEnabled")}      <- this patch
    #   bue(){if(!rt(rAn))return wS();...}                          <- Patch 12
    #   dq(){...&&!sr("chicagoEnabled")}                            <- untouched:
    #        Patch 2 adds "linux" to IRA, so IRA.has() is TRUE here; dq() is
    #        harmless anyway because Patch 6 injects the Linux dispatch at the
    #        top of handleToolCall, before the if(dq()) stub path is reached.
    #
    # The injected Linux branch is an UNCONDITIONAL `return!0`, not a pref read.
    # Reason: the enable pref is read through sr("chicagoEnabled"), and
    #   sr = A=>{const e=mc().preferences??{};return Qre(e)[A]}
    #   Qre = A=>{const e={};...;return{...U0t,...e,...A,...}}   (U0t = defaults)
    # merges the static defaults object U0t, which carries `chicagoEnabled:!1`.
    # So sr("chicagoEnabled") NEVER returns undefined for a user who has not set
    # the pref — it returns !1 — which means `sr("chicagoEnabled")??!0` can never
    # fall through to !0 and the gate stays false for everyone (CU absent). There
    # is also no CU toggle on Linux: the chicagoEnabled switch is server-rendered
    # by claude.ai and hidden here (see baseline/CLAUDE_FEATURE_FLAGS.md), so there
    # is no legitimate user-set state to respect. Forcing true unconditionally
    # restores the working v1.17377 semantics.
    #
    # v1.26832.0 reverted the v1.18286 three-statement shape back to a single
    # ternary and moved the platform Set behind a module namespace:
    #   function g(){return o.t.has(process.platform)?h()&&a.n(`chicagoEnabled`):!1}
    # (`g` is exported as isComputerUseEnabled). Its sibling
    #   function _(){return o.t.has(process.platform)&&h()&&!a.n(`chicagoEnabled`)}
    # is isComputerUseAvailableButOptedOut and has no `?`, so the ternary shape
    # below picks out exactly one function.
    #
    # v1.46388.2 folded the Cowork HIPAA compliance gate into the ternary and
    # flipped the minifier back to double quotes:
    #   function rz(){return!ZR.has(process.platform)||Uk()?!1:nz()&&Wx("chicagoEnabled")}
    # (`Uk()` is `coworkHipaaRestricted()==="restricted"`). The Linux branch now
    # returns `!<hipaa>()` instead of a bare `!0`, so an org compliance lock
    # still switches CU off on Linux exactly as it does on macOS/Windows; the
    # platform Set + chicagoEnabled parts stay forced as before.
    #
    # The same release added a PER-CALL deny to handleToolCall's preamble
    # (`if(...,t.Rb())return{isError:!0,content:[...]}`), which Patch 6's Linux
    # dispatch returns before. So the Linux branch also publishes the captured
    # gate as `globalThis.__cdbCuHipaa` and js/cu_handler_injection.js re-checks
    # it at the top of every tool call. isEnabled runs at server registration,
    # before any tool call, so the global is always set when the handler runs.
    # The v26832 fallback has no HIPAA function to capture and leaves the global
    # unset; the handler then skips the check (typeof guard).
    # v2.19675.1: the gates take an options arg (`e={}`, requireFreshGrowthBook)
    # and the platform Set became a call to hasComputerUseExecutor() (Patch 2):
    #   function aV(e={}){return!$B()||cb()?!1:iV(e)&&nb("chicagoEnabled")}
    # iV() now also requires the Linux rollout flag 3676943315; the Linux
    # branch bypasses it like it bypasses the rest of the rollout gate.
    let patV19675 =
      re"""(function [\w$]+\(([\w$]+)=\{\}\)\{)return![\w$]+(?:\.[\w$]+)*\(\)\|\|([\w$]+)\(\)\?!1:[\w$]+\(\2\)&&[\w$]+(?:\.[\w$]+)*\(["'`]chicagoEnabled["'`]\)\}"""
    let patV46388 =
      re"""(function [\w$]+\(\)\{)return![\w$]+(?:\.[\w$]+)*\.has\(process\.platform\)\|\|([\w$]+)\(\)\?!1:[\w$]+\(\)&&[\w$]+(?:\.[\w$]+)*\(["'`]chicagoEnabled["'`]\)\}"""
    let patV26832 =
      re"""(function [\w$]+\(\)\{)return [\w$]+(?:\.[\w$]+)*\.has\(process\.platform\)\?[\w$]+\(\)&&[\w$]+(?:\.[\w$]+)*\(["'`]chicagoEnabled["'`]\):!1\}"""
    let patV18286 =
      re"""(function [\w$]+\(\)\{)if\(!([\w$]+)\.has\(process\.platform\)\)return!1;const ([\w$]+)=([\w$]+)\(\);return \3!==void 0\?\3:([\w$]+)\(\)&&([\w$]+)\("chicagoEnabled"\)\}"""
    # <=v1.17377 shapes, kept as fallbacks:
    let patNew =
      re"""(function [\w$]+\(\)\{)return [\w$]+\.has\(process\.platform\)&&[\w$]+\(\)\}"""
    let patOld =
      re"""(function [\w$]+\(\)\{)return [\w$]+\([\w$]+\)\?[\w$]+\.has\(process\.platform\)&&[\w$]+\(\):[\w$]+\(\)\}"""
    var n = replaceFirst(
      content,
      patV19675,
      proc(m: RegexMatch): string =
        let bounds = m.matchBounds
        let whole = content[bounds.a .. bounds.b]
        let headerLen = m.captures[0].len
        let hipaaName = m.captures[2]
        m.captures[0] & "if(process.platform===\"linux\")return globalThis.__cdbCuHipaa=" &
          hipaaName & ",!" & hipaaName & "();" & whole[headerLen ..^ 1],
    )
    if n == 0:
      n = replaceFirst(
        content,
        patV46388,
        proc(m: RegexMatch): string =
          let bounds = m.matchBounds
          let whole = content[bounds.a .. bounds.b]
          let headerLen = m.captures[0].len
          let hipaaName = m.captures[1]
          m.captures[0] &
            "if(process.platform===\"linux\")return globalThis.__cdbCuHipaa=" & hipaaName &
            ",!" & hipaaName & "();" & whole[headerLen ..^ 1],
      )
    if n == 0:
      n = replaceFirst(
        content,
        patV26832,
        proc(m: RegexMatch): string =
          let bounds = m.matchBounds
          let whole = content[bounds.a .. bounds.b]
          let headerLen = m.captures[0].len
          m.captures[0] & "if(process.platform===\"linux\")return!0;" &
            whole[headerLen ..^ 1],
      )
    if n == 0:
      n = replaceFirst(
        content,
        patV18286,
        proc(m: RegexMatch): string =
          let bounds = m.matchBounds
          let whole = content[bounds.a .. bounds.b]
          let headerLen = m.captures[0].len
          m.captures[0] & "if(process.platform===\"linux\")return!0;" &
            whole[headerLen ..^ 1],
      )
    if n == 0:
      n = replaceFirst(
        content,
        patNew,
        proc(m: RegexMatch): string =
          let bounds = m.matchBounds
          let whole = content[bounds.a .. bounds.b]
          let headerLen = m.captures[0].len
          m.captures[0] & "if(process.platform===\"linux\")return!0;" &
            whole[headerLen ..^ 1],
      )
    if n == 0:
      n = replaceFirst(
        content,
        patOld,
        proc(m: RegexMatch): string =
          let bounds = m.matchBounds
          let whole = content[bounds.a .. bounds.b]
          let headerLen = m.captures[0].len
          m.captures[0] & "if(process.platform===\"linux\")return!0;" &
            whole[headerLen ..^ 1],
      )
    if n >= 1:
      echo &"  [OK] isEnabled: force true on Linux ({n} match)"
      inc changes, n
      inc patchesApplied
    else:
      echo "  [FAIL] isEnabled pattern: 0 matches (computer-use may not work in cowork/CCD)"

  # ── Patch 12: flag-gated pref-ignoring gate (bue) → delegate to wS ──────
  block:
    # v1.18286.0: bue(){if(!rt(rAn))return wS();const A=YiA();return A!==void 0
    # ?A:IRA.has(process.platform)&&HiA()} - behind GrowthBook flag rAn
    # ("2486083521") it stops consulting wS/chicagoEnabled and re-checks the
    # platform set, which would flip CU back OFF on Linux if the flag turns on
    # remotely. Prepend a Linux branch that always delegates to the (already
    # patched, unconditionally-true) wS.
    #
    # The v18286 branch delegates to wS() (now `return!0` on Linux via Patch 11),
    # so it is correct as-is. The <=v1.17377 fallback below used the same latent
    # `sr("chicagoEnabled")??!0` shape as the old Patch 11 — with sr merging the
    # `chicagoEnabled:!1` default that expression is always !1, so it too is now
    # an unconditional `return!0` for the same reason (see Patch 11 comment).
    #
    # v1.26832.0 collapsed it to a single ternary too:
    #   function y(){return i.Zt(l)?o.t.has(process.platform)&&h():g()}
    # (`y` is exported as isComputerUseRegisterable, `l` is the GrowthBook flag
    # id, `g` is the Patch-11 gate). The else-arm names the gate to delegate to,
    # so capture it rather than hardcoding `return!0`.
    #
    # v1.46388.2 prepends the Cowork HIPAA gate to the flag-on arm:
    #   function Nhn(){return wS(_hn)?!Uk()&&ZR.has(process.platform)&&nz():rz()}
    # The `!<hipaa>()&&` is optional in the pattern; the Linux branch still
    # delegates to the Patch-11 gate, which now honours the same HIPAA gate.
    # v2.19675.1 threads the options arg through and calls
    # hasComputerUseExecutor() instead of testing the Set:
    #   function f4n(e={}){return jb(J2n)?!cb()&&$B()&&iV(e):aV(e)}
    # Delegate to the Patch-11 gate with the same arg.
    let patV19675 =
      re"""(function [\w$]+\(([\w$]+)=\{\}\)\{)return [\w$]+(?:\.[\w$]+)*\([\w$]+\)\?(?:![\w$]+\(\)&&)?[\w$]+\(\)&&[\w$]+\(\2\):([\w$]+)\(\2\)\}"""
    let patV26832 =
      re"""(function [\w$]+\(\)\{)return [\w$]+(?:\.[\w$]+)*\(([\w$]+)\)\?(?:![\w$]+\(\)&&)?[\w$]+(?:\.[\w$]+)*\.has\(process\.platform\)&&[\w$]+\(\):([\w$]+)\(\)\}"""
    let patBue =
      re"""(function [\w$]+\(\)\{)if\(!([\w$]+)\(([\w$]+)\)\)return ([\w$]+)\(\);const ([\w$]+)=([\w$]+)\(\);return \5!==void 0\?\5:([\w$]+)\.has\(process\.platform\)&&([\w$]+)\(\)\}"""
    # <=v1.17377 shape (standalone chicagoEnabled ternary), kept as fallback:
    let patOldChicago =
      re"""(function [\w$]+\(\)\{)return [\w$]+\.has\(process\.platform\)\?[\w$]+\(\)&&([\w$]+)\("chicagoEnabled"\):!1\}"""
    var n = replaceFirst(
      content,
      patV19675,
      proc(m: RegexMatch): string =
        let bounds = m.matchBounds
        let whole = content[bounds.a .. bounds.b]
        let headerLen = m.captures[0].len
        let arg = m.captures[1]
        let wsName = m.captures[2]
        m.captures[0] & "if(process.platform===\"linux\")return " & wsName & "(" & arg &
          ");" & whole[headerLen ..^ 1],
    )
    if n == 0:
      n = replaceFirst(
        content,
        patV26832,
        proc(m: RegexMatch): string =
          let bounds = m.matchBounds
          let whole = content[bounds.a .. bounds.b]
          let headerLen = m.captures[0].len
          let wsName = m.captures[2]
          m.captures[0] & "if(process.platform===\"linux\")return " & wsName & "();" &
            whole[headerLen ..^ 1],
      )
    if n == 0:
      n = replaceFirst(
        content,
        patBue,
        proc(m: RegexMatch): string =
          let bounds = m.matchBounds
          let whole = content[bounds.a .. bounds.b]
          let headerLen = m.captures[0].len
          let wsName = m.captures[3]
          m.captures[0] & "if(process.platform===\"linux\")return " & wsName & "();" &
            whole[headerLen ..^ 1],
      )
    if n == 0:
      n = replaceFirst(
        content,
        patOldChicago,
        proc(m: RegexMatch): string =
          let bounds = m.matchBounds
          let whole = content[bounds.a .. bounds.b]
          let headerLen = m.captures[0].len
          m.captures[0] & "if(process.platform===\"linux\")return!0;" &
            whole[headerLen ..^ 1],
      )
    if n >= 1:
      echo &"  [OK] rj/bue: force true on Linux ({n} match)"
      inc changes, n
      inc patchesApplied
    else:
      echo "  [FAIL] rj pattern: 0 matches (computer-use tool calls may be blocked)"

  # ─── Tool description patches ────────────────────────────────────────
  echo "  --- Tool description patches ---"
  var descChanges = 0

  # 13a: Lf allowlist gate → empty on Linux
  block:
    # v2.19675.1: the sentence is the else-arm of a hitTest ternary
    # (`i=t.hitTest==="none"?"<shared-screen text>":"The frontmost ..."`).
    # Wrap that arm (empty on Linux), and the whole ternary in the live
    # "Ask before Computer Use controls an app" sentence, which is "" while
    # the switch is off (js/cu_consent.js text("input")).
    let patV19675 =
      re"""([\w$]+\.hitTest==="none"\?"[^"]*":)("The frontmost application must be in the session allowlist at the time of this call, or this tool returns an error and does nothing\.")"""
    let found13a = countMatches(content, patV19675)
    var n = 0
    if found13a == 1:
      n = replaceFirst(
        content,
        patV19675,
        proc(m: RegexMatch): string =
          "(process.platform===\"linux\"&&globalThis.__cdbCuConsent?.text(\"input\")||(" &
            m.captures[0] & "(process.platform===\"linux\"?\"\":" & m.captures[1] & ")))",
      )
    else:
      echo &"  [FAIL] 13a frontmost sentence (hitTest ternary): {found13a} matches, expected 1"
    if n == 1:
      echo "  [OK] 13a Lf allowlist gate: empty on Linux"
      inc descChanges
      inc patchesApplied
    else:
      echo "  [FAIL] 13a Lf: not found"

  # 13b: request_access macOS prefix → 3-way ternary
  block:
    # v1.26832.0: single-quoted literal → backtick template. Inside a template
    # literal the embedded `"Finder"` / `"Dolphin"` quotes need no escaping.
    # v1.46388.2: back to a single-quoted literal (it contains `"`).
    # v2.42304.2+: the prefix is keyed by `[t.platform]` and has its own
    # `linux:` entry, so on Linux the model sees that key, never this darwin
    # literal (the Linux arms below are inert there). The live Linux part is
    # 13b.linux, the wrapper around the `linux:` key's Wayland sentence.
    let old13b = [
      "'This computer is running macOS. The file manager is \"Finder\". '",
      "`This computer is running macOS. The file manager is \"Finder\". `",
    ]
    let new13b =
      "(process.platform===\"linux\"?(globalThis.__cuKwinMode?" &
      "`This computer is running Linux with KDE Plasma. The file manager is \"Dolphin\". `" &
      ":(globalThis.__cdbCuConsent?.text(\"prefix\")||" &
      "`This computer is running Linux. " &
      "On Linux, ALL applications are automatically accessible at full " &
      "tier without explicit permission grants. You do NOT need to call " &
      "request_access before using other tools. If called, it returns " &
      "synthetic grant confirmations. The file manager depends on the " &
      "desktop environment (e.g. Nautilus on GNOME, Dolphin on KDE, " &
      "Thunar on XFCE). `))" & ":" &
      "`This computer is running macOS. The file manager is \"Finder\". `)"
    if replaceLiteralFirstAny(content, old13b, new13b) == 1:
      echo "  [OK] 13b request_access: 3-way (kwin-wayland=KDE/Dolphin, regular=generic Linux, other=macOS)"
      inc descChanges
      inc patchesApplied
    else:
      echo "  [FAIL] 13b request_access macOS prefix: not found"

  # 13b.linux: request_access `linux:` prefix → session-aware sentence
  block:
    # The `linux:` key's second sentence is keyed on the preset's
    # screenshotFiltering: "none" reads "This is a Wayland session, so access is
    # to the entire screen ...". With 2b the X11 preset is "none" too, so that
    # arm would be chosen on X11 as well. Pick it only on a Wayland session
    # (KDE Wayland or XDG_SESSION_TYPE) and give X11 a sentence that matches
    # the bridge: whole display, input goes to whatever is under it. The
    # request_access/resolve_access consent flow itself is untouched.
    let pat =
      re""""This is a Wayland session, so access is to the entire screen[^"]*""""
    let nFound = countMatches(content, pat)
    if nFound != 1:
      echo &"  [FAIL] 13b.linux request_access Wayland sentence: {nFound} matches, expected 1"
    else:
      let n = replaceFirst(
        content,
        pat,
        proc(m: RegexMatch): string =
          "(globalThis.__cdbCuConsent?.text(\"access\")||(globalThis.__cuKwinMode||process.env.XDG_SESSION_TYPE===\"wayland\"?" &
            m.match & ":" & CU_X11_ACCESS_SENTENCE & "))",
      )
      if n == 1:
        echo "  [OK] 13b.linux request_access: Wayland sentence only on Wayland, X11 gets the whole-display sentence"
        inc descChanges
        inc patchesApplied
      else:
        echo "  [FAIL] 13b.linux request_access Wayland sentence: not rewritten"

  # 13b.kwin-alias: plasmashell alias in request_access
  block:
    # v1.26832.0: `const`→`let`, `=="string"`→`==\`string\``, and the error
    # strings are backtick templates.
    # v1.32352.1: arrow arguments are parenthesised - `.every((e=>...))` - so
    # the wrapping parens are optional.
    let pat =
      re"""((?:const|let|var) ([\w$]+)=[\w$]+\.apps;if\(!Array\.isArray\(\2\)\|\|!\2\.every\(\(?([\w$]+)=>typeof \3==["`]string["`]\)\)?\)return [\w$]+\(['"`]"apps" must be an array of strings\.['"`],["`]bad_args["`]\);(?:const|let|var) )([\w$]+)=\2(,[\w$]+=\{\};)"""
    let n = replaceFirst(
      content,
      pat,
      proc(m: RegexMatch): string =
        let prefix = m.captures[0]
        let appsVar = m.captures[1]
        let mappedVar = m.captures[3]
        let suffix = m.captures[4]
        prefix & mappedVar & "=globalThis.__cuKwinMode?" & appsVar &
          ".map(v=>v===\"org.kde.plasmashell\"?\"plasmashell\":v):" & appsVar & suffix,
    )
    if n >= 1:
      echo "  [OK] 13b.kwin-alias request_access: org.kde.plasmashell -> plasmashell (kwin-wayland mode)"
      inc descChanges
      inc patchesApplied
    else:
      echo "  [FAIL] 13b.kwin-alias request_access alias: not found"

  # 13b.kwin-alias-teach: plasmashell alias in request_teach_access
  #
  # v1.26832.0 dropped the intermediate `const <mapped>=<apps>,{needDialog:...}`
  # binding: the raw apps array is now passed straight into the resolver call
  # (`let{needDialog:...}=await X(ctx,<apps>,...)`), and it is its only use. So
  # map the ARGUMENT instead of introducing a binding — that also keeps working
  # whichever declarator upstream picks, since nothing is reassigned.
  block:
    # v1.32352.1: same optional arrow-wrapping parens as 13b.kwin-alias.
    let pat =
      re"""((?:const|let|var) ([\w$]+)=[\w$]+\.apps;if\(!Array\.isArray\(\2\)\|\|!\2\.every\(\(?([\w$]+)=>typeof \3==["`]string["`]\)\)?\)return [\w$]+\(['"`]"apps" must be an array of strings\.['"`],["`]bad_args["`]\);(?:const|let|var)\{needDialog:[\s\S]{0,400}?\}=await [\w$]+\([\w$]+,)\2(,)"""
    let n = replaceFirst(
      content,
      pat,
      proc(m: RegexMatch): string =
        let prefix = m.captures[0]
        let appsVar = m.captures[1]
        let suffix = m.captures[3]
        prefix & "(globalThis.__cuKwinMode?" & appsVar &
          ".map(v=>v===\"org.kde.plasmashell\"?\"plasmashell\":v):" & appsVar & ")" &
          suffix,
    )
    if n >= 1:
      echo "  [OK] 13b.kwin-alias-teach request_teach_access: plasmashell alias (kwin-wayland mode)"
      inc descChanges
      inc patchesApplied
    else:
      echo "  [FAIL] 13b.kwin-alias-teach request_teach_access alias: not found"

  # 13b.kwin-shell-hint: desktop shell hint template
  block:
    # v1.28929.0: wording changed ("To click on the desktop, ...") and a second
    # ${platform===`win32`?...} interpolation was added (click-only caveat).
    # The whole matched region is one template literal passed as an argument,
    # so it can be swapped for a parenthesised ternary — no outer template
    # wrapper needed, and the branch texts stay single-level templates where
    # `"` needs no escaping.
    let prefix =
      "`The desktop shell is frontmost. Double-click, right-click, and Enter on desktop items can launch applications outside the allowlist. To click on the desktop, taskbar, Start menu, Search, or file manager, call request_access with exactly \"${"
    # v1.32352.1: the minifier escapes non-ASCII as \uXXXX inside literals -
    # the em-dash is now the six ASCII chars \u2014, not raw UTF-8 bytes.
    # v1.46388.2: the inner string literals are double-quoted again
    # (`==="win32"?"File Explorer":"Finder"`); the outer template stays a
    # backtick literal because of the ${} interpolations. Accept either quote
    # style for the inner literals via a quote class (Q below).
    const Q = "[\"`]"
    let mid =
      "===" & Q & "win32" & Q & "\\?" & Q & "File Explorer" & Q & ":" & Q & "Finder" & Q &
      escapeRe("}\" in the apps array \\u2014 that single grant covers all of them.${")
    let suffix =
      "===" & Q & "win32" & Q & "\\?" & Q &
      escapeRe(" That grant is click-only: typing into the shell stays blocked.") & Q &
      ":" & Q & Q &
      escapeRe(
        "} To interact with a different app, use open_application to bring it forward.`"
      )
    let pat = re(escapeRe(prefix) & "([\\w$]+)" & mid & "([\\w$]+)" & suffix)
    let maybeMatch = content.find(pat)
    if maybeMatch.isSome:
      let m = maybeMatch.get()
      let bounds = m.matchBounds
      let old = content[bounds.a .. bounds.b]
      let newShell =
        "(globalThis.__cuKwinMode?`The desktop shell is frontmost. Desktop icons, panels, launchers, and widgets belong to Plasma Shell. To interact with them, call request_access with exactly \"plasmashell\" in the apps array. If you need the file manager, request \"Dolphin\" separately. To interact with a different app, use open_application to bring it forward.`:" &
        old & ")"
      discard replaceLiteralFirst(content, old, newShell)
      echo "  [OK] 13b.kwin-shell-hint: kwin-wayland=plasmashell, regular/other=upstream wording"
      inc descChanges
      inc patchesApplied
    else:
      echo "  [FAIL] 13b.kwin-shell-hint desktop shell hint: not found"

  # 13b.kwin-shell-grant: shell grant predicate
  block:
    # v1.28929.0: upstream switched .some(...) (boolean) to .find(...) — the
    # caller now reads `.tier` off the returned granted app, so the kwin-mode
    # branch must likewise return the matching app object, not a boolean.
    # v1.32352.1: arrow arguments are parenthesised - `.find((e=>...))` - so
    # the wrapping parens are optional. The replacement emits unwrapped arrows,
    # which is equally valid JS.
    let pat =
      re"""(function [\w$]+\(([\w$]+),([\w$]+)\)\{)return \3===["`]darwin["`]\?\2\.find\(\(?([\w$]+)=>\4\.bundleId===([\w$]+)\)\)?:\2\.find\(\(?([\w$]+)=>\6\.bundleId\.toLowerCase\(\)===([\w$]+)\)\)?\}"""
    let n = replaceFirst(
      content,
      pat,
      proc(m: RegexMatch): string =
        let header = m.captures[0]
        let apps = m.captures[1]
        let plat = m.captures[2]
        let darwinIter = m.captures[3]
        let macConst = m.captures[4]
        let winIter = m.captures[5]
        let winConst = m.captures[6]
        header & "return " & plat & "===\"darwin\"?" & apps & ".find(" & darwinIter &
          "=>" & darwinIter & ".bundleId===" & macConst & "):globalThis.__cuKwinMode&&" &
          plat & "===\"linux\"?" & apps & ".find(" & darwinIter & "=>" & darwinIter &
          ".bundleId===\"plasmashell\"||" & darwinIter &
          ".bundleId===\"org.kde.plasmashell\"):" & apps & ".find(" & winIter & "=>" &
          winIter & ".bundleId.toLowerCase()===" & winConst & ")}",
    )
    if n >= 1:
      echo "  [OK] 13b.kwin-shell-grant: plasmashell satisfies shell access (kwin-wayland only)"
      inc descChanges
      inc patchesApplied
    else:
      echo "  [FAIL] 13b.kwin-shell-grant desktop shell grant predicate: not found"

  # 13b.kwin-shell-detect: shell detection
  # Function shape upstream:
  #   function NAME(arg){if(arg===MAC_CONST)return!0;if(!X||!Y)return!1;...}
  # We extend the early macOS-shell early-return with a kwin-mode plasmashell
  # check so the "is this the desktop shell?" predicate accepts plasmashell on
  # KDE Wayland too.
  block:
    let pat =
      re"""(function [\w$]+\(([\w$]+)\)\{)if\(\2===([\w$]+)\)return!0;(if\(![\w$]+\|\|![\w$]+\)return!1;)"""
    let n = replaceFirst(
      content,
      pat,
      proc(m: RegexMatch): string =
        let header = m.captures[0]
        let arg = m.captures[1]
        let macConst = m.captures[2]
        let winGuard = m.captures[3]
        header & "if(" & arg & "===" & macConst & "||globalThis.__cuKwinMode&&(" & arg &
          "===\"plasmashell\"||" & arg & "===\"org.kde.plasmashell\"))return!0;" &
          winGuard,
    )
    if n >= 1:
      echo "  [OK] 13b.kwin-shell-detect: plasmashell recognized as shell (kwin-wayland only)"
      inc descChanges
      inc patchesApplied
    else:
      echo "  [FAIL] 13b.kwin-shell-detect desktop shell detection: not found"

  # 13c: request_access apps — WM_CLASS for Linux
  block:
    # v1.46388.2: single-quoted literal (contains `"`); backtick kept as fallback.
    let old13c = [
      "'Application display names (e.g. \"Slack\", \"Calendar\") or bundle identifiers (e.g. \"com.tinyspeck.slackmacgap\"). Display names are resolved case-insensitively against installed apps.'",
      "`Application display names (e.g. \"Slack\", \"Calendar\") or bundle identifiers (e.g. \"com.tinyspeck.slackmacgap\"). Display names are resolved case-insensitively against installed apps.`",
    ]
    let new13c =
      "(process.platform===\"linux\"?" &
      "`Application names as shown in window titles, or WM_CLASS values " &
      "(e.g. \"firefox\", \"org.gnome.Nautilus\"). " &
      "On Linux all apps are auto-granted at full tier.`" & ":" &
      "`Application display names (e.g. \"Slack\", \"Calendar\") or bundle " &
      "identifiers (e.g. \"com.tinyspeck.slackmacgap\"). Display names are " &
      "resolved case-insensitively against installed apps.`)"
    if replaceLiteralFirstAny(content, old13c, new13c) == 1:
      echo "  [OK] 13c request_access apps: Linux identifiers"
      inc descChanges
      inc patchesApplied
    else:
      echo "  [FAIL] 13c request_access apps: not found"

  # 13d: open_application app identifier
  block:
    # v1.46388.2: single-quoted literal (contains `"`); backtick kept as fallback.
    let old13d = [
      "'Display name (e.g. \"Slack\") or bundle identifier (e.g. \"com.tinyspeck.slackmacgap\").'",
      "`Display name (e.g. \"Slack\") or bundle identifier (e.g. \"com.tinyspeck.slackmacgap\").`",
    ]
    let new13d =
      "(process.platform===\"linux\"?" &
      "`Application name or WM_CLASS (e.g. \"firefox\", \"nautilus\").`" & ":" &
      "`Display name (e.g. \"Slack\") or bundle identifier (e.g. \"com.tinyspeck.slackmacgap\").`)"
    if replaceLiteralFirstAny(content, old13d, new13d) == 1:
      echo "  [OK] 13d open_application app: Linux identifiers"
      inc descChanges
      inc patchesApplied
    else:
      echo "  [FAIL] 13d open_application app: not found"

  # 13e: open_application description — no allowlist on Linux.
  # v1.21459.0 reworded the description (added background/display-scope prose);
  # only the trailing allowlist sentence needs the Linux ternary. Anchored by
  # the ",inputSchema:" that follows the open_application tool description so it
  # hits the tool definition site, not the runtime error strings that reuse the
  # same sentence.
  block:
    # v1.32352.1: the em-dash is emitted as the six-char \u2014 escape (see
    # 13b.kwin-shell-hint). The re-emitted branch keeps the escape, which JS
    # decodes to the same character.
    # Switch on, js/cu_consent.js text("openApp") says the app must be approved.
    let linuxSentence =
      "(globalThis.__cdbCuConsent?.text(\"openApp\")||\"On Linux, all applications are directly accessible.\")"
    let macSentence =
      "\"The target must already be in the session allowlist " &
      "\\u2014 call request_access first.\""
    # v1.46388.2: the description is a plain double-quoted string again, so a
    # `${}` interpolation would be emitted verbatim. Close the string and
    # concatenate the ternary instead; the sentence is preceded by a space
    # ("...brought to the front. "), so the split lands on a clean boundary.
    let old13eStr =
      "The target must already be in the session allowlist \\u2014 call request_access first.\",inputSchema:"
    let new13eStr =
      "\"+(process.platform===\"linux\"?" & linuxSentence & ":" & macSentence &
      "),inputSchema:"
    # <=v1.40609.0: backtick template - interpolate inside it.
    let old13eTpl =
      "The target must already be in the session allowlist \\u2014 call request_access first.`,inputSchema:"
    let new13eTpl =
      "${process.platform===\"linux\"?" & linuxSentence & ":" & macSentence &
      "}`,inputSchema:"
    if replaceLiteralFirst(content, old13eStr, new13eStr) == 1 or
        replaceLiteralFirst(content, old13eTpl, new13eTpl) == 1:
      echo "  [OK] 13e open_application: no allowlist on Linux"
      inc descChanges
      inc patchesApplied
    else:
      echo "  [FAIL] 13e open_application: not found"

  # 13f: screenshot description — clean on Linux
  block:
    # v1.32352.1: em-dash emitted as the \u2014 escape (see 13e).
    # v1.46388.2: double-quoted literal; backtick kept as fallback.
    let old13f = [
      "\"Take a screenshot of the primary display. On this platform, screenshots are NOT filtered \\u2014 all open windows are visible. Input actions targeting apps not in the session allowlist are rejected.\"",
      "`Take a screenshot of the primary display. On this platform, screenshots are NOT filtered \\u2014 all open windows are visible. Input actions targeting apps not in the session allowlist are rejected.`",
    ]
    # Switch on, js/cu_consent.js text("screenshot") says what this session's
    # screenshots show (masked or the whole screen).
    const linux13f =
      "(globalThis.__cdbCuConsent?.text(\"screenshot\")||\"Take a screenshot of the primary display. All open windows are visible.\")"
    let new13f =
      "(process.platform===\"linux\"?" & linux13f & ":" &
      "\"Take a screenshot of the primary display. On this platform, " &
      "screenshots are NOT filtered \\u2014 all open windows are visible. " &
      "Input actions targeting apps not in the session allowlist are rejected.\")"
    # v2.19675.1 split the allowlist sentence off into a hitTest-keyed suffix:
    #   "...NOT filtered \u2014 all open windows are visible."+(t.hitTest==="none"
    #   ?" That includes this assistant's own window; ...":" Input actions ...")
    # Wrap the whole concatenation so Linux gets neither suffix.
    let pat13f =
      re"""("Take a screenshot of the primary display\. On this platform, screenshots are NOT filtered \\u2014 all open windows are visible\."\+\([\w$]+\.hitTest==="none"\?"[^"]*":"[^"]*"\))"""
    var n13f = replaceFirst(
      content,
      pat13f,
      proc(m: RegexMatch): string =
        "(process.platform===\"linux\"?" & linux13f & ":" & m.captures[0] & ")",
    )
    if n13f == 0:
      n13f = replaceLiteralFirstAny(content, old13f, new13f)
    if n13f == 1:
      echo "  [OK] 13f screenshot: clean description on Linux"
      inc descChanges
      inc patchesApplied
    else:
      echo "  [FAIL] 13f screenshot: not found"

  # 13g: screenshot suffix — no allowlist error on Linux
  block:
    let pat =
      re"""([\w$]+)\+["`] Returns an error if the allowlist is empty\. The returned image is what subsequent click coordinates are relative to\.["`]"""
    let n = replaceFirst(
      content,
      pat,
      proc(m: RegexMatch): string =
        let v = m.captures[0]
        &"{v}+(process.platform===\"linux\"" &
          "?(globalThis.__cdbCuConsent?.text(\"shotSuffix\")||\" The returned image is what subsequent click coordinates are relative to.\")" &
          ":\" Returns an error if the allowlist is empty. The returned image is what subsequent click coordinates are relative to.\")",
    )
    if n >= 1:
      echo "  [OK] 13g screenshot suffix: no allowlist error on Linux"
      inc descChanges
      inc patchesApplied
    else:
      echo "  [FAIL] 13g screenshot suffix: not found"

  if descChanges > 0:
    inc changes, descChanges
    echo &"  [OK] {descChanges}/13 description patches applied (8 regular + 5 kwin-wayland KDE)"
  else:
    echo "  [FAIL] No description patches applied (descriptions unchanged)"

  # ─── Patch 14: Linux-aware CU system prompt ──────────────────────────
  # 14a: separate filesystems → 3-way same-filesystem wording (2 occurrences)
  block:
    # v1.32352.1: em-dash emitted as the \u2014 escape (see 13e).
    let sepOldFull2 =
      "**Separate filesystems.** Computer-use actions (clicks, typing, clipboard writes) happen on the user's real computer \\u2014 a different system from your sandbox. "
    let sepCount = countOccurrences(content, sepOldFull2)
    if sepCount == 2:
      let sepNewFull =
        "${process.platform===\"linux\"?(globalThis.__cuKwinMode" &
        "?\"**Same filesystem.** Computer-use actions and your CLI tools operate on the same Linux machine. " &
        "Files you create are directly accessible to desktop applications, and files selected or edited in " &
        "desktop apps are on the same machine you can read from the CLI. " & "\"" &
        ":\"**Same filesystem.** Computer-use actions and your CLI tools operate on the same Linux machine. " &
        "There is no sandbox \\u2014 files you create are directly accessible to desktop applications and vice versa. " &
        "\")" &
        ":\"**Separate filesystems.** Computer-use actions (clicks, typing, clipboard writes) " &
        "happen on the user's real computer \\u2014 a different system from your sandbox. " &
        "\"}"
      discard replaceLiteralAll(content, sepOldFull2, sepNewFull)
      echo &"  [OK] 14a separate filesystems: 3-way replace, {sepCount} occurrences"
      inc changes, sepCount
      inc patchesApplied
    else:
      echo &"  [FAIL] 14a separate filesystems: expected 2 occurrences, found {sepCount}"

  # 14b: Finder/Photos/System Settings → generic Linux app terms
  block:
    let appsOld = "Maps, Notes, Finder, Photos, System Settings"
    let appsNew =
      "${process.platform===\"linux\"?\"the file manager, image viewer, terminal emulator, system settings\":\"Maps, Notes, Finder, Photos, System Settings\"}"
    if replaceLiteralFirst(content, appsOld, appsNew) == 1:
      echo "  [OK] 14b app names: replaced macOS apps with Linux-generic terms"
      inc changes
      inc patchesApplied
    else:
      echo "  [FAIL] 14b app names: 'Maps, Notes, Finder, Photos, System Settings' not found"

  # 14c: File Explorer/Finder → 3-way (Dolphin/Files/Finder)
  block:
    # v1.46388.2: double-quoted literals; backtick kept as fallback. The
    # replacement re-emits its own quotes, so both variants share it.
    # Two sites, both reachable on Linux: the desktop-shell hint inside the
    # request_access error template, and the hit-test path's "desktop (<fm>)"
    # name when a click lands on the desktop behind a look-through window.
    let fmOld = ["\"File Explorer\":\"Finder\"", "`File Explorer`:`Finder`"]
    let fmNew =
      "\"File Explorer\":process.platform===\"linux\"?(globalThis.__cuKwinMode?\"Dolphin\":\"Files\"):\"Finder\""
    var fmCount = 0
    for needle in fmOld:
      fmCount += replaceLiteralAll(content, needle, fmNew)
    if fmCount == 2:
      echo "  [OK] 14c file manager name: 3-way (kwin-wayland=Dolphin, regular=Files, other=Finder), 2 sites"
      inc changes, fmCount
      inc patchesApplied
    else:
      echo &"  [FAIL] 14c file manager name: {fmCount} sites, expected 2"

  # 14d (kwin-wayland): env prompt KDE augmentation
  block:
    let envPat =
      re"""You have a computer-use MCP available \(tools named \\`mcp__computer-use__\*\\`\)\. It lets you take screenshots of the user's desktop and control it with mouse clicks, keyboard input, and scrolling\."""
    let envNew =
      "You have a computer-use MCP available (tools named \\`mcp__computer-use__*\\`). It lets you take " &
      "screenshots of the user's desktop and control it with mouse clicks, keyboard input, and scrolling." &
      "${globalThis.__cuKwinMode?' This computer is running Linux with KDE Plasma. The desktop shell is " &
      "plasmashell. The file manager is Dolphin.':''}"
    let envCount = replaceAllRegex(
      content,
      envPat,
      proc(m: RegexMatch): string =
        envNew,
    )
    if envCount == 2:
      echo &"  [OK] 14d CU env prompt: kwin-wayland-only KDE suffix ({envCount} occurrences)"
      inc changes, envCount
      inc patchesApplied
    else:
      echo &"  [FAIL] 14d CU env prompt: {envCount} environment sentence anchors, expected 2"

  # ─── Patch 15: accessibility tools (issue #306, js/cu_ax_tools.js) ────
  # Upstream's app-scoped AX tools (app_ax_find, app_click, ...) are darwin
  # only (`appScoped` is set by a darwin-gated flag). Ours reuse the names and
  # argument shapes, served by the bridges' ax-* subcommands. Every hook is
  # behind process.platform==="linux" and returns "nothing" while the switch is
  # off: no tool, an unchanged cache key, upstream's own dispatch.
  const SPLIT_MARK = "\n/*__CDB_SPLIT__"
  proc partOf(c: string, at: int): int =
    ## Start of the staged chunk part containing offset `at` (0 = the stub).
    let p = c.rfind(SPLIT_MARK, last = at)
    if p == -1: 0 else: p

  # 15a: tool builder tail `...t.appScoped?Pe(t.appScoped.supportsRawInput??!1,
  # t.platform):[]]}` -> also spread our tools. Same builder serves the local
  # computer-use server and the remote-devices bridge; the runtime leaves the
  # latter out (it passes saveToDisk:false).
  block:
    let pat =
      re"""(\.\.\.([\w$]+)\.appScoped\?[\w$]+\(\2\.appScoped\.supportsRawInput\?\?!1,\2\.platform\):\[\])\]\}"""
    let n = countMatches(content, pat)
    if n != 1:
      echo &"  [FAIL] 15a tool builder tail (`...t.appScoped?X(...):[]]}}`): {n} matches, expected 1"
    else:
      discard replaceFirst(
        content,
        pat,
        proc(m: RegexMatch): string =
          m.captures[0] & ",...(process.platform===\"linux\"&&globalThis.__cdbAxTools?.(" &
            m.captures[1] & ")||[])]}",
      )
      echo "  [OK] 15a tool builder: Linux accessibility tools appended (1 match)"
      inc changes
      inc patchesApplied

  # 15b: tools/list cache key `${flag()}:${teach()}:${opts().adaptiveResolution}`
  # -> also the switch, so a flip takes effect for the next session. "" while
  # off: the key is upstream's byte for byte.
  block:
    let pat =
      re"""(function [\w$]+\(\)\{let [\w$]+=`\$\{[\w$]+\(\)\}:\$\{[\w$]+(?:\.[\w$]+)?\(\)\}:\$\{[\w$]+(?:\.[\w$]+)?\(\)\.adaptiveResolution\})`;"""
    let n = countMatches(content, pat)
    if n != 1:
      echo &"  [FAIL] 15b tools/list cache key template: {n} matches, expected 1"
    else:
      discard replaceFirst(
        content,
        pat,
        proc(m: RegexMatch): string =
          m.captures[0] &
            "${process.platform===\"linux\"&&(globalThis.__cdbAxKey?.()||\"\")+(globalThis.__cdbCuConsent?.key?.()||\"\")||\"\"}`;",
      )
      echo "  [OK] 15b tools/list cache key: includes the accessibility and ask-before-control modes (1 match)"
      inc changes
      inc patchesApplied

  # 15c: teach mode's read-only set (a tool outside it counts as an action and
  # ends a teach step). app_ax_find / app_list_windows only read. Linux only:
  # on macOS upstream's own app_* tools keep upstream's classification.
  block:
    let pat =
      re"""(if\(([\w$]+)===(["`])computer_batch\3\)\{let ([\w$]+)=[\w$]+\.input\?\.actions;return Array\.isArray\(\4\)\?\4\.some\(\(?([\w$]+)=>typeof \5\?\.action==(["`])string\6&&!([\w$]+)\.has\(\5\.action\)\)\)?:!1\}return!)\7\.has\(\2\)\}"""
    let n = countMatches(content, pat)
    if n != 1:
      echo &"  [FAIL] 15c read-only tool set (computer_batch arm + `return!SET.has(name)}}`): {n} matches, expected 1"
    else:
      discard replaceFirst(
        content,
        pat,
        proc(m: RegexMatch): string =
          let nm = m.captures[1]
          m.captures[0] & "(" & m.captures[6] & ".has(" & nm &
            ")||process.platform===\"linux\"&&(" & nm & "===\"app_ax_find\"||" & nm &
            "===\"app_list_windows\"))}",
      )
      echo "  [OK] 15c read-only tool set: app_ax_find + app_list_windows on Linux (1 match)"
      inc changes
      inc patchesApplied

  # 15d: upstream's dispatch. Where upstream dispatches (kwin mode), our names
  # would hit its app_* branch, which needs executor.appScoped (darwin). Before
  # that branch, hand our tools to the runtime with the session's context (its
  # lastScreenshot), the session id (added to that context in the per-session
  # wrapper, which has it) and upstream's own tier check (`{error}` or
  # `{grant}`: read / click / full per tool). Upstream's earlier gates (no
  # grants, CU disabled, another session's lock) still run first.
  block:
    let sidPat =
      re"""(typingWaitAllowance:([\w$]+)\.getTypingWaitAllowance\?\.\(\),cuOnlyMode:\2\.cuOnlyMode)\}"""
    let tierPat =
      re"""function ([\w$]+)\(([\w$]+),([\w$]+),([\w$]+)\)\{let ([\w$]+)=\2\.allowedApps\.find\(\(?([\w$]+)=>\6\.bundleId===\3\)\)?;if\(!\5\)return \2\.policyDeniedBundleIds"""
    let qaPat =
      re"""(async function [\w$]+\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)\)\{let\{logger:[\w$]+,serverName:[\w$]+\}=\2,([\w$]+)=[\w$]+\(\5\);[\s\S]{0,1500}?,([\w$]+)=[\w$]+\(\4\);[\s\S]{0,1500}?if\(([\w$]+)\(\3\)\)\{)(let [\w$]+=\2\.executor\.appScoped;return )"""
    let nSid = countMatches(content, sidPat)
    let nTier = countMatches(content, tierPat)
    let nQa = countMatches(content, qaPat)
    if nSid != 1 or nTier != 1 or nQa != 1:
      echo &"  [FAIL] 15d dispatch anchors: session context {nSid}, tier check {nTier}, app_* branch {nQa} match(es), expected 1 each"
    else:
      let sidM = content.find(sidPat).get()
      let tierM = content.find(tierPat).get()
      let qaM = content.find(qaPat).get()
      let tierFn = tierM.captures[0]
      let eiFn = qaM.captures[7]
      # The app_* predicate must be upstream's: `function Ei(e){return
      # e==="app_release"||...`. And all three sites live in one chunk part:
      # the tier check is called by name, and the session id travels on the
      # context object the wrapper builds for this dispatch.
      let eiPat = re(
        "function " & escapeRe(eiFn) &
          """\(([\w$]+)\)\{return \1===(["`])app_release\2\|\|"""
      )
      let part = partOf(content, qaM.matchBounds.a)
      if countMatches(content, eiPat) != 1:
        echo &"  [FAIL] 15d app_* predicate {eiFn} is not upstream's app_release/app_* test"
      elif partOf(content, tierM.matchBounds.a) != part or
          partOf(content, sidM.matchBounds.a) != part:
        echo "  [FAIL] 15d dispatch, tier check and session context are not in one chunk part"
      else:
        let n1 = replaceFirst(
          content,
          sidPat,
          proc(m: RegexMatch): string =
            m.captures[0] & ",__cdbAxSid:process.platform===\"linux\"?" & m.captures[1] &
              ".sessionId:void 0}",
        )
        let n2 = replaceFirst(
          content,
          qaPat,
          proc(m: RegexMatch): string =
            let toolName = m.captures[2]
            let ctxVar = m.captures[5]
            let argsVar = m.captures[6]
            m.captures[0] &
              "if(process.platform===\"linux\"&&globalThis.__cdbAxHandles?.(" & toolName &
              "))return await globalThis.__cdbAxCall(" & toolName & "," & argsVar &
              ",{sid:" & ctxVar & ".__cdbAxSid,ctx:" & ctxVar & ",tier:(__cdbA,__cdbT)=>" &
              tierFn & "(" & ctxVar & ",__cdbA,__cdbT)});" & m.captures[8],
        )
        if n1 == 1 and n2 == 1:
          echo &"  [OK] 15d dispatch: Linux accessibility tools before upstream's app_* branch, tier check {tierFn} (2 sites)"
          inc changes, 2
          inc patchesApplied
        else:
          echo &"  [FAIL] 15d dispatch: {n1}/1 session context, {n2}/1 dispatch rewrites"

  # ─── Patch 16: per-app access follows the active backend ──────────────
  # Upstream answers "per app?" for its own Wayland portal executor: one shared
  # screen (`WO()`, the XDG_SESSION_TYPE Wayland check). Our bridges differ per
  # backend (kwin: native per-app; x11-bridge and wlroots-bridge on sway /
  # Hyprland: masked screenshots + hit test; GNOME, niri, fallback tools: the
  # whole screen). js/cu_consent.js answers from the live executor:
  # spSuffix() for the prompt text, globalThis.__cdbCuSharedScreen() for the
  # yes/no. Every hook is behind process.platform==="linux" and keeps
  # upstream's own answer when the helper is missing.

  # 16a: the system-prompt suffix after the tier rules (4.23118.1: `xe` in
  # index.chunk-D4NaWzj8.js, exported as `ct`; consumers: the local Cowork
  # computer_use / cu_only sections and the session server's request_access
  # result in that chunk, the local agent's canUseTool deny message in
  # index.chunk-DGosOwKd.js via `D.ct()`):
  #   function xe(){return t.X0()?`\n\nOn this system (a Linux Wayland session)
  #   those tiers apply to the whole shared screen at once ...`:""}
  # On Linux, a string from spSuffix() wins ("" in kwin mode); without it
  # upstream's text stays. Pre-assert: X0 resolves to the Wayland check.
  block:
    let pat =
      re"""(function ([\w$]+)\(\)\{)(return ([\w$]+)\.([\w$]+)\(\)\?([`"])\\n\\nOn this system \(a Linux Wayland session\) those tiers apply to the whole shared screen)"""
    var hits: seq[RegexMatch] = @[]
    for m in content.findIter(pat):
      hits.add m
    if hits.len != 1:
      echo &"  [FAIL] 16a prompt suffix (`function F(){{return t.X0()?\"\\n\\nOn this system (a Linux Wayland session) ...`): {hits.len} matches, expected 1"
    else:
      let h = hits[0]
      let fnName = h.captures[1]
      let (ps, pe) = partSpan(content, h.matchBounds.a)
      let file = requiredChunk(content[ps ..< pe], h.captures[3])
      let target = namedPart(content, file)
      let pred = exportTarget(target, h.captures[4])
      if pred == "" or waylandPredicateDefs(target, pred) != 1:
        echo &"  [FAIL] 16a prompt suffix {fnName}: {h.captures[3]}.{h.captures[4]}() does not resolve to the XDG_SESSION_TYPE Wayland check (chunk '{file}', local '{pred}') - re-audit"
      else:
        let n = replaceFirst(
          content,
          pat,
          proc(m: RegexMatch): string =
            m.captures[0] &
              "if(process.platform===\"linux\"){let __cdbSpx;try{__cdbSpx=globalThis.__cdbCuConsent?.spSuffix?.()}catch(__cdbSpe){}if(typeof __cdbSpx===\"string\")return __cdbSpx}" &
              m.captures[2],
        )
        if n == 1:
          echo &"  [OK] 16a prompt suffix: {fnName}() asks js/cu_consent.js spSuffix() on Linux ({h.captures[3]}.{h.captures[4]} = {pred}, 1 match)"
          inc changes
          inc patchesApplied
        else:
          echo "  [FAIL] 16a prompt suffix: replacement did not apply"

  # 16b: the supported-features entry (4.23118.1: in `jG`, index.chunk-
  # k6x_9PBk.js; read by the enable modal, Settings -> Computer use, the
  # approval card and the "Unhide apps" row):
  #   computerUsePerAppAccess:WO()?{status:"unsupported",reason:"A Wayland
  #   session shares the whole screen",unsupportedCode:"unknown"}:SG
  # The condition becomes __cdbCuSharedScreen() on Linux (X11 included: with
  # the ask switch off nothing is per app there either). Pre-assert: the
  # condition is the Wayland check.
  block:
    let pat =
      re"""computerUsePerAppAccess:([\w$]+)\(\)(\?\{status:"unsupported",reason:"A Wayland session shares the whole screen")"""
    var hits: seq[RegexMatch] = @[]
    for m in content.findIter(pat):
      hits.add m
    if hits.len != 1:
      echo &"  [FAIL] 16b computerUsePerAppAccess (`computerUsePerAppAccess:WO()?{{status:\"unsupported\",reason:\"A Wayland session shares the whole screen\"`): {hits.len} matches, expected 1"
    else:
      let cond = hits[0].captures[0]
      let (ps, pe) = partSpan(content, hits[0].matchBounds.a)
      if waylandPredicateDefs(content[ps ..< pe], cond) != 1:
        echo &"  [FAIL] 16b computerUsePerAppAccess: {cond}() is not the XDG_SESSION_TYPE Wayland check of its chunk - re-audit"
      else:
        let n = replaceFirst(
          content,
          pat,
          proc(m: RegexMatch): string =
            "computerUsePerAppAccess:(process.platform===\"linux\"&&typeof globalThis.__cdbCuSharedScreen===\"function\"?globalThis.__cdbCuSharedScreen():" &
              m.captures[0] & "())" & m.captures[1],
        )
        if n == 1:
          echo &"  [OK] 16b computerUsePerAppAccess: follows the active backend on Linux (upstream: {cond}(), 1 match)"
          inc changes
          inc patchesApplied
        else:
          echo "  [FAIL] 16b computerUsePerAppAccess: replacement did not apply"

  # 16c: upstream's supported-features broadcast (4.23118.1, k6x_9PBk):
  #   function RG(){for(let e of Usi)e()}
  #   function qsi(e){if(Usi.add(e),!Hsi){...}return()=>{Usi.delete(e)}}
  # qsi is onSupportedFeaturesInputsChanged; each window subscribes with
  # `()=>{e.isDestroyed()||t.dispatchSupportedFeaturesChanged()}` and the
  # renderer then fetches the features again. RG is exposed (Linux only) as
  # globalThis.__cdbCuFeaturesChanged, which js/cu_consent.js calls when the
  # 16b answer changed after the renderer read it (doctor reply, background
  # display, ask switch). Nothing is called here.
  block:
    let keyPat = re"""onSupportedFeaturesInputsChanged:\(\)=>([\w$]+)[,}]"""
    var keys: seq[string] = @[]
    for m in content.findIter(keyPat):
      keys.add m.captures[0]
    if keys.len != 1:
      echo &"  [FAIL] 16c onSupportedFeaturesInputsChanged namespace key: {keys.len} matches, expected 1"
    else:
      let sub = keys[0]
      let subPat =
        re("function " & escapeRe(sub) & """\(([\w$]+)\)\{if\(([\w$]+)\.add\(\1\),""")
      var sets: seq[string] = @[]
      for m in content.findIter(subPat):
        sets.add m.captures[1]
      if sets.len != 1:
        echo &"  [FAIL] 16c subscriber {sub}: `function {sub}(e){{if(S.add(e),` {sets.len} matches, expected 1"
      else:
        let firePat = re(
          """(?<=[;{}])(function ([\w$]+)\(\)\{for\(let ([\w$]+) of """ &
            escapeRe(sets[0]) & """\)\3\(\)\})"""
        )
        var fires: seq[RegexMatch] = @[]
        for m in content.findIter(firePat):
          fires.add m
        let listeners = countMatches(
          content,
          re"""\.isDestroyed\(\)\|\|[\w$]+\.dispatchSupportedFeaturesChanged\(\)""",
        )
        if fires.len != 1:
          echo &"  [FAIL] 16c broadcast over {sets[0]}: `function F(){{for(let e of {sets[0]})e()}}` {fires.len} matches, expected 1"
        elif listeners < 1:
          echo "  [FAIL] 16c no window listener calls dispatchSupportedFeaturesChanged() - re-audit"
        else:
          let fire = fires[0].captures[1]
          let n = replaceFirst(
            content,
            firePat,
            proc(m: RegexMatch): string =
              m.captures[0] &
                "process.platform===\"linux\"&&(globalThis.__cdbCuFeaturesChanged=" &
                m.captures[1] & ");",
          )
          if n == 1:
            echo &"  [OK] 16c features broadcast: {fire} (subscribers of {sub}) exposed as globalThis.__cdbCuFeaturesChanged on Linux (1 match)"
            inc changes
            inc patchesApplied
          else:
            echo "  [FAIL] 16c features broadcast: replacement did not apply"

  # 16d: the "Entire screen" pseudo-grant (4.23118.1: `ye` in D4NaWzj8, the
  # dispatch context's getAllowedApps):
  #   function ye(e,r){if(t.xF!==t.bF||e.some(e=>e.bundleId==="com.anthropic.cu.screen"))
  #   return e;...return[...e,{bundleId:t.mL,displayName:"Entire screen",...}]}
  # xF is PLATFORM_CAPABILITIES, bF the Wayland preset, so on every Wayland
  # session - kwin mode included, where upstream dispatches - the model's
  # list_granted_applications showed an "Entire screen" grant at the most
  # permissive tier. On Linux it is left out when __cdbCuNoScreenGrant() says
  # so (kwin mode, or "Ask before Computer Use controls an app" on in regular
  # mode: our gate refuses unapproved apps); it is only ever removed, never
  # added, and with the switch off upstream's rule is unchanged.
  block:
    let pat =
      re"""(function ([\w$]+)\(([\w$]+),[\w$]+\)\{if\()(([\w$]+)\.([\w$]+)!==\5\.([\w$]+)\|\|\3\.some\(\(?([\w$]+)=>\8\.bundleId===(["'`])com\.anthropic\.cu\.screen\9\)\)?\)return \3;)"""
    var hits: seq[RegexMatch] = @[]
    for m in content.findIter(pat):
      hits.add m
    if hits.len != 1:
      echo &"  [FAIL] 16d screen pseudo-grant (`function F(e,r){{if(t.A!==t.B||e.some(e=>e.bundleId===\"com.anthropic.cu.screen\"))return e;`): {hits.len} matches, expected 1"
    else:
      let h = hits[0]
      let fnName = h.captures[1]
      let tail =
        content[h.matchBounds.b + 1 ..< min(h.matchBounds.b + 600, content.len)]
      let (ps, pe) = partSpan(content, h.matchBounds.a)
      let file = requiredChunk(content[ps ..< pe], h.captures[4])
      let target = namedPart(content, file)
      let capsName = exportTarget(target, h.captures[5])
      let wlName = exportTarget(target, h.captures[6])
      let capsOk =
        capsName != "" and
        countMatches(
          target, re("PLATFORM_CAPABILITIES:\\(\\)=>" & escapeRe(capsName) & "[,}]")
        ) == 1
      let wlOk =
        wlName != "" and
        countMatches(
          target,
          re(
            "(?<![\\w$.])" & escapeRe(wlName) &
              """=\{screenshotFiltering:"none",platform:"linux",hitTest:"none"\}"""
          ),
        ) == 1
      if not tail.contains(re"""displayName:(["'`])Entire screen\1"""):
        echo &"  [FAIL] 16d screen pseudo-grant {fnName}: no `displayName:\"Entire screen\"` after the guard - re-audit"
      elif not capsOk or not wlOk:
        echo &"  [FAIL] 16d screen pseudo-grant {fnName}: {h.captures[4]}.{h.captures[5]} / .{h.captures[6]} are not PLATFORM_CAPABILITIES / the Wayland preset (chunk '{file}': '{capsName}' / '{wlName}') - re-audit"
      else:
        let n = replaceFirst(
          content,
          pat,
          proc(m: RegexMatch): string =
            m.captures[0] &
              "process.platform===\"linux\"&&globalThis.__cdbCuNoScreenGrant?.()===!0||" &
              m.captures[3],
        )
        if n == 1:
          echo &"  [OK] 16d screen pseudo-grant: {fnName} leaves \"Entire screen\" out on Linux in kwin mode and while ask-before-control is on (1 match)"
          inc changes
          inc patchesApplied
        else:
          echo "  [FAIL] 16d screen pseudo-grant: replacement did not apply"

  # 16e: the enable-prompt approval card (CU available but not yet enabled:
  # the session server's request_access and the local agent's canUseTool,
  # 4.23118.1 D4NaWzj8 / DGosOwKd) is built from the static preset:
  #   {...,screenshotFiltering:t.xF.screenshotFiltering,[hostPlatform:t.xF.platform,]
  #   featureDisabled:!0,...}
  # 2b pins that preset to "none" on Linux, and with "none" + hostPlatform
  # "linux" the card tells the user "Claude will be able to see your entire
  # screen and click or type in any app on it. On this system, Claude's access
  # can't be limited to the apps or levels listed here." - false where access
  # is per app. On Linux, when __cdbCuSharedScreen() says so, the card gets
  # the live executor's value (exec-free getter: "mask" on a masking bridge,
  # "native" in kwin mode), the same value upstream's regular request_access
  # card already reads; otherwise upstream's preset value stays.
  # Anchor: both sites (2); the preset must be PLATFORM_CAPABILITIES.
  block:
    let pat =
      re"""screenshotFiltering:(([\w$]+)\.([\w$]+)\.screenshotFiltering),((?:hostPlatform:\2\.\3\.platform,)?featureDisabled:!0)"""
    var hits: seq[RegexMatch] = @[]
    for m in content.findIter(pat):
      hits.add m
    var bad = ""
    for h in hits:
      let (ps, pe) = partSpan(content, h.matchBounds.a)
      let file = requiredChunk(content[ps ..< pe], h.captures[1])
      let target = namedPart(content, file)
      let capsName = exportTarget(target, h.captures[2])
      if capsName == "" or
          countMatches(
            target, re("PLATFORM_CAPABILITIES:\\(\\)=>" & escapeRe(capsName) & "[,}]")
          ) != 1:
        bad = h.captures[0]
    if hits.len != 2:
      echo &"  [FAIL] 16e enable card (`screenshotFiltering:t.xF.screenshotFiltering,...featureDisabled:!0`): {hits.len} matches, expected 2"
    elif bad != "":
      echo &"  [FAIL] 16e enable card: {bad} is not PLATFORM_CAPABILITIES.screenshotFiltering - re-audit"
    else:
      let n = replaceAllRegex(
        content,
        pat,
        proc(m: RegexMatch): string =
          "screenshotFiltering:(process.platform===\"linux\"&&globalThis.__cdbCuSharedScreen?.()===!1?globalThis.__linuxExecutor?.capabilities?.screenshotFiltering??\"mask\":" &
            m.captures[0] & ")," & m.captures[3],
      )
      if n == 2:
        echo "  [OK] 16e enable card: screenshot filtering follows the active backend on Linux (2 sites)"
        inc changes, 2
        inc patchesApplied
      else:
        echo &"  [FAIL] 16e enable card: {n}/2 rewrites"

  # ─── Patch 17c: Stop sharing stops the running turn ───────────────────
  # Upstream (4.23118.1, index.chunk-k6x_9PBk.js):
  #   function rbi(){fJ&&abi(fJ,"[cu-wayland] user stopped sharing")}
  # abi stops the CU lock holder and every app-mode holder through the callback
  # main's view registers (fJ, the same one upstream's Escape uses). Upstream
  # hands rbi to its native portal binding (`Ei()?.cuWaylandOnShareEnded?.(rbi)`,
  # in a function that runs once at module load on Wayland only), which never
  # fires: our bridges run Computer Use. rbi is exposed as
  # globalThis.__cdbCuShareEnded right after its declaration (module load,
  # every session type); the gnome / kwin executors call it the moment the
  # bridge's stopped-by-user marker appears (js/cu_share_stop.js). The
  # cuWaylandOnShareEnded site must still pass rbi (fail loud otherwise).
  # 17c: upstream's "user stopped sharing" abort, exposed at its declaration.
  block:
    let sitePat = re"""\.cuWaylandOnShareEnded\?\.\(([\w$]+)\)"""
    var sites: seq[string] = @[]
    for m in content.findIter(sitePat):
      sites.add m.captures[0]
    if sites.len != 1:
      echo &"  [FAIL] 17c `.cuWaylandOnShareEnded?.(F)`: {sites.len} matches, expected 1 - re-audit"
    else:
      let fn = sites[0]
      let defPat = re(
        "(?<=[;}])(function " & escapeRe(fn) &
          """\(\)\{([\w$]+)&&[\w$]+\(\2,(["'`])\[cu-wayland\] user stopped sharing\3\)\})"""
      )
      let defHits = countMatches(content, defPat)
      if defHits != 1:
        echo &"  [FAIL] 17c share-ended abort {fn}: `function {fn}(){{A&&abort(A,\"[cu-wayland] user stopped sharing\")}}` {defHits} matches, expected 1 - re-audit"
      else:
        let n = replaceFirst(
          content,
          defPat,
          proc(m: RegexMatch): string =
            m.captures[0] &
              "process.platform===\"linux\"&&(globalThis.__cdbCuShareEnded=" & fn & ");",
        )
        if n == 1:
          echo &"  [OK] 17c share-ended abort: {fn} (handed to cuWaylandOnShareEnded) exposed as globalThis.__cdbCuShareEnded on Linux (1 match)"
          inc changes
          inc patchesApplied
        else:
          echo "  [FAIL] 17c share-ended abort: replacement did not apply"

  # ─── Patch 17e: a model Escape is expected, as upstream marks its own ──
  # Upstream (4.23118.1, index.chunk-k6x_9PBk.js):
  #   var mJ=0;function ebi(){mJ++,setTimeout((()=>{mJ>0&&mJ--}),100)}
  #   async function tbi(){return ebi(),()=>void 0}
  #   function nbi(){if(mJ>0){mJ--,P.debug("[cu-esc] escape absorbed
  #     (model-synthesized)");return}ibi()}
  #   async function bbi(e,t){let n=vbi(e)?await tbi():()=>void 0;...}
  # Upstream's own executor wraps each key / holdKey whose keys are exactly
  # one Escape in bbi, which bumps mJ for 100 ms, so its X11 Escape grab (nbi)
  # absorbs that press. Our executors bypass that wrapper: ebi is exposed as
  # globalThis.__cdbCuExpectEscape right after its declaration (Linux only)
  # and the executors call it right before they inject a lone Escape. Nothing
  # is called here. Pre-assert: the grab handler with the `[cu-esc] escape
  # absorbed` branch decrements the same counter.
  block:
    let pat =
      re"""(?<=[;}])(function ([\w$]+)\(\)\{([\w$]+)\+\+,setTimeout\(\(?\(\)=>\{\3>0&&\3--\}\)?,100\)\})"""
    var hits: seq[RegexMatch] = @[]
    for m in content.findIter(pat):
      hits.add m
    if hits.len != 1:
      echo &"  [FAIL] 17e expected-Escape marker (`function F(){{N++,setTimeout((()=>{{N>0&&N--}}),100)}}`): {hits.len} matches, expected 1 - re-audit"
    else:
      let fn = hits[0].captures[1]
      let counter = hits[0].captures[2]
      let absorbHits = countMatches(
        content,
        re(
          """function [\w$]+\(\)\{if\(""" & escapeRe(counter) & """>0\)\{""" &
            escapeRe(counter) & """--,[\w$]+\.debug\((["'`])\[cu-esc\] escape absorbed"""
        ),
      )
      if absorbHits != 1:
        echo &"  [FAIL] 17e expected-Escape marker {fn}: the `[cu-esc] escape absorbed` handler does not read {counter} ({absorbHits} matches, expected 1) - re-audit"
      else:
        let n = replaceFirst(
          content,
          pat,
          proc(m: RegexMatch): string =
            m.captures[0] &
              "process.platform===\"linux\"&&(globalThis.__cdbCuExpectEscape=" & fn &
              ");",
        )
        if n == 1:
          echo &"  [OK] 17e expected-Escape marker: {fn} (counter {counter}, read by the grab handler) exposed as globalThis.__cdbCuExpectEscape on Linux (1 match)"
          inc changes
          inc patchesApplied
        else:
          echo "  [FAIL] 17e expected-Escape marker: replacement did not apply"

  if patchesApplied < EXPECTED_PATCHES:
    raise newException(
      ValueError,
      &"Only {patchesApplied}/{EXPECTED_PATCHES} patches applied — check [FAIL] messages above",
    )

  # Post-condition: every end state is present exactly as often as expected.
  for mk in markers:
    let n = countMatches(content, mk.pat)
    if n != mk.expected:
      raise newException(
        ValueError,
        &"  [FAIL] post-condition: end-state marker '{mk.name}' has {n} matches after patching, expected {mk.expected}",
      )

  if content != original:
    echo &"  [PASS] {patchesApplied}/{EXPECTED_PATCHES} sub-patches applied ({changes} content changes, {markers.len} end states verified)"
  else:
    raise newException(ValueError, "No changes made")

  return content

when isMainModule:
  if paramCount() != 1:
    stderr.writeLine "Usage: fix_computer_use_linux <path_to_index.js>"
    quit(1)
  let file = paramStr(1)
  echo "=== Patch: fix_computer_use_linux ==="
  echo &"  Target: {file}"
  let input = readFile(file)
  let output = apply(input)
  if output != input:
    writeFile(file, output)
