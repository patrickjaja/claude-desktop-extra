# @patch-target: resources/ion-dist
# @patch-type: nim-dir
# Renderer half of auto_archive_grace: read the native engine's ledger and use
# the native per-session auto-archive write. Zero delay preserves upstream UI.
import std/[os, strutils]
import regex

const source = staticRead("../../js/auto_archive_grace_ui.js")
const marker = "/*cdb-archive-grace-ui*/"

proc unique(s: string, pat: Regex2, label: string): RegexMatch2 =
  let matches = s.findAll(pat)
  if matches.len != 1:
    raise newException(ValueError, label & ": expected one anchor, got " & $matches.len)
  matches[0]

proc apply(s: string): string =
  if marker in s:
    let wrap = unique(
      s,
      re2"""function ([\w$]+)\(([\w$]+)\)\{return [\w$]+\(__cdbArchiveGraceView,\{sessionRef:[\w$]+\.sessionRef,children:[\w$]+\(__cdbArchiveNativeNotice,[\w$]+\)\}\)\}""",
      "notice wrapper",
    )
    let injectedRail = unique(
      s,
      re2"""function ([\w$]+)\(([\w$]+),([\w$]+)\)\{return [\w$]+\([\w$]+,\{children:\[[\w$]+\.inRail&&[\w$]+\.isPrimary\?[\w$]+\(__cdbArchiveGraceView,\{sessionRef:[\w$]+\.sessionRef,rail:true\}\):null,__cdbArchiveNativeRail\([\w$]+,[\w$]+\)\]\}\)\}""",
      "rail wrapper",
    )
    var original = s[0 ..< s.find("\n" & marker)]
    original = original.replace(
      "function __cdbArchiveNativeNotice(" & s[wrap.group(1)] & ")",
      "function " & s[wrap.group(0)] & "(" & s[wrap.group(1)] & ")",
    )
    original = original.replace(
      "function __cdbArchiveNativeRail(" & s[injectedRail.group(1)] & "," &
        s[injectedRail.group(2)] & ")",
      "function " & s[injectedRail.group(0)] & "(" & s[injectedRail.group(1)] & "," &
        s[injectedRail.group(2)] & ")",
    )
    if apply(original) != s:
      raise newException(ValueError, "archive UI injection incomplete or stale")
    return s
  # Positive idempotency: verify the full helper and both injected call sites.
  let control = unique(
    s,
    re2"""function ([\w$]+)\([\w$]+\)\{let [\w$]+=J9\(11\),[^;]*?([\w$]+)=([\w$]+)\?\.setSessionAutoArchiveOnPrClose""",
    "native archive control",
  )
  let nativeControl = s[control.group(0)]
  let nativeApi = s[control.group(2)]
  # Stable imports in this bundle: React hooks are used together in the native
  # preferences subscriber; resolve aliases rather than freezing minified names.
  let subscriber = unique(
    s,
    re2"""function [\w$]+\([\w$]+\)\{let [\w$]+=J9\(3\),\[[\w$]+,[\w$]+\]=([\w$]+)\(\),[\s\S]*?onPreferencesChanged[^;]*?,([\w$]+)\([\w$]+,[\w$]+\),[\w$]+\}""",
    "preference subscriber",
  )
  let notice = unique(
    s,
    re2"""function ([\w$]+)\(([\w$]+)\)\{let [\w$]+=J9\(7\),\{hold:[\w$]+,sessionRef:[\w$]+\}=[\w$]+,""",
    "archive notice",
  )
  let noticeName = s[notice.group(0)]
  let noticeArg = s[notice.group(1)]
  let jsx = unique(
    s,
    re2"""([\w$]+)\("div",\{role:"status","aria-live":"polite","data-find-omitted":"",className:""",
    "notice jsx",
  )
  let rail = unique(
    s,
    re2"""function ([\w$]+)\(([\w$]+),([\w$]+)\)\{let [\w$]+=J9\(440\),\{repoKey:[\w$]+,sessionRef:[\w$]+,sessionRepo:[\w$]+,isPrimary:[\w$]+,[\s\S]*?children:\[[\w$]+,[\w$]+,[\w$]+,[\w$]+,[\w$]+,[\w$]+\]\}\)\):[\w$]+\[439\]\}""",
    "primary rail",
  )
  let railName = s[rail.group(0)]
  let railArg = s[rail.group(1)]
  let railData = s[rail.group(2)]
  let fragment = unique(
    s,
    re2"""([\w$]+)\(([\w$]+),\{children:\[([\w$]+),([\w$]+),([\w$]+),([\w$]+),([\w$]+),([\w$]+)\]\}\)\):[\w$]+\[439\]\}""",
    "rail fragment",
  )
  let helper = source
    .replace("__cdbReactState", s[subscriber.group(0)])
    .replace("__cdbReactEffect", s[subscriber.group(1)])
    .replace("__cdbArchiveControl", nativeControl)
    .replace("__cdbLocalSessions", nativeApi)
    .replace("__cdbJsx", s[jsx.group(0)])
  let wrapper =
    "function " & noticeName & "(" & noticeArg & "){return " & s[jsx.group(0)] &
    "(__cdbArchiveGraceView,{sessionRef:" & noticeArg & ".sessionRef,children:" &
    s[jsx.group(0)] & "(__cdbArchiveNativeNotice," & noticeArg & ")})}"
  let railWrapper =
    "function " & railName & "(" & railArg & "," & railData & "){return " &
    s[fragment.group(0)] & "(" & s[fragment.group(1)] & ",{children:[" & railArg &
    ".inRail&&" & railArg & ".isPrimary?" & s[jsx.group(0)] &
    "(__cdbArchiveGraceView,{sessionRef:" & railArg &
    ".sessionRef,rail:true}):null,__cdbArchiveNativeRail(" & railArg & "," & railData &
    ")]})}"
  if s.count("function " & noticeName & "(" & noticeArg & ")") != 1 or
      s.count("function " & railName & "(" & railArg & "," & railData & ")") != 1:
    raise newException(ValueError, "archive UI function declarations are not unique")
  result = s.replace(
    "function " & noticeName & "(" & noticeArg & ")",
    "function __cdbArchiveNativeNotice(" & noticeArg & ")",
  )
  result = result.replace(
    "function " & railName & "(" & railArg & "," & railData & ")",
    "function __cdbArchiveNativeRail(" & railArg & "," & railData & ")",
  )
  result.add("\n" & marker & helper & wrapper & railWrapper)

when isMainModule:
  if paramCount() != 1:
    quit("Usage: add_feature_auto_archive_grace_ion <ion-dist>", 1)
  var found = 0
  for kind, file in walkDir(paramStr(1) / "assets" / "v1"):
    if kind != pcFile or not file.endsWith(".js"):
      continue
    let input = readFile(file)
    if "This session will be archived automatically after you leave it." notin input:
      continue
    inc found
    writeFile(file, apply(input))
  if found != 1:
    quit("[FAIL] archive UI target count " & $found, 1)
  echo "[OK] archive grace UI: notice and native keep control verified"
