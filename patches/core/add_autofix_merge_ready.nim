# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
# Reuse AutoFixEngine's selected-PR sweep and sendMessage CI wake pipeline.
# All anchors must match once; no parallel timers or changes to merge authority.
import std/[os, strutils]
import regex

const helper = staticRead("../../js/autofix_merge_ready.js")

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

proc apply*(input: string): string =
  result = input
  const markers = [
    "async __cdbOriginalCheckSession(", "this.__cdbMergeReady.completed(",
    "this.__cdbMergeReady.dropped(",
  ]
  if markers[0] in result or markers[1] in result or markers[2] in result:
    for marker in markers:
      if result.count(marker) != 1:
        raise newException(ValueError, "partial merge-ready injection; re-audit")
    if helper notin result:
      raise newException(ValueError, "merge-ready helper differs; re-audit")
    echo "  [OK] merge-ready sweep, helper and delivery callbacks already present"
    return
  const EXPECTED_PATCHES = 3
  var patchesApplied = 0
  result = inject(
    result,
    re2"async checkSession\(([\w$]+),([\w$]+)\)\{",
    proc(m: RegexMatch2, s: string): string =
      let a = s[m.group(0)]
      let b = s[m.group(1)]
      "async checkSession(" & a & "," & b & "){await this.__cdbOriginalCheckSession(" & a &
        "," & b & ");if(process.platform===\"linux\"){this.__cdbMergeReady??=" & helper &
        "(this);await this.__cdbMergeReady.check(" & a & "," & b &
        ")}}async __cdbOriginalCheckSession(" & a & "," & b & "){",
  )
  inc patchesApplied
  result = inject(
    result,
    re2"handleTurnCompleted\(([\w$]+),([\w$]+)\)\{try\{",
    proc(m: RegexMatch2, s: string): string =
      "handleTurnCompleted(" & s[m.group(0)] & "," & s[m.group(1)] &
        "){if(this.__cdbMergeReady)this.__cdbMergeReady.completed(" & s[m.group(0)] & "," &
        s[m.group(1)] & ");try{",
  )
  inc patchesApplied
  result = inject(
    result,
    re2"handleSendsDroppedUnsent\(([\w$]+),([\w$]+),([\w$]+)\)\{try\{",
    proc(m: RegexMatch2, s: string): string =
      "handleSendsDroppedUnsent(" & s[m.group(0)] & "," & s[m.group(1)] & "," &
        s[m.group(2)] & "){if(this.__cdbMergeReady)this.__cdbMergeReady.dropped(" &
        s[m.group(0)] & "," & s[m.group(1)] & ");try{",
  )
  inc patchesApplied
  if patchesApplied != EXPECTED_PATCHES:
    raise newException(ValueError, "not all merge-ready patches applied")
  echo "  [OK] merge-ready sweep and both delivery callbacks applied"

when isMainModule:
  if paramCount() != 1:
    quit("Usage: add_autofix_merge_ready <bundle.js>", 1)
  let file = paramStr(1)
  writeFile(file, apply(readFile(file)))
