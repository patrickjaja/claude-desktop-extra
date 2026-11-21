# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
# Enable `claude-desktop --toggle`, `--reload-theme`, and
# `--trigger-shortcut <action>` CLI triggers (Quick Entry toggle; theme config
# re-read, GitHub issue #242; Custom Shortcuts CLI dispatch, #350/#352).
# Four sub-patches:
#   A - capture the Quick Entry show handler into globalThis.__ceQuickEntryShow
#       with a 100ms debounce guard (prevents GNOME double-firing second-instance)
#   B - prepend argv check to second-instance handler (warm-start path):
#       --toggle / --toggle-quick-entry -> Quick Entry, --reload-theme -> theme
#       engine reload (globalThis.__cdbThemes.reload), --trigger-shortcut ->
#       globalThis.__cdbCustomShortcuts.trigger(slug, "second-instance")
#   C - schedule first-instance check after 250ms (cold-start: app just launched
#       with --toggle; reduced from 500ms, enough for Electron init)
#   D - create Unix domain socket at $XDG_RUNTIME_DIR/claude-desktop-qe.sock
#       (~5-25ms, no Electron process spawn). The server reads ONE short
#       newline-terminated command per connection (buffer capped at 256 bytes;
#       decided on first newline, on `end`, or after a 300 ms fallback timer,
#       whichever comes first, exactly once):
#         ""  / "toggle"    -> __ceQuickEntryShow()   (connect+close = toggle)
#         "reload-theme"    -> __cdbThemes.reload("socket"); one-line JSON
#         "shortcut:<slug>" -> __cdbCustomShortcuts.trigger(slug, "socket"); JSON
#         anything else     -> logged as unknown, connection ended
#   E - Quick Entry window probe: one "[quick-entry] shown WxH@x,y focused=..
#       {textarea,focused,font,color,placeholder,fonts,...}" line per show
#       (public Electron APIs; diagnostics for reports like #281)
# EXPECTED = 3 because A+C+D+E share one regex match slot; B is the other.
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
const SHORTCUT_FLAG_EQ = "--trigger-shortcut="
const SHORTCUT_CMD_PREFIX = "shortcut:"
# Positive end-state markers for sub-patch D's command dispatch (Rule 6): the
# literal comparisons the injected server performs on the trimmed payload.
const SOCKET_RELOAD_MARKER = "_c===\"" & RELOAD_CMD & "\""
const SOCKET_SHORTCUT_MARKER = "_c.indexOf(\"" & SHORTCUT_CMD_PREFIX & "\")===0"
const SOCKET_HALFOPEN_MARKER = "{allowHalfOpen:true}"
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

proc shortcutArgvJs(argvExpr: string): string =
  "(function(a){if(!Array.isArray(a))return \"\";for(var i=0;i<a.length;i++){var s=String(a[i]||\"\");" &
    "if(s.indexOf(\"" & SHORTCUT_FLAG_EQ & "\")===0)return s.slice(" &
    $SHORTCUT_FLAG_EQ.len & ");" &
    "if(s===\"--trigger-shortcut\"&&i+1<a.length)return String(a[i+1]||\"\")}return \"\"})(" &
    argvExpr & ")"

proc shortcutCallJs(slugExpr, src: string): string =
  "(function(s){var m=globalThis.__cdbCustomShortcuts;" &
    "if(!m||typeof m.trigger!==\"function\")return Promise.resolve({ok:false,error:\"custom shortcuts module missing\"});" &
    "return Promise.resolve(m.trigger(s,\"" & src & "\"))})(" & slugExpr & ")"

