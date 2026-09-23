# Plan: Linux portability pass

Source of truth: [SPEC.md](../SPEC.md) (approved 2026-09-23). Tasks: [todo.md](todo.md).

## Shape

Ten modules. Seven have no dependency on each other and run as parallel
workstreams (one sub-agent each, each touching a disjoint file set). Three
follow them.

```
Wave 1 (parallel, disjoint files)
  W1 host-tool-paths      patches/linux/fix_host_tool_paths_linux.nim (new), fix_detected_projects_linux.nim, apply_patches.py count, tests/linux
  W2 patch-hygiene + X6   enable_local_agent_mode, fix_quick_entry_position, fix_computer_use_linux, fix_startup_settings, fix_app_quit, T6 count pins, fix_cross_device_rename, CONSTRAINTS.md exception rows
  W3 packaging-deps       packaging/{debian,rpm,pacman,nix}, build-patched-tarball.sh ELF guard
  W4 launcher-fixes       scripts/claude-desktop-launcher.sh (non-diagnose parts), packaging/appimage
  W5 cu-robustness        js/cu_mode_preamble.js, js/cu_linux_executor.js, tests/linux
  W6 tray-less (X3)       verify first, then a patch (new or folded)
  W7 keep-awake (X4)      verify first, then a patch
Wave 2
  W8 rhel-cowork-qemu (X1)   after W4 (launcher PATH shim) - boot test in rockylinux:9 + /dev/kvm
  W9 diagnose-host-caps      after W1 + W4 (launcher _diagnose)
Wave 3
  W10 docs-refresh           after all; README, docs/, PATCHES.md, SKILL.md, CHANGELOG
```

## Conflicts to manage

- **`scripts/apply_patches.py` `EXPECTED_PATCH_COUNT`** is touched by W1 (+1),
  W6/W7 (+1 each if they add a patch) and W2 (-1 if X6 removes). Each workstream
  bumps it in its own change; I merge the final number. CONSTRAINTS P4: the pin
  only changes with the add/`git rm`.
- **The launcher** is touched by W4, W8 and W9. W4 goes first; W9 owns only the
  `_diagnose` function and the read-only-subcommand ordering; W8 only the PATH
  shim block.
- **`fix_computer_use_linux.nim`** (W2) and `js/cu_*.js` (W5) share a build:
  the patch embeds the js via `staticRead`. W5 touches only js; W2 only nim
  anchors. Both run the `linux` harness at the end; I rerun it after merging.
- **Patches share one bundle**: W1, W2, W6 and W7 each validate on their own
  staged copy; I run the full orchestrator + probe once after merging.

## Risks

| Risk | Mitigation |
|------|-----------|
| A tightened anchor (W2) lands on the wrong site after the next re-minify | Anchor on stable strings (error messages, captured function names), exact counts, and the probe's P2 second run |
| Removing an assert-only sub-patch loses a real precondition | W2 folds preconditions into the neighbouring real injection's anchor instead of dropping them (T4 P1 -> P3) |
| X3 changes what "close" does for users who DO have a tray | Detection is positive (a watcher is on the bus = upstream behavior unchanged); only the no-watcher case changes |
| X4 inhibitor leaks a `systemd-inhibit` child | Tie it to upstream's own start/stop branch; kill on stop and on app quit; harness checks both |
| X1 shim makes Cowork "start" but the VM misbehaves on qemu-kvm | Only ship after the helper's real VM boots in rockylinux:9 with KVM; otherwise docs-only |
| deb Conflicts+Replaces surprises a user | CHANGELOG + README line; tested in docker both install orders |

## Verification checkpoints

1. **After wave 1:** `make`, the probe (expect all ACTIVE, E1-E3 gone from its
   output), orchestrator on a fresh extract, `node --check` per chunk,
   `run-feature-tests.sh linux` + `core`, shellcheck, sibling-noop.
2. **After wave 2:** docker boot test (X1), `--diagnose` run on this host and in
   the Fedora43-KDE VM with busctl moved aside.
3. **Before handing back:** `./scripts/build-local.sh` (build only, no install),
   docker install tests for deb/rpm, one VM spot-check per headline fix
   (Wayland hotkey without `/usr/bin/busctl` on the KDE VM; GNOME search provider
   on the Ubuntu VM). I will say it is ready and give you the install command; I
   will not install on your machine or commit without being asked.
