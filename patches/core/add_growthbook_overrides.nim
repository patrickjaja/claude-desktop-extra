# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Local GrowthBook feature-flag overrides via <userData>/claude-desktop-extra.json.
#
# GrowthBook flags are served by Anthropic (/api/desktop/features) with no local
# override layer (the fcache disk cache is safeStorage-encrypted). This patch adds
# one: every load path (network fetch, disk cache, deployment-mode hardcoded set)
# funnels through a single features-store setter; we hook its head so a user's
# claude-desktop-extra.json (JSONC - comments allowed; auto-created template on
# first run) is merged over the freshly loaded map. Overrides are applied on a
# shallow copy, so the caller's raw payload (which feeds the disk cache) stays
# untouched. Layering: user override > server rollout.
#
# NOTE: flags that our patches force at the call site (enable_local_agent_mode
# etc. rewrite the read to !0) never consult the store, so this file cannot
# affect them - documented in the template and README.
#
# Sub-patches:
#   A: inject js/growthbook_overrides.js (defines globalThis.__cdbApplyGbOverrides)
#      at the very top of index.js (runs before any chunk code)
#   B: hook the features-store setter: function X(e){let t=Mx;Mx=e,Nx=!0;...
#      anchored on the stable log string "[growthbook] loaded %d features (%d changed)"
#
# Sub-patch A used to insert after the leading `"use strict";` directive. That
# anchor DIED in v1.26832.0: the bundle now opens with a Sentry IIFE and has no
# directive prologue, while the literal `"use strict";` still occurs deep inside
# a vendored template literal (`E(`"use strict"; return (`+e+`).constructor;`)`)
# - so a `find`-based anchor reported success while splicing the whole IIFE into
# the middle of a string. We prepend at offset 0 instead: index.js is a CJS
# module with no prologue and is `require`d by index.pre.js (package.json main),
# so offset 0 is both statement-level and earlier than every chunk.
#
# Break risk: LOW - A has no pattern left to break; B anchors on a log string
# that has been stable across releases. If upstream splits the setter or renames
# the log line, B fails loud.
#
# Uses the `regex` package (pure Nim) like the other patches: std/nre dlopens
# PCRE1 at run time, which ubuntu-24.04 (the CI harness runner) does not ship.
# `regex` has no backreferences, so the "transform is called on the setter's
# first parameter" constraint that used to be `\2` is an equality check on the
# captured groups; its repetition ranges are capped at 100, so the 200-char
# window between the keys count and the log line is two 100-char runs.

import std/[os, strformat, strutils]
import regex

const OVERRIDES_JS = staticRead("../../js/growthbook_overrides.js")
const EXPECTED_PATCHES = 2

