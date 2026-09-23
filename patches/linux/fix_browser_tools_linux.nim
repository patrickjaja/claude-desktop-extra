# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
# Enable Chrome browser tools ("Claude in Chrome") on Linux.
#
# State on the official Linux .deb (verified 2026-06): browser-tools is PARTIALLY
# upstreamed. The browser directory enumerator is now native and Linux-shaped:
#     function O_i(){const A=process.env.XDG_CONFIG_HOME;return A&&j.isAbsolute(A)?A:j.join(<os>.homedir(),".config")}
#     function xSA(){<os>.homedir();{const A=O_i();return[{name:"Chrome",path:j.join(A,"google-chrome")},
#                                                        {name:"Edge",path:j.join(A,"microsoft-edge")}]}}
#     function Y_i(){return <os>.homedir(),xSA().map(A=>({name:A.name,path:j.join(A.path,"NativeMessagingHosts")}))}
# and upstream's OWN sync loop writes the native-messaging manifest to those dirs:
#     for(const{name:A,path:e}of Y_i())...l2n(e,A)/aer(e,A)...     // install/remove
# plus a profile/extension discovery loop `x_i()` that iterates xSA(). So Chrome +
# Edge work natively on Linux now.
#
# The native-host BINARY PATH is upstreamed too (removed as a sub-patch in
# v1.26832.0). The .deb ships a real Linux native messaging host at
# resources/chrome-native-host (1.1 MB Rust ELF, glibc floor 2.34), and the
# bundle's packaged branch resolves exactly there:
#     ue=`chrome-native-host`
#     function Tt(){let e=he.S;return R.app.isPackaged
#         ?I.default.join(process.resourcesPath,e)
#         :I.default.join(R.app.getAppPath(),`../../packages/desktop/chrome-native-host/artifacts`,e)}
# Since the verbatim-layout refactor we ship the .deb's resources/ tree
# unchanged and process.resourcesPath behaves as on the stock .deb, so
# upstream's own resolution finds that binary in our repackage. We used to
# redirect it to ~/.claude/chrome/chrome-native-host (the Claude Code CLI's
# host); that only pointed the manifest away from the binary upstream ships.
#
# What's left for us — 3 sub-patches:
#   BC EXTEND the native browser list: xSA() ships ONLY Chrome+Edge. We add
#      Chromium, Brave, Vivaldi and Opera. Because BOTH the NativeMessagingHosts
#      install loop (via Y_i→xSA) AND profile discovery (x_i→xSA) derive from
#      xSA(), extending this ONE function covers what the old separate Patch B
#      (manifest write loop) and Patch C (user-data dirs) did — and reuses
#      upstream's own manifest writer instead of duplicating it.
#   D  Extension AUTO-INSTALL: still mac-gated (`Only macOS is supported.`). Inject
#      the Linux External-Extensions path.
#   E  DevTools opener: still darwin/win32 only. Add an xdg-open Linux handler.

import std/[os, strformat, strutils]
import regex

const EXPECTED_PATCHES = 3

