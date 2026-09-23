# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Resolve host tools through PATH when upstream's hardcoded /usr/bin path is
# missing.
#
# Upstream execs three host tools by absolute path:
#
#   /usr/bin/busctl         GlobalShortcuts portal probe. When it cannot run,
#                           the probe reads "no portal" and every Wayland
#                           global shortcut (Quick Entry) is refused with
#                           `registration-failed` before Electron is asked.
#   /usr/bin/secret-tool    Chrome cookie import (GNOME keyring / libsecret).
#   /usr/bin/kwallet-query  Chrome cookie import (KWallet). Without either,
#                           keyring-encrypted cookies are skipped silently.
#
# None of them live at /usr/bin on NixOS, and non-systemd distros or AppImage
# on such hosts may not have busctl there either. Each literal becomes
#
#   (require("fs").existsSync("/usr/bin/X")?"/usr/bin/X":"X")
#
# so a host that has the file keeps upstream's exact behavior, and any other
# host resolves the bare name through PATH (execFile does the lookup).
#
# Every chunk of the main bundle is a CommonJS module that already calls
# `require(...)` at top level, so `require` is in scope at each site.
#
# index.pre.js also runs /usr/bin/busctl (KWallet preflight); that target is
# left alone - the launcher covers that case.

import std/[os, strformat, strutils]
import regex

const TOOLS = [
  ("/usr/bin/busctl", "busctl"),
  ("/usr/bin/secret-tool", "secret-tool"),
  ("/usr/bin/kwallet-query", "kwallet-query"),
]

proc fallbackExpr*(path, name: string): string =
  "(require(\"fs\").existsSync(\"" & path & "\")?\"" & path & "\":\"" & name & "\")"

proc apply*(input: string): string =
  result = input
  var applied = 0
  for (path, name) in TOOLS:
    let expr = fallbackExpr(path, name)
    let lit = re2("[\"`]" & escapeRe(path) & "[\"`]")
    let injected = result.count(expr)
    # Old literal sites, not counting the two copies inside our own expression.
    let oldSites = result.replace(expr, "").findAll(lit).len
    if injected == 1 and oldSites == 0:
      echo &"  [OK] {path}: PATH fallback already present"
      inc applied
      continue
    if injected != 0 or oldSites != 1:
      echo &"  [FAIL] {path}: expected 1 literal site and no fallback, found {oldSites} literal(s) and {injected} fallback(s)"
      continue
    var n = 0
    result = result.replace(
      lit,
      proc(m: RegexMatch2, s: string): string =
        inc n
        expr,
    )
    if n == 1:
      echo &"  [OK] {path}: PATH fallback to \"{name}\" (1 site)"
      inc applied
    else:
      echo &"  [FAIL] {path}: rewrote {n} sites, expected 1"

  if applied < TOOLS.len:
    raise newException(
      ValueError,
      &"fix_host_tool_paths_linux: only {applied}/{TOOLS.len} sub-patches applied",
    )

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_host_tool_paths_linux <path_to_index.js>"
    quit(1)
  let file = paramStr(1)
  echo "=== Patch: fix_host_tool_paths_linux ==="
  echo &"  Target: {file}"
  if not fileExists(file):
    echo &"  [FAIL] File not found: {file}"
    quit(1)
  let input = readFile(file)
  var output: string
  try:
    output = apply(input)
  except ValueError as e:
    echo &"  [FAIL] {e.msg}"
    quit(1)
  if output != input:
    writeFile(file, output)
    echo "  [PASS] Host tools fall back to PATH"
  else:
    echo "  [PASS] Host tool PATH fallbacks already present (idempotent)"
