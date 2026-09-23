# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Make "Open in VS Code / Cursor / Zed / Windsurf" work in Local Code Sessions
# on Linux. (Still NOT upstreamed: the editor flow gates on Electron's
# `app.getApplicationInfoForProtocol(url)`, which is macOS+Windows-only; on Linux
# it never resolves a populated `{path,name,icon}`, so every editor reports
# installed:false and the open buttons are hidden/no-op.)
#
# WHY THIS PATCH CHANGED (vs the MSIX version):
#   The old shim built `{path,name,icon}` on top of
#   `app.getApplicationNameForProtocol(url)`. That Electron API is GONE from the
#   official .deb bundle (0 occurrences), so the old shim text-applied but called
#   an undefined function at runtime -> TypeError. We now detect a registered
#   URL-scheme handler the canonical XDG way instead:
#     xdg-mime query default x-scheme-handler/<scheme>
#   which prints the handler's .desktop filename (e.g. "code.desktop") when one is
#   registered and nothing otherwise. xdg-utils ships xdg-mime on every supported
#   distro (it is already a runtime dep for xdg-open, used by the launcher).
#
# WHAT THE 7 CALL SITES CONSUME (verified against the bundle):
#   - isVSCodeInstalled():            return!!(X!=null&&X.path)            // truthiness only
#   - openInVSCode()/openInEditor():  if(!(X!=null&&X.path))return!1; ... shell.openExternal("vscode://file/…")
#                                                                          // .path only gates; the open is shell.openExternal
#   - editor/Xcode detection:         o=!!(X!=null&&X.path)                // truthiness only
#   - mailto/external link dialogs:   X.name (display) and X.icon.isEmpty()
#   So the shim must return {path:<truthy when registered>, name:<display>, icon:{isEmpty:()=>!0}}
#   or null. We map .path/.name to the handler's .desktop name (path) and a
#   prettified name, and stub the icon (we don't ship editor icons on Linux; the
#   UI tolerates iconDataUrl: undefined).
#
# The arg to getApplicationInfoForProtocol is a URL-ish string in all forms we see
# ("vscode://" literal, a var `A`, or `i.protocol`/`n.protocol` = "<scheme>://"),
# so we evaluate it once and split on "://" to get the scheme.

import std/[os, strformat, strutils]
import regex

# Synchronous Linux shim: probe xdg-mime for a scheme handler. `_p` is the
# original argument expression (a URL string). stdio ignore on stdin/stderr so a
# missing xdg-mime or unregistered scheme just yields null (button stays hidden)
# rather than throwing into the surrounding try/catch.
#
# Uses execFileSync with an argv ARRAY (no shell) instead of execSync with a
# concatenated command string: the scheme `_s` is passed as a discrete argument,
# so shell metacharacters in a protocol string can never reach a shell. xdg-mime
# is invoked directly, the scheme is appended to the literal "x-scheme-handler/"
# argument, and a missing binary just throws into our catch → null.
const LINUX_SHIM_HEAD =
  "(process.platform===\"linux\"?(_p=>{try{const _s=String(_p).split(\"://\")[0];" &
  "const _h=require(\"child_process\").execFileSync(\"xdg-mime\",[\"query\",\"default\",\"x-scheme-handler/\"+_s]," &
  "{encoding:\"utf-8\",stdio:[\"ignore\",\"pipe\",\"ignore\"]}).trim();" &
  "return _h?{path:_h,name:_h.replace(/\\.desktop$/,\"\"),icon:{isEmpty:()=>!0}}:null}catch(_e){return null}})("

# Unique substring proving our replacement is already present (idempotency).
# Asserts the NEW (shell-free) execFileSync form specifically, so an old
# execSync-based shim would NOT be mistaken for already-patched.
const PATCHED_MARKER =
  "execFileSync(\"xdg-mime\",[\"query\",\"default\",\"x-scheme-handler/\""

