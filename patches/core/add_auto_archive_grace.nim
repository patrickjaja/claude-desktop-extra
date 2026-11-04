# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
# Keep the native archive sweep, safety gates and cleanup pipeline. Only the
# merged-PR rule gets a persisted grace period; CLOSED/inactivity are unchanged.
import std/[os, strutils]
import regex

const helper = staticRead("../../js/auto_archive_grace.js")

proc once(
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
    raise
      newException(ValueError, "archive-grace anchor count " & $hits & ", expected 1")

proc apply*(input: string): string =
  result = input
  # Resolve the settings module from a stable native archive preference anchor.
  let prefs = input.findAll(
    re2"""sessionAutoArchiveOnPrClose\([\w$]+\.sessionId\)\?\?([\w$]+)\.drt\("ccAutoArchiveOnPrClose"\)"""
  )
  if prefs.len != 1:
    raise newException(ValueError, "archive-grace preference anchor moved")
  let module = input[prefs[0].group(0)]
  let methodText =
    "__cdbGrace(){return this.__cdbArchiveGrace??=" & helper & "(this,()=>" & module &
    ".drt(\"ccAutoArchiveOnPrClose\")===!0)}"
  const head = re2"async checkAndArchive\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)\)\{"
  let heads = input.findAll(head)
  if heads.len != 1:
    raise newException(ValueError, "archive-grace archive entry moved")
  let session = input[heads[0].group(0)]
  let inactive = input[heads[0].group(2)]
  let stateHeads =
    input.findAll(re2"![\w$]+\.s\(([\w$]+)\)\)return;let [\w$]+=this\.holdReason\(")
  # On an already patched input the nonterminal return is wrapped below.
  let stateMarker = "/*cdb-grace-nonterminal:"
  var state: string
  if stateMarker in input:
    let start = input.find(stateMarker) + stateMarker.len
    state = input[start ..< input.find("*/", start)]
  elif stateHeads.len == 1:
    state = input[stateHeads[0].group(0)]
  else:
    raise newException(ValueError, "archive-grace state anchor moved")
  let guard =
    "if(process.platform===\"linux\"&&!" & inactive & "&&await this.__cdbGrace().wait(" &
    session & "," & state & "))return;"
  let observe =
    "/*cdb-grace-nonterminal:" & state &
    "*/if(process.platform===\"linux\")await this.__cdbGrace().wait(" & session & "," &
    state & ");return"
  let sweepHead = re2"async sweep\(([\w$]+)=!1\)\{"
  let sweeps = input.findAll(sweepHead)
  if sweeps.len != 1:
    raise newException(ValueError, "archive-grace sweep entry moved")
  let kicked = input[sweeps[0].group(0)]
  let sweepWrapper =
    "async sweep(" & kicked & "=!1){try{return await this.__cdbOriginalArchiveSweep(" &
    kicked &
    ")}finally{if(process.platform===\"linux\")await this.__cdbGrace().reconcileAll()}}async __cdbOriginalArchiveSweep(" &
    kicked & "=!1){"
  if "__cdbArchiveGrace" in input:
    if input.count(methodText) != 1 or input.count(guard) != 1 or
        input.count(observe) != 1 or input.count(sweepWrapper) != 1:
      raise newException(ValueError, "archive-grace injection incomplete or stale")
    echo "  [OK] archive-grace factory, reconciliation and guarded archive already present"
    return
  const EXPECTED_PATCHES = 4
  var patchesApplied = 0
  result = once(
    result,
    head,
    proc(m: RegexMatch2, s: string): string =
      methodText & s[m.boundaries],
  )
  inc patchesApplied
  result = once(
    result,
    sweepHead,
    proc(m: RegexMatch2, s: string): string =
      sweepWrapper,
  )
  inc patchesApplied
  result = once(
    result,
    re2"![\w$]+\.s\([\w$]+\)\)return;let [\w$]+=this\.holdReason\(",
    proc(m: RegexMatch2, s: string): string =
      s[m.boundaries].replace("return;", "{" & observe & ";}"),
  )
  inc patchesApplied
  result = once(
    result,
    re2"let ([\w$]+)=this\.holdReason\(([\w$]+),([\w$]+)\);if\(([\w$]+)&&",
    proc(m: RegexMatch2, s: string): string =
      guard & s[m.boundaries],
  )
  inc patchesApplied
  if patchesApplied != EXPECTED_PATCHES:
    quit("[FAIL] archive-grace partial patch", 1)
  echo "  [OK] archive-grace factory, reconciliation and guarded archive applied"

when isMainModule:
  if paramCount() != 1:
    quit("Usage: add_auto_archive_grace <bundle.js>", 1)
  let file = paramStr(1)
  writeFile(file, apply(readFile(file)))
