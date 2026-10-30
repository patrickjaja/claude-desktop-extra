# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Custom models: list models served by an Anthropic-compatible endpoint
# (DeepSeek's /anthropic API is the reference) in the Code tab's model picker
# NEXT TO Anthropic's own, and route the CLI's requests for them to that
# endpoint with the provider's key. Additive: the subscription login and every
# Claude model stay as they are - unlike 3p/managed-settings mode, which is
# exclusive. Driven by the `customModels` key of claude-desktop-extra.jsonc.
#
# Four sub-patches:
#   A. Prefix js/custom_models_main.js (with js/custom_models_preload.js
#      embedded) after "use strict";. It reads the config, attaches the CDP
#      Fetch domain to claude.ai webContents and appends our entries to the
#      `model_selector_config` of the /api/bootstrap RESPONSE (the page builds
#      the picker from it and reports the ids back to the app), and owns the
#      Settings switch IPC.
#   B. Splice `cliEnv(<base env>)` into the Code session manager's
#      `buildSessionEnv(scope, baseConfig, ...)`, which derives the session env
#      (`let u=await h(n.sessionEnv)`) at every Code session spawn - the main
#      session and its forks, SSH included (sub-patch D takes it back out
#      there). Not the base env builder itself: upstream memoises that for
#      30 s (BASE_CONFIG_TTL_MS), which made the switch reach new sessions
#      late, and its temporary config-loading queries run no model. The base
#      env is passed in, so cliEnv() builds on what upstream would send - the
#      user's Code-tab environment variables included. Anchored on the method
#      name, which the minifier keeps (the method forwards to a free function
#      since v4.4212.0; the body is found under the name it forwards to), and
#      the `.sessionEnv` argument of the base config parameter. When the feature is off cliEnv() contributes {} and
#      the session is exactly upstream's; when on it adds BUN_OPTIONS=
#      --preload=<userData>/custom-models/preload.js (the Claude Code binary is
#      a compiled Bun program and honours BUN_OPTIONS), the routes.json path and
#      the routes without their keys in CDB_CUSTOM_MODELS_JSON. The Cowork
#      session's env builder (`[LAM]`) is deliberately not touched.
#   C. Route two fields of the session's `initialize` control request (the
#      one the app sends the CLI when a Code session opens: `{subtype:
#      "initialize",hooks,...,appendSystemPrompt:this.initConfig?.
#      appendSystemPrompt,...,agents:this.initConfig?.agents,...}`, in a
#      code-split chunk) through `agents()` / `appendSystemPrompt()` of the
#      main module. Those are the Agent SDK's programmatic sub-agent
#      definitions and system-prompt suffix: one sub-agent type per custom
#      model and one line that tells Claude the models exist. That request
#      belongs to the Agent SDK's generic Query, which every SDK session
#      goes through (Cowork, Dispatch, SSH...), so the query's transport is
#      passed along: its options.env is the env the CLI was started with,
#      and only a session spawned with cliEnv() - the local Code session,
#      the one kind with the preload - carries CDB_CUSTOM_MODELS_JSON. Each
#      function returns its input untouched for any other session and when
#      the feature is off. The two shapes that check relies on - the Query
#      keeping `this.transport`, the transport keeping `options.env` - are
#      asserted here (exactly once each), so a move fails the build.
#   D. Call `remoteSpawn(options)` of the main module at the start of
#      `configureSSHSpawn(options, ...)`, the Code session manager's method
#      that turns a session into an SSH (or WSL) one. Its env is the same
#      Code session env B fed, and the remote spawner forwards every
#      CLAUDE_*/ANTHROPIC_* variable to a host that has no preload:
#      remoteSpawn() takes B's additions back out, which also leaves C
#      nothing to hand that session.
#
# Break risk: VERY LOW for A (stable "use strict"; anchor). LOW for B - a
# method name and a property name with an exact-count check; if upstream
# reshapes that method the build fails loud here. To find it again:
# grep -ao "buildSessionEnv([^)]*){.\{0,60\}" across index*.js, then
# grep -ao "async function <name>(.\{0,80\}" for the body it forwards to.
# LOW for C - two literal anchors plus the two shape asserts, each expected
# exactly once across the concatenated bundle; to find them again:
# rg 'subtype:"initialize"', rg 'this.transport=', rg 'updateEnv('.
# LOW for D - a method name, which the minifier keeps; rg 'configureSSHSpawn('.