proc apply*(input: string): string =
  result = input

  # ── Patch 1: Linux-aware shim for getApplicationInfoForProtocol ────────
  # Every call site: `<var>.app.getApplicationInfoForProtocol(<arg>)`.
  # We capture <var> (minified Electron binding) and <arg> and wrap them so the
  # original (non-Linux) call is preserved on the false branch.
  let markerCount = input.count(PATCHED_MARKER)
  if markerCount == 4:
    echo "  [OK] getApplicationInfoForProtocol Linux shim: already patched (skipped)"
  elif markerCount != 0:
    echo &"  [FAIL] getApplicationInfoForProtocol shim present at {markerCount} sites, expected 4"
    raise newException(
      ValueError, "fix_open_in_editor_linux: partially shimmed input, re-audit"
    )
  else:
    let pattern1 =
      re2"""([\w$]+(?:\.[\w$]+)*)\.app\.getApplicationInfoForProtocol\(([^()]+)\)"""
    var count1 = 0
    result = result.replace(
      pattern1,
      proc(m: RegexMatch2, s: string): string =
        inc count1
        let v = s[m.group(0)]
        let a = s[m.group(1)]
        LINUX_SHIM_HEAD & a & "):" & v & ".app.getApplicationInfoForProtocol(" & a & "))",
    )
    # Expected sites (clean .deb bundle, v1.26832.0): 4
    #   2× link-open dialogs (mailto/external): read .name and .icon
    #   2× <editorTable>.protocol: editor/Xcode installed-detection and the
    #      open path, both of which gate on `.path` being truthy
    #
    # v1.24012.9 had 6: the two above pairs plus TWO copies of a legacy
    # `isVSCodeInstalled(){…getApplicationInfoForProtocol("vscode://")}` method
    # (duplicated across chunks). v1.26832.0 deleted both - `isVSCodeInstalled`
    # and the "vscode://" call-site literal are gone from the bundle entirely,
    # and VS Code detection now flows through the generic editor table
    # (`{[VSCode]:{protocol:`vscode://`,name:`VS Code`}, …}`) consumed by the two
    # `.protocol` sites. That is an upstream dedup, NOT native Linux support:
    # both surviving sites still gate on Electron's macOS/Windows-only
    # getApplicationInfoForProtocol, so the shim stays load-bearing.
    if count1 != 4:
      echo &"  [FAIL] getApplicationInfoForProtocol shim: {count1} match(es), expected 4"
      raise newException(
        ValueError,
        "fix_open_in_editor_linux: getApplicationInfoForProtocol site count changed, re-audit",
      )
    echo &"  [OK] getApplicationInfoForProtocol shim (xdg-mime): {count1} call site(s) wrapped"

  # ── Patch 2: skip getFileIcon fallback on Linux in getInstalledEditors ─
  # The handler "path" we synthesize on Linux is a .desktop name, not a real file
  # path; calling `app.getFileIcon(<name>, {size:"normal"})` on it may throw and
  # trip the enclosing try/catch -> editor wrongly reported installed:false.
  # nim-regex (NFA) has no backreferences, so capture the icon-var uses separately
  # and verify they refer to the same identifier at runtime.
  #
  # Idempotency: our guarded form inserts `&&process.platform!=="linux"&&(` directly
  # before the `<var>=await <v>.app.getFileIcon(<n>.path,{size:"normal"})` assignment.
  # Positively assert that exact guarded shape (not a loose substring that other
  # Linux patches could also produce) before accepting "already patched".
  let guardedPat =
    re2"""&&process\.platform!=="linux"&&\([\w$]+=await [\w$]+(?:\.[\w$]+)*\.app\.getFileIcon\([\w$]+\.path,\{size:"normal"\}\)\)"""
  if result.findAll(guardedPat).len == 1:
    echo "  [OK] getFileIcon Linux guard: already present (skipped)"
  else:
    let pattern2 =
      re2"""\(!([\w$]+)\|\|([\w$]+)\.isEmpty\(\)\)&&\(([\w$]+)=await ([\w$]+(?:\.[\w$]+)*)\.app\.getFileIcon\(([\w$]+)\.path,\{size:["`]normal["`]\}\)\)"""
    var count2 = 0
    result = result.replace(
      pattern2,
      proc(m: RegexMatch2, s: string): string =
        let a1 = s[m.group(0)]
        let a2 = s[m.group(1)]
        let a3 = s[m.group(2)]
        let v = s[m.group(3)]
        let n = s[m.group(4)]
        if a1 != a2 or a1 != a3:
          return s[m.boundaries]
        inc count2
        "(!" & a1 & "||" & a1 & ".isEmpty())&&process.platform!==\"linux\"&&(" & a1 &
          "=await " & v & ".app.getFileIcon(" & n & ".path,{size:\"normal\"}))",
    )
    if count2 != 1:
      echo &"  [FAIL] getFileIcon Linux guard: {count2} matches (expected 1) and guarded form not found"
      raise newException(
        ValueError, "fix_open_in_editor_linux: getFileIcon fallback pattern not found"
      )
    echo &"  [OK] getFileIcon Linux guard: {count2} call site(s)"

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_open_in_editor_linux <path_to_index.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_open_in_editor_linux ==="
  echo &"  Target: {filePath}"
  if not fileExists(filePath):
    echo &"  [FAIL] File not found: {filePath}"
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] Open-in-editor patched for Linux (xdg-mime handler detection)"
  else:
    echo "  [PASS] Open-in-editor already patched for Linux"
