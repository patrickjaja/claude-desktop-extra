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
# merge authority. Three sub-patches, each anchor must match exactly once:
#   A  async checkSession(s,p){ -> runs the original, then (switch on, Linux)
#      the helper js/autofix_merge_ready.js inside a try/catch, so nothing it
#      throws can reject the sweep's Promise.all and skip upstream's own wakes.
#   B  handleTurnCompleted(s,m){try{ -> prepends a contained completion callback.
#   C  handleSendsDroppedUnsent(s,m,r){try{ -> prepends a contained drop
#      callback that passes the reason ("cancelled" = dismissed, not retried).
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
    echo "  [OK] merge-ready gated sweep wrapper and both contained callbacks already present"
    return
  const EXPECTED_PATCHES = 3
  var patchesApplied = 0
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
  if patchesApplied != EXPECTED_PATCHES:
    echo "  [FAIL] Only " & $patchesApplied & "/" & $EXPECTED_PATCHES &
      " patches applied"
    quit(1)
  echo "  [OK] merge-ready gated sweep wrapper and both contained callbacks applied"

when isMainModule:
  if paramCount() != 1:
    quit("Usage: add_feature_autofix_merge_ready <bundle.js>", 1)
  let file = paramStr(1)
  writeFile(file, apply(readFile(file)))
