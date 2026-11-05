# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Log silently-suppressed main-webview renderer deaths (#128).
#
# The main webview's "render-process-gone" handler logs and reloads only when
# it decides to act. Every death it decides to swallow -- an expected kill it
# has counted, a "clean-exit", or a "killed" that arrives while the app is
# quitting -- leaves no trace in main.log at all, so a renderer that dies (->
# blank view, claude.ai re-login) is invisible after the fact. Log those.
#
# Pure observability: the handler's own decisions are re-emitted verbatim and
# their values are passed straight through, so which deaths get reloaded is
# unchanged. Only the silent paths gain a log line.

import std/[os, strutils]
import regex

# Literal substring of the injected log line; absent from the fresh bundle.
const AppliedMarker = "Main webview render process gone (suppressed)"

proc logCall(logger, details: string): string =
  logger & """.info("Main webview render process gone (suppressed): %o",{reason:""" &
    details & ".reason,exitCode:" & details & ".exitCode})"

# Every early `return` of the handler's guards, in either spelling:
#   `)return;`           -> `){<log>;return}`
#   `{<body>;return}`    -> `{<body>;<log>;return}`
proc addLogs(guards, log: string): string =
  guards.replace(
    re2"""\)return;|([{;])return\}""",
    proc(m: RegexMatch2, s: string): string =
      if m.group(0).a < 0 or m.group(0).len == 0:
        "){" & log & ";return}"
      else:
        s[m.group(0)] & log & ";return}",
  )

# The main-webview handler head, and the log line that pins it.
let headRe =
  re2"""\.on\(["`]render-process-gone["`],\(?async\(([\w$]+),([\w$]+)\)=>\{"""
const HandledLog = "Main webview render process gone: %o"

