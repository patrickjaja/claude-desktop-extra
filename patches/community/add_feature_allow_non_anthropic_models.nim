# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Let a third-party gateway's non-Anthropic models through, opt-in (default OFF):
# `allowNonAnthropicModels` in claude-desktop-extra.json(c), switched from
# Settings -> Extra -> Community Features -> Inference.
#
# Upstream (Anthropic's own bundle) checks 3P model IDs by NAME: a denylist of
# non-Anthropic families (deepseek, qwen, glm, kimi/moonshot, gpt-oss, ...) plus
# an Anthropic-family allowlist. On a gateway, a route whose ID is neither is
# dropped. There is no single choke point; the gateway path checks the name in
# three places, and this patch guards exactly those three:
#
#   B. `HCe`, the gateway/mantle branch of the per-provider validator `Zo`.
#      Everything that goes through `Zo` for a gateway therefore accepts the
#      route: the config-load model-list filter (`gNe`, "... is not an
#      Anthropic model and was removed from the list"), the single-value
#      validator (`vNe`), the picker filter (`jfn`) and the runtime
#      `validateSessionModel` fallthrough.
#   C. Gateway `/v1/models` discovery (`_0t`, used when `inferenceModels` is
#      not set): a discovered row whose ID fails the check and carries no
#      `anthropic_family_tier` is dropped before it reaches the picker.
#   D. The `[custom-3p]` tier-pin sanitizer (`p9t`): on the gateway branch it
#      ignores a pinned value that matches the non-Anthropic denylist ("value
#      matches a known non-Anthropic model fragment") without going through
#      `Zo`.
#   E. The Setup window (Developer -> Configure Third-Party Inference) is the
#      ion-dist SPA and validates its Model list in the RENDERER with the SPA's
#      own copy of the check; add_feature_allow_non_anthropic_models_ion.nim
#      guards that copy. This sub-patch only hands it the switch: with the
#      switch on, the window's `--desktop-features` additionalArguments JSON
#      gains `cdbAllowNonAnthropicModels:{status:"supported"}`, which upstream's
#      preload exposes as `window.desktopBootFeatures` before any page script
#      runs (synchronous, no race). Off -> the stock value.
#
# Not touched: the 1P anthropic / bedrock / vertex / foundry validators, Bedrock
# discovery, the grouping helper `e0t` (it only groups, it does not filter), the
# HIPAA (`model_restricted`), admin allowlist (`not_in_allowed_models`) and
# app-catalog (`desktop_update_required`) gates, and index.pre.js's early copy
# of the config read (its filtered list stays inside pre.js and only produces
# main.log warnings; the chunk re-reads the config itself).
#
# Each guard is `(globalThis.__cdbAllowNonAnthropicModels&&globalThis.__cdbAllowNonAnthropicModels())`
# preceded by a per-site comment marker, so every site's end-state is counted
# on its own and a half-patched bundle is detected exactly:
#   B. return /*cdb-mb:validator*/GUARD||Xo(e)?{ok:!0}:{ok:!1,...}
#      (`||` binds tighter than `?:`: a true guard accepts, else stock.)
#   C. return!(/*cdb-mb:discovery*/GUARD||Xo(t.id))&&!n?[]:[{...}]
#      (true guard -> `!(true)` = false -> the row is kept; false guard ->
#      `!(Xo(t.id))`, which is the stock `!Xo(t.id)`.)
#   D. if(!/*cdb-mb:tier-pin*/GUARD&&PCe(r)&&!FCe(r)){P.warn(...);return}
#      (true guard skips the ignore branch and the value is returned.)
#   E. `--desktop-features=${JSON.stringify(/*cdb-mb:setup-window*/(GUARD?{...DH(),cdbAllowNonAnthropicModels:{status:"supported"}}:DH()))}`
#
#   A. js/allow_non_anthropic_models.js injected at the head of the staged
#      bundle: the pref reader (jsonc > json), the memoized global
#      `__cdbAllowNonAnthropicModels()`, and the `cdb-mb:pref-read`/`:pref-set`
#      IPC handlers behind the same origin guard the other Extra rows use. The
#      stub's `require("./index.chunk-...")` runs after it, and B-E only run
#      when their functions are called (config load and later), so the global
#      exists first. Each guard also tests the global before calling it, so a
#      missing module degrades to stock behavior instead of throwing.
#
# Break risk: LOW for A (head anchor: after "use strict"; when present, else
# prepended). B-E are each pinned by an upstream string next to the
# check (the gateway validator's reason, the "Gateway /v1/models returned an
# unexpected body." message, the "known non-Anthropic model fragment" warning,
# the Setup window's "Configure Third-Party Inference" title)
# with every identifier a wildcard, so a re-minify re-fits and a reorder fails
# loud (match count != 1).

