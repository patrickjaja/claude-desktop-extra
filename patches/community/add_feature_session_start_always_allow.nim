# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
# Opt-in (Settings -> Extra -> Community Features -> "Native dialog with 'Allow
# always' for starting other sessions", off by default): at the broker's
# ordinary card sink for start_session, show a native dialog parented to the
# main window with Deny / Allow once / Allow always, where "always" is scoped to
# the asking session's project and its default destination. Switch off,
# anything ineligible, no visible window or any failure before an answer ->
# upstream's own in-chat card. Never changes the SDK's always_ask policy or any
# start_session host check.
#
# Layout assertion: the orchestrator stages index.js + every chunk as ONE file
# split by `\n/*__CDB_SPLIT__<name>__*/\n` markers. The injection runs inside
# the broker's chunk and calls the `t` namespace (its `require("./index.chunk-
# ...")`); every export it calls must be defined in THAT chunk, so a moved
# export fails the build instead of throwing at run time.
import std/[os, strutils]
import regex

const helper = staticRead("../../js/session_start_permission.js")
const marker = "/*__CDB_SESSION_START_PERMISSION__*/"
const SPLIT = "\n/*__CDB_SPLIT__"
const SPLIT_END = "__*/\n"

type Part = tuple[name: string, a: int, b: int]

proc partAt(input: string, at: int): Part =
  ## The staged chunk part holding offset `at`; a = first byte after its marker.
  let p = input.rfind(SPLIT, last = at)
  if p == -1:
    raise newException(
      ValueError,
      "session-start: input is not a staged chunk concat (no split marker before the broker)",
    )
  let nameEnd = input.find(SPLIT_END, start = p + SPLIT.len)
  if nameEnd == -1 or nameEnd > at:
    raise newException(
      ValueError, "session-start: malformed split marker before the broker"
    )
  var e = input.find(SPLIT, start = at)
  if e == -1:
    e = input.len
  (input[p + SPLIT.len ..< nameEnd], nameEnd + SPLIT_END.len, e)

proc partNamed(input, name: string): Part =
  let m = SPLIT & name & SPLIT_END
  if input.count(m) != 1:
    raise newException(
      ValueError, "session-start: staged part " & name & " must exist exactly once"
    )
  let a = input.find(m) + m.len
  var e = input.find(SPLIT, start = a)
  if e == -1:
    e = input.len
  (name, a, e)

proc exportTarget(part: string, name: string): string =
  ## Local name behind `Object.defineProperty(exports,"<name>",...)`, once.
  var hits = 0
  for m in part.findAll(
    re2"""Object\.defineProperty\(exports,"([\w$]+)",\{enumerable:!0,get:function\(\)\{return ([\w$]+)\}\}\)"""
  ):
    if part[m.group(0)] == name:
      result = part[m.group(1)]
      inc hits
  if hits != 1:
    raise newException(
      ValueError,
      "session-start: export " & name &
        " must be defined once in the broker's namespace chunk (" & $hits & ")",
    )