proc apply*(input: string): string =
  result = input
  var applied = 0

  # Sub-patch A + C + D: capture handler into globalThis.__ceQuickEntryShow.
  # Idempotency positively asserts the CURRENT injected shape (Rule 6): the
  # handler global AND the socket server's reload-theme + shortcut:* dispatches. A
  # bundle carrying the handler but missing either dispatch is not "already
  # patched" - fail loud instead of skipping.
  # End-state shape of A+C: the complete registration call followed by our
  # first injected expression (also the post-condition after applying).
  let patAEnd =
    re2"[\w$]+(?:\.[\w$]+)*\([\w$]+(?:\.[\w$]+)*\.QUICK_ENTRY,\(globalThis\.__ceQuickEntryShow=\(\)=>\{var __t=Date\.now\(\);[^\n]*?\}\)(?:,[\w$]+(?:\.[\w$]+)*)*\),setTimeout\(\(\)=>\{try\{if\(Array\.isArray\(process\.argv\)"
  if HANDLER_GLOBAL in result:
    if SOCKET_RELOAD_MARKER notin result or SOCKET_SHORTCUT_MARKER notin result or
        SOCKET_HALFOPEN_MARKER notin result:
      raise newException(
        ValueError,
        "fix_quick_entry_cli_toggle: " & HANDLER_GLOBAL &
          " present but the socket server lacks allowHalfOpen or the reload-theme / shortcut:* dispatch - stale patch shape, re-audit",
      )
    if not result.contains(patAEnd):
      raise newException(
        ValueError,
        "fix_quick_entry_cli_toggle: " & HANDLER_GLOBAL &
          " present but the QUICK_ENTRY registration call is not in the patched shape - re-audit",
      )
    echo &"  [INFO] {HANDLER_GLOBAL} + socket reload-theme/shortcut dispatches already present -- sub-patch A/C/D skipped"
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
    # surrounding ( ... ). The replacement re-emits the handler parenthesized.
    # v5.1231.0: the registrar gained a third argument (an on-screen-locked
    # callback: reg(id, handler, onLocked)), so group 3 captures any trailing
    # `,arg` list up to the call's closing paren and the replacement re-emits it
    # as argument 3+ (handler stays argument 2).
    let patA =
      re2"([\w$]+(?:\.[\w$]+)*)\(([\w$]+(?:\.[\w$]+)*)\.QUICK_ENTRY,\(?(\(\)=>\{[\w$]+(?:\.[\w$]+)*&&![\w$]+(?:\.[\w$]+)*\.isDestroyed\(\)&&[\w$]+(?:\.[\w$]+)*\.isFullScreen\(\)\?\([\w$]+(?:\.[\w$]+)*\.focus\(\),[\w$]+(?:\.[\w$]+)*\((?:[\w$]+(?:\.[\w$]+)*)?\)\):[\w$]+(?:\.[\w$]+)*\((?:[\w$]+(?:\.[\w$]+)*)?\)\})\)?((?:,[\w$]+(?:\.[\w$]+)*)*)\)"

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
        let trailingArgs = result[m.group(3)]

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
        # "reload-theme" -> theme engine reload with a one-line JSON reply;
        # "shortcut:<slug>" -> custom shortcut trigger with a one-line JSON
        # reply; anything else -> logged, connection ended.
        #
        # Uses XDG_RUNTIME_DIR with /run/user/<uid> fallback (cowork socket uses
        # /tmp fallback instead; /run/user/<uid> is safer as it's always user-private).
        let socketTrigger =
          ",(()=>{" & "if(process.platform!==\"linux\")return;" & "try{" &
          "const _qeS=(process.env.XDG_RUNTIME_DIR||(\"/run/user/\"+process.getuid()))+\"/claude-desktop-qe\"+(process.env.CLAUDE_PROFILE?\"-\"+process.env.CLAUDE_PROFILE:\"\")+\".sock\";" &
          "try{require(\"fs\").unlinkSync(_qeS)}catch(e){}" &
          "require(\"net\").createServer({allowHalfOpen:true},c=>{" &
          "c.on(\"error\",e=>{(globalThis.__cdbDiag||console.warn)(\"[quick-entry] socket connection error:\",e.message)});" &
          "var _b=\"\",_d=false,_t=null;" &
          "var _run=function(){if(_d)return;_d=true;clearTimeout(_t);var _c=_b.trim();" &
          "if(_c===\"\"||_c===\"toggle\"){c.end();" & "try{if(globalThis." &
          HANDLER_GLOBAL & ")globalThis." & HANDLER_GLOBAL & "()}catch(e){}}" &
          "else if(" & SOCKET_RELOAD_MARKER & "){var r=" & reloadJs("socket") & ";" &
          "try{c.end(JSON.stringify(r)+\"\\n\")}catch(e){}}" & "else if(" &
          SOCKET_SHORTCUT_MARKER & "){var _s=_c.slice(" & $SHORTCUT_CMD_PREFIX.len &
          ").trim();" & shortcutCallJs("_s", "socket") &
          ".then(r=>{try{c.end(JSON.stringify(r||{ok:false})+\"\\n\")}catch(e){}},e=>{try{c.end(JSON.stringify({ok:false,error:String(e&&e.message||e)})+\"\\n\")}catch(e2){}})}" &
          "else{(globalThis.__cdbDiag||console.warn)(\"[quick-entry] unknown socket command: \"+JSON.stringify(_c.slice(0,64)));c.end()}};" &
          "c.setEncoding(\"utf8\");" &
          "c.on(\"data\",d=>{if(_d)return;_b+=d;if(_b.length>256)_b=_b.slice(0,256);var _n=_b.indexOf(\"\\n\");if(_n>=0){_b=_b.slice(0,_n);_run()}});" &
          "c.on(\"end\",_run);" & "_t=setTimeout(_run,300);" &
          "}).on(\"error\",e=>{(globalThis.__cdbDiag||console.warn)(\"[quick-entry] socket server error:\",e.message)}).listen(_qeS);" &
          "if(!globalThis.__qeTriggerLogged){globalThis.__qeTriggerLogged=true;" &
          "(globalThis.__cdbDiag||console.log)(\"[quick-entry] socket trigger ready: \"+_qeS)}" &
          "}catch(e){}" & "})()"

        # E: Quick Entry window probe (diagnostics, #281). Each time the Quick
        # Entry BrowserWindow is shown, log its size and focus plus the
        # renderer's view of the textarea (size, focus, used font, text and
        # placeholder colors, webfont statuses). Public Electron APIs only; the
        # window is recognised by its quick-window.html URL at show time (the
        # first show can precede did-finish-load). One "[quick-entry] shown ..."
        # line per show in claude-patches.log.
        let windowProbe =
          ",(()=>{" & "if(process.platform!==\"linux\")return;" & "try{" &
          "var _e=require(\"electron\");" &
          "_e.app.on(\"browser-window-created\",(_ev,w)=>{try{var wc=w.webContents;" &
          "w.on(\"show\",()=>{try{" &
          "if(!/quick_window\\/quick-window\\.html/.test(wc.getURL()||\"\"))return;" &
          "setTimeout(()=>{try{if(w.isDestroyed())return;var b=w.getBounds();" &
          "wc.executeJavaScript(`(()=>{try{var t=document.getElementById('prompt-input');" &
          "if(!t)return 'no #prompt-input';var r=t.getBoundingClientRect(),c=getComputedStyle(t),p=getComputedStyle(t,'::placeholder');" &
          "return JSON.stringify({textarea:[Math.round(r.width),Math.round(r.height)],focused:document.activeElement===t,docFocus:document.hasFocus()," &
          "font:c.fontFamily.split(',')[0],color:c.color,placeholder:p.color,caret:c.caretColor," &
          "fonts:Array.from(document.fonts).map(function(f){return f.family+':'+f.status}).join(' '),body:String(document.body.className).slice(0,80)})" &
          "}catch(e){return 'probe error '+e.message}})()`).then(s=>{" &
          "(globalThis.__cdbDiag||console.log)(\"[quick-entry] shown \"+b.width+\"x\"+b.height+\" focused=\"+w.isFocused()+\" \"+s)" &
          "}).catch(e=>{(globalThis.__cdbDiag||console.log)(\"[quick-entry] probe failed: \"+(e&&e.message))})" &
          "}catch(e){}},400)" & "}catch(e){}})}catch(e){}})" & "}catch(e){}" & "})()"

        resultStr &=
          regFn & "(" & enumVar & ".QUICK_ENTRY,(" & assign & ")" & trailingArgs & ")" &
          firstInstance & socketTrigger & windowProbe
        lastEnd = bounds.b + 1
        inc countA
        break

    if countA == 1:
      resultStr &= result[lastEnd .. ^1]
      # Post-condition (Rule 6): the patched call must be a complete call
      # <registrar>(<enum>.QUICK_ENTRY,(globalThis.__ceQuickEntryShow=()=>{...})<,args>)
      # directly followed by our first injected expression. A regex that ends
      # the call at the wrong paren leaves upstream's trailing args dangling.
      if not resultStr.contains(patAEnd) or SOCKET_SHORTCUT_MARKER notin resultStr:
        raise newException(
          ValueError,
          "fix_quick_entry_cli_toggle: sub-patch A output is not a well-formed registration call - re-audit",
        )
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
  # v6.28899.2 adds a 4th param (additionalData, `(t,n,r,i)=>{`); it is
  # optional and re-emitted verbatim as part of the tail capture.
  let patBApplied =
    re2"\.on\([""`]second-instance[""`],\(?\([\w$]+,[\w$]+,[\w$]+(?:,[\w$]+)?\)=>\{if\(Array\.isArray\([\w$]+\)&&\([\w$]+\.includes\(""--toggle-quick-entry""\)\|\|[\w$]+\.includes\(""--toggle""\)\)\)\{[^}]*\}catch\(e\)\{\}return\}if\(Array\.isArray\([\w$]+\)&&[\w$]+\.includes\(""--reload-theme""\)\)\{[^\n]*?return\}if\(\(function\(_a\)\{var _sc=\(function\(a\)\{if\(!Array\.isArray\(a\)\)return """";[^\n]*?""--trigger-shortcut=""[^\n]*?\)\([\w$]+\)\)return;"
  if result.contains(patBApplied):
    echo "  [INFO] sub-patch B already applied -- skipped"
    applied += 1
  else:
    let patB =
      re2"(\.on\([""`]second-instance[""`],\(?\()([\w$]+),([\w$]+),([\w$]+)((?:,[\w$]+)?\)=>\{)"

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
          "}catch(e){}return}" & "if((function(_a){var _sc=" & shortcutArgvJs("_a") &
          ";if(_sc){try{" & shortcutCallJs("_sc", "second-instance") &
          ".catch(function(){})}catch(e){}return true}return false})(" & argv &
          "))return;"

        resultStr2 &= head & evt & "," & argv & "," & cwd & tail & check
        lastEnd2 = bounds.b + 1
        inc countB
        break

    if countB == 1:
      resultStr2 &= result[lastEnd2 .. ^1]
      result = resultStr2
      echo "  [OK] sub-patch B (second-instance argv check: toggle + reload-theme + trigger-shortcut) applied"
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
