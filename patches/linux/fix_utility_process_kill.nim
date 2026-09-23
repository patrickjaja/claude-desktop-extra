# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Fix UtilityProcess not terminating on app exit.
#
# When using the integrated Node.js server for MCP, the fallback kill
# after SIGTERM timeout sends another SIGTERM instead of SIGKILL,
# causing the process to remain alive and preventing app exit.
#
# Note: "utiltiy" and "proccess" are typos in the original Anthropic code.

import std/[os, strutils]
import regex

# Positive end-state assertions (Rule 6): our signal parameter threaded through
# the kill helper, and our "SIGKILL" argument at the timeout-fallback call site
# that the `Killing utiltiy proccess again` log pins.
const AppliedDefPattern =
  re2"""killOrDeferToSpawn\([\w$]+,__cdbSig\)\{return [\w$]+\.kill\(__cdbSig\)"""
const AppliedCallPattern =
  re2"""killOrDeferToSpawn\([\w$]+,"SIGKILL"\),[\w$]+(?:\.[\w$]+)*\.info\(`Killing utiltiy proccess again"""

const ExpectedPatches = 2

proc apply*(input: string): string =
  if input.contains(AppliedDefPattern) and input.contains(AppliedCallPattern):
    echo "  [OK] UtilityProcess SIGKILL fix: already applied (idempotent)"
    return input

  # Shape history of the 5-second timeout fallback in _close():
  #   v1.9659.4:   const a=(s=this.process)==null?void 0:s.kill();te.info(`Killing utiltiy proccess again
  #   v1.11187.4:  const r=(n=this.process)==null?void 0:n.kill();r&&this.noteKillOnce(),D.info(`Killing utiltiy proccess again
  #   v1.26832.0:  let t=this.process?.kill();t&&this.noteKillOnce(),r.o.info(`Killing utiltiy proccess again
  #   v1.32352.1:  upstream hoisted the kill into a method used by every kill
  #   site (first graceful kill in _close, intentional-close kills during
  #   start/spawn-timeout, AND the timeout fallback):
  #     killOrDeferToSpawn(e){return e.kill()?(this.noteKillOnce(),!0):!this.killDeferredProcs.has(e)&&(...,e.once(`spawn`,(()=>{e.kill()&&this.noteKillOnce()})),!1)}
  #     ...
  #     let n=setTimeout((()=>{D.warn(`UtilityProcess did not exit gracefully, killing... id=${...}`),this.killOrDeferToSpawn(e),D.info(`Killing utiltiy proccess again: id=${...}`),t()}),5e3);
  #   The method still calls plain e.kill(), so the fallback is still not a
  #   SIGKILL. Two coordinated sub-patches restore the fix without touching
  #   the graceful kills:
  #     1. thread a signal parameter through the method:
  #          killOrDeferToSpawn(e,__cdbSig){return e.kill(__cdbSig)?...
  #        (one-arg callers pass undefined -> default graceful kill, unchanged;
  #        the deferred-to-spawn retry inside the method stays graceful too)
  #     2. pass "SIGKILL" at the timeout-fallback call site only, pinned by the
  #        adjacent `Killing utiltiy proccess again` log call.
  var patchesApplied = 0

  # --- Sub-patch 1: signal parameter on the kill helper ---
  let defPattern =
    re2"""(killOrDeferToSpawn\()([\w$]+)(\)\{return )([\w$]+)\.kill\(\)\?"""
  var defCount = 0
  result = input.replace(
    defPattern,
    proc(m: RegexMatch2, s: string): string =
      let param = s[m.group(1)]
      let obj = s[m.group(3)]
      if param != obj:
        # kill() target is not the method's parameter -- shape drifted; re-emit
        # the match untouched so the count stays 0 and we fail loudly.
        return s[m.group(0)] & param & s[m.group(2)] & obj & ".kill()?"
      inc defCount
      s[m.group(0)] & param & ",__cdbSig" & s[m.group(2)] & obj & ".kill(__cdbSig)?",
  )
  if defCount == 1:
    echo "  [OK] killOrDeferToSpawn signal parameter: 1 match"
    inc patchesApplied
  else:
    echo "  [FAIL] killOrDeferToSpawn definition pattern: " & $defCount &
      " matches, expected 1"

  # --- Sub-patch 2: SIGKILL at the timeout-fallback call site ---
  let callPattern =
    re2"""(this\.killOrDeferToSpawn\()([\w$]+)\)(,[\w$]+(?:\.[\w$]+)*\.info\(`Killing utiltiy proccess again)"""
  var callCount = 0
  result = result.replace(
    callPattern,
    proc(m: RegexMatch2, s: string): string =
      inc callCount
      s[m.group(0)] & s[m.group(1)] & ""","SIGKILL")""" & s[m.group(2)],
  )
  if callCount == 1:
    echo "  [OK] fallback call site SIGKILL: 1 match"
    inc patchesApplied
  else:
    if "Killing utiltiy proccess again" in input:
      echo "  [INFO] Found 'Killing utiltiy proccess again' string in file"
    echo "  [FAIL] UtilityProcess fallback kill pattern: " & $callCount &
      " matches, expected 1"

  if patchesApplied < ExpectedPatches:
    echo "  [FAIL] Only " & $patchesApplied & "/" & $ExpectedPatches &
      " sub-patches applied (may need pattern update)"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_utility_process_kill <file>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_utility_process_kill ==="
  echo "  Target: " & filePath
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
  echo "  [PASS] UtilityProcess kill patched successfully"
