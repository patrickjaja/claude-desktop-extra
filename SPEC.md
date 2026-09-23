# Spec: Linux portability pass (upstream v2.7032.0)

Status: APPROVED 2026-09-23 (capability map, deb Conflicts+Replaces, extras X1/X3/X4/X6). Written 2026-09-23 from six read-only audits of
the fresh 2.7032.0 extract (amd64 + arm64 `.deb`), the launcher, `packaging/`,
all 48 patches and the issue tracker. Minified names below are 2.7032.0 names
and will be wrong after the next release.

## Objective

Upstream ships a Linux build, but it is built and tested for Debian/Ubuntu with
systemd, GNOME and an FHS `/usr`. We ship it to Arch, Fedora/RHEL, NixOS,
Jetson and AppImage, on x86_64 and aarch64, across X11 and every Wayland
flavor. This pass finds where upstream (or our own layer) quietly assumes the
Debian case, and closes the gaps that cost our users a working feature.

The one pattern that keeps coming back: **a host tool or bundled binary is
missing or cannot load, and a feature silently degrades.** Nothing tells the
user. Wayland hotkeys, Chrome cookie import, GNOME search, NixOS autostart and
Computer Use on NixOS KDE all fail this way today.

Success = every finding below marked "fix" is closed or explicitly deferred,
and the user can see, from one command, which host capabilities are missing.

## Assumptions (correct me before implementation)

1. We keep the patch budget tight (CONSTRAINTS.md). A new patch is OK when it
   closes a functional gap for a whole distro class; not for cosmetics.
2. Nix fixes go into `packaging/nix/package.nix`. The asar is not edited at Nix
   build time; a bundle fix goes through a patch like everywhere else.
3. "Fix" means the same code path upstream uses on Debian stays byte-for-byte
   the same on Debian. Our fallback only engages where upstream's path is absent.
4. Anything that changes app behavior users can see (window/tray semantics,
   power management) is ask-first, even when small.
5. Tests follow the existing harness layout (`scripts/tests/<category>/`).

## Verified findings, ranked by impact

Legend: V = verified by reading code / running it; R = reasoned. "Ours" = our
layer is at fault, not upstream.

### Tier 1: a feature is dead on a whole distro/format

| ID | Finding | Who breaks | Remedy | Conf |
|----|---------|-----------|--------|------|
| H1 | `N9t` runs `execFile("/usr/bin/busctl", ...)` to probe the GlobalShortcuts portal; `catch{jk=!1}` treats "no binary" as "no portal", and `eI()` returns `registration-failed` before `globalShortcut.register()`. Our launcher's `--enable-features=GlobalShortcutsPortal` cannot rescue it. Our `--diagnose` probes with `gdbus`, so it can report the portal as present while the app has disabled hotkeys. | NixOS on any Wayland DE; non-systemd distros; AppImage on either | **patch** (new, see M1) | V |
| H2 | Chrome cookie import execs `/usr/bin/secret-tool` / `/usr/bin/kwallet-query`; failure logs "keyring unavailable" and returns `[]`, so v11 (keyring-encrypted) cookies are silently skipped. | NixOS always; Debian/Ubuntu/Jetson unless `libsecret-tools` is installed (neither upstream's Depends nor ours pull it; Arch/Fedora `libsecret` ship it) | **patch** (M1) + **packaging** (M2) | V |
| H3 | Our own `fix_detected_projects_linux.nim` enables Recent Projects on Linux, and the code it enables runs `/usr/bin/sqlite3`. Upstream is darwin-only here, so this one is ours. (Two auditors called the sqlite dependency "dead weight"; that is wrong - they read the pristine bundle.) | NixOS; AppImage on NixOS | **existing patch** gains one rewrite, no new patch (M1) | V |
| P1 | Our `.deb` declares only `Replaces/Breaks: claude-desktop-bin`. It installs the same `/usr/lib/claude-desktop/*` files as Anthropic's `claude-desktop` package, whose postinst also auto-registers its apt repo, so it is common on Ubuntu. dpkg aborts with "trying to overwrite". | Ubuntu/Debian/Jetson users who ever installed the official package | **packaging**: `Conflicts: claude-desktop` + `Replaces: claude-desktop` (rpm: `Conflicts: claude-desktop`, pre-empting an official RPM, which upstream's postinst hints at) | V (control files) |
| P2 | Upstream's postinst registers a GNOME Shell search provider (`.ini` into `/usr/share/gnome-shell/search-providers/`, D-Bus `.service` running `/usr/bin/gjs -m /usr/lib/claude-desktop/resources/gnome-search-provider/searchProvider.js`). We ship the files verbatim and register nothing, in every format. Our prefix is also `/usr/lib/claude-desktop`, so the files work as-is. | Every GNOME user of every format | **packaging** (M2) | V |
| N1 | Ours. On Nix, `readlink -f "$0"` resolves to the *unwrapped* `$out/lib/claude-desktop/launcher.sh`. "Start at login" (`CLAUDE_LAUNCHER`, our `fix_startup_settings` P4) and `--create-profile` entries point there, so they run without the makeWrapper env and exit "Electron binary not found". They also point into a store path that GC removes. | NixOS: autostart, named profiles | **launcher** + **nix** (M3) | V (simulated) |
| C1 | Ours. The CU bridge resolver (`_cdbResolveBin`, `js/cu_mode_preamble.js`) only checks `X_OK`. A bridge that is present but cannot load gets selected anyway, and the error text says "reinstall the package". On NixOS KDE, the documented spectacle fallback is never reached, because kwin mode wins and the bridge cannot exec (foreign loader). | GNOME Wayland on Ubuntu 22.04 / Debian 12 / RHEL 9 (PipeWire floor); NixOS KDE + GNOME | **js** (M6) | V (code), R (NixOS runtime) |

