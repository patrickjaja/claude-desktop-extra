# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
# Opt-in author mismatch for Auto-fix. Settings -> Extra owns the live,
# profile-local preference (default false). Only the two author comparisons
# change: the automatic own-create eligibility helper and enableAutoFixForModel.
# Authentication, session ownership, origin/age, confirmation, consent and
# concurrent-write checks remain upstream's code. Never spoof readGhLogin.
# Audited against pristine 4.16336.0. Fail closed if either guard moves.

import std/[os, strutils]
import regex

const GATE = "globalThis.__cdbAutoFixAllowDifferentAuthor?.()===true"
const SITES = 2
let guardRe =
  re2"""if\(![\w$]+\(\{user:\{login:[\w$]+\.author\}\},[\w$]+\.login\)\)return["`]not_author["`];"""
let endRe =
  re2"""if\(!\(globalThis\.__cdbAutoFixAllowDifferentAuthor\?\.\(\)===true\)&&![\w$]+\(\{user:\{login:[\w$]+\.author\}\},[\w$]+\.login\)\)return["`]not_author["`];"""

proc apply*(input: string): string =
  result = input
  let done = result.findAll(endRe).len
  if done == SITES and result.findAll(guardRe).len == 0:
    echo "  [OK] both Auto-fix author guards already patched (idempotent)"
    return
  if done != 0 or result.findAll(guardRe).len != SITES:
    echo "  [FAIL] expected exactly two pristine author guards or two patched guards; re-audit"
    quit(1)
  if "async enableAutoFixForModel(" notin result or "async armOwnCreate(" notin result:
    echo "  [FAIL] Auto-fix activation methods moved; re-audit"
    quit(1)
  result = result.replace(
    guardRe,
    proc(m: RegexMatch2, s: string): string =
      let original = s[m.boundaries]
      "if(!(" & GATE & ")&&" & original[3 .. ^1],
  )
  if result.findAll(endRe).len != SITES or result.findAll(guardRe).len != 0:
    echo "  [FAIL] both author guard end states must be present"
    quit(1)
  echo "  [OK] opt-in added to both Auto-fix author comparisons"

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_feature_autofix_author <path_to_index.js>"
    quit(1)
  let filePath = paramStr(1)
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
  echo "  [PASS] Auto-fix author opt-in"
