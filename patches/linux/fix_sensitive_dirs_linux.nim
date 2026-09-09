# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Add Linux-specific sensitive directories to the protected path list.
#
# The upstream JS defines a sensitive-directories array (used to block
# sandbox mounts that overlap credential stores). It includes cross-platform
# entries (.ssh, .aws, .gnupg, ...) and platform-specific entries for macOS
# (Library/Keychains, ...) and Windows (AppData/Roaming/...), but has NO
# Linux-specific entries.
#
# This patch appends a Linux block that protects:
#   - .local/share/keyrings  (GNOME Keyring / KDE Wallet credential files)
#   - .pki                   (NSS/Chrome certificate database)
#   - .config/autostart       (XDG autostart .desktop entries)
#
# Entries carry upstream's {sub,family,tier} shape (since v1.49585.0).

import std/[os, strformat, strutils]
import regex

const EXPECTED_PATCHES = 1

const LINUX_DIRS_SPREAD =
  """,...process.platform==="linux"?[{sub:".local/share/keyrings",family:"credential_dir",tier:"B"},{sub:".pki",family:"credential_dir",tier:"B"},{sub:".config/autostart",family:"credential_dir",tier:"B"}]:[]"""

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0

  # Already-patched detection: positive end-state, our Linux entries are present
  if """sub:".local/share/keyrings",family:"credential_dir"""" in result:
    echo "  [INFO] Linux sensitive dirs already injected"
    patchesApplied += 1
  else:
    # Strategy (v1.49585.0+): the protected-subpath list is a tiered object
    # array consumed by the protectedSubpaths builder:
    #
    #   <var>=[{sub:".ssh",family:"credential_dir",tier:"B"},
    #          {sub:".aws",family:"credential_dir",tier:"B"}, ...,
    #          {sub:".claude",family:"claude_config_dir",tier:"A"},
    #          {sub:".config/gcloud",...},{sub:".config/gh",...}].filter(e=><const>),
    #   <subs>=<var>.map(e=>e.sub),
    #   <psh>=[".config/powershell"];
    #
    # and later: for(let{sub:e,family:t,tier:n}of <var>)r.push(await o(e,t,n,"dir"))
    #
    # Each entry needs sub + family + tier, so we inject full entry objects (the
    # family/tier vocabulary is upstream's: "credential_dir" / tier "B" is what
    # the sibling credential stores use). We anchor on the array OPENING plus
    # the first entry (`[{sub:".ssh",family:"credential_dir",tier:"B"}`) and
    # spread our Linux entries right after it, so the patch does not depend on
    # which entry upstream lists last. EXPECT EXACTLY ONE match.
    #
    # History: up to v1.46388.2 this was a flat string array ending with a
    # win32 block (`..."PowerShell")]:[]];`), which we anchored on. In
    # v1.49585.0 upstream dropped the darwin/win32 blocks from this list
    # entirely and switched to the tiered shape above.
    let pattern =
      re2"""(\[\{sub:[""`]\.ssh[""`],family:[""`]credential_dir[""`],tier:[""`]B[""`]\})"""

    var count = 0
    result = result.replace(
      pattern,
      proc(m: RegexMatch2, s: string): string =
        inc count
        # Reconstruct: array open + first entry, then our Linux spread
        s[m.group(0)] & LINUX_DIRS_SPREAD,
    )
    if count == 1:
      echo &"  [OK] Linux sensitive dirs injected: {count} match(es)"
      patchesApplied += 1
    elif count == 0:
      echo "  [FAIL] Could not find the tiered sensitive-dirs array opening"
      echo "  [HINT] Search for 'sub:\".ssh\",family:' in the target file"
    else:
      echo &"  [FAIL] Expected exactly 1 sensitive-dirs match, got {count} - anchor now matches an unintended array; re-audit"

  if patchesApplied < EXPECTED_PATCHES:
    echo &"  [FAIL] Only {patchesApplied}/{EXPECTED_PATCHES} patches applied"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_sensitive_dirs_linux <file>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_sensitive_dirs_linux ==="
  echo &"  Target: {filePath}"
  if not fileExists(filePath):
    echo &"  [FAIL] File not found: {filePath}"
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] Linux sensitive dirs patched successfully"
  else:
    echo "  [PASS] No changes needed (already patched)"