### Tier 2: degraded, wrong or misleading on a subset

| ID | Finding | Remedy | Conf |
|----|---------|--------|------|
| P3 | Ours. deb `Recommends: gnome-keyring \| kwalletd6 \| kwalletd5`: the last two packages do not exist on any supported Debian/Ubuntu, so apt pulls gnome-keyring onto KDE. | Use upstream's `gnome-keyring \| plasma-workspace`, add `libsecret-tools` | V (docker) |
| N2 | Ours. `package.nix` `meta.platforms` claims `aarch64-linux`, but `src` is always the x86_64 tarball; a direct `callPackage` on aarch64 gets x86 bridges and x86 `pty.node`. README:237 and AGENTS.md claim Nix ARM64. The flake itself is x86_64-only. | Narrow to x86_64 now; real aarch64 is ask-first (X2) | V |
| N3 | Ours. The Nix wrapper PATH lacks `python3` (`--install-gnome-hotkey`, `--1p/--3p`), `xdg-utils` (openExternal, our CU executor) and `sqlite` (H3). The gapps env of nixpkgs' electron wrapper (`XDG_DATA_DIRS`, `GIO_EXTRA_MODULES`, `GDK_PIXBUF_MODULE_FILE`) is bypassed; the launcher comment at ~2071 claiming it "carries its own wrapper" is false. | Add the three to `--prefix PATH`; gapps env is ask-first (it is M-sized and needs a Nix build test) | V |
| L1 | Ours. Per-profile binary refresh (`_canonical_electron_bin`, launcher ~639-670) only knows `/usr/lib/...` and ignores `CLAUDE_ELECTRON`. AppImage: the mount path changes every run, so a created profile breaks from the second launch. Mixed installs silently re-copy from the system package. | Prefer `CLAUDE_ELECTRON`; refuse `--create-profile` on AppImage with a clear message | V (simulated) |
| L2 | Ours. `--diagnose` does not check any absolute-path tool the app needs, probes the portal differently from the app, and self-tests only 2 of 4 bridges. `--diagnose` and `--help` also run the profile refresh (up to a ~200 MB copy) and AppImage desktop integration before dispatching. | M4 | V |
| A1 | Ours. `build-patched-tarball.sh` host-fallback bridge builds are always x86_64 and nothing checks ELF arch, so a local build fed an arm64 `.deb` ships x86 bridges on a green build. CI is unaffected (it passes the `*_BRIDGE_BIN` vars). | Derive the rust target from `DEB_ARCH`; fail loud unless every ELF in the tree matches `DEB_ARCH` | V |
| C2 | Ours. `js/cu_linux_executor.js:621,726` hardcodes the app dirs (`/usr/share/applications`, `~/.local/share/...`, flatpak) and ignores `XDG_DATA_DIRS`, so NixOS, snap and `/usr/local` apps are missing from list/open. `_hasCmd` shells out to `which`, which is absent on some minimal installs; there, every tool reads as missing. | Derive from `XDG_DATA_DIRS`/`XDG_DATA_HOME`; PATH walk instead of `which` | V |
| L3 | Ours. `CLAUDE_USE_XWAYLAND=1` is ignored on Niri by name, even with xwayland-satellite providing `DISPLAY`. Other compositors without XWayland get `--ozone-platform=x11` with no `DISPLAY`, so no window. | Gate on `-n "$DISPLAY"`, not the compositor name | R |
| L4 | Ours. `_kwallet_available` is `if busctl / elif dbus-send`; a present-but-failing busctl never tries the next tool (the secret-service probe falls through correctly). | Fall through | V |
| L5 | Ours. AppImage `AppRun` exports `LD_LIBRARY_PATH=<AppDir>/usr/lib/claude-desktop`. The binary's RPATH is already `$ORIGIN`, so the export is redundant and leaks the bundled `libvulkan.so.1` / `libffmpeg.so` into every shell, MCP server, qemu and claude-code the app spawns. | Drop the export | V (leak), R (impact) |
| D1 | Docs that promise more than the code does: Computer Use "works out of the box everywhere" (README:31,304); Quick Entry "out of the box on Sway/Hyprland" (xdpw has no GlobalShortcuts portal; Hyprland needs a `global` bind); Nix ARM64; per-profile window identity (`--help`, the launcher runtime hint, `profiles.md:78`); "134 flags"; "5 optional features (9 patches)" (it is 7 switches / 10 patches); the 3P log-dir trigger; AppImage "works on NixOS"; `CLAUDE_GPU_BACKEND`, `CLAUDE_DISABLE_SANDBOX`, `CLAUDE_CU_MODE`, `*_BRIDGE_BIN` missing from `docs/environment-variables.md`; Debian 12 has no virtiofsd, so Cowork does not work there; Pi 5 needs 8 GB for the 4 GB default VM; stale `.claude/skills/linux/SKILL.md` (Electron 42.5.1, retired patches, "$PATH" fallback that does not exist) | M7 | V |

