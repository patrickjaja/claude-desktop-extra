# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# "Start at login" / "Start in system tray" on Linux.
#
# History (three layers, all targeting the Windows MSIX):
#   1. isStartupOnLoginEnabled() called Electron getLoginItemSettings() (returns
#      undefined on Linux) -> Settings toggle always showed disabled.
#   2. setStartupOnLoginEnabled() used Electron setLoginItemSettings() which on
#      Linux does NOT add --startup to the Exec line -> main window always shown.
#   3. GNOME session restore re-launches saved apps WITHOUT --startup -> the main
#      window pops up after every reboot.
# We used to patch all three (anchor: the env-var short-circuit
# CLAUDE_AVOID_READING_LOGING_ITEM_SETTINGS, and the "Toggling" debug log).
#
# The official Linux .deb UPSTREAMED layers 1 and 2 natively:
#   - read:  function ico(){...exists(zmA())...readFile(zmA())...!rco(...)}  reads
#            the XDG autostart .desktop and parses Hidden / X-GNOME-Autostart-enabled.
#   - write: function nco(A){...} writes/removes it, building the file with
#            function tco(){return["[Desktop Entry]","Type=Application",
#              `Name=${app.getName()}`,`Exec=${eco(process.execPath)} --startup`,
#              "X-GNOME-Autostart-enabled=true",""].join(...)}
#   - dir:   J6A() = (XDG_CONFIG_HOME||~/.config)/autostart
#   - file:  zmA() = `${basename(process.execPath)}.desktop`  (profile-aware: our
#            per-profile Electron binary has a distinct basename, so each profile
#            manages its own autostart entry — same outcome our old patch hand-rolled)
#   - setStartupOnLoginEnabled(A){...nco(A).catch(...)"Failed to update XDG autostart entry"}
# The Exec line already carries --startup, so an autostart launch hides the window.
#
# Layer 3 was NOT upstreamed: the window-show gate is purely
#   wco=!<proc>.argv.includes("--startup")
# and the whole bundle has ZERO /run/user and ZERO gnome-session references. A
# GNOME session-restore relaunch (no --startup) therefore still shows the window.
#
# So per AGENTS.md Rule 4 we only patch layer 3 and the Exec target; the native
# read/write paths are PRECONDITIONS of those two sub-patches, not sub-patches
# of their own (they were assert-only guards until 2026-09-23):
#   - P3 (session-restore detection): widen the single argv.includes("--startup")
#     gate with js/startup_session_restore_gate.js, which suppresses ONLY when an
#     enabled XDG autostart entry exists AND the graphical session started under
#     60s ago. Requiring the autostart entry is what keeps an ordinary launch
#     visible (issue #233). Precondition: upstream's autostart path is still
#     (XDG_CONFIG_HOME||~/.config)/autostart/<basename(execPath)>.desktop, the
#     exact file the gate reads.
#   - P4 (autostart Exec): build the entry from CLAUDE_LAUNCHER so a login launch
#     goes through our launcher rather than the bundled Electron. Its anchor is
#     the .desktop builder itself (Exec=... --startup followed by
#     X-GNOME-Autostart-enabled=true), which is the native write path.

import std/[os, strutils]
import regex

# The session-restore predicate lives in js/ so it is reviewable, syntax-checked
# and unit-tested (scripts/tests/linux/test-startup-gate.mjs). It is a bare JS
# expression, inlined verbatim into upstream's show-at-launch gate. Comments in
# it are /* */ only - a // comment would swallow the minified code that follows
# it on the same line.
const GATE_JS = staticRead("../../js/startup_session_restore_gate.js")
const GATE_MARKER = "__cdb_startup_gate_v2__"