import std/[os, strutils]
import regex

const MAIN_JS = staticRead("../../js/custom_models_main.js")
const PRELOAD_JS = staticRead("../../js/custom_models_preload.js")

const MARKER = "__CDB_CUSTOM_MODELS__"
const PLACEHOLDER = "\"__CDB_CM_PRELOAD_SRC__\""
# B. The session env goes through upstream's managed-network-env helper
# (`let d=await t.hd(r.sessionEnv)`; it fills managed proxy/CA variables the
# env lacks, then enforces managed proxy settings). We hand that helper
# `{...r.sessionEnv,...cliEnv(r.sessionEnv)}` instead, so managed policy still
# has the last word; cliEnv() sets no network variables.
# Since v4.4212.0 the method only forwards, prepending an identity thunk:
#   buildSessionEnv(...e){return JO((()=>({organizationUuid:..,accountUuid:..})),...e)}
#   async function JO(e,n,r,i,...,u=!1){let d=await t.hd(r.sessionEnv),...
# so the base config, the method's second argument, is the function's THIRD
# parameter. The method name survives minification; the function's name does
# not, so it is read from the forwarder and the body is matched under that
# name. Trailing parameters may carry a default (`u=!1`).
proc envSplice(base: string): string =
  "{..." & base &
    ".sessionEnv,...((globalThis.__cdbCustomModels&&globalThis.__cdbCustomModels.cliEnv(" &
    base & ".sessionEnv))||{})}"

# Group 0 = the rest parameter, group 1 = the function, group 2 = the spread.
let envForwarderRe =
  re2"""buildSessionEnv\(\.\.\.([\w$]+)\)\{return ([\w$]+)\(\(\(\)=>\(\{[^{}]*\}\)\),\.\.\.([\w$]+)\)\}"""

proc identRe(name: string): string =
  name.replace("$", "\\$")

proc envSiteRe(fn: string): Regex2 =
  re2(
    "(async function " & identRe(fn) &
      """\([\w$]+,[\w$]+,([\w$]+)(?:,[\w$]+(?:=[^,(){}]+)?)*\)\{let [\w$]+=await [\w$]+(?:\.[\w$]+)?\()([\w$]+)\.sessionEnv\)"""
  )

# Our injected end-state, asserted positively (Rule 6): the splice, made with
# that same third parameter, as the helper's argument.
proc envEndStateRe(fn: string): Regex2 =
  re2(
    "async function " & identRe(fn) &
      """\([\w$]+,[\w$]+,([\w$]+)(?:,[\w$]+(?:=[^,(){}]+)?)*\)\{let [\w$]+=await [\w$]+(?:\.[\w$]+)?\(\{\.\.\.([\w$]+)\.sessionEnv,\.\.\.\(\(globalThis\.__cdbCustomModels&&globalThis\.__cdbCustomModels\.cliEnv\(([\w$]+)\.sessionEnv\)\)\|\|\{\}\)\}\)"""
  )

# The function buildSessionEnv forwards to, or "" unless exactly one forwarder.
proc envForwardee(s: string): string =
  var names: seq[string]
  for m in s.findAll(envForwarderRe):
    if s[m.group(0)] == s[m.group(2)]:
      names.add s[m.group(1)]
  if names.len == 1:
    names[0]
  else:
    ""

proc envEndStateCount(s, fn: string): int =
  for m in s.findAll(envEndStateRe(fn)):
    let p = s[m.group(0)]
    if s[m.group(1)] == p and s[m.group(2)] == p:
      inc result

