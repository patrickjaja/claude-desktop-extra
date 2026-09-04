# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Nim port of fix_computer_use_linux.py — produces byte-identical output.
#
# The four JS snippets (regular inline executor, kwin-wayland executor,
# hybrid handler injection, mode preamble) are checked-in plain .js files
# under js/ and shared verbatim with the Python implementation. Nim
# embeds them via staticRead at compile time; Python reads them at runtime.
# No codegen — the .js files are the single source of truth.
#
# All 35 sub-patches use std/nre (PCRE) because many require backreferences.

import std/[os, strformat, strutils, options]
import std/nre

const LINUX_EXECUTOR_JS = staticRead("../../js/cu_linux_executor.js")
const LINUX_HANDLER_INJECTION_JS = staticRead("../../js/cu_handler_injection.js")
const MODE_PREAMBLE_JS = staticRead("../../js/cu_mode_preamble.js")
const KWIN_EXECUTOR_SOURCE = staticRead("../../js/executor_linux.js")

# ─── helpers ────────────────────────────────────────────────────────────────

proc replaceFirst(
    content: var string, pattern: Regex, subFn: proc(m: RegexMatch): string
): int =
  ## Replace the first regex match. Returns 1 if replaced, 0 otherwise.
  let maybeMatch = content.find(pattern)
  if maybeMatch.isNone:
    return 0
  let m = maybeMatch.get()
  let bounds = m.matchBounds
  content = content[0 ..< bounds.a] & subFn(m) & content[bounds.b + 1 .. ^1]
  return 1

proc replaceAllRegex(
    content: var string, pattern: Regex, subFn: proc(m: RegexMatch): string
): int =
  ## Replace ALL regex matches. Returns match count.
  var count = 0
  content = content.replace(
    pattern,
    proc(m: RegexMatch): string =
      inc count
      subFn(m),
  )
  return count

proc replaceLiteralFirst(content: var string, needle, sub: string): int =
  ## Replace first literal (non-regex) occurrence. Returns 1 if replaced, 0 otherwise.
  let idx = content.find(needle)
  if idx == -1:
    return 0
  content = content[0 ..< idx] & sub & content[idx + needle.len .. ^1]
  return 1

proc replaceLiteralFirstAny(
    content: var string, needles: openArray[string], sub: string
): int =
  ## Like replaceLiteralFirst, but tries each needle in order and replaces the
  ## first one found. Used for anchors that upstream's minifier re-quotes
  ## between releases (backtick <-> double/single quotes) without changing text.
  for needle in needles:
    if replaceLiteralFirst(content, needle, sub) == 1:
      return 1
  return 0

proc replaceLiteralAll(content: var string, needle, sub: string): int =
  ## Replace all literal occurrences. Returns match count.
  var idx = 0
  while true:
    let found = content.find(needle, idx)
    if found == -1:
      break
    content = content[0 ..< found] & sub & content[found + needle.len .. ^1]
    idx = found + sub.len
    inc result

proc countOccurrences(content, needle: string): int =
  var idx = 0
  while true:
    let found = content.find(needle, idx)
    if found == -1:
      break
    inc result
    idx = found + needle.len

proc findStringMarker(content: string, messages: varargs[string]): int =
  ## Mirrors find_string_marker from the Python source.
  for message in messages:
    for quote in ["\"", "'"]:
      let needle = quote & message & quote
      let idx = content.find(needle)
      if idx != -1:
        return idx
    let idx = content.find(message)
    if idx != -1:
      return idx
  return -1

type FunctionInfo = object
  headerEnd: int
  header: string
  body: string

proc findFunctionBeforeMarker(content: string, markerIndex: int): Option[FunctionInfo] =
  ## Mirrors find_function_before_marker.
  let fnIdx = content.rfind("function ", last = markerIndex - 1)
  if fnIdx == -1:
    return none(FunctionInfo)
  let headerEnd = content.find('{', start = fnIdx, last = markerIndex - 1)
  if headerEnd == -1:
    return none(FunctionInfo)
  return some(
    FunctionInfo(
      headerEnd: headerEnd,
      header: content[fnIdx .. headerEnd],
      body: content[headerEnd + 1 ..< markerIndex],
    )
  )

# ─── kwin-wayland executor transformation ───────────────────────────────────

proc buildKwinLinuxExecutorInjection(): string =
  ## Mirrors build_kwin_linux_executor_injection: transforms ES-module imports
  ## to CommonJS requires, strips `export` keywords, wraps in an IIFE.
  var js = KWIN_EXECUTOR_SOURCE
  js = js.replace(
    "import { execFile as execFileCb, spawnSync } from 'node:child_process'\n",
    "var { execFile: execFileCb, spawnSync } = require(\"node:child_process\");\n",
  )
  js = js.replace(
    "import { execFile as execFileCb } from 'node:child_process'\n",
    "var { execFile: execFileCb } = require(\"node:child_process\");\n",
  )
  js = js.replace(
    "import { screen as electronScreen } from 'electron'\n",
    "var { screen: electronScreen } = require(\"electron\");\n",
  )
  js = js.replace(
    "import { promisify } from 'node:util'\n",
    "var { promisify } = require(\"node:util\");\n",
  )
  # Strip `export ` at the start of any line. Python used re.sub(r"^export\s+", "", ..., flags=re.MULTILINE);
  # std/nre's default mode treats ^/$ as buffer boundaries, so enable multiline via (?m).
  js = js.replace(re"(?m)^export\s+", "")
  result =
    "(function(){\n" & js.strip(leading = false, trailing = true) &
    "\n\nglobalThis.__linuxExecutor = createLinuxExecutor({ hostBundleId: \"com.anthropic.claude\" });\n})();\n"

# ─── main patch ─────────────────────────────────────────────────────────────

