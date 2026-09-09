# AGENTS.md - Project Guidelines

## Project Overview

This project repackages Anthropic's **official Claude Desktop Linux `.deb`** for the distros Anthropic does not ship (Arch via our own pacman repo primary, plus Fedora/RHEL via RPM, NixOS, AppImage, and our own Debian/Ubuntu `.deb`). It applies JavaScript patches to the official build's `app.asar` to add Linux-only value-adds (Computer Use, custom themes, multi-profile, Quick Entry) and Linux fixes.

The official `.deb` (apt repo `https://downloads.claude.ai/claude-desktop/apt`) bundles its own **Electron** (44.2.0 as of v1.49585.0; authoritative source: the deb tree's `usr/lib/claude-desktop/version` file) and a **native Cowork VM backend**. We download it, verify GPG + SHA256, `dpkg-deb -x` it, patch its `app.asar`, and repackage. We no longer ingest the Windows MSIX, and we no longer pin Electron or rebuild node-pty (both are bundled in the official `.deb`).

**Layout invariant (2026-07-13):** every package ships the `.deb`'s `usr/lib/claude-desktop/` tree **verbatim** (binary renamed `claude-desktop` -> `claude`; patched `resources/app.asar` exe-adjacent; our CU bridges added to `resources/`). Electron auto-loads the adjacent asar - the official build's `OnlyLoadAppFromAsar` + `EnableEmbeddedAsarIntegrityValidation` fuses are on (integrity is not enforced on Linux, which is why a patched asar boots). The launcher passes NO asar on the command line, so `process.resourcesPath` and `app.isPackaged` behave exactly as on the stock Anthropic `.deb`. Never add a patch that redirects resource paths; put bundled files at their upstream `resources/` position instead. On NixOS the nixpkgs Electron dist is merged with our `resources/` into one directory to preserve the same adjacency.

**Target platform:** Linux only. We do NOT need macOS or Windows compatibility — all patches target Linux exclusively (X11, Wayland, XWayland).

**Architectures:** x86_64 (primary) and aarch64 (Raspberry Pi 5, NVIDIA Jetson/DGX Spark, etc.). Any native binary **we** ship (`kwin-portal-bridge`) must be built for both architectures. (node-pty arrives pre-built for both arches inside the official `.deb`.)

**Supported distros & session managers:**

| Distro | Packaging | Min glibc | Arch |
|--------|-----------|-----------|------|
| Arch Linux | own pacman repo (`claude-desktop-extra`) | 2.41 (rolling) | x86_64, aarch64 |
| Ubuntu 22.04+ | `.deb` | 2.35 | amd64, arm64 |
| Debian 12+ | `.deb` | 2.36 | amd64, arm64 |
| Fedora 40+ | `.rpm` | 2.39 | x86_64, aarch64 |
| RHEL 9+ | `.rpm` | 2.34 | x86_64, aarch64 |
| NixOS | Nix flake | 2.40 (current) | x86_64, aarch64 |
| NVIDIA Jetson (JetPack 6) | `.deb` | 2.35 | aarch64 |
| Any (glibc) | `.AppImage` | varies | x86_64, aarch64 |

**glibc floor is 2.34** (RHEL 9 / Ubuntu 22.04). Debian 11 (bullseye, glibc 2.31) is **no longer supported** — the official Linux `.deb` we repackage targets newer glibc.

**glibc floor for binaries we ship:**

| Binary | glibc floor | Rationale | CI build base |
|--------|-------------|-----------|---------------|
| x11-bridge | none (static musl) | Pure Rust, fully static — runs everywhere incl. NixOS | `ubuntu:noble` (rustup musl targets) |
| wlroots-bridge | none (static musl) | Pure Rust, fully static — runs everywhere incl. NixOS | `ubuntu:noble` (rustup musl targets) |
| gnome-portal-bridge | 2.39 (Ubuntu Noble) | lamco-pipewire calls pw_stream_get_nsec + extended pw_time - needs PipeWire >= 1.0.5 runtime (Noble/Fedora 40+/Debian 13); Ubuntu 22.04 (0.3.48) and Debian 12 (0.3.65) cannot even load the binary | `ubuntu:noble` + native cross |
| kwin-portal-bridge | 2.39 (Ubuntu Noble) | KWin 6.6+ only ships on Noble+ / Fedora 40+ | `ubuntu:noble` + native cross |

CI enforces the floor via `objdump -T | grep GLIBC_` verification. If a new native binary is added, pick the floor that matches its minimum viable distro. (node-pty is not in this table — it is bundled pre-built in the official `.deb`, not built by us.)

**RPM packaging caveat:** per-binary floors above the distro floor only work because the spec excludes the bundled tree from rpm's automatic ELF dependency generator (`__requires_exclude_from` in `packaging/rpm/claude-desktop-extra.spec`); without it, the gnome/kwin bridges' glibc-2.39 symbols become package-level requirements and the rpm cannot install on RHEL 9 (glibc 2.34). CI's rockylinux:9 install test guards this permanently.

| Session type | Compositors / DEs | Input backend | Screenshot tools |
|-------------|-------------------|---------------|-----------------|
| X11 | Any (GNOME, KDE, i3, …) | `x11-bridge` (bundled) | `x11-bridge` (bundled) |
| Wayland — wlroots/wlr-protocols | Sway, Hyprland, Niri | `wlroots-bridge` (bundled) | `wlroots-bridge` (bundled) |
| Wayland — GNOME | GNOME Shell (PipeWire >= 1.0.5, i.e. Ubuntu 24.04+/Fedora 40+/Debian 13+) | `gnome-portal-bridge` (bundled) | `gnome-portal-bridge` (bundled; consent dialog, persisted on GNOME 46+) |
| Wayland — KDE | KDE Plasma 6.6+ | `kwin-portal-bridge` (bundled) | `kwin-portal-bridge` (bundled) |
| XWayland | Any Wayland compositor | `x11-bridge` (bundled) | `x11-bridge` (bundled) |
| Wayland — exotic (residual) | COSMIC, Enlightenment, … | `ydotool` (+`ydotoold`), else x11-bridge/XWayland | Electron `desktopCapturer` / `COWORK_SCREENSHOT_CMD` |

Patches emit `[claude-cu] diagnostics:` lines showing detected session, available/missing tools, and screenshot cascade order. They are written to **`~/.config/Claude/logs/claude-patches.log`** (profile/3p-aware via userData; 2 MiB rotation to `.old`) and to raw **fd 2** (visible in a terminal launch). When debugging locally, read that file directly; for remote issue reporters, ask them to attach it. **Do NOT rely on `console.log` in main-process patch code** - the official `.deb` build discards console/`process.stdout` writes entirely (the fds are healthy; proven 2026-07-06). Use the injected `globalThis.__cdbDiag(...)` sink (defined in `js/cu_mode_preamble.js`), or `(globalThis.__cdbDiag||console.log)(...)` in patches that must not depend on the CU patch.

**Key constraint:** The official Linux `.deb` is managed by Anthropic and re-minifies between releases. Every minified variable name, function signature, and feature flag can change. This makes the project inherently fragile — patches and documentation must be re-validated on each upstream update.

## Version-Sensitive Artifacts

These files embed assumptions about upstream internals and **must be challenged on every release**:

| File | What's fragile | Update workflow |
|------|---------------|-----------------|
| `patches/{linux,community,core}/*.nim` | Regex patterns matching minified JS | Build fails → fix patterns → `make` → `node --check` |
| `baseline/CLAUDE_FEATURE_FLAGS.md` | Function names, GrowthBook IDs, architecture details | Run Feature Flag Audit (Prompt 3 in update-prompt.md) |
| `PATCHES.md` | The patch catalog: one table per `patches/` subdirectory (Community features, Core infrastructure, Linux compatibility), each row linking `patches/<group>/<name>.nim`. Debug `rg` anchor patterns live in the patch sources themselves, not here. | Review after patches are fixed |
| `README.md` | Feature descriptions, and the three-bullet patch summary with its per-directory counts (the tables themselves live in `PATCHES.md`). **NOT** install command version numbers - those are updated automatically by CI. | Review after patches are fixed |
| `baseline/CLAUDE_BUILT_IN_MCP.md` | Built-in MCP server names, registration patterns | Check `registerInternalMcpServer` calls in new JS |
| `js/extra_settings_main.js` (`__cdbEx_DEPLOY_KEYS`) | The managed-settings key catalog the Extra → Deployment panel renders, pinned from the bundle's own zod schema. A key upstream removes keeps being offered; a key it adds is missing. Also the faithful port of the 3p-dir resolver and the mode decision | ``rg -ao 'flatKey:[`"][A-Za-z0-9_]+[`"]' tmp/app.asar.contents/.vite/build/index.pre.js \| sort -u`` (the minifier emits backtick strings since v1.26832.0) and diff against the catalog; `node scripts/tests/core/test-deployment-main.mjs` asserts the shape |
| `baseline/PANEL_TABS_ANCHORS.md` | Panel-tabs DOM/fiber anchors: the row shape, `MAX_CHAIN_HOPS`, the literal `"chat"` tile id, the label->tileId map (upstream's `Browser` is tile `preview`), the Session-actions menu, and the runtime warnings that mean an anchor moved | Re-run the console recipes in that file against the new build; every `[cdb-tabs]` warning key listed there names the anchor that broke |
| `baseline/FILES_QUICK_OPEN_ANCHORS.md` | Files quick-open anchors: the `data-perf-screen="file"` pane, the tree rows, the `Show file tree` toolbar button, the fiber `onPreview(path, line)` handler with its `root` prop, the `entry` props, the `fetchMentionOptions` result shape, and the `[cdb-qopen]` warning keys | Re-run the console recipes in that file against the new build; also re-check the `FileIndexHost.search` anchor of `add_feature_files_quick_open_worker.nim` (`grep -o 'of this\.index\.search(' fileIndexWorker.js` must hit exactly once before patching). The worker-host fork that carries the `CDB_FILES_QUICK_OPEN` gate (``grep -oE 'utilityProcess\.fork\([^)]{0,120}\)' index*.js``) needs no manual check - `add_feature_files_quick_open.nim` sub-patch B rewrites it to pass `env:Object.assign({},process.env)` and its strict count (exactly one match) fails the build if the shape moves |
| `baseline/ION.md` | ion-dist SPA bundle stats, patched patterns, config key schema | Run ion-dist checks (Prompt 4 in update-prompt.md) |
| `baseline/PLATFORM_GATE_BASELINE.md` | darwin/win32 conditional counts, gate classifications (PATCHED/NATIVE/STUB/PORTABLE) | Run platform gate re-audit (Prompt 5 in update-prompt.md) |
| `CHANGELOG.md` | Version-specific notes | Add new entry for each release. **One entry per day** - merge multiple changes into a single dated `##` section with subsections. **Keep notes informative, simple, and straight** - state what changed and the conclusion; don't dump verification minutiae, raw diffs, byte counts, or every minified identifier. The CHANGELOG is a reader's summary, not a debug log. |
| `.upstream-version` | The Claude Desktop version our patches & docs were last validated against | **Normally bumped automatically**: the release job commits it on every successful release (including the auto-release runs dispatched by `version-check.yml`). Bump + commit manually only when handling a version fully by hand — even a trivial build bump with no public release. `version-check.yml` compares the highest `Version:` in the official apt Packages index against this file; a mismatch with no open tracking issue triggers a new auto-release attempt. |

**Rule of thumb:** If a doc references a specific minified name, it will be wrong after the next upstream release. Use `\w+` wildcards in patches; in docs, always note the version the names apply to.

**Reading `CHANGELOG.md`:** It is large and append-at-top (newest entry first). To see the current state, **read only the head — `offset: 1, limit: 60`** (the most recent dated `##` section). Do not read the whole file; older entries are historical context you rarely need. Read further down only when you specifically need a past release's notes.

## CI-Managed Files (Do NOT Edit Manually)

- **README.md install command version numbers** (`.deb`, `.rpm`, `.AppImage` filenames) — updated automatically by the `release` job in `.github/workflows/build-and-release.yml` via `sed`. Manual edits will cause merge conflicts with the CI commit.

## Update Workflow

**Upstream bumps are handled automatically by default.** Since we repackage the official Linux `.deb` (Anthropic maintains 1p Linux support), most releases need zero manual work: `version-check.yml` (2-hourly) detects a new version, opens a tracking issue, and dispatches `build-and-release.yml` in release mode. The patch strictness rules make that run the arbiter — every sub-patch must apply or the build fails loud. Green run → packages published (including the signed pacman repo db as release assets), README versions + Nix hash + `.upstream-version` committed, tracking issue auto-closed. Red run → a comment lands on the tracking issue; **that comment is the signal for manual work**.

Caveat: a green build proves the patches *applied*, not that runtime behavior is correct — a wildcard regex can in principle match a wrong site after a re-minify, and remote claude.ai code can change behavior without any desktop release (issue #173 was exactly that). The safety net is the strict counts + positive end-state assertions + smoke test; spot-check a real install after notable bumps.

**Manual path (only when the auto-release fails, or for a deep audit):** run the `/update <version>` skill, or follow [update-prompt.md](update-prompt.md) — copy-paste prompts for:

1. **Prompt 1:** Build & fix patches (download official `.deb`, run build, fix failures). For each failing patch, decide first: pattern moved (fix regex) vs **feature upstreamed (remove the patch — the expected direction over time; do NOT convert to a regression guard)**.
2. **Prompt 2:** Diff & discover new changes (compare old vs new JS bundles)
3. **Prompt 3:** Feature flag audit (catch new/changed flags)

Quick start:
```bash
# Build (auto-cleans build dir, downloads the latest official .deb, applies patches, packages)
./scripts/build-local.sh
# Or build from a specific version / local .deb:
./scripts/build-local.sh --version 1.17282.0
./scripts/build-local.sh --deb /path/to/claude-desktop_amd64.deb
```

### Building on Ubuntu / Debian

```bash
# this is how you build it on ubuntu
./scripts/build-ubuntu-local.sh
```

All local build scripts skip the Electron smoke test by default. Pass
`--smoke-test` to opt in, or set `SKIP_SMOKE_TEST=0` in the environment.
CI runs the smoke test automatically.

See also: [UPDATE-PROMPT-CC-INPUT-MANUAL.md](UPDATE-PROMPT-CC-INPUT-MANUAL.md) for the one-liner to kick off the process. (Step-by-step patch debugging is covered in the "Debugging Patch Failures" section below and in update-prompt.md; the formerly linked validate_and_fix_claude-setup-x64.md was an MSIX-era local scratch file, never tracked in git.)

## Debugging Patch Failures

**IMPORTANT:** Always work against a **freshly extracted** bundle in `./tmp/` (project-local, gitignored). If the official `.deb` or any extracted `index.js` in `./tmp/` is older than today, re-fetch from upstream and re-extract before doing any patch work (review, debugging, writing). Stale extracts have different minified variable names and will lead to wrong conclusions.

```bash
# Re-download + extract in one step (compares local vs upstream version automatically):
./scripts/build-local.sh

# Or manually: extract a local .deb to ./tmp/:
mkdir -p tmp
dpkg-deb -x ./tmp/claude-desktop_*_amd64.deb ./tmp/extract
asar extract ./tmp/extract/usr/lib/claude-desktop/resources/app.asar ./tmp/app.asar.contents
# The unpatched main bundle is at: ./tmp/app.asar.contents/.vite/build/
# Since v1.19367.0 it is CODE-SPLIT: index.js is a tiny loader stub and the real
# code lives in content-hashed siblings (index.chunk-<hash>.js; hashes change
# every release) plus index.pre.js (the package.json main). Patches still target
# index.js: the orchestrator stages the stub + all chunks as ONE concatenated
# file (marker comments between parts) and splits it back after patching, so
# match counts apply across the whole logical bundle. To search "the bundle",
# rg across .vite/build/index*.js, not just index.js.

# ion-dist (3P config SPA) is in the .deb's resources, not inside app.asar:
#   ls ./tmp/extract/usr/lib/claude-desktop/resources/ion-dist/
```

When patches fail after a new Claude Desktop release, follow this workflow:

### 1. Extract and Test Locally

```bash
# Extract the official .deb (the build script leaves it in ./tmp/; adjust path/arch as needed)
mkdir -p tmp
dpkg-deb -x ./tmp/claude-desktop_*_amd64.deb ./tmp/extract

# Extract app.asar
asar extract ./tmp/extract/usr/lib/claude-desktop/resources/app.asar ./tmp/app.asar.contents
```

### 2. Run Validation Script

```bash
./scripts/validate-patches.sh ./tmp/app.asar.contents
```

Test individual patches directly using compiled Nim binaries:

```bash
# Compile first (or use Docker fallback)
cd patches && make -j$(nproc) && cd ..

# Run a single patch on a copy. For the code-split main bundle, test against a
# stub+chunks concatenation (what the orchestrator stages), not index.js alone:
B=./tmp/app.asar.contents/.vite/build
{ cat $B/index.js; for c in $B/index.chunk-*.js; do printf '\n/*__CDB_SPLIT__%s__*/\n' "$(basename $c)"; cat "$c"; done; } > ./tmp/test-index.js
patches/linux/fix_quick_entry_position ./tmp/test-index.js
echo "Exit code: $?"
```

### 3. Find New Patterns

When patterns don't match, the minified variable names likely changed. Search for the actual patterns:

```bash
# Find getPrimaryDisplay patterns (for quick_entry patch)
rg -o '.{0,50}getPrimaryDisplay.{0,50}' ./tmp/app.asar.contents/.vite/build/index.js

# Find resourcesPath patterns (for tray_path patch)
rg -o 'function [a-zA-Z]+\(\)\{return [a-zA-Z]+\.app\.isPackaged\?[a-zA-Z]+\.resourcesPath.{0,50}' ./tmp/app.asar.contents/.vite/build/index.js

# Find specific function patterns
rg -o 'function [a-zA-Z]+\(\)\{const t=[a-zA-Z]+\.screen\.getPrimaryDisplay' ./tmp/app.asar.contents/.vite/build/index.js
```

### 4. Common Variable Name Changes

Minified variable names change between versions. Examples from v1.0.1217 → v1.0.1307:

| Variable | Old | New |
|----------|-----|-----|
| Electron module | `ce` | `de` |
| Process module | `pn` | `gn` |
| Position function | `pTe` | `lPe` |

### 5. Fix Strategy: Use Flexible Patterns

Instead of hardcoding variable names, use `[\w$]+` wildcards with replacement functions:

```nim
# BAD - hardcoded variable names (breaks on updates)
let pattern = re2"function pTe\(\)\{const t=ce\.screen\.getPrimaryDisplay\(\)"

# GOOD - flexible pattern with capture groups
let pattern = re2"(function [\w$]+\(\)\{const t=)([\w$]+)(\.screen\.)getPrimaryDisplay\(\)"

result = content.replace(pattern, proc(m: RegexMatch2, s: string): string =
  let electronVar = s[m.group(1)]
  s[m.group(0)] & electronVar & s[m.group(2)] &
    "getDisplayNearestPoint(" & electronVar & ".screen.getCursorScreenPoint())"
)
```

**Important:** Always use `[\w$]+` (not bare `\w+`) for matching JS identifiers. Minified variable names can contain `$` (e.g., `F$e`, `$S`). Using bare `\w+` will silently fail to match.

### 5b. Patch Strictness Rules

**Every sub-patch MUST succeed or the whole patch script MUST fail (exit 1).** This is critical because:

- A failed sub-patch means the upstream code changed — the pattern no longer matches
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
2. Never use `[WARN]` + continue for a patch that doesn't match — use `[FAIL]` and don't increment the counter
3. "Already patched" detection (idempotency) counts as success — increment the counter. **But it MUST be a positive assertion that the desired end-state is present** (see Rule 6).
4. When a patch fails after an upstream update, investigate why:
   - **Pattern changed:** The minified variable names shifted — update the regex
   - **Code refactored:** The target code was restructured — rewrite the patch approach
   - **Feature removed:** The code we patched no longer exists — the patch can be removed
   - **Feature upstreamed:** Anthropic added native Linux support — **remove the patch** (`git rm`). Once there is nothing of ours left to inject, the patch only asserts upstream's own behavior; we keep only patches that modify the bundle. Do NOT convert it to a regression guard.
5. Never add a new patch with `[WARN]`-on-failure or `patchesApplied == 0` as the only check

6. **No false success reporting — an `[OK]`/"already patched" line must never be backed by a false premise.**
   A patch must report success only when it has *positively verified* the desired end-state exists in the
   output. The classic trap is an idempotency check that keys off the **absence** of the old pattern:

   This governs the "already patched" (idempotency) branch of an **active** patch — one that injects
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
   raise newException(ValueError, "neither old pattern nor our injection found — re-audit")
   ```

   Rules of thumb:
   - "Already patched" / "already applied" must check for the **patched result** (the string/shape the
     patch produces, or the behavior it guarantees), NOT merely that the pre-patch pattern is gone.
     "Old pattern absent" ≠ "new behavior present" — those diverge the instant upstream refactors.
   - If a feature was upstreamed and there is nothing left to rewrite, **remove the patch** (`git rm`) —
     see Rule 4. A patch that changes nothing in the bundle and only asserts upstream's own behavior is
     forbidden; pure assert-only "regression guard" patches were retired 2026-07-15. This rule
     (positive-end-state assertion for idempotency) still governs the "already patched" branch of
     **active** patches — those that DO inject: they must verify the patched result is present, not merely
     that the pre-patch pattern is gone.
   - Every `[OK]`/`[INFO]` success message must correspond to a real, checked fact. If you cannot assert
     the fact, you must `[FAIL]`. Silence and false-positives are worse than a loud build failure.

### 6. Verify Syntax After Patching

Always check JavaScript syntax after applying patches:

```bash
node --check ./tmp/app.asar.contents/.vite/build/index.js
echo "Syntax check exit: $?"
```

If syntax errors occur, the patch likely replaced only part of a construct (e.g., part of a function), leaving dangling code.

### 7. Build and Test Locally

```bash
./scripts/build-local.sh
```

Or build without installing:

```bash
./scripts/build-local.sh
sudo pacman -U build/claude-desktop-extra-*.pkg.tar.zst
```

### 8. Commit Convention

```bash
git add patches/*/*.nim js/*.js CHANGELOG.md
git commit -m "$(cat <<'EOF'
Fix patch patterns for Claude Desktop vX.X.XXXX

Update [patch_name].nim to use flexible regex patterns with dynamic
variable capture instead of hardcoded names.

Changes:
- Use \w+ wildcards for minified variable names
- Use replacement functions to capture and reuse actual variable names
- [Any other specific changes]

Tested variable name changes: [list changes like ce→de, pn→gn]
EOF
)"
git push
```

## File Structure

```
patches/           # Nim patch sources (.nim) + Makefile, compiled to native binaries (ls patches/*/*.nim)
patches/linux/     #   Linux compatibility - always on, not user-configurable (31)
patches/community/ #   Opt-in features, each with a switch in Settings -> Extra -> Community Features (9)
patches/core/      #   Always-on infrastructure the rest builds on: the Extra settings pages, the theme
                   #   engine, the GrowthBook override mechanism, multi-profile plumbing (7)
js/                # Shared JS snippets embedded by Nim patches via staticRead ("../../js/..." from a patch)
scripts/           # Build, validation, and launcher scripts (ls scripts/)
scripts/tests/     # Feature test harnesses, grouped like patches/ (run: scripts/run-feature-tests.sh)
scripts/tests/community/ #   Behavior tests for the opt-in community features (8)
scripts/tests/core/      #   Behavior tests for the core infrastructure features (5)
scripts/tests/linux/     #   Behavior tests for the Linux compatibility patches (2)
scripts/tests/lib/       #   Shared harness plumbing (theme-engine-harness.mjs), not tests themselves
docs/              # Per-feature deep-dives (themes, profiles, quick-entry, cowork, feature-flags,
                   #   computer-use, third-party-inference, environment-variables) + screenshots.
                   #   The README carries only a teaser per feature and links here.
baseline/          # Version-sensitive reference docs re-validated against the bundle each release: CLAUDE_FEATURE_FLAGS.md, CLAUDE_BUILT_IN_MCP.md, ION.md, PLATFORM_GATE_BASELINE.md, PANEL_TABS_ANCHORS.md, FILES_QUICK_OPEN_ANCHORS.md
```

Each patch has a `# @patch-target:` and `# @patch-type: nim` header. The Makefile compiles them to native binaries. The orchestrator (`scripts/apply_patches.py`) discovers them recursively across the three subdirectories and applies them in **basename order** (the directory only classifies a patch, it does not order it). Use `ls patches/*/*.nim` as the single source of truth for what exists.

`apply_patches.py` pins the total in `EXPECTED_PATCH_COUNT` and fails loud when discovery finds a different number - bump the constant in the same commit that adds or removes a patch. `PATCHES.md` documents the full recipe for a new opt-in feature in its "Adding your own feature" section (patch + config key + toggle row).

## Profile System (multi-instance)

Multiple Desktop instances can run side by side via named profiles. The launcher (`scripts/claude-desktop-launcher.sh`) resolves `CLAUDE_PROFILE` from `--profile=NAME`, the env var, or its own basename (`claude-desktop-NAME`), then exports it so child processes inherit it.

**Per-profile path table** (default profile = unset = no suffix; named profile suffixes everything with `-<name>`):

| Resource | Mechanism | Where to look in code |
|----------|-----------|----------------------|
| Electron userData | `--user-data-dir` flag in launcher | All `app.getPath("userData")` consumers auto-redirect |
| Claude Code config | `CLAUDE_CONFIG_DIR` env exported by launcher | Honored by `@anthropic-ai/claude-code` CLI |
| Quick Entry socket | `process.env.CLAUDE_PROFILE` read in JS | `patches/core/fix_quick_entry_cli_toggle.nim` |
| systemd scope | `${profile_suffix}` in launcher | `claude-desktop-launcher.sh` |
| WM_CLASS / Wayland app_id | per-profile Electron binary (hardlink → reflink → copy fallback) | `~/.local/lib/claude-desktop/<APP_ID>-<name>` — must be a real file, not a symlink, because Electron derives its app identity from `/proc/self/exe` (the kernel resolves symlinks before reading) |
| SSO callback routing | marker file written by JS hook on `shell.openExternal`; launcher reads marker to dispatch incoming `claude://` URL | `patches/core/fix_profile_url_routing.nim` (writer) + `claude-desktop-launcher.sh` URL-handler block (reader / re-exec) |

**Rule when adding a new patch:** if it writes to a fixed user-level path, prefer `app.getPath("userData")` (auto-isolates) over `os.homedir()+"/.config/Claude"` (single-instance leak). If it opens a Unix socket or pipe that is owned by the Electron process itself, append `process.env.CLAUDE_PROFILE` to the path the same way `fix_quick_entry_cli_toggle.nim` does. If the socket is owned by a separate shared user-level daemon, do NOT suffix it — clients across all profiles need to connect to the same listener; profile isolation comes from per-profile state inherited via env. If the patch spawns a long-lived child process that holds state, propagate `process.env.CLAUDE_PROFILE` and `process.env.CLAUDE_CONFIG_DIR` (or accept that `child_process.spawn` inherits `process.env` by default — verify, don't assume).

## Feature Flag System

See [CLAUDE_FEATURE_FLAGS.md](baseline/CLAUDE_FEATURE_FLAGS.md) for the full reference: feature flag catalog, 3-layer override architecture (static registry → async merger → IPC), GrowthBook flag IDs, and how `enable_local_agent_mode.nim` bypasses the production gate.

**Note:** Function names in CLAUDE_FEATURE_FLAGS.md are version-specific (they change every release). The version history table at the bottom tracks the renames across versions.

## Log Files

Runtime logs are at `~/.config/Claude/logs/`.

**3p/enterprise deployments use a different dir.** If `/etc/claude-desktop/managed-settings.json` sets an
**`inferenceProvider`** (gateway / Bedrock / Vertex - the actual 3p switch; the file merely existing with
only `managedMcpServers` stays 1p), the live logs and state are under **`~/.config/Claude-3p/logs/`**
instead - upstream relocates Electron userData with a `-3p` suffix. Reading the wrong dir gives stale/1p
evidence. So: **check `/etc/claude-desktop/managed-settings.json` for `inferenceProvider` first** (or grep
main.log for `3P mode active`) and substitute `Claude-3p` for `Claude` in every path below when it's active
(named profiles add a further `-<profile>` suffix). When in doubt, confirm the running process:
`pgrep -af claude` and read its `--user-data-dir` / `--database=...Crashpad` arg. See the `/3p` skill for
the full behavior.

| Log File | Description |
|----------|-------------|
| `main.log` | Main Electron process log (~6MB) |
| `claude-patches.log` | OUR patch diagnostics (`[claude-cu]`, `[quick-entry]`, `[CustomThemes]`, …) via `__cdbDiag` - console output is discarded by the official build |
| `claude.ai-web.log` | BrowserView web content log (~1.6MB) |
| `cowork_vm_node.log` | Cowork VM/session log (~638KB) |
| `mcp.log` | MCP server communication log (~3.5MB) |
| `mcp-server-*.log` | Per-MCP-server logs (e.g., ClickUp) |

```bash
# Tail main process log
tail -f ~/.config/Claude/logs/main.log

# Search for errors across all logs
rg -i 'error|exception|fatal' ~/.config/Claude/logs/

# Check crash reports
ls -la ~/.config/Claude/crash*
```

### Dispatch Debug Workflow

When dispatch responses don't render or features fail, use this sequence:

```bash
# 1. Check bridge event flow (did the message pass through?)
grep -a 'DISPATCH-FWD.*PASSING\|DISPATCH-TRANSFORM\|DISPATCH-WRITE' ~/.config/Claude/logs/main.log | tail -20

# 2. Check for permission denials on MCP tools
grep -a 'Permission.*denied' ~/.config/Claude/logs/main.log | tail -10

# 3. Check the audit log for the dispatch session (shows model's tool calls and results)
AUDIT=$(find ~/.config/Claude/local-agent-mode-sessions -name "audit.jsonl" -printf '%T@ %p\n' | sort -n | tail -1 | cut -d' ' -f2)
python3 -c "
import json
with open('$AUDIT') as f:
    for i, line in enumerate(f):
        d = json.loads(line)
        t = d.get('type','?')
        if t == 'assistant' and d.get('message'):
            content = d['message'].get('content', [])
            names = [c.get('name','') for c in content if c.get('type') == 'tool_use']
            texts = [c.get('text','')[:80] for c in content if c.get('type') == 'text']
            print(f'[{i}] {t} tools={names} text={texts}')
        elif t == 'user' and ('Error' in str(d) or 'Permission' in str(d)):
            print(f'[{i}] {t} (error): {str(d)[:200]}')
"

# 4. Check the Cowork/VM backend log (the official native backend bundled in the .deb).
#    The Electron-side log records spawn/VM lifecycle and the bridge's view of the session:
grep -a 'Using Claude VM spawn\|Spawn succeeded\|vmStarted\|disallowedTools\|CLAUDE_CODE_BRIEF' \
  ~/.config/Claude/logs/cowork_vm_node.log | tail -20

# 5. Check what tools the CLI actually exposed to the model
python3 -c "
import json
with open('$AUDIT') as f:
    for i, line in enumerate(f):
        d = json.loads(line)
        if d.get('tools') and len(d['tools']) > 10:
            names = [t if isinstance(t, str) else t.get('name','?') for t in d['tools']]
            print(f'Tools ({len(names)}): {names}')
            for target in ['SendUserMessage','present_files','send_message']:
                found = [n for n in names if target in n]
                print(f'  {target}: {found or \"MISSING\"}')
            break
"

# 6. Clear stale dispatch session (model remembers past errors)
rm -rf ~/.config/Claude/local-agent-mode-sessions/
```

**Key insight:** The audit.jsonl is the single source of truth for what the model sees and does. The main.log shows how the bridge processes the model's output. Check both when debugging.

## CI Pipeline

GitHub Actions workflow:
1. Polls the official apt Packages index; downloads the latest official Claude Desktop `.deb` and verifies GPG + SHA256
2. Extracts `app.asar`, applies patches, repackages, and runs validation in Docker
3. If validation passes, publishes the packages plus the signed APT, DNF and pacman repository metadata

When CI fails, download the `.deb` locally and debug using the workflow above.


# Ubuntu VM
vboxmanage startvm "Ubuntu"
# Credentials: osboxes / osboxes.org
# SSH (port 2222) is unreliable — use guest control instead:
# Copy file to VM:  vboxmanage guestcontrol "Ubuntu" copyto --target-directory /home/osboxes/ <file> --username osboxes --password "osboxes.org"
# Run command in VM: vboxmanage guestcontrol "Ubuntu" run --exe /bin/bash --username osboxes --password "osboxes.org" -- bash -c "<cmd>"

# Fedora 43 KDE VM (RPM testing)
vboxmanage startvm "Fedora43-KDE"
# SSH: ssh -p 2223 localhost
# Shared folder: /tmp/fedora-test → auto-mounted in guest
# Install RPM: sudo dnf install /media/sf_shared/claude-desktop-extra-*.x86_64.rpm