### Tier 3: our patch layer vs CONSTRAINTS.md (no user-visible change)

The absorption probe cannot see these: its `ALREADY` regex only matches output
lines that say "already", and assert-only sub-patches print "guard satisfied" /
"no gate needed". So they pass P1 while violating Rule 4.

| ID | Patch | Finding | Remedy | Conf |
|----|-------|---------|--------|------|
| T1 | `enable_local_agent_mode.nim` | Only 3 of 6 counted sub-patches change bytes. Patch 1b (yukonSilver) and the platform-header guard are assert-only. Patch 2 (chillingSlothLocal) prints `[OK]` and increments with **no check at all** (Rule 6). Patch 1 does inject, but into `lYn`, which only runs via `quietPenguin:pH(lYn)`, and `pH` returns "unavailable" whenever `app.isPackaged`, so it never runs in a shipped build (Patch 3 already forces quietPenguin). Patch 3's old-format fallback is dead (0 matches). | Drop 1, 1b, 2 and the header guard; move the `__nav_spoof_applied` stale-input check into the orchestrator. EXPECTED 6 -> 2. Add a positive "already" branch to Patch 4, which **retires exception E1** | V |
| T2 | `fix_quick_entry_position.nim` | Patch 1 global-replaces 2 sites: `Lcr` (intended, the QE default position) and `c$r` (display list of the **win32** CU executor; unreachable on Linux, harmless today, unwanted). Patch 2 is dead: its site sits after the early `return Lcr()` that Patch 3 creates. Patch 3 accepts 0 matches as "optional" (Rule 1/5). | Anchor Patch 1 on Patch 3's captured fallback name, count == 1; remove Patch 2; make Patch 3 required | V |
| T3 | `fix_computer_use_linux.nim` | Patch 7 is assert-only (counted in 36). Patch 2 edits the first of **two** `new Set(["darwin","win32"])` (CU gate vs watch-record gate) by declaration order, so a swap upstream would ship broken CU on a green build. 14c patches 1 of 2 "Finder" sites (the second is reachable in kwin mode). A second run re-injects the executor block before throwing (E3). | Anchor Patch 2 on the CU gate, count == 1; drop Patch 7 (35); patch both Finder sites; marker-set idempotency (N/N markers present = done, 0 = apply, in between = FAIL) retires **E3** | V |
| T4 | `fix_startup_settings.nim` | P1 and P2 are assert-only. P1's path shape is a real precondition of P3; P2 is subsumed by P4's anchor. | Fold into P3/P4 anchors, `expectedPatches` 4 -> 2 | V |
| T5 | `fix_app_quit.nim` | Global replace with a `count == 0` check only; exactly 1 site. | `== 1` + positive already-branch, retires **E2** | V |
| T6 | ~14 patches | `>= 1` / `> 0` where the exact count is known (list in agent E notes: `fix_updater_state_linux`, `fix_utility_process_kill`, `fix_detected_projects_linux`, `fix_dock_bounce`, `fix_window_bounds`, `fix_ion_dist_linux`, `fix_browser_tools_linux`, `fix_renderer_gone_suppressed_log`, `fix_browse_files_linux`, `fix_tray_icon_theme`, `fix_open_in_editor_linux`, `fix_builtin_mcp_browser_env` (2 wanted sites), `fix_computer_use_linux` 14a/14d). Two weak generic idempotency markers (`fix_window_bounds`, `fix_process_argv_renderer`). | Pin exact counts; unique markers | V |
| T7 | `fix_cross_device_rename.nim` | Global rewrite of every `await X.rename(a,b)`: 14 sites. 4 are a Result-returning store API (not `fs`), most are same-dir atomic writes that cannot EXDEV, and the one cross-fs site upstream already handles. The header's stated target (VM bundle /tmp -> ~/.config) was not found. | **Ask first** (X6): audit, then pin or remove | R |