# C. The two initialize-request fields, as the minifier spells them, each
# routed with the query's transport (see the header).
const INIT_SITES = [
  (
    "appendSystemPrompt:this.initConfig?.appendSystemPrompt",
    "appendSystemPrompt:((globalThis.__cdbCustomModels&&globalThis.__cdbCustomModels.appendSystemPrompt)||function(x){return x})(this.initConfig?.appendSystemPrompt,this.transport)",
  ),
  (
    "agents:this.initConfig?.agents",
    "agents:((globalThis.__cdbCustomModels&&globalThis.__cdbCustomModels.agents)||function(x){return x})(this.initConfig?.agents,this.transport)",
  ),
]
# What sessionRouted() reads at run time: the Query's transport field and
# the transport's options.env. Asserted before C is applied.
let transportShapeRes = [
  re2"""\{this\.transport=[\w$]+,this\.isSingleUserTurn=""",
  re2"""updateEnv\([\w$]+\)\{this\.options\.env\?Object\.assign\(this\.options\.env,""",
]

proc initSitesDone(s: string): int =
  ## How many of the C sites carry our end-state (0, 1 or 2).
  for site in INIT_SITES:
    if site[1] in s:
      inc result

# D. configureSSHSpawn(options, ...): the method name survives minification,
# its parameter names do not.
const REMOTE_CALL =
  "((globalThis.__cdbCustomModels&&globalThis.__cdbCustomModels.remoteSpawn)||function(){})"
let sshSiteRe = re2"""(async configureSSHSpawn\(([\w$]+)(?:,[\w$]+)*\)\{)"""
let sshEndStateRe =
  re2"""async configureSSHSpawn\(([\w$]+)(?:,[\w$]+)*\)\{\(\(globalThis\.__cdbCustomModels&&globalThis\.__cdbCustomModels\.remoteSpawn\)\|\|function\(\)\{\}\)\(([\w$]+)\);"""

proc sshEndStateCount(s: string): int =
  ## Our call, made with the method's own first parameter.
  for m in s.findAll(sshEndStateRe):
    if s[m.group(0)] == s[m.group(1)]:
      inc result

const EXPECTED_PATCHES = 4 # A, B, C, D

proc escapeJs(s: string): string =
  result = s
  result = result.replace("\\", "\\\\")
  result = result.replace("\"", "\\\"")
  result = result.replace("\n", "\\n")
  result = result.replace("\r", "")

