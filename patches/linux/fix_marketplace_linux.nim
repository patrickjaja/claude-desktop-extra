# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# The Claude Code CLI stores personal plugins as scope="project" with
# projectPath=$HOME. getAllLocalPluginsWithResolver promotes those entries to
# scope="user", so the web UI lists them under "Personal Plugins" instead of
# under the current project header.
#
# Uses the `regex` package (pure Nim) like the other patches: std/nre dlopens
# PCRE1 at run time, which ubuntu-24.04 (the CI harness runner) does not ship.
# `regex` has no backreferences, so the "same entry variable" constraint that
# used to be `\1` is an equality check on the captured groups.

import std/[os, strformat, strutils]
import regex

const EXPECTED_PATCHES = 1

# Return-style anchor (v1.8089+):
#   if(X.scope==="user")return this.entryToPluginInfo(A,X,B,C);
# v1.26832.0 quotes the scope literal with backticks, hence the ["`] class.
# Groups: 0 = X (entry), 1 = A, 2 = X again (must equal group 0), 3 = B, 4 = C.
const ANCHOR_RETURN =
  re2"""if\(([\w$]+)\.scope===["`]user["`]\)return this\.entryToPluginInfo\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)\);"""

# Push-style anchor (older builds):
#   if(X.scope==="user"){Y.push(this.entryToPluginInfo(A,X,B,C));continue}
# Groups: 0 = X, 1 = Y, 2 = A, 3 = X again (must equal group 0), 4 = B, 5 = C.
const ANCHOR_PUSH =
  re2"""if\(([\w$]+)\.scope===["`]user["`]\)\{([\w$]+)\.push\(this\.entryToPluginInfo\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)\)\);continue\}"""

# Thunk-style anchor (v3.6556.2+; scope cached in a local, result wrapped):
#   P=()=>this.entryToPluginInfo(A,X,B,C),M=X.scope;if(M==="user")return{plugin:P()};
# Groups: 0 = P, 1 = A, 2 = X, 3 = B, 4 = C, 5 = M, 6 = X again, 7 = M again,
# 8 = P again (6/7/8 must equal 2/5/0).
const ANCHOR_THUNK =
  re2"""([\w$]+)=\(\)=>this\.entryToPluginInfo\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)\),([\w$]+)=([\w$]+)\.scope;if\(([\w$]+)===["`]user["`]\)return\{plugin:([\w$]+)\(\)\};"""

# Ternary-thunk anchor (v6.28899.2+; the if/return became one conditional return):
#   P=()=>this.entryToPluginInfo(A,X,B,C),M=X.scope;return M==="user"?{plugin:P()}:M==="project"||...
# Same groups and equality checks as the thunk-style anchor.
const ANCHOR_TERNARY =
  re2"""([\w$]+)=\(\)=>this\.entryToPluginInfo\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)\),([\w$]+)=([\w$]+)\.scope;return ([\w$]+)===["`]user["`]\?\{plugin:([\w$]+)\(\)\}:"""

# Positive end-state (Rule 6): our `||X.scope==="project"&&X.projectPath` arm
# (the thunk-style injections test the cached local `M==="user"` first).
const ALREADY_PATCHED =
  re2"""(?:if\(|return )[\w$.]+==="user"\|\|[\w$]+\.scope==="project"&&[\w$]+\.projectPath"""

proc firstWithSameEntry(
    s: string, pattern: Regex2, entryGroup: int
): (bool, RegexMatch2) =
  ## First match whose repeated entry capture equals group 0 (the `\1` constraint).
  for m in s.findAll(pattern):
    if s[m.group(0)] == s[m.group(entryGroup)]:
      return (true, m)
  (false, default(RegexMatch2))

