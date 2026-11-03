# @patch-target: resources/ion-dist
# @patch-type: nim-dir
#
# Patch the ion-dist 3P configuration SPA for Linux compatibility.
#
# The ion-dist bundle is a React SPA served via the app:// protocol that
# powers Developer -> Configure Third-Party Inference and the Cowork UI. It
# has three issues on Linux:
#
#   1) The org-plugins mount path only has mac/win entries - on Linux it
#      falls back to the macOS path "/Library/Application Support/Claude/org-plugins"
#
#   2) The mount-path display component uses VAR===ENUM.Win32?X.win:X.mac
#      which ignores the Linux case entirely
#
#   3) A Cowork task on a KEYLESS desktop (the user cannot open /dev/tpmrm0)
#      shows no device icon at all: the server refuses to bind cloud sessions
#      to a keyless device, the session's binding state stays "unbound", and
#      the header seat returns null. Nothing says why Computer Use is missing.
#      Sub-patch C (4.4212.0 names) makes the seat's unbound branch
#        if(!Cj(o))return null;
#      -> if(!Cj(o))return __cdbKeylessSeat(o,a);
#      and wraps the popover's status-line builder call inside Nj
#        {title:d,statusLine:f,iconLabel:p}=Mj(n)
#      -> {title:d,statusLine:f,iconLabel:p}=__cdbKeylessLine(Mj(n),n)
#      The helpers (inserted before Cj) return null unless process.platform
#      is linux and the state is exactly "unbound"; then a small component
#      subscribes (useSyncExternalStore) to upstream's deviceLinkStore
#      (globalThis["claude.web"].WindowState) and, while it reports
#      connected + idSource "keyless", renders upstream's own popover Nj with
#      a private __cdbKeyless prop. __cdbKeylessLine turns only that Nj's
#      status line into a warning dot and the Computer Use status hint; every
#      other Nj gets upstream's object back unchanged.
#
# The target JS files have content-hash filenames (e.g. c71860c77-C6hxWuPG.js)
# that change every upstream release, and since v1.28929.0 the SPA is split so
# the mountPath data object and its platform-ternary consumer live in two
# DIFFERENT chunks. Each sub-patch therefore finds its own target file by
# content signature. Counts are taken across ALL SPA files: each sub-patch has
# exactly one site (upstream shape to apply, or our end state = already
# applied); any other total is a FAIL.

import std/[algorithm, os, strutils]
import regex

const EXPECTED_PATCHES = 3

const oldMountPath =
  """mountPath:{mac:"/Library/Application Support/Claude/org-plugins",win:"%ProgramFiles%\\Claude\\org-plugins"}"""
const newMountPath =
  """mountPath:{mac:"/Library/Application Support/Claude/org-plugins",win:"%ProgramFiles%\\Claude\\org-plugins",linux:"/etc/claude-desktop/org-plugins"}"""

# Sub-patch B patterns. Variable names are minified and change between
# versions (v1.7196: r===W.Win32?t.win:t.mac; v1.8089:
# C===V.Win32?Ve.mountPath.win:Ve.mountPath.mac). Use [\w$.]+ wildcards.
const alreadyPatchedPatB =
  re2"""[\w$]+=== *[\w$]+\.Win32\?[\w$.]+\.win:[\w$]+=== *[\w$]+\.Linux\?[\w$.]+\.linux:[\w$.]+\.mac"""
const ternaryPatB = re2"""([\w$]+)=== *([\w$]+)\.Win32\?([\w$.]+)\.win:([\w$.]+)\.mac"""

# Sub-patch C. The popover chunk is found by the "Claude can use the files and
# apps on your computer." message id. In it every anchor is pinned by content
# shape and must hit exactly once (4.4212.0 names in brackets):
#   cjPatC     the "renders a seat" predicate          [Cj]
#   headPatC   the header seat's head: muted flag, binding-state hook, bound
#              flag and linkedHere hook                 [wj: a, lu(t), s, Dj]
#   guard      "if(!Cj(o))return null;if(!s)return "  (built from the head)
#   njCallPatC the seat's upstream popover render       [q(Nj,{linkedHere:c,...)]
#   djPatC     the linkedHere hook's useSyncExternalStore call [Dj -> Ue(t,n,n)]
#   callPatC   Nj's status-line builder call, callee = builderPatC [Mj(n)]
const sigC = "cQTH9F2BGU"
const cjPatC =
  re2"""function ([\w$]+)\([\w$]+\)\{return [\w$]+==="bound"\|\|[\w$]+==="unknown"\}"""
