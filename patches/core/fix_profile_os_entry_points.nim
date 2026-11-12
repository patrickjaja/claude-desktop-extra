# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Named profiles keep their own os-entry-points.json.
#
# Upstream's OS entry points module (the GNOME search provider's state, the
# jump list, the Nautilus / KIO "Open in Claude Code" verbs) records whether
# the feature is on and which account and organization it shows in
# `os-entry-points.json` ({enabled, account, org}). It writes that file to the
# 1P data directory of the 3P-config resolver (5.1231.2, names version
# specific):
#
#   function CJe(){let e=qi("CLAUDE_E2E_1P_USERDATA");if(e)return[e];
#     if(process.platform==="win32"){...}let t=u.app.getPath("userData");
#     return t.endsWith(Su)?[t.slice(0,-3)]:[n.join(u.app.getPath("appData"),Cu)]}
#   function TJe(){return wJe().dir}            // wJe(): {dir: CJe()[0], ...}
#   async function ZIo(e){let t=JSON.stringify(e);t!==JIo&&(await
#     $r(n.default.join(TJe(),VIo),e),JIo=t)}   // VIo="os-entry-points.json"
#
# For the default profile that is ~/.config/Claude (also from Claude-3p). A
# named profile runs with --user-data-dir ~/.config/Claude-<name>, which does
# not end in "-3p", so it falls to join(appData, "Claude"): the DEFAULT
# profile's directory. Every named profile overwrote the default profile's
# file with its own account and org ids, or with {"enabled":false} when the
# feature is off there, and the GNOME search provider (which reads that file
# and then claude-code-sessions/<account>/<org> beside it) showed the wrong
# account's sessions or nothing for the default profile.
#
# Fix: on Linux this one write goes to the active profile's userData with a
# trailing "-3p" stripped - identical to upstream for the default profile and
# for Claude-3p (~/.config/Claude), ~/.config/Claude-<name> for a named
# profile and for Claude-<name>-3p. CLAUDE_E2E_1P_USERDATA keeps priority,
# read through upstream's own env helper. TJe/wJe/CJe themselves are not
# touched: their other consumers (the 3P config and log directory logic) keep
# upstream's behaviour. Nothing in the app reads the file back (the only other
# reference to its name is the declaration); its reader is the GNOME search
# provider, a single D-Bus slot that reads ~/.config/Claude, so it keeps
# showing the default profile's sessions.
#
# The expression reuses the resolver's own identifiers (env helper, electron
# binding, "-3p" constant), captured from CJe. They are top-level bindings of
# the same chunk as the writer; the patch checks the writer does not shadow
# them.
#
# Break risk: LOW. Fails loud when the writer, the name constant or the
# resolver changes shape.

import std/[os, strformat]
import regex

const MARKER = "/*__cdbOsEntryProfile*/"

# var VIo="os-entry-points.json" (group 0 = name).
const NAME_DECL = re2"""[\s,;]([\w$]+)=["`]os-entry-points\.json["`][,;]"""

# The resolver. Groups: 0 = CJe, 1 = env var, 2 = env helper, 3 = env var
# again, 4 = env var again, 5 = userData var, 6 = electron binding, 7 =
# userData var again, 8 = "-3p" constant, 9 = userData var again, 10 =
# electron binding again.
const DIR_FN =
  re2"""function ([\w$]+)\(\)\{let ([\w$]+)=([\w$]+)\(["`]CLAUDE_E2E_1P_USERDATA["`]\);if\(([\w$]+)\)return\[([\w$]+)\];if\(process\.platform===["`]win32["`]\)\{let\{[^{}]*\}=[\w$]+\(\);return[^{}]*\}let ([\w$]+)=([\w$]+)\.app\.getPath\(["`]userData["`]\);return ([\w$]+)\.endsWith\(([\w$]+)\)\?\[([\w$]+)\.slice\(0,-3\)\]:\[[\w$]+(?:\.default)?\.join\(([\w$]+)\.app\.getPath\(["`]appData["`]\),[\w$]+\)\]\}"""

proc writerPat(nameVar: string): Regex2 =
  ## async function ZIo(e){let t=JSON.stringify(e);t!==JIo&&(await
  ## $r(n.default.join(TJe(),VIo),e),JIo=t)}. Groups: 0 = param, 1 = local,
  ## 2 = param again, 3 = local again, 4 = cache, 5 = write helper, 6 = path
  ## binding, 7 = dir function, 8 = param again, 9 = cache again, 10 = local
  ## again.
  re2(
    r"async function [\w$]+\(([\w$]+)\)\{let ([\w$]+)=JSON\.stringify\(([\w$]+)\);([\w$]+)!==([\w$]+)&&\(await ([\w$]+)\(([\w$]+(?:\.default)?)\.join\(([\w$]+)\(\)," &
      escapeRe(nameVar) & r"\),([\w$]+)\),([\w$]+)=([\w$]+)\)\}"
  )

proc donePat(nameVar: string): Regex2 =
  ## Our injected end state in the writer's join.
  re2(
    r"\.join\(" & escapeRe(MARKER) &
      r"""\(process\.platform==="linux"\?[\w$]+\("CLAUDE_E2E_1P_USERDATA"\)\|\|\(__cdbU=>__cdbU\.endsWith\(([\w$]+)\)\?__cdbU\.slice\(0,-([\w$]+)\.length\):__cdbU\)\([\w$]+\.app\.getPath\("userData"\)\):[\w$]+\(\)\),""" &
      escapeRe(nameVar) & r"\),"
  )

