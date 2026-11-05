# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Opt-in (default OFF): wake an Auto-fix session when its PR is ready to merge.
# Switch: Settings -> Extra -> Community Features -> "Auto-fix notices: ready
# to merge, comments after merge" (key `autoFixMergeReady`, read live through
# globalThis.__cdbAutoFixMergeReadyEnabled(), defined by js/extra_settings_main.js;
# shared with add_feature_autofix_post_merge.nim).
#
# Reuses AutoFixEngine's own sweep and its sendMessage CI wake; no timer, no
# merge authority. Four sub-patches, each anchor must match exactly once:
#   A  async checkSession(s,p){ -> runs the original, then (switch on, Linux)
#      the helper js/autofix_merge_ready.js inside a try/catch, so nothing it
#      throws can reject the sweep's Promise.all and skip upstream's own wakes.
#   B  handleTurnCompleted(s,m){try{ -> prepends a contained completion callback.
#   C  handleSendsDroppedUnsent(s,m,r){try{ -> prepends a contained drop
#      callback that passes the reason ("cancelled" = dismissed, not retried).
#   D  the healthy completion emitter (`...health==="healthy"&&this.deps.emit(
#      "turnCompleted",owner,cycle.userMessageUuid)`): upstream starts a drained
#      batch under its first message UUID, keeps the others in
#      pendingCycle.promptUuids and emits completion for the first only, so a
#      notice later in the batch stays pending. With the switch on (Linux, a
#      non-empty promptUuids array), it also emits for the batch's other user
#      messages that were echoed, are still buffered, not withdrawn and not the
#      next cycle's; otherwise the plain upstream emit runs. Every upstream
#      health/query/adoption guard before it is kept.
# Idempotency asserts the exact injected end states (gate, try/catch, helper);
# each callback body must sit exactly once in its method's prefix chain, since
# add_feature_autofix_post_merge prepends its own contained callback after us.
import std/[os, strutils]
import regex

const helper = staticRead("../../js/autofix_merge_ready.js")

const
  gate =
    "if(process.platform===\"linux\"&&globalThis.__cdbAutoFixMergeReadyEnabled?.()===true)"
  diag = "globalThis.__cdbDiag?.(\"[merge-ready] \"+String(__cdbAfmrE))"

proc wrapperFor(a, b: string): string =
  "async checkSession(" & a & "," & b &
    "){let __cdbAfmrR=await this.__cdbOriginalCheckSession(" & a & "," & b & ");" & gate &
    "{try{this.__cdbMergeReady??=" & helper & "(this);await this.__cdbMergeReady.check(" &
    a & "," & b & ")}catch(__cdbAfmrE){" & diag &
    "}}return __cdbAfmrR}async __cdbOriginalCheckSession(" & a & "," & b & "){"

proc completedFor(a, b: string): string =
  "handleTurnCompleted(" & a & "," & b & "){try{this.__cdbMergeReady?.completed(" & a &
    "," & b & ")}catch(__cdbAfmrE){" & diag & "}try{"

proc droppedFor(a, b, c: string): string =
  "handleSendsDroppedUnsent(" & a & "," & b & "," & c &
    "){try{this.__cdbMergeReady?.dropped(" & a & "," & b & "," & c &
    ")}catch(__cdbAfmrE){" & diag & "}try{"

# --- D: batch completion receipts ------------------------------------------
const emitPrefix =
  "([\\w$]+)&&([\\w$]+)\\.query===([\\w$]+)\\.queryObj&&([\\w$]+)!==void 0&&!([\\w$]+)\\.adoptedByStartedCommand&&([\\w$]+)\\.health===[\"`]healthy[\"`]&&"
let emitOriginalRe = re2(
  emitPrefix &
    "this\\.deps\\.emit\\([\"`]turnCompleted[\"`],([\\w$]+),([\\w$]+)\\.userMessageUuid\\)"
)
let emitInstalledRe = re2(
  emitPrefix &
    "\\(process\\.platform===\"linux\"&&Array\\.isArray\\(([\\w$]+)\\.promptUuids\\)"
)
let emitLoopRe =
  re2"""for\(const __cdbBatchReceiptId of __cdbBatchReceiptIds\)this\.deps\.emit\("turnCompleted",([\w$]+),__cdbBatchReceiptId\)"""