# v1.19367.0 shape:
#   function hTt(e){const t=lf;lf=e,AP=!0;const r=Object.keys(lf).length,
#     n=Object.entries(lf).filter(...);v.info("[growthbook] loaded %d features (%d changed)",...)
# v1.26832.0 shape (new minifier: `let` instead of `const`, backtick literals,
# separate `let` for the second binding, dotted logger callee):
#   function tS(e){let t=Mx;Mx=e,Nx=!0;let n=Object.keys(Mx).length,
#     i=Object.entries(Mx).filter(...).length;r.o.info(`[growthbook] loaded %d features (%d changed)`,n,i)
# v1.34493.1 shape: the setter takes a SECOND parameter (a source/status tag,
# stored first), the dirty flag is gone, and the stored value now funnels
# through a TRANSFORM - the deployment-mode hardcoded-features filter, which
# used to be a separate load path calling the setter:
#   function Fit(e,t){OS=t;let n=DS;DS=jit(e);let r=Object.keys(DS).length,
#     i=Object.entries(DS).filter(...).length;D.info(`[growthbook] loaded %d features (%d changed)`,r,i)
# We now wrap the TRANSFORM CALL (`jit(e)`) rather than reassigning the raw
# parameter: overrides must apply to the map that is actually STORED, after
# the hardcoded-mode filter - same layering as before, when the hardcoded set
# itself arrived through the setter's parameter (user override > any rollout).
# Groups: 0 = head "function F(e,t){OS=t;let n=DS;DS=" (v6: "function F(e,t,n=null){X=t,Y=n;let r=D;D="), 1 = e (first param),
# 2 = transform call "jit(e)", 3 = e again (must equal group 1), 4 = tail
# ";let r=Object.keys(DS).length...loaded %d features...".
# v6.28899.2 shape: a THIRD parameter (the account/org identity the payload
# belongs to, defaulting to null) is stored next to the source tag, joined by a
# comma:
#   function RZt(e,t,n=null){X_=t,cZt=n;let r=Y_;Y_=NZt(e);let i=Object.keys(Y_).length,...
# Both the optional third `x=null` parameter and the optional extra `,a=b`
# store are accepted; the transform call and log-line anchor are unchanged.
const SETTER_PAT =
  re2"""(function [\w$]+\(([\w$]+),[\w$]+(?:,[\w$]+=null)?\)\{[\w$]+=[\w$]+(?:,[\w$]+=[\w$]+)?;(?:const|let|var) [\w$]+=[\w$]+;[\w$]+=)([\w$]+\(([\w$]+)\))(;(?:const|let|var) [\w$]+=Object\.keys\([\w$]+\)\.length[^"`]{0,100}[^"`]{0,100}["`]\[growthbook\] loaded %d features \(%d changed\)["`])"""

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0

  # --- Sub-patch A: helper injection ---------------------------------------
  if result.contains("__CDB_GB_OVERRIDES__"):
    echo "  [OK] growthbook overrides helper already present"
    inc patchesApplied
  else:
    # Prepend at offset 0 (see header note: no directive prologue since v1.26832.0).
    result = OVERRIDES_JS & result
    if result.contains("__CDB_GB_OVERRIDES__"):
      echo "  [OK] growthbook overrides helper prepended to index.js"
      inc patchesApplied
    else:
      echo "  [FAIL] growthbook overrides helper missing after injection"

  # --- Sub-patch B: hook the features-store setter --------------------------
  if result.contains("=(globalThis.__cdbApplyGbOverrides||"):
    echo "  [OK] features-store setter already hooked"
    inc patchesApplied
  else:
    var hooked = 0
    var setter = RegexMatch2()
    for m in result.findAll(SETTER_PAT):
      if result[m.group(1)] == result[m.group(3)]:
        setter = m
        hooked = 1
        break
    if hooked == 1:
      let head = result[setter.group(0)] # "function F(e,t){OS=t;let n=DS;DS="
      let transformCall = result[setter.group(2)] # "jit(e)"
      let tail = result[setter.group(4)]
        # ";let r=Object.keys(DS).length...loaded %d features..."
      let hook =
        head & "(globalThis.__cdbApplyGbOverrides||function(x){return x})(" &
        transformCall & ")" & tail
      result = result.replace(result[setter.boundaries], hook)
      echo "  [OK] features-store setter hooked (overrides applied on every flag load)"
      inc patchesApplied
    else:
      echo "  [FAIL] features-store setter pattern: 0 matches (loaded-features log line moved?)"

  if patchesApplied < EXPECTED_PATCHES:
    echo &"  [FAIL] Only {patchesApplied}/{EXPECTED_PATCHES} patches applied"
    quit(1)
  echo &"  [PASS] {patchesApplied}/{EXPECTED_PATCHES} growthbook override patches applied"

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_growthbook_overrides <index.js>"
    quit(1)
  let path = paramStr(1)
  echo "=== Patch: add_growthbook_overrides ==="
  echo &"  Target: {path}"
  let content = readFile(path)
  let patched = apply(content)
  if patched != content:
    writeFile(path, patched)
