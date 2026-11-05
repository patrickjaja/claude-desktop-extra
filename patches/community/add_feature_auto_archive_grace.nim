# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Opt-in (default immediate = upstream): delay upstream's PR auto-archive after
# a PR merges or closes. Row: Settings -> Extra -> Community Features ->
# "Auto-archive delay after PR merge or close" (key `autoArchiveMergeDelayMinutes`,
# read once per sweep through globalThis.__cdbAutoArchiveMergeDelayMinutes(),
# defined by js/extra_settings_main.js). The inactivity rule is unchanged.
#
# Wraps AutoArchiveEngine (index chunk on 4.23118.0). Seven sub-patches, each
# anchor must match exactly once:
#   A  async checkAndArchive(r,a,s,c){ -> a lazy __cdbGrace() factory before it
#      (js/auto_archive_grace.js), bound to the native ccAutoArchiveOnPrClose pref.
#   B  async sweep(t=!1){ -> wrapper: snapshot the delay at sweep start, run the
#      original, then reconcile the grace ledger in `finally`.
#   C  !n.s(d))return;  (the non-terminal return) -> report the answer to the
#      helper, so a positive OPEN answer clears a pending grace.
#   D  the reopenSeen short return, right before `if(s){if(!this.takesShare(` ->
#      the terminal gate for a confirmed MERGED/CLOSED verdict (`!_`, where `_`
#      is upstream's unconfirmed-close binding). During a grace upstream's takesShare slot,
#      waitsOnRememberedClose / waitsOnUnrecordedPr (GitHub reads) and
#      inspectSessionWorktree (git) are skipped; after expiry all of them run.
#      It sits inside upstream's `if(!s){` block (so the PR rule, never
#      inactivity) after that block's own `let s` (readsGitHub), so it does
#      not test `s`. Being after upstream's reopenSeen return, a stale CLOSED
#      binding of a just-reopened PR returns before it and cannot restart a
#      cancelled grace.
#   E  `if(t.length>1){this.prCheckedAt.set(..);return}if(d=` -> skip
#      lookupPrState while the session's terminal verdict is known and its
#      grace is still pending (no GitHub read during a grace).
#   F  waitsOnRememberedClose's confirmed-reopen return -> cancel the grace.
#   G  end of the `if(!s){` block, before inspectSessionWorktree -> the gate for
#      an unconfirmed close (`_`): upstream confirms it first (that is a
#      GitHub read every sweep, as upstream does without the grace), so an
#      unconfirmed close never starts a grace on its own.
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

proc one(input: string, pattern: Regex2, what: string): RegexMatch2 =
  let hits = input.findAll(pattern)
  if hits.len != 1:
    raise newException(
      ValueError,
      "archive-grace " & what & " anchor count " & $hits.len & ", expected 1",
    )
  hits[0]