proc apply*(input: string): string =
  # Idempotency: positive end-state. Between the main-webview handler's head
  # and upstream's own log line, every early `return` is preceded by our log
  # call, and our log call appears nowhere else.
  if input.count(AppliedMarker) > 0:
    let h = input.find(HandledLog)
    var heads: seq[RegexMatch2] = @[]
    let winStart = max(0, h - 3000)
    let win =
      if h > 0:
        input[winStart ..< h]
      else:
        ""
    if h > 0 and input.count(HandledLog) == 1:
      for m in win.findAll(headRe):
        heads.add m
    if heads.len > 0:
      let seg = win[heads[^1].boundaries.b + 1 .. ^1]
      let returns = seg.count("return")
      let logged = seg.count(AppliedMarker & """: %o",{reason:""")
      # each log call sits directly in front of its `return`
      let loggedReturns = seg.count(".exitCode});return}")
      if returns >= 2 and logged == returns and loggedReturns == returns and
          input.count(AppliedMarker) == logged:
        echo "  [OK] suppressed renderer-gone log: already applied (" & $logged &
          " early returns logged)"
        return input
    echo "  [FAIL] '" & AppliedMarker &
      "' present but not in front of every early return of the main-webview handler; re-audit"
    quit(1)

  # Shape history of the handler's suppression decision:
  #   <= v1.24012.9: inline early-return branch
  #     .on("render-process-gone",async(i,r)=>{if(KG>0||r.reason==="killed"||...){...;return}if(D.info("Main webview render process gone: %o
  #   v1.26832.0 - v1.30096.1: one hoisted predicate ANDed into a single condition
  #   v1.32352.1: SPLIT into an early-return guard, an interposed `let`, and a second if
  #   v1.37937.0: the interposed `let` gained a second declarator
  #   v1.46388.2: the second condition became a second early-return guard:
  #     e.on("render-process-gone",(async(t,i)=>{if(!T6t(i))return;let a=Q6t(),o=FWt();if(i.reason==="killed"&&(await new Promise((e=>setTimeout(e,_6t))),e.isDestroyed()||XA())||e.isDestroyed())return;N.info("Main webview render process gone: %o",i);
  #   v2.31226.0: the first guard runs a call first - `if(II(e),!aBn(n))return;`
  #   v4.29.0: a bare call statement sits between the first guard and the `let`,
  #   and the second guard is split into two block guards that end the hang-kill
  #   recovery before returning:
  #     e.on("render-process-gone",(async(t,n)=>{if($B(e),!Wnr(n))return;d();let r=l(),i=nV(e),s=wV(),c=kVn();
  #       if(n.reason==="killed"&&(await new Promise((e=>setTimeout(e,Onr))),e.isDestroyed()||XN())){p("abandoned");return}
  #       if(e.isDestroyed()){p("abandoned");return}P.info("Main webview render process gone: %o",n),...
  #     p() logs only while a hang-kill recovery is in progress, so these deaths
  #     still leave no trace in main.log otherwise (#128).
  #   v4.23118.0: a bare call and a `let` (Date.now()) now precede the first guard,
  #   and the second `let` carries an object-literal declarator, so both lets are
  #   matched as `let <no-semicolon run>;`:
  #     {H4n(e);let r=Date.now(),i=O4n(r);if(!F3n(n))return;d();let s=l(),...,h={...b6n(r),renderer_age_ms:i};if(...){p("abandoned");return}...
  #
  # Every early return is a suppressed death that stays silent -- the gap #128
  # is about. Each gains a log line right before its `return`; the guard
  # conditions, their bodies, the bare calls and the `let` are re-emitted
  # verbatim (the `await` stays where it was, in the enclosing async arrow), so
  # which deaths get reloaded is unchanged.
  #
  # The guard run after the `let` is one or more `if(<cond>)return;` or
  # `if(<cond>){<body>return}` statements. A condition is a run of non-brace
  # characters, spelled as three concatenated runs because the regex library
  # caps a repetition range at 100; ~85 chars in v4.29.0. Excluding braces
  # bounds the match so it cannot run into the telemetry object literal that
  # follows the log call.
  #
  # The trailing `.info(<q>Main webview render process gone: %o` both pins this
  # site (50 render-process-gone mentions exist; only this one logs that
  # message) and captures the logger identifier (dotted namespace tolerated).
  # Count policy: exactly 1. A second copy means upstream duplicated the
  # handler and the site needs a re-audit; 0 means upstream changed the code.
  # Both fail loudly.
  let pattern =
    re2"""(\.on\(["`]render-process-gone["`],\(?async\(([\w$]+),([\w$]+)\)=>\{)((?:[\w$]+(?:\.[\w$]+)*\([^()]*\);)*(?:let [^;]*;)?)(if\(((?:[\w$]+(?:\.[\w$]+)*\([^()]*\),)*)!([\w$]+)\(([\w$]+)\)\)return;)((?:[\w$]+(?:\.[\w$]+)*\([^()]*\);)*)(let [^;]*;)((?:if\([^{}]{1,100}[^{}]{0,100}[^{}]{0,100}\)(?:return;|\{[^{}]{0,100}return\}))+)(([\w$]+(?:\.[\w$]+)*)\.info\(["`]Main webview render process gone: %o)"""
  var count = 0
  var guardCount = 0
  result = input.replace(
    pattern,
    proc(m: RegexMatch2, s: string): string =
      # group(0) head incl. arrow params; group(1) is the (unused) event arg.
      let head = s[m.group(0)]
      let preamble = s[m.group(3)] # bare calls / `let` before the first guard, verbatim
      let details = s[m.group(2)] # RenderProcessGoneDetails
      let firstGuard = s[m.group(4)] # `if(<calls>,!<pred>(<details>))return;`
      let predArg = s[m.group(7)] # what the first guard passes to the predicate
      let bareCalls = s[m.group(8)] # `d();` -- kept verbatim
      let letStmt = s[m.group(9)] # interposed `let x=f(),...;` -- kept verbatim
      let guards = s[m.group(10)] # the killed-grace / destroyed guards
      let tail = s[m.group(11)] # the handled path's own `<logger>.info(...` call
      let logger = s[m.group(12)] # module-level logger
      let whole = s[m.boundaries]
      let ifs = firstGuard.count("if(") + guards.count("if(")
      let rets = firstGuard.count("return") + guards.count("return")
      if predArg != details or ifs != rets:
        # The guard checks something other than the event details, or a guard
        # has other than one return -- shape drifted; re-emit untouched so
        # count stays 0 and we fail loudly.
        return whole
      inc count
      guardCount = ifs
      let log = logCall(logger, details)
      head & preamble & addLogs(firstGuard, log) & bareCalls & letStmt &
        addLogs(guards, log) & tail,
  )
  if count != 1:
    if HandledLog in input:
      echo "  [INFO] Found '" & HandledLog &
        "' in file but pattern didn't match exactly once"
    echo "  [FAIL] suppressed renderer-gone pattern: " & $count & " matches, expected 1"
    quit(1)
  if result.count(AppliedMarker) != guardCount:
    echo "  [FAIL] suppressed renderer-gone log: " & $result.count(AppliedMarker) &
      " log call(s) injected for " & $guardCount & " early return(s)"
    quit(1)
  echo "  [OK] suppressed renderer-gone log: 1 match (" & $guardCount &
    " early returns logged)"

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_renderer_gone_suppressed_log <file>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_renderer_gone_suppressed_log ==="
  echo "  Target: " & filePath
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
  echo "  [PASS] Suppressed renderer-gone log patched successfully"
