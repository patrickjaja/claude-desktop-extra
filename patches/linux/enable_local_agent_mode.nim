# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Enable Code and Cowork features on Linux.
#
# Two sub-patches:
#   3  async feature merger overrides (quietPenguin, louderPenguin, computerUse,
#      plus three inert safety nets - see the comment at the sub-patch)
#   4  preferences defaults (quietPenguinEnabled / louderPenguinEnabled)
#
# Retired 2026-09-23 (v2.7032.0, AGENTS.md Rule 4):
#   1  platform gate on the quietPenguin support function. The registry consumes
#      it as `quietPenguin:X(fn)` where `X(e){return app.isPackaged?
#      {status:"unavailable"}:e()}`, so the function is never called in a
#      packaged build; quietPenguin is delivered by sub-patch 3 alone.
#   1b yukonSilver guard and the anthropic-client-os-platform header guard:
#      assert-only, changed no bytes. Cowork support on Linux is upstream's
#      native determiner (linux -> "unix" VM-bundle key, gated on the KVM probe);
#      never force yukonSilver here.
#   2  chillingSlothLocal: printed [OK] with no check at all.
#   3's pre-v1.13 `const X=async()=>({...})` fallback: zero matches since.
#   The stale-input check for the removed navigator spoof marker
#   (`__nav_spoof_applied`) now lives in scripts/apply_patches.py
#   (STALE_INPUT_MARKERS), which refuses a pre-patched extract for every patch.
#
# (Sub-patches 3b-3p, the GrowthBook rollout-bypass forces, were RETIRED
# 2026-07-13: none of those flags is platform-gated, every read consults the
# feature store, and add_growthbook_overrides.nim gives users a supported
# one-line opt-in via claude-desktop-extra.jsonc growthbookOverrides. All
# retired IDs are listed in the .jsonc template for re-enabling. Patches
# 5/5b/6/8, the MSIX-era platform spoofs, were removed 2026-07-01 for issue
# #173: the official Linux .deb reports "linux" natively.)
#
# This patch targets index.js only.

import std/[os, strformat, strutils]
import regex

const EXPECTED_PATCHES = 2

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0

  # Patch 3: Override features in the async feature merger.
  #
  # IMPORTANT: do NOT force-override the Cowork VM capability features
  # (yukonSilver / yukonSilverGems / coworkKappa / coworkArtifacts) here. Those
  # are gated by upstream's NATIVE VM-capability probe (/dev/kvm, OVMF
  # firmware, qemu, virtiofsd and the bundled helper). Slamming yukonSilver to
  # "supported" would MASK a real unavailable state (KVM-less host, missing
  # firmware/qemu), so the UI would advertise Cowork and then fail at VM spawn
  # with a generic error instead of the honest "install QEMU / add to kvm
  # group" message.
  #
  # We override the features we genuinely provide the backend for on Linux.
  # Three of the six are LOAD-BEARING and three are inert safety nets
  # (re-verified v2.7032.0) - keep the distinction honest:
  #   quietPenguin   NEEDED  registry gives X(fn) -> unavailable when packaged
  #   louderPenguin  NEEDED  darwin/win32 + flag 4116586025 gated
  #   computerUse    NEEDED  tests a Set([darwin,win32]) -> Linux gets
  #                          {status:"unsupported"}; we ship the input +
  #                          screenshot backends, so we override it
  #   chillingSlothFeat  inert  already returns {status:"supported"}
  #   chillingSlothLocal inert  already returns {status:"supported"}
  #   ccdPlugins         inert  registry value is literally {status:"supported"}
  # The three inert keys are kept deliberately: they cost nothing, and they keep
  # working if upstream ever re-gates them.
  let overrides =
    ",quietPenguin:{status:\"supported\"},louderPenguin:{status:\"supported\"},chillingSlothFeat:{status:\"supported\"},chillingSlothLocal:{status:\"supported\"},ccdPlugins:{status:\"supported\"},computerUse:{status:\"supported\"}"

  # Idempotency: our overrides are a verbatim literal run, so their presence IS
  # the patched end-state (positive assertion, AGENTS.md Rule 6).
  let overridesCount = result.count(overrides)
  if overridesCount == 1:
    echo "  [OK] feature merger: overrides already present (idempotent)"
    inc patchesApplied
  elif overridesCount > 1:
    echo &"  [FAIL] feature merger: overrides present {overridesCount} times, expected 1"
    quit(1)
  else:
    # The async merger ends `return{...STATIC(),...LOCALS}}`: STATIC() is the
    # static feature registry, LOCALS the async-resolved overrides object. We
    # append our overrides LAST so they win over both. Match the merger
    # structurally, then VERIFY the match semantically: the spread callee must
    # be the static feature registry, i.e. its body lists `quietPenguin:`.
    let pattern3 = re2"return\{\.\.\.([\w$]+)\(\),\.\.\.[\w$]+\}\}"
    var m3Count = 0
    var m3End = -1
    var m3Callee = ""
    for m in result.findAll(pattern3):
      let callee = result[m.group(0)]
      let defIdx = strutils.find(result, "function " & callee & "(")
      if defIdx >= 0:
        let sliceEnd = min(defIdx + 4000, result.len - 1)
        if result[defIdx .. sliceEnd].contains("quietPenguin:"):
          inc m3Count
          m3End = m.boundaries.b
          m3Callee = callee
    if m3Count != 1:
      echo &"  [FAIL] feature merger: {m3Count} registry-verified matches, expected exactly 1"
      quit(1)
    # Insert immediately before the merger's closing "}}".
    let insertPos = m3End - 1
    result = result[0 ..< insertPos] & overrides & result[insertPos .. ^1]
    echo &"  [OK] feature merger via {m3Callee}(): 6 features overridden (1 match)"
    inc patchesApplied

  # Patch 4: Change preferences defaults for Code features.
  #
  # CAVEAT (upstream behaviour, not ours): the preferences reader carries a
  # one-shot kill-switch for this key: if `louderPenguinEnabled` is ever
  # PERSISTED as true, upstream writes it back to false and latches it off for
  # the rest of the session. Our default only survives while the key is ABSENT
  # from the store - which is exactly why this patch changes the DEFAULT rather
  # than writing the preference. Never tell a user to "switch it on in
  # Settings" - doing so persists the key and thereby disables the feature.
  let pattern4Old = "quietPenguinEnabled:!1,louderPenguinEnabled:!1"
  let pattern4New = "quietPenguinEnabled:!0,louderPenguinEnabled:!0"
  let count4Old = result.count(pattern4Old)
  let count4New = result.count(pattern4New)
  if count4Old == 1 and count4New == 0:
    result = result.replace(pattern4Old, pattern4New)
    echo "  [OK] Preferences defaults: quietPenguinEnabled + louderPenguinEnabled -> true (1 match)"
    inc patchesApplied
  elif count4Old == 0 and count4New == 1:
    echo "  [OK] Preferences defaults: already true (idempotent)"
    inc patchesApplied
  else:
    echo &"  [FAIL] Preferences defaults: {count4Old} default-off and {count4New} default-on sites, expected exactly one of them once"
    quit(1)

  if patchesApplied != EXPECTED_PATCHES:
    echo &"  [FAIL] Only {patchesApplied}/{EXPECTED_PATCHES} patches applied"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: enable_local_agent_mode <path_to_index.js>"
    quit(1)

  let filePath = paramStr(1)
  echo "=== Patch: enable_local_agent_mode ==="
  echo "  Target: " & filePath

  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)

  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
  echo &"  [PASS] {EXPECTED_PATCHES}/{EXPECTED_PATCHES} patches applied"