### Checked and fine (no action)

- **arm64:** the official arm64 `.deb` is complete: same file set, every ELF aarch64, floors <= 2.34, all LOAD segments 64K-aligned (safe on Pi 5 / Asahi 16K kernels), and every `process.arch` selector (node-pty, CCD, uv, VM manifest, `qemu-system-aarch64`, updater URL) maps arm64. The #241 `O_*` remap is still present. Our arm64 CI tarball, AppImage, rpm and pacman are consistent.
- `/usr/bin/{ssh,pgrep,open,osascript,...}` are darwin-only. `/usr/bin/update-desktop-database` is a logged no-op off-FHS and our `.desktop` already carries the jump-list actions. `/etc/os-release` is only used for telemetry and the Ubuntu-22 virtiofsd gate. Linux auto-update is `platformUnsupported`; it never touches apt.
- Firmware/virtiofsd paths: covered by `fix_cowork_firmware_paths_linux.nim`. KWallet preflight in `index.pre.js` (`/usr/bin/busctl`): covered by the launcher's own PATH-based probe.
- AppArmor userns profile, chrome-sandbox 4755, desktop/icon caches: correct in deb/rpm/pacman. Non-systemd: the scope launch falls back to plain exec.
- `XDG_CURRENT_DESKTOP` parsing, notifications, protocol handler, clipboard: generic.
- Scope naming for named profiles (`app-com.anthropic.Claude-<name>-PID.scope`): one auditor suspected the dash breaks xdg-desktop-portal's parse; its lazy `(.+?)\-[[:alnum:]]*\.scope$` regex should capture `com.anthropic.Claude-<name>`. Kept as a verify item (V3), not a fix.

## Capability map

Modules are independent enough to build and verify separately. Ids are stable.

