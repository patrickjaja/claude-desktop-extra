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
#   B. precondition (asserted, not applied): the generic worker host forks with
#      main's live env - see below
#   P. precondition (asserted, not applied): upstream still READS `loadLimits` -
#      see below
#   C. `new <Manager>({[k:v,...]onTranscriptTruncatedChanged:` ->
#      `new <Manager>({loadLimits:globalThis.__cdbTranscriptLimits?.(),[k:v,...]onTranscriptTruncatedChanged:`
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
#   utilityProcess.fork(r,[],{serviceName:t,stdio:"pipe",env:Object.assign({},process.env)...})
#
# PRECONDITION, not a sub-patch: upstream still CONSUMES the option. C's end
# state only proves that WE pass `loadLimits:`. If upstream renamed the option,
# both constructor anchors would still match, C would print [OK], and the
# manager would silently ignore the value. So its reads are pinned, each to
# exactly one site (2.9939.4 shapes, in an index.chunk-*), and `this.config.
# loadLimits` to exactly those two spellings:
#   this.inProcess=new _e(e.loadLimits)   the in-process reader: the limits are
#                                         merged over the defaults ({...ae,...e})
#   let c=this.config.loadLimits          predictTranscriptTruncation's read
#   o=5*(this.config.loadLimits?.mainBytes??52428800)
#                                         since v6.28899.2: searchLeftFile's scan
#                                         budget when the history window walks
#                                         back into an earlier session file the
#                                         conversation continued from. It stops
#                                         after 5x the main tail size; a larger
#                                         mainBytes widens that bounded budget in
#                                         proportion, which is the intent (a
#                                         session loaded in full may link earlier
#                                         files of the same order of size)
# Neither regex can match our own injection: C writes `loadLimits:globalThis...`
# and js/transcript_limits_main.js must never spell either shape (not even in a
# comment - it is injected verbatim), so an idempotent second run still counts 1.
#
# Break risk: LOW. A has a stable head-of-bundle anchor; the preconditions pin the
# fork site's end state and upstream's two `loadLimits` reads (exactly one each);
# C anchors on a config
# PROPERTY name (`onTranscriptTruncatedChanged:`), which survives minification
# where identifiers do not. C is pinned to exactly two sites: a third (or a
# renamed option) fails the build rather than silently skipping a manager.

import std/[os, strutils]
import regex

const MAIN_JS = staticRead("../../js/transcript_limits_main.js")
const MARKER = "__CDB_TRANSCRIPT_LIMITS__"
const EXPECTED_PATCHES = 2
  # A: main-process half, C: loadLimits hook (B and P are preconditions)
const CTOR_SITES = 2

# The precondition's end state (written by add_feature_files_quick_open.nim
# sub-patch B). Quote-agnostic: the style flips between minifier releases.
let forkEndStateRe =
  re2"""stdio:["`]pipe["`],env:Object\.assign\(\{\},process\.env\)[,}]"""

# Precondition P: upstream's two reads of the option (see the header).
let limitsCtorReadRe = re2"""new [\w$.]+\([\w$]+\.loadLimits\)"""
let limitsConfigReadRe = re2"""this\.config\.loadLimits\b"""
let limitsPredictReadRe = re2"""let [\w$]+=this\.config\.loadLimits;"""
let limitsSearchReadRe =
  re2"""[\w$]+=5\*\(this\.config\.loadLimits\?\.mainBytes\?\?\d+\)"""

# Sub-patch C. Group 0 = `new <id>.<id>({`, group 1 = the `key:value,` properties
# upstream places before the callback (empty, or starting with a key), as long as
# none of them opens or closes a brace: that keeps the match inside the one object
# literal whose own key is `onTranscriptTruncatedChanged:`. Matches (v4.29.0):
#   this.diskTranscript=new gt.t({resolvesByKind:i$,isCopied:yD,copyOf:(e,t)=>this.vmTranscriptCopies.dirOf(e,t),onTranscriptTruncatedChanged:e=>{...
#   this.transcriptReader=new a.t({onTranscriptTruncatedChanged:()=>{},skipMtimeTouchOnRead:!0})
# (v2.19675.1 had no leading property on the first site; up to v3.6556.2 only
# `resolvesByKind:<id>`.) The v4 arrow-function value is why the property values
# are brace-free rather than identifier-only. `isCopied`/`copyOf` route Cowork VM
# transcript copies through this same manager instance, so they need no site of
# their own. `loadLimits:` goes right after `({`, ahead of any such property.
let ctorRe =
  re2"""(new [\w$.]+\(\{)((?:[\w$]+:[^{}]*?,)?)onTranscriptTruncatedChanged:"""
let ctorEndRe =
  re2"""new [\w$.]+\(\{loadLimits:globalThis\.__cdbTranscriptLimits\?\.\(\),(?:[\w$]+:[^{}]*?,)?onTranscriptTruncatedChanged:"""

proc forkEndStateCount(s: string): int =
  s.findAll(forkEndStateRe).len

proc ctorEndStateCount(s: string): int =
  s.findAll(ctorEndRe).len

proc limitsReadCounts(s: string): (int, int, int, int) =
  (
    s.findAll(limitsCtorReadRe).len,
    s.findAll(limitsConfigReadRe).len,
    s.findAll(limitsPredictReadRe).len,
    s.findAll(limitsSearchReadRe).len,
  )

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

  # --- precondition P: upstream still reads the loadLimits option ---------------
  # Without it C would "succeed" into an option nothing reads (see the header).
  let (ctorReads, configReads, predictReads, searchReads) = limitsReadCounts(result)
  if ctorReads != 1 or configReads != 2 or predictReads != 1 or searchReads != 1:
    echo "  [FAIL] transcript limits: expected upstream to read loadLimits at exactly 1 " &
      "`new <Reader>(<cfg>.loadLimits)` and 2 `this.config.loadLimits` (1 " &
      "`let <x>=this.config.loadLimits;`, 1 `<x>=5*(this.config.loadLimits?.mainBytes??N)`), found " &
      $ctorReads & ", " & $configReads & " (" & $predictReads & ", " & $searchReads &
      ") - the option was renamed or its reads moved, so passing it may change nothing " &
      "or something new; re-audit before re-fitting C"
    quit(1)
  echo "  [OK] transcript limits: upstream reads loadLimits (precondition met)"

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
        s[m.group(0)] & "loadLimits:globalThis.__cdbTranscriptLimits?.()," &
          s[m.group(1)] & "onTranscriptTruncatedChanged:",
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
        limitsReadCounts(output) != (1, 2, 1, 1) or
        ctorEndStateCount(output) != CTOR_SITES:
      echo "  [FAIL] No changes made and the end-state is absent"
      quit(1)
    echo "  [OK] Already applied (no changes needed)"
