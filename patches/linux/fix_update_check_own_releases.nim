# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# "Update available" follows claude-desktop-extra's releases and its click
# opens the README section for the installed package format.
#
# Upstream's Linux updater (v3.1623.3, same shapes with other names in
# v3.1623.0) is
#
#   async function Dti(){xti(),oti(),await pti(),
#     P.info("[updater] Linux: in-app updater off (updates via apt)"),
#     Q("desktop_update_disabled",{reason:"managed_by_package_manager"}),Sti()}
#   function Sti(){... let t=async()=>{ ...autoUpdate.disabled -> idle...
#     let r=await wti(),{state:i}=NY;if(r===null||i.state==="replaced")return;
#     let o=K().autoUpdate.dangerousMaxVersion,
#         s=Ll.default.gt(r,a.app.getVersion())&&!(o&&a5t(r,o))?r:null;
#     s!==(i.state==="available"?i.version:null)&&NY.emulateState(...)};
#     setTimeout((()=>void t()),Kei)}            // 30 s, then hourly
#   var Cti=`https://${jo}/claude-desktop/apt/stable`;
#   function wti(){return bh(Tti().catch((()=>null)),5e3,null)}
#   async function Tti(){let e=process.arch==="arm64"?"arm64":"amd64",
#     t=await a.net.fetch(`${Cti}/dists/stable/main/binary-${e}/Packages`);
#     if(!t.ok)return null; ...max "Version:" of Package: claude-desktop...}
#
# v3.6556.2 keeps those shapes with two additions: the init ends
# `...,Sti(),Hti()}` (a restart-enforcement ticker for the ready/replaced
# states), and the poll opens `let e=a.app.getVersion(),t=async()=>{` and, before
# the apt check, asks upstream's release API only to emit a
# desktop_update_available telemetry event (it never sets the button state).
# v4.16336.0 reorders the init tail to `...,TICK(),await WAIT(),POLL()}` (WAIT
# settles the managed-settings overlay first) and the poll returns to idle
# early when a self-hosted updates host is configured; the shapes A and B
# rewrite are unchanged. v5.11492.0 sends the telemetry event after an apt
# source probe, `PROBE().then((e=>Q("desktop_update_disabled",{...,apt_source:e})))`;
# C's anchor accepts both forms.
#
# where `a` is require("electron"). So the button shows whenever Anthropic's
# apt has a newer claude-desktop than app.getVersion(). Our users update from
# our own packages, which trail Anthropic's apt; our patch releases
# (v3.1623.1-2) never show, since semver.gt("3.1623.1-2","3.1623.1") is false;
# and the claude.ai SPA's click on the button does
# window.open("https://code.claude.com/docs/<locale>/desktop-linux#update"),
# Anthropic's apt instructions. The main view's window-open handler sends that
# https URL through J9 -> Uy, which calls `a.shell.openExternal(n)`: looked up
# on electron's shell object at call time, so a wrapper installed on it later
# still sees the URL.
#
# js/update_check_own_releases.js is inlined once, as
# `globalThis.__cdbUpdateOwn||=(...);` in front of the fetcher, and:
#
#   A. the fetcher's body becomes `return globalThis.__cdbUpdateOwn.latestTag(a)`:
#      our latest GitHub release tag without the "v" (3.1623.1-2), null on an
#      HTTP error or a tag outside ^v\d+\.\d+\.\d+(-\d+)?$. Upstream's 5 s
#      timeout wrapper, its catch -> null, the hourly cadence and the
#      "null -> keep the state" rule stay.
#   B. the poll's `Ll.default.gt(r,a.app.getVersion())` becomes
#      `globalThis.__cdbUpdateOwn.isNewer(r,a.app.getVersion())`, comparing
#      (X.Y.Z, N) against the build-time stamp resources/cdb-release.json
#      (or app.getVersion(), N=1, without one), and the dangerousMaxVersion cap
#      gets `__cdbUpdateOwn.xyz(r)`, the tag without -N. autoUpdate.disabled
#      and the `replaced` (binary swapped -> relaunch) path are untouched.
#   C. the Linux updater init calls `globalThis.__cdbUpdateOwn.hookLinks(a)`
#      right before it starts the poll: electron.shell.openExternal is wrapped
#      once, and exactly the desktop-linux#update docs URL becomes
#      https://github.com/patrickjaja/claude-desktop-extra#install-<format>
#      (#quick-install without a stamp). Composes with fix_profile_url_routing's
#      wrapper in either order.
#
# One [cdb-update] line per decision change and per rewritten link lands in
# claude-patches.log.
#
# Preconditions asserted (fail loud, Rule 4): the apt Packages fetcher, its
# 5 s wrapper and its apt base URL exist once; the poll's compare reads that
# wrapper's result through the same electron alias; the cap helper is
# semver-based; the updater init starts that poll. If upstream's fetcher
# already asks our releases, the patch is absorbed and fails.