| Module id | Responsibility | Findings | Depends on | Size |
|-----------|---------------|----------|-----------|------|
| `host-tool-paths` | Bundle: absolute `/usr/bin/X` -> keep it when present, else bare name via PATH | H1, H2, H3 | none | S |
| `patch-hygiene` | Remove assert-only / dead sub-patches, pin counts, retire E1-E3 | T1-T6 | none | M |
| `packaging-deps` | deb Conflicts/Replaces + keyring/secret-tool Recommends; search provider install (deb/rpm/pacman) + gjs optional; Nix PATH + platforms; arm64 ELF-arch guard | P1-P3, N2, N3 (PATH part), A1 | none | S-M |
| `launcher-fixes` | `CLAUDE_LAUNCHER` on Nix, profile refresh vs `CLAUDE_ELECTRON`, XWayland gate, kwallet fall-through, AppImage `LD_LIBRARY_PATH`, read-only subcommands first | N1, L1, L3, L4, L5 | none | S-M |
| `diagnose-host-caps` | `--diagnose` "Host capabilities" section: one line per feature -> tool -> found/MISSING -> consequence, probing exactly what the app probes (literal paths, busctl portal probe); runs-at-all check for all 4 bridges; closing "Problems found" list | L2 | `host-tool-paths`, `launcher-fixes` | S-M |
| `cu-robustness` | Bridge runnable check (async, once, cached) + honest error text; NixOS KDE reaches the spectacle tier; `XDG_DATA_DIRS`; no `which` | C1, C2 | none | S-M |
| `rhel-cowork-qemu` (X1) | RHEL 9: make upstream's `qemu-system-x86_64` PATH walk find `/usr/libexec/qemu-kvm` (shim dir on PATH), after a boot test proves the helper's qemu args work on qemu-kvm | X1 | `launcher-fixes` | M |
| `tray-less-desktops` (X3) | Verify, then: with no StatusNotifierWatcher on the bus, close quits-to-hidden only if a tray exists, and `--startup` shows the window | X3 | none | M |
| `keep-awake-linux` (X4) | Verify `powerSaveBlocker` per DE, then hold a `systemd-inhibit` (logind) inhibitor while keep-awake is active where it is a no-op | X4 | none | M |
| `docs-refresh` | README / docs / skill corrections, per-compositor Quick Entry snippets, env vars, Cowork distro/arch notes, CHANGELOG | D1 + every module | all above | S |

Build order: `host-tool-paths`, `patch-hygiene` (incl. X6 rename audit),
`packaging-deps`, `launcher-fixes`, `cu-robustness`, `tray-less-desktops`,
`keep-awake-linux` in parallel -> `rhel-cowork-qemu`, `diagnose-host-caps` ->
`docs-refresh`. X3 and X4 each start with a verify step and stop for review if
the premise does not hold.

### `host-tool-paths` design (the only new patch)

New `patches/linux/fix_host_tool_paths_linux.nim`, target `index.js` (the
stub + chunks concat). It rewrites each literal to an expression that keeps
upstream's exact path when it exists and falls back to PATH resolution:

```js
// before
wf("/usr/bin/busctl",["--user","--timeout=2",...e])
// after
wf((require("fs").existsSync("/usr/bin/busctl")?"/usr/bin/busctl":"busctl"),["--user","--timeout=2",...e])
```

- Literals, exact count 1 each in the `index.js` concat: `"/usr/bin/busctl"`,
  `"/usr/bin/secret-tool"`, `"/usr/bin/kwallet-query"`. Plus `/usr/bin/sqlite3`
  inside the existing `fix_detected_projects_linux.nim` (our feature, our patch;
  no new patch for it).
- The `index.pre.js` busctl (KWallet preflight) is left alone: the launcher
  already covers that case, and it would need a second patch for no user gain.
- Positive idempotency: the rewritten expression is the marker; old literal
  count 0 and marker count 1 -> "already". Both present -> FAIL.
- `EXPECTED_PATCH_COUNT` 48 -> 49, PATCHES.md row, CHANGELOG.
- Why a patch and not a Nix substitution: the literals live inside `app.asar`,
  and non-systemd distros and AppImage have the same gap without Nix.

## Commands

```bash
cd patches && make -j"$(nproc)" && cd ..                        # compile patches
python3 scripts/check-upstream-absorbed.py tmp/app.asar.contents \
  tmp/extract/usr/lib/claude-desktop/resources/ion-dist            # P1/P2 probe (~13 s)
bash scripts/run-feature-tests.sh linux                         # touched category (also: core, community)
bash scripts/check-patch-sibling-noop.sh                        # P3
shellcheck -S error scripts/*.sh packaging/*/*.sh .github/scripts/*.sh
./scripts/build-local.sh                                        # full local build (Arch); do not install
node --check <each patched chunk>                               # done by build-patched-tarball.sh
docker run --rm -v "$PWD/build:/b" ubuntu:24.04 bash -c '...'    # deb install/Conflicts tests
```

## Project structure (touched areas)