proc apply*(input: string): string =
  result = input
  # Resolve the settings module from a stable native archive preference anchor.
  let prefs = one(
    input,
    re2"""sessionAutoArchiveOnPrClose\([\w$]+\.sessionId\)\?\?([\w$]+)\.([\w$]+)\("ccAutoArchiveOnPrClose"\)""",
    "preference",
  )
  # Module and getter both re-minify (drt on 4.16336.0, Tit on 4.23118.0).
  let module = input[prefs.group(0)]
  let getter = input[prefs.group(1)]
  let methodText =
    "__cdbGrace(){return this.__cdbArchiveGrace??=" & helper & "(this,()=>" & module &
    "." & getter & "(\"ccAutoArchiveOnPrClose\")===!0)}"
  const head = re2"async checkAndArchive\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)\)\{"
  let heads = one(input, head, "archive entry")
  let session = input[heads.group(0)]
  let now = input[heads.group(1)]
  # checkAndArchive's try-block locals: own bindings, terminal state `d` and
  # the unconfirmed-close binding `_`. This anchor survives our own patching.
  let locals = one(
    input,
    re2"""async checkAndArchive\([\w$]+,[\w$]+,[\w$]+,[\w$]+\)\{let [\w$]+=[\w$]+\?"inactive":"pr";try\{let ([\w$]+)=this\.ownPrBindings\([\w$]+\.prs\),([\w$]+)=null,[\w$]+=!1,[\w$]+=!1,([\w$]+);""",
    "checkAndArchive locals",
  )
  let own = input[locals.group(0)]
  let state = input[locals.group(1)]
  let unconfirmed = input[locals.group(2)]
  let inactive = input[heads.group(2)]

  let observe =
    "if(process.platform===\"linux\")await this.__cdbGrace().wait(" & session & "," &
    state & ");return"
  let guard =
    "if(process.platform===\"linux\"&&!" & unconfirmed & "&&(" & state &
    "===\"merged\"||" & state & "===\"closed\")&&await this.__cdbGrace().wait(" & session &
    "," & state & "))return;"
  let lateGate =
    "if(process.platform===\"linux\"&&!" & inactive & "&&" & unconfirmed &
    "&&await this.__cdbGrace().wait(" & session & "," & state & "))return;"
  let shortcut =
    "if(process.platform===\"linux\"&&this.terminalVerdict(" & session & ".sessionId," &
    own & "," & now & ").terminal&&this.__cdbGrace().pending(" & session & "))return;"

  let sweepHead = re2"async sweep\(([\w$]+)=!1\)\{"
  let sweeps = one(input, sweepHead, "sweep entry")
  let kicked = input[sweeps.group(0)]
  let sweepWrapper =
    "async sweep(" & kicked &
    "=!1){let __cdbOwn=process.platform===\"linux\"&&!this.sweeping;__cdbOwn&&this.__cdbGrace().begin();try{return await this.__cdbOriginalArchiveSweep(" &
    kicked &
    ")}finally{__cdbOwn&&!this.sweeping&&await this.__cdbGrace().reconcileAll()}}async __cdbOriginalArchiveSweep(" &
    kicked & "=!1){"

  let reopens = one(
    input,
    re2"""this\.answered\(([\w$]+)\.sessionId,"close"\),this\.reopenSeen\.set\(""",
    "confirmed-reopen",
  )
  let cancel =
    "process.platform===\"linux\"&&this.__cdbGrace().cancel(" & input[reopens.group(0)] &
    ".sessionId),"

  # What C, D, E and G sit in front of; asserted on the patched result too.
  let gateTail = re2"if\([\w$]+\)\{if\(!this\.takesShare\("
  let shortcutTail = re2"if\(([\w$]+)=([\w$]+)\.length>0&&"
  let lateTail = re2"let [\w$]+=await [\w$]+\.inspectSessionWorktree\("
  let observeTail = re2"\}let [\w$]+=this\.holdReason\("

  proc followedBy(s, injected: string, tail: Regex2): bool =
    let at = s.find(injected)
    at >= 0 and s.count(injected) == 1 and s.startsWith(tail, at + injected.len)

  if "__cdbArchiveGrace" in input:
    if input.count(methodText) != 1 or input.count(sweepWrapper) != 1 or
        not input.followedBy(observe, observeTail) or
        not input.followedBy(guard, gateTail) or
        not input.followedBy(shortcut, shortcutTail) or
        not input.followedBy(lateGate, lateTail) or input.count(cancel) != 1:
      raise newException(ValueError, "archive-grace injection incomplete or stale")
    echo "  [OK] archive-grace factory, sweep wrapper, gates and reopen cancel already present"
    return

  const EXPECTED_PATCHES = 7
  var patchesApplied = 0
  # A: factory
  result = once(
    result,
    head,
    proc(m: RegexMatch2, s: string): string =
      methodText & s[m.boundaries],
  )
  inc patchesApplied
  # B: sweep wrapper
  result = once(
    result,
    sweepHead,
    proc(m: RegexMatch2, s: string): string =
      sweepWrapper,
  )
  inc patchesApplied
  # C: non-terminal answers reach the helper
  result = once(
    result,
    re2"![\w$]+\.s\([\w$]+\)\)return;let [\w$]+=this\.holdReason\(",
    proc(m: RegexMatch2, s: string): string =
      s[m.boundaries].replace("return;", "{" & observe & "}"),
  )
  inc patchesApplied
  # D: terminal gate before upstream's pre-archive GitHub/git work
  result = once(
    result,
    re2"if\(([\w$]+)&&([\w$]+)\?\.bindings===[\w$]+\([\w$]+\)&&[\w$]+-[\w$]+\.at<[\w$]+\)return;if\([\w$]+\)\{if\(!this\.takesShare\(",
    proc(m: RegexMatch2, s: string): string =
      let text = s[m.boundaries]
      let cut = text.find(")return;") + ")return;".len
      text[0 ..< cut] & guard & text[cut .. ^1],
  )
  inc patchesApplied
  # E: no lookupPrState while a known terminal verdict is still in its grace
  result = once(
    result,
    re2"if\(([\w$]+)\.length>1\)\{this\.prCheckedAt\.set\(([\w$]+)\.sessionId,([\w$]+)\);return\}if\(([\w$]+)=([\w$]+)\.length>0&&",
    proc(m: RegexMatch2, s: string): string =
      if s[m.group(1)] != session or s[m.group(2)] != now or s[m.group(3)] != state or
          s[m.group(4)] != own:
        raise newException(ValueError, "archive-grace lookup anchor names drifted")
      let text = s[m.boundaries]
      let cut = text.find("return}") + "return}".len
      text[0 ..< cut] & shortcut & text[cut .. ^1],
  )
  inc patchesApplied
  # F: a confirmed reopen cancels the grace
  result = once(
    result,
    re2"""[\w$]+\.length>0\)return this\.answered\([\w$]+\.sessionId,"close"\),this\.reopenSeen\.set\(""",
    proc(m: RegexMatch2, s: string): string =
      s[m.boundaries].replace("return ", "return " & cancel),
  )
  inc patchesApplied
  # G: an unconfirmed close is gated only after upstream confirmed it
  result = once(
    result,
    re2"this\.noPrAnswer\.delete\([\w$]+\.sessionId\)\}\}let [\w$]+=await [\w$]+\.inspectSessionWorktree\(",
    proc(m: RegexMatch2, s: string): string =
      let text = s[m.boundaries]
      let cut = text.find("}}") + 2
      text[0 ..< cut] & lateGate & text[cut .. ^1],
  )
  inc patchesApplied
  if patchesApplied != EXPECTED_PATCHES or not result.followedBy(guard, gateTail) or
      not result.followedBy(shortcut, shortcutTail) or
      not result.followedBy(lateGate, lateTail):
    quit(
      "  [FAIL] archive-grace: " & $patchesApplied & "/" & $EXPECTED_PATCHES &
        " sub-patches applied or end state missing",
      1,
    )
  echo "  [OK] archive-grace factory, sweep wrapper, gates and reopen cancel applied (7/7)"

when isMainModule:
  if paramCount() != 1:
    quit("Usage: add_feature_auto_archive_grace <bundle.js>", 1)
  let file = paramStr(1)
  writeFile(file, apply(readFile(file)))
