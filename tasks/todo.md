# Tasks: Linux portability pass

See [plan.md](plan.md) and [SPEC.md](../SPEC.md). IDs refer to SPEC findings.

## Wave 1 (parallel)

### W1 host-tool-paths
- [x] T1.1 New `patches/linux/fix_host_tool_paths_linux.nim`: rewrite `"/usr/bin/busctl"`, `"/usr/bin/secret-tool"`, `"/usr/bin/kwallet-query"` (exactly 1 each in the index.js concat) to `(require("fs").existsSync(P)?P:"<name>")`; positive idempotency; exact counts
  - Acceptance: probe says ACTIVE and P2-idempotent; Debian path unchanged when the file exists
  - Verify: `make`; probe; `node --check` on the patched chunk; new harness
  - Files: new .nim, `scripts/apply_patches.py` (48 -> 49), `PATCHES.md` row
- [x] T1.2 `fix_detected_projects_linux.nim`: same rewrite for `/usr/bin/sqlite3` (H3), count == 1, pin the patch's other `>=1` counts (T6)
  - Verify: probe; harness
- [x] T1.3 Harness `scripts/tests/linux/test-host-tool-paths.mjs`: extract the patched function, run with a fake FS/PATH both ways; bump `EXPECTED_TEST_HARNESSES`
  - Verify: `bash scripts/run-feature-tests.sh linux`

### W2 patch-hygiene (+ X6)
- [ ] T2.1 `enable_local_agent_mode.nim` (T1): drop Patch 1, 1b, 2, header guard, dead Patch 3 fallback; Patch 4 `== 1` + positive already-branch; EXPECTED 6 -> 2; move `__nav_spoof_applied` stale-input check into the orchestrator/probe stale-input refusal
  - Acceptance: second run exits 0 with no change; delete CONSTRAINTS E1
- [ ] T2.2 `fix_quick_entry_position.nim` (T2): anchor Patch 1 on the captured fallback fn (count 1), remove Patch 2, Patch 3 required `== 1`
  - Verify: diff shows only `Lcr` rewritten, `c$r` untouched
- [ ] T2.3 `fix_computer_use_linux.nim` (T3): Patch 2 anchored on the CU gate Set (count 1); drop Patch 7 (36 -> 35); 14c both Finder sites (== 2); 14a/14d `== 2`; marker-set idempotency; delete CONSTRAINTS E3
- [ ] T2.4 `fix_startup_settings.nim` (T4): fold P1 into P3 preconditions, P2 into P4's anchor; 4 -> 2
- [ ] T2.5 `fix_app_quit.nim` (T5): `== 1` + positive branch; delete CONSTRAINTS E2; note whether upstream's quit watchdog makes it redundant (report, do not remove)
- [ ] T2.6 Exact-count pins + unique idempotency markers for the T6 list (excluding files owned by W1/W6/W7)
- [ ] T2.7 X6 `fix_cross_device_rename.nim`: enumerate the 14 sites, prove which (if any) can cross filesystems (e.g. `/tmp` -> userData); pin to those or `git rm` + count -1; report the evidence before removing
  - Verify for all of W2: `make`; probe shows 0 exceptions for E1-E3 and all ACTIVE; `run-feature-tests.sh linux` + `core`; `node --check`

### W3 packaging-deps
- [x] T3.1 deb: `Conflicts: claude-desktop`, `Replaces: claude-desktop` (P1); Recommends `gnome-keyring | plasma-workspace`, `libsecret-tools` (P3, H2); Suggests `gjs`; review ydotool Suggests text (Debian ships 0.1.8)
  - Verify: docker ubuntu:24.04 install official deb then ours, and ours then official; `apt-get install --simulate` on 22.04/24.04/debian:12/13
  - Files: `packaging/debian/build-deb.sh`
- [x] T3.2 rpm: `Conflicts: claude-desktop`; gjs weak dep
  - Files: `packaging/rpm/claude-desktop-extra.spec`
- [x] T3.3 GNOME search provider (P2): install `.ini` to `/usr/share/gnome-shell/search-providers/` and `.service` to `/usr/share/dbus-1/services/` in deb, rpm, pacman payloads; optdepend gjs; Arch optdepend desktop-file-utils
  - Verify: `dpkg -c`, `rpm -qlp`, `tar -tf` on built packages
  - Files: build-deb.sh, spec, PKGBUILD (find it), pacman helper
- [x] T3.4 Nix (N2, N3): `meta.platforms = [ "x86_64-linux" ]`; add `python3`, `xdg-utils`, `sqlite` to wrapper PATH; search-provider files with store paths substituted
  - Verify: `nix build` in the nixos/nix container
  - Files: `packaging/nix/package.nix`
- [x] T3.5 A1: `build-patched-tarball.sh` derives rust targets from `DEB_ARCH`, skips host builds on arch mismatch, and fails unless every ELF in `TREE_DIR` matches `DEB_ARCH`
  - Verify: run the guard function against the amd64 tree (pass) and a tree with one foreign ELF (fail)