proc apply*(input: string): string =
  var patchesApplied = 0
  const expectedPatches = 2
  result = input

  # ── P3 (active patch): session-restore detection ─────────────────────────
  # Upstream's only gate is `<proc>.argv.includes("--startup")`, and
  # gnome-session / Plasma re-launch saved clients after a reboot WITHOUT that
  # flag, so a user who asked for a hidden start got the window on every login.
  # We widen the gate with the predicate in js/startup_session_restore_gate.js,
  # which suppresses only when an ENABLED XDG autostart entry exists AND the
  # graphical session started under 60s ago. Requiring the autostart entry is
  # what keeps an ordinary launch visible: without it, clicking the launcher
  # icon shortly after login produced a hidden window (issue #233).
  #
  # Precondition: the gate reads the autostart entry at upstream's own path, so
  # upstream must still build that path. v1.26832.0: node builtins are reached
  # through namespace aliases (I.default.join / dt.default.homedir) and string
  # literals became backticks, so allow member chains and either quoting.
  let autostartDir = input.findAll(
    re2"""XDG_CONFIG_HOME\|\|[\w$]+(?:\.[\w$]+)*\.join\([\w$]+(?:\.[\w$]+)*\.homedir\(\),["`]\.config["`]\);return [\w$]+(?:\.[\w$]+)*\.join\([\w$]+,["`]autostart["`]\)"""
  ).len
  let autostartFile = input.findAll(
    re2"""return`\$\{[\w$]+(?:\.[\w$]+)*\.basename\(process\.execPath\)\}\.desktop`"""
  ).len
  if autostartDir != 1 or autostartFile != 1:
    echo "  [FAIL] session-restore precondition: upstream's XDG autostart path " &
      "((XDG_CONFIG_HOME||~/.config)/autostart, basename(execPath).desktop) not found " &
      "exactly once (dir=" & $autostartDir & " file=" & $autostartFile &
      ") - the gate would read the wrong file; re-audit P3"
    quit(1)

  let gateCount = input.count(GATE_MARKER)
  if gateCount == 1:
    echo "  [OK] session-restore detection: already patched (" & GATE_MARKER & ")"
    patchesApplied += 1
  elif gateCount > 1:
    echo "  [FAIL] session-restore detection: " & GATE_MARKER & " present " & $gateCount &
      " times, expected 1"
    quit(1)
  elif "_b.mtimeMs" in input:
    # The superseded v1 predicate suppressed on the socket mtime alone. Never
    # treat it as "already patched" - that would silently ship the #233 bug.
    echo "  [FAIL] input carries the superseded v1 session-restore predicate"
    echo "         (_b.mtimeMs). Re-extract a clean bundle."
    quit(1)
  else:
    # v1.26832.0: `--startup` is a template literal and process is reached via a
    # namespace alias (L.default.argv), so accept either quoting and member chains.
    let pattern3 = re2"""([\w$]+(?:\.[\w$]+)*)\.argv\.includes\(["`]--startup["`]\)"""
    var count3 = 0
    result = result.replace(
      pattern3,
      proc(m: RegexMatch2, s: string): string =
        inc count3
        let processVar = s[m.group(0)]
        # The result MUST be parenthesized: upstream negates this expression
        # (`showWindow ??= !<proc>.argv.includes("--startup")`) and `!` binds
        # tighter than `||`. Without the parens the injected heuristic would
        # read `(!includes)||restore` and *show* the window on session restore
        # - the exact opposite of what this patch is for.
        "(" & processVar &
          ".argv.includes(\"--startup\")||process.platform===\"linux\"&&" &
          GATE_JS.strip() & ")",
    )
    if count3 == 1:
      echo "  [OK] session-restore detection: augmented argv --startup gate (1 match)"
      patchesApplied += 1
    else:
      echo "  [FAIL] session-restore: expected 1 argv --startup site, found " & $count3 &
        " - re-audit (the window-show gate may have changed shape)"
      quit(1)

  # ── P4 (active patch): autostart entry must point at OUR launcher ─────────
  # Upstream builds the XDG autostart entry as
  #   `Exec=${<shellQuote>(process.execPath)} --startup`
  # i.e. the BUNDLED ELECTRON BINARY (/usr/lib/claude-desktop/claude), not our
  # launcher (/usr/bin/claude-desktop). A login launch would therefore start with
  # none of the launcher's setup: no --ozone-platform=wayland (so on a Wayland
  # session the autostarted instance comes up under XWayland while a later manual
  # launch is native Wayland - two windowing regimes against one instance lock),
  # no --enable-features=UseOzonePlatform,GlobalShortcutsPortal, no PATH repair
  # (Cowork cannot find qemu), no --password-store, no systemd scope (the portal
  # identity that persists Computer Use grants), and for a named profile no
  # --user-data-dir - so the autostarted instance would silently share the
  # DEFAULT profile's userData.
  #
  # The launcher exports CLAUDE_LAUNCHER (its own resolved path, or the AppImage
  # path), so Exec points back at it, and --profile=<name> is re-added from
  # CLAUDE_PROFILE. Falls back to upstream's process.execPath when the env var is
  # absent (someone ran the Electron binary directly).
  #
  # The anchor is the whole Exec entry of the .desktop builder, followed by
  # X-GNOME-Autostart-enabled=true: the --startup flag (autostart launches hide
  # the window) and the enable key must both still be what upstream writes.
  let execTail = """ --startup`,["`]X-GNOME-Autostart-enabled=true["`]"""
  let pattern4 = re2("""(Exec=\$\{)([\w$]+)(\(process\.execPath\)\}""" & execTail & ")")
  let pattern4Done = re2(
    """Exec=\$\{[\w$]+\(process\.env\.CLAUDE_LAUNCHER\|\|process\.execPath\)\}\$\{process\.env\.CLAUDE_PROFILE\?""" &
      """[^`]{0,100}\}""" & execTail
  )
  let done4 = result.findAll(pattern4Done).len
  let count4 = result.findAll(pattern4).len
  if done4 == 1 and count4 == 0:
    echo "  [OK] autostart Exec already points at the launcher (idempotent)"
    patchesApplied += 1
  elif done4 == 0 and count4 == 1:
    result = result.replace(
      pattern4,
      proc(m: RegexMatch2, s: string): string =
        let shellQuote = s[m.group(1)]
        let rest = s[m.group(2)]
        s[m.group(0)] & shellQuote & "(process.env.CLAUDE_LAUNCHER||process.execPath)}" &
          "${process.env.CLAUDE_PROFILE?\" --profile=\"+" &
          "process.env.CLAUDE_PROFILE.replace(/[^A-Za-z0-9._-]/g,\"\"):\"\"}" &
          rest["(process.execPath)}".len .. ^1],
    )
    echo "  [OK] autostart Exec now points at the launcher (1 match)"
    patchesApplied += 1
  else:
    echo "  [FAIL] autostart .desktop builder: " & $count4 & " upstream and " & $done4 &
      " patched Exec entries, expected exactly one of them once (re-audit P4)"
    quit(1)

  if patchesApplied != expectedPatches:
    echo "  [FAIL] Only " & $patchesApplied & "/" & $expectedPatches & " patches applied"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_startup_settings <path_to_index.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_startup_settings ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
  echo "  [PASS] Startup settings: 2/2 patches applied"
