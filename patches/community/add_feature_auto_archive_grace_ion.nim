# @patch-target: resources/ion-dist
# @patch-type: nim-dir
# Notice and session-rail renderer halves of the optional archive grace, in the
# ion-dist SPA (the main window in 3P mode). The delay at Immediately (0)
# preserves upstream's UI: the helper renders upstream's own output, reads the
# main process once and starts no timer.
#
# Two chunks, each must be found exactly once and be distinct:
#   notice chunk  upstream's auto-archive hold notice ({hold,sessionRef} props,
#                 role="status" div). Wrapped: the notice renders unchanged and
#                 a separate delay line may follow it.
#   rail chunk    the per-session "Session details" rail ({session,pullRequests,
#                 plan,artifacts,...,outputsSession} props, returns null or
#                 jsxs("aside",{ref,...,children:[header,content]})). Wrapped:
#                 the keep control is appended to the aside's children. The
#                 rail renders once per session panel, so the control does too.
#
# React aliases (names and slot counts are wildcards): useState / useEffect come
# from the notice chunk's ccAutoArchiveOnPrClose preference subscriber, jsx from
# the notice's role="status" div, jsxs / Fragment from the PR bar row's closing
# fragment. Each local name is mapped to its vendor-frame export through the
# notice chunk's import list, and that export to the rail chunk's own local
# name through the rail chunk's import list; the rail's own `aside` call must
# use the same jsxs.
import std/[os, strutils, tables]
import regex

const source = staticRead("../../js/auto_archive_grace_ui.js")
const marker = "/*cdb-archive-grace-ui*/"
const noticeTarget = "This session will be archived automatically after you leave it."
const placeholders = [
  "__cdbReactState", "__cdbReactEffect", "__cdbJsxOne", "__cdbJsxMany", "__cdbFragment"
]

proc unique(s: string, pat: Regex2, label: string): RegexMatch2 =
  let hits = s.findAll(pat)
  if hits.len != 1:
    raise newException(ValueError, label & ": expected one anchor, got " & $hits.len)
  hits[0]

proc vendorImports(
    s: string
): tuple[file: string, byExport, byLocal: Table[string, string]] =
  let m = unique(
    s,
    re2"""import\{([^}]+)\}from"(\./vendor-frame-[^"]+\.js)"""",
    "vendor-frame import list",
  )
  result.file = s[m.group(1)]
  for entry in s[m.group(0)].split(','):
    let parts = entry.split(" as ")
    let exported = parts[0]
    let local =
      if parts.len == 2:
        parts[1]
      else:
        parts[0]
    result.byExport[exported] = local
    result.byLocal[local] = exported

type Aliases = object
  vendor: string
  exports: array[5, string] # in `placeholders` order

proc resolveAliases(notice: string): Aliases =
  let subscriber = unique(
    notice,
    re2"""\[[\w$]+,[\w$]+\]=([\w$]+)\(\),[^;]*;return [^;]*;let [^;]*?ccAutoArchiveOnPrClose===!0\)\};return [^;]*?onPreferencesChanged[^;]*?,([\w$]+)\([\w$]+,[\w$]+\),[\w$]+\}""",
    "preference subscriber",
  )
  let jsx = unique(
    notice,
    re2"""([\w$]+)\("div",\{role:"status","aria-live":"polite","data-find-omitted":"",className:""",
    "notice jsx",
  )
  let fragment = unique(
    notice,
    re2"""function [\w$]+\([\w$]+,[\w$]+\)\{let [\w$]+=[\w$]+\(\d+\),\{repoKey:[\w$]+,sessionRef:[\w$]+,sessionRepo:[\w$]+,isPrimary:[\w$]+,[\s\S]*?([\w$]+)\(([\w$]+),\{children:\[[\w$]+,[\w$]+,[\w$]+,[\w$]+,[\w$]+,[\w$]+\]\}\)\):[\w$]+\[\d+\]\}""",
    "PR bar row fragment",
  )
  let locals = [
    notice[subscriber.group(0)],
    notice[subscriber.group(1)],
    notice[jsx.group(0)],
    notice[fragment.group(0)],
    notice[fragment.group(1)],
  ]
  let imports = vendorImports(notice)
  result.vendor = imports.file
  for i, local in locals:
    if local notin imports.byLocal:
      raise newException(
        ValueError, placeholders[i] & ": " & local & " is not a vendor-frame import"
      )
    result.exports[i] = imports.byLocal[local]

