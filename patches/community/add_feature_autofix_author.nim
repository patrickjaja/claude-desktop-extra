# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
# Recognize additional PR authors only through an explicit host/login allowlist.
# The Extra settings module owns validation, persistence and the live predicate.
# Empty/missing list (or missing helper) leaves upstream's author check intact.
# Only two author comparisons change; never spoof readGhLogin or remove auth,
# ownership, origin/age, confirmation, consent or concurrent-write conditions.
# Audited against pristine 4.16336.0. Bind each call to its actual PR's host.

import std/[os, strutils]
import regex

const SITES = 2
# Captures for both patterns: prefix, host/binding argument, guard, PR object.
# Automatic eligibility: the fourth parameter is the PR binding, with .host.
let autoRe =
  re2"""(function [\w$]+\([\w$]+,[\w$]+,[\w$]+,([\w$]+),[\w$]+,[\w$]+\)\{if\(![\w$]+\?\.success\)return["`]unreadable["`];if\([\w$]+\.login===null\)return [\w$]+\.failed\?["`]unreadable["`]:["`]no_login["`];)(if\(![\w$]+\(\{user:\{login:([\w$]+)\.author\}\},[\w$]+\.login\)\)return["`]not_author["`];)"""
# Model activation: the fourth argument is the explicit optional GitHub host.
# Bounded to this audited method; additional or missing sites fail the build.
let modelRe =
  re2"""(async enableAutoFixForModel\([\w$]+,[\w$]+,[\w$]+,([\w$]+)\)\{[\s\S]*?)(if\(![\w$]+\(\{user:\{login:([\w$]+)\.author\}\},[\w$]+\.login\)\)return["`]not_author["`];)"""
let guardRe =
  re2"""if\(![\w$]+\(\{user:\{login:[\w$]+\.author\}\},[\w$]+\.login\)\)return["`]not_author["`];"""
let endRe =
  re2"""if\(!\(globalThis\.__cdbAutoFixAuthorAllowed\?\.\([\w$]+\.author,[\w$]+(?:\.host)?\?\?["`]github\.com["`]\)===true\)&&![\w$]+\(\{user:\{login:[\w$]+\.author\}\},[\w$]+\.login\)\)return["`]not_author["`];"""

proc apply*(input: string): string =
  result = input
  let done = result.findAll(endRe).len
  if done == SITES and result.findAll(guardRe).len == 0:
    echo "  [OK] both host-scoped author guards already patched (idempotent)"
    return
  if done != 0 or result.findAll(guardRe).len != SITES or result.findAll(autoRe).len != 1 or
      result.findAll(modelRe).len != 1:
    echo "  [FAIL] expected one automatic and one model author guard; re-audit"
    quit(1)
  result = result.replace(
    autoRe,
    proc(m: RegexMatch2, s: string): string =
      s[m.group(0)] & "if(!(globalThis.__cdbAutoFixAuthorAllowed?.(" & s[m.group(3)] &
        ".author," & s[m.group(1)] & ".host??\"github.com\")===true)&&" &
        s[m.group(2)][3 .. ^1],
  )
  result = result.replace(
    modelRe,
    proc(m: RegexMatch2, s: string): string =
      let prefix = s[m.group(0)]
      if prefix.len > 1600 or "}storedAutoFix(" in prefix:
        echo "  [FAIL] model author guard moved outside its audited method"
        quit(1)
      prefix & "if(!(globalThis.__cdbAutoFixAuthorAllowed?.(" & s[m.group(3)] &
        ".author," & s[m.group(1)] & "??\"github.com\")===true)&&" &
        s[m.group(2)][3 .. ^1],
  )
  if result.findAll(endRe).len != SITES or result.findAll(guardRe).len != 0:
    echo "  [FAIL] both host-scoped author guard end states must be present"
    quit(1)
  echo "  [OK] explicit author allowlist added to both activation paths"

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
  echo "  [PASS] Auto-fix trusted authors"