const headPatC =
  re2"""\{sessionId:([\w$]+),muted:([\w$]+),isScheduledTaskRun:[\w$]+,isDispatchSession:[\w$]+\}=[\w$]+,([\w$]+)=([\w$]+)!==void 0&&([\w$]+),([\w$]+)=([\w$]+)\(([\w$]+)\),([\w$]+)=([\w$]+)==="bound",([\w$]+)=([\w$]+)\(([\w$]+)\?([\w$]+):void 0\)"""
const njCallPatC =
  re2"""([\w$]+)\(([\w$]+),\{linkedHere:([\w$]+),usableFromHere:[\w$]+,computerName:[\w$]+,status:[\w$]+,connectedElsewhere:[\w$]+,linkOffer:[\w$]+,onLink:"""
const djPatC =
  re2"""function ([\w$]+)\([\w$]+\)\{let \$=[\w$]+\(\d+\),[^;]*;return ([\w$]+)\(([\w$]+),([\w$]+),([\w$]+)\)\}"""
const callPatC =
  re2"\{title:([\w$]+),statusLine:([\w$]+),iconLabel:([\w$]+)\}=([\w$]+)\(([\w$]+)\)"
const patchedCallPatC =
  re2"\{title:([\w$]+),statusLine:([\w$]+),iconLabel:([\w$]+)\}=__cdbKeylessLine\(([\w$]+)\(([\w$]+)\),([\w$]+)\)"
const builderPatC =
  re2"function ([\w$]+)\([\w$]+\)\{let [\w$]+=[\w$]+\(\d+\),\{linkedHere:[\w$]+,usableFromHere:[\w$]+,computerName:[\w$]+,status:[\w$]+,"
const helperMarkerC = "/*cdb:keyless-hint*/"
# __JSX__ / __USE__ / __NJ__ are replaced with the chunk's jsx factory,
# useSyncExternalStore binding and popover component.
const helperTemplateC =
  helperMarkerC &
  """var __cdbKeylessLink={sub:!1,state:void 0,fans:new Set,memo:new WeakMap};function __cdbKeylessInit(){if(!__cdbKeylessLink.sub){__cdbKeylessLink.sub=!0;try{let e=globalThis["claude.web"]?.WindowState?.deviceLinkStore;e?.onStateChange(t=>{__cdbKeylessLink.state=t;for(let n of __cdbKeylessLink.fans)try{n()}catch{}}),__cdbKeylessLink.state=e?.getStateSync()}catch{}}}function __cdbKeylessSub(e){return __cdbKeylessInit(),__cdbKeylessLink.fans.add(e),()=>{__cdbKeylessLink.fans.delete(e)}}function __cdbKeylessSnap(){__cdbKeylessInit();let e=__cdbKeylessLink.state;return e?.connected===!0&&e.idSource==="keyless"}function __cdbKeylessSeat(e,t){try{return globalThis.process?.platform==="linux"&&e==="unbound"?__JSX__(__cdbKeylessIcon,{muted:t}):null}catch{return null}}function __cdbKeylessIcon(e){return __USE__(__cdbKeylessSub,__cdbKeylessSnap,__cdbKeylessSnap)?__JSX__(__NJ__,{linkedHere:!1,computerName:"Not linked to this computer",muted:e.muted,__cdbKeyless:!0}):null}function __cdbKeylessLine(r,p){try{if(p?.__cdbKeyless!==!0||r==null)return r;let m=__cdbKeylessLink.memo.get(r);return m===void 0&&(m={...r,statusLine:{dotColor:"var(--cds-fill-warning)",text:"No device key",detail:"This desktop has no device key, so Computer Use is not available in Cowork. Open Settings -> Extra -> Computer Use to fix it.",label:"No device key"},iconLabel:r.title+", No device key"},__cdbKeylessLink.memo.set(r,m)),m}catch{return r}}"""

type
  StateC = enum
    scBad
    scPristine
    scPatched

  SitesC = object
    state: StateC
    why: string
    cj, cjAt: int # cjAt: offset of "function Cj("
    guardOld, guardNew: string # the seat guard before / after
    guardAt: int
    helper: string # the exact helper for this chunk's names
    callAt, callEnd: int # Nj's builder call (pristine)
    callNew: string

