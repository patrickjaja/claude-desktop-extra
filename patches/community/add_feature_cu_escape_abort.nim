# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Opt-in (default OFF): Escape stops Computer Use on Linux (issue #323).
# Switch: Settings -> Extra -> Community Features -> "Escape stops Computer
# Use" (key `computerUseEscapeAbort`, read at every arm through
# globalThis.__cdbCuEscapeAbortEnabled(), defined by js/extra_settings_main.js).
#
# Upstream (4.23118.1, index.chunk-k6x_9PBk.js; `zU` is the CU lock):
#   function nbi(){if(mJ>0){mJ--,P.debug("[cu-esc] escape absorbed
#     (model-synthesized)");return}ibi()}
#   function obi(){if(!(pJ||WO())){mJ=0;try{if(!u.globalShortcut.register(
#     "Escape",nbi)){...}pJ=!0,...}catch(e){...}}}
#   function sbi(){pJ&&(u.globalShortcut.unregister("Escape"),pJ=!1,mJ=0,...)}
#   function cbi(){zU.currentHolder&&$yi===0?obi():sbi()}
#   function lbi(e){fJ=e,zU.on("cuLockChanged",cbi),cbi(),...}
# obi registers Escape while the CU lock is held: an X11 key grab that takes
# the user's AND the model's Escape; on Wayland (WO()) nothing at all. sbi
# drops it, nbi stops every holder.
#
# Three sub-patches, each anchor exactly once, each with a positive end-state
# marker (all present = already applied; none = apply; anything else = FAIL):
#   17d  js/cu_esc_watch.js embedded as a statement right before obi (module
#        load, Linux only): globalThis.__cdbCuEscWatch. It spawns nothing until
#        17a arms it with the switch on.
#   17a  obi, on Linux with the switch on: arm(nbi, zU.currentHolder, obi).
#        true = our watcher takes the hold: drop a grab upstream registered
#        before (pJ, and reset its expected-Escape counter as its unregister
#        does) and return. false = no watcher can run here now (none for this
#        desktop, bridge missing or not runnable, breaker tripped, or a watcher
#        that failed on X11 handed the hold back by calling obi again):
#        upstream's body runs - its grab on X11, nothing on Wayland. With the
#        switch off a watcher of ours is disarmed (silent no-op when none) and
#        upstream's body runs untouched - OFF is exactly upstream.
#   17b  sbi: disarm the watcher first (silent no-op when none), then
#        upstream's body, so a grab upstream registered is still dropped.
# Pre-asserts (fail loud): the handler passed to register is the function with
# the `[cu-esc] escape absorbed` branch; the lock-change function calls obi and
# sbi and is the cuLockChanged listener; sbi drops "Escape".
#
# Applied before fix_computer_use_linux (basename order); that patch's markers
# never match anything injected here, and the executors it embeds only reach
# globalThis.__cdbCuEscWatch through optional calls (suspendAround, toolCall,
# taskEnded), which cost nothing while this patch is absent or the switch off.
import std/[os, strutils]
import regex

const watcherJs = staticRead("../../js/cu_esc_watch.js")
const EXPECTED_PATCHES = 3 # 17d, 17a, 17b

proc esc(name: string): string =
  ## A minified identifier ([\w$]+) as a literal regex.
  name.replace("$", "\\$")

proc count(s: string, pat: Regex2): int =
  s.findAll(pat).len

let
  markEmbed = re2"""globalThis\.__cdbCuEscWatch=Object\.freeze\("""
  markArm =
    re2"""function [\w$]+\(\)\{if\(process\.platform==="linux"&&globalThis\.__cdbCuEscapeAbortEnabled\?\.\(\)===true&&globalThis\.__cdbCuEscWatch\?\.arm\([\w$]+,[\w$]+\.currentHolder,[\w$]+\)===true\)\{if\([\w$]+\)\{[\w$]+\.globalShortcut\.unregister\("Escape"\);[\w$]+=!1;[\w$]+=0\}return\}process\.platform==="linux"&&globalThis\.__cdbCuEscapeAbortEnabled\?\.\(\)!==true&&globalThis\.__cdbCuEscWatch\?\.disarm\("switch off"\);if\(!\("""
  markDisarm =
    re2"""function [\w$]+\(\)\{process\.platform==="linux"&&globalThis\.__cdbCuEscWatch\?\.disarm\(\);[\w$]+&&\([\w$]+\.globalShortcut\.unregister\("""
  regPat =
    re2"""function ([\w$]+)\(\)\{if\(!\(([\w$]+)\|\|([\w$]+)\(\)\)\)\{([\w$]+)=0;try\{if\(!([\w$]+)\.globalShortcut\.register\(["'`]Escape["'`],([\w$]+)\)\)"""

