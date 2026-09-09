---
name: linux
description: Linux compatibility reference for the claude-desktop-extra project (repackaging Anthropic's official Claude Desktop Linux .deb and patching its app.asar for the distros Anthropic does not ship). Use when working on Linux support, session managers, distros, Computer Use input/screenshot backends, glibc floors, Wayland/X11, multi-profile, or any patch in patches/*/*.nim. Loads the distro/session matrix, the input + screenshot cascades, native-binary glibc floors, and known Linux gotchas.
when_to_use: When the user mentions Linux compatibility, X11, Wayland, wlroots, GNOME, KDE, XWayland, a distro (Arch/Ubuntu/Debian/Fedora/RHEL/NixOS/Jetson), xdotool/ydotool/grim/spectacle, glibc, kwin-portal-bridge, app_id/WM_CLASS, profiles, or edits files under patches/ or scripts/.
paths: patches/**, scripts/**, js/**, baseline/PLATFORM_GATE_BASELINE.md, wayland.md
---

# Linux compatibility - claude-desktop-extra

Repackages Anthropic's **official Claude Desktop Linux `.deb`** (bundles Electron 42.5.1 + a native Cowork VM backend) for the distros Anthropic does not ship, patching its `app.asar` to add Linux value-adds (Computer Use, themes, multi-profile, Quick Entry) and Linux fixes. **Linux only** - never add macOS/Windows code. Minified JS identifiers change every upstream release, so patterns must use `[\w$]+` wildcards anchored on stable strings (feature names, log messages, `process.platform==="darwin"`). For a clean unpatched bundle to test patterns against, see `/fresh-upstream`.

## Support matrix (must validate every change against ALL rows)

| Session | Compositors/DEs | Input backend | Screenshot |
|---|---|---|---|
| X11 | any (GNOME, KDE, i3, …) | `x11-bridge` (bundled, static) | `x11-bridge` (bundled, static) |
| Wayland wlroots | Sway, Hyprland, Niri | `wlroots-bridge` (bundled, static) | `wlroots-bridge` (bundled, static) |
| Wayland GNOME | GNOME Shell | `gnome-portal-bridge` (bundled; portal consent, persisted GNOME 46+) | `gnome-portal-bridge` (bundled) |
| Wayland KDE 6.6+ | KDE Plasma | `kwin-portal-bridge` (bundled) | `kwin-portal-bridge` (bundled) |
| Wayland KDE <6.6 | KDE Plasma | `ydotool`, else x11-bridge/XWayland | `spectacle`+`convert` |
| XWayland | any Wayland | `x11-bridge` (bundled) | `x11-bridge` (bundled) |
| Wayland exotic | COSMIC, Enlightenment, … | `ydotool` (+`ydotoold`), else x11-bridge/XWayland | `desktopCapturer` / `COWORK_SCREENSHOT_CMD` |

| Distro | Pkg | Min glibc | Arch |
|---|---|---|---|
| Arch | own pacman repo | 2.41 | x86_64, aarch64 |
| Ubuntu 22.04+ | deb | 2.35 | amd64, arm64 |
| Debian 12+ | deb | 2.36 | amd64, arm64 |
| Fedora 40+ | rpm | 2.39 | x86_64, aarch64 |
| RHEL 9+ | rpm | 2.34 | x86_64, aarch64 |
| NixOS | flake | 2.40 | x86_64, aarch64 |
| Jetson (JetPack 6) | deb | 2.35 | aarch64 |
| Any (glibc) | AppImage | varies | x86_64, aarch64 |

**glibc floor is 2.34** (RHEL 9 / Ubuntu 22.04). Debian 11 (bullseye, glibc 2.31) is **no longer supported** - the official Linux `.deb` we repackage targets newer glibc.

## Session detection (`scripts/claude-desktop-launcher.sh`)
- `is_wayland=true` iff `$WAYLAND_DISPLAY` set; else X11. Both unset → hard error.
- `platform_mode ∈ {x11, wayland, xwayland}` drives Electron flags. `CLAUDE_USE_XWAYLAND=1` forces xwayland (escape hatch). **Niri ignores it** (no XWayland) → stays wayland.
- Electron <40 on Wayland warns loudly: broken GlobalShortcutsPortal (electron/electron#49806) → global hotkeys only work when focused. Fix: update Electron, or `CLAUDE_USE_XWAYLAND=1`.
- `claude-desktop --diagnose` dumps `XDG_SESSION_TYPE`, `WAYLAND_DISPLAY`, `platform_mode`, electron major.

## Input + screenshot executors - single source of truth
The dispatch logic lives in checked-in JS under `js/`, embedded into `patches/linux/fix_computer_use_linux.nim` via `staticRead` (36 sub-patches, PCRE/`std/nre` for backreferences). **Edit the `.js`, not the patch.**
- `js/cu_linux_executor.js` - inline executor: session detection, per-session bridge dispatch, residual fallbacks, `[claude-cu] diagnostics:` lines.
- `js/executor_linux.js` - KWin/KDE hybrid executor (kwin mode).
- `js/cu_handler_injection.js`, `js/cu_mode_preamble.js` - handler wiring + mode/bridge-binary resolution (env var → `process.resourcesPath` → `$PATH`; env vars: `X11_BRIDGE_BIN`, `WLROOTS_BRIDGE_BIN`, `GNOME_PORTAL_BRIDGE_BIN`, `KWIN_PORTAL_BRIDGE_BIN`).

**Dispatch (bridge-only on covered sessions):** wlroots session → `wlroots-bridge`; GNOME Wayland → `gnome-portal-bridge` (portal session daemon scoped to the CU lock via `__setLockHeld`); X11/XWayland → `x11-bridge`; KDE 6.6+ → kwin mode. All bridges share the x11-bridge CLI/JSON contract (subcommand + `--kebab` flags, one JSON value on stdout, exit 1 + stderr on error). On covered sessions there is NO third-party fallback - a missing bridge is a hard, diagnosable error. `COWORK_SCREENSHOT_CMD` overrides screenshots everywhere; Electron `desktopCapturer` is the last-resort screenshot tier. Clipboard + cursor-position are Electron-native in the regular executor. `_checkYdotool()` (ydotool + running ydotoold) gates only the exotic-Wayland residual path.

**Executor methods run OUTSIDE the CU lock - treat them as ambient API (issue #184).** Upstream builds the CU tool schemas at Code/Cowork session open and calls `executor.listInstalledApps()`/`listRunningApps()` there (raced against a 1s timeout that CANNOT preempt a synchronous block - `execFileSync` freezes the whole main process, timer never fires). Therefore: enumeration subcommands (`windows`, `frontmost-app`, `app-under-point`, `screens`) must NEVER open a portal session, pop a consent dialog, or wait on user interaction; portal sessions belong to the lock lifecycle (`__setLockHeld`, async `execFile`) plus the per-portal-command sync backstop. In `cu_linux_executor.js` this is enforced by the `_gnomePortalCmds` allowlist - only input/capture subcommands (pointer-*, key-sequence, type, hold-key, zoom, screenshot, left-mouse-*) may ensure the portal session. Any new executor method or bridge subcommand must declare which side it is on. All four bridges audited 2026-07-08: kwin already enforces this structurally (enumeration = portal-free KWin scripting; portal only via explicit `session-start`, fail-closed otherwise; JS fully async); wlroots/x11 have zero portal/consent surface (`session-start` is a no-op there) and bounded enumeration - GNOME was the only offender.

**`[claude-cu] diagnostics:`** lines (input-backend, per-bridge `present (path)|absent`, `screenshot-cascade=[...]`, VM/Wayland detection) are written via `globalThis.__cdbDiag` to `~/.config/Claude/logs/claude-patches.log` + raw fd 2. **Debugging locally: read that file yourself** (`grep -a 'claude-cu' ~/.config/Claude/logs/claude-patches.log`); ask remote issue reporters to attach it. The official `.deb` build DISCARDS main-process `console.log`/`process.stdout` (fds healthy - proven via /proc fd probe); never add plain `console.log` diagnostics to main-process patch code - use `__cdbDiag` (or the `(globalThis.__cdbDiag||console.log)` fallback outside the CU patch).

## Native binaries & glibc floors (CI enforces via `objdump -T | grep GLIBC_`)
| Binary | Floor | Why | CI base |
|---|---|---|---|
| x11-bridge | none (static musl) | pure Rust, runs everywhere incl. NixOS | `ubuntu:noble` (rustup musl) |
| wlroots-bridge | none (static musl) | pure Rust, runs everywhere incl. NixOS | `ubuntu:noble` (rustup musl) |
| gnome-portal-bridge | 2.39 (Ubuntu Noble) | lamco-pipewire needs PipeWire >= 1.0.5 runtime (Noble/Fedora 40+/Debian 13+); Jammy (0.3.48) and Bookworm (0.3.65) cannot even load the binary | `ubuntu:noble` + native cross |
| kwin-portal-bridge | 2.39 (Ubuntu Noble) | KWin 6.6+ only on Noble+/Fedora 40+ | `ubuntu:noble` + native cross |

- **node-pty is no longer rebuilt by us.** The official Linux `.deb` ships a pre-built `pty.node` + `spawn-helper` for x86_64 and arm64 inside `app.asar.unpacked`; our repackage preserves them (`asar pack` keeps the unpacked dir). There is no `rebuild-pty-for-arch.sh` and no Electron pin (`.electron-version`/`.electron-shasums` are gone) - Electron 42.5.1 is bundled in the official `.deb`.
- **All four CU bridges are ours** (repos: patrickjaja/x11-bridge, patrickjaja/wlroots-bridge, patrickjaja/gnome-bridge, patrickjaja/kwin-portal-bridge fork). Built for x86_64 + arm64 by CI, cached by upstream HEAD SHA. Static bridges assert `statically linked|static-pie`; dynamic bridges assert the glibc floor.
- On NixOS the static bridges run as bundled; the dynamic two do not (glibc mismatch) - GNOME needs `.override { gnome-portal-bridge = …; }`, KDE falls back to spectacle.
- New native binary → pick floor = its minimum viable distro; CI verifies it via `objdump -T | grep GLIBC_`.

## Multi-profile / window identity (`scripts/claude-desktop-launcher.sh`)
- Per-profile Electron binary at `~/.local/lib/claude-desktop/<APP_ID>-<name>` via **hardlink → reflink → copy** (never symlink - Electron derives identity from `realpath(/proc/self/exe)`, kernel resolves symlinks first). Gives per-profile process/exe identity, NOT a per-profile window app_id.
- WM_CLASS = Wayland app_id = `com.anthropic.Claude` - Chromium derives it from the bundle's `desktopName` (upstream's own reverse-DNS identity; the old `claude-desktop` pin was removed 2026-07-15). Shared across ALL profiles; distinct per-profile app_id needs a per-profile `desktopName` override (unsolved follow-up). systemd scope `app-com.anthropic.Claude(-<name>)-$$.scope`; installed `.desktop` = `com.anthropic.Claude.desktop` (`StartupWMClass=com.anthropic.Claude`); Quick Entry keeps its own `claude-quick-entry` id. XDG autostart entries derive from the BINARY basename instead: `~/.config/autostart/claude(-<name>).desktop`.
- Per-profile isolation: `--user-data-dir` (Electron userData), `CLAUDE_CONFIG_DIR` (Claude Code CLI), `CLAUDE_PROFILE` env (sockets/markers). See AGENTS.md "Profile System" table.
- **Portal identity**: xdg-desktop-portal resolves unsandboxed Electron via systemd scope → `.desktop` id; a reverse-DNS id is required for activation routing and KDE persistent grants. Shipped since 2026-07-15: `desktopName` / `.desktop` / `StartupWMClass` / scope all agree on `com.anthropic.Claude`. A build tripwire in `build-patched-tarball.sh` fails loud if upstream renames `desktopName` again.

## Known Linux gotchas (one line each → which patch)
- Opening a Code session enumerates apps via the executor (no CU lock); a portal-session ensure on that path popped GNOME's consent dialog + froze the main process (#184) → `js/cu_linux_executor.js` `_gnomePortalCmds` allowlist + async `__setLockHeld` lifecycle.
- A gnome-portal-bridge that never answers froze the whole app: every bridge call on the capture/input paths was a blocking `execFileSync`, and a failed `session-start` left no memo, so each action re-paid `screens` + `session-start` + the command itself (#232) → screenshot path is async end to end (`_wlBridgeCallAsync`, `_x11BridgeAsync`), a failed portal session latches for 60 s (`_gnomePortalDown`, cleared by a fresh CU lock), the sync backstop is capped at 8 s (consent belongs to the async lock path, which keeps 30 s), and the x11-bridge screenshot tier is gated on `!_wlb` - a rootless XWayland root answers `BadMatch`, so a covered session goes straight to `desktopCapturer`. Pinned by `scripts/tests/linux/test-cu-nonblocking.mjs`; `--diagnose` self-tests `gnome-portal-bridge screens` on GNOME Wayland.
- EXDEV cross-device rename (/tmp tmpfs ↔ ~/.config) → `fix_cross_device_rename.nim` (copy+unlink fallback).
- Sandbox credential-path blocklist (.ssh/.gnupg/.aws/keyrings/.pki/autostart) → `fix_sensitive_dirs_linux.nim`.
- Tray DBus races on session change → `fix_tray_dbus.nim` (async + mutex + destroy delay). Theme: `fix_tray_icon_theme.nim`.
- GNOME Mutter focus-stealing: Quick Entry opens then self-dismisses → `fix_quick_entry_wayland_blur_guard.nim` (ignore blur with no preceding focus). KDE/Hyprland transfer focus so click-outside works; GNOME users close with Esc.
- Native titlebar overlay was win32-only → `fix_native_frame.nim` (+ `_renderer`); three runtime modes: default integrated, `CLAUDE_NATIVE_TITLEBAR=1` (system frame, wins), `CLAUDE_NO_WINDOW_CONTROLS=1` (frameless, no overlay, `hasShadow:false`). The last one is the only in-app way to drop the 4 px border Chromium paints inside frameless windows on xfwm4 and on WMs that do not advertise `_GTK_FRAME_EXTENTS` (i3, Awesome): its gate is `wants_frame_ = !IsTranslucent() && (HasShadow() || IsWindowControlsOverlayEnabled())`, so BOTH disjuncts must be false - dropping `hasShadow:false` silently restores the border.
- Resource paths are upstream-native: every package ships the official install tree verbatim (exe-adjacent `resources/app.asar`, autoloaded via the OnlyLoadAppFromAsar fuse; launcher passes NO asar argv). `process.resourcesPath` / `app.isPackaged` behave exactly as on the stock .deb; bridges + ion-dist + virtiofsd live directly in `resources/`. The former repackaging patches (`fix_locale_paths`, `fix_0_node_host`, `fix_asar_folder_drop`, `fix_asar_workspace_cwd`) were removed 2026-07-13.
- `process.argv` undefined in renderer broke Claude Code web bundle → `fix_process_argv_renderer.nim`.
- CliGovernor false memory-pressure (uses .free, not MemAvailable) evicts sessions → `fix_cli_governor_memavailable.nim` (reads /proc/meminfo).
- `app.dock.bounce` (macOS) → `fix_dock_bounce.nim` (stub).

## wayland.md highlights
- GNOME hotkey: GlobalShortcuts portal approval easy to miss (Electron returns true even if it failed). Workaround `claude-desktop --install-gnome-hotkey` writes a gsettings custom keybinding (bypasses portal), toggling via Unix socket in `$XDG_RUNTIME_DIR`.
- KDE stale kglobalaccel entries after crash block re-registration → `gdbus` unregister before re-register.

## Rules
1. Every change must work across all session types and all distro/arch rows - think through each, especially Wayland fragmentation (GNOME ≠ KDE ≠ wlroots ≠ exotic).
2. New input/screenshot work → change the BRIDGE for that session type (x11-bridge / wlroots-bridge / gnome-portal-bridge / kwin-portal-bridge), or the dispatch in `js/cu_linux_executor.js` (+ `executor_linux.js` for KDE); keep diagnostics lines and the shared CLI/JSON contract (x11-bridge DESIGN.md is authoritative).
3. Fixed user-level paths → prefer `app.getPath("userData")` (auto-isolates per profile) over `~/.config/Claude`.
4. New native binary we ship → builds for x86_64 AND aarch64, pick a glibc floor (or static musl), CI verifies. (We do NOT rebuild node-pty - it comes pre-built in the official `.deb`.)
5. Verify JS syntax after any patch: `node --check ./tmp/app.asar.contents/.vite/build/index.js`.
