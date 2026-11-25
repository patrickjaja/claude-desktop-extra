# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Make upstream "Install as app" (artifactApps) fully functional on Linux across
# all 3 permission tiers:
#   - Injects js/artifact_apps_linux.js (globalThis.__cdbArtifactApps) for XDG
#     .desktop entry & hicolor PNG icon generation, per-window CHROME_DESKTOP /
#     app.setDesktopName swapping, multi-profile isolation, reconciliation, and
#     --artifact-app=<id> CLI launch routing.
#   - Unfolds the build-time Linux stubs in DqepnCaA.js (Ybi, vMr, vTi, Rv, xTi)
#     and intercepts --artifact-app=<id> in second-instance before UHs raises
#     the main Claude window.
#   - Wires openFromCommandLine and cold-start queue draining in DJs65d_-.js.
#   - Replaces the macOS .app bundle / app_shim_loader / /usr/bin/open / Finder
#     paths in Dx0_sNU1.js with Linux XDG desktop entries and window rebuilds.

import std/[os, strutils]
import std/nre

const HELPER_JS = staticRead("../../js/artifact_apps_linux.js")
const HELPER_MARKER = "__cdb_artifact_apps_linux_v1__"
const EXPECTED_PATCHES = 24

proc countOf(s: string, p: Regex): int =
  for _ in s.findIter(p):
    inc result

proc findUnique(s: string, p: Regex, label: string): RegexMatch =
  var count = 0
  for m in s.findIter(p):
    result = m
    inc count
  if count != 1:
    echo "  [FAIL] " & label & ": expected 1 match, got " & $count
    quit(1)

