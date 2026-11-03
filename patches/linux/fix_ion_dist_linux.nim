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
#   3) The Cowork header device popover says "Connected - Claude can use the
#      files and apps on your computer." with a green dot even when THIS
#      desktop registered as a KEYLESS device (the user cannot open
#      /dev/tpmrm0). The server never attaches computer tools to a keyless
#      device's cloud sessions, so cloud Cowork / Dispatch silently has no
#      Computer Use. Sub-patch C wraps the popover's status-line builder:
#        {title:d,statusLine:f,iconLabel:p}=Mj(n)
#      -> {title:d,statusLine:f,iconLabel:p}=__cdbKeylessHint(Mj(n),n)
#      and the helper (inserted before Mj) turns the line into a warning-dot
#      hint pointing at Settings -> Extra -> Community -> Computer Use status, only when:
#      process.platform is linux (window.process from upstream's own preload),
#      the popover's props say linkedHere (the session is bound by THIS
#      desktop) and status "connected", and upstream's own deviceLinkStore
#      (globalThis["claude.web"].WindowState, this desktop's remote-tools link)
#      reports connected with idSource "keyless". Anything else returns
#      upstream's object unchanged.
#
# The target JS files have content-hash filenames (e.g. c71860c77-C6hxWuPG.js)
# that change every upstream release, and since v1.28929.0 the SPA is split so
# the mountPath data object and its platform-ternary consumer live in two
# DIFFERENT chunks. Each sub-patch therefore finds its own target file by
# content signature. Counts are taken across ALL SPA files: each sub-patch has
# exactly one site (upstream shape to apply, or our end state = already
# applied); any other total is a FAIL.

import std/[os, strutils]
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
# apps on your computer." message id; the call site and the status-line
# builder's props shape are both pinned in that chunk (4.4212.0 names: Nj
# calls Mj, Mj destructures {linkedHere,usableFromHere,computerName,status}).
const sigC = "cQTH9F2BGU"
const callPatC =
  re2"\{title:([\w$]+),statusLine:([\w$]+),iconLabel:([\w$]+)\}=([\w$]+)\(([\w$]+)\)"
const patchedCallPatC =
  re2"\{title:[\w$]+,statusLine:[\w$]+,iconLabel:[\w$]+\}=__cdbKeylessHint\([\w$]+\([\w$]+\),[\w$]+\)"
const builderPatC =
  re2"function ([\w$]+)\([\w$]+\)\{let [\w$]+=[\w$]+\(\d+\),\{linkedHere:[\w$]+,usableFromHere:[\w$]+,computerName:[\w$]+,status:[\w$]+,"
const helperMarkerC = "/*cdb:keyless-hint*/"
const helperC =
  helperMarkerC &
  """var __cdbKeylessLink={sub:!1,state:void 0,memo:new WeakMap};function __cdbKeylessState(){if(!__cdbKeylessLink.sub){__cdbKeylessLink.sub=!0;try{let e=globalThis["claude.web"]?.WindowState?.deviceLinkStore;e?.onStateChange(t=>{__cdbKeylessLink.state=t}),__cdbKeylessLink.state=e?.getStateSync()}catch{}}return __cdbKeylessLink.state}function __cdbKeylessHint(r,p){try{if(globalThis.process?.platform!=="linux"||p?.linkedHere!==!0||p.status!=="connected"||r?.statusLine?.detail===void 0)return r;let s=__cdbKeylessState();if(s?.connected!==!0||s.idSource!=="keyless")return r;let m=__cdbKeylessLink.memo.get(r);return m===void 0&&(m={...r,statusLine:{...r.statusLine,dotColor:"var(--cds-fill-warning)",detail:"Connected without a device key, so Computer Use is not available in Cowork. Open Settings -> Extra -> Community -> Computer Use status to fix it."}},__cdbKeylessLink.memo.set(r,m)),m}catch{return r}}"""

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

proc checkBuilderC(content: string): string =
  ## Sub-patch C precondition: the call site's callee is the status-line
  ## builder whose props carry linkedHere and status. Returns the call's
  ## callee name, or "" when the shape is not exactly that.
  let calls = content.findAll(callPatC)
  let builders = content.findAll(builderPatC)
  if calls.len != 1 or builders.len != 1:
    return ""
  let callee = content[calls[0].group(3)]
  if content[builders[0].group(0)] != callee:
    return ""
  callee

proc applyKeylessHint(content: string): string =
  ## Sub-patch C: wrap the builder call and insert the helper before the
  ## builder's declaration (function declarations hoist, module scope).
  let call = content.findAll(callPatC)[0]
  let builder = content.findAll(builderPatC)[0]
  let callee = content[call.group(3)]
  let props = content[call.group(4)]
  let wrapped =
    "{title:" & content[call.group(0)] & ",statusLine:" & content[call.group(1)] &
    ",iconLabel:" & content[call.group(2)] & "}=__cdbKeylessHint(" & callee & "(" & props &
    ")," & props & ")"
  var parts: seq[(int, int, string)] =
    @[
      (call.boundaries.a, call.boundaries.b + 1, wrapped),
      (builder.boundaries.a, builder.boundaries.a, helperC),
    ]
  # Apply from the end so earlier offsets stay valid.
  if parts[0][0] < parts[1][0]:
    parts = @[parts[1], parts[0]]
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
  var sigFilesC, oldC, newC, helpersC = 0
  var builderOkC = false
  var helperExactC = 0
  for filePath in spaFiles(ionDistDir):
    let content = readFile(filePath)
    helpersC += content.count("function __cdbKeylessHint(")
    if content.contains(sigC):
      sigFilesC += 1
      oldC += content.findAll(callPatC).len
      newC += content.findAll(patchedCallPatC).len
      helperExactC += content.count(helperC)
      builderOkC = checkBuilderC(content) != ""
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
  elif oldC == 1 and newC == 0 and helpersC == 0 and builderOkC:
    applyC = true
  elif oldC == 0 and newC == 1 and helpersC == 1 and helperExactC == 1:
    echo "  [OK] keyless device hint: already applied"
    patchesApplied += 1
  else:
    echo "  [FAIL] keyless device hint: " & $oldC & " upstream and " & $newC &
      " patched call sites, " & $helpersC & " helpers (" & $helperExactC &
      " exact), builder shape " & (if builderOkC: "ok" else: "not found") &
      " - expected exactly one upstream site with the {linkedHere,...,status} builder, or our end state"

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
      content = applyKeylessHint(content)
      if content.findAll(patchedCallPatC).len == 1 and content.count(helperC) == 1 and
          content.findAll(callPatC).len == 0:
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