proc analyzeC(content: string): SitesC =
  ## Sub-patch C: locate every anchor and classify the chunk as pristine
  ## upstream, fully patched (our exact end state), or anything else (bad).
  result.state = scBad
  let cjs = content.findAll(cjPatC)
  if cjs.len != 1:
    result.why = $cjs.len & " seat predicates"
    return
  let cj = content[cjs[0].group(0)]
  result.cjAt = cjs[0].boundaries.a
  let heads = content.findAll(headPatC)
  if heads.len != 1:
    result.why = $heads.len & " header seat heads"
    return
  let h = heads[0]
  template g(i: int): string =
    content[h.group(i)]

  # {sessionId:t,muted:n,..}=e,a=n!==void 0&&n,o=lu(t),s=o==="bound",c=Dj(s?t:void 0)
  if g(1) != g(3) or g(1) != g(4) or g(0) != g(7) or g(0) != g(13) or g(5) != g(9) or
      g(8) != g(12):
    result.why = "header seat head has an unexpected data flow"
    return
  let muted = g(2)
  let bindState = g(5)
  let boundFlag = g(8)
  let linkedVar = g(10)
  let dj = g(11)
  let guardPrefix = "if(!" & cj & "(" & bindState & "))return "
  let guardSuffix = ";if(!" & boundFlag & ")return "
  result.guardOld = guardPrefix & "null" & guardSuffix
  result.guardNew =
    guardPrefix & "__cdbKeylessSeat(" & bindState & "," & muted & ")" & guardSuffix
  let nOld = content.count(result.guardOld)
  let nNew = content.count(result.guardNew)
  let njs = content.findAll(njCallPatC)
  if njs.len != 1 or content[njs[0].group(2)] != linkedVar:
    result.why = $njs.len & " seat popover renders"
    return
  let jsx = content[njs[0].group(0)]
  let nj = content[njs[0].group(1)]
  var use = ""
  var djHits = 0
  for m in content.findAll(djPatC):
    if content[m.group(0)] == dj:
      djHits += 1
      if content[m.group(3)] == content[m.group(4)]:
        use = content[m.group(1)]
  if djHits != 1 or use == "":
    result.why = "linkedHere hook " & dj & " not found as one store subscription"
    return
  result.helper =
    helperTemplateC.multiReplace(("__JSX__", jsx), ("__USE__", use), ("__NJ__", nj))
  let builders = content.findAll(builderPatC)
  if builders.len != 1:
    result.why = $builders.len & " status-line builders"
    return
  let builder = content[builders[0].group(0)]
  let njAt = content.find("function " & nj & "(")
  let njEnd = content.find("function ", njAt + 1)
  if njAt < 0 or content.count("function " & nj & "(") != 1:
    result.why = "popover component " & nj & " not declared once"
    return
  let calls = content.findAll(callPatC)
  let patched = content.findAll(patchedCallPatC)
  let helpers = content.count(helperMarkerC)
  if calls.len == 1 and patched.len == 0 and nOld == 1 and nNew == 0 and helpers == 0:
    let c = calls[0]
    if content[c.group(3)] != builder or c.boundaries.a < njAt or c.boundaries.a > njEnd:
      result.why = "Nj's builder call is not " & builder & "(props) inside " & nj
      return
    let props = content[c.group(4)]
    result.guardAt = content.find(result.guardOld)
    result.callAt = c.boundaries.a
    result.callEnd = c.boundaries.b + 1
    result.callNew =
      "{title:" & content[c.group(0)] & ",statusLine:" & content[c.group(1)] &
      ",iconLabel:" & content[c.group(2)] & "}=__cdbKeylessLine(" & builder & "(" & props &
      ")," & props & ")"
    result.state = scPristine
  elif calls.len == 0 and patched.len == 1 and nOld == 0 and nNew == 1 and helpers == 1 and
      content.count(result.helper) == 1 and
      content.find(result.helper & "function " & cj & "(") >= 0:
    let c = patched[0]
    if content[c.group(3)] != builder or content[c.group(4)] != content[c.group(5)] or
        c.boundaries.a < njAt or c.boundaries.a > njEnd:
      result.why = "wrapped call is not around " & builder & "(props) inside " & nj
      return
    result.state = scPatched
  else:
    result.why =
      $calls.len & " upstream and " & $patched.len & " wrapped builder calls, " & $nOld &
      " upstream and " & $nNew & " patched seat guards, " & $helpers & " helpers (" &
      $content.count(result.helper) & " exact, before " & cj & ")"

iterator spaFiles(ionDistDir: string): string =
  for dir in walkDir(ionDistDir / "assets" / "v1"):
    if dir.kind == pcFile and dir.path.endsWith(".js"):
      yield dir.path

proc applyTernary(content: string): string =
  ## Sub-patch B: extend the Win32/mac mount-path ternary with a Linux case.
  content.replace(
    ternaryPatB,
    proc(m: RegexMatch2, s: string): string =
      let condVar = s[m.group(0)]
      let enumVar = s[m.group(1)]
      let winObj = s[m.group(2)]
      let macObj = s[m.group(3)]
      condVar & "===" & enumVar & ".Win32?" & winObj & ".win:" & condVar & "===" &
        enumVar & ".Linux?" & winObj & ".linux:" & macObj & ".mac",
  )

