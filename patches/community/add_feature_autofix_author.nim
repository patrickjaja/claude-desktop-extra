# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
# Recognize additional PR authors only through an explicit host/login allowlist.
# The Extra settings module owns validation, persistence and the live predicate.
# Empty/missing list (or missing helper) leaves upstream's author checks intact.
# Seven author comparisons change: the two Auto-fix guards, plus the PR-manager
# ownership reads (by number, by branch, by head SHA) and the two discovery
# filters, so a listed author's PR is bound as the session's own and Auto-fix
# can arm. Never spoof readGhLogin or remove auth, ownership, origin/age,
# confirmation, consent or concurrent-write conditions; a missing gh login
# still yields "unknown". Audited against pristine 5.1231.0 (the model path now
# reads the login fresh via readGhLoginNow and checks push permission after the
# author check; neither is an author comparison). Bind each call to its actual
# PR's host.

import std/[os, strutils]
import regex

const SITES = 7
const ALLOWED = "globalThis.__cdbAutoFixAuthorAllowed?.("
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
# The login matcher every ownership site calls (Dd on 5.1231.0).
let matcherRe =
  re2"""function ([\w$]+)\([\w$]+,[\w$]+\)\{let [\w$]+=[\w$]+\.user\?\.login;return!![\w$]+&&!![\w$]+&&[\w$]+\.toLowerCase\(\)===[\w$]+\.toLowerCase\(\)\}"""
# Site 1, getPrStateByNumberUncached: host argument, login param, matcher, PR.
let byNumRe =
  re2"""ownCreate:await this\.getGhLogin\(([\w$]+)\)\.then\(\(([\w$]+)=>([\w$]+)===null\?void 0:([\w$]+)\(([\w$]+),([\w$]+)\)\)\)"""
# Sites 2+3, getPrStateForBranchUncached: the discovery filter (own, bound,
# known App via fd(PR, slug.hostname), else push access) and the result's
# ownCreate, bounded to the same method.
let branchRe =
  re2"""([\w$]+)\(([\w$]+),([\w$]+)\)(\|\|[\w$]+\.number!==void 0&&[\w$]+\.has\([\w$]+\.number\)\|\|[\w$]+\([\w$]+,([\w$]+)\.hostname\))(\?!0:await this\.authorMayPush\([\s\S]*?ownCreate:)([\w$]+)===null\?void 0:([\w$]+)\(([\w$]+),([\w$]+)\)\}\)"""
# Sites 4+5, discoverPrByHeadSha: the same-repo discovery branch (the fork
# branch, which needs the user's own fork, stays upstream's) and ownCreate.
let shaRe =
  re2"""(\{let [\w$]+=([\w$]+)\(([\w$]+),([\w$]+)\);return [\w$]+\.head\?\.repo\?\.full_name\?\.toLowerCase\(\)===[\w$]+\?[\w$]+\|\|[\w$]+\([\w$]+,([\w$]+)\.hostname\))(\|\|await this\.authorMayPush\([\s\S]*?ownCreate:)([\w$]+)!==null&&!([\w$]+)\(([\w$]+),([\w$]+)\)\?!1:void 0"""
# Pre-patch shapes: each exactly once before, zero after.
let preRes = [
  re2"""ownCreate:await this\.getGhLogin\([\w$]+\)\.then\(\([\w$]+=>[\w$]+===null\?void 0:[\w$]+\([\w$]+,[\w$]+\)\)\)""",
  re2"""\|\|[\w$]+\([\w$]+,[\w$]+\.hostname\)\?!0:await this\.authorMayPush\(""",
  re2"""ownCreate:[\w$]+===null\?void 0:[\w$]+\([\w$]+,[\w$]+\)\}\)""",
  re2"""\|\|[\w$]+\([\w$]+,[\w$]+\.hostname\)\|\|await this\.authorMayPush\(""",
  re2"""ownCreate:[\w$]+!==null&&![\w$]+\([\w$]+,[\w$]+\)\?!1:void 0""",
]
# End states for sites 1-5, each exactly once after patching.
let ownEndRes = [
  re2"""ownCreate:await this\.getGhLogin\([\w$]+\)\.then\(\([\w$]+=>[\w$]+===null\?void 0:[\w$]+\([\w$]+,[\w$]+\)\|\|globalThis\.__cdbAutoFixAuthorAllowed\?\.\([\w$]+\.user\?\.login,[\w$]+\?\?["`]github\.com["`]\)===true\)\)""",
  re2"""\|\|[\w$]+\([\w$]+,[\w$]+\.hostname\)\|\|globalThis\.__cdbAutoFixAuthorAllowed\?\.\([\w$]+\.user\?\.login,[\w$]+\.hostname\)===true\?!0:await this\.authorMayPush\(""",
  re2"""ownCreate:[\w$]+===null\?void 0:[\w$]+\([\w$]+,[\w$]+\)\|\|globalThis\.__cdbAutoFixAuthorAllowed\?\.\([\w$]+\.user\?\.login,[\w$]+\.hostname\)===true\}\)""",
  re2"""\|\|[\w$]+\([\w$]+,[\w$]+\.hostname\)\|\|globalThis\.__cdbAutoFixAuthorAllowed\?\.\([\w$]+\.user\?\.login,[\w$]+\.hostname\)===true\|\|await this\.authorMayPush\(""",
  re2"""ownCreate:[\w$]+!==null&&![\w$]+\([\w$]+,[\w$]+\)&&!\(globalThis\.__cdbAutoFixAuthorAllowed\?\.\([\w$]+\.user\?\.login,[\w$]+\.hostname\)===true\)\?!1:void 0""",
]

