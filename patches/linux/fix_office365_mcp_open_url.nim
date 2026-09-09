# @patch-target: app.asar.contents/resources/office365-mcp/office365-mcp-stdio.mjs
# @patch-type: nim
#
# Delegate the M365 local connector's OAuth browser-open to the Electron main
# process (issue #139, KDE timeout).
#
# Root cause:
#   The built-in office365-mcp server opens the Entra sign-in URL with
#   spawn("xdg-open",[url]) from inside the utilityProcess child. Even with the
#   widened env allowlist (fix_builtin_mcp_browser_env), xdg-open is fragile:
#   on KDE with XDG_CURRENT_DESKTOP=KDE but xdg-open quirks (kfmclient-era
#   fallbacks that exit 0 without opening anything) the sign-in silently
#   never happens -> 300s ceiling -> LocalAuthSignInCooldownError.
#
#   Remote OAuth servers (e.g. Atlassian) work on every DE because the PARENT
#   opens the browser via shell.openExternal. This patch reuses exactly that
#   mechanism for the local M365 flow:
#
#   Child side (this file): the target moved from office365-mcp.mjs to
#   office365-mcp-stdio.mjs in v1.49585.0 (the server now pins
#   MCP_TRANSPORT=stdio itself; it is still forked through the nodeHost
#   utilityProcess, so process.parentPort is present). In the browser-open
#   helper (v1.17377.x: $4o; v1.49585.0: gKo), on
#   Linux and when running under utilityProcess (process.parentPort present),
#   post {type:"open-url",url} to the parent instead of spawning xdg-open,
#   keeping the original log/stderr-hint semantics. Falls through to the
#   original spawn path when standalone (no parentPort) or on other platforms.
#
#   Parent side: fix_builtin_mcp_open_url_handler.nim adds the matching
#   "open-url" branch (-> shell.openExternal) to the host's message handler in
#   index.js. Both patches are required together; each fails loud on its own
#   anchor, so an upstream refactor breaks the build rather than the feature.
#
# Anchors are the stable strings "local_auth_browser_open" and the (url, flag,
# ctx) parameter shape; all minified identifiers are captured with [\w$]+.

import std/[os, strutils]
import regex

proc apply*(input: string): string =
  # Idempotency: positive end-state -- the delegation postMessage must exist.
  if """process.parentPort.postMessage({type:"open-url",url:""" in input:
    echo "  [OK] office365-mcp open-url delegation: already patched"
    return input

  # Matches: function $4o(t,e=!1,a={}){e?F.log("info","local_auth_browser_open",{})
  # Groups: 0=function head, 1=url param, 2=flag param (decl), 3=flag param
  # (use; RE2 has no backrefs so it is captured again), 4=logger var.
  let pattern =
    re2"""(function [\w$]+\(([\w$]+),([\w$]+)=!1,[\w$]+=\{\}\)\{)([\w$]+)\?([\w$]+)\.log\("info","local_auth_browser_open",\{\}\)"""

  var count = 0
  result = input.replace(
    pattern,
    proc(m: RegexMatch2, s: string): string =
      inc count
      let funcHead = s[m.group(0)]
      let urlParam = s[m.group(1)]
      let flagUse = s[m.group(3)]
      let logger = s[m.group(4)]
      let origTail =
        flagUse & "?" & logger & ".log(\"info\",\"local_auth_browser_open\",{})"
      funcHead &
        "if(process.platform!==\"darwin\"&&process.platform!==\"win32\"&&process.parentPort){" &
        flagUse & "?" & logger &
        ".log(\"info\",\"local_auth_browser_open\",{}):process.stderr.write(\"Opening browser for sign-in. If it does not open, visit:\\n  \"+" &
        urlParam & "+\"\\n\");" &
        "try{process.parentPort.postMessage({type:\"open-url\",url:" & urlParam &
        "})}catch(cpErr){}return Promise.resolve()}" & origTail,
  )

  if count != 1:
    echo "  [FAIL] office365-mcp open-url delegation: " & $count &
      " matches (expected 1)"
    quit(1)

  echo "  [OK] office365-mcp open-url delegation: browser-open routed to parent"

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_office365_mcp_open_url <file>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_office365_mcp_open_url ==="
  echo "  Target: " & filePath
  let input = readFile(filePath)
  let output = apply(input)
  writeFile(filePath, output)
  echo "  [PASS] office365-mcp open-url delegation patched successfully"
