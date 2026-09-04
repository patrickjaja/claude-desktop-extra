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

proc apply*(input: string): string =
  if AppliedMarker in input:
    echo "  [OK] suppressed renderer-gone log: already applied"
    return input

  # Shape history of the handler's suppression decision:
  #   <= v1.24012.9: inline early-return branch
  #     .on("render-process-gone",async(i,r)=>{if(KG>0||r.reason==="killed"||...){...;return}if(D.info("Main webview render process gone: %o
  #   v1.26832.0 - v1.30096.1: one hoisted predicate ANDed into a single condition
  #     e.on(`render-process-gone`,async(t,a)=>{if(Ia(a)&&!(a.reason===`killed`&&(await ...))&&!e.isDestroyed()){if(o.o.info(`Main webview render process gone: %o
  #   v1.32352.1: the single condition is SPLIT into an early-return guard, an
  #   interposed `let` (timing/context capture), and a second if; the async
  #   arrow gained wrapping parens:
  #     e.on(`render-process-gone`,(async(t,r)=>{if(!XNn(r))return;let i=CPn();if(!(r.reason===`killed`&&(await new Promise((e=>setTimeout(e,WNn))),e.isDestroyed()||pI()))&&!e.isDestroyed()){if(D.info(`Main webview render process gone: %o
  #   v1.37937.0: same shape, but the interposed `let` gained a SECOND
  #   declarator - `let i=ONt(),a=hOt();` (was `let i=CPn();`). `a` is a cached
  #   main-view heap sample read only for the handled path's telemetry payload,
  #   so it adds no control flow; the capture below just accepts a
  #   comma-separated run of call-initialised declarators and re-emits it
  #   verbatim, preserving its position before the killed-wait `await`.
  #   v1.46388.2: the second condition is INVERTED into a second early-return
  #   guard and the handled path is no longer nested in an if-block; the log
  #   call follows the guard directly:
  #     e.on("render-process-gone",(async(t,i)=>{if(!T6t(i))return;let a=Q6t(),o=FWt();if(i.reason==="killed"&&(await new Promise((e=>setTimeout(e,_6t))),e.isDestroyed()||XA())||e.isDestroyed())return;N.info("Main webview render process gone: %o",i);
  #
  # Either early return is a suppressed death that stays silent -- the gap
  # #128 is about. Both guards gain a log line before their `return`; the
  # conditions themselves are re-emitted verbatim (the `await` inside the
  # second one stays where it was, in the enclosing async arrow), so which
  # deaths get reloaded is unchanged.
  #
  # The second condition is captured as a run of non-brace characters, spelled
  # as three concatenated runs because the regex library caps a repetition
  # range at 100 (and nesting the bound blows up NFA construction at compile
  # time). ~100 chars in v1.46388.2, so 300 is the headroom. Excluding braces
  # bounds the match so it cannot run into the telemetry object literal that
  # follows the log call.
  #
  # The trailing `.info(<q>Main webview render process gone: %o` both pins this
  # site (22 render-process-gone mentions exist; only this one logs that
  # message) and captures the logger identifier (dotted namespace tolerated).
  # Count policy: require >= 1 and echo the actual count -- the insertion
  # is correct for N copies of the registration, while 0 matches means
  # upstream changed the code and the patch must fail loudly.
  let pattern =
    re2"""(\.on\(["`]render-process-gone["`],\(?async\(([\w$]+),([\w$]+)\)=>\{)if\(!([\w$]+)\(([\w$]+)\)\)return;(let [\w$]+=[\w$]+(?:\.[\w$]+)*\([^()]*\)(?:,[\w$]+=[\w$]+(?:\.[\w$]+)*\([^()]*\))*;)if\(([^{}]{1,100}[^{}]{0,100}[^{}]{0,100})\)return;(([\w$]+(?:\.[\w$]+)*)\.info\(["`]Main webview render process gone: %o)"""
  var count = 0
  result = input.replace(
    pattern,
    proc(m: RegexMatch2, s: string): string =
      # group(0) prefix incl. arrow params; group(1) is the (unused) event arg.
      let details = s[m.group(2)] # RenderProcessGoneDetails
      let pred = s[m.group(3)] # hoisted "should we handle this?" predicate
      let predArg = s[m.group(4)] # what the guard passes to the predicate
      let letStmt = s[m.group(5)] # interposed `let x=f();` -- kept verbatim
      let cond = s[m.group(6)] # second guard (killed-after-wait / destroyed)
      let tail = s[m.group(7)] # the handled path's own `<logger>.info(...` call
      let logger = s[m.group(8)] # module-level logger
      if predArg != details:
        # Guard checks something other than the event details -- shape drifted;
        # re-emit the match untouched so count stays 0 and we fail loudly.
        return
          s[m.group(0)] & "if(!" & pred & "(" & predArg & "))return;" & letStmt & "if(" &
          cond & ")return;" & tail
      inc count
      let logCall =
        logger & """.info("Main webview render process gone (suppressed): %o",{reason:""" &
        details & ".reason,exitCode:" & details & ".exitCode})"
      s[m.group(0)] & "if(!" & pred & "(" & predArg & ")){" & logCall & ";return}" &
        letStmt & "if(" & cond & "){" & logCall & ";return}" & tail,
  )
  if count == 0:
    if "Main webview render process gone" in input:
      echo "  [INFO] Found 'Main webview render process gone' in file but pattern didn't match"
    echo "  [FAIL] suppressed renderer-gone pattern: 0 matches (may need pattern update)"
    quit(1)
  echo "  [OK] suppressed renderer-gone log: " & $count & " match(es)"

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_renderer_gone_suppressed_log <file>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_renderer_gone_suppressed_log ==="
  echo "  Target: " & filePath
  let input = readFile(filePath)
  let output = apply(input)
  writeFile(filePath, output)
  echo "  [PASS] Suppressed renderer-gone log patched successfully"