proc helperFor(s: string, aliases: Aliases): string =
  let imports = vendorImports(s)
  if imports.file != aliases.vendor:
    raise newException(ValueError, "chunks import different vendor-frame files")
  result = source
  for i, placeholder in placeholders:
    if aliases.exports[i] notin imports.byExport:
      raise newException(
        ValueError, placeholder & ": export " & aliases.exports[i] & " not imported"
      )
    result = result.replace(placeholder, imports.byExport[aliases.exports[i]])
  for placeholder in placeholders:
    if placeholder in result:
      raise newException(ValueError, "helper placeholder left: " & placeholder)

proc restoreNotice(s: string): string =
  if marker notin s:
    return s
  let wrap = unique(
    s,
    re2"""function ([\w$]+)\(([\w$]+)\)\{return [\w$]+\(__cdbArchiveGraceView,\{sessionRef:[\w$]+\.sessionRef,hold:[\w$]+\.hold,lineClass:(?:`[^`]*`|"[^"]*"),children:[\w$]+\(__cdbArchiveNativeNotice,[\w$]+\)\}\)\}""",
    "notice wrapper",
  )
  result = s[0 ..< s.find("\n" & marker)].replace(
    "function __cdbArchiveNativeNotice(" & s[wrap.group(1)] & ")",
    "function " & s[wrap.group(0)] & "(" & s[wrap.group(1)] & ")",
  )

proc restoreRail(s: string): string =
  if marker notin s:
    return s
  let wrap = unique(
    s,
    re2"""function ([\w$]+)\(([\w$]+)\)\{let __cdbRail=__cdbArchiveNativeRail\([\w$]+\);return __cdbRail&&Array\.isArray\(__cdbRail\.props\?\.children\)\?[\w$]+\(__cdbRail\.type,\{\.\.\.__cdbRail\.props,children:\[\.\.\.__cdbRail\.props\.children,[\w$]+\(__cdbArchiveGraceView,\{sessionRef:[\w$]+\.outputsSession,rail:!0\}\)\]\},__cdbRail\.key\?\?void 0\):__cdbRail\}""",
    "session rail wrapper",
  )
  result = s[0 ..< s.find("\n" & marker)].replace(
    "function __cdbArchiveNativeRail(" & s[wrap.group(1)] & ")",
    "function " & s[wrap.group(0)] & "(" & s[wrap.group(1)] & ")",
  )

proc applyNotice(s: string, aliases: Aliases): string =
  let site = unique(
    s,
    re2"""function ([\w$]+)\(([\w$]+)\)\{let [\w$]+=[\w$]+\(\d+\),\{hold:[\w$]+,sessionRef:[\w$]+\}=[\w$]+,""",
    "notice",
  )
  let jsx = unique(
    s,
    re2"""([\w$]+)\("div",\{role:"status","aria-live":"polite","data-find-omitted":"",className:(`[^`]*`|"[^"]*")""",
    "notice div",
  )
  if jsx.boundaries.a < site.boundaries.b or
      "function " in s[site.boundaries.b ..< jsx.boundaries.a]:
    raise newException(ValueError, "notice div: not inside the archive notice")
  let name = s[site.group(0)]
  let arg = s[site.group(1)]
  let jsxOne = s[jsx.group(0)]
  let declaration = "function " & name & "(" & arg & ")"
  if s.count(declaration) != 1:
    raise newException(ValueError, "notice declaration not unique")
  let wrapper =
    declaration & "{return " & jsxOne & "(__cdbArchiveGraceView,{sessionRef:" & arg &
    ".sessionRef,hold:" & arg & ".hold,lineClass:" & s[jsx.group(1)] & ",children:" &
    jsxOne & "(__cdbArchiveNativeNotice," & arg & ")})}"
  result = s.replace(declaration, "function __cdbArchiveNativeNotice(" & arg & ")")
  result.add("\n" & marker & helperFor(s, aliases) & wrapper)