proc replaceFirst(
    content: var string, pattern: Regex2, subFn: proc(m: RegexMatch2, s: string): string
): int =
  var found = false
  var resultStr = ""
  var lastEnd = 0
  for m in content.findAll(pattern):
    if not found:
      let bounds = m.boundaries
      resultStr &= content[lastEnd ..< bounds.a]
      resultStr &= subFn(m, content)
      lastEnd = bounds.b + 1
      found = true
      break
  if found:
    resultStr &= content[lastEnd .. ^1]
    content = resultStr
    return 1
  return 0

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0

  # ── Patch BC: extend native browser list (xSA) to 6 browsers ──────────────
  # Native xSA() returns ONLY Chrome+Edge. Replace its return array with one that
  # also includes Chromium/Brave/Vivaldi/Opera, reusing the upstream config-dir
  # var (the result of O_i(), bound to `const <A>=`). Both the NativeMessagingHosts
  # install loop (Y_i→xSA) and profile discovery (x_i→xSA) then cover all 6.
  let alreadyBC =
    re2"""\{name:"Chromium",path:[\w$]+(?:\.[\w$]+)*\.join\([\w$]+,"chromium"\)\}"""
  var amBC: RegexMatch2
  if result.find(alreadyBC, amBC):
    echo "  [OK] Browser list (xSA): already extended to Chromium/Brave/Vivaldi/Opera (skipped)"
    patchesApplied += 1
  else:
    # function Ft(){<os>.homedir();{let <CFG>=Nt();return[{name:`Chrome`,...},{name:`Edge`,...}]}return[]}
    # Capture g0 = head through `let <CFG>=<dirfn>();return[`, g1 = the config-dir
    # var name, then we rebuild the full 6-entry array and keep the original
    # Chrome+Edge entries. Quoting is backticks since v1.26832.0 and the module
    # accessors are dotted (`q.default.homedir()`, `W.default.join`).
    let patternBC =
      re2"""(function [\w$]+\(\)\{[\w$]+(?:\.[\w$]+)*\.homedir\(\);\{(?:const|let|var) )([\w$]+)(=[\w$]+(?:\.[\w$]+)*\(\);return\[)(\{name:["`]Chrome["`],path:([\w$]+(?:\.[\w$]+)*)\.join\([\w$]+,["`]google-chrome["`]\)\},\{name:["`]Edge["`],path:[\w$]+(?:\.[\w$]+)*\.join\([\w$]+,["`]microsoft-edge["`]\)\})(\])"""
    let sitesBC = result.findAll(patternBC).len
    if sitesBC != 1:
      echo "  [FAIL] Browser list (xSA): " & $sitesBC & " sites, expected 1"
      quit(1)
    var countBC = result.replaceFirst(
      patternBC,
      proc(m: RegexMatch2, s: string): string =
        let head = s[m.group(0)] # "function …{<os>.homedir();{const "
        let cfgVar = s[m.group(1)] # the O_i() result var
        let mid = s[m.group(2)] # "=O_i();return["
        let chromeEdge = s[m.group(3)] # original Chrome+Edge entries
        let joinVar = s[m.group(4)] # the path module var used in `<j>.join`
        let extra =
          ",{name:\"Chromium\",path:" & joinVar & ".join(" & cfgVar & ",\"chromium\")}" &
          ",{name:\"Brave\",path:" & joinVar & ".join(" & cfgVar &
          ",\"BraveSoftware\",\"Brave-Browser\")}" & ",{name:\"Vivaldi\",path:" & joinVar &
          ".join(" & cfgVar & ",\"vivaldi\")}" & ",{name:\"Opera\",path:" & joinVar &
          ".join(" & cfgVar & ",\"opera\")}"
        head & cfgVar & mid & chromeEdge & extra & s[m.group(5)],
    )
    if countBC == 1:
      echo &"  [OK] Browser list (xSA): extended to 6 browsers (Chromium/Brave/Vivaldi/Opera added) ({countBC} match)"
      patchesApplied += 1
    else:
      echo "  [FAIL] Browser list (xSA): native Chrome+Edge enumerator not found"
      echo "         Debug: rg -o 'name:\"Chrome\",path:[\\w$]+.join([\\w$]+,\"google-chrome\")' index.js"

  # ── Patch D: Chrome extension auto-install (still mac-gated) ───────────────
  let alreadyD =
    re2"""process\.platform!=="darwin"&&process\.platform!=="linux"\)return\{status:"""
  var amD: RegexMatch2
  if result.find(alreadyD, amD):
    echo "  [OK] Chrome extension install: already patched (skipped)"
    patchesApplied += 1
  else:
    # The status enum is reached through a dotted namespace since v1.26832.0
    # (`D.i.Error`), so capture the whole prefix before `.Error`.
    let patternD =
      re2"""(if\(process\.platform!==["`]darwin["`]\)return\{status:)((?:[\w$]+\.)*[\w$]+)(\.Error,error:["`]Unsupported platform: \$\{process\.platform\}\. Only macOS is supported\.["`]\})"""
    let sitesD = result.findAll(patternD).len
    if sitesD != 1:
      echo "  [FAIL] Chrome extension install: " & $sitesD & " sites, expected 1"
      quit(1)
    var countD = result.replaceFirst(
      patternD,
      proc(m: RegexMatch2, s: string): string =
        let enumVar = s[m.group(1)]
        "if(process.platform!==\"darwin\"&&process.platform!==\"linux\")return{status:" &
          enumVar &
          ".Error,error:`Unsupported platform: ${process.platform}. Only macOS and Linux are supported.`};" &
          "if(process.platform===\"linux\"){" &
          "try{const _h=require(\"os\").homedir(),_p=require(\"path\")," &
          "_id=\"fcoeoabgfenejglbffodgkkbkcdhcgfn\"," &
          "_url=\"https://clients2.google.com/service/update2/crx\"," &
          "_dirs=[_p.join(_h,\".config\",\"google-chrome\"),_p.join(_h,\".config\",\"chromium\")];" &
          "let _ok=!1;for(const _d of _dirs){try{const _e=_p.join(_d,\"External Extensions\");" &
          "require(\"fs\").mkdirSync(_e,{recursive:!0});" &
          "require(\"fs\").writeFileSync(_p.join(_e,_id+\".json\")," &
          "JSON.stringify({external_update_url:_url},null,2),\"utf-8\");" &
          "(globalThis.__cdbDiag||console.log)(\"[Chrome Extension Install] Wrote to \"+_e);_ok=!0}catch(_x){}}" &
          "return _ok?{status:" & enumVar & ".Succeeded}:{status:" & enumVar &
          ".Error,error:\"No Chrome/Chromium config dirs found on Linux\"}}" &
          "catch(e){return{status:" & enumVar &
          ".Error,error:e instanceof Error?e.message:\"Unknown error\"}}}",
    )
    if countD == 1:
      echo &"  [OK] Chrome extension install: added Linux support ({countD} match)"
      patchesApplied += 1
    else:
      echo "  [FAIL] Chrome extension install: pattern not found"
      echo "         Debug: rg -o 'Only macOS is supported.{{0,20}}' index.js"

  # ── Patch E: Chrome DevTools opener (still darwin/win32 only) ──────────────
  let alreadyE =
    re2"""process\.platform==="linux"&&await [\w$]+(?:\.[\w$]+)*\("xdg-open",\["chrome://inspect"\]\)"""
  var amE: RegexMatch2
  if result.find(alreadyE, amE):
    echo "  [OK] Chrome DevTools opener: already patched (skipped)"
    patchesApplied += 1
  else:
    let patternE =
      re2"""(process\.platform===["`]win32["`]&&await )((?:[\w$]+\.)*[\w$]+)(\(["`]start["`],\[["`]chrome["`],["`]chrome://inspect["`]\]\))"""
    let sitesE = result.findAll(patternE).len
    if sitesE != 1:
      echo "  [FAIL] Chrome DevTools opener: " & $sitesE & " sites, expected 1"
      quit(1)
    var countE = result.replaceFirst(
      patternE,
      proc(m: RegexMatch2, s: string): string =
        let execFn = s[m.group(1)]
        "process.platform===\"win32\"?await " & execFn & s[m.group(2)] &
          ":process.platform===\"linux\"&&await " & execFn &
          "(\"xdg-open\",[\"chrome://inspect\"])",
    )
    if countE == 1:
      echo &"  [OK] Chrome DevTools opener: added Linux xdg-open handler ({countE} match)"
      patchesApplied += 1
    else:
      echo "  [FAIL] Chrome DevTools opener: pattern not found"
      echo "         Debug: rg -o 'chrome://inspect.{{0,30}}' index.js"

  if patchesApplied < EXPECTED_PATCHES:
    raise newException(
      ValueError,
      &"fix_browser_tools_linux: Only {patchesApplied}/{EXPECTED_PATCHES} patches applied",
    )

  # Verify brace balance
  let originalDelta = input.count('{') - input.count('}')
  let patchedDelta = result.count('{') - result.count('}')
  if originalDelta != patchedDelta:
    let diff = patchedDelta - originalDelta
    raise newException(
      ValueError,
      &"fix_browser_tools_linux: Patch introduced brace imbalance: {diff:+} unmatched braces",
    )

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_browser_tools_linux <file>"
    quit(1)
  let file = paramStr(1)
  echo "=== Patch: fix_browser_tools_linux ==="
  echo &"  Target: {file}"
  if not fileExists(file):
    echo &"  [FAIL] File not found: {file}"
    quit(1)
  let input = readFile(file)
  let output = apply(input)
  if output == input:
    echo &"  [OK] All patches already applied (no changes needed)"
  else:
    writeFile(file, output)
    echo &"  [PASS] Patches applied"
