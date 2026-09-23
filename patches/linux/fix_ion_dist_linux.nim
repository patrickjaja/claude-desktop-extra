# @patch-target: resources/ion-dist
# @patch-type: nim-dir
#
# Patch the ion-dist 3P configuration SPA for Linux compatibility.
#
# The ion-dist bundle is a React SPA served via the app:// protocol that
# powers Developer -> Configure Third-Party Inference. It has two issues
# on Linux:
#
#   1) The org-plugins mount path only has mac/win entries - on Linux it
#      falls back to the macOS path "/Library/Application Support/Claude/org-plugins"
#
#   2) The mount-path display component uses VAR===ENUM.Win32?X.win:X.mac
#      which ignores the Linux case entirely
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

const EXPECTED_PATCHES = 2

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
  for filePath in spaFiles(ionDistDir):
    let content = readFile(filePath)
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

  if patchesApplied + ord(applyA) + ord(applyB) != EXPECTED_PATCHES:
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
    if content != original:
      writeFile(filePath, content)

  if patchesApplied != EXPECTED_PATCHES:
    echo "  [FAIL] Only " & $patchesApplied & "/" & $EXPECTED_PATCHES &
      " patches applied"
    quit(1)

  echo "  [PASS] All " & $EXPECTED_PATCHES & " patches applied"
  quit(0)