import std/[os, strformat, strutils]
import regex

const MODULE_JS = staticRead("../../js/allow_non_anthropic_models.js")

const MARKER = "__CDB_ALLOW_NONANTHROPIC__"
const GUARD =
  "(globalThis.__cdbAllowNonAnthropicModels&&globalThis.__cdbAllowNonAnthropicModels())"
const MARK_B = "/*cdb-mb:validator*/"
const MARK_C = "/*cdb-mb:discovery*/"
const MARK_D = "/*cdb-mb:tier-pin*/"
const MARK_E = "/*cdb-mb:setup-window*/"
const ION_FLAG = "cdbAllowNonAnthropicModels:{status:\"supported\"}"
const EXPECTED_PATCHES = 5
  # A module, B validator, C discovery, D tier pin, E setup-window signal
const GUARD_SITES = 4 # B, C, D, E

proc endState(s: string): array[5, int] =
  [
    s.count(MARKER),
    s.count(MARK_B & GUARD),
    s.count(MARK_C & GUARD),
    s.count(MARK_D & GUARD),
    s.count(MARK_E & "(" & GUARD & "?{..."),
  ]

proc apply*(input: string): string =
  result = input

  # Idempotency: positive end-state assertion - our module and each of the four
  # guards (by its own site marker) must be present exactly once, and the guard
  # text must appear nowhere else (AGENTS.md Rule 6).
  let have = endState(result)
  let guardTotal = result.count(GUARD)
  if have == [1, 1, 1, 1, 1] and guardTotal == GUARD_SITES and
      result.count(ION_FLAG) == 1:
    echo "  [OK] allow-non-anthropic-models: module and all 4 guards already present (idempotent)"
    return
  if have != [0, 0, 0, 0, 0] or guardTotal != 0 or result.count(ION_FLAG) != 0:
    echo &"  [FAIL] allow-non-anthropic-models: half-patched bundle (module x{have[0]}, validator x{have[1]}, discovery x{have[2]}, tier-pin x{have[3]}, setup-window x{have[4]}, guard text x{guardTotal}) - re-audit"
    quit(1)

  # Sub-patches B, C, D, E first, so the module text injected by A is never searched.

  # B. gateway/mantle validator (`HCe`), pinned by its reason string.
  var n = 0
  result = result.replace(
    re2"""(function [\w$]+\([\w$]+\)[{]return )([\w$]+\([\w$]+\))(\?[{]ok:!0[}]:[{]ok:!1,reason:"expected a gateway model route)""",
    proc(m: RegexMatch2, s: string): string =
      inc n
      s[m.group(0)] & MARK_B & GUARD & "||" & s[m.group(1)] & s[m.group(2)],
  )
  if n != 1:
    echo &"  [FAIL] allow-non-anthropic-models: B gateway validator matched {n}/1 - re-audit"
    quit(1)
  echo "  [OK] B gateway model validator: guard added"

  # C. gateway /v1/models discovery row filter, pinned to the gateway function
  # by its "unexpected body" message a few dozen bytes before the flatMap.
  n = 0
  result = result.replace(
    re2"""(Gateway /v1/models returned an unexpected body\..{0,100}?.{0,100}?.{0,100}?\.data\.flatMap\(\([\w$]+=>[{]let [\w$]+=[\w$]+\?[\w$]+\([\w$]+\.id\):void 0;if\(![\w$]+\|\|![\w$]+\)return\[\];let [\w$]+=[\w$]+\([\w$]+\.anthropic_family_tier\);return)!([\w$]+\([\w$]+\.id\))(&&![\w$]+\?\[\]:\[)""",
    proc(m: RegexMatch2, s: string): string =
      inc n
      s[m.group(0)] & "!(" & MARK_C & GUARD & "||" & s[m.group(1)] & ")" & s[m.group(2)],
  )
  if n != 1:
    echo &"  [FAIL] allow-non-anthropic-models: C gateway /v1/models discovery filter matched {n}/1 - re-audit"
    quit(1)
  echo "  [OK] C gateway /v1/models discovery: guard added"

  # D. [custom-3p] tier-pin sanitizer, gateway branch, pinned by its warning.
  n = 0
  result = result.replace(
    re2"""(if\(![\w$]+\)[{]if\()([\w$]+\([\w$]+\)&&![\w$]+\([\w$]+\)\)[{][\w$]+\.warn\(["`]\[custom-3p\] \$[{][\w$]+[}]: value matches a known non-Anthropic model fragment; ignoring\.)""",
    proc(m: RegexMatch2, s: string): string =
      inc n
      s[m.group(0)] & "!" & MARK_D & GUARD & "&&" & s[m.group(1)],
  )
  if n != 1:
    echo &"  [FAIL] allow-non-anthropic-models: D tier-pin sanitizer matched {n}/1 - re-audit"
    quit(1)
  echo "  [OK] D [custom-3p] tier-pin sanitizer: guard added"

  # E. setup-window signal for the ion-dist half
  # (add_feature_allow_non_anthropic_models_ion.nim). The Setup window
  # (Developer -> Configure Third-Party Inference) validates its Model list in
  # the renderer with the SPA's own copy of the gateway check. Upstream hands
  # the window `--desktop-features=<JSON>` via additionalArguments; its preload
  # (mainView.js) exposes that JSON as `window.desktopBootFeatures` before any
  # page script runs. With the switch on, add our key to that JSON for this
  # window only; off -> the stock `JSON.stringify(DH())` value. Pinned by the
  # window's title string.
  n = 0
  result = result.replace(
    re2"""(defaultMessage:["`]Configure Third-Party Inference\\u2026["`],id:["`][^"`]{1,40}["`][}]\),webPreferences:[{]preload:[^{}]{0,100}?mainView\.js["`]\),additionalArguments:\[`--desktop-features=\$[{]JSON\.stringify\()([\w$]+\(\))(\)[}]`\][}])""",
    proc(m: RegexMatch2, s: string): string =
      inc n
      let feats = s[m.group(1)]
      s[m.group(0)] & MARK_E & "(" & GUARD & "?{..." & feats & "," & ION_FLAG & "}:" &
        feats & ")" & s[m.group(2)],
  )
  if n != 1:
    echo &"  [FAIL] allow-non-anthropic-models: E setup-window --desktop-features matched {n}/1 - re-audit"
    quit(1)
  echo "  [OK] E setup-window --desktop-features: switch signal added"

  # A. inject at the head, after a leading "use strict"; when one is present
  # (directive prologues only work in first-statement position), else prepend.
  # Basename order puts this patch before add_growthbook_overrides, so on a
  # pristine stage the directive is usually still there; when an earlier patch
  # has already displaced it, the prepend is the normal case, not an error.
  # Same shape as add_feature_theme_picker.
  let strictPrefix = "\"use strict\";"
  if result.startsWith(strictPrefix):
    result = strictPrefix & MODULE_JS & "\n;\n" & result[strictPrefix.len .. ^1]
    echo "  [OK] A allow-non-anthropic-models module injected after \"use strict\""
  else:
    result = MODULE_JS & "\n;\n" & result
    echo "  [OK] A allow-non-anthropic-models module prepended"

  let after = endState(result)
  var applied = 0
  for c in after:
    if c == 1:
      inc applied
  if applied < EXPECTED_PATCHES or result.count(GUARD) != GUARD_SITES or
      result.count(ION_FLAG) != 1:
    echo &"  [FAIL] Only {applied}/{EXPECTED_PATCHES} allow-non-anthropic-models parts present exactly once after patching (guard text x{result.count(GUARD)}, want {GUARD_SITES})"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_feature_allow_non_anthropic_models <path_to_index.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: add_feature_allow_non_anthropic_models ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo &"  [PASS] allow non-Anthropic models applied ({EXPECTED_PATCHES}/{EXPECTED_PATCHES} parts)"
  else:
    if endState(output) != [1, 1, 1, 1, 1]:
      echo "  [FAIL] No changes made and the patched end-state is absent"
      quit(1)
    echo "  [OK] Already applied (no changes needed)"