proc buildInjection(): string =
  if PLACEHOLDER notin MAIN_JS:
    raise
      newException(ValueError, "custom_models_main.js lost its preload-src placeholder")
  MAIN_JS.replace(PLACEHOLDER, "\"" & escapeJs(PRELOAD_JS) & "\"")

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0

  # A. main module injection. Idempotency: positive end-state (Rule 6).
  if MARKER in result:
    echo "  [OK] custom models: main module already present (idempotent)"
    inc patchesApplied
  else:
    let injection = buildInjection()
    let strictPrefix = "\"use strict\";"
    if result.startsWith(strictPrefix):
      result = strictPrefix & injection & result[strictPrefix.len .. ^1]
      echo "  [OK] custom models: main module injected after \"use strict\""
    else:
      result = injection & result
      echo "  [OK] custom models: main module prepended"
    if MARKER in result:
      inc patchesApplied
    else:
      echo "  [FAIL] custom models: main module not present after injection"

  # B. CLI environment splice. Exactly one buildSessionEnv forwarder, and
  # exactly one body under the name it forwards to.
  let envFn = envForwardee(result)
  let already =
    if envFn == "":
      0
    else:
      envEndStateCount(result, envFn)
  if envFn == "":
    echo "  [FAIL] custom models: expected exactly 1 `buildSessionEnv(...e){return F((()=>({..})),...e)}` forwarder" &
      " - the Code session env builder moved; re-audit sub-patch B"
  elif already == 1:
    echo "  [OK] custom models: CLI env splice already present (idempotent)"
    inc patchesApplied
  elif already > 1:
    echo "  [FAIL] custom models: env splice present " & $already &
      " times, expected 1 - re-audit"
  else:
    var count = 0
    var sameParam = true
    result = result.replace(
      envSiteRe(envFn),
      proc(m: RegexMatch2, s: string): string =
        inc count
        if s[m.group(1)] != s[m.group(2)]:
          sameParam = false
        s[m.group(0)] & envSplice(s[m.group(2)]) & ")",
    )
    if count != 1 or not sameParam:
      echo "  [FAIL] custom models: expected exactly 1 `async function " & envFn &
        "(_,_,r,...){let u=await h(r.sessionEnv)`, found " & $count &
        (if sameParam: "" else: " spreading another name") &
        " - the Code session env copy moved; re-audit sub-patch B"
    elif envEndStateCount(result, envFn) != 1:
      echo "  [FAIL] custom models: env splice missing after replacement"
    else:
      echo "  [OK] custom models: cliEnv() spliced into buildSessionEnv's body " & envFn &
        " (1 match)"
      inc patchesApplied

  # C. Sub-agent definitions and the system-prompt suffix of the initialize
  # request. Both sites or nothing: half a patch would list the types in the
  # system prompt without defining them, or the reverse. And only while the
  # transport shape sessionRouted() reads is where it expects.
  var shapeOk = true
  for r in transportShapeRes:
    let n = result.findAll(r).len
    if n != 1:
      echo "  [FAIL] custom models: the SDK transport shape moved (" & $n &
        " matches, expected 1) - " &
        "sessionRouted() reads Query.transport.options.env; re-audit sub-patch C"
      shapeOk = false
  let done = initSitesDone(result)
  if not shapeOk:
    discard
  elif done == INIT_SITES.len:
    echo "  [OK] custom models: initialize request already routed (idempotent)"
    inc patchesApplied
  elif done > 0:
    echo "  [FAIL] custom models: " & $done & "/" & $INIT_SITES.len &
      " initialize sites already patched - re-audit"
  else:
    var siteOk = true
    for site in INIT_SITES:
      let n = result.count(site[0])
      if n != 1:
        echo "  [FAIL] custom models: expected exactly 1 initialize site `" & site[0] &
          "`, found " & $n &
          " - the session initialize request moved; re-audit sub-patch C"
        siteOk = false
    if siteOk:
      var patched = result
      for site in INIT_SITES:
        patched = patched.replace(site[0], site[1])
      if initSitesDone(patched) != INIT_SITES.len:
        echo "  [FAIL] custom models: initialize sites missing after replacement"
      else:
        result = patched
        echo "  [OK] custom models: agents() and appendSystemPrompt() routed through the initialize request (2 sites)"
        inc patchesApplied

  # D. remoteSpawn() at the start of configureSSHSpawn. Exactly one site.
  let sshDone = sshEndStateCount(result)
  if sshDone == 1:
    echo "  [OK] custom models: remoteSpawn() already called by configureSSHSpawn (idempotent)"
    inc patchesApplied
  elif sshDone > 1:
    echo "  [FAIL] custom models: remoteSpawn() call present " & $sshDone &
      " times, expected 1 - re-audit"
  else:
    var count = 0
    result = result.replace(
      sshSiteRe,
      proc(m: RegexMatch2, s: string): string =
        inc count
        s[m.group(0)] & REMOTE_CALL & "(" & s[m.group(1)] & ");",
    )
    if count != 1:
      echo "  [FAIL] custom models: expected exactly 1 `async configureSSHSpawn(...){`, found " &
        $count & " - the SSH session setup moved; re-audit sub-patch D"
    elif sshEndStateCount(result) != 1:
      echo "  [FAIL] custom models: remoteSpawn() call missing after replacement"
    else:
      echo "  [OK] custom models: remoteSpawn() called at the start of configureSSHSpawn (1 match)"
      inc patchesApplied

  if patchesApplied < EXPECTED_PATCHES:
    echo "  [FAIL] Only " & $patchesApplied & "/" & $EXPECTED_PATCHES &
      " patches applied"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_feature_custom_models <path_to_index.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: add_feature_custom_models ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] custom models applied"
  else:
    let envFn = envForwardee(output)
    if MARKER notin output or envFn == "" or envEndStateCount(output, envFn) != 1 or
        initSitesDone(output) != INIT_SITES.len or sshEndStateCount(output) != 1:
      echo "  [FAIL] No changes made and injection is absent"
      quit(1)
    echo "  [OK] Already applied (no changes needed)"