proc apply*(input: string): string =
  let s = input
  var patchesApplied = 0
  let marks = [count(s, markEmbed), count(s, markArm), count(s, markDisarm)]
  if marks == [1, 1, 1]:
    echo "  [OK] 17d / 17a / 17b Escape watcher embed, register and unregister hooks already present (idempotent)"
    return s
  if marks != [0, 0, 0]:
    raise newException(
      ValueError,
      "  [FAIL] half-patched input: end states embed/arm/disarm = " & $marks &
        ", expected all 1 or all 0 - use a fresh extract and re-audit",
    )

  let regs = s.findAll(regPat)
  if regs.len != 1:
    raise newException(
      ValueError,
      "  [FAIL] 17a Escape register (`function F(){if(!(R||W())){N=0;try{if(!u.globalShortcut.register(\"Escape\",H))`): " &
        $regs.len & " matches, expected 1",
    )
  let m = regs[0]
  let reg = s[m.group(0)]
  let registered = s[m.group(1)]
  let synth = s[m.group(3)]
  let electron = s[m.group(4)]
  let handler = s[m.group(5)]
  let handlerHits = count(
    s,
    re2(
      "function " & esc(handler) & "\\(\\)\\{if\\(" & esc(synth) & ">0\\)\\{" &
        esc(synth) & "--,[\\w$]+\\.debug\\([\"'`]\\[cu-esc\\] escape absorbed"
    ),
  )
  if handlerHits != 1:
    raise newException(
      ValueError,
      "  [FAIL] 17a Escape handler " & handler &
        ": not the function with the `[cu-esc] escape absorbed` branch (" & $handlerHits &
        " matches, expected 1) - re-audit",
    )
  let lcs = s.findAll(
    re2(
      "function ([\\w$]+)\\(\\)\\{([\\w$]+)\\.currentHolder&&[\\w$]+===0\\?" & esc(reg) &
        "\\(\\):([\\w$]+)\\(\\)\\}"
    )
  )
  if lcs.len != 1:
    raise newException(
      ValueError,
      "  [FAIL] 17a lock-change function `function L(){lock.currentHolder&&N===0?" & reg &
        "():U()}`: " & $lcs.len & " matches, expected 1 - re-audit",
    )
  let lc = s[lcs[0].group(0)]
  let lock = s[lcs[0].group(1)]
  let unreg = s[lcs[0].group(2)]
  let listenHits = count(s, re2("\\.on\\([\"'`]cuLockChanged[\"'`]," & esc(lc) & "\\)"))
  if listenHits != 1:
    raise newException(
      ValueError,
      "  [FAIL] 17a " & lc & " is not the cuLockChanged listener (" & $listenHits &
        " matches, expected 1) - re-audit",
    )
  let unregPat = re2(
    "function " & esc(unreg) & "\\(\\)\\{" & esc(registered) & "&&\\(" & esc(electron) &
      "\\.globalShortcut\\.unregister\\([\"'`]Escape[\"'`]\\)"
  )
  let unregs = s.findAll(unregPat)
  if unregs.len != 1:
    raise newException(
      ValueError,
      "  [FAIL] 17b Escape unregister " & unreg & ": `" & registered & "&&(" & electron &
        ".globalShortcut.unregister(\"Escape\")` " & $unregs.len &
        " matches, expected 1 - re-audit",
    )

  # Splice from the end so the earlier offsets stay valid.
  let regAt = m.boundaries.a
  let regBody = regAt + ("function " & reg & "(){").len
  let unregBody = unregs[0].boundaries.a + ("function " & unreg & "(){").len
  if unregBody < regAt:
    raise newException(
      ValueError, "  [FAIL] 17b " & unreg & " is declared before " & reg & " - re-audit"
    )
  let res =
    s[0 ..< regAt] & "if(process.platform===\"linux\"){" & watcherJs.strip() & "}" &
    "function " & reg & "(){" &
    "if(process.platform===\"linux\"&&globalThis.__cdbCuEscapeAbortEnabled?.()===true&&globalThis.__cdbCuEscWatch?.arm(" &
    handler & "," & lock & ".currentHolder," & reg & ")===true){" & "if(" & registered &
    "){" & electron & ".globalShortcut.unregister(\"Escape\");" & registered & "=!1;" &
    synth & "=0}return}" &
    "process.platform===\"linux\"&&globalThis.__cdbCuEscapeAbortEnabled?.()!==true&&globalThis.__cdbCuEscWatch?.disarm(\"switch off\");" &
    s[regBody ..< unregBody] &
    "process.platform===\"linux\"&&globalThis.__cdbCuEscWatch?.disarm();" &
    s[unregBody .. ^1]
  echo "  [OK] 17d Escape watcher: js/cu_esc_watch.js embedded before " & reg & "()"
  inc patchesApplied
  echo "  [OK] 17a Escape register: " & reg &
    "() arms the watcher with upstream's handler " & handler &
    " when the switch is on, else upstream's body (lock listener " & lc & ")"
  inc patchesApplied
  echo "  [OK] 17b Escape unregister: " & unreg &
    "() disarms the watcher first, upstream's body kept"
  inc patchesApplied

  let after = [count(res, markEmbed), count(res, markArm), count(res, markDisarm)]
  if after != [1, 1, 1]:
    raise newException(
      ValueError,
      "  [FAIL] post-condition: end states embed/arm/disarm = " & $after &
        ", expected [1, 1, 1]",
    )
  if patchesApplied < EXPECTED_PATCHES:
    raise newException(
      ValueError,
      "  [FAIL] Only " & $patchesApplied & "/" & $EXPECTED_PATCHES & " patches applied",
    )
  echo "  [PASS] " & $patchesApplied & "/" & $EXPECTED_PATCHES & " sub-patches applied"
  result = res

when isMainModule:
  if paramCount() != 1:
    quit("Usage: add_feature_cu_escape_abort <bundle.js>", 1)
  echo "=== Patch: add_feature_cu_escape_abort ==="
  let file = paramStr(1)
  let input = readFile(file)
  let output = apply(input)
  if output != input:
    writeFile(file, output)