### W4 launcher-fixes
- [x] T4.1 N1: respect a pre-set `CLAUDE_LAUNCHER`; profile `.desktop`/symlink Exec uses it too; Nix wrapper sets it to the bare `claude-desktop` name (coordinate the one line in package.nix with W3)
- [x] T4.2 L1: `_canonical_electron_bin` prefers `CLAUDE_ELECTRON`; `--create-profile` on AppImage refuses with a clear message
- [x] T4.3 L3: XWayland gate on `-n "$DISPLAY"` instead of the Niri name
- [x] T4.4 L4: `_kwallet_available` falls through busctl -> dbus-send -> gdbus
- [x] T4.5 L5: drop `LD_LIBRARY_PATH` export from AppRun (`packaging/appimage/build-appimage.sh`), after confirming `$ORIGIN` RPATH covers every bundled .so the binary needs
- [x] T4.6 S4: when `WAYLAND_DISPLAY` is set and `XDG_SESSION_TYPE` is neither wayland nor x11, export `XDG_SESSION_TYPE=wayland`
  - Verify for W4: agent D's simulations (fake Electron, scratch HOME, makeWrapper exec form, AppImage mount path change) as scripted regression checks; `shellcheck -S error`

### W5 cu-robustness
- [x] T5.1 C1: bridge runnable check (spawn a no-op subcommand, async, 3 s, cached per process) before a bridge is selected; on failure fall to the next tier and log the real cause (exit code / loader error), replace "reinstall" text with cause-specific hints (PipeWire floor, glibc floor, NixOS override)
  - Acceptance: a present-but-unloadable kwin bridge on KDE routes to the regular executor (spectacle tier); no sync block on the main process
- [x] T5.2 C2: app dirs from `XDG_DATA_HOME` + `XDG_DATA_DIRS` (+ flatpak exports); `_hasCmd` via a PATH walk, not `which`
  - Verify: extend `scripts/tests/linux/` harness (unrunnable bridge fixture, XDG_DATA_DIRS fixture); `run-feature-tests.sh linux`; `make` (staticRead)

### W6 tray-less-desktops (X3)
- [x] T6.1 Verify: on the Ubuntu VM (GNOME, AppIndicator disabled) close the window -> is the process left running with no way back but relaunch? Check whether upstream already probes for a tray host anywhere
- [x] T6.2 If confirmed: patch so the close-to-tray and `--startup` hidden paths require a StatusNotifierWatcher on the session bus (async check at startup, cached; with a watcher, upstream behavior unchanged). Harness for both branches. Report before adding a new patch file vs folding into an existing linux patch

### W7 keep-awake-linux (X4)
- [x] T7.1 Verify: with keep-awake on, what does `powerSaveBlocker.start("prevent-app-suspension")` produce on this host and the VMs (`systemd-inhibit --list`, `busctl --user` ScreenSaver/PowerManagement inhibitors)?
- [x] T7.2 If it is a no-op on some DEs: at upstream's start/stop sites, also spawn/kill `systemd-inhibit --what=sleep --who=Claude --why=... sleep infinity` (only if `systemd-inhibit` exists; kill on stop and on quit). Harness for start/stop/quit
- [x] T7.3 Use an idle inhibitor (`--what=idle`) instead of sleep: upstream only promises idle-sleep prevention and `ccKeepAwakeWhileWorking` defaults on (user decision 2026-09-23)

## Wave 2

### W8 rhel-cowork-qemu (X1)
- [ ] T8.1 rockylinux:9 + `--device /dev/kvm`: install qemu-kvm, run upstream's `cowork-linux-helper` VM boot with a `qemu-system-x86_64 -> /usr/libexec/qemu-kvm` shim; record whether it boots
- [ ] T8.2 If it boots: rpm ships the shim dir, launcher appends it to PATH only when no `qemu-system-*` is on PATH and `/usr/libexec/qemu-kvm` exists. Else: docs-only, with the reason

### W9 diagnose-host-caps
- [ ] T9.1 `--diagnose` "Host capabilities": feature -> tool -> found/MISSING -> consequence for busctl (with the app's exact portal probe), secret-tool, kwallet-query, sqlite3, xdg-open, gjs, python3, socat, systemd-inhibit, bluetoothd, qemu/firmware (reuse the Cowork section); runs-at-all check for all 4 bridges; "Problems found" summary
- [ ] T9.2 Move profile refresh + AppImage integration below read-only subcommands (`--diagnose`, `--help`)
  - Verify: run on this host; in the Fedora VM with `/usr/bin/busctl` moved aside

## Wave 3

### W10 docs-refresh
- [ ] T10.1 README + docs corrections from SPEC D1; per-compositor Quick Entry snippets (Sway/river/niri `--toggle` bind, Hyprland `global` bind, GNOME < 48 `--install-gnome-hotkey`); env vars page; Cowork per-distro/arch notes (Debian 12, RHEL, Pi RAM, Jetson KVM)
- [ ] T10.2 `.claude/skills/linux/SKILL.md` refresh; stale comments (tarball script, package.nix, launcher ~2071)
- [ ] T10.3 PATCHES.md rows, CHANGELOG 2026-09-23 section (merge into today's entry)
- [ ] T10.4 Final gate: `make`, probe, orchestrator, all harness categories, shellcheck, sibling-noop, jsonc sync, `./scripts/build-local.sh` (no install)

## Verify-first items (run inside the waves, not blocking)
- [x] V1 `CLAUDE_GPU_BACKEND=angle-gl` on 2.7032.0 (no libEGL/libGLESv2 shipped) - W4 (ANGLE is linked into the binary; knob should still work, not launch-tested)
- [ ] V2 X11 Quick Entry hotkey with GlobalShortcutsPortal forced - needs your XFCE session (manual, 1 min)
- [x] V3 xdg-desktop-portal named-profile scope parse - W4 (parses to com.anthropic.Claude-<name>; no fix)
- [ ] V4 Portal probe 2 s timeout on autostart - W9
