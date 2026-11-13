# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
# Jira issue tracker over the main window's content area, behind the Community switch jiraTracker.
# Sub-patches A-C and every anchor: baseline/JIRA_TRACKER_ANCHORS.md.

import std/[json, os, strutils]
import regex

const
  ADF_JS = staticRead("../../js/jira_tracker_adf.js")
  CLIENT_JS = staticRead("../../js/jira_tracker_client.js")
  STORE_JS = staticRead("../../js/jira_tracker_store.js")
  PROMPT_JS = staticRead("../../js/jira_tracker_prompt.js")
  SEND_JS = staticRead("../../js/jira_tracker_send.js")
  VIEW_JS = staticRead("../../js/jira_tracker_view.js")
  MAIN_JS = staticRead("../../js/jira_tracker_main.js")
  PAGE_HTML = staticRead("../../js/jira_tracker_page.html")
  PAGE_JS = staticRead("../../js/jira_tracker_page.js")
  PRELOAD_JS = staticRead("../../js/jira_tracker_preload.js")
  WEB_JS = staticRead("../../js/jira_tracker_web_page.js")
  MARKER = "/*__CDB_JIRA_TRACKER__*/"
  SESSIONS = "globalThis.__cdbJiraSessions="
  ATTACHED = "globalThis.__cdbJiraOnNativeViewAttached="
  STRICT = "\"use strict\";"
  SPLIT = "\n/*__CDB_SPLIT__"
  EXPECTED_PATCHES = 3 # A module, B session manager, C native view attach

let sessionsKeyRe = re2"""getClaudeCodeSessionManager:\(\)=>([\w$]+)"""
let sessionsDefRe =
  re2"""async function ([\w$]+)\(\)\{if\(([\w$]+)\)return ([\w$]+);let\{claudeCodeSessionManager:([\w$]+)\}=await """
let attachKeyRe = re2"""onNativeViewAttached:\(\)=>([\w$]+)"""
let attachDefRe =
  re2"""function ([\w$]+)\(([\w$]+)\)\{return ([\w$]+)\.add\(([\w$]+)\),\(\)=>\{([\w$]+)\.delete\(([\w$]+)\)\}\}"""
let endStateRe = re2"""globalThis\.__cdbJira(Sessions|OnNativeViewAttached)=[\w$]+;"""

proc fail(msg: string) {.noreturn.} =
  echo "  [FAIL] jira tracker: " & msg
  quit(1)

proc slot(main: var string, name, value: string) =
  let quoted = "\"" & name & "\""
  if main.count(quoted) != 1:
    fail("js/jira_tracker_main.js must carry " & quoted & " exactly once")
  main = main.replace(quoted, escapeJson(value))

proc module(): string =
  if (ADF_JS & PAGE_JS).toLowerAscii.contains("</script"):
    fail("the page script must not contain </script")
  var main = MAIN_JS
  slot(main, "__CDB_JIRA_PAGE_HTML__", PAGE_HTML)
  slot(main, "__CDB_JIRA_PAGE_JS__", PAGE_JS)
  slot(main, "__CDB_JIRA_ADF_SRC__", ADF_JS)
  slot(main, "__CDB_JIRA_PRELOAD__", PRELOAD_JS)
  slot(main, "__CDB_JIRA_WEB_SRC__", WEB_JS)
  result = ADF_JS & CLIENT_JS & STORE_JS & PROMPT_JS & SEND_JS & VIEW_JS & main
  if result.count(MARKER) != 1:
    fail("the module must carry " & MARKER & " exactly once")
  if result.findAll(endStateRe).len != 0:
    fail("the module contains a capture end-state shape; B or C would read it as present")

proc partOf(s: string, at: int): Slice[int] =
  let before = s.rfind(SPLIT, last = at)
  let first = if before < 0: 0 else: s.find("__*/\n", before) + 5
  let after = s.find(SPLIT, at)
  first .. (if after < 0: s.high else: after - 1)

