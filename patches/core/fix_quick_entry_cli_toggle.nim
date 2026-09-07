# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
# Enable `claude-desktop --toggle` and `claude-desktop --reload-theme` CLI
# triggers (Quick Entry toggle; theme config re-read, GitHub issue #242).
# Four sub-patches:
#   A - capture the Quick Entry show handler into globalThis.__ceQuickEntryShow
#       with a 100ms debounce guard (prevents GNOME double-firing second-instance)
#   B - prepend argv check to second-instance handler (warm-start path):
#       --toggle / --toggle-quick-entry -> Quick Entry, --reload-theme -> theme
#       engine reload (globalThis.__cdbThemes.reload, add_feature_custom_themes)
#   C - schedule first-instance check after 250ms (cold-start: app just launched
#       with --toggle; reduced from 500ms, enough for Electron init)
#   D - create Unix domain socket at $XDG_RUNTIME_DIR/claude-desktop-qe.sock
#       (~5-25ms, no Electron process spawn). The server reads ONE short
#       newline-terminated command per connection (buffer capped at 256 bytes;
#       decided on first newline, on `end`, or after a 300 ms fallback timer,
#       whichever comes first, exactly once):
#         ""  / "toggle"  -> __ceQuickEntryShow()   (connect+close = toggle, so
#                             the hotkey client stays fast: `end` fires at once)
#         "reload-theme"  -> __cdbThemes.reload("socket"); one-line JSON result
#                             {ok,changed,name,windows} written back, then end
#         anything else   -> logged as unknown, connection ended
# EXPECTED = 3 because A+C+D share one regex match slot; B is the other.
#
# Debug anchors (rg -a on the concatenated stub+chunks, see AGENTS.md):
#   sub-patch A:  rg -ao '.{0,40}\.QUICK_ENTRY,\(?\(\)=>\{.{0,160}'
#   sub-patch B:  rg -ao '\.on\(["`]second-instance["`],\(?\([\w$]+,[\w$]+,[\w$]+\)=>\{.{0,80}'
#   end-state:    grep -c 'claude-desktop-qe' / grep -c '"reload-theme"'
#                 (both must hit once after patching)

import std/[os, strformat, strutils]
import regex

const TRIGGER_FLAG = "--toggle-quick-entry"
const TRIGGER_FLAG_SHORT = "--toggle"
const HANDLER_GLOBAL = "__ceQuickEntryShow"
const RELOAD_FLAG = "--reload-theme"
const RELOAD_CMD = "reload-theme"
# Positive end-state marker for sub-patch D's command dispatch (Rule 6): the
# literal comparison the injected server performs on the trimmed payload.
const SOCKET_RELOAD_MARKER = "_c===\"" & RELOAD_CMD & "\""
const EXPECTED = 3

# JS expression (IIFE) that asks the theme engine to re-read its config and
# re-apply, returning its {ok,changed,name,windows} result (or an {ok:false,
# error} object when the engine is missing or throws). `src` is the reason
# string handed to reload() and echoed in the diagnostics line. Inlined at both
# call sites (socket server + second-instance handler) so neither depends on
# the other's load order - only on the theme engine's globalThis export.
proc reloadJs(src: string): string =
  "(function(){var r;try{r=globalThis.__cdbThemes&&globalThis.__cdbThemes.reload?" &
    "globalThis.__cdbThemes.reload(\"" & src &
    "\"):{ok:false,error:\"theme engine missing\"}}" &
    "catch(e){r={ok:false,error:String(e&&e.message||e)}};" &
    "(globalThis.__cdbDiag||console.warn)(\"[quick-entry] reload-theme (" & src &
    "): \"+JSON.stringify(r));" & "return r})()"

