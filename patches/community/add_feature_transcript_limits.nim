# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Load large sessions in full - opt-in, off by default.
#
# Upstream's session manager (the `[CCD]` class that logs "transcript is N bytes;
# tail-loading last 52428800 bytes") loads only the LAST 50 MiB of a session's
# transcript, plus ONE shared 32 MiB for all of the session's subagent
# transcripts, and hides the rest behind "Earlier messages aren't shown. This
# session is too large to load in full." / "Some agent activity isn't shown.
# ...". Sessions with many inline browser screenshots reach that within hours
# (a screenshot is ~0.4 MB of base64; the main transcript stores each tool result
# twice, subagent transcripts once, so 60-80 of them reach a limit).
#
# The class already takes an optional `loadLimits` config object, merged over its
# own defaults (`this.limits={...defaults,...loadLimits}`) and also read by
# predictTranscriptTruncation, which decides whether the "too large" notice is
# shown BEFORE the load runs. Nothing in the app ever passes it. This patch does,
# and only when the user opted in; with the switch off the value is undefined and
# every upstream number, including any Anthropic changes in future, stays as
# shipped. That is why this feeds Anthropic's own hook instead of rewriting the
# number literals: one semantic change, no tracking of upstream's values.
#
#   A. inject js/transcript_limits_main.js (pref, derivation, IPC, worker env)
#   C. `new <Manager>({onTranscriptTruncatedChanged:` ->
#      `new <Manager>({loadLimits:globalThis.__cdbTranscriptLimits?.(),onTranscriptTruncatedChanged:`
#      at BOTH construction sites (the session manager, and the sidebar's
#      lightweight reader, whose truncation callback is a no-op).
#
# The worker's own copy of the limits object is
# add_feature_transcript_limits_worker.nim (one target per patch file).
#
# PRECONDITION, not a sub-patch: the heavy-work utility process only sees
# CDB_TRANSCRIPT_LIMITS if the generic worker host forks with main's live env
# (utilityProcess.fork() with no `env` hands the child the browser process's
# INITIAL environment). That change is owned by add_feature_files_quick_open.nim
# sub-patch B, which runs first in basename order; carrying a copy here would make
# this patch take an "already" branch on a pristine bundle, and the absorption
# probe blocks that. So it is asserted instead, and the build fails loudly if the
# pass-through is ever missing, e.g. if that patch is dropped. The pinned shape is
#   utilityProcess.fork(r,[],{serviceName:t,stdio:"pipe",env:Object.assign({},process.env)})
#
# Break risk: LOW. A has a stable head-of-bundle anchor; the precondition pins the
# fork site's end state (exactly one); C anchors on a config
# PROPERTY name (`onTranscriptTruncatedChanged:`), which survives minification
# where identifiers do not. C is pinned to exactly two sites: a third (or a
# renamed option) fails the build rather than silently skipping a manager.

import std/[os, strutils]
import regex

const MAIN_JS = staticRead("../../js/transcript_limits_main.js")
const MARKER = "__CDB_TRANSCRIPT_LIMITS__"
const EXPECTED_PATCHES = 2
  # A: main-process half, C: loadLimits hook (B is a precondition)
const CTOR_SITES = 2

# The precondition's end state (written by add_feature_files_quick_open.nim
# sub-patch B). Quote-agnostic: the style flips between minifier releases.
let forkEndStateRe =
  re2"""stdio:["`]pipe["`],env:Object\.assign\(\{\},process\.env\)\}"""

# Sub-patch C. Group 0 = `new <id>.<id>({`.
let ctorRe = re2"""(new [\w$.]+\(\{)onTranscriptTruncatedChanged:"""
let ctorEndRe =
  re2"""new [\w$.]+\(\{loadLimits:globalThis\.__cdbTranscriptLimits\?\.\(\),onTranscriptTruncatedChanged:"""

proc forkEndStateCount(s: string): int =
  s.findAll(forkEndStateRe).len

proc ctorEndStateCount(s: string): int =
  s.findAll(ctorEndRe).len

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0

  # --- A: inject the main-process half -------------------------------------------
  # Idempotency: positive end-state assertion (Rule 6).
  if MARKER in result:
    echo "  [OK] transcript limits: injection already present (idempotent)"
    inc patchesApplied
  else:
    let strictPrefix = "\"use strict\";"
    if result.startsWith(strictPrefix):
      result = strictPrefix & MAIN_JS & result[strictPrefix.len .. ^1]
      echo "  [OK] transcript limits injected after \"use strict\""
    else:
      result = MAIN_JS & result
      echo "  [OK] transcript limits prepended"
    if MARKER notin result:
      echo "  [FAIL] transcript limits: injection not present after patching"
    else:
      inc patchesApplied

  # --- precondition: the generic worker host forks with main's live env ----------
  # Not applied here (see the header): asserted. No "already" wording on purpose.
  let forkSites = forkEndStateCount(result)
  if forkSites != 1:
    echo "  [FAIL] transcript limits: expected exactly 1 generic worker-host fork with " &
      "main's env, found " & $forkSites & " - that change comes from " &
      "add_feature_files_quick_open.nim (sub-patch B), which must run first; without " &
      "it CDB_TRANSCRIPT_LIMITS never reaches the heavy-work worker; re-audit"
    quit(1)
  echo "  [OK] transcript limits: worker host forks with main's env (precondition met)"

  # --- C: hand the limits to both manager constructors --------------------------------
  let ctorDone = ctorEndStateCount(result)
  if ctorDone == CTOR_SITES:
    echo "  [OK] transcript limits: loadLimits already passed at both constructors (idempotent)"
    inc patchesApplied
  elif ctorDone > 0:
    echo "  [FAIL] transcript limits: loadLimits present at " & $ctorDone & " of " &
      $CTOR_SITES & " constructors - partial injection; re-audit"
  else:
    var count = 0
    result = result.replace(
      ctorRe,
      proc(m: RegexMatch2, s: string): string =
        inc count
        s[m.group(0)] &
          "loadLimits:globalThis.__cdbTranscriptLimits?.(),onTranscriptTruncatedChanged:",
    )
    if count != CTOR_SITES:
      echo "  [FAIL] transcript limits: expected exactly " & $CTOR_SITES &
        " session-manager construction sites, found " & $count & " - re-audit"
    elif ctorEndStateCount(result) != CTOR_SITES:
      echo "  [FAIL] transcript limits: loadLimits hook absent after patching"
    else:
      echo "  [OK] transcript limits: loadLimits hook added at " & $count &
        " constructors"
      inc patchesApplied

  if patchesApplied < EXPECTED_PATCHES:
    echo "  [FAIL] Only " & $patchesApplied & "/" & $EXPECTED_PATCHES &
      " patches applied"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_feature_transcript_limits <path_to_index.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: add_feature_transcript_limits ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] transcript limits applied"
  else:
    if MARKER notin output or forkEndStateCount(output) != 1 or
        ctorEndStateCount(output) != CTOR_SITES:
      echo "  [FAIL] No changes made and the end-state is absent"
      quit(1)
    echo "  [OK] Already applied (no changes needed)"