proc locate(s: string, keyRe: Regex2, prefix, suffix, what: string): (string, int) =
  let keys = s.findAll(keyRe)
  if keys.len != 1:
    fail(what & " export found " & $keys.len & " times; re-audit")
  let name = s[keys[0].group(0)]
  let part = partOf(s, keys[0].boundaries.a)
  let text = s[part]
  let head = prefix & name & suffix
  if text.count(head) != 1:
    fail(what & " " & name & " is defined " & $text.count(head) & " times in its chunk; re-audit")
  (name, part.a + text.find(head))

proc groupsAt(
    s: string, at, span, n: int, pattern: Regex2, what: string
): (seq[string], int) =
  let tail = s[at ..< min(s.len, at + span)]
  let hits = tail.findAll(pattern)
  if hits.len == 0 or hits[0].boundaries.a != 0:
    fail(what & " changed shape; re-audit")
  var groups: seq[string]
  for i in 0 ..< n:
    groups.add tail[hits[0].group(i)]
  (groups, hits[0].boundaries.b + 1)

proc patchA(s: var string, code: string): bool =
  let n = s.count(MARKER)
  if n == 1 and s.count(code) == 1:
    echo "  [OK] A module already present (idempotent)"
    return true
  if n != 0:
    fail("A: a module marker is present but not this build's module; rebuild from a pristine extract")
  if s.startsWith(STRICT):
    s = STRICT & code & s[STRICT.len .. ^1]
  else:
    s = code & s
  if s.count(MARKER) != 1 or s.count(code) != 1:
    fail("A: module not present after injection")
  echo "  [OK] A module injected"

proc patchB(s: var string): bool =
  let (name, at) =
    locate(s, sessionsKeyRe, "async function ", "(){", "B: getClaudeCodeSessionManager")
  let (g, _) = groupsAt(s, at, 400, 4, sessionsDefRe, "B: accessor " & name)
  if g[0] != name or g[1] != g[2]:
    fail("B: accessor " & name & " changed shape; re-audit")
  let stmt = SESSIONS & name & ";"
  let n = s.count(SESSIONS)
  if n == 1 and at >= stmt.len and s[at - stmt.len ..< at] == stmt:
    echo "  [OK] B session-manager accessor already captured (idempotent)"
    return true
  if n != 0:
    fail("B: another session-manager capture is present; rebuild from a pristine extract")
  if at == 0 or s[at - 1] notin {'}', ';'}:
    fail("B: the accessor no longer starts a statement; re-audit")
  s = s[0 ..< at] & stmt & s[at .. ^1]
  echo "  [OK] B session-manager accessor captured"

proc patchC(s: var string): bool =
  let (name, at) =
    locate(s, attachKeyRe, "function ", "(", "C: onNativeViewAttached")
  let (g, size) = groupsAt(s, at, 200, 6, attachDefRe, "C: registry " & name)
  if g[0] != name or g[1] != g[3] or g[1] != g[5] or g[2] != g[4]:
    fail("C: registry " & name & " changed shape; re-audit")
  let stop = at + size
  let stmt = ATTACHED & name & ";"
  let n = s.count(ATTACHED)
  if n == 1 and s.continuesWith(stmt, stop):
    echo "  [OK] C native-view attach registry already captured (idempotent)"
    return true
  if n != 0:
    fail("C: another native-view capture is present; rebuild from a pristine extract")
  s = s[0 ..< stop] & stmt & s[stop .. ^1]
  echo "  [OK] C native-view attach registry captured"

proc apply*(input: string): string =
  result = input
  let code = module()
  var applied = 0
  let a = patchA(result, code)
  inc applied
  let b = patchB(result)
  inc applied
  let c = patchC(result)
  inc applied
  if a != b or a != c:
    fail(
      "partial injection (A " & $a & ", B " & $b & ", C " & $c &
        "); rebuild from a pristine extract"
    )
  if applied < EXPECTED_PATCHES:
    echo "  [FAIL] Only " & $applied & "/" & $EXPECTED_PATCHES & " patches applied"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    quit("Usage: add_feature_jira_tracker <path_to_index.js>", 1)
  let file = paramStr(1)
  if not fileExists(file):
    quit("  [FAIL] File not found: " & file, 1)
  let input = readFile(file)
  let output = apply(input)
  if output != input:
    writeFile(file, output)
  echo "  [PASS] Jira issue tracker"