```
patches/linux/fix_host_tool_paths_linux.nim   new (host-tool-paths)
patches/linux/*.nim                           patch-hygiene edits, fix_detected_projects_linux sqlite rewrite
js/cu_mode_preamble.js, js/cu_linux_executor.js   cu-robustness
scripts/claude-desktop-launcher.sh            launcher-fixes, diagnose-host-caps
scripts/build-patched-tarball.sh              ELF-arch guard
scripts/apply_patches.py                      EXPECTED_PATCH_COUNT; stale-input check moved here
packaging/{debian,rpm,pacman,nix,appimage}/   packaging-deps, L5
scripts/tests/linux/                          new harnesses (host paths, bridge runnable)
CONSTRAINTS.md                                delete retired exception rows E1-E3 (tightening only)
README.md, docs/, PATCHES.md, CHANGELOG.md, .claude/skills/linux/SKILL.md   docs-refresh
```

## Code style

Follow the existing patches: `regex` package (`re2`, `RegexMatch2`), never
`std/nre` (the CI host has no libpcre); `[\w$]+` for identifiers; `["`]`
quote classes; exact counts; `[FAIL]` + `quit(1)` on any shortfall; positive
end-state for "already".

```nim
const EXPECTED_PATCHES = 3
var applied = 0
for lit in ["/usr/bin/busctl", "/usr/bin/secret-tool", "/usr/bin/kwallet-query"]:
  let marker = "require(\"fs\").existsSync(\"" & lit & "\")"
  let oldCount = result.count("\"" & lit & "\"") - result.count(marker) * 2
  if oldCount == 0 and result.count(marker) == 1:
    echo &"  [OK] {lit}: PATH fallback already present"; inc applied; continue
  if oldCount != 1:
    echo &"  [FAIL] {lit}: expected 1 site, found {oldCount}"; continue
  # ... rewrite, inc applied
if applied < EXPECTED_PATCHES:
  echo &"  [FAIL] Only {applied}/{EXPECTED_PATCHES} patches applied"; quit(1)
```

Shell: bash, `shellcheck -S error` clean, existing `log` helpers. Docs: no
em-dashes, state the positive fact, provenance goes into CHANGELOG (one entry
per day).

## Testing strategy

- **Patches:** every changed patch passes the probe (ACTIVE, and P2 idempotent
  for T1/T3/T5 so their exception rows get deleted), `node --check`, and the
  `linux` harness category. `host-tool-paths` gets a harness in
  `scripts/tests/linux/` that runs the patched function against a fake PATH
  with no `/usr/bin/busctl` (resolves to the PATH copy) and with one (keeps the
  literal).
- **Packaging:** docker install tests: official `claude-desktop` deb then ours on
  ubuntu:24.04 (must replace cleanly, no dpkg error); `apt-cache` resolution of
  every Recommends on 22.04/24.04/debian:12/13; search provider files land at
  the right paths in deb/rpm/pacman payloads (`dpkg -c`, `rpm -qlp`, `tar -t`).
  Nix: `nix build` in the nixos/nix container for the PATH change.
- **Launcher:** the simulated-makeWrapper and AppImage-mount scenarios agent D
  used become regression checks; `shellcheck`.
- **Runtime spot-checks** (ask Patrick; I do not install): Wayland hotkey on a
  host without `/usr/bin/busctl` (Fedora43-KDE VM with busctl moved aside), GNOME
  search provider on the Ubuntu VM.

## Boundaries

- **Always:** fresh extract before patch work; exact counts; positive
  idempotency; run the probe + touched harness category at task end;
  CHANGELOG entry; keep upstream's Debian code path unchanged.
- **Ask first:** anything in the "Ask first" list below; any new patch beyond
  `fix_host_tool_paths_linux`; changing app-visible behavior; editing
  CI workflows; editing kwin-portal-bridge (mosi0815's repo, PR only).
- **Never:** weaken CONSTRAINTS.md (deleting a retired exception row is
  tightening); convert a dead patch into a guard; build-and-install or
  commit/push without being asked; hand-edit README install versions.

## Ask first

Approved into this pass: X1, X3, X4, X6. Still deferred: X2, X5, X7, X8.

| ID | Item | Why it is bigger |
|----|------|-----------------|
| X1 | RHEL 9 Cowork: `qemu-kvm-core` ships only `/usr/libexec/qemu-kvm`, so upstream's PATH walk for `qemu-system-x86_64` always fails, even with our `Recommends: qemu-kvm`. A `qemu-system-x86_64 -> /usr/libexec/qemu-kvm` shim on PATH might work. | Needs a real boot test on RHEL (machine type, virtio devices, vhost-vsock) |
| X2 | Real Nix aarch64: per-arch `src` + second hash, CI sed, flake `eachSystem` | CI change + Nix build on arm64 |
| X3 | Tray-less desktops (vanilla GNOME without AppIndicator, niri/sway without a bar): closing the window hides it into a tray that does not exist, and an autostart launch is invisible. Patch: treat the tray as disabled when no `org.kde.StatusNotifierWatcher` is on the bus. | Changes window semantics |
| X4 | `keepAwakeEnabled` uses `powerSaveBlocker`, which likely does nothing on wlroots/Hyprland/niri/i3/COSMIC. Patch: also hold a `systemd-inhibit` while active. | New behavior, needs verification first |
| X5 | Extra settings "System check" page showing the `diagnose-host-caps` data in-app | UI work |
| X6 | `fix_cross_device_rename.nim` audit (T7): pin to real cross-fs sites or remove | May remove a patch |
| X7 | Nix gapps env (`wrapGAppsHook3`) | Nix build work, conditional impact |
| X8 | Widen upstream's Ubuntu-22-only gate for the bundled virtiofsd to all distros (glibc 2.34, libseccomp + libcap-ng), dropping the system virtiofsd requirement everywhere but NixOS | New patch; needs a Cowork boot test per distro |

## Verify first (cheap tests before deciding)

| ID | Question | How |
|----|----------|-----|
| V1 | v2.7032.0 no longer ships `libEGL.so` / `libGLESv2.so` (1.46388.2 did). Does `CLAUDE_GPU_BACKEND=angle-gl` (`--use-gl=angle --use-angle=gl`) still work, or is it now a dead knob we document for #180? | Launch with the knob, check `chrome://gpu` / GPU process log |
| V2 | pre.js forces `GlobalShortcutsPortal` on for X11 too. Does the Quick Entry hotkey still fire on X11 (your XFCE box)? | One-minute manual test |
| V3 | Named-profile scope parse (see "fine" list) | Read xdg-desktop-portal's `parse_app_id_from_unit_name` |
| V4 | Portal probe has a 2 s timeout and is memoized per process; on autostart before the portal is up, hotkeys are off for the whole session | Autostart test on KDE VM; fix would be a launcher warm-up |

