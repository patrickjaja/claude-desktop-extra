# @patch-target: app.asar.contents/.vite/build/file-index-worker/fileIndexWorker.js
# @patch-type: nim
#
# Files quick open - worker half. Upstream's fuzzy file scorer treats a space in
# the query as a literal character to find, so "user service" matches nothing.
# This patch (1) prepends js/files_quick_open_worker.js, which defines
# __cdbQoSearch(index, query, limit) - VS Code's multi-piece AND search on top of
# the unchanged scorer, gated by process.env.CDB_FILES_QUICK_OPEN - and
# (2) rewrites the ONE call site inside FileIndexHost.search:
#     search(e,t){let n=[],r=this.builtIndex();if(r)for(let{path:i,positions:a}of r.search(e,t))
#  -> ...of __cdbQoSearch(r,e,t))
# (up to v5.11492.5 the index was a field: `if(this.index)for(...of this.index.search(e,t))`;
# since v6.28899.2 the host builds it lazily through a method and reads it into a local).
#
# Break risk: LOW. The anchor is the structural shape of FileIndexHost.search
# (a `let x=[],<idx>=this.<method>()` followed by `if(<idx>)` and a for-of over
# `<idx>.search` with the method's own two parameters); every identifier is a
# wildcard and the names are cross-checked in the replacement. Two
# preconditions pin the scorer contract the helper's full-set scan needs and the
# call-site anchor does not cover (see below).

import std/[os, strutils]
import regex

const HELPER_JS = staticRead("../../js/files_quick_open_worker.js")
const MARKER = "__CDB_QOPEN_WORKER__"
const DIRECTIVES = ["\"use strict\";", "'use strict';"]

# The rewritten call site, matched by SHAPE rather than by the bare substring
# "__cdbQoSearch(" - that name also occurs in the helper's own
# doc comment, so a substring test would report "call present" the moment the
# helper is prepended, even if the rewrite never happened (Rule 6: an [OK] must
# rest on a positively verified end-state).
let callRe = re2"\}of __cdbQoSearch\([\w$]+,[\w$]+,[\w$]+\)\)"

proc hasCallSite(s: string): bool =
  s.contains(callRe)

# search(<q>,<lim>){let <acc>=[],<idx>=this.<build>();if(<idx>)for(let{path:<p>,positions:<pos>}of <idx>.search(<q2>,<lim2>))
# Groups: 0 = everything up to and including "of ", 1 = q, 2 = lim, 3 = idx (let),
# 4 = idx (if), 5 = idx (receiver), 6 = q2, 7 = lim2
let anchor =
  re2"(search\(([\w$]+),([\w$]+)\)\{let [\w$]+=\[\],([\w$]+)=this\.[\w$]+\(\);if\(([\w$]+)\)for\(let\{path:[\w$]+,positions:[\w$]+\}of )([\w$]+)\.search\(([\w$]+),([\w$]+)\)\)"

# PRECONDITIONS for the helper's multi-piece path: js/files_quick_open_worker.js
# scans the WHOLE match set per piece, because intersecting two top-N lists
# would drop the very files the space fix exists for. Up to v5.11492.5 it asked
# for `index.readyCount` results; since v6.28899.2 that count is a private field
# (`#c`, set by `publish(n)`) of the scorer's table, so the helper passes an
# unbounded limit instead. That returns every match only while
#   (1) the index wrapper hands a non-empty query and the limit straight to the
#       table: `search(e,t){return t<=0?[]:e.length===0?<top-level cache>:this.table.search(e,t)}`
#   (2) the table's top-N keeps pushing until it holds `limit` entries:
#       `if(ne+=...,s.length<t)s.push({pathIndex:e,...` (pruning only starts at s.length===t)
# A change to either would make the multi-piece path return a truncated or
# empty set - silently - so both are pinned, exactly once each.
let wrapperRe =
  re2"search\(([\w$]+),([\w$]+)\)\{return ([\w$]+)<=0\?\[\]:([\w$]+)\.length===0\?[^;]*?:this\.table\.search\(([\w$]+),([\w$]+)\)\}"
let topNRe = re2"[(,]([\w$]+)\.length<([\w$]+)\)([\w$]+)\.push\(\{pathIndex:"

proc wrapperCount(s: string): int =
  for m in s.findAll(wrapperRe):
    let q = s[m.group(0)]
    let lim = s[m.group(1)]
    if s[m.group(2)] == lim and s[m.group(3)] == q and s[m.group(4)] == q and
        s[m.group(5)] == lim:
      inc result

proc topNCount(s: string): int =
  for m in s.findAll(topNRe):
    if s[m.group(0)] == s[m.group(2)]:
      inc result

proc apply*(input: string): string =
  result = input
  let hasMarker = MARKER in result
  let hasCall = hasCallSite(result)
  # Idempotency (Rule 6): BOTH halves of our end-state must be present.
  if hasMarker and hasCall:
    echo "  [OK] files quick open worker: helper + rewritten call already present (idempotent)"
    return
  if hasMarker != hasCall:
    echo "  [FAIL] files quick open worker: partial injection (marker=" & $hasMarker &
      " call=" & $hasCall & ") - refusing to patch on top; re-audit the worker bundle"
    quit(1)

  let nWrap = wrapperCount(result)
  let nTopN = topNCount(result)
  if nWrap != 1 or nTopN != 1:
    echo "  [FAIL] files quick open worker: the scorer's full-set contract moved (index wrapper " &
      $nWrap & "/1, top-N fill " & $nTopN & "/1) - the helper's unbounded scan could " &
      "silently return a truncated or empty set; re-audit"
    quit(1)

  var count = 0
  result = result.replace(
    anchor,
    proc(m: RegexMatch2, s: string): string =
      let q = s[m.group(1)]
      let lim = s[m.group(2)]
      let idx = s[m.group(3)]
      if s[m.group(4)] != idx or s[m.group(5)] != idx:
        echo "  [FAIL] files quick open worker: the for-of searches " & s[m.group(5)] &
          ", not the index local " & idx & " the method built and checked"
        quit(1)
      if s[m.group(6)] != q or s[m.group(7)] != lim:
        echo "  [FAIL] files quick open worker: inner search() args (" & s[m.group(6)] &
          "," & s[m.group(7)] & ") are not the method parameters (" & q & "," & lim & ")"
        quit(1)
      inc count
      s[m.group(0)] & "__cdbQoSearch(" & idx & "," & q & "," & lim & "))",
  )
  if count != 1:
    echo "  [FAIL] files quick open worker: expected exactly 1 FileIndexHost.search anchor, found " &
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

  if MARKER notin result or not hasCallSite(result):
    echo "  [FAIL] files quick open worker: end-state absent after patching"
    quit(1)
  echo "  [OK] files quick open worker: helper prepended, FileIndexHost.search rewritten"

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_feature_files_quick_open_worker <path_to_fileIndexWorker.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: add_feature_files_quick_open_worker ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] files quick open worker applied"
  else:
    if MARKER notin output or not hasCallSite(output):
      echo "  [FAIL] No changes made and end-state is absent"
      quit(1)
    echo "  [OK] Already applied (no changes needed)"
