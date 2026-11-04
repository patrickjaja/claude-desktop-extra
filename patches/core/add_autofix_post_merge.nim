# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
# Post-merge comments remain informational; only active Auto-fix bindings.
# Audited on pristine 4.16336.0. Three exact injections, no new timer.
import std/[os, strutils]
import regex

const helper = staticRead("../../js/autofix_post_merge.js")
const diag = "globalThis.__cdbDiag?.(\"[post-merge] \"+String(__cdbPmError))"
const sweep =
  "async sweep(){if(this.sweeping)return;await this.__cdbOriginalPostMergeSweep();if(process.platform===\"linux\"){try{this.__cdbPostMerge??=" &
  helper & "(this);await this.__cdbPostMerge.sweep()}catch(__cdbPmError){" & diag &
  "}}}async __cdbOriginalPostMergeSweep(){"

proc completed(a, b: string): string =
  "handleTurnCompleted(" & a & "," & b & "){try{this.__cdbPostMerge?.completed(" & a &
    "," & b & ")}catch(__cdbPmError){" & diag & "}"

proc dropped(a, b, c: string): string =
  "handleSendsDroppedUnsent(" & a & "," & b & "," & c &
    "){try{this.__cdbPostMerge?.dropped(" & a & "," & b & "," & c &
    ")}catch(__cdbPmError){" & diag & "}"

proc apply*(input: string): string =
  result = input
  let done = "__cdbOriginalPostMergeSweep" in input
  const EXPECTED_PATCHES = 3
  var patchesApplied = 0
  if done:
    if input.count(sweep) != 1:
      raise newException(ValueError, "post-merge sweep end-state differs; re-audit")
    inc patchesApplied
  else:
    const anchor = "async sweep(){if(!this.sweeping){"
    if result.count(anchor) != 1:
      raise newException(ValueError, "expected one AutoFixEngine sweep; re-audit")
    result = result.replace(anchor, sweep & "if(!this.sweeping){")
    inc patchesApplied
  let patterns = [
    re2"handleTurnCompleted\(([\w$]+),([\w$]+)\)\{",
    re2"handleSendsDroppedUnsent\(([\w$]+),([\w$]+),([\w$]+)\)\{",
  ]
  for index, pattern in patterns:
    let matches = result.findAll(pattern)
    if matches.len != 1:
      raise
        newException(ValueError, "post-merge callback anchor count differs; re-audit")
    let m = matches[0]
    let injected =
      if index == 0:
        completed(result[m.group(0)], result[m.group(1)])
      else:
        dropped(result[m.group(0)], result[m.group(1)], result[m.group(2)])
    if done:
      if result.count(injected) != 1:
        raise
          newException(ValueError, "post-merge callback end-state differs; re-audit")
    else:
      if "__cdbPostMerge?." in input:
        raise newException(ValueError, "partial post-merge injection; re-audit")
      result = result.replace(result[m.boundaries], injected)
    inc patchesApplied
  if patchesApplied != EXPECTED_PATCHES:
    raise newException(ValueError, "post-merge incomplete injection")
  echo "  [OK] post-merge sweep and delivery callbacks present"

when isMainModule:
  if paramCount() != 1:
    quit("Usage: add_autofix_post_merge <bundle.js>", 1)
  let file = paramStr(1)
  writeFile(file, apply(readFile(file)))