proc applyKeylessHint(content: string, c: SitesC): string =
  ## Sub-patch C: three splices, applied from the end so earlier offsets stay
  ## valid: Nj's builder call, the seat guard, the helper before Cj.
  var parts: seq[(int, int, string)] =
    @[
      (c.callAt, c.callEnd, c.callNew),
      (c.guardAt, c.guardAt + c.guardOld.len, c.guardNew),
      (c.cjAt, c.cjAt, c.helper),
    ]
  parts.sort(
    proc(x, y: (int, int, string)): int =
      cmp(y[0], x[0])
  )
  result = content
  for (a, b, text) in parts:
    result = result[0 ..< a] & text & result[b .. ^1]

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_ion_dist_linux <ion-dist-directory>"
    quit(1)
  let ionDistDir = paramStr(1)
  echo "=== Patch: fix_ion_dist_linux ==="
  echo "  Target dir: " & ionDistDir
  if not dirExists(ionDistDir):
    echo "  [FAIL] Directory not found: " & ionDistDir
    quit(1)

  # Pass 1: count every site across all SPA files.
  var oldA, newA, oldB, newB = 0
  var sigFilesC, helpersC = 0
  var sitesC: SitesC
  for filePath in spaFiles(ionDistDir):
    let content = readFile(filePath)
    helpersC += content.count("function __cdbKeylessSeat(")
    helpersC += content.count("function __cdbKeylessHint(")
    if content.contains(sigC):
      sigFilesC += 1
      sitesC = analyzeC(content)
    oldA += content.count(oldMountPath)
    newA += content.count(newMountPath)
    oldB += content.findAll(ternaryPatB).len
    newB += content.findAll(alreadyPatchedPatB).len

  var patchesApplied = 0
  var applyA, applyB = false
  if oldA == 1 and newA == 0:
    applyA = true
  elif oldA == 0 and newA == 1:
    echo "  [OK] org-plugins linux path: already applied"
    patchesApplied += 1
  else:
    echo "  [FAIL] org-plugins linux path: " & $oldA & " upstream and " & $newA &
      " patched sites across the SPA, expected exactly one of them once"
  if oldB == 1 and newB == 0:
    applyB = true
  elif oldB == 0 and newB == 1:
    echo "  [OK] mount path platform ternary: already applied"
    patchesApplied += 1
  else:
    echo "  [FAIL] mount path platform ternary: " & $oldB & " upstream and " & $newB &
      " patched sites across the SPA, expected exactly one of them once"

  var applyC = false
  if sigFilesC != 1:
    echo "  [FAIL] keyless device hint: " & $sigFilesC & " SPA files carry " & sigC &
      ", expected exactly one (the Cowork device popover chunk)"
  elif helpersC > 1 or (sitesC.state == scPristine and helpersC != 0):
    echo "  [FAIL] keyless device hint: " & $helpersC &
      " keyless helpers across the SPA, expected none (pristine) or ours once"
  elif sitesC.state == scPristine:
    applyC = true
  elif sitesC.state == scPatched:
    echo "  [OK] keyless device hint: already applied"
    patchesApplied += 1
  else:
    echo "  [FAIL] keyless device hint: " & sitesC.why &
      " - expected the pristine header seat + popover shapes exactly once, or our end state"

  if patchesApplied + ord(applyA) + ord(applyB) + ord(applyC) != EXPECTED_PATCHES:
    echo "  [INFO] This likely means the upstream changed the 3P config UI structure"
    quit(1)

  # Pass 2: apply to the one file that holds each site.
  for filePath in spaFiles(ionDistDir):
    var content = readFile(filePath)
    let original = content
    let fileName = extractFilename(filePath)
    if applyA and content.contains(oldMountPath):
      content = content.replace(oldMountPath, newMountPath)
      echo "  [OK] org-plugins linux path: 1 match (" & fileName & ")"
      patchesApplied += 1
    if applyB and content.findAll(ternaryPatB).len == 1:
      content = applyTernary(content)
      echo "  [OK] mount path platform ternary: 1 match (" & fileName & ")"
      patchesApplied += 1
    if applyC and content.contains(sigC):
      content = applyKeylessHint(content, analyzeC(content))
      if analyzeC(content).state == scPatched:
        echo "  [OK] keyless device hint: 1 match (" & fileName & ")"
        patchesApplied += 1
      else:
        echo "  [FAIL] keyless device hint: end state not present after rewrite (" &
          fileName & ")"
    if content != original:
      writeFile(filePath, content)

  if patchesApplied != EXPECTED_PATCHES:
    echo "  [FAIL] Only " & $patchesApplied & "/" & $EXPECTED_PATCHES &
      " patches applied"
    quit(1)

  echo "  [PASS] All " & $EXPECTED_PATCHES & " patches applied"
  quit(0)