proc receiptsFor(session, cycle, id: string): string =
  let emit = "this.deps.emit(\"turnCompleted\"," & id & ","
  "(process.platform===\"linux\"&&Array.isArray(" & cycle & ".promptUuids)&&" & cycle &
    ".promptUuids.length>0&&globalThis.__cdbAutoFixMergeReadyEnabled?.()===true?(()=>{const __cdbBatchReceiptIds=new Set([" &
    cycle & ".userMessageUuid]);for(const __cdbBatchReceiptId of " & cycle &
    ".promptUuids){if(typeof __cdbBatchReceiptId===\"string\"&&__cdbBatchReceiptId.length>0&&!" &
    session & ".pendingEchoUuids?.has(__cdbBatchReceiptId)&&" & session &
    ".nextCycleUuid!==__cdbBatchReceiptId&&" & session &
    ".messageBuffer?.some(__cdbBatchReceiptMessage=>__cdbBatchReceiptMessage.type===\"user\"&&__cdbBatchReceiptMessage.uuid===__cdbBatchReceiptId&&!__cdbBatchReceiptMessage.isWithdrawn))__cdbBatchReceiptIds.add(__cdbBatchReceiptId)}for(const __cdbBatchReceiptId of __cdbBatchReceiptIds)" &
    emit & "__cdbBatchReceiptId)})():" & emit & cycle & ".userMessageUuid))"

# Returns the patched text; `present` is set when the exact end state was
# already there (asserted, rebuilt from the identifiers it was written with).
proc batchReceipts(s: string, present: var bool): string =
  if "__cdbBatchReceiptIds" in s:
    let hits = s.findAll(emitInstalledRe)
    let loops = s.findAll(emitLoopRe)
    if hits.len != 1 or loops.len != 1 or s.findAll(emitOriginalRe).len != 0:
      raise newException(
        ValueError,
        "batch receipt end-state count " & $hits.len & "/" & $loops.len & "; re-audit",
      )
    let m = hits[0]
    let cycle = s[m.group(3)]
    if s[m.group(4)] != cycle or s[m.group(6)] != cycle:
      raise newException(ValueError, "batch receipt cycle guards changed; re-audit")
    let whole = s[m.boundaries]
    let expected =
      whole[0 ..< whole.find("(process.platform")] &
      receiptsFor(s[m.group(1)], cycle, s[loops[0].group(0)])
    if s.count(expected) != 1 or s.find(expected) != m.boundaries.a:
      raise newException(ValueError, "batch receipt injection differs; re-audit")
    present = true
    return s
  let hits = s.findAll(emitOriginalRe)
  if hits.len != 1:
    raise newException(
      ValueError, "batch receipt emitter count " & $hits.len & ", expected 1; re-audit"
    )
  let m = hits[0]
  let cycle = s[m.group(3)]
  if s[m.group(4)] != cycle or s[m.group(7)] != cycle:
    raise newException(ValueError, "batch receipt cycle identity changed; re-audit")
  let original = s[m.boundaries]
  let prefix = original[0 ..< original.find("this.deps.emit")]
  result =
    s[0 ..< m.boundaries.a] & prefix & receiptsFor(s[m.group(1)], cycle, s[m.group(6)]) &
    s[m.boundaries.b + 1 .. ^1]

proc inject(
    s: string, pattern: Regex2, replacement: proc(m: RegexMatch2, s: string): string
): string =
  var hits = 0
  result = s.replace(
    pattern,
    proc(m: RegexMatch2, s: string): string =
      inc hits
      replacement(m, s),
  )
  if hits != 1:
    raise newException(ValueError, "merge-ready anchor count " & $hits & ", expected 1")

# The injected end state, rebuilt from the identifiers it was written with.
proc assertPresent(s: string, pattern: Regex2, expected: proc(m: RegexMatch2): string) =
  let hits = s.findAll(pattern)
  if hits.len != 1:
    raise newException(
      ValueError, "merge-ready end-state count " & $hits.len & "; re-audit"
    )
  if s.count(expected(hits[0])) != 1:
    raise newException(
      ValueError, "merge-ready injection differs from this build; re-audit"
    )

# A callback's injected body (everything after the signature's `{`) must be
# present exactly once, and inside that method's chain of contained callback
# prefixes: other patches (add_feature_autofix_post_merge, applied after this
# one in basename order) may prepend their own `try{...}catch(...){...}` block.
proc assertCallback(
    s: string, signature: Regex2, chain: Regex2, expected: proc(m: RegexMatch2): string
) =
  let heads = s.findAll(signature)
  if heads.len != 1:
    raise newException(
      ValueError, "merge-ready callback signature count " & $heads.len & "; re-audit"
    )
  let full = expected(heads[0])
  let body = full[full.find('{') + 1 .. ^1]
  if s.count(body) != 1:
    raise newException(
      ValueError, "merge-ready callback body count " & $s.count(body) & "; re-audit"
    )
  let links = s.findAll(chain)
  if links.len != 1 or links[0].boundaries.a != heads[0].boundaries.a:
    raise newException(ValueError, "merge-ready callback chain differs; re-audit")
  let marker = body[0 ..< body.find('(') + 1]
  let at = links[0].boundaries.b + 1 - marker.len
  if at < 0 or s.find(body, at) != at:
    raise newException(
      ValueError, "merge-ready callback outside its method prefix; re-audit"
    )

