# @patch-target: resources/ion-dist
# @patch-type: nim-dir
# Notice and session-rail renderer halves of the optional archive grace.
import std/[os, strutils]
import regex

const source = staticRead("../../js/auto_archive_grace_ui.js")
const marker = "/*cdb-archive-grace-ui*/"

proc unique(s: string, pat: Regex2, label: string): RegexMatch2 =
  let hits = s.findAll(pat)
  if hits.len != 1:
    raise newException(ValueError, label & ": expected one anchor, got " & $hits.len)
  hits[0]

proc helper(s: string): tuple[jsx, code: string] =
  let imports = unique(
    s, re2"""import\{[^}]+\}from["']\./vendor-frame-[^"']+\.js["']""", "React imports"
  )
  let importsText = s[imports.boundaries]
  let state = unique(importsText, re2"""\bTo as ([\w$]+)""", "state hook")
  let effect = unique(importsText, re2"""\bgo as ([\w$]+)""", "effect hook")
  let reference = unique(importsText, re2"""\bwo as ([\w$]+)""", "ref hook")
  let jsx = unique(importsText, re2"""\bGa as ([\w$]+)""", "JSX")
  result.jsx = importsText[jsx.group(0)]
  result.code = source
    .replace("__cdbReactState", importsText[state.group(0)])
    .replace("__cdbReactEffect", importsText[effect.group(0)])
    .replace("__cdbReactRef", importsText[reference.group(0)])
    .replace("__cdbLocalSessions", "globalThis[\"claude.web\"]?.LocalSessions")
    .replace("__cdbJsx", result.jsx)

proc applyNotice(s: string): string =
  if marker in s:
    let wrap = unique(
      s,
      re2"""function ([\w$]+)\(([\w$]+)\)\{return [\w$]+\(__cdbArchiveGraceView,\{sessionRef:[\w$]+\.sessionRef,children:[\w$]+\(__cdbArchiveNativeNotice,[\w$]+\)\}\)\}""",
      "notice wrapper",
    )
    var original = s[0 ..< s.find("\n" & marker)]
    original = original.replace(
      "function __cdbArchiveNativeNotice(" & s[wrap.group(1)] & ")",
      "function " & s[wrap.group(0)] & "(" & s[wrap.group(1)] & ")",
    )
    if applyNotice(original) != s:
      raise newException(ValueError, "notice injection incomplete or stale")
    return s
  let site = unique(
    s,
    re2"""function ([\w$]+)\(([\w$]+)\)\{let [\w$]+=J9\(7\),\{hold:[\w$]+,sessionRef:[\w$]+\}=[\w$]+,""",
    "notice",
  )
  let name = s[site.group(0)]
  let arg = s[site.group(1)]
  let h = helper(s)
  let declaration = "function " & name & "(" & arg & ")"
  if s.count(declaration) != 1:
    raise newException(ValueError, "notice declaration not unique")
  let wrapper =
    declaration & "{return " & h.jsx & "(__cdbArchiveGraceView,{sessionRef:" & arg &
    ".sessionRef,children:" & h.jsx & "(__cdbArchiveNativeNotice," & arg & ")})}"
  result = s.replace(declaration, "function __cdbArchiveNativeNotice(" & arg & ")")
  result.add("\n" & marker & h.code & wrapper)

proc applyRail(s: string): string =
  if marker in s:
    let wrap = unique(
      s,
      re2"""function ([\w$]+)\(([\w$]+)\)\{let __cdbRail=__cdbArchiveNativeRail\([\w$]+\);return __cdbRail\?[\w$]+\(__cdbRail\.type,\{\.\.\.__cdbRail\.props,children:\[\.\.\.__cdbRail\.props\.children,[\w$]+\(__cdbArchiveGraceView,\{sessionRef:[\w$]+\.outputsSession,rail:true\}\)\]\}\):__cdbRail\}""",
      "session rail wrapper",
    )
    var original = s[0 ..< s.find("\n" & marker)]
    original = original.replace(
      "function __cdbArchiveNativeRail(" & s[wrap.group(1)] & ")",
      "function " & s[wrap.group(0)] & "(" & s[wrap.group(1)] & ")",
    )
    if applyRail(original) != s:
      raise newException(ValueError, "session rail injection incomplete or stale")
    return s
  let site = unique(
    s,
    re2"""function ([\w$]+)\(([\w$]+)\)\{let [\w$]+=J9\(123\),\{session:[\w$]+,pullRequests:[\w$]+,plan:[\w$]+,artifacts:[\w$]+,[^}]+outputsSession:[\w$]+,""",
    "session rail",
  )
  let aside = unique(
    s,
    re2"""[\w$]+\("aside",\{ref:[\w$]+,"aria-label":[\w$]+,tabIndex:-1,onMouseDownCapture:[\w$]+,onClickCapture:[\w$]+,onDoubleClickCapture:[\w$]+,className:[\w$]+,children:\[[\w$]+,[\w$]+\]\}\)""",
    "session rail aside",
  )
  discard aside
  let name = s[site.group(0)]
  let arg = s[site.group(1)]
  let h = helper(s)
  let declaration = "function " & name & "(" & arg & ")"
  if s.count(declaration) != 1:
    raise newException(ValueError, "rail declaration not unique")
  let wrapper =
    declaration & "{let __cdbRail=__cdbArchiveNativeRail(" & arg & ");return __cdbRail?" &
    h.jsx & "(__cdbRail.type,{...__cdbRail.props,children:[...__cdbRail.props.children," &
    h.jsx & "(__cdbArchiveGraceView,{sessionRef:" & arg &
    ".outputsSession,rail:true})]}):__cdbRail}"
  result = s.replace(declaration, "function __cdbArchiveNativeRail(" & arg & ")")
  result.add("\n" & marker & h.code & wrapper)

when isMainModule:
  if paramCount() != 1:
    quit("Usage: add_feature_auto_archive_grace_ion <ion-dist>", 1)
  var noticePath, railPath, noticeResult, railResult: string
  var notices, rails = 0
  for kind, file in walkDir(paramStr(1) / "assets" / "v1"):
    if kind != pcFile or not file.endsWith(".js"):
      continue
    let input = readFile(file)
    if "This session will be archived automatically after you leave it." in input:
      inc notices
      noticePath = file
      noticeResult = applyNotice(input)
    if "id:\"environment\",title:" in input and "id:\"pullRequests\",title:" in input and
        "outputsSession:" in input:
      inc rails
      railPath = file
      railResult = applyRail(input)
  if notices != 1 or rails != 1 or noticePath == railPath:
    quit("[FAIL] expected one notice and one distinct session rail", 1)
  writeFile(noticePath, noticeResult)
  writeFile(railPath, railResult)
  echo "[OK] archive grace notice and session rail verified"
