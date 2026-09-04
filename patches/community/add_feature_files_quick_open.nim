# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Files quick open - main-process half. Two sub-patches:
#   A) injects js/files_quick_open_main.js with the page module
#      (js/files_quick_open_page.js) embedded, at the head of the bundle;
#   B) makes the generic utility-process host fork its workers with main's LIVE
#      environment, which is what carries the CDB_FILES_QUICK_OPEN gate to the
#      file-index worker.
# Counterparts: patches/community/add_feature_files_quick_open_bridge.nim
# (preload) and patches/community/add_feature_files_quick_open_worker.nim
# (file index).
#
# WHY SUB-PATCH B (measured live on 1.40609.0, 2026-08-29): Electron's
# utilityProcess.fork() with no `env` option does NOT hand the child the parent's
# live process.env - it hands it the browser process's INITIAL environment. The
# main half sets process.env.CDB_FILES_QUICK_OPEN at runtime, so with upstream's
# default the key was absent from every utility process (/proc/<pid>/environ: 2062
# entries in main, 2031-2064 in the workers, the key in none of them) and the
# spaces fix silently stayed off while every build check was green. Upstream's own
# MCP host passes `env:` explicitly for exactly this reason. So we pass it too, at
# the ONE generic worker-host fork site: every worker that host spawns (file-index,
# transcript-search, heavy-work, stall-sampler, ...) now inherits main's live env -
# which is what the default was assumed to do anyway.
#
# What that widens: `Object.assign({},process.env)` forwards not just our gate but
# everything upstream itself writes into main's env after startup - measured on
# 1.37937.3: `CLAUDE_CODE_SESSION_ACCESS_TOKEN` and `CLAUDE_CONFIG_DIR` - to all
# four of those workers, which the initial-env default did not. Same user, same
# app, same trust domain (no process/user boundary is crossed), so this is an
# exposure-surface widening rather than a boundary crossing; noted here because
# it is the one behavioural side effect of B beyond the gate it was written for.
#
# The other three fork sites in the bundle are NOT touched and cannot match this
# anchor: `Claude Desktop Shell Environment Extractor` (no stdio option), the MCP
# host (`{...a,env:s}` - already passes env), and the pty host.
#
# Break risk: VERY LOW for A (stable head-of-bundle anchor, no regex on minified
# code); LOW for B (minified identifiers are wildcards, string quotes are a
# ["`] class; the anchor is the serviceName+stdio option shape and must match
# exactly once - see
# baseline/FILES_QUICK_OPEN_ANCHORS.md for the grep recipe). The page half keys
# off remote claude.ai DOM and fiber props and degrades to a no-op on a redeploy.

import std/[os, strutils]
import regex

const MAIN_JS = staticRead("../../js/files_quick_open_main.js")
const PAGE_JS = staticRead("../../js/files_quick_open_page.js")
const MARKER = "__CDB_FILES_QUICK_OPEN__"
const PLACEHOLDER = "\"__CDB_QOPEN_PAGE_SRC__\""
const EXPECTED_PATCHES = 2 # A: page/main injection, B: worker-host env passthrough

# Sub-patch B, exactly one occurrence in the staged stub+chunks bundle
# (1.46388.2 shape; 1.40609.0 emitted the same call with backtick strings):
#   utilityProcess.fork(r,[],{serviceName:t,stdio:"pipe"})
# The string quote style flips between minifier releases, so it is matched with
# the quote-agnostic ["`] class and re-emitted as captured.
# Groups: 0 = the worker bundle path, 1 = the service name, 2 = the quote char.
let forkRe =
  re2"""utilityProcess\.fork\(([\w$]+),\[\],\{serviceName:([\w$]+),stdio:(["`])pipe["`]\}\)"""
# Our injected end-state, asserted positively (Rule 6) rather than inferred from
# the absence of the pre-patch shape. Quote-agnostic for the same reason.
let forkEndStateRe =
  re2"""stdio:["`]pipe["`],env:Object\.assign\(\{\},process\.env\)\}"""

proc endStateCount(s: string): int =
  s.findAll(forkEndStateRe).len

proc escapeJs(s: string): string =
  result = s
  result = result.replace("\\", "\\\\")
  result = result.replace("\"", "\\\"")
  result = result.replace("\n", "\\n")
  result = result.replace("\r", "")

proc buildInjection(): string =
  if PLACEHOLDER notin MAIN_JS:
    raise
      newException(ValueError, "files_quick_open_main.js lost its page-src placeholder")
  let pageSrc =
    PAGE_JS & "\n;\nif(window.__cdbQuickOpenPage)window.__cdbQuickOpenPage.start();\n"
  MAIN_JS.replace(PLACEHOLDER, "\"" & escapeJs(pageSrc) & "\"")

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0

  # --- A: inject the main-process half (with the page module embedded) ---------
  # Idempotency: positive end-state assertion (Rule 6).
  if MARKER in result:
    echo "  [OK] files quick open: injection already present (idempotent)"
    inc patchesApplied
  else:
    let injection = buildInjection()
    let strictPrefix = "\"use strict\";"
    if result.startsWith(strictPrefix):
      result = strictPrefix & injection & result[strictPrefix.len .. ^1]
      echo "  [OK] files quick open injected after \"use strict\""
    else:
      result = injection & result
      echo "  [OK] files quick open prepended"
    if MARKER notin result:
      echo "  [FAIL] files quick open: injection not present after patching"
    else:
      inc patchesApplied

  # --- B: pass main's live env to the generic worker host ----------------------
  let already = endStateCount(result)
  if already == 1:
    echo "  [OK] files quick open: worker host already forks with main's env (idempotent)"
    inc patchesApplied
  elif already > 1:
    echo "  [FAIL] files quick open: worker-host env passthrough present " & $already &
      " times, expected 1 - re-audit"
  else:
    var count = 0
    result = result.replace(
      forkRe,
      proc(m: RegexMatch2, s: string): string =
        inc count
        let q = s[m.group(2)]
        "utilityProcess.fork(" & s[m.group(0)] & ",[],{serviceName:" & s[m.group(1)] &
          ",stdio:" & q & "pipe" & q & ",env:Object.assign({},process.env)})",
    )
    if count != 1:
      echo "  [FAIL] files quick open: expected exactly 1 generic worker-host fork site, found " &
        $count &
        " - the CDB_FILES_QUICK_OPEN gate would never reach the file-index worker; re-audit"
    elif endStateCount(result) != 1:
      echo "  [FAIL] files quick open: worker-host env passthrough absent after patching"
    else:
      echo "  [OK] files quick open: worker host now forks with main's env"
      inc patchesApplied

  if patchesApplied < EXPECTED_PATCHES:
    echo "  [FAIL] Only " & $patchesApplied & "/" & $EXPECTED_PATCHES &
      " patches applied"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_feature_files_quick_open <path_to_index.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: add_feature_files_quick_open ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] files quick open applied"
  else:
    if MARKER notin output or endStateCount(output) != 1:
      echo "  [FAIL] No changes made and the end-state is absent"
      quit(1)
    echo "  [OK] Already applied (no changes needed)"