## Success criteria

- [ ] On a host without `/usr/bin/busctl` but with `busctl` on PATH, the Wayland
      hotkey registers (harness + one VM check); on Debian the call is unchanged.
- [ ] Chrome import finds `secret-tool` via PATH; deb Recommends pulls it.
- [ ] Installing our deb over the official `claude-desktop` succeeds in docker.
- [ ] GNOME search provider files installed by deb, rpm and pacman.
- [ ] Nix: autostart and profile entries survive GC and carry the wrapper env;
      `meta.platforms` matches what is built; python3/xdg-utils/sqlite on PATH.
- [ ] `--diagnose` prints a Host capabilities section and a Problems list; it
      has no side effects before dispatch.
- [ ] CU picks a bridge only if it runs; the error names the real cause.
- [ ] Probe: 49 ACTIVE, exception rows E1-E3 deleted (all patches pass P2),
      no counted assert-only sub-patch left in T1-T4.
- [ ] RHEL 9 (rockylinux:9 + KVM): upstream's Cowork probe finds qemu and the helper's VM boots, or X1 is closed as docs-only with the reason.
- [ ] X3/X4: verified premise + fix, or closed with evidence that the premise is false.
- [ ] X6: `fix_cross_device_rename` pinned to proven cross-fs sites, or removed.
- [ ] Every docs error in D1 corrected; CHANGELOG entry for the day.

## Decisions (2026-09-23)

1. Capability map approved, including the new `fix_host_tool_paths_linux` patch.
2. P1: deb `Conflicts: claude-desktop` + `Replaces: claude-desktop`; rpm `Conflicts: claude-desktop`.
3. X1, X3, X4, X6 are in this pass. X3/X4 may add a patch each (so up to 51,
   minus X6 if it removes one); each count change lands in the commit that adds
   or removes the file (CONSTRAINTS P4).
4. Runtime checks may use the VirtualBox VMs (Ubuntu, Fedora43-KDE) headless
   and docker (incl. `--device /dev/kvm` for the RHEL qemu-kvm boot test).
