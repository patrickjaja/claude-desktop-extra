# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
# Enable Detected Projects (Recent Projects) on Linux.
# Four sub-patches: platform guard, VSCode/Cursor DB path, Zed DB path, and
# the sqlite3 binary path (upstream execs "/usr/bin/sqlite3", which does not
# exist on NixOS; fall back to "sqlite3" on PATH when the file is missing).
#
# Every sub-patch matches exactly one site. Each has its own positive
# "already" check on the end state it injects, so a second run changes nothing.

import std/[os, strformat, strutils]
import regex

const EXPECTED_PATCHES = 4

const SQLITE_PATH = "/usr/bin/sqlite3"
const SQLITE_EXPR =
  "(require(\"fs\").existsSync(\"" & SQLITE_PATH & "\")?\"" & SQLITE_PATH &
  "\":\"sqlite3\")"

# Homedir call as upstream writes it: `(0,ns.homedir)()` or `ns.homedir()`.
const HOME = r"(?:\(0,[\w$]+(?:\.[\w$]+)*\.homedir\)|[\w$]+(?:\.[\w$]+)*\.homedir)\(\)"

proc apply*(input: string): string =
  result = input
  var applied = 0

  # 1. Platform guard in detection entry-point
  # v1.26832.0: literals are backticks and the logger callee is dotted
  # (`if(process.platform!==`darwin`)return t.o.debug(`[detectedProjects] skipping`).
  let patGuard =
    re2"(if\(process\.platform!==[""`]darwin[""`])\)(return [\w$]+(?:\.[\w$]+)*\.debug\(`\[detectedProjects\] skipping)"
  let doneGuard =
    re2"if\(process\.platform!==[""`]darwin[""`]&&process\.platform!==""linux""\)return [\w$]+(?:\.[\w$]+)*\.debug\(`\[detectedProjects\] skipping"
  let guardOld = result.findAll(patGuard).len
  let guardDone = result.findAll(doneGuard).len
  if guardDone == 1 and guardOld == 0:
    echo "  [OK] Platform guard: linux guard already present"
    inc applied
  elif guardDone == 0 and guardOld == 1:
    result = result.replace(
      patGuard,
      proc(m: RegexMatch2, s: string): string =
        s[m.group(0)] & "&&process.platform!==\"linux\")" & s[m.group(1)],
    )
    echo "  [OK] Platform guard: 1 match"
    inc applied
  else:
    echo &"  [FAIL] Platform guard: {guardOld} unpatched / {guardDone} patched sites, expected exactly 1"

  # 2. VSCode / Cursor state DB path
  # v1.26832.0: `i.default.join((0,a.homedir)(),`Library`,...)` - the path module
  # is a dotted member and homedir is called through the `(0,ns.fn)()` indirection.
  let patVscode = re2(
    r"([\w$]+(?:\.[\w$]+)*)\.join\((" & HOME &
      r"),[""`]Library[""`],[""`]Application Support[""`],([\w$]+),[""`]User[""`],[""`]globalStorage[""`],[""`]state\.vscdb[""`]\)"
  )
  let doneVscode = re2(
    r"\(process\.platform===""darwin""\?[\w$]+(?:\.[\w$]+)*\.join\(" & HOME &
      r",""Library"",""Application Support"",[\w$]+,""User"",""globalStorage"",""state\.vscdb""\):[\w$]+(?:\.[\w$]+)*\.join\(" &
      HOME & r","".config"",[\w$]+,""User"",""globalStorage"",""state\.vscdb""\)\)"
  )
  let vscodeDone = result.findAll(doneVscode).len
  # Our darwin branch still carries the old shape, so count old sites only
  # outside the injected ternary.
  let vscodeOld = result.replace(doneVscode, "").findAll(patVscode).len
  if vscodeDone == 1 and vscodeOld == 0:
    echo "  [OK] VSCode/Cursor DB path: linux path already present"
    inc applied
  elif vscodeDone == 0 and vscodeOld == 1:
    result = result.replace(
      patVscode,
      proc(m: RegexMatch2, s: string): string =
        let p = s[m.group(0)]
        let home = s[m.group(1)] # full homedir() call expression, verbatim
        let d = s[m.group(2)]
        let mac =
          p & ".join(" & home & ",\"Library\",\"Application Support\"," & d &
          ",\"User\",\"globalStorage\",\"state.vscdb\")"
        let lin =
          p & ".join(" & home & ",\".config\"," & d &
          ",\"User\",\"globalStorage\",\"state.vscdb\")"
        "(process.platform===\"darwin\"?" & mac & ":" & lin & ")",
    )
    echo "  [OK] VSCode/Cursor DB path: 1 match"
    inc applied
  else:
    echo &"  [FAIL] VSCode/Cursor DB path: {vscodeOld} unpatched / {vscodeDone} patched sites, expected exactly 1"

  # 3. Zed state DB path
  let patZed = re2(
    r"([\w$]+(?:\.[\w$]+)*)\.join\((" & HOME &
      r"),[""`]Library[""`],[""`]Application Support[""`],[""`]Zed[""`],[""`]db[""`],[""`]0-stable[""`],[""`]db\.sqlite[""`]\)"
  )
  let doneZed = re2(
    r"\(process\.platform===""darwin""\?[\w$]+(?:\.[\w$]+)*\.join\(" & HOME &
      r",""Library"",""Application Support"",""Zed"",""db"",""0-stable"",""db\.sqlite""\):[\w$]+(?:\.[\w$]+)*\.join\(" &
      HOME & r","".local"",""share"",""zed"",""db"",""0-stable"",""db\.sqlite""\)\)"
  )
  let zedDone = result.findAll(doneZed).len
  let zedOld = result.replace(doneZed, "").findAll(patZed).len
  if zedDone == 1 and zedOld == 0:
    echo "  [OK] Zed DB path: linux path already present"
    inc applied
  elif zedDone == 0 and zedOld == 1:
    result = result.replace(
      patZed,
      proc(m: RegexMatch2, s: string): string =
        let p = s[m.group(0)]
        let home = s[m.group(1)] # full homedir() call expression, verbatim
        let mac =
          p & ".join(" & home &
          ",\"Library\",\"Application Support\",\"Zed\",\"db\",\"0-stable\",\"db.sqlite\")"
        let lin =
          p & ".join(" & home &
          ",\".local\",\"share\",\"zed\",\"db\",\"0-stable\",\"db.sqlite\")"
        "(process.platform===\"darwin\"?" & mac & ":" & lin & ")",
    )
    echo "  [OK] Zed DB path: 1 match"
    inc applied
  else:
    echo &"  [FAIL] Zed DB path: {zedOld} unpatched / {zedDone} patched sites, expected exactly 1"

  # 4. sqlite3 binary: keep /usr/bin/sqlite3 when present, else PATH lookup.
  let patSqlite = re2("[\"`]" & escapeRe(SQLITE_PATH) & "[\"`]")
  let sqliteDone = result.count(SQLITE_EXPR)
  let sqliteOld = result.replace(SQLITE_EXPR, "").findAll(patSqlite).len
  if sqliteDone == 1 and sqliteOld == 0:
    echo "  [OK] sqlite3 path: PATH fallback already present"
    inc applied
  elif sqliteDone == 0 and sqliteOld == 1:
    result = result.replace(
      patSqlite,
      proc(m: RegexMatch2, s: string): string =
        SQLITE_EXPR,
    )
    echo "  [OK] sqlite3 path: PATH fallback to \"sqlite3\" (1 site)"
    inc applied
  else:
    echo &"  [FAIL] sqlite3 path: {sqliteOld} literal(s) / {sqliteDone} fallback(s), expected exactly 1"

  if applied < EXPECTED_PATCHES:
    raise newException(
      ValueError,
      &"fix_detected_projects_linux: only {applied}/{EXPECTED_PATCHES} sub-patches applied",
    )

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_detected_projects_linux <file>"
    quit(1)
  let file = paramStr(1)
  echo "=== Patch: fix_detected_projects_linux ==="
  echo &"  Target: {file}"
  if not fileExists(file):
    echo &"  [FAIL] File not found: {file}"
    quit(1)
  let input = readFile(file)
  var output: string
  try:
    output = apply(input)
  except ValueError as e:
    echo &"  [FAIL] {e.msg}"
    quit(1)
  if output != input:
    writeFile(file, output)
    echo "  [PASS] Detected Projects patched for Linux"
  else:
    # apply() raises unless every sub-patch applied or found its end state,
    # so an unchanged file means all four end states are present.
    echo "  [PASS] Detected Projects already patched for Linux (idempotent)"