proc allowed(pr, host: string): string =
  ALLOWED & pr & ".user?.login," & host & ")===true"

proc counts(s: string, res: openArray[Regex2]): seq[int] =
  for r in res:
    result.add s.findAll(r).len

proc allEq(c: seq[int], n: int): bool =
  for x in c:
    if x != n:
      return false
  true

proc matcherName(s: string): string =
  let found = s.findAll(matcherRe)
  if found.len != 1:
    echo "  [FAIL] expected exactly one PR-author login matcher; re-audit"
    quit(1)
  s[found[0].group(0)]

proc bounded(middle, what: string) =
  if middle.len > 2000 or "}async " in middle:
    echo "  [FAIL] " & what & " ownership read moved outside its audited method"
    quit(1)

proc apply*(input: string): string =
  result = input
  let done = result.findAll(endRe).len
  let ownDone = counts(result, ownEndRes)
  let pre = counts(result, preRes)
  if done == 2 and allEq(ownDone, 1) and result.findAll(guardRe).len == 0 and
      allEq(pre, 0):
    echo "  [OK] all " & $SITES &
      " host-scoped author checks already patched (idempotent)"
    return
  if done != 0 or not allEq(ownDone, 0) or result.findAll(guardRe).len != 2 or
      result.findAll(autoRe).len != 1 or result.findAll(modelRe).len != 1 or
      not allEq(pre, 1) or result.findAll(byNumRe).len != 1 or
      result.findAll(branchRe).len != 1 or result.findAll(shaRe).len != 1:
    echo "  [FAIL] expected two Auto-fix author guards and five ownership/discovery sites; re-audit"
    quit(1)
  let ld = matcherName(result)
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
  # Site 1: a listed author on the PR's own host counts as own; null login
  # stays undefined. getGhLogin defaults a missing host to github.com.
  result = result.replace(
    byNumRe,
    proc(m: RegexMatch2, s: string): string =
      let host = s[m.group(0)]
      let p = s[m.group(1)]
      let fn = s[m.group(3)]
      let pr = s[m.group(4)]
      if s[m.group(2)] != p or s[m.group(5)] != p or fn != ld:
        echo "  [FAIL] by-number ownership read changed shape; re-audit"
        quit(1)
      "ownCreate:await this.getGhLogin(" & host & ").then((" & p & "=>" & p &
        "===null?void 0:" & fn & "(" & pr & "," & p & ")||" &
        allowed(pr, host & "??\"github.com\"") & "))",
  )
  # Sites 2+3: discovery admits a listed author next to the known-App check;
  # the result is own when the login was read and the author is listed.
  result = result.replace(
    branchRe,
    proc(m: RegexMatch2, s: string): string =
      let middle = s[m.group(5)]
      bounded(middle, "branch")
      let login = s[m.group(2)]
      let host = s[m.group(4)] & ".hostname"
      let pr = s[m.group(8)]
      if s[m.group(0)] != ld or s[m.group(7)] != ld or s[m.group(6)] != login or
          s[m.group(9)] != login:
        echo "  [FAIL] branch discovery/ownership changed shape; re-audit"
        quit(1)
      ld & "(" & s[m.group(1)] & "," & login & ")" & s[m.group(3)] & "||" &
        allowed(s[m.group(1)], host) & middle & login & "===null?void 0:" & ld & "(" & pr &
        "," & login & ")||" & allowed(pr, host) & "})",
  )
  # Sites 4+5: same-repo discovery admits a listed author; ownCreate is no
  # longer false for one (still never true here, matching the user's own PR).
  result = result.replace(
    shaRe,
    proc(m: RegexMatch2, s: string): string =
      let middle = s[m.group(5)]
      bounded(middle, "head-SHA")
      let login = s[m.group(3)]
      let host = s[m.group(4)] & ".hostname"
      let pr = s[m.group(8)]
      if s[m.group(1)] != ld or s[m.group(7)] != ld or s[m.group(6)] != login or
          s[m.group(9)] != login:
        echo "  [FAIL] head-SHA discovery/ownership changed shape; re-audit"
        quit(1)
      s[m.group(0)] & "||" & allowed(s[m.group(2)], host) & middle & login & "!==null&&!" &
        ld & "(" & pr & "," & login & ")&&!(" & allowed(pr, host) & ")?!1:void 0",
  )
  if result.findAll(endRe).len != 2 or result.findAll(guardRe).len != 0 or
      not allEq(counts(result, ownEndRes), 1) or not allEq(counts(result, preRes), 0):
    echo "  [FAIL] all " & $SITES &
      " host-scoped author check end states must be present"
    quit(1)
  echo "  [OK] explicit author allowlist added to both activation paths and five ownership/discovery sites"

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
