# AGENTS.md - Project Guidelines

## Project Overview

This project repackages Anthropic's **official Claude Desktop Linux `.deb`** for the distros Anthropic does not ship (Arch via our own pacman repo, Fedora/RHEL via RPM, NixOS, AppImage, plus our own Debian/Ubuntu `.deb`). It applies JavaScript patches to the official build's `app.asar` to add Linux-only value-adds (Computer Use, custom themes, multi-profile, Quick Entry) and Linux fixes.

The official `.deb` (apt repo `https://downloads.claude.ai/claude-desktop/apt`) bundles its own **Electron** (44.4.3 as of v2.7032.0; authoritative source: the deb tree's `usr/lib/claude-desktop/version` file) and a **native Cowork VM backend**. We download it, verify GPG + SHA256, extract it, patch its `app.asar`, and repackage. We do not pin Electron or rebuild node-pty (both ship pre-built in the `.deb`).

**Layout invariant (2026-07-13):** every package ships the `.deb`'s `usr/lib/claude-desktop/` tree **verbatim** (binary renamed `claude-desktop` -> `claude`; patched `resources/app.asar` exe-adjacent; our CU bridges added to `resources/`). Electron auto-loads the adjacent asar - the official build's `OnlyLoadAppFromAsar` + `EnableEmbeddedAsarIntegrityValidation` fuses are on (integrity is not enforced on Linux, which is why a patched asar boots). The launcher passes NO asar on the command line, so `process.resourcesPath` and `app.isPackaged` behave exactly as on the stock Anthropic `.deb`. Never add a patch that redirects resource paths; put bundled files at their upstream `resources/` position instead. On NixOS the nixpkgs Electron dist is merged with our `resources/` into one directory to preserve the same adjacency.

- **Target platform:** Linux only (X11, Wayland, XWayland). No macOS/Windows code.
- **Architectures:** x86_64 (primary) and aarch64.
- **glibc floor:** 2.34 (RHEL 9 / Ubuntu 22.04). Debian 11 is not supported.
- **Native binaries we ship** (the four Computer Use bridges) build for x86_64 AND aarch64, each with a stated glibc floor or as static musl; CI verifies with `objdump -T | grep GLIBC_`. A new native binary picks the floor of its minimum viable distro.
- **RPM caveat:** the spec excludes the bundled tree from rpm's automatic ELF dependency generator (`__requires_exclude_from` in `packaging/rpm/claude-desktop-extra.spec`); without it the bridges' glibc-2.39 symbols block install on RHEL 9. CI's rockylinux:9 install test guards this.

The full distro, session-type, input/screenshot backend and per-bridge glibc tables live in the `/linux` skill (`.claude/skills/linux/SKILL.md`).

**Key constraint:** the official `.deb` re-minifies between releases. Every minified variable name, function signature, and feature flag can change, so patches and docs must be re-validated on each upstream update.

## Commands

```bash
./scripts/build-local.sh                      # Arch: download latest official .deb, patch, package
./scripts/build-local.sh --version 1.17282.0  # a specific upstream version
./scripts/build-local.sh --deb /path/to/claude-desktop_amd64.deb
./scripts/build-ubuntu-local.sh               # Ubuntu/Debian
./scripts/build-fedora-local.sh               # Fedora/RHEL
# local builds skip the Electron smoke test; opt in with --smoke-test (or SKIP_SMOKE_TEST=0). CI always runs it.

cd patches && make -j"$(nproc)" && cd ..      # compile all Nim patches
python3 scripts/check-upstream-absorbed.py tmp/app.asar.contents \
  tmp/extract/usr/lib/claude-desktop/resources/ion-dist   # absorption probe (~11 s, pristine extract)
bash scripts/run-feature-tests.sh <community|core|linux>  # feature harnesses for the category you touched
./scripts/validate-patches.sh ./tmp/app.asar.contents
node --check <patched.js>
```

Where each check runs:
- **Commit:** `.githooks/pre-commit` runs `nph --check`, `nim check` and `shellcheck -S error` on staged files.
- **Task end** (any change under `patches/` or `js/`, budget under 90 s): `make`, the absorption probe against a fresh extract, and the feature tests for the touched category.
- **Build** (local + CI): `scripts/build-patched-tarball.sh` runs the probe, the orchestrator, and `node --check` per chunk.
- **CI:** all of the above plus the full harness suite, sibling-noop check, jsonc template sync, `desktop-file-validate`, and the smoke test.

## Adding a feature

1. Clone the repo and run `./scripts/build-local.sh`.
2. Write one patch following [Adding your own feature](docs/patches.md#adding-your-own-feature).
3. Rebuild and check the feature in the app.
4. Open a PR.

The project skills in `.claude/skills/` (`/update`, `/fresh-upstream`, `/debug`, `/linux`, ...) are optional helpers for Claude Code users.

## Patch strictness rules

Match JS identifiers with `[\w$]+`, never bare `\w+`: minified names can contain `$` (`F$e`, `$S`). Search extracted bundles with `grep -a` (they contain NUL bytes; `rg -a --no-ignore` can silently find nothing).

**Every sub-patch MUST succeed or the whole patch script MUST fail (exit 1).** This is critical because:

- A failed sub-patch means the upstream code changed - the pattern no longer matches
- Silent failures hide regressions that only surface as broken features at runtime
- The correct response to a failed match is *investigation*, not silent acceptance

**Required pattern for multi-patch Nim scripts:**

```nim
const EXPECTED_PATCHES = 5  # A, B, C, D, E
var patchesApplied = 0

# ... each successful sub-patch increments patchesApplied ...

if patchesApplied < EXPECTED_PATCHES:
  echo &"  [FAIL] Only {patchesApplied}/{EXPECTED_PATCHES} patches applied"
  quit(1)
```

**Rules:**
1. Count expected patches and require ALL to succeed (or be detected as "already applied")
2. Never use `[WARN]` + continue for a patch that doesn't match - use `[FAIL]` and don't increment the counter
3. "Already patched" detection (idempotency) counts as success - increment the counter. **But it MUST be a positive assertion that the desired end-state is present** (see Rule 6).
4. When a patch fails after an upstream update, investigate why:
   - **Pattern changed:** The minified variable names shifted - update the regex
   - **Code refactored:** The target code was restructured - rewrite the patch approach
   - **Feature removed:** The code we patched no longer exists - the patch can be removed
   - **Feature upstreamed:** Anthropic added native Linux support - **remove the patch** (`git rm`). Once there is nothing of ours left to inject, the patch only asserts upstream's own behavior; we keep only patches that modify the bundle. Do NOT convert it to a regression guard.
5. Never add a new patch with `[WARN]`-on-failure or `patchesApplied == 0` as the only check

6. **No false success reporting - an `[OK]`/"already patched" line must never be backed by a false premise.**
   A patch must report success only when it has *positively verified* the desired end-state exists in the
   output. The classic trap is an idempotency check that keys off the **absence** of the old pattern:

   This governs the "already patched" (idempotency) branch of an **active** patch - one that injects
   something. It must check that its own injected result is present, not that the old pre-patch pattern
   is merely gone. (Example uses a hypothetical patch that injects `__cdbInjectedMarker` before a call.)

   ```nim
   # BAD - reports "already patched" the moment upstream refactors the old code away,
   # even if OUR injection was NEVER applied. The [OK] is a lie.
   if "oldUpstreamPattern" notin result:
     echo "  [INFO] already patched"; return

   # GOOD - assert OUR injected end-state is actually present; fail loud if it is not.
   if result.contains(re2"__cdbInjectedMarker\([\w$]+\)"):
     echo "  [OK] injection already present (idempotent)"; return
   raise newException(ValueError, "neither old pattern nor our injection found - re-audit")
   ```

   Rules of thumb:
   - "Already patched" / "already applied" must check for the **patched result** (the string/shape the
     patch produces, or the behavior it guarantees), NOT merely that the pre-patch pattern is gone.
     "Old pattern absent" ≠ "new behavior present" - those diverge the instant upstream refactors.
   - If a feature was upstreamed and there is nothing left to rewrite, **remove the patch** (`git rm`) -
     see Rule 4. A patch that changes nothing in the bundle and only asserts upstream's own behavior is
     forbidden; pure assert-only "regression guard" patches were retired 2026-07-15. This rule
     (positive-end-state assertion for idempotency) still governs the "already patched" branch of
     **active** patches - those that DO inject: they must verify the patched result is present, not merely
     that the pre-patch pattern is gone.
   - Every `[OK]`/`[INFO]` success message must correspond to a real, checked fact. If you cannot assert
     the fact, you must `[FAIL]`. Silence and false-positives are worse than a loud build failure.

**When the absorption probe blocks** (`scripts/check-upstream-absorbed.py`, runs before any patch applies):
- **ABSORBED / PARTIAL:** audit deeply - confirm upstream ships the *same behavior on Linux*, not just a string that looks like our end state (read the new code path, check the platform gate, spot-check a real install if user-visible). Then `git rm` the patch (or drop the sub-patch), bump `EXPECTED_PATCH_COUNT`, update `docs/patches.md` and `CHANGELOG.md`. ABSORBED can also mean an earlier patch of ours already produces the result: that is a redundant patch, same treatment.
- **FAILED is not a removal signal.** A patch that no longer finds its target is re-fitted, unless the audit shows the feature was upstreamed.

Also enforced:
- A patch writes only its own `@patch-target`. The orchestrator stages each target alone, so a sibling write is a silent no-op (`bash scripts/check-patch-sibling-noop.sh`).
- The count pins `EXPECTED_PATCH_COUNT` (`scripts/apply_patches.py`) and `EXPECTED_TEST_HARNESSES` (`scripts/run-feature-tests.sh`) only change in the commit that adds or `git rm`s the file.
- Every patched JS part must pass `node --check`.
- Loosening a gate (an `IDEMPOTENCY_EXCEPTIONS` entry in `scripts/check-upstream-absorbed.py`, a lowered count) needs @patrickjaja in the commit.

## Debugging patch failures

Always work against a **freshly extracted, pristine** bundle in `./tmp/` (re-extract if it is older than today; stale extracts have different minified names). The main bundle is code-split: `index.js` is a loader stub, the code lives in `index.chunk-<hash>.js` + `index.pre.js`, so search across `.vite/build/index*.js`; the orchestrator stages stub + chunks as ONE file and splits it back after patching. The step-by-step (extract, re-fit a pattern, test one patch, audits) is the `/update` skill: `.claude/skills/update/SKILL.md`.

## Version-sensitive artifacts

These embed assumptions about upstream internals and **must be challenged on every release**:

| File | What's fragile | Update workflow |
|------|---------------|-----------------|
| `patches/{linux,community,core}/*.nim` | Regex patterns matching minified JS | Build fails -> fix patterns -> `make` -> `node --check` |
| `baseline/CLAUDE_FEATURE_FLAGS.md` | Function names, GrowthBook IDs, architecture details | Feature flag audit (`/update` skill) |
| `docs/patches.md` | The patch catalog: one table per `patches/` subdirectory, each row linking `patches/<group>/<name>.nim` | Review after patches are fixed |
| `README.md` | Feature descriptions and the per-directory patch counts. **NOT** install command version numbers (CI updates those) | Review after patches are fixed |
| `baseline/CLAUDE_BUILT_IN_MCP.md` | Built-in MCP server names, registration patterns | Check `registerInternalMcpServer` calls in new JS |
| `js/extra_settings_main.js` (`__cdbEx_DEPLOY_KEYS`) | The managed-settings key catalog the Extra -> Deployment panel renders, pinned from the bundle's zod schema; also the port of the 3p-dir resolver and mode decision | ``rg -ao 'flatKey:[`"][A-Za-z0-9_]+[`"]' tmp/app.asar.contents/.vite/build/index.pre.js \| sort -u`` and diff against the catalog; `node scripts/tests/core/test-deployment-main.mjs` |
| `kwin-portal-bridge/src/teach_overlay.rs` (`TeachStepPayload`) | The only place our CU bridges are pinned to upstream DATA: `js/executor_linux.js` forwards upstream's teach-step payload verbatim and the Rust side requires `explanation`. A rename is a runtime serde failure on a green build, KDE Wayland only. This repo is **mosi0815's** - fixes go through a PR to `mosi0815/kwin-portal-bridge` | ``grep -ao 'onTeachStep({[^}]*}' <new-bundle-concat>``; keys must still be `explanation` / `nextPreview` / `anchorLogical` |
| `baseline/PANEL_TABS_ANCHORS.md` | Panel-tabs DOM/fiber anchors and the `[cdb-tabs]` warning keys that mean an anchor moved | Re-run the console recipes in that file against the new build |
| `baseline/FILES_QUICK_OPEN_ANCHORS.md` | Files quick-open anchors and the `[cdb-qopen]` warning keys | Re-run its console recipes; `grep -o 'of this\.index\.search(' fileIndexWorker.js` must hit exactly once |
| `baseline/ION.md` | ion-dist SPA bundle stats, patched patterns, config key schema | ion-dist audit (`/update` skill) |
| `baseline/PLATFORM_GATE_BASELINE.md` | darwin/win32 conditional counts, gate classifications (PATCHED/NATIVE/STUB/PORTABLE) | Platform gate re-audit (`/update` skill) |
| `CHANGELOG.md` | Version-specific notes | **One entry per day**, newest first; informative and short, not a debug log |
| `.upstream-version` | The version patches & docs were last validated against | Bumped automatically by the release job; bump manually only when handling a version fully by hand |

**Rule of thumb:** if a doc references a specific minified name, it will be wrong after the next upstream release. Use `[\w$]+` wildcards in patches; in docs, always note the version the names apply to.

**Reading `CHANGELOG.md`:** it is large and newest-first. Read only the head (`offset: 1, limit: 60`) unless you need a past release's notes.

## CI-managed files (do NOT edit manually)

- **README.md install command version numbers** (`.deb`, `.rpm`, `.AppImage` filenames) are rewritten by the `release` job in `.github/workflows/build-and-release.yml` via `sed`. Manual edits cause merge conflicts with the CI commit.

## Update workflow

Upstream bumps are handled automatically: `version-check.yml` (2-hourly) detects a new version, opens a tracking issue, and dispatches `build-and-release.yml` in release mode. The strictness rules make that run the arbiter. **Green:** packages published (incl. the signed pacman repo db), README versions + Nix hash + `.upstream-version` committed, tracking issue closed. **Red:** a comment lands on the tracking issue - that is the signal for manual work: run the `/update <version>` skill.

A green build proves the patches *applied*, not that runtime behavior is correct (a wildcard regex can match a wrong site after a re-minify, and remote claude.ai code can change without a desktop release). Spot-check a real install after notable bumps.

## Profile system (multi-instance)

The launcher (`scripts/claude-desktop-launcher.sh`) resolves `CLAUDE_PROFILE` from `--profile=NAME`, the env var, or its own basename (`claude-desktop-NAME`), then exports it so child processes inherit it. Default profile = unset = no suffix; a named profile suffixes everything with `-<name>`.

| Resource | Mechanism | Where to look in code |
|----------|-----------|----------------------|
| Electron userData | `--user-data-dir` flag in launcher | All `app.getPath("userData")` consumers auto-redirect |
| Claude Code config | `CLAUDE_CONFIG_DIR` env exported by launcher | Honored by `@anthropic-ai/claude-code` CLI |
| Quick Entry socket | `process.env.CLAUDE_PROFILE` read in JS | `patches/core/fix_quick_entry_cli_toggle.nim` |
| systemd scope | `${profile_suffix}` in launcher | `claude-desktop-launcher.sh` |
| Per-profile Electron binary | hardlink -> reflink -> copy fallback, refreshed from `CLAUDE_ELECTRON` when set (Nix) | `~/.local/lib/claude-desktop/<APP_ID>-<name>`. Does NOT give the window its own identity: WM_CLASS / Wayland app_id is `com.anthropic.Claude` for every profile; `fix_profile_window_title.nim` puts the profile name in the title |
| SSO callback routing | marker file written by JS hook on `shell.openExternal`; launcher reads it to dispatch an incoming `claude://` URL | `patches/core/fix_profile_url_routing.nim` (writer) + launcher URL-handler block (reader) |

**Rule when adding a patch:** if it writes to a fixed user-level path, prefer `app.getPath("userData")` (auto-isolates) over `os.homedir()+"/.config/Claude"`. If it opens a Unix socket or pipe owned by the Electron process itself, append `process.env.CLAUDE_PROFILE` to the path like `fix_quick_entry_cli_toggle.nim` does. If the socket belongs to a shared user-level daemon, do NOT suffix it - clients across all profiles connect to the same listener. If the patch spawns a long-lived child process that holds state, make sure it gets `CLAUDE_PROFILE` and `CLAUDE_CONFIG_DIR` (`child_process.spawn` inherits `process.env` by default - verify, don't assume).

## Logs

Runtime logs are in `~/.config/Claude/logs/`. When 3P mode is active (an `inferenceProvider` set, e.g. in `/etc/claude-desktop/managed-settings.json`, or `3P mode active` in `main.log`), use `~/.config/Claude-3p/` instead; named profiles add `-<profile>`. When in doubt, read the running process's `--user-data-dir` (`pgrep -af claude`).

- `claude-patches.log` - OUR patch diagnostics (`[claude-cu]`, `[quick-entry]`, `[CustomThemes]`, ...), 2 MiB rotation to `.old`, also mirrored to fd 2.
- `main.log` (Electron main), `claude.ai-web.log` (web content), `cowork_vm_node.log` (Cowork VM), `mcp.log` + `mcp-server-*.log`.

**Do NOT rely on `console.log` in main-process patch code** - the official `.deb` build discards console/`process.stdout` writes. Use `globalThis.__cdbDiag(...)` (defined in `js/cu_mode_preamble.js`), or `(globalThis.__cdbDiag||console.log)(...)` in patches that must not depend on the CU patch. The Cowork/Dispatch debug recipe (audit.jsonl, dispatch log greps) is the `/debug` skill.

## Feature flags

[baseline/CLAUDE_FEATURE_FLAGS.md](baseline/CLAUDE_FEATURE_FLAGS.md) is the reference: flag catalog, the 3-layer override architecture, GrowthBook IDs, and how `enable_local_agent_mode.nim` bypasses the production gate. Function names in it are version-specific.

## File structure

```
patches/           # Nim patch sources (.nim) + Makefile, compiled to native binaries (ls patches/*/*.nim)
patches/linux/     #   Linux compatibility - always on, not user-configurable (33)
patches/community/ #   Opt-in features, each with a switch in Settings -> Extra -> Community Features (10)
patches/core/      #   Always-on infrastructure: Extra settings pages, theme engine, GrowthBook overrides, multi-profile (7)
js/                # Shared JS snippets embedded by Nim patches via staticRead ("../../js/..." from a patch)
scripts/           # Build, validation, and launcher scripts
scripts/tests/     # Feature test harnesses, grouped like patches/ (run: scripts/run-feature-tests.sh)
packaging/         # Per-format packaging: apt, debian, rpm, appimage, nix, pacman, arch (PKGBUILD.template + .install)
docs/              # Per-feature deep-dives, the patch catalog (patches.md), troubleshooting.md, command-line.md
baseline/          # Version-sensitive reference docs re-validated each release
.claude/skills/    # Optional Claude Code skills for this repo (/update, /debug, /linux, ...)
```

Each patch has a `# @patch-target:` and `# @patch-type: nim` header. The orchestrator (`scripts/apply_patches.py`) discovers them recursively across the three subdirectories and applies them in **basename order** (the directory only classifies a patch, it does not order it). It pins the total in `EXPECTED_PATCH_COUNT` and fails loud when discovery finds a different number - bump the constant in the same commit that adds or removes a patch.

## Test VMs

```
# Ubuntu VM
vboxmanage startvm "Ubuntu"
# Credentials: osboxes / osboxes.org
# SSH (port 2222) is unreliable - use guest control instead:
# Copy file to VM:  vboxmanage guestcontrol "Ubuntu" copyto --target-directory /home/osboxes/ <file> --username osboxes --password "osboxes.org"
# Run command in VM: vboxmanage guestcontrol "Ubuntu" run --exe /bin/bash --username osboxes --password "osboxes.org" -- bash -c "<cmd>"

# Fedora 43 KDE VM (RPM testing)
vboxmanage startvm "Fedora43-KDE"
# SSH: ssh -p 2223 localhost
# Shared folder: /tmp/fedora-test -> auto-mounted in guest
# Install RPM: sudo dnf install /media/sf_shared/claude-desktop-extra-*.x86_64.rpm
```