const
  wrapperHead =
    re2"""async checkSession\(([\w$]+),([\w$]+)\)\{let __cdbAfmrR=await this\.__cdbOriginalCheckSession\("""
  # One contained callback another patch prepended: try{this.__cdbX?.m(a,b)}catch(e){globalThis.__cdbDiag?.("[x] "+String(e))}
  prefixLink =
    """(?:try\{this\.__cdb[\w$]+\?\.(?:completed|dropped)\([\w$,]*\)\}catch\([\w$]+\)\{globalThis\.__cdbDiag\?\.\("\[[\w-]+\] "\+String\([\w$]+\)\)\})*"""
  completedSig = re2"""handleTurnCompleted\(([\w$]+),([\w$]+)\)\{"""
  droppedSig = re2"""handleSendsDroppedUnsent\(([\w$]+),([\w$]+),([\w$]+)\)\{"""
  completedChain = re2(
    """handleTurnCompleted\([\w$]+,[\w$]+\)\{""" & prefixLink &
      """try\{this\.__cdbMergeReady\?\.completed\("""
  )
  droppedChain = re2(
    """handleSendsDroppedUnsent\([\w$]+,[\w$]+,[\w$]+\)\{""" & prefixLink &
      """try\{this\.__cdbMergeReady\?\.dropped\("""
  )

proc apply*(input: string): string =
  result = input
  let s = input
  const markers = [
    "__cdbOriginalCheckSession(", "this.__cdbMergeReady.completed(",
    "this.__cdbMergeReady?.completed(", "this.__cdbMergeReady.dropped(",
    "this.__cdbMergeReady?.dropped(",
  ]
  var touched = false
  for marker in markers:
    if marker in s:
      touched = true
  const EXPECTED_PATCHES = 4 # A, B, C, D
  var patchesApplied = 0
  var abcPresent = false
  if touched:
    assertPresent(
      s,
      wrapperHead,
      proc(m: RegexMatch2): string =
        wrapperFor(s[m.group(0)], s[m.group(1)]),
    )
    assertCallback(
      s,
      completedSig,
      completedChain,
      proc(m: RegexMatch2): string =
        completedFor(s[m.group(0)], s[m.group(1)]),
    )
    assertCallback(
      s,
      droppedSig,
      droppedChain,
      proc(m: RegexMatch2): string =
        droppedFor(s[m.group(0)], s[m.group(1)], s[m.group(2)]),
    )
    abcPresent = true
    patchesApplied += 3
  else:
    result = inject(
      result,
      re2"async checkSession\(([\w$]+),([\w$]+)\)\{",
      proc(m: RegexMatch2, s: string): string =
        wrapperFor(s[m.group(0)], s[m.group(1)]),
    )
    inc patchesApplied
    result = inject(
      result,
      re2"handleTurnCompleted\(([\w$]+),([\w$]+)\)\{try\{",
      proc(m: RegexMatch2, s: string): string =
        completedFor(s[m.group(0)], s[m.group(1)]),
    )
    inc patchesApplied
    result = inject(
      result,
      re2"handleSendsDroppedUnsent\(([\w$]+),([\w$]+),([\w$]+)\)\{try\{",
      proc(m: RegexMatch2, s: string): string =
        droppedFor(s[m.group(0)], s[m.group(1)], s[m.group(2)]),
    )
    inc patchesApplied
  var dPresent = false
  result = batchReceipts(result, dPresent)
  inc patchesApplied
  if patchesApplied != EXPECTED_PATCHES:
    echo "  [FAIL] Only " & $patchesApplied & "/" & $EXPECTED_PATCHES &
      " patches applied"
    quit(1)
  if abcPresent and dPresent:
    echo "  [OK] merge-ready gated sweep wrapper, both contained callbacks and batch receipts already present"
  else:
    echo "  [OK] merge-ready gated sweep wrapper, both contained callbacks and batch receipts applied"

when isMainModule:
  if paramCount() != 1:
    quit("Usage: add_feature_autofix_merge_ready <bundle.js>", 1)
  let file = paramStr(1)
  writeFile(file, apply(readFile(file)))