proc apply*(input: string): string =
  var content = input
  let original = input
  var patchesApplied = 0
  var changes = 0
  const EXPECTED_PATCHES = 36

  # ── Patch 1: inject executors + mode preamble at app.on("ready") ───────
  block:
    let regularJs = LINUX_EXECUTOR_JS.strip()
    let kwinJs = buildKwinLinuxExecutorInjection().strip()
    # v1.26832.0 switched minifier: most string literals became backtick
    # template literals (app.on(`ready`)). Accept either quote style here and
    # everywhere else a literal is part of an anchor.
    # v1.32352.1: the minifier now parenthesises function expressions passed as
    # call arguments - `app.on(`ready`,(async()=>{...}))`. Allow the optional
    # `(` before the arrow; we only insert after `{`, so the extra closing paren
    # stays upstream's own.
    let pat = re"""(app\.on\(["`]ready["`],\(?async\(\)=>\{)"""
    let n = replaceFirst(
      content,
      pat,
      proc(m: RegexMatch): string =
        m.captures[0] & "if(process.platform===\"linux\"){" & MODE_PREAMBLE_JS &
          "if(globalThis.__cuKwinMode){" & kwinJs & "}else{" & regularJs & "}}",
    )
    if n >= 1:
      echo &"  [OK] Linux executor: injected regular + kwin-wayland variants ({n} match)"
      inc changes, n
      inc patchesApplied
    else:
      echo "  [FAIL] app.on(\"ready\") pattern: 0 matches"
      raise newException(ValueError, "  [FAIL] app.on(\"ready\") pattern: 0 matches")

  # ── Patch 2: add "linux" to the platform Set ───────────────────────────
  block:
    # Quote-agnostic: v1.26832.0 emits new Set([`darwin`,`win32`]). Re-emit the
    # quote character upstream actually used so the output stays homogeneous.
    let pat = re"""new Set\((\[(["`])darwin\2,(["`])win32\3)\]\)"""
    let n = replaceFirst(
      content,
      pat,
      proc(m: RegexMatch): string =
        let quote = m.captures[1]
        "new Set(" & m.captures[0] & "," & quote & "linux" & quote & "])",
    )
    if n >= 1:
      echo &"  [OK] ese Set: added linux ({n} match)"
      inc changes, n
      inc patchesApplied
    else:
      echo "  [FAIL] ese Set pattern: 0 matches"
      raise newException(ValueError, "  [FAIL] ese Set pattern: 0 matches")

  # ── Patch 4: createDarwinExecutor Linux fallback ───────────────────────
  block:
    # v1.26832.0: `throw new Error(` became `throw Error(`, and "darwin" is a
    # backtick literal. Capture the whole throw-guard verbatim and re-emit it so
    # neither variation has to be reproduced by hand.
    let pat =
      re"""(function [\w$]+\([\w$]+\)\{)(if\(process\.platform!==["`]darwin["`]\)throw (?:new )?Error)"""
    let n = replaceFirst(
      content,
      pat,
      proc(m: RegexMatch): string =
        m.captures[0] &
          "if(process.platform===\"linux\"&&globalThis.__linuxExecutor)return globalThis.__linuxExecutor;" &
          m.captures[1],
    )
    if n >= 1:
      echo &"  [OK] createDarwinExecutor: Linux fallback ({n} match)"
      inc changes, n
      inc patchesApplied
    else:
      echo "  [FAIL] createDarwinExecutor pattern: 0 matches"
      raise newException(ValueError, "  [FAIL] createDarwinExecutor pattern: 0 matches")

  # ── Patch 4d: platform executor factory (Cowork/agent path) ────────────
  # As of v1.15200 upstream split the executor factory in two. Patch 4 above
  # handles `createDarwinExecutor` (leading `!=="darwin"` throw). This SECOND
  # factory — `{const{...,hostBundleId:Z()};if(win32)return ...;if(darwin)return
  # ...;throw "computer-use executor not implemented for ${platform}"}` — is the
  # one the Cowork/agent computer-use path actually calls, and it has no linux
  # branch, so on Linux it fell straight to the throw (issue #159). Inject the
  # linux branch immediately before the throw, after the darwin branch.
  block:
    # Idempotency (Rule 6): assert the linux branch is present AT THIS factory
    # (immediately before the "executor not implemented" throw) — NOT merely that
    # the branch string exists somewhere, since Patch 4 injects an identical
    # string into createDarwinExecutor.
    # v1.26832.0: the win32/darwin arms became namespace-object method calls
    # (`s.r(),s.t(t)` / `o.t(t)`), platform literals are backticks, and the throw
    # dropped `new`. Allow dotted callees and either quote style.
    #
    # The guard describes the branch order this patch actually produces: the
    # linux branch goes BETWEEN the darwin arm and the throw. (Before v1.26832.0
    # it claimed the opposite order and so never matched its own output — a dead
    # branch that only ever produced a spurious [FAIL] on a second run, never a
    # false [OK].) Pinning it to the darwin-arm + throw pair is what keeps it
    # from being satisfied by Patch 4's identical injection in
    # createDarwinExecutor, which is preceded by a function header instead.
    let alreadyPat =
      re"""if\(process\.platform===["`]darwin["`]\)return [\w$]+(?:\.[\w$]+)*\([\w$]+\);if\(process\.platform==="linux"&&globalThis\.__linuxExecutor\)return globalThis\.__linuxExecutor;throw (?:new )?Error\(["`]computer-use executor not implemented"""
    if content.contains(alreadyPat):
      echo "  [OK] platform executor factory: linux branch already present at throw-site"
      inc patchesApplied
    else:
      # Anchor on the darwin-return immediately before the throw (unique: exactly
      # one `darwin)return X(Y);throw "...executor not implemented"` site). Insert
      # the linux branch between the darwin branch and the throw. Param/fn vars
      # are minified — keep them as captured wildcards.
      # NB: the throw interpolates `${process.platform}` — the placeholder body
      # contains a `.`, so it is `[\w$.]+` (NOT `[\w$]+`, which stops at the dot
      # and never reaches the closing `}` — a silent 0-match trap).
      let pat =
        re"""(if\(process\.platform===["`]darwin["`]\)return [\w$]+(?:\.[\w$]+)*\([\w$]+\);)(throw (?:new )?Error\(`computer-use executor not implemented for \$\{[\w$.]+\}`\))"""
      let n = replaceFirst(
        content,
        pat,
        proc(m: RegexMatch): string =
          m.captures[0] &
            "if(process.platform===\"linux\"&&globalThis.__linuxExecutor)return globalThis.__linuxExecutor;" &
            m.captures[1],
      )
      if n == 1:
        echo &"  [OK] platform executor factory: Linux branch before throw ({n} match)"
        inc changes, n
        inc patchesApplied
      elif n > 1:
        echo &"  [FAIL] platform executor factory: {n} matches (expected 1) — anchor too broad"
        raise newException(
          ValueError,
          &"  [FAIL] platform executor factory: {n} matches (expected 1) — anchor too broad",
        )
      else:
        echo "  [FAIL] platform executor factory: 0 matches (issue #159 throw-site anchor) — re-audit"
        raise newException(
          ValueError,
          "  [FAIL] platform executor factory: 0 matches (issue #159 throw-site anchor) — re-audit",
        )

  # ── Patch 4b (kwin-wayland): cu lock acquire → __setLockHeld(true) ──────
  # v1.20186.1 refactored the lock class: `this.holder` became
  # `this.exclusiveHolder`, and acquire() changed from a `this.holder===void
  # 0&&(this.holder=X,emit(...),cb())` guarded expression into an early-return
  # guard shape ending in `return this.exclusiveHolder=X,emit(...),cb(),!0`.
  # The cuLockChanged emit is unchanged; anchor the acquire-side emit and inject
  # __setLockHeld(true) right before it.
  block:
    # v1.26832.0: the trailing callback became a method call (`e.nn()`) and the
    # event name a backtick literal. Capture the whole emit-and-callback tail and
    # re-emit it verbatim instead of reconstructing it.
    let pat =
      re"""(return this\.exclusiveHolder=([\w$]+),)(this\.emit\(["`]cuLockChanged["`],\{holder:\2\}\),[\w$]+(?:\.[\w$]+)*\(\),!0)"""
    let n = replaceFirst(
      content,
      pat,
      proc(m: RegexMatch): string =
        m.captures[0] &
          "process.platform===\"linux\"&&globalThis.__linuxExecutor?.__setLockHeld?.(!0).catch?.(e=>(globalThis.__cdbDiag||console.warn)(\"[linux-executor] failed to start bridge session on lock acquire\",e))," &
          m.captures[2],
    )
    if n >= 1:
      echo &"  [OK] cu lock acquire: start bridge session on Linux ({n} match)"
      inc changes, n
      inc patchesApplied
    else:
      echo "  [FAIL] cu lock acquire pattern: 0 matches"

  # ── Patch 4b.2: cu lock release → __setLockHeld(false) ─────────────────
  # v1.20186.1: `this.holder` → `this.exclusiveHolder` (see Patch 4b).
  # v1.26832.0 split the release path in two — `releaseExclusive(x)` (display
  # lock only) and `release(x)` (also drops the app lock) — each with its own
  # copy of the clear-and-emit expression. BOTH are genuine "the exclusive CU
  # lock was dropped" sites, so hook every occurrence rather than only the first;
  # __setLockHeld(!1) is idempotent, so a session released through both paths is
  # still correct.
  block:
    let pat =
      re"""(this\.exclusiveHolder===([\w$]+)&&\(this\.exclusiveHolder=void 0,)(this\.emit\(["`]cuLockChanged["`],\{holder:void 0\}\)\))"""
    let n = replaceAllRegex(
      content,
      pat,
      proc(m: RegexMatch): string =
        m.captures[0] &
          "process.platform===\"linux\"&&globalThis.__linuxExecutor?.__setLockHeld?.(!1).catch?.(e=>(globalThis.__cdbDiag||console.warn)(\"[linux-executor] failed to stop bridge session on lock release\",e))," &
          m.captures[2],
    )
    if n >= 1:
      echo &"  [OK] cu lock release: stop bridge session on Linux ({n} match)"
      inc changes, n
      inc patchesApplied
    else:
      echo "  [FAIL] cu lock release pattern: 0 matches"

  # ── Patch 5: ensureOsPermissions → skip TCC on Linux ───────────────────
  block:
    let pat = re"""ensureOsPermissions:([\w$]+(?:\.[\w$]+)*)"""
    let n = replaceFirst(
      content,
      pat,
      proc(m: RegexMatch): string =
        let fnName = m.captures[0]
        &"ensureOsPermissions:process.platform===\"linux\"?async()=>({{granted:!0}}):{fnName}",
    )
    if n >= 1:
      echo &"  [OK] ensureOsPermissions: skip TCC on Linux ({n} match)"
      inc changes, n
      inc patchesApplied
    else:
      echo "  [FAIL] ensureOsPermissions pattern: 0 matches"

  # ── Patch 5b (kwin-wayland): screenshot intro note workaround ──────────
  block:
    if content.contains("linuxVisibleLastScreenshot=") and
        content.contains("lastScreenshot:linuxVisibleLastScreenshot,"):
      echo "  [OK] screenshot intro note workaround: already present"
      inc patchesApplied
    else:
      # v1.18286.0 added an abort timeout between the AbortController and the
      # options object: `,I=setTimeout(()=>u.abort(),PXi)` - matched optionally
      # and non-capturing so the AbortController capture index (5) stays stable.
      # The \6 backref pins the setTimeout's abort target to the AbortController
      # var captured just before it (hardening from PR #179 by @boommasterxd).
      #
      # v1.20186.1 rewrote the wrapper prologue that immediately precedes the
      # screenshot-dims decl (added an onTakeoverRequest/approveTakeover takeover
      # flow ending in `||X.call(Y)}}}const <dims>=...` instead of the old
      # `;X()}}const <dims>=...`). The old prologue anchor `;[\w$]+\(\)\}\}const`
      # no longer matches. The screenshot-dims decl itself is unique, so anchor
      # the async header, then lazily skip (up to 8000 chars) straight to that
      # decl — do not try to pin the exact prologue shape.
      #
      # v1.26832.0 rewrote the decl itself: the `X||(a=b.getLastScreenshotDims)==
      # null?void 0:a.call(b)` babel-style optional call collapsed into a plain
      # ternary over a native optional call — `let <dims>=<skip>?void 0:<ctx>.
      # getLastScreenshotDims?.()`. `const` also became `let`.
      #
      # The header anchor is now pinned to `return async(...)` (the dispatcher
      # factory's returned tool handler). Without `return ` the lazy skip also
      # matches two nested `async(e,t)=>{` permission callbacks that sit ~7k
      # chars upstream of the decl, which would capture THEIR `e` as the tool
      # name — a silent mis-binding, not a build failure.
      #
      # v1.30096.1 introduced the grant-tier rework, which hoists three more
      # declarations out of the options object and in between the setTimeout and
      # the object literal (`,b=[...ctx.getAllowedApps()],x=ctx.getGrantFlags(),
      # S=ctx.getUserDeniedBundleIds(),C={...,grants:g(b,S),...}`). Allow any
      # number of such comma-free simple declarations before the options object
      # rather than pinning their shape.
      # v1.32352.1: the minifier parenthesises arrow arguments -
      # `setTimeout((()=>v.abort()),or)` - so the wrapping parens around the
      # abort arrow are optional.
      let seedPat =
        re"""return async\(([\w$]+),[\w$]+\)=>\{[\s\S]{0,8000}?(?:const|let|var) ([\w$]+)=([\w$]+)\?void 0:[\w$]+(?:\.[\w$]+)*\.getLastScreenshotDims\?\.\(\),([\w$]+)=new AbortController(?:,[\w$]+=setTimeout\(\(?\(\)=>\4\.abort\(\)\)?,[\w$]+\))?(?:,[\w$]+=[^{},]{1,200})*,([\w$]+)=\{"""
      let maybeSeed = content.find(seedPat)
      if maybeSeed.isNone:
        echo "  [FAIL] screenshot intro note: wrapper seed anchor not found"
      else:
        let seed = maybeSeed.get()
        let toolName = seed.captures[0]
        let dimsVar = seed.captures[1]
        let lastVar = seed.captures[2]
        let injection =
          ",linuxVisibleLastScreenshot=process.platform===\"linux\"&&" & lastVar &
          "===void 0&&" & toolName & "===\"screenshot\"?void 0:" & lastVar & "??(" &
          dimsVar & "?{..." & dimsVar & ",base64:\"\"}:void 0)"
        # Split at the comma immediately before the AbortController var so the
        # injection joins the same declaration list. That var is group 4 of the
        # v1.26832.0 seed pattern → nre captures/captureBounds index 3.
        let abortBounds = seed.captureBounds[3]
        let splitPoint = abortBounds.a - 1
        content = content[0 ..< splitPoint] & injection & content[splitPoint ..^ 1]
        inc changes

        let lastScreenshotPat = re(
          "lastScreenshot:" & escapeRe(lastVar) & r"\?\?\(" & escapeRe(dimsVar) &
            r"\?\{\.\.\." & escapeRe(dimsVar) &
            r",base64:(?:\x22\x22|\x60\x60)\}:void 0\),"
        )
        let lsCount = replaceFirst(
          content,
          lastScreenshotPat,
          proc(m: RegexMatch): string =
            "lastScreenshot:linuxVisibleLastScreenshot,",
        )
        if lsCount < 1:
          echo "  [FAIL] screenshot intro note: lastScreenshot anchor not found"
        else:
          inc changes
          inc patchesApplied
          echo "  [OK] screenshot intro note: first wrapper screenshot restored"

  # ── Patch 6: handleToolCall hybrid dispatch (two-step match) ───────────
  block:
    # isEnabled was a bare call `e=>xS()` through v1.17377; v1.18286.0 made it a
    # session-type ternary `A=>A.sessionType==="ccd"?wS():bue()`; v1.20186.1 made
    # the ternary arms METHOD calls on a namespace object
    # `e=>e.sessionType==="ccd"?n.isComputerUseEnabled():n.isComputerUseRegisterable()`.
    # Accept all three (non-capturing): each ternary arm is `X()` or `X.Y()`. The
    # ternary shape is unique to the computer-use tool object (siblings use
    # `e.sessionType==="ccd"` without paired call arms).
    # v1.26832.0 moved `serverName:<ns>.<k>,tools:[],` in front of isEnabled on
    # this object and switched the literals to backticks. Allow a short
    # brace-free property prefix rather than pinning those two keys, and accept
    # either quote style around "ccd".
    let htcStart =
      re"""(([\w$]+)=\{[^{}]{0,80}isEnabled:[\w$]+=>(?:[\w$]+\.sessionType===["`]ccd["`]\?[\w$]+(?:\.[\w$]+)?\(\):[\w$]+(?:\.[\w$]+)?\(\)|[\w$]+\(\)),handleToolCall:async\(([\w$]+),([\w$]+),([\w$]+)\)=>\{)"""
    let maybeHtc = content.find(htcStart)
    if maybeHtc.isNone:
      echo "  [FAIL] handleToolCall pattern: 0 matches"
      raise newException(ValueError, "  [FAIL] handleToolCall pattern: 0 matches")
    let htc = maybeHtc.get()
    let objName = htc.captures[1]
    let toolNameParam = htc.captures[2]
    let inputParam = htc.captures[3]
    let sessionParam = htc.captures[4]
    let injectPos = htc.matchBounds.b + 1

    let afterBrace = content[injectPos ..< min(injectPos + 2000, content.len)]
    let dispatcherPat = re(
      "(?:const|let|var) [\\w$]+=([\\w$]+)\\(" & escapeRe(sessionParam) &
        """\),\{save_to_disk:"""
    )
    let maybeDispatcher = afterBrace.find(dispatcherPat)
    if maybeDispatcher.isNone:
      echo "  [FAIL] handleToolCall dispatcher not found"
      raise newException(ValueError, "  [FAIL] handleToolCall dispatcher not found")
    let dispatcher = maybeDispatcher.get().captures[0]
    var handlerJs = LINUX_HANDLER_INJECTION_JS.strip()
    handlerJs = handlerJs.replace("__SELF__", objName)
    handlerJs = handlerJs.replace("__DISPATCHER__", dispatcher)
    handlerJs = handlerJs.replace("__TOOL_NAME__", toolNameParam)
    handlerJs = handlerJs.replace("__INPUT__", inputParam)
    handlerJs = handlerJs.replace("__SESSION__", sessionParam)
    handlerJs = handlerJs.replace(
      "if(process.platform===\"linux\"){",
      "if(process.platform===\"linux\"&&!globalThis.__cuKwinMode){",
    )
    content = content[0 ..< injectPos] & handlerJs & content[injectPos ..^ 1]
    echo "  [OK] handleToolCall: regular-mode hybrid dispatch (gated; kwin-wayland falls through to upstream)"
    inc changes
    inc patchesApplied

  # ── Patch 7: teach overlay CU gate verify (no content change) ──────────
  var overlayVarOpt: Option[string]
  block:
    let stubPat = re"""listInstalledApps:\(\)=>\[\]\}\)"""
    let maybeStub = content.find(stubPat)
    if maybeStub.isNone:
      echo "  [FAIL] teach overlay: TCC stub pattern not found"
    else:
      let stub = maybeStub.get()
      let beforeStart = max(0, stub.matchBounds.a - 500)
      let beforeStub = content[beforeStart ..< stub.matchBounds.a]
      let afterStart = stub.matchBounds.b + 1
      let afterStub = content[afterStart ..< min(afterStart + 50, content.len)]
      let gatePat = re""",[\w$]+\(\)&&\("""
      if afterStub.contains(".has(process.platform)") or afterStub.find(gatePat).isSome:
        echo "  [OK] teach overlay controller: CU gate found after TCC stub (handled by Set fix)"
        inc patchesApplied
      elif beforeStub.find(
        re"[\w$]+(?:\.[\w$]+)*\(\)\?[\w$]+\([\w$]+\):[\w$]+(?:\.[\w$]+)*\.for\([\w$]+\)\.setImplementation\(\{"
      ).isSome:
        echo "  [OK] teach overlay controller: CU gate found before TCC stub via ternary (handled by Set fix)"
        inc patchesApplied
      else:
        echo "  [FAIL] teach overlay: CU gate not found near TCC stub — may need manual check"

  # ── Patch 7b (kwin-wayland): teach overlay bridge-backed init ──────────
  block:
    if content.contains("globalThis.__linuxExecutor?.__initTeachController"):
      echo "  [OK] teach overlay controller: bridge-backed init already present"
      inc patchesApplied
    else:
      let markerIdx = findStringMarker(content, "[cu-teach] controller initialized")
      if markerIdx == -1:
        echo "  [FAIL] teach overlay controller marker: not found"
      else:
        let fnInfoOpt = findFunctionBeforeMarker(content, markerIdx)
        if fnInfoOpt.isNone:
          echo "  [FAIL] teach overlay controller init header: not found"
        else:
          let fnInfo = fnInfoOpt.get
          let headerPat = re"""^function [\w$]+\(([\w$]+),([\w$]+)\)\{$"""
          let headerMatch = fnInfo.header.find(headerPat)
          let bodyOK =
            fnInfo.body.contains(re"""\.on\(["`]teachModeChanged["`]""") and
            fnInfo.body.contains(re"""\.on\(["`]teachStepRequested["`]""")
          if headerMatch.isNone or not bodyOK:
            echo "  [FAIL] teach overlay controller init function shape: unexpected"
          else:
            let manager = headerMatch.get().captures[0]
            let mainWindow = headerMatch.get().captures[1]
            let injected =
              &"if(process.platform===\"linux\"&&globalThis.__linuxExecutor?.__initTeachController){{globalThis.__linuxExecutor.__initTeachController({manager},{mainWindow});return;}}"
            content =
              content[0 .. fnInfo.headerEnd] & injected &
              content[fnInfo.headerEnd + 1 ..^ 1]
            echo "  [OK] teach overlay controller: Linux bridge-backed init"
            inc changes
            inc patchesApplied

  # ── Patch 7c (kwin-wayland): side-panel bridge-backed init ─────────────
  block:
    if content.contains("globalThis.__linuxExecutor?.__initDockController"):
      echo "  [OK] cu side-panel: bridge-backed init already present"
      inc patchesApplied
    else:
      let markerIdx = findStringMarker(content, "[cu-side-panel] initialized")
      if markerIdx == -1:
        echo "  [FAIL] cu side-panel controller marker: not found"
      else:
        let fnInfoOpt = findFunctionBeforeMarker(content, markerIdx)
        if fnInfoOpt.isNone:
          echo "  [FAIL] cu side-panel controller init header: not found"
        else:
          let fnInfo = fnInfoOpt.get
          let headerPat = re"""^function [\w$]+\(([\w$]+)\)\{$"""
          let headerMatch = fnInfo.header.find(headerPat)
          let bodyOK = fnInfo.body.contains(re"""\.on\(["`]cuLockChanged["`]""")
          if headerMatch.isNone or not bodyOK:
            echo "  [FAIL] cu side-panel controller init function shape: unexpected"
          else:
            let mainWindow = headerMatch.get().captures[0]
            let injected =
              &"if(process.platform===\"linux\"&&globalThis.__linuxExecutor?.__initDockController){{globalThis.__linuxExecutor.__initDockController({mainWindow});return;}}"
            content =
              content[0 .. fnInfo.headerEnd] & injected &
              content[fnInfo.headerEnd + 1 ..^ 1]
            echo "  [OK] cu side-panel: Linux bridge-backed init"
            inc changes
            inc patchesApplied

  # ── Patch 8: teach overlay mouse — tooltip-bounds polling on Linux ─────
  var overlayVar: string
  block:
    let overlayVarPat =
      re"""([\w$]+)\.setAlwaysOnTop\(!0,["`]screen-saver["`]\),\1\.setFullScreenable\(!1\),\1\.setIgnoreMouseEvents\(!0,\{forward:!0\}\)"""
    let maybeOV = content.find(overlayVarPat)
    if maybeOV.isNone:
      echo "  [FAIL] teach overlay mouse: overlay variable pattern not found"
    else:
      overlayVar = maybeOV.get().captures[0]
      overlayVarOpt = some(overlayVar)
      let oldInit = overlayVar & ".setIgnoreMouseEvents(!0,{forward:!0})"
      let newInit =
        "(process.platform===\"linux\"?(" & overlayVar &
        ".setIgnoreMouseEvents=function(){},globalThis.__isVM&&" & overlayVar &
        ".setOpacity(.15)):" & overlayVar & ".setIgnoreMouseEvents(!0,{forward:!0}))"
      if replaceLiteralFirst(content, oldInit, newInit) == 1:
        echo &"  [OK] teach overlay mouse: tooltip-bounds polling for Linux ({overlayVar})"
        inc changes
        inc patchesApplied
      else:
        echo "  [FAIL] teach overlay mouse: replacement failed"

  # ── Patch 9a: neutralize setIgnoreMouseEvents in yJt ───────────────────
  if overlayVarOpt.isSome:
    block:
      let pat =
        re"""(function [\w$]+\([\w$]+,[\w$]+\)\{)([\w$]+)(\.setIgnoreMouseEvents\(!0,\{forward:!0\}\))"""
      let n = replaceFirst(
        content,
        pat,
        proc(m: RegexMatch): string =
          let fnHead = m.captures[0]
          let vvar = m.captures[1]
          let rest = m.captures[2]
          &"{fnHead}(process.platform!==\"linux\"&&{vvar}{rest})",
      )
      if n >= 1:
        echo "  [OK] teach overlay: neutralized setIgnoreMouseEvents in show handler (yJt) for Linux"
        inc changes
        inc patchesApplied
      else:
        echo "  [FAIL] teach overlay: yJt pattern not found"

    # ── Patch 9b: neutralize setIgnoreMouseEvents in SUn ─────────────────
    # v1.26832.0 replaced the raw IPC channel send in the "working" handler
    # (`<ov>.webContents.send("cu-teach:working")`) with a typed dispatcher call
    # (`<ns>.getDispatcher(<ov>.webContents)?.dispatchWorking()`); the channel
    # string "cu-teach:working" no longer exists anywhere in the bundle. The
    # dispatch call is what now discriminates this site from the overlay-creation
    # site, which shares the identical setIgnoreMouseEvents prefix.
    block:
      let ov = overlayVarOpt.get
      let sunPat = re(
        escapeRe(ov) & r"\.setIgnoreMouseEvents\(!0,\{forward:!0\}\)," &
          r"([\w$]+(?:\.[\w$]+)*\.getDispatcher\(" & escapeRe(ov) &
          r"\.webContents\)\?\.dispatchWorking\(\))"
      )
      let sunCount = replaceFirst(
        content,
        sunPat,
        proc(m: RegexMatch): string =
          "(process.platform!==\"linux\"&&" & ov &
            ".setIgnoreMouseEvents(!0,{forward:!0}))," & m.captures[0],
      )
      if sunCount == 1:
        echo "  [OK] teach overlay: neutralized setIgnoreMouseEvents in working handler (SUn) for Linux"
        inc changes
        inc patchesApplied
      else:
        echo "  [FAIL] teach overlay: SUn pattern not found"

  # ── Patch 8a (kwin-wayland): disable glow overlay ──────────────────────
  block:
    # v1.26832.0: the emitter is reached through a module namespace (`N.t.on(...)`)
    # and the event name is a backtick literal. Capture the whole `.on(...)` head
    # and re-emit it instead of rebuilding it from an identifier.
    let pat =
      re"""(function [\w$]+\(([\w$]+),([\w$]+)\)\{)([\w$]+(?:\.[\w$]+)*\.on\(["`]cuLockChanged["`],)"""
    let n = replaceFirst(
      content,
      pat,
      proc(m: RegexMatch): string =
        m.captures[0] &
          "if(process.platform===\"linux\"&&globalThis.__cuKwinMode)return;" &
          m.captures[3],
    )
    if n >= 1:
      echo &"  [OK] cu glow overlay: disabled in kwin-wayland mode ({n} match)"
      inc changes, n
      inc patchesApplied
    else:
      echo "  [FAIL] cu glow overlay pattern: 0 matches"

  # ── Patch 10: teach overlay VM-aware transparency ──────────────────────
  block:
    # Python walks ALL matches and picks the first whose 80-byte prefix contains "workArea".
    let pat =
      re"""(=new [\w$]+\.BrowserWindow\(\{[^}]*?)transparent:!0([^}]*?)backgroundColor:(["`])#00000000\3"""
    var applied = false
    for m in content.findIter(pat):
      let matchStart = m.matchBounds.a
      let preStart = max(0, matchStart - 80)
      let before = content[preStart ..< matchStart]
      if before.contains("workArea"):
        let bounds = m.matchBounds
        let old = content[bounds.a .. bounds.b]
        let quote = content[m.captureBounds[2]]
        var newS = old
        newS = newS.replace("transparent:!0", "transparent:!globalThis.__isVM")
        newS = newS.replace(
          "backgroundColor:" & quote & "#00000000" & quote,
          "backgroundColor:globalThis.__isVM?\"#000000\":\"#00000000\"",
        )
        # Single literal replacement
        discard replaceLiteralFirst(content, old, newS)
        echo "  [OK] teach overlay: VM-aware transparency (transparent on native, dark backdrop on VMs)"
        inc changes
        inc patchesApplied
        applied = true
        break
    if not applied:
      echo "  [FAIL] teach overlay transparency pattern not found"

  # ── Patch 10b: xlr() force primary monitor on Linux ────────────────────
  block:
    let pat =
      re"""(function [\w$]+\(([\w$]+)\)\{)(return \2===null\?[\w$]+\.screen\.getPrimaryDisplay\(\):[\w$]+\.screen\.getAllDisplays\(\)\.find)"""
    let n = replaceFirst(
      content,
      pat,
      proc(m: RegexMatch): string =
        let param = m.captures[1]
        m.captures[0] & &"if(process.platform===\"linux\"){param}=null;" & m.captures[2],
    )
    if n >= 1:
      echo &"  [OK] teach overlay display: forced to primary monitor on Linux ({n} match)"
      inc changes, n
      inc patchesApplied
    else:
      echo "  [FAIL] xlr display resolver pattern: 0 matches (teach may appear on wrong monitor)"

  # ── Patch 11: force the primary CU enable gate → true on Linux ──────────
  block:
    # v1.18286.0 merged the old isEnabled + rj pair into a gate family:
    #   wS(){if(!IRA.has(process.platform))return!1;const A=YiA();
    #        return A!==void 0?A:HiA()&&sr("chicagoEnabled")}      <- this patch
    #   bue(){if(!rt(rAn))return wS();...}                          <- Patch 12
    #   dq(){...&&!sr("chicagoEnabled")}                            <- untouched:
    #        Patch 2 adds "linux" to IRA, so IRA.has() is TRUE here; dq() is
    #        harmless anyway because Patch 6 injects the Linux dispatch at the
    #        top of handleToolCall, before the if(dq()) stub path is reached.
    #
    # The injected Linux branch is an UNCONDITIONAL `return!0`, not a pref read.
    # Reason: the enable pref is read through sr("chicagoEnabled"), and
    #   sr = A=>{const e=mc().preferences??{};return Qre(e)[A]}
    #   Qre = A=>{const e={};...;return{...U0t,...e,...A,...}}   (U0t = defaults)
    # merges the static defaults object U0t, which carries `chicagoEnabled:!1`.
    # So sr("chicagoEnabled") NEVER returns undefined for a user who has not set
    # the pref — it returns !1 — which means `sr("chicagoEnabled")??!0` can never
    # fall through to !0 and the gate stays false for everyone (CU absent). There
    # is also no CU toggle on Linux: the chicagoEnabled switch is server-rendered
    # by claude.ai and hidden here (see baseline/CLAUDE_FEATURE_FLAGS.md), so there
    # is no legitimate user-set state to respect. Forcing true unconditionally
    # restores the working v1.17377 semantics.
    #
    # Rule-6 regression guard: if the desired Linux branch is already present,
    # assert it and count success (idempotent), keying off the PATCHED end-state
    # (return!0 as the first statement of the gate function), not the absence of
    # the old shape.
    #
    # v1.26832.0 reverted the v1.18286 three-statement shape back to a single
    # ternary and moved the platform Set behind a module namespace:
    #   function g(){return o.t.has(process.platform)?h()&&a.n(`chicagoEnabled`):!1}
    # (`g` is exported as isComputerUseEnabled). Its sibling
    #   function _(){return o.t.has(process.platform)&&h()&&!a.n(`chicagoEnabled`)}
    # is isComputerUseAvailableButOptedOut and has no `?`, so the ternary shape
    # below picks out exactly one function.
    #
    # v1.46388.2 folded the Cowork HIPAA compliance gate into the ternary and
    # flipped the minifier back to double quotes:
    #   function rz(){return!ZR.has(process.platform)||Uk()?!1:nz()&&Wx("chicagoEnabled")}
    # (`Uk()` is `coworkHipaaRestricted()==="restricted"`). The Linux branch now
    # returns `!<hipaa>()` instead of a bare `!0`, so an org compliance lock
    # still switches CU off on Linux exactly as it does on macOS/Windows; the
    # platform Set + chicagoEnabled parts stay forced as before.
    #
    # The same release added a PER-CALL deny to handleToolCall's preamble
    # (`if(...,t.Rb())return{isError:!0,content:[...]}`), which Patch 6's Linux
    # dispatch returns before. So the Linux branch also publishes the captured
    # gate as `globalThis.__cdbCuHipaa` and js/cu_handler_injection.js re-checks
    # it at the top of every tool call. isEnabled runs at server registration,
    # before any tool call, so the global is always set when the handler runs.
    # The v26832 fallback has no HIPAA function to capture and leaves the global
    # unset; the handler then skips the check (typeof guard).
    let alreadyWs =
      re"""function [\w$]+\(\)\{if\(process\.platform==="linux"\)return(?: ?!0| globalThis\.__cdbCuHipaa=[\w$]+,![\w$]+\(\));return ?!?[\w$]+(?:\.[\w$]+)*\.has\(process\.platform\)(?:\|\|[\w$]+\(\))?\?(?:!1:)?[\w$]+\(\)&&[\w$]+(?:\.[\w$]+)*\(["'`]chicagoEnabled["'`]\)(?::!1)?\}"""
    if content.contains(alreadyWs):
      echo "  [OK] isEnabled: linux branch already present (guard satisfied)"
      inc patchesApplied
    else:
      let patV46388 =
        re"""(function [\w$]+\(\)\{)return![\w$]+(?:\.[\w$]+)*\.has\(process\.platform\)\|\|([\w$]+)\(\)\?!1:[\w$]+\(\)&&[\w$]+(?:\.[\w$]+)*\(["'`]chicagoEnabled["'`]\)\}"""
      let patV26832 =
        re"""(function [\w$]+\(\)\{)return [\w$]+(?:\.[\w$]+)*\.has\(process\.platform\)\?[\w$]+\(\)&&[\w$]+(?:\.[\w$]+)*\(["'`]chicagoEnabled["'`]\):!1\}"""
      let patV18286 =
        re"""(function [\w$]+\(\)\{)if\(!([\w$]+)\.has\(process\.platform\)\)return!1;const ([\w$]+)=([\w$]+)\(\);return \3!==void 0\?\3:([\w$]+)\(\)&&([\w$]+)\("chicagoEnabled"\)\}"""
      # <=v1.17377 shapes, kept as fallbacks:
      let patNew =
        re"""(function [\w$]+\(\)\{)return [\w$]+\.has\(process\.platform\)&&[\w$]+\(\)\}"""
      let patOld =
        re"""(function [\w$]+\(\)\{)return [\w$]+\([\w$]+\)\?[\w$]+\.has\(process\.platform\)&&[\w$]+\(\):[\w$]+\(\)\}"""
      var n = replaceFirst(
        content,
        patV46388,
        proc(m: RegexMatch): string =
          let bounds = m.matchBounds
          let whole = content[bounds.a .. bounds.b]
          let headerLen = m.captures[0].len
          let hipaaName = m.captures[1]
          m.captures[0] &
            "if(process.platform===\"linux\")return globalThis.__cdbCuHipaa=" & hipaaName &
            ",!" & hipaaName & "();" & whole[headerLen ..^ 1],
      )
      if n == 0:
        n = replaceFirst(
          content,
          patV26832,
          proc(m: RegexMatch): string =
            let bounds = m.matchBounds
            let whole = content[bounds.a .. bounds.b]
            let headerLen = m.captures[0].len
            m.captures[0] & "if(process.platform===\"linux\")return!0;" &
              whole[headerLen ..^ 1],
        )
      if n == 0:
        n = replaceFirst(
          content,
          patV18286,
          proc(m: RegexMatch): string =
            let bounds = m.matchBounds
            let whole = content[bounds.a .. bounds.b]
            let headerLen = m.captures[0].len
            m.captures[0] & "if(process.platform===\"linux\")return!0;" &
              whole[headerLen ..^ 1],
        )
      if n == 0:
        n = replaceFirst(
          content,
          patNew,
          proc(m: RegexMatch): string =
            let bounds = m.matchBounds
            let whole = content[bounds.a .. bounds.b]
            let headerLen = m.captures[0].len
            m.captures[0] & "if(process.platform===\"linux\")return!0;" &
              whole[headerLen ..^ 1],
        )
      if n == 0:
        n = replaceFirst(
          content,
          patOld,
          proc(m: RegexMatch): string =
            let bounds = m.matchBounds
            let whole = content[bounds.a .. bounds.b]
            let headerLen = m.captures[0].len
            m.captures[0] & "if(process.platform===\"linux\")return!0;" &
              whole[headerLen ..^ 1],
        )
      if n >= 1:
        echo &"  [OK] isEnabled: force true on Linux ({n} match)"
        inc changes, n
        inc patchesApplied
      else:
        echo "  [FAIL] isEnabled pattern: 0 matches (computer-use may not work in cowork/CCD)"

  # ── Patch 12: flag-gated pref-ignoring gate (bue) → delegate to wS ──────
  block:
    # v1.18286.0: bue(){if(!rt(rAn))return wS();const A=YiA();return A!==void 0
    # ?A:IRA.has(process.platform)&&HiA()} - behind GrowthBook flag rAn
    # ("2486083521") it stops consulting wS/chicagoEnabled and re-checks the
    # platform set, which would flip CU back OFF on Linux if the flag turns on
    # remotely. Prepend a Linux branch that always delegates to the (already
    # patched, unconditionally-true) wS.
    #
    # The v18286 branch delegates to wS() (now `return!0` on Linux via Patch 11),
    # so it is correct as-is. The <=v1.17377 fallback below used the same latent
    # `sr("chicagoEnabled")??!0` shape as the old Patch 11 — with sr merging the
    # `chicagoEnabled:!1` default that expression is always !1, so it too is now
    # an unconditional `return!0` for the same reason (see Patch 11 comment).
    #
    # Rule-6 regression guard: assert the desired end-state (a Linux branch at the
    # top of this gate that either delegates to a wS-style fn or returns !0) is
    # present, keying off the PATCHED shape, not the absence of the old one.
    #
    # v1.26832.0 collapsed it to a single ternary too:
    #   function y(){return i.Zt(l)?o.t.has(process.platform)&&h():g()}
    # (`y` is exported as isComputerUseRegisterable, `l` is the GrowthBook flag
    # id, `g` is the Patch-11 gate). The else-arm names the gate to delegate to,
    # so capture it rather than hardcoding `return!0`.
    #
    # v1.46388.2 prepends the Cowork HIPAA gate to the flag-on arm:
    #   function Nhn(){return wS(_hn)?!Uk()&&ZR.has(process.platform)&&nz():rz()}
    # The `!<hipaa>()&&` is optional in the pattern; the Linux branch still
    # delegates to the Patch-11 gate, which now honours the same HIPAA gate.
    let alreadyBue =
      re"""function [\w$]+\(\)\{if\(process\.platform==="linux"\)return (?:[\w$]+\(\)|!0);return [\w$]+(?:\.[\w$]+)*\(([\w$]+)\)\?(?:![\w$]+\(\)&&)?[\w$]+(?:\.[\w$]+)*\.has\(process\.platform\)"""
    if content.contains(alreadyBue):
      echo "  [OK] rj/bue: linux branch already present (guard satisfied)"
      inc patchesApplied
    else:
      let patV26832 =
        re"""(function [\w$]+\(\)\{)return [\w$]+(?:\.[\w$]+)*\(([\w$]+)\)\?(?:![\w$]+\(\)&&)?[\w$]+(?:\.[\w$]+)*\.has\(process\.platform\)&&[\w$]+\(\):([\w$]+)\(\)\}"""
      let patBue =
        re"""(function [\w$]+\(\)\{)if\(!([\w$]+)\(([\w$]+)\)\)return ([\w$]+)\(\);const ([\w$]+)=([\w$]+)\(\);return \5!==void 0\?\5:([\w$]+)\.has\(process\.platform\)&&([\w$]+)\(\)\}"""
      # <=v1.17377 shape (standalone chicagoEnabled ternary), kept as fallback:
      let patOldChicago =
        re"""(function [\w$]+\(\)\{)return [\w$]+\.has\(process\.platform\)\?[\w$]+\(\)&&([\w$]+)\("chicagoEnabled"\):!1\}"""
      var n = replaceFirst(
        content,
        patV26832,
        proc(m: RegexMatch): string =
          let bounds = m.matchBounds
          let whole = content[bounds.a .. bounds.b]
          let headerLen = m.captures[0].len
          let wsName = m.captures[2]
          m.captures[0] & "if(process.platform===\"linux\")return " & wsName & "();" &
            whole[headerLen ..^ 1],
      )
      if n == 0:
        n = replaceFirst(
          content,
          patBue,
          proc(m: RegexMatch): string =
            let bounds = m.matchBounds
            let whole = content[bounds.a .. bounds.b]
            let headerLen = m.captures[0].len
            let wsName = m.captures[3]
            m.captures[0] & "if(process.platform===\"linux\")return " & wsName & "();" &
              whole[headerLen ..^ 1],
        )
      if n == 0:
        n = replaceFirst(
          content,
          patOldChicago,
          proc(m: RegexMatch): string =
            let bounds = m.matchBounds
            let whole = content[bounds.a .. bounds.b]
            let headerLen = m.captures[0].len
            m.captures[0] & "if(process.platform===\"linux\")return!0;" &
              whole[headerLen ..^ 1],
        )
      if n >= 1:
        echo &"  [OK] rj/bue: force true on Linux ({n} match)"
        inc changes, n
        inc patchesApplied
      else:
        echo "  [FAIL] rj pattern: 0 matches (computer-use tool calls may be blocked)"

  # ─── Tool description patches ────────────────────────────────────────
  echo "  --- Tool description patches ---"
  var descChanges = 0

  # 13a: Lf allowlist gate → empty on Linux
  block:
    let pat =
      re"""([\w$]+)=["`]The frontmost application must be in the session allowlist at the time of this call, or this tool returns an error and does nothing\.["`]"""
    let n = replaceFirst(
      content,
      pat,
      proc(m: RegexMatch): string =
        let v = m.captures[0]
        &"{v}=process.platform===\"linux\"?\"\":\"The frontmost application must be in the session allowlist at the time of this call, or this tool returns an error and does nothing.\"",
    )
    if n >= 1:
      echo "  [OK] 13a Lf allowlist gate: empty on Linux"
      inc descChanges
      inc patchesApplied
    else:
      echo "  [FAIL] 13a Lf: not found"

  # 13b: request_access macOS prefix → 3-way ternary
  block:
    # v1.26832.0: single-quoted literal → backtick template. Inside a template
    # literal the embedded `"Finder"` / `"Dolphin"` quotes need no escaping.
    # v1.46388.2: back to a single-quoted literal (it contains `"`).
    let old13b = [
      "'This computer is running macOS. The file manager is \"Finder\". '",
      "`This computer is running macOS. The file manager is \"Finder\". `",
    ]
    let new13b =
      "(process.platform===\"linux\"?(globalThis.__cuKwinMode?" &
      "`This computer is running Linux with KDE Plasma. The file manager is \"Dolphin\". `" &
      ":" & "`This computer is running Linux. " &
      "On Linux, ALL applications are automatically accessible at full " &
      "tier without explicit permission grants. You do NOT need to call " &
      "request_access before using other tools. If called, it returns " &
      "synthetic grant confirmations. The file manager depends on the " &
      "desktop environment (e.g. Nautilus on GNOME, Dolphin on KDE, " &
      "Thunar on XFCE). `)" & ":" &
      "`This computer is running macOS. The file manager is \"Finder\". `)"
    if replaceLiteralFirstAny(content, old13b, new13b) == 1:
      echo "  [OK] 13b request_access: 3-way (kwin-wayland=KDE/Dolphin, regular=generic Linux, other=macOS)"
      inc descChanges
      inc patchesApplied
    else:
      echo "  [FAIL] 13b request_access macOS prefix: not found"

  # 13b.kwin-alias: plasmashell alias in request_access
  block:
    # v1.26832.0: `const`→`let`, `=="string"`→`==\`string\``, and the error
    # strings are backtick templates.
    # v1.32352.1: arrow arguments are parenthesised - `.every((e=>...))` - so
    # the wrapping parens are optional.
    let pat =
      re"""((?:const|let|var) ([\w$]+)=[\w$]+\.apps;if\(!Array\.isArray\(\2\)\|\|!\2\.every\(\(?([\w$]+)=>typeof \3==["`]string["`]\)\)?\)return [\w$]+\(['"`]"apps" must be an array of strings\.['"`],["`]bad_args["`]\);(?:const|let|var) )([\w$]+)=\2(,[\w$]+=\{\};)"""
    let n = replaceFirst(
      content,
      pat,
      proc(m: RegexMatch): string =
        let prefix = m.captures[0]
        let appsVar = m.captures[1]
        let mappedVar = m.captures[3]
        let suffix = m.captures[4]
        prefix & mappedVar & "=globalThis.__cuKwinMode?" & appsVar &
          ".map(v=>v===\"org.kde.plasmashell\"?\"plasmashell\":v):" & appsVar & suffix,
    )
    if n >= 1:
      echo "  [OK] 13b.kwin-alias request_access: org.kde.plasmashell -> plasmashell (kwin-wayland mode)"
      inc descChanges
      inc patchesApplied
    else:
      echo "  [FAIL] 13b.kwin-alias request_access alias: not found"

  # 13b.kwin-alias-teach: plasmashell alias in request_teach_access
  #
  # v1.26832.0 dropped the intermediate `const <mapped>=<apps>,{needDialog:...}`
  # binding: the raw apps array is now passed straight into the resolver call
  # (`let{needDialog:...}=await X(ctx,<apps>,...)`), and it is its only use. So
  # map the ARGUMENT instead of introducing a binding — that also keeps working
  # whichever declarator upstream picks, since nothing is reassigned.
  block:
    # v1.32352.1: same optional arrow-wrapping parens as 13b.kwin-alias.
    let pat =
      re"""((?:const|let|var) ([\w$]+)=[\w$]+\.apps;if\(!Array\.isArray\(\2\)\|\|!\2\.every\(\(?([\w$]+)=>typeof \3==["`]string["`]\)\)?\)return [\w$]+\(['"`]"apps" must be an array of strings\.['"`],["`]bad_args["`]\);(?:const|let|var)\{needDialog:[\s\S]{0,400}?\}=await [\w$]+\([\w$]+,)\2(,)"""
    let n = replaceFirst(
      content,
      pat,
      proc(m: RegexMatch): string =
        let prefix = m.captures[0]
        let appsVar = m.captures[1]
        let suffix = m.captures[3]
        prefix & "(globalThis.__cuKwinMode?" & appsVar &
          ".map(v=>v===\"org.kde.plasmashell\"?\"plasmashell\":v):" & appsVar & ")" &
          suffix,
    )
    if n >= 1:
      echo "  [OK] 13b.kwin-alias-teach request_teach_access: plasmashell alias (kwin-wayland mode)"
      inc descChanges
      inc patchesApplied
    else:
      echo "  [FAIL] 13b.kwin-alias-teach request_teach_access alias: not found"

  # 13b.kwin-shell-hint: desktop shell hint template
  block:
    # v1.28929.0: wording changed ("To click on the desktop, ...") and a second
    # ${platform===`win32`?...} interpolation was added (click-only caveat).
    # The whole matched region is one template literal passed as an argument,
    # so it can be swapped for a parenthesised ternary — no outer template
    # wrapper needed, and the branch texts stay single-level templates where
    # `"` needs no escaping.
    let prefix =
      "`The desktop shell is frontmost. Double-click, right-click, and Enter on desktop items can launch applications outside the allowlist. To click on the desktop, taskbar, Start menu, Search, or file manager, call request_access with exactly \"${"
    # v1.32352.1: the minifier escapes non-ASCII as \uXXXX inside literals -
    # the em-dash is now the six ASCII chars \u2014, not raw UTF-8 bytes.
    # v1.46388.2: the inner string literals are double-quoted again
    # (`==="win32"?"File Explorer":"Finder"`); the outer template stays a
    # backtick literal because of the ${} interpolations. Accept either quote
    # style for the inner literals via a quote class (Q below).
    const Q = "[\"`]"
    let mid =
      "===" & Q & "win32" & Q & "\\?" & Q & "File Explorer" & Q & ":" & Q & "Finder" & Q &
      escapeRe("}\" in the apps array \\u2014 that single grant covers all of them.${")
    let suffix =
      "===" & Q & "win32" & Q & "\\?" & Q &
      escapeRe(" That grant is click-only: typing into the shell stays blocked.") & Q &
      ":" & Q & Q &
      escapeRe(
        "} To interact with a different app, use open_application to bring it forward.`"
      )
    let pat = re(escapeRe(prefix) & "([\\w$]+)" & mid & "([\\w$]+)" & suffix)
    let maybeMatch = content.find(pat)
    if maybeMatch.isSome:
      let m = maybeMatch.get()
      let bounds = m.matchBounds
      let old = content[bounds.a .. bounds.b]
      let newShell =
        "(globalThis.__cuKwinMode?`The desktop shell is frontmost. Desktop icons, panels, launchers, and widgets belong to Plasma Shell. To interact with them, call request_access with exactly \"plasmashell\" in the apps array. If you need the file manager, request \"Dolphin\" separately. To interact with a different app, use open_application to bring it forward.`:" &
        old & ")"
      discard replaceLiteralFirst(content, old, newShell)
      echo "  [OK] 13b.kwin-shell-hint: kwin-wayland=plasmashell, regular/other=upstream wording"
      inc descChanges
      inc patchesApplied
    else:
      echo "  [FAIL] 13b.kwin-shell-hint desktop shell hint: not found"

  # 13b.kwin-shell-grant: shell grant predicate
  block:
    # v1.28929.0: upstream switched .some(...) (boolean) to .find(...) — the
    # caller now reads `.tier` off the returned granted app, so the kwin-mode
    # branch must likewise return the matching app object, not a boolean.
    # v1.32352.1: arrow arguments are parenthesised - `.find((e=>...))` - so
    # the wrapping parens are optional. The replacement emits unwrapped arrows,
    # which is equally valid JS.
    let pat =
      re"""(function [\w$]+\(([\w$]+),([\w$]+)\)\{)return \3===["`]darwin["`]\?\2\.find\(\(?([\w$]+)=>\4\.bundleId===([\w$]+)\)\)?:\2\.find\(\(?([\w$]+)=>\6\.bundleId\.toLowerCase\(\)===([\w$]+)\)\)?\}"""
    let n = replaceFirst(
      content,
      pat,
      proc(m: RegexMatch): string =
        let header = m.captures[0]
        let apps = m.captures[1]
        let plat = m.captures[2]
        let darwinIter = m.captures[3]
        let macConst = m.captures[4]
        let winIter = m.captures[5]
        let winConst = m.captures[6]
        header & "return " & plat & "===\"darwin\"?" & apps & ".find(" & darwinIter &
          "=>" & darwinIter & ".bundleId===" & macConst & "):globalThis.__cuKwinMode&&" &
          plat & "===\"linux\"?" & apps & ".find(" & darwinIter & "=>" & darwinIter &
          ".bundleId===\"plasmashell\"||" & darwinIter &
          ".bundleId===\"org.kde.plasmashell\"):" & apps & ".find(" & winIter & "=>" &
          winIter & ".bundleId.toLowerCase()===" & winConst & ")}",
    )
    if n >= 1:
      echo "  [OK] 13b.kwin-shell-grant: plasmashell satisfies shell access (kwin-wayland only)"
      inc descChanges
      inc patchesApplied
    else:
      echo "  [FAIL] 13b.kwin-shell-grant desktop shell grant predicate: not found"

  # 13b.kwin-shell-detect: shell detection
  # Function shape upstream:
  #   function NAME(arg){if(arg===MAC_CONST)return!0;if(!X||!Y)return!1;...}
  # We extend the early macOS-shell early-return with a kwin-mode plasmashell
  # check so the "is this the desktop shell?" predicate accepts plasmashell on
  # KDE Wayland too.
  block:
    let pat =
      re"""(function [\w$]+\(([\w$]+)\)\{)if\(\2===([\w$]+)\)return!0;(if\(![\w$]+\|\|![\w$]+\)return!1;)"""
    let n = replaceFirst(
      content,
      pat,
      proc(m: RegexMatch): string =
        let header = m.captures[0]
        let arg = m.captures[1]
        let macConst = m.captures[2]
        let winGuard = m.captures[3]
        header & "if(" & arg & "===" & macConst & "||globalThis.__cuKwinMode&&(" & arg &
          "===\"plasmashell\"||" & arg & "===\"org.kde.plasmashell\"))return!0;" &
          winGuard,
    )
    if n >= 1:
      echo "  [OK] 13b.kwin-shell-detect: plasmashell recognized as shell (kwin-wayland only)"
      inc descChanges
      inc patchesApplied
    else:
      echo "  [FAIL] 13b.kwin-shell-detect desktop shell detection: not found"

  # 13c: request_access apps — WM_CLASS for Linux
  block:
    # v1.46388.2: single-quoted literal (contains `"`); backtick kept as fallback.
    let old13c = [
      "'Application display names (e.g. \"Slack\", \"Calendar\") or bundle identifiers (e.g. \"com.tinyspeck.slackmacgap\"). Display names are resolved case-insensitively against installed apps.'",
      "`Application display names (e.g. \"Slack\", \"Calendar\") or bundle identifiers (e.g. \"com.tinyspeck.slackmacgap\"). Display names are resolved case-insensitively against installed apps.`",
    ]
    let new13c =
      "(process.platform===\"linux\"?" &
      "`Application names as shown in window titles, or WM_CLASS values " &
      "(e.g. \"firefox\", \"org.gnome.Nautilus\"). " &
      "On Linux all apps are auto-granted at full tier.`" & ":" &
      "`Application display names (e.g. \"Slack\", \"Calendar\") or bundle " &
      "identifiers (e.g. \"com.tinyspeck.slackmacgap\"). Display names are " &
      "resolved case-insensitively against installed apps.`)"
    if replaceLiteralFirstAny(content, old13c, new13c) == 1:
      echo "  [OK] 13c request_access apps: Linux identifiers"
      inc descChanges
      inc patchesApplied
    else:
      echo "  [FAIL] 13c request_access apps: not found"

  # 13d: open_application app identifier
  block:
    # v1.46388.2: single-quoted literal (contains `"`); backtick kept as fallback.
    let old13d = [
      "'Display name (e.g. \"Slack\") or bundle identifier (e.g. \"com.tinyspeck.slackmacgap\").'",
      "`Display name (e.g. \"Slack\") or bundle identifier (e.g. \"com.tinyspeck.slackmacgap\").`",
    ]
    let new13d =
      "(process.platform===\"linux\"?" &
      "`Application name or WM_CLASS (e.g. \"firefox\", \"nautilus\").`" & ":" &
      "`Display name (e.g. \"Slack\") or bundle identifier (e.g. \"com.tinyspeck.slackmacgap\").`)"
    if replaceLiteralFirstAny(content, old13d, new13d) == 1:
      echo "  [OK] 13d open_application app: Linux identifiers"
      inc descChanges
      inc patchesApplied
    else:
      echo "  [FAIL] 13d open_application app: not found"

  # 13e: open_application description — no allowlist on Linux.
  # v1.21459.0 reworded the description (added background/display-scope prose);
  # only the trailing allowlist sentence needs the Linux ternary. Anchored by
  # the ",inputSchema:" that follows the open_application tool description so it
  # hits the tool definition site, not the runtime error strings that reuse the
  # same sentence.
  block:
    # v1.32352.1: the em-dash is emitted as the six-char \u2014 escape (see
    # 13b.kwin-shell-hint). The re-emitted branch keeps the escape, which JS
    # decodes to the same character.
    let linuxSentence = "\"On Linux, all applications are directly accessible.\""
    let macSentence =
      "\"The target must already be in the session allowlist " &
      "\\u2014 call request_access first.\""
    # v1.46388.2: the description is a plain double-quoted string again, so a
    # `${}` interpolation would be emitted verbatim. Close the string and
    # concatenate the ternary instead; the sentence is preceded by a space
    # ("...brought to the front. "), so the split lands on a clean boundary.
    let old13eStr =
      "The target must already be in the session allowlist \\u2014 call request_access first.\",inputSchema:"
    let new13eStr =
      "\"+(process.platform===\"linux\"?" & linuxSentence & ":" & macSentence &
      "),inputSchema:"
    # <=v1.40609.0: backtick template - interpolate inside it.
    let old13eTpl =
      "The target must already be in the session allowlist \\u2014 call request_access first.`,inputSchema:"
    let new13eTpl =
      "${process.platform===\"linux\"?" & linuxSentence & ":" & macSentence &
      "}`,inputSchema:"
    if replaceLiteralFirst(content, old13eStr, new13eStr) == 1 or
        replaceLiteralFirst(content, old13eTpl, new13eTpl) == 1:
      echo "  [OK] 13e open_application: no allowlist on Linux"
      inc descChanges
      inc patchesApplied
    else:
      echo "  [FAIL] 13e open_application: not found"

  # 13f: screenshot description — clean on Linux
  block:
    # v1.32352.1: em-dash emitted as the \u2014 escape (see 13e).
    # v1.46388.2: double-quoted literal; backtick kept as fallback.
    let old13f = [
      "\"Take a screenshot of the primary display. On this platform, screenshots are NOT filtered \\u2014 all open windows are visible. Input actions targeting apps not in the session allowlist are rejected.\"",
      "`Take a screenshot of the primary display. On this platform, screenshots are NOT filtered \\u2014 all open windows are visible. Input actions targeting apps not in the session allowlist are rejected.`",
    ]
    let new13f =
      "(process.platform===\"linux\"?" &
      "\"Take a screenshot of the primary display. All open windows are visible.\"" & ":" &
      "\"Take a screenshot of the primary display. On this platform, " &
      "screenshots are NOT filtered \\u2014 all open windows are visible. " &
      "Input actions targeting apps not in the session allowlist are rejected.\")"
    if replaceLiteralFirstAny(content, old13f, new13f) == 1:
      echo "  [OK] 13f screenshot: clean description on Linux"
      inc descChanges
      inc patchesApplied
    else:
      echo "  [FAIL] 13f screenshot: not found"

  # 13g: screenshot suffix — no allowlist error on Linux
  block:
    let pat =
      re"""([\w$]+)\+["`] Returns an error if the allowlist is empty\. The returned image is what subsequent click coordinates are relative to\.["`]"""
    let n = replaceFirst(
      content,
      pat,
      proc(m: RegexMatch): string =
        let v = m.captures[0]
        &"{v}+(process.platform===\"linux\"" &
          "?\" The returned image is what subsequent click coordinates are relative to.\"" &
          ":\" Returns an error if the allowlist is empty. The returned image is what subsequent click coordinates are relative to.\")",
    )
    if n >= 1:
      echo "  [OK] 13g screenshot suffix: no allowlist error on Linux"
      inc descChanges
      inc patchesApplied
    else:
      echo "  [FAIL] 13g screenshot suffix: not found"

  if descChanges > 0:
    inc changes, descChanges
    echo &"  [OK] {descChanges}/12 description patches applied (7 regular + 5 kwin-wayland KDE)"
  else:
    echo "  [FAIL] No description patches applied (descriptions unchanged)"

  # ─── Patch 14: Linux-aware CU system prompt ──────────────────────────
  # 14a: separate filesystems → 3-way same-filesystem wording (2 occurrences)
  block:
    # v1.32352.1: em-dash emitted as the \u2014 escape (see 13e).
    let sepOldFull2 =
      "**Separate filesystems.** Computer-use actions (clicks, typing, clipboard writes) happen on the user's real computer \\u2014 a different system from your sandbox. "
    let sepCount = countOccurrences(content, sepOldFull2)
    if sepCount >= 2:
      let sepNewFull =
        "${process.platform===\"linux\"?(globalThis.__cuKwinMode" &
        "?\"**Same filesystem.** Computer-use actions and your CLI tools operate on the same Linux machine. " &
        "Files you create are directly accessible to desktop applications, and files selected or edited in " &
        "desktop apps are on the same machine you can read from the CLI. " & "\"" &
        ":\"**Same filesystem.** Computer-use actions and your CLI tools operate on the same Linux machine. " &
        "There is no sandbox \\u2014 files you create are directly accessible to desktop applications and vice versa. " &
        "\")" &
        ":\"**Separate filesystems.** Computer-use actions (clicks, typing, clipboard writes) " &
        "happen on the user's real computer \\u2014 a different system from your sandbox. " &
        "\"}"
      discard replaceLiteralAll(content, sepOldFull2, sepNewFull)
      echo &"  [OK] 14a separate filesystems: 3-way replace, {sepCount} occurrences"
      inc changes, sepCount
      inc patchesApplied
    else:
      echo &"  [FAIL] 14a separate filesystems: expected 2 occurrences, found {sepCount}"

  # 14b: Finder/Photos/System Settings → generic Linux app terms
  block:
    let appsOld = "Maps, Notes, Finder, Photos, System Settings"
    let appsNew =
      "${process.platform===\"linux\"?\"the file manager, image viewer, terminal emulator, system settings\":\"Maps, Notes, Finder, Photos, System Settings\"}"
    if replaceLiteralFirst(content, appsOld, appsNew) == 1:
      echo "  [OK] 14b app names: replaced macOS apps with Linux-generic terms"
      inc changes
      inc patchesApplied
    else:
      echo "  [FAIL] 14b app names: 'Maps, Notes, Finder, Photos, System Settings' not found"

  # 14c: File Explorer/Finder → 3-way (Dolphin/Files/Finder)
  block:
    # v1.46388.2: double-quoted literals; backtick kept as fallback. The
    # replacement re-emits its own quotes, so both variants share it.
    let fmOld = ["\"File Explorer\":\"Finder\"", "`File Explorer`:`Finder`"]
    let fmNew =
      "\"File Explorer\":process.platform===\"linux\"?(globalThis.__cuKwinMode?\"Dolphin\":\"Files\"):\"Finder\""
    if replaceLiteralFirstAny(content, fmOld, fmNew) == 1:
      echo "  [OK] 14c file manager name: 3-way (kwin-wayland=Dolphin, regular=Files, other=Finder)"
      inc changes
      inc patchesApplied
    else:
      echo "  [FAIL] 14c file manager name: pattern not found"

  # 14d (kwin-wayland): env prompt KDE augmentation
  block:
    let envPat =
      re"""You have a computer-use MCP available \(tools named \\`mcp__computer-use__\*\\`\)\. It lets you take screenshots of the user's desktop and control it with mouse clicks, keyboard input, and scrolling\."""
    let envNew =
      "You have a computer-use MCP available (tools named \\`mcp__computer-use__*\\`). It lets you take " &
      "screenshots of the user's desktop and control it with mouse clicks, keyboard input, and scrolling." &
      "${globalThis.__cuKwinMode?' This computer is running Linux with KDE Plasma. The desktop shell is " &
      "plasmashell. The file manager is Dolphin.':''}"
    let envCount = replaceAllRegex(
      content,
      envPat,
      proc(m: RegexMatch): string =
        envNew,
    )
    if envCount > 0:
      let plural = if envCount != 1: "s" else: ""
      echo &"  [OK] 14d CU env prompt: kwin-wayland-only KDE suffix ({envCount} occurrence{plural})"
      inc changes, envCount
      inc patchesApplied
    else:
      echo "  [FAIL] 14d CU env prompt: environment sentence anchor not found"

  if patchesApplied < EXPECTED_PATCHES:
    raise newException(
      ValueError,
      &"Only {patchesApplied}/{EXPECTED_PATCHES} patches applied — check [FAIL] messages above",
    )

  if content != original:
    echo &"  [PASS] {patchesApplied}/{EXPECTED_PATCHES} sub-patches applied ({changes} content changes)"
  else:
    raise newException(ValueError, "No changes made")

  return content

when isMainModule:
  if paramCount() != 1:
    stderr.writeLine "Usage: fix_computer_use_linux <path_to_index.js>"
    quit(1)
  let file = paramStr(1)
  echo "=== Patch: fix_computer_use_linux ==="
  echo &"  Target: {file}"
  let input = readFile(file)
  let output = apply(input)
  writeFile(file, output)