proc apply*(input: string): string =
  const EXPECTED_PATCHES = 1
  var patchesApplied = 0
  result = input

  var names: seq[string]
  for m in result.findAll(NAME_DECL):
    names.add result[m.group(0)]
  if names.len != 1:
    raise newException(
      ValueError,
      &"  [FAIL] `VIo=\"os-entry-points.json\"`: {names.len} matches, expected 1 - re-audit",
    )
  let nameVar = names[0]

  # Idempotency: our injected shape in the writer, exactly once.
  let done = result.findAll(donePat(nameVar))
  if done.len == 1:
    let d = done[0]
    if result[d.group(0)] != result[d.group(1)]:
      raise newException(
        ValueError,
        "  [FAIL] injected os-entry-points dir: inconsistent suffix constant",
      )
    echo "  [OK] os-entry-points.json already written to the active profile's directory (idempotent)"
    inc patchesApplied
  elif done.len > 1:
    raise newException(
      ValueError,
      &"  [FAIL] injected os-entry-points dir: {done.len} matches, expected 1 - re-audit",
    )
  else:
    var fns: seq[RegexMatch2]
    for m in result.findAll(DIR_FN):
      let s = result
      if s[m.group(1)] == s[m.group(3)] and s[m.group(1)] == s[m.group(4)] and
          s[m.group(5)] == s[m.group(7)] and s[m.group(5)] == s[m.group(9)] and
          s[m.group(6)] == s[m.group(10)]:
        fns.add m
    if fns.len != 1:
      raise newException(
        ValueError,
        &"  [FAIL] 1P data dir resolver (`function CJe(){{let e=qi(\"CLAUDE_E2E_1P_USERDATA\");...t.endsWith(Su)?[t.slice(0,-3)]:[join(appData,Cu)]}}`): {fns.len} matches, expected 1 - re-audit",
      )
    let f = fns[0]
    let dirFn = result[f.group(0)]
    let envFn = result[f.group(2)]
    let electron = result[f.group(6)]
    let suffix = result[f.group(8)]

    var writers: seq[RegexMatch2]
    for m in result.findAll(writerPat(nameVar)):
      let s = result
      if s[m.group(0)] == s[m.group(2)] and s[m.group(0)] == s[m.group(8)] and
          s[m.group(1)] == s[m.group(3)] and s[m.group(1)] == s[m.group(10)] and
          s[m.group(4)] == s[m.group(9)]:
        writers.add m
    if writers.len != 1:
      raise newException(
        ValueError,
        &"  [FAIL] os-entry-points writer (`async function ZIo(e){{let t=JSON.stringify(e);t!==JIo&&(await $r(n.default.join(TJe(),VIo),e),JIo=t)}}`): {writers.len} matches, expected 1 - re-audit",
      )
    let w = writers[0]
    let tje = result[w.group(7)]
    let locals = [result[w.group(0)], result[w.group(1)]]
    for id in [envFn, electron, suffix]:
      if id in locals:
        raise newException(
          ValueError,
          &"  [FAIL] os-entry-points writer shadows `{id}` (resolver binding) - re-audit",
        )

    # The writer's directory is the resolver's: TJe(){return wJe().dir},
    # wJe(){let e=CJe();...}. Anything else is a different file.
    let tjeM = result.findAll(
      re2(r"function " & escapeRe(tje) & r"\(\)\{return ([\w$]+)\(\)\.dir\}")
    )
    if tjeM.len != 1:
      raise newException(
        ValueError,
        &"  [FAIL] `function {tje}(){{return wJe().dir}}`: {tjeM.len} matches, expected 1 - re-audit",
      )
    let wje = result[tjeM[0].group(0)]
    let wjeN = result.findAll(
      re2(
        r"function " & escapeRe(wje) & r"\(\)\{let ([\w$]+)=" & escapeRe(dirFn) &
          r"\(\);"
      )
    ).len
    if wjeN != 1:
      raise newException(
        ValueError,
        &"  [FAIL] `function {wje}(){{let e={dirFn}();...`: {wjeN} matches, expected 1 - re-audit",
      )

    # Replace `TJe()` (the group plus its "()").
    let a = w.group(7).a
    let b = w.group(7).b + 3
    let expr =
      MARKER & "(process.platform===\"linux\"?" & envFn &
      "(\"CLAUDE_E2E_1P_USERDATA\")||(__cdbU=>__cdbU.endsWith(" & suffix &
      ")?__cdbU.slice(0,-" & suffix & ".length):__cdbU)(" & electron &
      ".app.getPath(\"userData\")):" & tje & "())"
    result = result[0 ..< a] & expr & result[b .. ^1]
    if result.findAll(donePat(nameVar)).len != 1:
      raise newException(
        ValueError, "  [FAIL] os-entry-points dir: replacement did not apply"
      )
    echo &"  [OK] os-entry-points.json: written to the active profile's directory on Linux (writer {tje}() -> userData minus \"-3p\", 1 match)"
    inc patchesApplied

  if patchesApplied < EXPECTED_PATCHES:
    raise newException(
      ValueError, &"  [FAIL] Only {patchesApplied}/{EXPECTED_PATCHES} patches applied"
    )

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_profile_os_entry_points <file>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_profile_os_entry_points ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  var output: string
  try:
    output = apply(input)
  except ValueError as e:
    echo e.msg
    quit(1)
  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] os-entry-points.json follows the active profile"
