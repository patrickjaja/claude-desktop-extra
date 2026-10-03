# @patch-target: app.asar.contents/.vite/build/heavy-work-worker/heavyWorkWorker.js
# @patch-type: nim
#
# Load large sessions in full - worker half. See add_feature_transcript_limits.nim
# for the full story.
#
# Anthropic can run transcript reads in a separate "heavy-work" utility process
# (a server-side flag decides; the app logs "[transcript-read] local-session reads
# run in the heavy-work utility process"). That process bundles its OWN copy of
# the session manager, with its own limits object literal:
#
#   {mainBytes:<id>,subagentBytes:<id>,cachedEntryBytes:<id>,cachedTotalBytes:<id>}
#
# and none of the main process's code, so the main half hands the numbers over in
# process.env.CDB_TRANSCRIPT_LIMITS. This patch prepends
# js/transcript_limits_worker.js and wraps the literal:
#
#   -> __cdbTranscriptLimitsWorker({mainBytes:<id>,...})
#
# which returns Anthropic's own object untouched unless the variable holds four
# positive numbers. So with the switch off (variable unset) the worker is stock.
#
# The in-process copy of the limits lives in index.js, not here: that is the main
# half's `loadLimits` hook (one target per patch file).
#
# Break risk: LOW. Anchor is the limits object's PROPERTY names, which survive
# minification; it matched in four upstream builds with different identifiers.

import std/[os, strutils]
import regex

const HELPER_JS = staticRead("../../js/transcript_limits_worker.js")
const MARKER = "__CDB_TRANSCRIPT_LIMITS_WORKER__"
const DIRECTIVES = ["\"use strict\";", "'use strict';"]

# Group 0 = the whole limits object literal.
let limitsRe =
  re2"""(\{mainBytes:[\w$]+,subagentBytes:[\w$]+,cachedEntryBytes:[\w$]+,cachedTotalBytes:[\w$]+\})"""
# Our end-state, matched by SHAPE: the bare helper name also occurs in the helper's
# own definition, so a substring test would report "wrapped" the moment the helper
# is prepended, even if the rewrite never happened (Rule 6).
let wrappedRe =
  re2"""__cdbTranscriptLimitsWorker\(\{mainBytes:[\w$]+,subagentBytes:[\w$]+,cachedEntryBytes:[\w$]+,cachedTotalBytes:[\w$]+\}\)"""

proc hasWrap(s: string): bool =
  s.findAll(wrappedRe).len == 1

proc apply*(input: string): string =
  result = input
  let hasMarker = MARKER in result
  let wrapped = hasWrap(result)
  # Idempotency (Rule 6): BOTH halves of our end-state must be present.
  if hasMarker and wrapped:
    echo "  [OK] transcript limits worker: helper + wrapped limits already present (idempotent)"
    return
  if hasMarker != wrapped:
    echo "  [FAIL] transcript limits worker: partial injection (marker=" & $hasMarker &
      " wrapped=" & $wrapped & ") - refusing to patch on top; re-audit the worker bundle"
    quit(1)

  var count = 0
  result = result.replace(
    limitsRe,
    proc(m: RegexMatch2, s: string): string =
      inc count
      "__cdbTranscriptLimitsWorker(" & s[m.group(0)] & ")",
  )
  if count != 1:
    echo "  [FAIL] transcript limits worker: expected exactly 1 limits object, found " &
      $count
    quit(1)

  # Prepend the helper after the directive prologue (a directive only counts when
  # it is the very first statement).
  var prologue = 0
  for d in DIRECTIVES:
    if result.startsWith(d):
      prologue = d.len
      break
  let helper = "\n/*" & MARKER & "*/\n" & HELPER_JS & "\n"
  result = result[0 ..< prologue] & helper & result[prologue .. ^1]

  if MARKER notin result or not hasWrap(result):
    echo "  [FAIL] transcript limits worker: end-state absent after patching"
    quit(1)
  echo "  [OK] transcript limits worker: helper prepended, limits object wrapped"

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_feature_transcript_limits_worker <path_to_heavyWorkWorker.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: add_feature_transcript_limits_worker ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] transcript limits worker applied"
  else:
    if MARKER notin output or not hasWrap(output):
      echo "  [FAIL] No changes made and the end-state is absent"
      quit(1)
    echo "  [OK] Already applied (no changes needed)"
