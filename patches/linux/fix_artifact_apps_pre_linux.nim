# @patch-target: app.asar.contents/.vite/build/index.pre.js
# @patch-type: nim
#
# Enable early CLI --artifact-app=<installId> launch detection in index.pre.js
# on Linux. Upstream folds Xue.isLaunch to `e => !1` and Xue.enter to `{}` in
# the Linux build; re-arming them lets cold-start launches with
# `--artifact-app=<32-hex>` keep the main window hidden until the artifact
# window opens (bornHiddenReason: "appifact") and preserve the flag across
# relaunches.

import std/[os, strutils]
import regex

const EXPECTED_PATCHES = 1
const APPLIED_MARKER = "__cdbArtifactPreLaunch"

const PreXuePattern =
  re2"""var ([\w$]+)="--artifact-app-launch",([\w$]+)=([\w$]+)=>[\w$]+===[\w$]+,([\w$]+)=!1,([\w$]+)=new Set,([\w$]+);function ([\w$]+)\(\)\{\}var ([\w$]+)=\{launchArg:[\w$]+,isLaunch:[\w$]+=>!1,active:\(\)=>[\w$]+,bornHiddenReason:\(\)=>[\w$]+\?"appifact":void 0,enter:[\w$]+,"""

proc countOf(s: string, p: Regex2): int =
  for _ in s.findAll(p):
    inc result

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0

  if APPLIED_MARKER in result and countOf(result, PreXuePattern) == 0:
    echo "  [OK] pre-launch Xue hook already applied (" & APPLIED_MARKER & ")"
    inc patchesApplied
  elif countOf(result, PreXuePattern) == 1:
    result = result.replace(
      PreXuePattern,
      proc(m: RegexMatch2, s: string): string =
        let argVar = s[m.group(0)]
        let matchFn = s[m.group(1)]
        let matchParam = s[m.group(2)]
        let activeVar = s[m.group(3)]
        let setVar = s[m.group(4)]
        let cbVar = s[m.group(5)]
        let enterFn = s[m.group(6)]
        let objVar = s[m.group(7)]
        "var " & argVar & "=\"--artifact-app-launch\"," & matchFn & "=" & matchParam &
          "=>" & matchParam & "===" & argVar & "||" & matchParam &
          ".startsWith(\"--artifact-app=\")," & activeVar & "=!1," & setVar & "=new Set," &
          cbVar & ";function " & enterFn & "(){" & activeVar & "=!0}var " & objVar &
          "={launchArg:" & argVar & ",isLaunch:function " & APPLIED_MARKER &
          "(e){return Array.isArray(e)&&e.slice(0,e.indexOf(\"--\")===-1?e.length:e.indexOf(\"--\")).some(function(a){return /^--artifact-app=[0-9a-f]{32}$/.test(a)})},active:()=>" &
          activeVar & ",bornHiddenReason:()=>" & activeVar &
          "?\"appifact\":void 0,enter:" & enterFn & ",",
    )
    if APPLIED_MARKER in result:
      echo "  [OK] pre-launch Xue hook enabled for --artifact-app=<id>"
      inc patchesApplied
    else:
      echo "  [FAIL] pre-launch Xue hook replacement did not land"
  else:
    echo "  [FAIL] expected 1 pre-launch Xue block, found " &
      $countOf(result, PreXuePattern)

  if patchesApplied < EXPECTED_PATCHES:
    echo "  [FAIL] Only " & $patchesApplied & "/" & $EXPECTED_PATCHES &
      " patches applied"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_artifact_apps_pre_linux <file>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_artifact_apps_pre_linux ==="
  echo "  Target: " & filePath
  let src = readFile(filePath)
  let dst = apply(src)
  if dst != src:
    writeFile(filePath, dst)
  echo "  [DONE] fix_artifact_apps_pre_linux"
