# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Make the Cowork VM capability probe find OVMF firmware + virtiofsd on the
# distros Anthropic's official Debian .deb does not target (Arch, Fedora/RHEL,
# openSUSE, NixOS, ...).
#
# The official build hard-codes DEBIAN-ONLY firmware paths. The capability probe
# builds {qemuPath, firmwarePath, virtiofsdPath, ...} and the support determiner
# returns "unsupported" (reason: "Cowork requires QEMU...") whenever ANY of them
# is null. On Arch, edk2-ovmf installs OVMF to /usr/share/edk2/x64/OVMF_CODE.4m.fd,
# NOT the Debian /usr/share/OVMF/OVMF_CODE_4M.fd, so firmwarePath resolves to null
# and Cowork is permanently "unsupported" -> the Download button is inert and the
# workspace never provisions. (virtiofsd does NOT resolve everywhere either: the
# bundled resources/virtiofsd only counts on Ubuntu 22.x - see below.)
#
# qemuPath (sub-patch D): up to 3.6556.2 the probe walked $PATH for
# qemu-system-<arch>. From 4.29.0 it only checks the fixed Debian path
#   GUn = process.arch==="arm64" ? "/usr/bin/qemu-system-aarch64"
#                                : "/usr/bin/qemu-system-x86_64"
#   ... QUn([GUn], a.constants.X_OK) ...   -> qemuPath
# and hands the resolved absolute path to cowork-linux-helper, which execs it.
# A QEMU anywhere else (RHEL's qemu-kvm via our rpm qemu-shim, NixOS ${qemu}/bin,
# /usr/local/bin) made Cowork "unsupported" again. D rewrites the candidate list
# to: CLAUDE_QEMU_PATH (absolute only), then upstream's /usr/bin path, then
# <dir>/qemu-system-<arch> for every dir of the TOOL PATH (the old X_OK walk;
# the TOOL PATH is the narrowed PATH plus the root-owned read-only dirs of the
# PATH the app was started with - see add_tool_path_resolver.nim - or
# process.env.PATH when upstream does not narrow it).
# Upstream's own path stays ahead of $PATH, so Debian/Ubuntu/Fedora/Arch resolve
# exactly as upstream does. The helper's main.validateQEMUPath rejects a path
# containing ',' or '=' (QEMU option separators), so PATH-derived candidates
# with those characters are skipped; an explicit override is passed through so
# a bad one surfaces the helper's own error.
#
# On top of the extra fixed paths, we prepend ENV-VAR overrides to both arrays
# (issue #177, NixOS): NixOS has no /usr/share firmware or /usr/libexec, so fixed
# paths can never cover it. The probe honors:
#   CLAUDE_OVMF_CODE_PATH  - path to an OVMF/AAVMF *CODE* firmware image. The
#     matching VARS file must sit next to it with the same name shape (the app
#     derives it via replace("OVMF_CODE","OVMF_VARS")/("AAVMF_CODE","AAVMF_VARS")).
#   CLAUDE_VIRTIOFSD_PATH  - path to a system virtiofsd binary.
# The Nix package wraps these via `.override { OVMF = ...; virtiofsd = ...; }`.
# Injected as conditional array spreads (`...(env?[env]:[])`), so behavior is
# byte-for-byte identical when the vars are unset.
#
# Upstream code (minified var names change every release):
#   boi = process.arch==="arm64"
#           ? ["/usr/share/AAVMF/AAVMF_CODE.fd"]
#           : ["/usr/share/OVMF/OVMF_CODE_4M.fd","/usr/share/OVMF/OVMF_CODE.fd"],
#   Loi = ["/usr/libexec/virtiofsd","/usr/bin/virtiofsd"]
#
# v1.26832.0 kept this shape verbatim but the new minifier emits every string as
# a backtick template literal (OT=process.arch===`arm64`?[`/usr/share/AAVMF/...`]
# :[...], kT=[`/usr/libexec/virtiofsd`,`/usr/bin/virtiofsd`]). Still Debian-only:
# no /usr/share/edk2 candidate exists anywhere in the bundle, so nothing here is
# upstreamed. All three anchors accept either quoting now; the values we splice
# in stay double-quoted (valid JS either way, and it keeps the already-patched
# detection below a plain substring check).
#
# The firmware resolver i_t(boi) returns the FIRST readable path, and the _VARS
# companion is derived by s.replace("OVMF_CODE","OVMF_VARS") / ("AAVMF_CODE",
# "AAVMF_VARS"), so every CODE path we add must have a matching VARS file with the
# same name shape next to it (true for the distro paths below).
#
# We extend BOTH arrays with distro-portable candidates. Order does not matter for
# correctness (resolver takes the first that exists) but Debian paths are kept
# FIRST so behaviour on Debian/Ubuntu is byte-for-byte unchanged.