proc apply*(input: string): string =
  let headers = input.findAll(
    re2"async handleToolPermission\(([\w$]+),([\w$]+),([\w$]+),([\w$]+),([\w$]+),([\w$]+)\)\{let ([\w$]+)=this\.config\.getSession\("
  )
  if headers.len != 1:
    raise newException(ValueError, "session-start broker header must match once")
  let h = headers[0]
  let sid = input[h.group(0)]
  let tool = input[h.group(1)]
  let data = input[h.group(2)]
  let signal = input[h.group(4)]
  let options = input[h.group(5)]
  let session = input[h.group(6)]
  let head =
    input[headers[0].boundaries.a .. min(input.high, headers[0].boundaries.a + 2500)]
  # Every namespace export the hook calls is resolved from upstream's own call
  # site of the same check (export names are re-minified each release).
  let namespaces = head.findAll(re2"\.viaHostCliLauncher===!0\|\|([\w$]+)\.([\w$]+)\(")
  if namespaces.len != 1:
    raise newException(ValueError, "session-start policy namespace must match once")
  let api = head[namespaces[0].group(0)]
  let hostCliFn = head[namespaces[0].group(1)]
  # The broker's chunk and the chunk its `api` namespace is required from.
  let brokerPart = partAt(input, h.boundaries.a)
  let broker = input[brokerPart.a ..< brokerPart.b]
  var apiChunk = ""
  var apiRequires = 0
  for m in broker.findAll(
    re2"""(?:^|[^\w$.])([\w$]+)=require\("\./(index[\w.-]*\.js)"\)"""
  ):
    if broker[m.group(0)] == api:
      apiChunk = broker[m.group(1)]
      inc apiRequires
  if apiRequires != 1:
    raise newException(
      ValueError,
      "session-start: broker namespace " & api & " must be required from one chunk (" &
        $apiRequires & ")",
    )
  let apiPart = partNamed(input, apiChunk)
  let apiSrc = input[apiPart.a ..< apiPart.b]
  proc brokerCall(hits: seq[RegexMatch2], label: string): string =
    ## The `api.<export>` upstream's broker calls at one fixed check site.
    if hits.len != 1 or broker[hits[0].group(0)] != api:
      raise newException(
        ValueError,
        "session-start: broker's " & label & " check must call " & api & " once (" &
          $hits.len & ")",
      )
    broker[hits[0].group(1)]

  # Organization requires approval: forceAsk's `return api.X(e)?"org_requires_approval"`.
  let hostPolicyFn = brokerCall(
    broker.findAll(
      re2"""if\([\w$]+!=="ordinary"\)return ([\w$]+)\.([\w$]+)\([\w$]+\)\?"org_requires_approval":"""
    ),
    "org_requires_approval",
  )
  # The session's own ask rules/hooks: `??=api.X(s?.query,tool).then(...own_ask_rules_read`.
  let ownAskFn = brokerCall(
    broker.findAll(
      re2"""\?\?=([\w$]+)\.([\w$]+)\([\w$]+\?\.query,[\w$]+\)\.then\(\([\w$]+=>\{[^{}]{0,100}"desktop_ccd_own_ask_rules_read","""
    ),
    "own ask rules",
  )
  # Unattended session: firstUseSidePlace's `||api.X(sid,(e=>this.config.getSession(e)))`.
  let unattendedFn = brokerCall(
    broker.findAll(
      re2"""\}async firstUseSidePlace\([\w$]+,[\w$]+,[\w$]+\)\{if\(!\([^{}]*?\|\|([\w$]+)\.([\w$]+)\([\w$]+,\([\w$]+=>this\.config\.getSession\([\w$]+\)\)\)\)\)try\{"""
    ),
    "unattended",
  )
  for name in [hostCliFn, ownAskFn, hostPolicyFn, unattendedFn]:
    let local = exportTarget(apiSrc, name)
    if apiSrc.count("function " & local & "(") != 1:
      raise newException(
        ValueError,
        "session-start: " & api & "." & name & " -> " & local &
          " is not defined once in " & apiChunk,
      )
  # The main window: `V=new u.BrowserWindow(e),zi(V.webContents,Li.MAIN_WINDOW)`,
  # and the one export that returns it.
  var mainVar = ""
  var mainHits = 0
  for m in apiSrc.findAll(
    re2"""(?:^|[^\w$.])([\w$]+)=new [\w$]+\.BrowserWindow\([\w$]+\),[\w$]+\(([\w$]+)\.webContents,[\w$]+\.MAIN_WINDOW\)"""
  ):
    if apiSrc[m.group(0)] == apiSrc[m.group(1)]:
      mainVar = apiSrc[m.group(0)]
      inc mainHits
  if mainHits != 1:
    raise newException(
      ValueError,
      "session-start: MAIN_WINDOW BrowserWindow not found once in " & apiChunk,
    )
  var mainExport = ""
  var mainExports = 0
  for m in apiSrc.findAll(
    re2"""Object\.defineProperty\(exports,"([\w$]+)",\{enumerable:!0,get:function\(\)\{return ([\w$]+)\}\}\)"""
  ):
    if apiSrc[m.group(1)] == mainVar:
      mainExport = apiSrc[m.group(0)]
      inc mainExports
  if mainExports != 1:
    raise newException(
      ValueError,
      "session-start: the MAIN_WINDOW variable must be exported once from " & apiChunk &
        " (" & $mainExports & ")",
    )
  for meth in [
    "firstUseSidePlace(", "forceAskVerdict(", "internalNameProvenanceVerdict("
  ]:
    if broker.count("}" & meth) + broker.count("}async " & meth) != 1:
      raise newException(
        ValueError,
        "session-start: broker method " & meth & ") not found once in " & brokerPart.name,
      )
  # Resolve the bundle's own permission-rule matcher, not a second wildcard parser.
  let matchers = input.findAll(
    re2"""function ([\w$]+)\([\w$]+,[\w$]+\)\{let [\w$]+=[\w$]+\.trim\(\)\.split\("\("\)\[0\]\.trim\(\),[\w$]+=[\w$]+\.indexOf\("__",5\),"""
  )
  if matchers.len != 1:
    raise newException(ValueError, "session-start native rule matcher must match once")
  let matcherName = input[matchers[0].group(0)]
  var matcherExport = ""
  var matcherExports = 0
  for m in input.findAll(
    re2"""Object\.defineProperty\(exports,"([\w$]+)",\{enumerable:!0,get:function\(\)\{return ([\w$]+)\}\}\)"""
  ):
    if input[m.group(1)] == matcherName:
      matcherExport = input[m.group(0)]
      inc matcherExports
  if matcherExports != 1:
    raise
      newException(ValueError, "session-start native matcher export must match once")
  if exportTarget(apiSrc, matcherExport) != matcherName or
      apiSrc.count("function " & matcherName & "(") != 1:
    raise newException(
      ValueError, "session-start: native rule matcher is not exported from " & apiChunk
    )
  let startGates = input.findAll(
    re2"""function ([\w$]+)\([\w$]+,[\w$]+,[\w$]+,[\w$]+,[\w$]+,[\w$]+\)\{if\(![\w$]+\.has\([\w$]+\)[^{}]*;return [\w$]+\.[\w$]+\([\w$]+\)\|\|[\w$]+\([\w$]+,[\w$]+,[\w$]+\)\|\|[\w$]+\([\w$]+,[\w$]+,[\w$]+\)>=10\}"""
  )
  if startGates.len != 1:
    raise newException(
      ValueError, "session-start native continuation/count gate must match once"
    )
  let startGate = input[startGates[0].group(0)]
  if startGates[0].boundaries.a < brokerPart.a or
      startGates[0].boundaries.b >= brokerPart.b:
    raise newException(
      ValueError,
      "session-start: native start gate is not in the broker's chunk " & brokerPart.name,
    )
  let anchors = input.findAll(
    re2"let ([\w$]+)=\(0,([\w$]+)\.randomUUID\)\(\),([\w$]+)=([\w$]+)\(([\w$]+)\?\.toolUseID\),"
  )
  var hits = 0
  var anchor = ""
  for a in anchors:
    if input[a.group(4)] == options and a.boundaries.a > h.boundaries.a and
        a.boundaries.b < brokerPart.b:
      inc hits
      anchor = input[a.boundaries]
  if hits != 1:
    raise newException(ValueError, "session-start native card sink must match once")
  let o = options
  proc keep(cond, token: string): string =
    ## One refusal: when `cond` holds, log the fixed token once and keep the card.
    "if(" & cond & ")return __cdbStartKeep(" & token & ");"

  proc tok(token: string): string =
    "\"" & token & "\""

  let eligibility =
    # Called by the helper as eligible() before the dialog and eligible(true) for the
    # post-answer recheck; only the first call logs, one line per refused ask.
    "async(__cdbStartRecheck)=>{let __cdbStartKeep=__cdbReason=>{if(__cdbStartRecheck!==true)try{globalThis.__cdbDiag?.(\"[session-start-always-allow] card kept: \"+__cdbReason)}catch(__cdbE){}return false}," &
    "__cdbStartTok=__cdbV=>typeof __cdbV===\"string\"&&/^[A-Za-z][\\w-]{0,39}$/.test(__cdbV)?__cdbV:typeof __cdbV;" &
    # Other tools reach this sink too: silent, never logged.
    "if(" & tool & "!==\"mcp__ccd_session__start_session\")return false;" &
    "let __cdbStartPlace=await this.firstUseSidePlace(" & sid & "," & tool & "," & data &
    ");" &
    # __cdbStartPlaceAsk: the ask is only the first-use folder sentence. The CLI folds several
    # PreToolUse ask results into one (last wins), so a hook ask may arrive here and is answered
    # in the native dialog; the person is still asked. User ask rules and managed policy keep the card.
    "let __cdbStartPlaceAsk=" & data &
    "?.cwd!==undefined&&__cdbStartPlace!==undefined&&typeof __cdbStartPlace.sentence===\"string\"&&" &
    o & "?.decisionReason===__cdbStartPlace.sentence&&(" & o &
    "?.decisionReasonType===\"hook\"||" & o & "?.decisionReasonType===undefined);" &
    # __cdbStartPlaceOrdinary: upstream's ordinary card (no reason, or the verified
    # server-policy rule reason below) for an explicit local folder first used by the
    # asking session. Upstream's outer canUseTool grants that place after ANY allow
    # (grantSidePlace), so this dialog's answer is the same folder consent.
    "let __cdbStartPlaceOrdinary=__cdbStartPlace!==undefined&&typeof __cdbStartPlace.sentence===\"string\"&&typeof " &
    data & "?.cwd===\"string\"&&" & data & ".cwd.startsWith(\"/\")&&" & o &
    "!==undefined&&" & o & ".handedToPerson!==true&&((" & o &
    ".decisionReason===undefined&&" & o & ".decisionReasonType===undefined)||" & o &
    ".decisionReasonType===\"rule\");" & keep(o & "===undefined", tok("gate:options")) &
    keep(session & "===undefined", tok("gate:session")) &
    keep(
      "!(" & o & ".decisionReasonType===undefined||" & o &
        ".decisionReasonType===\"rule\"||__cdbStartPlaceAsk)",
      "\"gate:decisionReasonType=\"+__cdbStartTok(" & o & ".decisionReasonType)",
    ) &
    keep(
      "!(" & o & ".forceAskCause===undefined||" & o & ".forceAskCause===\"ordinary\")",
      "\"gate:forceAskCause=\"+__cdbStartTok(" & o & ".forceAskCause)",
    ) & keep(o & ".firstDriveReference!==undefined", tok("gate:firstDriveReference")) &
    keep(o & ".rulesLock!==undefined", tok("gate:rulesLock")) &
    keep(o & ".nameTrustWithheld===true", tok("gate:nameTrustWithheld")) &
    keep(o & ".handedToPerson===true&&!__cdbStartPlaceAsk", tok("gate:handedToPerson")) &
    keep(o & ".defaultToNo===true", tok("gate:defaultToNo")) &
    keep(o & ".settingsFileRuleAsk===true", tok("gate:settingsFileRuleAsk")) &
    keep(o & ".suppressAlwaysAllowRule===true", tok("gate:suppressAlwaysAllowRule")) &
    keep(o & ".connectorAsk!==undefined", tok("gate:connectorAsk")) &
    keep(o & ".viaHostCliLauncher===true", tok("gate:viaHostCliLauncher")) &
    keep("this.config.getSession(" & sid & ")!==" & session, tok("sessionChanged")) &
    keep(api & "." & hostCliFn & "(" & session & ")", tok("hostCliLauncher")) &
    keep(session & ".permissionMode===\"plan\"", tok("planMode")) &
    keep(
      "this.config.laptopMcpToolAsksEveryCall?.(" & sid & "," & tool & ")===true",
      tok("laptopAsksEveryCall"),
    ) & keep(api & "." & hostPolicyFn & "(" & tool & ")", tok("hostPolicy")) &
    keep(
      api & "." & unattendedFn & "(" & sid & ",e=>this.config.getSession(e))",
      tok("unattended"),
    ) &
    keep(
      "this.internalNameProvenanceVerdict(" & sid & "," & tool & ")!==undefined",
      tok("provenance"),
    ) &
    keep(
      startGate & "(" & tool & "," & data & "," & sid &
        ",__cdbSessionId=>this.config.getSession(__cdbSessionId)," & o &
        ".toolUseID,\"canUseTool\")",
      tok("startGate"),
    ) &
    keep(
      "__cdbStartPlace!==undefined&&!__cdbStartPlaceAsk&&!__cdbStartPlaceOrdinary",
      tok("firstUsePlace"),
    ) & "let __cdbStartVerdict=await this.forceAskVerdict(" & tool & "," & data & "," &
    sid & ");" &
    keep(
      "!(__cdbStartVerdict.cause===\"ordinary\"||__cdbStartVerdict.standDown===\"bypass\")",
      "\"forceAsk:\"+__cdbStartTok(__cdbStartVerdict.cause??__cdbStartVerdict.standDown)",
    ) &
    keep(
      "await " & api & "." & ownAskFn & "(" & session & ".query," & tool & ")!==false",
      tok("ownAskRules"),
    ) & "let __cdbStartListing=await " & session &
    ".query?.listPermissionRules?.(),__cdbStartRules=__cdbStartListing?.state?.rules;" &
    keep(
      "!(__cdbStartListing?.state?.managedOnly===false&&Array.isArray(__cdbStartRules)&&" &
        "__cdbStartRules.every(__cdbStartRule=>__cdbStartRule&&typeof __cdbStartRule.rule===\"string\"&&typeof __cdbStartRule.behavior===\"string\"&&typeof __cdbStartRule.source===\"string\"))",
      tok("rules:listing"),
    ) &
    keep(
      "!(__cdbStartPlaceAsk||(" & o & ".decisionReason===undefined&&" & o &
        ".decisionReasonType===undefined)||(" & o & ".decisionReasonType===\"rule\"&&" &
        o &
        ".reasonFromApp!==true&&__cdbStartRules.some(__cdbStartRule=>__cdbStartRule.notInEffect!==true&&__cdbStartRule.behavior===\"ask\"&&__cdbStartRule.source===\"mcpServerPolicy\"&&" &
        api & "." & matcherExport & "(__cdbStartRule.rule," & tool & "))))",
      tok("reason"),
    ) &
    keep(
      "__cdbStartRules.some(__cdbStartRule=>__cdbStartRule.notInEffect!==true&&__cdbStartRule.behavior===\"deny\"&&" &
        api & "." & matcherExport & "(__cdbStartRule.rule," & tool & "))",
      tok("rules:deny"),
    ) & "return true}"
  let injected =
    marker &
    "if(process.platform===\"linux\"&&globalThis.__cdbSessionStartDialogEnabled?.()===true){let __cdbStartResult=await (" &
    helper & ")(" & data & "," & signal & "," & eligibility & ",{session:" & session &
    ",sessionId:" & sid & ",mainWindow:()=>" & api & "." & mainExport &
    ",place:()=>this.firstUseSidePlace(" & sid & "," & tool & "," & data &
    "),onApproved:__cdbResult=>this.allowedOnCardJustNow.add(__cdbResult)});if(__cdbStartResult!==undefined)return __cdbStartResult}"
  if marker in input:
    if input.count(injected & anchor) != 1:
      raise newException(ValueError, "session-start end state differs; re-audit")
    echo "  [OK] session-start always-allow dialog hook already present (idempotent)"
    return input
  result = input.replace(anchor, injected & anchor)
  if result.count(injected & anchor) != 1:
    raise newException(ValueError, "session-start consent injection failed")
  echo "  [OK] session-start always-allow dialog hook injected (main-window parent, project-scoped grants)"

when isMainModule:
  if paramCount() != 1:
    quit("Usage: add_feature_session_start_always_allow <bundle.js>", 1)
  let file = paramStr(1)
  try:
    writeFile(file, apply(readFile(file)))
  except ValueError as e:
    echo "  [FAIL] " & e.msg
    quit(1)
