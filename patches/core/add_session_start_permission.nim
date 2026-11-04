# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
# Offer profile-local, revocable consent only at the ordinary native card sink.
# Never change the SDK's always_ask policy or any start_session host checks.
import std/[os, strutils]
import regex

const helper = staticRead("../../js/session_start_permission.js")
const marker = "/*__CDB_SESSION_START_PERMISSION__*/"

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
  let anchors = input.findAll(
    re2"let ([\w$]+)=\(0,([\w$]+)\.randomUUID\)\(\),([\w$]+)=([\w$]+)\(([\w$]+)\?\.toolUseID\),"
  )
  var hits = 0
  var anchor = ""
  for a in anchors:
    if input[a.group(4)] == options:
      inc hits
      anchor = input[a.boundaries]
  if hits != 1:
    raise newException(ValueError, "session-start native card sink must match once")
  let gate =
    tool & "===\"mcp__ccd_session__start_session\"&&" & options & "!==undefined&&" &
    session & "!==undefined&&(" & options & ".decisionReasonType===undefined||" & options &
    ".decisionReasonType===\"rule\")&&(" & options & ".forceAskCause===undefined||" &
    options & ".forceAskCause===\"ordinary\")&&" & options &
    ".firstDriveReference===undefined&&" & options & ".rulesLock===undefined&&" & options &
    ".nameTrustWithheld!==true&&" & options & ".handedToPerson!==true&&" & options &
    ".defaultToNo!==true&&" & options & ".settingsFileRuleAsk!==true&&" & options &
    ".suppressAlwaysAllowRule!==true&&" & options & ".connectorAsk===undefined&&" &
    options & ".viaHostCliLauncher!==true"
  let eligibility =
    "async()=>{if(!(" & gate & "))return false;" & "if(this.config.getSession(" & sid &
    ")!==" & session & "||" & api & ".TF(" & session & ")||" & session &
    ".permissionMode===\"plan\"||" & "this.config.laptopMcpToolAsksEveryCall?.(" & sid &
    "," & tool & ")===true||" & api & ".hm(" & tool & ")||" & api & ".qn(" & sid &
    ",e=>this.config.getSession(e))||" & "this.internalNameProvenanceVerdict(" & sid &
    "," & tool & ")!==undefined)return false;" & "if(" & startGate & "(" & tool & "," &
    data & "," & sid & ",__cdbSessionId=>this.config.getSession(__cdbSessionId)," &
    options & ".toolUseID,\"canUseTool\")||" & "await this.firstUseSidePlace(" & sid &
    "," & tool & "," & data & ")!==undefined)return false;" &
    "let __cdbStartVerdict=await this.forceAskVerdict(" & tool & "," & data & "," & sid &
    ");" &
    "if(!(__cdbStartVerdict.cause===\"ordinary\"||__cdbStartVerdict.standDown===\"bypass\")||" &
    "await " & api & "._K(" & session & ".query," & tool & ")!==false)return false;" &
    "let __cdbStartListing=await " & session &
    ".query?.listPermissionRules?.(),__cdbStartRules=__cdbStartListing?.state?.rules;" &
    "return __cdbStartListing?.state?.managedOnly===false&&Array.isArray(__cdbStartRules)&&" &
    "__cdbStartRules.every(__cdbStartRule=>__cdbStartRule&&typeof __cdbStartRule.rule===\"string\"&&typeof __cdbStartRule.behavior===\"string\"&&typeof __cdbStartRule.source===\"string\")&&" &
    "((" & options & ".decisionReason===undefined&&" & options &
    ".decisionReasonType===undefined)||(" & options & ".decisionReasonType===\"rule\"&&" &
    options &
    ".reasonFromApp!==true&&__cdbStartRules.some(__cdbStartRule=>__cdbStartRule.notInEffect!==true&&__cdbStartRule.behavior===\"ask\"&&__cdbStartRule.source===\"mcpServerPolicy\"&&" &
    api & "." & matcherExport & "(__cdbStartRule.rule," & tool & "))))&&" &
    "!__cdbStartRules.some(__cdbStartRule=>__cdbStartRule.notInEffect!==true&&__cdbStartRule.behavior===\"deny\"&&" &
    api & "." & matcherExport & "(__cdbStartRule.rule," & tool & "))}"
  let injected =
    marker & "if(process.platform===\"linux\"){let __cdbStartResult=await (" & helper &
    ")(" & data & "," & signal & "," & eligibility &
    ");if(__cdbStartResult!==undefined)return __cdbStartResult}"
  if marker in input:
    if input.count(injected & anchor) != 1:
      raise newException(ValueError, "session-start end state differs; re-audit")
    echo "  [OK] session-start native consent sink already present"
    return input
  result = input.replace(anchor, injected & anchor)
  if result.count(injected & anchor) != 1:
    raise newException(ValueError, "session-start consent injection failed")
  echo "  [OK] session-start native consent sink injected"

when isMainModule:
  if paramCount() != 1:
    quit("Usage: add_session_start_permission <bundle.js>", 1)
  let file = paramStr(1)
  writeFile(file, apply(readFile(file)))