import std/[os, strutils]
import regex

proc apply*(input: string): string =
  result = input

  # Additional x86_64 OVMF_CODE candidates for non-Debian distros.
  # The app derives the VARS path by A.replace("OVMF_CODE","OVMF_VARS"), so a
  # candidate is only usable if (a) the CODE file exists on that distro AND
  # (b) a sibling file with "OVMF_CODE" -> "OVMF_VARS" in its name also exists.
  # Every path below satisfies both (verified: Arch live box; Fedora/RHEL via
  # edk2-ovmf package file-list). Distros whose firmware is named "*-code.bin"
  # (openSUSE: /usr/share/qemu/ovmf-x86_64-code.bin) or "edk2-x86_64-code.fd"
  # (generic qemu symlinks) are deliberately NOT added: the OVMF_CODE->OVMF_VARS
  # replace would not yield their real VARS filename, so they'd resolve as
  # firmwarePath but fail later at VARS lookup. Covering them needs a separate
  # "-code"->"-vars" rule; tracked as a known gap, not added here.
  const extraX64 =
    "\"/usr/share/edk2/ovmf/OVMF_CODE.fd\"," &
      # Fedora 40+/RHEL 9+ (edk2-ovmf; VARS: OVMF_VARS.fd)
    "\"/usr/share/edk2/x64/OVMF_CODE.4m.fd\"," &
      # Arch (edk2-ovmf; VARS: OVMF_VARS.4m.fd)
    "\"/usr/share/edk2/x64/OVMF_CODE.fd\"," # Arch alt/older name if present

  # aarch64 needs NO additions: the Debian path the app already checks,
  # /usr/share/AAVMF/AAVMF_CODE.fd (+ AAVMF_VARS.fd), is ALSO the canonical
  # path on Fedora/RHEL (edk2-aarch64) and Arch (edk2-aarch64). Only openSUSE
  # differs (aavmf-aarch64-code.bin), which has the same "-code.bin" VARS-replace
  # problem as its x86_64 firmware and is left as the same known gap.

  # Additional virtiofsd system-path candidates. The app checks
  # /usr/libexec/virtiofsd (Fedora/RHEL/openSUSE) and /usr/bin/virtiofsd. NOTE
  # (verified v1.17377.1): the BUNDLED resources/virtiofsd is only used as a
  # fallback on Ubuntu 22.x (`os-release id==="ubuntu" && versionId.startsWith
  # ("22.")`), where apt has no standalone Rust virtiofsd - on every other
  # distro a missing system virtiofsd means "unsupported". So a system virtiofsd
  # (our optdepends/Recommends) is REQUIRED outside Ubuntu 22.04, and we add
  # Arch's /usr/lib/virtiofsd so the probe finds it there.
  #
  # NixOS (issue #177): there is no FHS /usr/lib or /usr/bin at all, so NONE of
  # the candidates above ever exist - a system `virtiofsd` package only lands
  # at /run/current-system/sw/bin/virtiofsd (the systemPackages profile bin
  # dir) or a Nix store path (unstable, can't be hardcoded). We add the former
  # so NixOS users who put `pkgs.virtiofsd` in environment.systemPackages
  # resolve, same pattern as Arch's /usr/lib/virtiofsd.
  const extraVirtiofsd =
    "\"/usr/lib/virtiofsd\"," & # Arch (virtiofsd pkg)
    "\"/usr/lib/qemu/virtiofsd\"," & # some distros
    "\"/run/current-system/sw/bin/virtiofsd\"," # NixOS (environment.systemPackages)

  # Env-var override candidates, prepended so an explicit override always wins.
  # Conditional spread = no-op when the env var is unset.
  const envFirmware =
    "...(process.env.CLAUDE_OVMF_CODE_PATH?[process.env.CLAUDE_OVMF_CODE_PATH]:[]),"
  const envVirtiofsd =
    "...(process.env.CLAUDE_VIRTIOFSD_PATH?[process.env.CLAUDE_VIRTIOFSD_PATH]:[]),"

  var patchesApplied = 0
  const EXPECTED_PATCHES = 4
    # A: x64 firmware array, B: virtiofsd array, C: arm64 firmware array,
    # D: qemu-system candidates (env override + upstream path + TOOL PATH walk)

  # --- Patch A: extend the x86_64 OVMF firmware array ------------------------
  # Only the x86_64 (OVMF) array needs extending; the aarch64 (AAVMF) array's
  # single Debian path is already correct on every distro we support (see above).
  # We anchor on the x64 array open `["` immediately followed by the first Debian
  # value, and splice our fully-quoted candidates in right after the `[`.
  # Anchoring on `]:[` (the ternary's arm-array close + x64-array open) makes the
  # match unambiguous even though "/usr/share/OVMF/OVMF_CODE_4M.fd" is short.
  # group0 = `]:[`   group1 = `"/usr/share/OVMF/OVMF_CODE_4M.fd"`  (x64 first value)
  let firmwarePattern = re2"""(\]:\[)(["`]/usr/share/OVMF/OVMF_CODE_4M\.fd["`])"""
  var countA = 0
  let alreadyFirmware =
    "/usr/share/edk2/x64/OVMF_CODE.4m.fd" in result and envFirmware & extraX64 in result
  if alreadyFirmware:
    echo "  [OK] firmware paths: env override + non-Debian OVMF candidates already present"
    inc patchesApplied
  else:
    result = result.replace(
      firmwarePattern,
      proc(m: RegexMatch2, s: string): string =
        inc countA
        s[m.group(0)] & envFirmware & extraX64 & s[m.group(1)],
    )
    if countA == 1:
      echo "  [OK] firmware paths: injected env override + non-Debian OVMF candidates"
      inc patchesApplied
    else:
      echo "  [FAIL] firmware paths: expected 1 match, got " & $countA &
        " (upstream OVMF array shape changed - re-anchor)"

  # --- Patch B: extend the virtiofsd system-path array -----------------------
  # group0 = `[`  group1 = `"/usr/libexec/virtiofsd",`  group2 = `"/usr/bin/virtiofsd"`
  # Env override goes FIRST (before the system paths), extras keep their old
  # position between the two Debian candidates.
  let virtiofsdPattern =
    re2"""(\[)(["`]/usr/libexec/virtiofsd["`],)(["`]/usr/bin/virtiofsd["`])"""
  var countB = 0
  # Quote-agnostic already-check: our env spread must sit immediately before the
  # (upstream-quoted, backticks since v1.26832.0) first Debian candidate.
  let virtiofsdInjected =
    re2"""\.\.\.\(process\.env\.CLAUDE_VIRTIOFSD_PATH\?\[process\.env\.CLAUDE_VIRTIOFSD_PATH\]:\[\]\),["`]/usr/libexec/virtiofsd"""
  let alreadyVirtiofsd =
    "/usr/lib/virtiofsd" in result and result.contains(virtiofsdInjected)
  if alreadyVirtiofsd:
    echo "  [OK] virtiofsd paths: env override + non-Debian candidate already present"
    inc patchesApplied
  else:
    result = result.replace(
      virtiofsdPattern,
      proc(m: RegexMatch2, s: string): string =
        inc countB
        s[m.group(0)] & envVirtiofsd & s[m.group(1)] & extraVirtiofsd & s[m.group(2)],
    )
    if countB == 1:
      echo "  [OK] virtiofsd paths: injected env override + non-Debian candidate"
      inc patchesApplied
    else:
      echo "  [FAIL] virtiofsd paths: expected 1 match, got " & $countB &
        " (upstream virtiofsd array shape changed - re-anchor)"

  # --- Patch C: env override for the arm64 AAVMF firmware array --------------
  # The arm64 arm needs no extra fixed paths (see above), but the env override
  # must reach it too. group0 = `?[`  group1 = `"/usr/share/AAVMF/AAVMF_CODE.fd"`
  let aavmfPattern = re2"""(\?\[)(["`]/usr/share/AAVMF/AAVMF_CODE\.fd["`])"""
  var countC = 0
  let aavmfInjected =
    re2"""\.\.\.\(process\.env\.CLAUDE_OVMF_CODE_PATH\?\[process\.env\.CLAUDE_OVMF_CODE_PATH\]:\[\]\),["`]/usr/share/AAVMF/AAVMF_CODE\.fd"""
  let alreadyAavmf = result.contains(aavmfInjected)
  if alreadyAavmf:
    echo "  [OK] arm64 firmware: env override already present"
    inc patchesApplied
  else:
    result = result.replace(
      aavmfPattern,
      proc(m: RegexMatch2, s: string): string =
        inc countC
        s[m.group(0)] & envFirmware & s[m.group(1)],
    )
    if countC == 1:
      echo "  [OK] arm64 firmware: injected env override"
      inc patchesApplied
    else:
      echo "  [FAIL] arm64 firmware: expected 1 match, got " & $countC &
        " (upstream AAVMF array shape changed - re-anchor)"

  # --- Patch D: qemuPath candidates ------------------------------------------
  # 4.29.0 probes only upstream's fixed /usr/bin/qemu-system-<arch> (see header).
  # We wrap the single-element candidate array of that one probe call in a
  # self-contained named function expression: no module, require() or minified
  # name of upstream is referenced, only process.env and string ops, so it works
  # in whichever chunk the probe lands in. The function name is the idempotency
  # marker. Upstream's access check (QUn, X_OK, first hit wins) is reused as is.
  #   (1) the arch constant definition, captured to learn its minified name:
  #       GUn=process.arch==="arm64"?"/usr/bin/qemu-system-aarch64":"/usr/bin/qemu-system-x86_64"
  #   (2) the probe call: QUn([GUn],a.constants.X_OK)
  #       -> QUn((function __cdbQemuCandidates(q){...})(GUn),a.constants.X_OK)
  # Requires the 4.29.0 shape: 3.6556.2 has no /usr/bin constant (it walked
  # $PATH itself) and fails here; we only build >= 4.29.0.
  #
  # The dirs walked come from the shared resolver (globalThis.__cdbToolPath,
  # patches/core/add_tool_path_resolver.nim): since 4.23118 upstream narrows
  # process.env.PATH to fixed system dirs, which drops the rpm's qemu-shim dir
  # the launcher appends on RHEL 9 and every other root-managed dir. toolPath()
  # is the narrowed dirs plus the started-PATH dirs that pass upstream's trust
  # rule (root-owned, not writable, along every hop): the shim dir and Nix
  # store dirs pass, ~/.local/bin does not, so a user-writable copy is never
  # handed to the helper. which(b) is called for its diagnostics only (one line
  # when the shim or another trusted dir is taken, one when a user-writable copy
  # is ignored). Without the resolver, or when it throws (any error is caught:
  # the Cowork probe must never break on it): process.env.PATH, as before.
  const qemuCandidatesFn =
    "(function __cdbQemuCandidates(q){" &
    "let b=q.slice(q.lastIndexOf(\"/\")+1),o=process.env.CLAUDE_QEMU_PATH," &
    "t=globalThis.__cdbToolPath,s;" &
    "try{s=t?t.toolPath():void 0;t&&t.which(b)}catch(e){s=void 0}" &
    "let p=((typeof s===\"string\"?s:process.env.PATH)??\"\").split(\":\").filter(d=>d.startsWith(\"/\"))" &
    ".map(d=>d.replace(/\\/+$/,\"\")+\"/\"+b).filter(c=>!/[,=]/.test(c));" &
    "return[...(o&&o.startsWith(\"/\")?[o]:[]),q,...p]})"
  let qemuDefPattern =
    re2"""([\w$]+)=process\.arch===["`]arm64["`]\?["`]/usr/bin/qemu-system-aarch64["`]:["`]/usr/bin/qemu-system-x86_64["`]"""
  var qemuVars: seq[string] = @[]
  for m in result.findAll(qemuDefPattern):
    qemuVars.add(result[m.group(0)])
  if qemuVars.len != 1:
    echo "  [FAIL] qemu candidates: expected 1 /usr/bin/qemu-system-<arch> constant, got " &
      $qemuVars.len & " (upstream qemu probe shape changed - re-anchor)"
  else:
    let qv = escapeRe(qemuVars[0])
    let qemuInjected = re2(
      "[\\w$]+\\(" & escapeRe(qemuCandidatesFn) & "\\(" & qv &
        "\\),[\\w$]+\\.constants\\.X_OK\\)"
    )
    if result.contains(qemuInjected):
      echo "  [OK] qemu candidates: env override + TOOL PATH fallback already present"
      inc patchesApplied
    else:
      let qemuCallPattern =
        re2("([\\w$]+)\\(\\[" & qv & "\\],([\\w$]+)\\.constants\\.X_OK\\)")
      var countD = 0
      result = result.replace(
        qemuCallPattern,
        proc(m: RegexMatch2, s: string): string =
          inc countD
          s[m.group(0)] & "(" & qemuCandidatesFn & "(" & qemuVars[0] & ")," &
            s[m.group(1)] & ".constants.X_OK)",
      )
      if countD == 1:
        echo "  [OK] qemu candidates: injected CLAUDE_QEMU_PATH override + TOOL PATH fallback"
        inc patchesApplied
      else:
        echo "  [FAIL] qemu candidates: expected 1 probe call on " & qemuVars[0] &
          ", got " & $countD & " (upstream qemu probe call changed - re-anchor)"

  if patchesApplied < EXPECTED_PATCHES:
    echo "  [FAIL] Only " & $patchesApplied & "/" & $EXPECTED_PATCHES &
      " patches applied"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_cowork_firmware_paths_linux <path_to_index.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_cowork_firmware_paths_linux ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] All required patterns matched and applied"
  else:
    echo "  [OK] No changes made (already patched)"