import std/[os, strformat, strutils]
import regex

const EXPECTED_PATCHES = 3 # A fetcher, B compare, C link hook

const HELPER_JS = staticRead("../../js/update_check_own_releases.js")

# Bumped whenever the helper's shape changes, so idempotency asserts THIS
# version's injected end-state rather than "something of ours is present".
const MARKER = "__cdb_update_own_releases_v1__"

const HELPER_DEF = "globalThis.__cdbUpdateOwn||=("

# Minified identifiers may contain `$`, which is a regex metacharacter.
proc rxEscape(name: string): string =
  name.replace("$", "\\$")

proc allMatches(s: string, r: Regex2): seq[RegexMatch2] =
  for m in s.findAll(r):
    result.add m

proc fail(msg: string) =
  echo "  [FAIL] " & msg
  quit(1)

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0

  let markerCount = result.count(MARKER)
  if markerCount == 0 and
      "api.github.com/repos/patrickjaja/claude-desktop-extra" in result:
    fail(
      "the bundle already asks api.github.com/repos/patrickjaja/claude-desktop-extra " &
        "without our helper: upstream checks our releases itself, this patch is " &
        "absorbed: remove it (Rule 4)"
    )

  # ── A: the apt Packages fetcher ─────────────────────────────────────────
  #   groups: 0 fn, 1 arch, 2 resp, 3 electron, 4 base url var, 5 arch use,
  #           6 resp.ok, 7 result var, 8 resp.text, 9 returned var
  let fetchRe = re2(
    """async function ([\w$]+)\(\)\{let ([\w$]+)=process\.arch===["`]arm64["`]\?["`]arm64["`]:""" &
      """["`]amd64["`],([\w$]+)=await ([\w$]+)\.net\.fetch\(`\$\{([\w$]+)\}/dists/stable/main/""" &
      """binary-\$\{([\w$]+)\}/Packages`\);if\(!([\w$]+)\.ok\)return null;let ([\w$]+)=null;""" &
      """for\(let [\w$]+ of\(await ([\w$]+)\.text\(\)\)\.split\(`\\n\\n`\)\)\{if\(!/\^Package: """ &
      """claude-desktop\$/m\.test\([\w$]+\)\)continue;let [\w$]+=[\w$]+\.default\.valid\(""" &
      """/\^Version: \(\\S\+\)\$/m\.exec\([\w$]+\)\?\.\[1\]\);[\w$]+!==null&&\([\w$]+===null""" &
      """\|\|[\w$]+\.default\.gt\([\w$]+,[\w$]+\)\)&&\([\w$]+=[\w$]+\)\}return ([\w$]+)\}"""
  )
  let fetchDoneRe = re2(
    """async function ([\w$]+)\(\)\{return globalThis\.__cdbUpdateOwn\.latestTag\(([\w$]+)\)\}"""
  )
  let fetchMatches = allMatches(result, fetchRe)
  let fetchDone = allMatches(result, fetchDoneRe)
  let helperCount = result.count(HELPER_DEF)
  var fetchFn, electron: string
  var aPending = false
  if fetchDone.len == 1 and fetchMatches.len == 0 and helperCount == 1 and
      markerCount == 1:
    fetchFn = result[fetchDone[0].group(0)]
    electron = result[fetchDone[0].group(1)]
  elif fetchDone.len == 0 and fetchMatches.len == 1 and helperCount == 0 and
      markerCount == 0:
    let m = fetchMatches[0]
    fetchFn = result[m.group(0)]
    electron = result[m.group(3)]
    if result[m.group(1)] != result[m.group(5)] or
        result[m.group(2)] != result[m.group(6)] or
        result[m.group(2)] != result[m.group(8)] or
        result[m.group(7)] != result[m.group(9)]:
      fail(
        &"A: fetcher {fetchFn} matched but its locals are used inconsistently; re-audit"
      )
    let base = result[m.group(4)]
    let baseRe = re2(
      "var " & rxEscape(base) & """=`https://\$\{[\w$]+\}/claude-desktop/apt/stable`;"""
    )
    if allMatches(result, baseRe).len != 1:
      fail(
        &"A: fetcher {fetchFn} reads {base}, which is not Anthropic's apt base URL " &
          "anymore; re-audit (if it is our releases, this patch is absorbed: remove it (Rule 4))"
      )
    let at = m.boundaries.a
    if at == 0 or result[at - 1] notin {'}', ';'}:
      fail(
        &"A: fetcher {fetchFn} is not at statement position; cannot inline the helper"
      )
    aPending = true
  else:
    fail(
      &"A: apt Packages fetcher found {fetchMatches.len} time(s), patched fetcher " &
        &"{fetchDone.len}, helper {helperCount}, marker {markerCount}; expected 1/0/0/0 " &
        "(pristine) or 0/1/1/1 (applied). If upstream's fetcher now asks our releases, " &
        "this patch is absorbed: remove it (Rule 4)"
    )

  # upstream's 5 s timeout wrapper around the fetcher
  let wrapRe = re2(
    """function ([\w$]+)\(\)\{return [\w$]+\(""" & rxEscape(fetchFn) &
      """\(\)\.catch\(\(\(\)=>null\)\),5e3,null\)\}"""
  )
  let wraps = allMatches(result, wrapRe)
  if wraps.len != 1:
    fail(
      &"A: 5 s timeout wrapper around {fetchFn} found {wraps.len} time(s), expected 1; re-audit"
    )
  let wrapFn = result[wraps[0].group(0)]

  # ── B's anchor: the poll's compare ───────────────────────────────────────
  #   groups: 0 r, 1 wrapper, 2 i, 3 NY, 4 r, 5 i, 6 o, 7 s, then per shape
  let pollHead =
    """let ([\w$]+)=await ([\w$]+)\(\),\{state:([\w$]+)\}=([\w$]+);if\(([\w$]+)===null\|\|""" &
    """([\w$]+)\.state===["`]replaced["`]\)return;let ([\w$]+)=[\w$]+\(\)\.autoUpdate\.""" &
    """dangerousMaxVersion,([\w$]+)="""
  let pollTail =
    """\?([\w$]+):null;([\w$]+)!==\(([\w$]+)\.state===["`]available["`]\?([\w$]+)\.version:null\)""" &
    """&&([\w$]+)\.emulateState\("""
  #   pristine: 8 semver, 9 r, 10 electron, 11 o, 12 cap fn, 13 r, 14 o, 15 r, 16 s, 17 i, 18 i, 19 NY
  let cmpRe = re2(
    pollHead &
      """([\w$]+)\.default\.gt\(([\w$]+),([\w$]+)\.app\.getVersion\(\)\)&&!\(([\w$]+)&&([\w$]+)""" &
      """\(([\w$]+),([\w$]+)\)\)""" & pollTail
  )
  #   patched: 8 r, 9 electron, 10 o, 11 cap fn, 12 r, 13 o, 14 r, 15 s, 16 i, 17 i, 18 NY
  let cmpDoneRe = re2(
    pollHead &
      """globalThis\.__cdbUpdateOwn\.isNewer\(([\w$]+),([\w$]+)\.app\.getVersion\(\)\)&&!\(""" &
      """([\w$]+)&&([\w$]+)\(globalThis\.__cdbUpdateOwn\.xyz\(([\w$]+)\),([\w$]+)\)\)""" &
      pollTail
  )
  let cmpMatches = allMatches(result, cmpRe)
  let cmpDone = allMatches(result, cmpDoneRe)
  var bPending = false
  var cmpMatch: RegexMatch2
  var capFn: string
  if cmpDone.len == 1 and cmpMatches.len == 0:
    cmpMatch = cmpDone[0]
    capFn = result[cmpMatch.group(11)]
    if result[cmpMatch.group(9)] != electron:
      fail(
        &"B: patched compare uses electron alias {result[cmpMatch.group(9)]}, the fetcher {electron}"
      )
  elif cmpDone.len == 0 and cmpMatches.len == 1:
    cmpMatch = cmpMatches[0]
    capFn = result[cmpMatch.group(12)]
    if result[cmpMatch.group(10)] != electron:
      fail(
        &"B: compare uses electron alias {result[cmpMatch.group(10)]}, the fetcher {electron}; re-audit"
      )
    bPending = true
  else:
    fail(
      &"B: poll compare `gt(r,app.getVersion())` found {cmpMatches.len} time(s), patched " &
        &"compare {cmpDone.len} time(s); expected exactly one of them once (the poll changed " &
        "shape; re-audit)"
    )
  block:
    let m = cmpMatch
    let r = result[m.group(0)]
    let i = result[m.group(2)]
    let ny = result[m.group(3)]
    let o = result[m.group(6)]
    let s = result[m.group(7)]
    let rs =
      if bPending:
        @[4, 9, 13, 15]
      else:
        @[4, 8, 12, 14]
    let os =
      if bPending:
        @[11, 14]
      else:
        @[10, 13]
    let tailS = (if bPending: 16 else: 15)
    for g in rs:
      if result[m.group(g)] != r:
        fail("B: the poll's fetched-version local is used inconsistently; re-audit")
    for g in os:
      if result[m.group(g)] != o:
        fail("B: the poll's dangerousMaxVersion local is used inconsistently; re-audit")
    if result[m.group(5)] != i or result[m.group(tailS + 1)] != i or
        result[m.group(tailS + 2)] != i or result[m.group(tailS)] != s or
        result[m.group(tailS + 3)] != ny:
      fail("B: the poll's state locals are used inconsistently; re-audit")
    if result[m.group(1)] != wrapFn:
      fail(
        &"B: the poll awaits {result[m.group(1)]}, not the fetcher's wrapper {wrapFn}; re-audit"
      )
  # the cap helper must still be upstream's semver compare
  let capRe = re2(
    "function " & rxEscape(capFn) &
      """\(([\w$]+),([\w$]+)\)\{return [\w$]+\.default\.valid\([\w$]+\)!==null&&"""
  )
  if allMatches(result, capRe).len != 1:
    fail(
      &"B: cap helper {capFn} is not upstream's semver dangerousMaxVersion check anymore; re-audit"
    )

  # ── C's anchor: the Linux updater init that starts the poll ──────────────
  let initPrefix =
    """[\w$]+\.info\(["`]\[updater\] Linux: in-app updater off \(updates via apt\)["`]\),""" &
    """(?:[\w$]+\(["`]desktop_update_disabled["`],\{reason:["`]managed_by_package_manager["`]\}\)|""" &
    """[\w$]+\(\)\.then\(\(\(?[\w$]+\)?=>[\w$]+\(["`]desktop_update_disabled["`],\{reason:["`]managed_by_package_manager["`],apt_source:[\w$]+\}\)\)\)),"""
  # The init ends in a comma list of argument-less calls after the telemetry
  # call: `...,POLL(),TICK()}` in v3.6556.2, `...,TICK(),await WAIT(),POLL()}`
  # since v4.16336.0. The list is captured whole (group 0 = prefix, 1 = list)
  # and split here; exactly one element must be the poll (checked below), and
  # the patched list carries `globalThis.__cdbUpdateOwn.hookLinks(<electron>)`
  # right before it.
  let initRe = re2("(" & initPrefix & """)([^{}]*)\}""")
  let callRe = re2"""(?:await )?([\w$]+)\(\)"""
  let hookRe = re2"""globalThis\.__cdbUpdateOwn\.hookLinks\(([\w$]+)\)"""
  let inits = allMatches(result, initRe)
  if inits.len != 1:
    fail(&"C: Linux updater init found {inits.len} time(s), expected 1; re-audit")
  let initM = inits[0]
  let calls = result[initM.group(1)].split(',')
  var hookAt = -1
  var callees: seq[string]
  for i, c in calls:
    var cm = RegexMatch2()
    if c.match(hookRe, cm):
      if hookAt >= 0:
        fail("C: patched updater init hooks the update link twice; re-audit")
      if c[cm.group(0)] != electron:
        fail(
          "C: patched updater init hooks a different electron alias than the fetcher's"
        )
      hookAt = i
      callees.add ""
    elif c.match(callRe, cm):
      callees.add c[cm.group(0)]
    else:
      fail(&"C: updater init tail `{c}` is not an argument-less call; re-audit")
  # The function the init starts must be the poll that owns B's compare.
  proc pollReFor(fn: string): Regex2 =
    re2(
      "function " & rxEscape(fn) & """\(\)\{let [\w$]+=""" & rxEscape(electron) &
        """\.app\.getVersion\(\)[;,]"""
    )

  var pollAt = -1
  for i, fn in callees:
    if fn.len > 0 and allMatches(result, pollReFor(fn)).len == 1:
      if pollAt >= 0:
        fail("C: the updater init starts two poll-shaped functions; re-audit")
      pollAt = i
  if pollAt < 0:
    fail(
      &"C: none of the updater init calls `{result[initM.group(1)]}` is the poll; re-audit"
    )
  let pollFn = callees[pollAt]
  var cPending = false
  if hookAt < 0:
    cPending = true
  elif hookAt != pollAt - 1:
    fail("C: patched updater init hooks the update link, but not right before the poll")
  # The function the init starts must be the poll that owns B's compare.
  let polls = allMatches(result, pollReFor(pollFn))
  if polls[0].boundaries.b >= cmpMatch.boundaries.a or
      "function " in result[polls[0].boundaries.b + 1 ..< cmpMatch.boundaries.a]:
    fail(&"C: the compare B rewrites is not inside {pollFn}; re-audit")

  # ── apply, back to front so earlier offsets stay valid ───────────────────
  # Order in the bundle: poll (B) < fetcher (A) < init (C). Assert it.
  if aPending or bPending or cPending:
    var fetchAt = 0
    var initAt = 0
    if aPending:
      fetchAt = fetchMatches[0].boundaries.a
    else:
      fetchAt = fetchDone[0].boundaries.a
    initAt = initM.boundaries.a
    if not (cmpMatch.boundaries.a < fetchAt and fetchAt < initAt):
      fail("internal: expected poll < fetcher < updater init in the bundle; re-audit")

  if cPending:
    var tail = calls
    tail.insert("globalThis.__cdbUpdateOwn.hookLinks(" & electron & ")", pollAt)
    let injected = result[initM.group(0)] & tail.join(",") & "}"
    result =
      result[0 ..< initM.boundaries.a] & injected & result[initM.boundaries.b + 1 .. ^1]
    echo &"  [OK] C: updater init now hooks the update link before starting the poll {pollFn}"
    patchesApplied += 1
  else:
    echo "  [OK] C: updater init already hooks the update link (idempotent)"
    patchesApplied += 1

  if aPending:
    let m = fetchMatches[0]
    let injected =
      HELPER_DEF & HELPER_JS.strip() & ");async function " & fetchFn &
      "(){return globalThis.__cdbUpdateOwn.latestTag(" & electron & ")}"
    result = result[0 ..< m.boundaries.a] & injected & result[m.boundaries.b + 1 .. ^1]
    echo &"  [OK] A: {fetchFn} now returns our latest release tag (electron={electron}, " &
      &"timeout wrapper {wrapFn})"
    patchesApplied += 1
  else:
    echo &"  [OK] A: fetcher already returns __cdbUpdateOwn.latestTag ({MARKER})"
    patchesApplied += 1

  if bPending:
    let m = cmpMatch
    let r = result[m.group(0)]
    let o = result[m.group(6)]
    let s = result[m.group(7)]
    let matched = result[m.boundaries]
    let head = s & "=" & result[m.group(8)] & ".default.gt("
    let at = matched.find("," & head)
    let qAt = matched.find("?" & r & ":null;")
    if at < 0 or qAt < at:
      fail("internal: compare slice markers missing")
    let injected =
      matched[0 .. at] & s & "=globalThis.__cdbUpdateOwn.isNewer(" & r & "," & electron &
      ".app.getVersion())&&!(" & o & "&&" & capFn & "(globalThis.__cdbUpdateOwn.xyz(" & r &
      ")," & o & "))" & matched[qAt .. ^1]
    result = result[0 ..< m.boundaries.a] & injected & result[m.boundaries.b + 1 .. ^1]
    echo &"  [OK] B: poll compare now asks __cdbUpdateOwn.isNewer (cap {capFn} on X.Y.Z)"
    patchesApplied += 1
  else:
    echo "  [OK] B: poll compare already asks __cdbUpdateOwn.isNewer (idempotent)"
    patchesApplied += 1

  # Positive end-state assertions (Rule 6).
  if allMatches(result, fetchDoneRe).len != 1 or allMatches(result, fetchRe).len != 0 or
      result.count(HELPER_DEF) != 1 or result.count(MARKER) != 1:
    fail("A: end state missing (patched fetcher, helper or " & MARKER & ")")
  if allMatches(result, cmpDoneRe).len != 1 or allMatches(result, cmpRe).len != 0:
    fail("B: end state missing (patched compare)")
  let initsOut = allMatches(result, initRe)
  let hookedPoll =
    "globalThis.__cdbUpdateOwn.hookLinks(" & electron & ")," & pollFn & "()"
  if initsOut.len != 1 or
      ("," & result[initsOut[0].group(1)] & ",").count("," & hookedPoll & ",") != 1:
    fail("C: end state missing (hookLinks call in the updater init)")

  if patchesApplied < EXPECTED_PATCHES:
    fail(&"Only {patchesApplied}/{EXPECTED_PATCHES} patches applied")

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_update_check_own_releases <path_to_index.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_update_check_own_releases ==="
  echo &"  Target: {filePath}"
  if not fileExists(filePath):
    echo &"  [FAIL] File not found: {filePath}"
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] Update check own releases: 3/3 patches applied"
  else:
    echo "  [PASS] No changes needed (already applied)"