proc applySub(
    s: var string,
    patchesApplied: var int,
    label: string,
    pattern: Regex,
    appliedRegex: Regex,
    repl: proc(m: RegexMatch): string {.closure.},
) =
  let doneCount = countOf(s, appliedRegex)
  let rawCount = countOf(s, pattern)
  if doneCount == 1 and rawCount == 0:
    echo "  [OK] " & label & " already applied (idempotent)"
    inc patchesApplied
    return
  if doneCount == 0 and rawCount == 1:
    s = s.replace(pattern, repl)
    if countOf(s, appliedRegex) == 1:
      echo "  [OK] " & label
      inc patchesApplied
    else:
      echo "  [FAIL] " & label & " replacement did not produce expected marker"
    return
  echo "  [FAIL] " & label & ": raw=" & $rawCount & " applied=" & $doneCount

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0

  # --- 1. A: Head helper injection ---
  if HELPER_MARKER in result:
    echo "  [OK] A: helper already injected (" & HELPER_MARKER & ")"
    inc patchesApplied
  else:
    if result.startsWith("\"use strict\";"):
      result = "\"use strict\";" & HELPER_JS & result[len("\"use strict\";") .. ^1]
    else:
      result = HELPER_JS & result
    if HELPER_MARKER in result:
      echo "  [OK] A: helper injected"
      inc patchesApplied
    else:
      echo "  [FAIL] A: helper marker missing after injection"

  let gbRead = findUnique(
    result,
    re"""function [\w$]+\(\)\{return [\w$]+\(\(\(\)=>([\w$]+)\(["`]1928275548["`]\)""",
    "B1/B2: gbRead helper",
  ).captures[0]

  # --- 2. B1: Ybi() capability predicate -> checks globalThis.__cdbArtifactApps._tier1() ---
  applySub(
    result,
    patchesApplied,
    "B1: artifactApps capability gate (Ybi)",
    re"""function ([\w$]+)\(\)\{return!1\}(function [\w$]+\(\)\{return [\w$]+\(\(\(\)=>[\w$]+\(["`]1928275548["`]\))""",
    re"""function [\w$]+\(\)\{return!!\(globalThis\.__cdbArtifactApps\._tier1&&globalThis\.__cdbArtifactApps\._tier1\(\)\)\}""",
    proc(m: RegexMatch): string =
      let ybi = m.captures[0]
      let xbiHead = m.captures[1]
      "function " & ybi &
        "(){return!!(globalThis.__cdbArtifactApps._tier1&&globalThis.__cdbArtifactApps._tier1())}" &
        xbiHead,
  )

  # --- 3. B2: vMr = () => !1 -> hMr(1) && Y(_Mr), registered as _tier1 ---
  applySub(
    result,
    patchesApplied,
    "B2: artifactApps IPC gate (vMr)",
    re"""function ([\w$]+)\([\w$]+\)\{return [\w$]+\([\w$]+\)\.every\(\([\w$]+=>[\w$]+===["`]allows["`]\)\)\}function [\w$]+\([\w$]+,[\w$]+\)\{[^}]+\}var ([\w$]+)=["`]2701212339["`],([\w$]+)=\(\)=>!1,[\w$]+=["`]artifact-shell:transport-port["`]""",
    re"""[\w$]+=\(globalThis\.__cdbArtifactApps\._tier1=\(\)=>[\w$]+\(1\)&&[\w$]+\([\w$]+\)\),[\w$]+=["`]artifact-shell:transport-port["`]""",
    proc(m: RegexMatch): string =
      let hmr = m.captures[0]
      let mr = m.captures[1]
      let vmr = m.captures[2]
      let full = m.match
      let target = "," & vmr & "=()=>!1,"
      let repl =
        "," & vmr & "=(globalThis.__cdbArtifactApps._tier1=()=>" & hmr & "(1)&&" & gbRead &
        "(" & mr & ")),"
      full.replace(target, repl),
  )

  # --- 4. B3: vTi = () => !1 -> () => !0 ---
  applySub(
    result,
    patchesApplied,
    "B3: artifactApps startup subscription gate (vTi)",
    re"""var [\w$]+=2e3,[\w$]+=12e4,[\w$]+=3e4,([\w$]+)=\(\)=>!1,[\w$]+=Promise\.resolve\(\);function [\w$]+\(\)\{if\(![\w$]+\(\)\)return;""",
    re"""[\w$]+=\(\)=>!0/\*__cdbVTi\*/""",
    proc(m: RegexMatch): string =
      let vti = m.captures[0]
      let full = m.match
      full.replace("," & vti & "=()=>!1,", "," & vti & "=()=>!0/*__cdbVTi*/,"),
  )

  # --- 5. C1a: Rv launch detection + enter() in DqepnCaA.js ---
  applySub(
    result,
    patchesApplied,
    "C1a: Rv launchArg/isLaunch/enter",
    re"""var ([\w$]+)=["`]--artifact-app-launch["`],([\w$]+)=([\w$]+)=>[\w$]+===[\w$]+,([\w$]+)=!1;function ([\w$]+)\(\)\{[\w$]+=!0\}var ([\w$]+)=!1,([\w$]+)=new Set,([\w$]+);function ([\w$]+)\(\)\{\}var ([\w$]+)=\{launchArg:[\w$]+,isLaunch:[\w$]+=>!1,active:\(\)=>[\w$]+,bornHiddenReason:\(\)=>[\w$]+\?["`]appifact["`]:void 0,enter:[\w$]+,""",
    re"""isLaunch:[\w$]+=>globalThis\.__cdbArtifactApps\.isLaunchArgv\([\w$]+\)""",
    proc(m: RegexMatch): string =
      let argVar = m.captures[0]
      let matchFn = m.captures[1]
      let matchParam = m.captures[2]
      let qqt = m.captures[3]
      let qqtFn = m.captures[4]
      let activeVar = m.captures[5]
      let setVar = m.captures[6]
      let cbVar = m.captures[7]
      let enterFn = m.captures[8]
      let rvVar = m.captures[9]
      "var " & argVar & "=\"--artifact-app-launch\"," & matchFn & "=" & matchParam & "=>" &
        matchParam & "===" & argVar & "||" & matchParam &
        ".startsWith(\"--artifact-app=\")," & qqt & "=!1;function " & qqtFn & "(){" & qqt &
        "=!0}var " & activeVar & "=!1," & setVar & "=new Set," & cbVar & ";function " &
        enterFn & "(){" & activeVar & "=!0}var " & rvVar & "={launchArg:" & argVar &
        ",isLaunch:e=>globalThis.__cdbArtifactApps.isLaunchArgv(e),active:()=>" &
        activeVar & ",bornHiddenReason:()=>" & activeVar & "?\"appifact\":void 0,enter:" &
        enterFn & ",",
  )

  # --- 6. C1b: xTi(argv) queues cold-start --artifact-app=<id> ---
  applySub(
    result,
    patchesApplied,
    "C1b: xTi launch queueing",
    re"""function ([\w$]+)\(([\w$]+)\)\{return ([\w$]+)\.isLaunch\([\w$]+\)&&([\w$]+)\(\),([\w$]+)=([\w$]+)\([\w$]+\)\.finally""",
    re"""globalThis\.__cdbArtifactApps\.queueLaunch\([\w$]+\)""",
    proc(m: RegexMatch): string =
      let fn = m.captures[0]
      let arg = m.captures[1]
      let rv = m.captures[2]
      let wti = m.captures[3]
      let yti = m.captures[4]
      let sti = m.captures[5]
      "function " & fn & "(" & arg & "){return " & rv & ".isLaunch(" & arg &
        ")&&(globalThis.__cdbArtifactApps.queueLaunch(" & arg & ")," & wti & "())," & yti &
        "=" & sti & "(" & arg & ").finally",
  )

  # --- 7. C1c + C2: Capture c$t/zv/wTi and intercept second-instance before UHs ---
  let czvMatch = findUnique(
    result,
    re"""function ([\w$]+)\(\)\{return ([\w$]+)\?\?=Promise\.resolve\(\)\.then\(\(\(\)=>require\(["`]\./index\.chunk-[\w$-]+\.js["`]\)\)\)\.then\(\(([\w$]+)=>\{([\w$]+)=[\w$]+;try\{[\w$]+\.initArtifactApps\(\)\}catch\([^)]+\)\{[^}]+\}return [\w$]+\}\),\(([\w$]+)=>\{[^}]+\}\)\),\s*[\w$]+\}var [\w$]+=\(\)=>[\w$]+,([\w$]+)=[\w$]+=>[\w$]+===["`]evenWhenOff["`]\|\|[\w$]+\?\.isArtifactAppsEnabled\?\.\(\)\?[\w$]+:void 0""",
    "C2: c$t/zv helpers",
  )
  let capLoad = czvMatch.captures[0]
  let capGet = czvMatch.captures[5]
  let capBlocked = findUnique(
    result,
    re"""function [\w$]+\([\w$]+\)\{return [\w$]+\.isLaunch\([\w$]+\)&&\(globalThis\.__cdbArtifactApps\.queueLaunch\([\w$]+\),([\w$]+)\(\)\)""",
    "C2: wTi blocked helper",
  ).captures[0]

  applySub(
    result,
    patchesApplied,
    "C2: second-instance --artifact-app=<id> intercept",
    re"""(\.on\(["`]second-instance["`],\(?\([\w$]+,([\w$]+),[\w$]+,[\w$]+\)=>\{(?:[^;]*;)?if\([\w$]+\(\),[\w$]+\.includes\(["`]--reopened-after-update["`]\)\|\|[\w$]+\(\)\)return;)(if\([\w$]+\([\w$]+\)&&[\w$]+\(\),[\w$]+\([\w$]+,[\w$]+\))""",
    re"""globalThis\.__cdbArtifactApps\.handleSecondInstance\(""",
    proc(m: RegexMatch): string =
      let head = m.captures[0]
      let argvVar = m.captures[1]
      let tail = m.captures[2]
      head & "if(globalThis.__cdbArtifactApps.handleSecondInstance(" & argvVar & "," &
        capGet & "," & capLoad & "," & capBlocked & "))return;" & tail,
  )

  # --- 8. D1 + D2: DJs65d_-.js openFromCommandLine + appShim timer suppression ---
  let d2Match = findUnique(
    result,
    re"""var [\w$]+=15e3,[\w$]+=45e3,[\w$]+=4e4,[\w$]+=5e3,[\w$]+=!1,[\w$]+=!1,[\w$]+=new Set,([\w$]+)=!1,([\w$]+)=!1,[\w$]+=0,[\w$]+;""",
    "D1: DJs65d_-.js shim timer flags",
  )
  let djsU = d2Match.captures[0]
  let djsD = d2Match.captures[1]

  applySub(
    result,
    patchesApplied,
    "D1: DJs65d_-.js openFromCommandLine",
    re"""async openInBackground\([\w$]+\)\{[^}]+\}\}\},([\w$]+)=void 0;""",
    re"""[\w$]+=\(argv\)=>\{const _ok=globalThis\.__cdbArtifactApps\.openFromCommandLine\(argv\);if\(_ok\)\{[\w$]+=!0,[\w$]+=!0\}return _ok\}""",
    proc(m: RegexMatch): string =
      let rVar = m.captures[0]
      let full = m.match
      full.replace(
        "," & rVar & "=void 0;",
        "," & rVar &
          "=(argv)=>{const _ok=globalThis.__cdbArtifactApps.openFromCommandLine(argv);if(_ok){" &
          djsU & "=!0," & djsD & "=!0}return _ok};",
      ),
  )

  # --- 9. D3: DJs65d_-.js initArtifactApps drains queued cold-start launches ---
  applySub(
    result,
    patchesApplied,
    "D3: DJs65d_-.js drainQueuedOnReady on app.whenReady()",
    re"""function ([\w$]+)\(\)\{([\w$]+)\(\),[\w$]+\.C\([\w$]+=>\{[\w$]+===["`]bound["`]&&""",
    re"""globalThis\.__cdbArtifactApps\.drainQueuedOnReady\(\)""",
    proc(m: RegexMatch): string =
      let kFn = m.captures[0]
      let gFn = m.captures[1]
      let full = m.match
      full.replace(
        "function " & kFn & "(){" & gFn & "(),",
        "function " & kFn & "(){" & gFn &
          "(),require(\"electron\").app.whenReady().then(()=>{const _opened=globalThis.__cdbArtifactApps.drainQueuedOnReady();if(_opened>0){" &
          djsU & "=!0," & djsD & "=!0}}),",
      ),
  )

  # --- 10. E1: Dx0_sNU1.js schema (dc), display name (fc), store name (Sc), Cc ---
  applySub(
    result,
    patchesApplied,
    "E1: Linux installed-apps schema, store name & Cc",
    re"""([\w$]+)=([\w$]+)\.EWt\(\{installId:[\w$]+\.jWt\(\)\.regex\([\w$]+\),artifactUuid:[\w$]+\.jWt\(\)\.regex\([\w$]+\),org:[\w$]+\.jWt\(\)\.regex\([\w$]+\)\.optional\(\),bundle:[\w$]+\.jWt\(\)\.regex\(/\^\[[^\]]+\]\+\\\.app\$/\),root:[\w$]+\.uWt\(\[["`]prod["`],["`]dev["`]\]\),cdHashes:[\w$]+\.mWt\([\w$]+\.jWt\(\)\.regex\([\w$]+\)\)\.min\(1\)\.optional\(\),notifierHashes:[\w$]+\.mWt\([\w$]+\.jWt\(\)\.regex\([\w$]+\)\)\.min\(1\)\.optional\(\)\}\),([\w$]+)=[\w$]+=>[\w$]+\.bundle\.slice\(0,-4\),([\w$]+),([\w$]+),([\w$]+),([\w$]+)=([\w$]+)\(["`]installs-changed["`]\),([\w$]+)=new Set,([\w$]+)=new Set,([\w$]+)=new WeakSet,([\w$]+)=new WeakSet,([\w$]+);function ([\w$]+)\(\)\{return [\w$]+\?\?=[\w$]+\.pv\(\{name:["`]artifact-apps-installed["`],configFileMode:384,defaults:\{apps:\[\]\}\}\),[\w$]+\}function ([\w$]+)\(\)\{return [\w$]+\?\?=[\w$]+\(\)\.then\([\w$]+\)\.then\(\(\(\)=>void 0\),\(\(\)=>\{[\w$]+=null\}\)\),[\w$]+\}""",
    re"""artifact-apps-installed-linux""",
    proc(m: RegexMatch): string =
      let dc = m.captures[0]
      let t = m.captures[1]
      let fc = m.captures[2]
      let pc = m.captures[3]
      let mc = m.captures[4]
      let hc = m.captures[5]
      let gc = m.captures[6]
      let bFn = m.captures[7]
      let c1 = m.captures[8]
      let c2 = m.captures[9]
      let c3 = m.captures[10]
      let c4 = m.captures[11]
      let xc = m.captures[12]
      let sc = m.captures[13]
      let cc = m.captures[14]
      dc & "=" & t & ".EWt({installId:" & t &
        ".jWt().regex(/^[0-9a-f]{32}$/),artifactUuid:" & t &
        ".jWt().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),org:" &
        t &
        ".jWt().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/).optional(),name:" &
        t & ".jWt().optional(),desktopFile:" & t & ".jWt().optional(),bundle:" & t &
        ".jWt().optional(),root:" & t & ".uWt([\"prod\",\"dev\"]),cdHashes:" & t &
        ".mWt(" & t & ".jWt()).optional(),notifierHashes:" & t & ".mWt(" & t &
        ".jWt()).optional()})," & fc &
        "=e=>e.name||(e.bundle?e.bundle.replace(/\\.app$/i,\"\"):\"Untitled\")," & pc &
        "," & mc & "=\"prod\"," & hc & "," & gc & "=" & bFn & "(\"installs-changed\")," &
        c1 & "=new Set," & c2 & "=new Set," & c3 & "=new WeakSet," & c4 & "=new WeakSet," &
        xc & ";function " & sc & "(){return " & pc & "??=" & t &
        ".pv({name:\"artifact-apps-installed-linux\",configFileMode:384,defaults:{apps:[]}})," &
        pc & "}function " & cc & "(){return " & mc & "=\"prod\"," & hc &
        "??=Promise.resolve()}",
  )

  # --- 11. E2: Nc() reconciles against Linux .desktop files ---
  applySub(
    result,
    patchesApplied,
    "E2: Nc() XDG .desktop reconciliation",
    re"""function ([\w$]+)\(\)\{return ([\w$]+)\?\?=\(async\(\)=>\{try\{if\(await ([\w$]+)\(\),!([\w$]+)\(\)\)return;let [\w$]+=await [\w$]+\(\),[\w$]+=\[\],[\w$]+=!1,[\w$]+=([\w$]+)\(\)\.flatMap\(\([\w$]+=>\{let [\w$]+=[\w$]+\.get\([\w$]+\.installId\);return [\w$]+===void 0\|\|([\w$]+)\.has\([\w$]+\.installId\)\?\[[\w$]+\]:[\w$]+===null\?\([\w$]+\.push\([\w$]+\),\[\]\):\([\w$]+\|\|=[\w$]+!==[\w$]+\.bundle,\[\{\.\.\.[\w$]+,bundle:[\w$]+\}\]\)\}\)\);if\([\w$]+\.length===0&&![\w$]+\)return;([\w$]+)\.sUt\.info\(["`]\[artifactApps\] forgetting %d install\(s\) whose app was deleted["`],[\w$]+\.length\),([\w$]+)\([\w$]+\);for\(let [\w$]+ of [\w$]+\)([\w$]+)\([\w$]+\.artifactUuid\),([\w$]+)\(\)\.then\(\(\(\)=>([\w$]+)\(["`]desktop_artifact_app_uninstalled["`],\{frame_slug_fp:([\w$]+)\([\w$]+\.artifactUuid,[\w$]+\.org\),how:["`]deleted_from_folder["`],total_installed:[\w$]+\.length\}\)\)\)\}catch\([\w$]+\)\{([\w$]+)\(["`]couldn't forget deleted apps["`],[\w$]+\)\}finally\{[\w$]+=void 0\}\}\)\(\),[\w$]+\}""",
    re"""globalThis\.__cdbArtifactApps\.reconcileRecords""",
    proc(m: RegexMatch): string =
      let nc = m.captures[0]
      let xc = m.captures[1]
      let cc = m.captures[2]
      let iFn = m.captures[3]
      let qFn = m.captures[4]
      let delSet = m.captures[5]
      let tMod = m.captures[6]
      let kcFn = m.captures[7]
      let isFn = m.captures[8]
      let enFn = m.captures[9]
      let inFn = m.captures[10]
      let slugFn = m.captures[11]
      let errFn = m.captures[12]
      "function " & nc & "(){return " & xc & "??=(async()=>{try{if(await " & cc & "(),!" &
        iFn & "())return;let _cur=" & qFn &
        "();if(_cur.length===0)return;let _res=await globalThis.__cdbArtifactApps.reconcileRecords(_cur);let _rem=_res.removed.filter(e=>!" &
        delSet & ".has(e.installId));let _kept=[..._res.kept,..._res.removed.filter(e=>" &
        delSet &
        ".has(e.installId))];if(_rem.length===0&&!_res.changed)return;if(_rem.length>0)" &
        tMod &
        ".sUt.info(\"[artifactApps] forgetting %d install(s) whose app was deleted\",_rem.length);" &
        kcFn & "(_kept);for(let e of _rem)" & isFn & "(e.artifactUuid)," & enFn &
        "().then(()=>" & inFn & "(\"desktop_artifact_app_uninstalled\",{frame_slug_fp:" &
        slugFn &
        "(e.artifactUuid,e.org),how:\"deleted_from_folder\",total_installed:_kept.length}))}catch(e){" &
        errFn & "(\"couldn't forget deleted apps\",e)}finally{" & xc & "=void 0}})()," &
        xc & "}",
  )

  # --- 12. E3: Uc() lists existing Linux .desktop app names ---
  applySub(
    result,
    patchesApplied,
    "E3: Uc() listExistingAppNames",
    re"""async function ([\w$]+)\(\)\{let [\w$]+=\[\.\.\.[\w$]+,[\w$]+\.default\.join\([\w$]+\.app\.getPath\(["`]home["`]\),["`]Applications["`]\)\];return\(await Promise\.all\([\w$]+\.map\(\(async [\w$]+=>\{try\{await using [\w$]+=await [\w$]+\.eVt\.open\([\w$]+,["`]workspace["`]\);return\(await [\w$]+\.readdir\(["`]\.["`]\)\)\.map\(\([\w$]+=>[\w$]+\.name\)\)\}catch\([\w$]+\)\{return [\w$]+\(["`]couldn't list an app folder for look-alike names["`],[\w$]+,["`]info["`]\),\[\]\}\}\)\)\)\)\.flat\(\)\.filter\(\([\w$]+=>[\w$]+\.endsWith\(["`]\.app["`]\)\)\)\.map\(\([\w$]+=>[\w$]+\.slice\(0,-4\)\)\)\}""",
    re"""globalThis\.__cdbArtifactApps\.listExistingAppNames\(\)""",
    proc(m: RegexMatch): string =
      let ucFn = m.captures[0]
      "async function " & ucFn &
        "(){return globalThis.__cdbArtifactApps.listExistingAppNames()}",
  )

  # --- 13. E4: fl() finds free Linux app name ---
  let qName = findUnique(
    result,
    re"""function ([\w$]+)\(\)\{return [\w$]+\(\),[\w$]+\(\)\.filter\([\w$]+\)\}""",
    "E4: q() helper",
  ).captures[0]

  applySub(
    result,
    patchesApplied,
    "E4: fl() findFreeName",
    re"""async function ([\w$]+)\([\w$]+\)\{try\{await using ([\w$]+)=await [\w$]+\(await [\w$]+\(await [\w$]+\(\)\)\);return [\w$]+\?await [\w$]+\([\w$]+,[\w$]+\):[\w$]+\}catch\([\w$]+\)\{return [\w$]+\(["`]couldn't look for a free app name["`],[\w$]+,["`]info["`]\),[\w$]+\}\}""",
    re"""globalThis\.__cdbArtifactApps\.findFreeName\(""",
    proc(m: RegexMatch): string =
      let flFn = m.captures[0]
      "async function " & flFn &
        "(e){try{return await globalThis.__cdbArtifactApps.findFreeName(e," & qName &
        "())}catch(t){return e}}",
  )

  # --- Resolve shared Dx0_sNU1.js helpers BEFORE E5..E17 ---
  let entryMatch = findUnique(
    result,
    re"""function ([\w$]+)\(([\w$]+)\)\{if\(typeof [\w$]+==["`]string["`]\)\{let [\w$]+=[\w$]+\.QH\([\w$]+\);return [\w$]+===null\?void 0:([\w$]+)\.get\([\w$]+\)\}""",
    "Dx0_sNU1: findEntry / Z map",
  )
  let findEntryFn = entryMatch.captures[0]
  let zMap = entryMatch.captures[2]
  let jFn = findUnique(
    result,
    re"""var ([\w$]+)=[\w$]+=>[\w$]+\(\)\.find\(\([\w$]+=>[\w$]+\.artifactUuid===[\w$]+\)\)""",
    "Dx0_sNU1: J() finder",
  ).captures[0]
  let fcFn = findUnique(
    result, re"""([\w$]+)=e=>e\.name\|\|\(e\.bundle\?""", "Dx0_sNU1: fc() display name"
  ).captures[0]
  let iconMatch = findUnique(
    result,
    re"""[\w$]+=await [\w$]+,[\w$]+=([\w$]+)\([\w$]+\),[\w$]+=[\w$]+\?\?\([\w$]+\?([\w$]+)\([\w$]+\):null\)""",
    "Dx0_sNU1: rr/Un icon helpers",
  )
  let rrFn = iconMatch.captures[0]
  let unFn = iconMatch.captures[1]
  let kcFn = findUnique(
    result,
    re"""function ([\w$]+)\([\w$]+\)\{[\w$]+\(\)\.set\(["`]apps["`]""",
    "Dx0_sNU1: kc() store writer",
  ).captures[0]
  let nhFn = findUnique(
    result,
    re"""function ([\w$]+)\(([\w$]+)\)\{let [\w$]+=[\w$]+\.QH\([\w$]+\),[\w$]+=[\w$]+===null\?void 0:[\w$]+\.get\([\w$]+\);if\([\w$]+===null\|\|![\w$]+\|\|[\w$]+\.window\.isDestroyed\(\)\|\|[\w$]+\([\w$]+\)\)return!1;""",
    "Dx0_sNU1: nh() window rebuilder",
  ).captures[0]
  let klFn = findUnique(
    result,
    re"""function ([\w$]+)\([\w$]+\)\{let [\w$]+=[\w$]+\([\w$]+\.artifactUuid\)\?[\w$]+\([\w$]+\.artifactUuid\):[\w$]+\([\w$]+\.artifactUuid,\{sourceUrl:[\w$]+\([\w$]+\)\}\);return [\w$]+&&[\w$]+\([\w$]+\),[\w$]+!==null\}""",
    "Dx0_sNU1: openRecord helper",
  ).captures[0]
  let amFn = findUnique(
    result,
    re"""function ([\w$]+)\([\w$]+\)\{[\w$]+\([\w$]+,\([\w$]+=>\{[\w$]+\.showInactive\(\),[\w$]+\.BrowserWindow\.getFocusedWindow\(\)!==null&&[\w$]+\.focus\(\)\}\)\)\}""",
    "Dx0_sNU1: Am() window reveal",
  ).captures[0]
  let ecFn = findUnique(
    result,
    re"""function ([\w$]+)\([\w$]+\)\{return [\w$]+\(\)\.find\(\([\w$]+=>[\w$]+\.installId===[\w$]+\)\)\}""",
    "Dx0_sNU1: ec() installId lookup",
  ).captures[0]
  let zmParam = findUnique(
    result,
    re"""function [\w$]+\(([\w$]+),[\w$]+,[\w$]+,[\w$]+,[\w$]+,[\w$]+=\{hidden:!1\}\)\{let [\w$]+=[\w$]+\?\?[\w$]+\.restored\?\?[\w$]+\.around,""",
    "Dx0_sNU1: zm() artifactUuid param",
  ).captures[0]

  # --- 14. E5: Sl() Linux install flow ---
  applySub(
    result,
    patchesApplied,
    "E5: Sl() Linux installDesktopEntry + window rebuild",
    re"""async function ([\w$]+)\([\w$]+,[\w$]+,[\w$]+,[\w$]+\)\{let [\w$]+=[\w$]+\.artifactUuid,\{effect:[\w$]+,startedAt:[\w$]+,giveIcon:[\w$]+,abandon:[\w$]+,tellPage:[\w$]+\}=[\w$]+,([\w$]+)=([\w$]+)\.Irt\(\),[\w$]+=await [\w$]+\(\),\[[\w$]+,[\w$]+,[\w$]+,[\w$]+,[\w$]+\]=await Promise\.all\(\[[\w$]+\([\w$]+\)\.catch\(\(\(\)=>null\)\),[\w$]+\(\)\.catch\(\(\(\)=>null\)\),[\w$]+\(\)\.catch\(\(\(\)=>null\)\),[\w$]+\(\)\.catch\(\(\(\)=>null\)\),[\w$]+\(\)\]\),[\w$]+=await [\w$]+\([\w$]+,[\w$]+,[\w$]+,[\w$]+\);if\([\w$]+\|\|![\w$]+\|\|![\w$]+\|\|![\w$]+\|\|![\w$]+\|\|![\w$]+\)return await [\w$]+\(\),await ([\w$]+)\([\w$]+,[\w$]+,[\w$]+\?\?""\),"failed";if\(!([\w$]+)\([\w$]+,[\w$]+\)\)return await [\w$]+\(\),"cancelled";let [\w$]+=[\w$]+\.pageOrg\(\),\{inTime:[\w$]+,late:[\w$]+\}=([\w$]+)\([\w$]+,[\w$]+,[\w$]+\);[\w$]+\([\w$]+\);let [\w$]+=await [\w$]+\([\w$]+,\{native:[\w$]+,root:[\w$]+,template:[\w$]+,notifier:[\w$]+,shimHost:[\w$]+,minimumSystemVersion:[\w$]+,name:[\w$]+,org:[\w$]+,icon:[\w$]+\}\);if\([\w$]+===null\)return await [\w$]+\(\),await [\w$]+\([\w$]+,[\w$]+,([\w$]+)\(\)\),"failed";([\w$]+)\(["`]desktop_artifact_app_installed["`],\{frame_slug_fp:([\w$]+)\([\w$]+,[\w$]+\),total_installed:([\w$]+)\(\)\.length\}\);[\s\S]*?\[artifactApps\] installed, but /usr/bin/open couldn't start the app; telling the person %o[\s\S]*?([\w$]+)\([\w$]+,[\w$]+\),["`]installed["`]\}""",
    re"""globalThis\.__cdbArtifactApps\.installDesktopEntry\(\{""",
    proc(m: RegexMatch): string =
      let fn = m.captures[0]
      let tMod = m.captures[2]
      let elFn = m.captures[3]
      let glCheck = m.captures[4]
      let ylFn = m.captures[5]
      let tlFn = m.captures[6]
      let inFn = m.captures[7]
      let slugFn = m.captures[8]
      let qFn = m.captures[9]
      let xlFn = m.captures[10]
      "async function " & fn &
        "(e,n,r,i){let o=e.artifactUuid,{effect:s,startedAt:l,giveIcon:u,abandon:d,tellPage:f}=r,p=" &
        tMod & ".Irt();if(!" & glCheck &
        "(e,p))return await d(),\"cancelled\";let x=e.pageOrg(),{inTime:S,late:C}=" &
        ylFn &
        "(e,i,x);u(S);try{let _id=globalThis.__cdbArtifactApps.newInstallId();let _h=await S;let _g=" &
        rrFn & "(o);let _img=_g??(_h?" & unFn &
        "(_h):null);let _res=await globalThis.__cdbArtifactApps.installDesktopEntry({installId:_id,artifactUuid:o,name:i,image:_img,userDataDir:require(\"electron\").app.getPath(\"userData\")});let _rec={installId:_id,artifactUuid:o,org:x,name:i,desktopFile:_res.desktopFile,root:\"prod\"};" &
        kcFn & "([..." & qFn & "().filter(a=>a.artifactUuid!==o),_rec]);" & inFn &
        "(\"desktop_artifact_app_installed\",{frame_slug_fp:" & slugFn &
        "(o,x),total_installed:" & qFn &
        "().length});s.reveal(),await s.finished,e.window.isDestroyed()||e.window.isVisible()||" &
        amFn & "(e),f();if(!e.window.isDestroyed()){if(typeof " & nhFn &
        "===\"function\")" & nhFn & "(o);else " & klFn & "(_rec)}" & tMod &
        ".sUt.info(\"[artifactApps] installed the app %o\",{installId:_id,desktopFile:_res.desktopFile});" &
        xlFn & "(o,C);return\"installed\"}catch(err){" & tMod &
        ".sUt.warn(\"[artifactApps] linux install failed: %s\",err&&err.stack?err.stack:String(err));await d(),await " &
        elFn & "(n,i," & tlFn & "());return\"failed\"}}",
  )

  # --- 15. E6: kl() Linux icon update ---
  applySub(
    result,
    patchesApplied,
    "E6: kl() Linux icon update",
    re"""async function ([\w$]+)\([\w$]+\)\{let [\w$]+=([\w$]+)\([\w$]+\),[\w$]+=([\w$]+)\([\w$]+\)\?\?\([\w$]+&&([\w$]+)\.get\([\w$]+\.installId\)\);if\(![\w$]+\|\|![\w$]+\)return!1;await using [\w$]+=await [\w$]+\([\w$]+\([\w$]+\)\);let [\w$]+=[\w$]+\?await [\w$]+\([\w$]+,[\w$]+\):null;if\(![\w$]+\|\|![\w$]+\|\|[\w$]+\.root!==[\w$]+\)return!1;[\s\S]*?return await\(\(await [\w$]+\(\)\)\?\.registerBundle\([^)]+\)\)\.catch\(\(\(\)=>void 0\)\)\)?,?!0\}""",
    re"""globalThis\.__cdbArtifactApps\.updateAppIcon\(""",
    proc(m: RegexMatch): string =
      let klFn = m.captures[0]
      let jInner = m.captures[1]
      let rrInner = m.captures[2]
      let blMap = m.captures[3]
      "async function " & klFn & "(e){let t=" & jInner & "(e),n=" & rrInner & "(e)??(t&&" &
        blMap & ".get(t.installId));if(!n||!t)return!1;try{let _win=" & findEntryFn &
        "(e)?.window;return await globalThis.__cdbArtifactApps.updateAppIcon({installId:t.installId,desktopFile:t.desktopFile,image:n,userDataDir:require(\"electron\").app.getPath(\"userData\"),openWindow:_win})}catch(err){return!1}}",
  )

  # --- 16. E7: Gl() Linux uninstall ---
  applySub(
    result,
    patchesApplied,
    "E7: Gl() Linux desktop entry uninstall",
    re"""async function ([\w$]+)\([\w$]+,[\w$]+\)\{if\(!([\w$]+)\([\w$]+\.installId\)\|\|([\w$]+)\.has\([\w$]+\.installId\)\)return;[\w$]+\.add\([\w$]+\.installId\);let [\w$]+=([\w$]+)\([\w$]+\);try\{await using [\w$]+=await [\w$]+\([\w$]+\);let [\w$]+=[\w$]+\?await [\w$]+\([\w$]+,[\w$]+\):null;[\w$]+&&[\w$]+\?await ([\w$]+)\.shell\.trashItem\([\w$]+\.default\.join\([\w$]+\.path,[\w$]+\)\):await ([\w$]+)\([\w$]+,\{message:([\w$]+)\.ARt\(\)\.formatMessage\(\{defaultMessage:["`]Removed \{app\} from \{claude\}\.["`],id:["`]fpzLLNLWhs["`]\},\{app:([\w$]+)\(([\w$]+)\([\w$]+\)\),claude:([\w$]+)\}\),detail:[\w$]+\.ARt\(\)\.formatMessage\(\{defaultMessage:["`]The app itself wasn\\u2019t in \{folder\} in the \{parent\} folder in your home folder\. If it\\u2019s somewhere else, it won\\u2019t open any more; move it to the Trash\.["`],id:["`]YTaAqjE8OW["`]\},\{folder:[\w$]+\.folder,parent:[\w$]+\.parent\}\),buttons:\[([\w$]+)\(\)\]\}\);let [\w$]+=([\w$]+)\(\)\.filter\(\([\w$]+=>[\w$]+\.installId!==[\w$]+\.installId\)\);([\w$]+)\([\w$]+\),([\w$]+)\([\w$]+\.artifactUuid\),([\w$]+)\(["`]desktop_artifact_app_uninstalled["`],\{frame_slug_fp:([\w$]+)\([\w$]+\.artifactUuid,[\w$]+\.org\),how:["`]uninstall["`],total_installed:[\w$]+\.length\}\);let [\w$]+=[\w$]+\([\w$]+\.artifactUuid\);[\w$]+&&([\w$]+)\([\w$]+\)\}catch\([\w$]+\)\{([\w$]+)\(["`]uninstall failed["`],[\w$]+\),await [\w$]+\([\w$]+,\{icon:["`]warning["`],message:[\w$]+\.ARt\(\)\.formatMessage\(\{defaultMessage:["`]Couldn\\u2019t uninstall \{app\}\.["`],id:["`]Mt87m\+oj4i["`]\},\{app:[\w$]+\([\w$]+\([\w$]+\)\)\}\),detail:[\w$]+\.ARt\(\)\.formatMessage\(\{defaultMessage:["`]Try again\. If it keeps failing, drag it from its folder to the Trash in Finder; \{claude\} then forgets it\.["`],id:["`]tBvKdzADmO["`]\},\{claude:[\w$]+\}\),buttons:\[[\w$]+\(\)\]\}\)\}finally\{[\w$]+\.delete\([\w$]+\.installId\)\}\}""",
    re"""globalThis\.__cdbArtifactApps\.uninstallDesktopEntry\(""",
    proc(m: RegexMatch): string =
      let glFn = m.captures[0]
      let ecInner = m.captures[1]
      let delSet = m.captures[2]
      let cVar = m.captures[4]
      let dlgFn = m.captures[5]
      let tMod = m.captures[6]
      let hFn = m.captures[7]
      let fcInner = m.captures[8]
      let ysVar = m.captures[9]
      let brFn = m.captures[10]
      let qFn = m.captures[11]
      let kcInner = m.captures[12]
      let isFn = m.captures[13]
      let inFn = m.captures[14]
      let slugFn = m.captures[15]
      let jmFn = m.captures[16]
      let errFn = m.captures[17]
      "async function " & glFn & "(e,n){if(!" & ecInner & "(e.installId)||" & delSet &
        ".has(e.installId))return;" & delSet &
        ".add(e.installId);try{await globalThis.__cdbArtifactApps.uninstallDesktopEntry(e," &
        cVar & ".app.getPath(\"userData\"));let s=" & qFn &
        "().filter(t=>t.installId!==e.installId);" & kcInner & "(s)," & isFn &
        "(e.artifactUuid)," & inFn &
        "(\"desktop_artifact_app_uninstalled\",{frame_slug_fp:" & slugFn &
        "(e.artifactUuid,e.org),how:\"uninstall\",total_installed:s.length});let l=" &
        findEntryFn & "(e.artifactUuid);l&&" & jmFn & "(l)}catch(r){" & errFn &
        "(\"uninstall failed\",r),await " & dlgFn & "(n,{icon:\"warning\",message:" &
        tMod &
        ".ARt().formatMessage({defaultMessage:\"Couldn\\u2019t uninstall {app}.\",id:\"Mt87m+oj4i\"},{app:" &
        hFn & "(" & fcInner & "(e))}),detail:" & tMod &
        ".ARt().formatMessage({defaultMessage:\"Try again or remove its .desktop file from ~/.local/share/applications; {claude} then forgets it.\",id:\"tBvKdzADmO\"},{claude:" &
        ysVar & "}),buttons:[" & brFn & "()]})}finally{" & delSet &
        ".delete(e.installId)}}",
  )

  # --- 17. E8: Jl() Linux open + registerHooks ---
  applySub(
    result,
    patchesApplied,
    "E8: Jl() Linux open + registerHooks",
    re"""async function ([\w$]+)\([\w$]+\)\{await ([\w$]+)\(\);let [\w$]+=([\w$]+)\([\w$]+\);if\(![\w$]+\)return["`]notInstalled["`];let [\w$]+=([\w$]+)\([\w$]+\),[\w$]+=await [\w$]+\([\w$]+\),[\w$]+=[\w$]+!==null&&([\w$]+)\(\)&&await [\w$]+\([\w$]+\);return [\w$]+\|\|[\w$]+\?["`]opened["`]:["`]failed["`]\}""",
    re"""globalThis\.__cdbArtifactApps\.registerHooks\(\{""",
    proc(m: RegexMatch): string =
      let jlFn = m.captures[0]
      let ncFn = m.captures[1]
      let jInner = m.captures[2]
      let klInner = m.captures[3]
      let iFn = m.captures[4]
      "globalThis.__cdbArtifactApps.registerHooks({isEnabled:" & iFn &
        ",findByInstallId:" & ecFn & ",openRecord:" & klInner &
        ",markLaunched:()=>{}});async function " & jlFn & "(e){await " & ncFn &
        "();let t=" & jInner & "(e);if(!t)return\"notInstalled\";return " & klInner &
        "(t)?\"opened\":\"failed\"}",
  )

  # --- 18. E9: Bl() Linux Show .desktop in File Manager ---
  applySub(
    result,
    patchesApplied,
    "E9: Bl() Show desktop entry in File Manager",
    re"""async function ([\w$]+)\([\w$]+,[\w$]+\)\{let [\w$]+=await [\w$]+\([\w$]+\);if\([\w$]+\)\{([\w$]+)\.shell\.showItemInFolder\([\w$]+\);return\}let\{folder:[\w$]+,parent:[\w$]+\}=[\w$]+\([\w$]+\);await ([\w$]+)\([\w$]+,\{message:([\w$]+)\.ARt\(\)\.formatMessage\(\{defaultMessage:["`]Couldn\\u2019t find \{app\} in \{folder\} in the \{parent\} folder in your home folder\.["`],id:["`]QXaTM6Vrne["`]\},\{app:([\w$]+)\(([\w$]+)\([\w$]+\)\),folder:[\w$]+,parent:[\w$]+\}\),detail:[\w$]+\.ARt\(\)\.formatMessage\(\{defaultMessage:["`]It may have been moved or deleted\.["`],id:["`]aUTxfatgPO["`]\}\),buttons:\[([\w$]+)\(\)\]\}\)\}""",
    re"""globalThis\.__cdbArtifactApps\.desktopEntryPath\(""",
    proc(m: RegexMatch): string =
      let blFn = m.captures[0]
      let cVar = m.captures[1]
      let dlgFn = m.captures[2]
      let tMod = m.captures[3]
      let hFn = m.captures[4]
      let fcInner = m.captures[5]
      let brFn = m.captures[6]
      "async function " & blFn &
        "(e,n){let r=globalThis.__cdbArtifactApps.desktopEntryPath(n);if(r){" & cVar &
        ".shell.showItemInFolder(r);return}await " & dlgFn & "(e,{message:" & tMod &
        ".ARt().formatMessage({defaultMessage:\"Couldn\\u2019t find {app} in {folder} in the {parent} folder in your home folder.\",id:\"QXaTM6Vrne\"},{app:" &
        hFn & "(" & fcInner &
        "(n)),folder:\"applications\",parent:\".local/share\"}),detail:" & tMod &
        ".ARt().formatMessage({defaultMessage:\"It may have been moved or deleted.\",id:\"aUTxfatgPO\"}),buttons:[" &
        brFn & "()]})}",
  )

  # --- 19. E10 + E11: hu() badge + uu() app name fallback ---
  applySub(
    result,
    patchesApplied,
    "E10: hu() Linux badge count",
    re"""function ([\w$]+)\([\w$]+,[\w$]+\)\{let [\w$]+=[\w$]+\.get\([\w$]+\)\?\.shim;return [\w$]+\?\.isConnected\(\)\?\([\w$]+\.setBadge\([\w$]+\),!0\):!1\}""",
    re"""globalThis\.__cdbArtifactApps\.setBadge\(""",
    proc(m: RegexMatch): string =
      let huFn = m.captures[0]
      "function " & huFn &
        "(e,t){return globalThis.__cdbArtifactApps.setBadge(require(\"electron\").app,t)}",
  )

  applySub(
    result,
    patchesApplied,
    "E11: uu() installed app name fallback",
    re"""function ([\w$]+)\([\w$]+\)\{let [\w$]+=([\w$]+)\([\w$]+\);return [\w$]+===void 0\?void 0:([\w$]+)\.default\.basename\([\w$]+,["`]\.app["`]\)""",
    re"""globalThis\.__cdbArtifactApps\._uuFallback""",
    proc(m: RegexMatch): string =
      let uuFn = m.captures[0]
      let cuFn = m.captures[1]
      let pathVar = m.captures[2]
      "function " & uuFn & "(e){let t=" & cuFn & "(e);if(t!==void 0)return " & pathVar &
        ".default.basename(t,\".app\");let _rec=(globalThis.__cdbArtifactApps._uuFallback=1," &
        jFn & "(e));return _rec?" & fcFn & "(_rec):void 0",
  )

  # --- 20. E12: su() open apps restart persistence ---
  applySub(
    result,
    patchesApplied,
    "E12: su() restart reopen state for Linux windows",
    re"""function ([\w$]+)\(\)\{try\{let [\w$]+=\[\.\.\.[\w$]+\]\.filter\(\(\(\[,\{shim:[\w$]+\}\]\)=>[\w$]+\.isConnected\(\)\)\)\.flatMap\(\(\(\[[\w$]+,\{installId:[\w$]+\}\]\)=>\{let [\w$]+=[\w$]+\([\w$]+\);return![\w$]+\|\|[\w$]+\.window\.isDestroyed\(\)\?\[\]:\[\{installId:[\w$]+,state:[\w$]+\.isAway\(\)\?["`]hidden["`]:[\w$]+\.window\.isMinimized\(\)\?["`]minimized["`]:["`]shown["`],\.\.\.([\w$]+)\([\w$]+\)&&\{leftRunning:!0\},bounds:[\w$]+\.window\.getNormalBounds\(\)\}\]\}\)\);return\(\)=>([\w$]+)\([\w$]+\)\}catch\([\w$]+\)\{return ([\w$]+)\(["`]the open apps couldn't be read for the restart["`],[\w$]+\),async\(\)=>void 0\}\}""",
    re"""/\*__cdbSuLinux\*/""",
    proc(m: RegexMatch): string =
      let suFn = m.captures[0]
      let dmFn = m.captures[1]
      let euFn = m.captures[2]
      let errFn = m.captures[3]
      "function " & suFn & "(){try{let e=[..." & zMap &
        ".values()].flatMap(n=>{/*__cdbSuLinux*/let t=" & jFn &
        "(n.artifactUuid);return!t||n.window.isDestroyed()?[]:[{installId:t.installId,state:n.isAway()?\"hidden\":n.window.isMinimized()?\"minimized\":\"shown\",..." &
        dmFn &
        "(n.artifactUuid)&&{leftRunning:!0},bounds:n.window.getNormalBounds()}]});return()=>" &
        euFn & "(e)}catch(e){return " & errFn &
        "(\"the open apps couldn't be read for the restart\",e),async()=>void 0}}",
  )

  # --- 21. E13: zm() wraps BrowserWindow creation with per-window app_id + icon ---
  applySub(
    result,
    patchesApplied,
    "E13: zm() per-window CHROME_DESKTOP + icon",
    re"""([\w$]+)=new ([\w$]+)\.BrowserWindow\((\{\.\.\.[\w$]+,\.\.\.[\w$]+\?\{appShim:[\w$]+\}:\{\},minWidth:Math\.min\(360,[\w$]+\.width\?\?360,[\w$]+\.maxWidth\?\?360\),minHeight:Math\.min\(300,[\w$]+\.height\?\?300,[\w$]+\.maxHeight\?\?300\),backgroundColor:[\w$]+\.RL\(\),\.\.\.[\w$]+,\.\.\.[\w$]+\?[\w$]+\([\w$]+,[\w$]+,[\w$]+,[\w$]+\?void 0:[\w$]+\.beside\):\{\},\.\.\.[\w$]+\.hidden\?\{opacity:0\}:\{\},show:[\w$]+&&!0,title:[\w$]+\.LL\(\),autoHideMenuBar:!0,webPreferences:\{sandbox:!0,contextIsolation:!0,nodeIntegration:!1,devTools:!1,spellcheck:!1\}\})\),([\w$]+)=new [\w$]+\.WebContentsView""",
    re"""globalThis\.__cdbArtifactApps\.createWindow\(""",
    proc(m: RegexMatch): string =
      let winVar = m.captures[0]
      let cVar = m.captures[1]
      let optsObj = m.captures[2]
      let viewVar = m.captures[3]
      winVar & "=globalThis.__cdbArtifactApps.createWindow(" & cVar & ".BrowserWindow," &
        cVar & ".app," & optsObj & "," & jFn & "(" & zmParam & "))," & viewVar & "=new " &
        cVar & ".WebContentsView",
  )

  # --- 22. E14 + E15: pm() tray keep-alive + Qi.plainReason skip macOS WebGL overlay ---
  applySub(
    result,
    patchesApplied,
    "E14: pm() tray keep-alive on Linux",
    re"""function ([\w$]+)\([\w$]+\)\{return [\w$]+\.appShim\?\.isConnected\(\)===!0&&([\w$]+)\([\w$]+\.artifactUuid\)\}""",
    re"""/\*__cdbPmLinux\*/""",
    proc(m: RegexMatch): string =
      let pmFn = m.captures[0]
      let fdFn = m.captures[1]
      "function " & pmFn & "(e){return/*__cdbPmLinux*/(e.appShim?.isConnected()===!0||" &
        jFn & "(e.artifactUuid)!==void 0)&&" & fdFn & "(e.artifactUuid)}",
  )

  applySub(
    result,
    patchesApplied,
    "E15: Qi.plainReason() skips macOS WebGL overlay on Linux",
    re"""plainReason\(\)\{let [\w$]+=this\.target\.window;if\([\w$]+\)return["`]another install's effect is running["`];""",
    re"""plainReason\(\)\{if\(process\.platform===["`]linux["`]\)return["`]Linux["`];""",
    proc(m: RegexMatch): string =
      let full = m.match
      full.replace(
        "plainReason(){",
        "plainReason(){if(process.platform===\"linux\")return\"Linux\";",
      ),
  )

  # --- 23 + 24. E16 + E17: Linux UI wording ("Show in File Manager", ".desktop entry") ---
  applySub(
    result,
    patchesApplied,
    "E16: Linux Show in File Manager + uninstall dialog strings",
    re"""([\w$]+)=\(\)=>([\w$]+)\.ARt\(\)\.formatMessage\(\{defaultMessage:["`]Show in Finder["`],id:["`]BihKtuw6kW["`]\}\),([\w$]+)=[\w$]+\.FRt\(\{open:\{defaultMessage:["`]It will be moved to the Trash and this window will close\. If it[^}]+?\},closed:\{defaultMessage:["`]It will be moved to the Trash\. If it[^}]+?\}\}\)""",
    re"""formatMessage\(\{defaultMessage:["`]Show in File Manager["`],id:["`]BihKtuw6kW["`]\}""",
    proc(m: RegexMatch): string =
      let rlFn = m.captures[0]
      let tMod = m.captures[1]
      let ilVar = m.captures[2]
      rlFn & "=()=>" & tMod &
        ".ARt().formatMessage({defaultMessage:\"Show in File Manager\",id:\"BihKtuw6kW\"})," &
        ilVar & "=" & tMod &
        ".FRt({open:{defaultMessage:\"Its desktop entry and icons will be removed and this window will close.\",id:\"nVzd/e1U+y\"},closed:{defaultMessage:\"Its desktop entry and icons will be removed.\",id:\"eGIGZbh1JQ\"}})",
  )

  applySub(
    result,
    patchesApplied,
    "E17: Linux Show App in File Manager context menu item",
    re"""defaultMessage:["`]Show App in Finder["`],id:["`]gd\+Fc5U7Fh["`]\}\),click:([\w$]+)\(["`]Show App in Finder["`]""",
    re"""defaultMessage:["`]Show App in File Manager["`],id:["`]gd\+Fc5U7Fh["`]""",
    proc(m: RegexMatch): string =
      let yFn = m.captures[0]
      "defaultMessage:\"Show App in File Manager\",id:\"gd+Fc5U7Fh\"}),click:" & yFn &
        "(\"Show App in File Manager\"",
  )

  if patchesApplied < EXPECTED_PATCHES:
    echo "  [FAIL] Only " & $patchesApplied & "/" & $EXPECTED_PATCHES &
      " sub-patches applied"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_artifact_apps_linux <file>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_artifact_apps_linux ==="
  echo "  Target: " & filePath
  let src = readFile(filePath)
  let dst = apply(src)
  if dst != src:
    writeFile(filePath, dst)
  echo "  [DONE] fix_artifact_apps_linux"