proc homedirArm(e: string): string =
  e & ".scope===\"project\"&&" & e & ".projectPath&&" &
    "process.env.HOME&&require(\"path\").normalize(" & e &
    ".projectPath)===require(\"path\").normalize(process.env.HOME)"

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0

  # B: scope normalization in getAllLocalPluginsWithResolver
  if result.contains(ALREADY_PATCHED):
    echo "  [SKIP] B already patched"
    inc patchesApplied
  else:
    var foundThunk = false
    var mThunk: RegexMatch2
    for m in result.findAll(ANCHOR_THUNK):
      if result[m.group(6)] == result[m.group(2)] and
          result[m.group(7)] == result[m.group(5)] and
          result[m.group(8)] == result[m.group(0)]:
        foundThunk = true
        mThunk = m
        break
    var foundTernary = false
    var mTernary: RegexMatch2
    for m in result.findAll(ANCHOR_TERNARY):
      if result[m.group(6)] == result[m.group(2)] and
          result[m.group(7)] == result[m.group(5)] and
          result[m.group(8)] == result[m.group(0)]:
        foundTernary = true
        mTernary = m
        break
    let (foundNew, mNew) = result.firstWithSameEntry(ANCHOR_RETURN, 2)
    let (foundOld, mOld) = result.firstWithSameEntry(ANCHOR_PUSH, 3)
    if foundTernary:
      let p = result[mTernary.group(0)]
      let a = result[mTernary.group(1)]
      let e = result[mTernary.group(2)]
      let b = result[mTernary.group(3)]
      let c = result[mTernary.group(4)]
      let m = result[mTernary.group(5)]
      result =
        result[0 ..< mTernary.boundaries.a] & p & "=()=>this.entryToPluginInfo(" & a &
        "," & e & "," & b & "," & c & ")," & m & "=" & e & ".scope;return " & m &
        "===\"user\"||" & homedirArm(e) & "?{plugin:this.entryToPluginInfo(" & a &
        ",{..." & e & ",scope:\"user\"}," & b & "," & c & ")}:" &
        result[mTernary.boundaries.b + 1 .. ^1]
      echo "  [OK] B scope normalization (1 match, ternary-thunk-style)"
      inc patchesApplied
    elif foundThunk:
      let p = result[mThunk.group(0)]
      let a = result[mThunk.group(1)]
      let e = result[mThunk.group(2)]
      let b = result[mThunk.group(3)]
      let c = result[mThunk.group(4)]
      let m = result[mThunk.group(5)]
      result =
        result[0 ..< mThunk.boundaries.a] & p & "=()=>this.entryToPluginInfo(" & a & "," &
        e & "," & b & "," & c & ")," & m & "=" & e & ".scope;if(" & m & "===\"user\"||" &
        homedirArm(e) & ")return{plugin:this.entryToPluginInfo(" & a & ",{..." & e &
        ",scope:\"user\"}," & b & "," & c & ")};" & result[
          mThunk.boundaries.b + 1 .. ^1
        ]
      echo "  [OK] B scope normalization (1 match, thunk-style)"
      inc patchesApplied
    elif foundNew:
      let e = result[mNew.group(0)]
      let g = result[mNew.group(1)]
      let n = result[mNew.group(3)]
      let b = result[mNew.group(4)]
      result =
        result[0 ..< mNew.boundaries.a] & "if(" & e & ".scope===\"user\"||" &
        homedirArm(e) & ")return this.entryToPluginInfo(" & g & ",{..." & e &
        ",scope:\"user\"}," & n & "," & b & ");" & result[mNew.boundaries.b + 1 .. ^1]
      echo "  [OK] B scope normalization (1 match, return-style)"
      inc patchesApplied
    elif foundOld:
      let e = result[mOld.group(0)]
      let s = result[mOld.group(1)]
      let o = result[mOld.group(2)]
      let n = result[mOld.group(4)]
      let i = result[mOld.group(5)]
      result =
        result[0 ..< mOld.boundaries.a] & "if(" & e & ".scope===\"user\"||" &
        homedirArm(e) & "){" & s & ".push(this.entryToPluginInfo(" & o & ",{..." & e &
        ",scope:\"user\"}," & n & "," & i & "));continue}" &
        result[mOld.boundaries.b + 1 .. ^1]
      echo "  [OK] B scope normalization (1 match, push-style)"
      inc patchesApplied
    else:
      echo "  [FAIL] B scope normalization: 0 matches"

  if patchesApplied < EXPECTED_PATCHES:
    echo &"  [FAIL] Only {patchesApplied}/{EXPECTED_PATCHES} sub-patches applied"
    quit(1)

  let originalDelta = input.count('{') - input.count('}')
  let patchedDelta = result.count('{') - result.count('}')
  if originalDelta != patchedDelta:
    echo &"  [FAIL] Brace balance changed: {originalDelta} -> {patchedDelta}"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_marketplace_linux <path_to_index.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_marketplace_linux ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
  echo "  [PASS] Marketplace Linux patch applied"