proc apply*(input: string): string =
  result = input
  var applied = 0

  # Sub-patch A + C + D: capture handler into globalThis.__ceQuickEntryShow.
  # Idempotency positively asserts the CURRENT injected shape (Rule 6): the
  # handler global AND the socket server's reload-theme command dispatch. A
  # bundle carrying the handler but the pre-#242 connect-only server is not
  # "already patched" - fail loud instead of skipping.
  if HANDLER_GLOBAL in result:
    if SOCKET_RELOAD_MARKER notin result:
      raise newException(
        ValueError,
        "fix_quick_entry_cli_toggle: " & HANDLER_GLOBAL &
          " present but the socket server lacks the reload-theme dispatch (" &
          SOCKET_RELOAD_MARKER & ") - stale patch shape, re-audit",
      )
    echo &"  [INFO] {HANDLER_GLOBAL} + socket reload-theme dispatch already present -- sub-patch A/C/D skipped"
    applied += 2
  else:
    # The two ternary-branch calls take optional args: in v1.15962 the
    # focus-branch call gained the window var (i9t() -> GZt(tt)). In v1.19367
    # the window variable became a property chain (it -> exports.mainWindow),
    # so every window-var slot allows a dotted identifier chain
    # ([\w$]+(?:\.[\w$]+)*), including inside the call parens.
    # v1.26832.0 moved the registrar and the shortcut-id enum behind chunk
    # namespaces (T.p(T.l.QUICK_ENTRY, ...)) and made the focus-branch callee a
    # namespaced import too (i.T(u.f)), so every CALLEE slot is a dotted chain
    # as well.
    # v1.32352.1: the minifier wraps callback arrows in an extra paren pair
    # (Xrn($V.QUICK_ENTRY,(()=>{...}))), so the arrow allows an optional
    # surrounding ( ... ). The replacement re-emits the call without the wrap.
    let patA =
      re2"([\w$]+(?:\.[\w$]+)*)\(([\w$]+(?:\.[\w$]+)*)\.QUICK_ENTRY,\(?(\(\)=>\{[\w$]+(?:\.[\w$]+)*&&![\w$]+(?:\.[\w$]+)*\.isDestroyed\(\)&&[\w$]+(?:\.[\w$]+)*\.isFullScreen\(\)\?\([\w$]+(?:\.[\w$]+)*\.focus\(\),[\w$]+(?:\.[\w$]+)*\((?:[\w$]+(?:\.[\w$]+)*)?\)\):[\w$]+(?:\.[\w$]+)*\((?:[\w$]+(?:\.[\w$]+)*)?\)\})\)?\)"

    var countA = 0
    var resultStr = ""
    var lastEnd = 0
    for m in result.findAll(patA):
      if countA == 0:
        let bounds = m.boundaries
        resultStr &= result[lastEnd ..< bounds.a]

        let regFn = result[m.group(0)]
        let enumVar = result[m.group(1)]
        let arrow = result[m.group(2)]

        # Verify arrow shape
        assert arrow.startsWith("()=>{") and arrow.endsWith("}"),
          "unexpected arrow shape: " & arrow

        let body = arrow[len("()=>{") ..< arrow.len - 1]

        # A: register with assignment to globalThis AND a debounce guard.
        # 100ms debounce: safety net against any remaining edge cases.
        # The original 900ms was added for GNOME's duplicate second-instance
        # delivery (issue #38, double-fires within 1-5ms), but with the socket
        # trigger (sub-patch D) the second-instance path is no longer taken when
        # the app is running -- the socket calls __ceQuickEntryShow() directly,
        # bypassing second-instance entirely. GNOME has nothing left to double-fire.
        # 100ms is kept as a cheap safety net; it no longer affects normal usage.
        let arrowWrapped =
          "()=>{var __t=Date.now();if(globalThis.__ceQEInvokedAt&&__t-globalThis.__ceQEInvokedAt<100)return;globalThis.__ceQEInvokedAt=__t;" &
          body & "}"
        let assign = "globalThis." & HANDLER_GLOBAL & "=" & arrowWrapped

        # C: schedule first-instance check
        let firstInstance =
          ",setTimeout(()=>{" &
          "try{if(Array.isArray(process.argv)&&(process.argv.includes(\"" & TRIGGER_FLAG &
          "\")||process.argv.includes(\"" & TRIGGER_FLAG_SHORT & "\"))&&globalThis." &
          HANDLER_GLOBAL & ")globalThis." & HANDLER_GLOBAL & "()}catch(e){}" & "},250)"

        # D: Unix domain socket trigger -- fast hotkey / CLI path on Linux.
        #
        # Without the socket, `claude-desktop --toggle-quick-entry` (or `--toggle`)
        # spawns a full Electron process just to IPC to the running instance
        # (~300 ms overhead per keypress). Instead, on startup the app creates a
        # Unix domain socket. The launcher connects via socat (~2 ms) or python3
        # (~25 ms), falling back to the Electron path when the app is not running.
        #
        # Protocol (one command per connection): the server buffers `data` (cap
        # 256 bytes) and decides exactly once - on the first newline, on `end`
        # (client half-closed / closed without sending: the hotkey case), or
        # after a 300 ms fallback timer. "" / "toggle" -> Quick Entry;
        # "reload-theme" -> theme engine reload with a one-line JSON reply so
        # the CLI can print it; anything else -> logged, connection ended.
        #
        # Uses XDG_RUNTIME_DIR with /run/user/<uid> fallback (cowork socket uses
        # /tmp fallback instead; /run/user/<uid> is safer as it's always user-private).
        let socketTrigger =
          ",(()=>{" & "if(process.platform!==\"linux\")return;" & "try{" &
          "const _qeS=(process.env.XDG_RUNTIME_DIR||(\"/run/user/\"+process.getuid()))+\"/claude-desktop-qe\"+(process.env.CLAUDE_PROFILE?\"-\"+process.env.CLAUDE_PROFILE:\"\")+\".sock\";" &
          "try{require(\"fs\").unlinkSync(_qeS)}catch(e){}" &
          "require(\"net\").createServer(c=>{" &
          "c.on(\"error\",e=>{(globalThis.__cdbDiag||console.warn)(\"[quick-entry] socket connection error:\",e.message)});" &
          "var _b=\"\",_d=false,_t=null;" &
          "var _run=function(){if(_d)return;_d=true;clearTimeout(_t);var _c=_b.trim();" &
          "if(_c===\"\"||_c===\"toggle\"){c.end();" & "try{if(globalThis." &
          HANDLER_GLOBAL & ")globalThis." & HANDLER_GLOBAL & "()}catch(e){}}" &
          "else if(" & SOCKET_RELOAD_MARKER & "){var r=" & reloadJs("socket") & ";" &
          "try{c.end(JSON.stringify(r)+\"\\n\")}catch(e){}}" &
          "else{(globalThis.__cdbDiag||console.warn)(\"[quick-entry] unknown socket command: \"+JSON.stringify(_c.slice(0,64)));c.end()}};" &
          "c.setEncoding(\"utf8\");" &
          "c.on(\"data\",d=>{if(_d)return;_b+=d;if(_b.length>256)_b=_b.slice(0,256);var _n=_b.indexOf(\"\\n\");if(_n>=0){_b=_b.slice(0,_n);_run()}});" &
          "c.on(\"end\",_run);" & "_t=setTimeout(_run,300);" &
          "}).on(\"error\",e=>{(globalThis.__cdbDiag||console.warn)(\"[quick-entry] socket server error:\",e.message)}).listen(_qeS);" &
          "if(!globalThis.__qeTriggerLogged){globalThis.__qeTriggerLogged=true;" &
          "(globalThis.__cdbDiag||console.log)(\"[quick-entry] socket trigger ready: \"+_qeS)}" &
          "}catch(e){}" & "})()"

        resultStr &=
          regFn & "(" & enumVar & ".QUICK_ENTRY," & assign & ")" & firstInstance &
          socketTrigger
        lastEnd = bounds.b + 1
        inc countA
        break

    if countA == 1:
      resultStr &= result[lastEnd .. ^1]
      result = resultStr
      echo "  [OK] sub-patch A (handler capture) + C (first-instance schedule) applied"
      applied += 2
    elif countA > 1:
      raise newException(
        ValueError,
        &"fix_quick_entry_cli_toggle: sub-patch A matched {countA} times (expected 1)",
      )
    else:
      raise newException(
        ValueError,
        "fix_quick_entry_cli_toggle: sub-patch A did not match QUICK_ENTRY handler registration",
      )

  # Sub-patch B: prepend argv check to second-instance handler.
  # Idempotency must positively verify B's OWN end-state (the second-instance
  # handler body starting with our Array.isArray argv check for the toggle
  # flags, immediately followed by the --reload-theme branch) - a plain
  # substring probe for the trigger flag is satisfied by sub-patch A/C's
  # injected text and silently skips B on a fresh bundle (Rule 6).
  # v1.32352.1: the minifier wraps the handler arrow in an extra paren pair
  # (.on(`second-instance`,((t,n,r)=>{...))), so the head allows an optional
  # extra open paren; the head capture re-emits whatever was consumed verbatim,
  # keeping the parens balanced for both shapes.
  let patBApplied =
    re2"\.on\([""`]second-instance[""`],\(?\([\w$]+,[\w$]+,[\w$]+\)=>\{if\(Array\.isArray\([\w$]+\)&&\([\w$]+\.includes\(""--toggle-quick-entry""\)\|\|[\w$]+\.includes\(""--toggle""\)\)\)\{[^}]*\}catch\(e\)\{\}return\}if\(Array\.isArray\([\w$]+\)&&[\w$]+\.includes\(""--reload-theme""\)\)"
  if result.contains(patBApplied):
    echo "  [INFO] sub-patch B already applied -- skipped"
    applied += 1
  else:
    let patB =
      re2"(\.on\([""`]second-instance[""`],\(?\()([\w$]+),([\w$]+),([\w$]+)(\)=>\{)"

    var countB = 0
    var resultStr2 = ""
    var lastEnd2 = 0
    for m in result.findAll(patB):
      if countB == 0:
        let bounds = m.boundaries
        resultStr2 &= result[lastEnd2 ..< bounds.a]

        let head = result[m.group(0)]
        let evt = result[m.group(1)]
        let argv = result[m.group(2)]
        let cwd = result[m.group(3)]
        let tail = result[m.group(4)]

        let check =
          "if(Array.isArray(" & argv & ")&&(" & argv & ".includes(\"" & TRIGGER_FLAG &
          "\")||" & argv & ".includes(\"" & TRIGGER_FLAG_SHORT & "\")))" &
          "{try{globalThis." & HANDLER_GLOBAL & "&&globalThis." & HANDLER_GLOBAL &
          "()}catch(e){}return}" & "if(Array.isArray(" & argv & ")&&" & argv &
          ".includes(\"" & RELOAD_FLAG & "\"))" & "{try{" & reloadJs("second-instance") &
          "}catch(e){}return}"

        resultStr2 &= head & evt & "," & argv & "," & cwd & tail & check
        lastEnd2 = bounds.b + 1
        inc countB
        break

    if countB == 1:
      resultStr2 &= result[lastEnd2 .. ^1]
      result = resultStr2
      echo "  [OK] sub-patch B (second-instance argv check: toggle + reload-theme) applied"
      applied += 1
    elif countB > 1:
      raise newException(
        ValueError,
        &"fix_quick_entry_cli_toggle: sub-patch B matched {countB} times (expected 1)",
      )
    else:
      raise newException(
        ValueError,
        "fix_quick_entry_cli_toggle: sub-patch B did not match .on(\"second-instance\", ...) handler",
      )

  if applied < EXPECTED:
    raise newException(
      ValueError,
      &"fix_quick_entry_cli_toggle: Only {applied}/{EXPECTED} sub-patches applied",
    )

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_quick_entry_cli_toggle <file>"
    quit(1)
  let file = paramStr(1)
  echo "=== Patch: fix_quick_entry_cli_toggle ==="
  echo &"  Target: {file}"
  if not fileExists(file):
    echo &"  [FAIL] File not found: {file}"
    quit(1)
  let input = readFile(file)
  let output = apply(input)
  if output != input:
    writeFile(file, output)
    echo &"  [PASS] {EXPECTED}/{EXPECTED} sub-patches applied"
  else:
    echo &"  [PASS] No changes needed -- already patched ({EXPECTED}/{EXPECTED})"