proc applyRail(s: string, aliases: Aliases): string =
  let site = unique(
    s,
    re2"""function ([\w$]+)\(([\w$]+)\)\{let [\w$]+=[\w$]+\(\d+\),\{session:[\w$]+,pullRequests:[\w$]+,plan:[\w$]+,artifacts:[\w$]+,[^}]+outputsSession:[\w$]+,""",
    "session rail",
  )
  let bodyEnd = s.find("function ", site.boundaries.b)
  if bodyEnd < 0:
    raise newException(ValueError, "session rail: no end")
  let body = s[site.boundaries.a ..< bodyEnd]
  # Every return is either `return null` or the aside with a two-element
  # children array (the wrapper also guards with Array.isArray at run time).
  let aside = unique(
    body,
    re2"""return [^;]*?([\w$]+)\("aside",\{ref:[\w$]+,"aria-label":[\w$]+,tabIndex:-1,onMouseDownCapture:[\w$]+,onClickCapture:[\w$]+,onDoubleClickCapture:[\w$]+,className:[\w$]+,children:\[[\w$]+,[\w$]+\]\}\)\):[\w$]+\[\d+\]\}$""",
    "session rail aside",
  )
  let returns = body.findAll(re2"""\breturn\b""").len
  let nullReturns = body.findAll(re2"""\breturn null;""").len
  if returns != nullReturns + 1:
    raise newException(ValueError, "session rail: unexpected return shapes")
  let helper = helperFor(s, aliases)
  let imports = vendorImports(s)
  let jsxMany = imports.byExport[aliases.exports[3]]
  let jsxOne = imports.byExport[aliases.exports[2]]
  if body[aside.group(0)] != jsxMany:
    raise newException(ValueError, "session rail: aside is not built with jsxs")
  let name = s[site.group(0)]
  let arg = s[site.group(1)]
  let declaration = "function " & name & "(" & arg & ")"
  if s.count(declaration) != 1:
    raise newException(ValueError, "rail declaration not unique")
  let wrapper =
    declaration & "{let __cdbRail=__cdbArchiveNativeRail(" & arg &
    ");return __cdbRail&&Array.isArray(__cdbRail.props?.children)?" & jsxMany &
    "(__cdbRail.type,{...__cdbRail.props,children:[...__cdbRail.props.children," & jsxOne &
    "(__cdbArchiveGraceView,{sessionRef:" & arg &
    ".outputsSession,rail:!0})]},__cdbRail.key??void 0):__cdbRail}"
  result = s.replace(declaration, "function __cdbArchiveNativeRail(" & arg & ")")
  result.add("\n" & marker & helper & wrapper)

proc isRail(s: string): bool =
  "id:\"environment\",title:" in s and "id:\"pullRequests\",title:" in s and
    "outputsSession:" in s

when isMainModule:
  if paramCount() != 1:
    quit("Usage: add_feature_auto_archive_grace_ion <ion-dist>", 1)
  var noticePath, railPath, noticeInput, railInput: string
  var notices, rails = 0
  for kind, file in walkDir(paramStr(1) / "assets" / "v1"):
    if kind != pcFile or not file.endsWith(".js"):
      continue
    let input = readFile(file)
    if noticeTarget in input:
      inc notices
      noticePath = file
      noticeInput = input
    if input.isRail:
      inc rails
      railPath = file
      railInput = input
  if notices != 1 or rails != 1 or noticePath == railPath:
    quit(
      "[FAIL] archive grace UI: expected one notice and one distinct session rail chunk",
      1,
    )
  try:
    # Positive idempotency: an already patched chunk is rebuilt to its
    # original text and must re-apply byte-identically.
    let noticeOriginal = restoreNotice(noticeInput)
    let railOriginal = restoreRail(railInput)
    let aliases = resolveAliases(noticeOriginal)
    let noticeOutput = applyNotice(noticeOriginal, aliases)
    let railOutput = applyRail(railOriginal, aliases)
    if (marker in noticeInput and noticeOutput != noticeInput) or
        (marker in railInput and railOutput != railInput):
      raise newException(ValueError, "injection incomplete or stale")
    writeFile(noticePath, noticeOutput)
    writeFile(railPath, railOutput)
  except ValueError as e:
    quit("[FAIL] archive grace UI: " & e.msg, 1)
  echo "[OK] archive grace UI: notice and session rail verified"
