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
  let namespaces = head.findAll(re2"\.viaHostCliLauncher===!0\|\|([\w$]+)\.TF\(")
  if namespaces.len != 1:
    raise newException(ValueError, "session-start policy namespace must match once")
  let api = head[namespaces[0].group(0)]
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
  for name in ["TF", "_K", "hm", "qn"]:
    let local = exportTarget(apiSrc, name)
    if apiSrc.count("function " & local & "(") != 1:
      raise newException(
        ValueError,
        "session-start: " & api & "." & name & " -> " & local &
          " is not defined once in " & apiChunk,
      )
  # The main window: `V=new u.BrowserWindow(e),zi(V.webContents,Li.MAIN_WINDOW)`.
  let mainVar = exportTarget(apiSrc, "Xmt")
  var mainHits = 0
  for m in apiSrc.findAll(
    re2"""(?:^|[^\w$.])([\w$]+)=new [\w$]+\.BrowserWindow\([\w$]+\),[\w$]+\(([\w$]+)\.webContents,[\w$]+\.MAIN_WINDOW\)"""
  ):
    if apiSrc[m.group(0)] == mainVar and apiSrc[m.group(1)] == mainVar:
      inc mainHits
  if mainHits != 1:
    raise newException(
      ValueError,
      "session-start: " & api & ".Xmt is not the MAIN_WINDOW BrowserWindow in " &
        apiChunk,
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
  for required in [api & "._K(", api & ".hm(", api & ".qn("]:
    if required notin input:
      raise
        newException(ValueError, "session-start host-policy anchor absent: " & required)
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
  let gate =
    tool & "===\"mcp__ccd_session__start_session\"&&" & options & "!==undefined&&" &
    session & "!==undefined&&(" & options & ".decisionReasonType===undefined||" & options &
    ".decisionReasonType===\"rule\"||__cdbStartPlaceAsk)&&(" & options &
    ".forceAskCause===undefined||" & options & ".forceAskCause===\"ordinary\")&&" &
    options & ".firstDriveReference===undefined&&" & options & ".rulesLock===undefined&&" &
    options & ".nameTrustWithheld!==true&&(" & options &
    ".handedToPerson!==true||__cdbStartPlaceAsk)&&" & options & ".defaultToNo!==true&&" &
    options & ".settingsFileRuleAsk!==true&&" & options &
    ".suppressAlwaysAllowRule!==true&&" & options & ".connectorAsk===undefined&&" &
    options & ".viaHostCliLauncher!==true"
  let eligibility =
    # __cdbStartPlaceAsk: the ask is only the first-use folder sentence. The CLI folds several
    # PreToolUse ask results into one (last wins), so a hook ask may arrive here and is answered
    # in the native dialog; the person is still asked. User ask rules and managed policy keep the card.
    "async()=>{let __cdbStartPlace=await this.firstUseSidePlace(" & sid & "," & tool &
    "," & data & ");" & "let __cdbStartPlaceAsk=" & data &
    "?.cwd!==undefined&&__cdbStartPlace!==undefined&&typeof __cdbStartPlace.sentence===\"string\"&&" &
    options & "?.decisionReason===__cdbStartPlace.sentence&&(" & options &
    "?.decisionReasonType===\"hook\"||" & options & "?.decisionReasonType===undefined);" &
    "if(!(" & gate & "))return false;" & "if(this.config.getSession(" & sid & ")!==" &
    session & "||" & api & ".TF(" & session & ")||" & session &
    ".permissionMode===\"plan\"||" & "this.config.laptopMcpToolAsksEveryCall?.(" & sid &
    "," & tool & ")===true||" & api & ".hm(" & tool & ")||" & api & ".qn(" & sid &
    ",e=>this.config.getSession(e))||" & "this.internalNameProvenanceVerdict(" & sid &
    "," & tool & ")!==undefined)return false;" & "if(" & startGate & "(" & tool & "," &
    data & "," & sid & ",__cdbSessionId=>this.config.getSession(__cdbSessionId)," &
    options &
    ".toolUseID,\"canUseTool\")||(__cdbStartPlace!==undefined&&!__cdbStartPlaceAsk))return false;" &
    "let __cdbStartVerdict=await this.forceAskVerdict(" & tool & "," & data & "," & sid &
    ");" &
    "if(!(__cdbStartVerdict.cause===\"ordinary\"||__cdbStartVerdict.standDown===\"bypass\")||" &
    "await " & api & "._K(" & session & ".query," & tool & ")!==false)return false;" &
    "let __cdbStartListing=await " & session &
    ".query?.listPermissionRules?.(),__cdbStartRules=__cdbStartListing?.state?.rules;" &
    "return __cdbStartListing?.state?.managedOnly===false&&Array.isArray(__cdbStartRules)&&" &
    "__cdbStartRules.every(__cdbStartRule=>__cdbStartRule&&typeof __cdbStartRule.rule===\"string\"&&typeof __cdbStartRule.behavior===\"string\"&&typeof __cdbStartRule.source===\"string\")&&" &
    "(__cdbStartPlaceAsk||(" & options & ".decisionReason===undefined&&" & options &
    ".decisionReasonType===undefined)||(" & options & ".decisionReasonType===\"rule\"&&" &
    options &
    ".reasonFromApp!==true&&__cdbStartRules.some(__cdbStartRule=>__cdbStartRule.notInEffect!==true&&__cdbStartRule.behavior===\"ask\"&&__cdbStartRule.source===\"mcpServerPolicy\"&&" &
    api & "." & matcherExport & "(__cdbStartRule.rule," & tool & "))))&&" &
    "!__cdbStartRules.some(__cdbStartRule=>__cdbStartRule.notInEffect!==true&&__cdbStartRule.behavior===\"deny\"&&" &
    api & "." & matcherExport & "(__cdbStartRule.rule," & tool & "))}"
  let injected =
    marker &
    "if(process.platform===\"linux\"&&globalThis.__cdbSessionStartDialogEnabled?.()===true){let __cdbStartResult=await (" &
    helper & ")(" & data & "," & signal & "," & eligibility & ",{session:" & session &
    ",sessionId:" & sid & ",mainWindow:()=>" & api &
    ".Xmt,place:()=>this.firstUseSidePlace(" & sid & "," & tool & "," & data &
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
