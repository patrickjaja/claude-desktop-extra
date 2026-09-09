# Claude Desktop Linux — Version Update Prompts

Reusable prompts for updating the packages when a new official Claude Desktop Linux `.deb` drops.

**Normally you don't need this file.** New upstream versions are released automatically: `version-check.yml` detects them (2-hourly) and dispatches a full release run; the strict patches are the gate (every sub-patch applies or the build fails loud). Green run → released unattended, `.upstream-version` bumped, tracking issue closed. Use these prompts when the **auto-release failed** (a comment on the tracking issue links the failed run) or for a deliberate deep audit. The first question for every failing patch: did the re-minify move the anchor (fix the regex), or did upstream natively implement what we patch (**remove the patch** — the expected direction over time, since Anthropic maintains 1p Linux support; do NOT convert to a regression guard)?

This project repackages Anthropic's **official Linux `.deb`** (apt repo `https://downloads.claude.ai/claude-desktop/apt`); it bundles its own Electron (44.2.0 as of v1.49585.0) and a native Cowork VM backend. We download it, verify it, extract its `app.asar`, apply our patches, and repackage for Arch/Fedora/RHEL/Nix/AppImage + our own Debian/Ubuntu `.deb`.

## How to find the latest version

The build script auto-downloads the latest version. To check manually, query the apt Packages index:

```bash
# amd64 (use binary-arm64 for arm64)
curl -s https://downloads.claude.ai/claude-desktop/apt/stable/dists/stable/main/binary-amd64/Packages \
  | rg -A1 '^Version:' | head
# Each stanza has Version:, Filename: (the .deb path), and SHA256:
```

---

## Step 0: Clean Slate (Run First)

Before any version update, remove stale artifacts so the build downloads fresh:

> **Prepare for a clean Claude Desktop update.**
>
> 1. Remove old build artifacts:
>    ```bash
>    rm -rf build/ tmp/
>    ```
> 2. Verify clean state:
>    ```bash
>    git status
>    ```
>
> Then proceed to **Prompt 1** - the build script will auto-download the latest official `.deb`.

---

## Prompt 1: Build & Fix Patches

Copy-paste this into Claude Code when a new version is available:

> **New Claude Desktop version is available.** Please build and fix patches:
>
> 1. Read the current reference docs (this is your version A baseline):
>    - `baseline/CLAUDE_FEATURE_FLAGS.md` — current feature flags, function names, GrowthBook IDs
>    - `baseline/CLAUDE_BUILT_IN_MCP.md` — current MCP servers, registration patterns
>    - `CHANGELOG.md` — recent version history (first entry = current version)
>
> 2. Run the build (auto-downloads the latest official `.deb`):
>    ```bash
>    # Arch Linux:
>    ./scripts/build-local.sh
>    # Ubuntu/Debian:
>    ./scripts/build-ubuntu-local.sh
>    # Fedora/RHEL:
>    ./scripts/build-fedora-local.sh
>    # To build from a specific version or a local .deb:
>    ./scripts/build-local.sh --version 1.17282.0
>    ./scripts/build-local.sh --deb /path/to/claude-desktop_amd64.deb
>    ```
>
> 3. If patches fail, extract the app for analysis (from the downloaded `.deb` in `./tmp/`):
>    ```bash
>    mkdir -p /tmp/claude-new
>    dpkg-deb -x ./tmp/claude-desktop_*_amd64.deb /tmp/claude-new
>    asar extract /tmp/claude-new/usr/lib/claude-desktop/resources/app.asar /tmp/claude-new/app
>    ```
>
> 4. For each failing patch:
>    - Use `rg` to find the new code pattern in the extracted JS
>    - Update the regex in `patches/*/*.nim` - use `\w+` (or `[\w$]+` if the minified name can start with `$`) for variable names
>    - Recompile: `cd patches && make PATCH_NAME && cd ..`
>    - Test the individual patch: `patches/<group>/PATCH_NAME /tmp/test_index.js`
>    - Verify syntax: `node --check /tmp/test_index.js`
>
> 5. Rebuild (re-run same build script from step 2)
>
> 6. Verify all patches pass and JS syntax is valid:
>    ```bash
>    # Count patches (should match build output)
>    ls patches/*/*.nim | wc -l
>    ```
>
> 7. Run the Feature Flag Audit (Prompt 3) to check for new/changed flags
>
> 8. Install:
>    - **Arch:** `sudo pacman -U build/claude-desktop-extra-*-x86_64.pkg.tar.zst`
>    - **Ubuntu/Debian:** `sudo apt install ./build/claude-desktop-extra_*.deb`
>    - **Fedora/RHEL:** `sudo dnf install build/claude-desktop-extra-*.rpm`
>
> 9. Update documentation (compare what you found vs your version A baseline):
>    - `baseline/CLAUDE_FEATURE_FLAGS.md` — if flags added/removed/renamed
>    - `baseline/CLAUDE_BUILT_IN_MCP.md` — if MCP servers changed (check `registerInternalMcpServer` calls)
>    - `CHANGELOG.md` — add new version entry
>    - `PATCHES.md` patch tables - if patches added/removed/changed (the README keeps only the per-directory counts)
>    - `baseline/ION.md` — if ion-dist bundle stats, patterns, or config keys changed
>    - **`.upstream-version` — bump to the new version (required).** This is what closes the auto-created "new version detected" issue and greens the README badge. `version-check.yml` compares the highest `Version:` in the official apt Packages index against this file; until they match, the issue is recreated every 2h. Bump it even for a trivial build bump with no public release.
>
> 10. Commit the changes (including the `.upstream-version` bump)

---

## Prompt 2: Diff & Discover New Changes

Copy-paste this into Claude Code to analyze what changed between two versions:

> **Compare Claude Desktop JS bundles between old and new version.**
>
> 1. Read the reference docs first (version A baseline):
>    - `baseline/CLAUDE_FEATURE_FLAGS.md` — know what flags exist before diffing
>    - `baseline/CLAUDE_BUILT_IN_MCP.md` — know what MCP servers exist before diffing
>
> 2. Both JS versions should be extracted:
>    - Old: `/tmp/claude-old/app/.vite/build/index.js`
>    - New: `/tmp/claude-new/app/.vite/build/index.js`
>
>    (If not yet extracted, extract them first using the steps in AGENTS.md § "Extract and Test Locally".)
>
>    Since v1.19367.0 the main bundle is code-split: `index.js` is a loader stub and the
>    code lives in `index.chunk-<hash>.js` siblings + `index.pre.js`. Wherever a command
>    below reads `.vite/build/index.js`, use a concatenation of `index.pre.js` + `index.js`
>    + all `index.chunk-*.js` for that side instead, e.g.:
>    `cat /tmp/claude-new/app/.vite/build/index.pre.js /tmp/claude-new/app/.vite/build/index.js /tmp/claude-new/app/.vite/build/index.chunk-*.js > /tmp/claude-new-bundle.js`
>
> Run these comparisons and summarize the findings:
>
> 1. **File-level diff** — new or removed files
>    ```bash
>    diff <(cd /tmp/claude-old/app && find . -type f | sort) \
>         <(cd /tmp/claude-new/app && find . -type f | sort)
>    ```
>
> 2. **Platform checks** — new `process.platform` guards
>    ```bash
>    diff <(rg -o '.{0,40}process\.platform.{0,40}' /tmp/claude-old/app/.vite/build/index.js | sort -u) \
>         <(rg -o '.{0,40}process\.platform.{0,40}' /tmp/claude-new/app/.vite/build/index.js | sort -u)
>    ```
>
> 3. **Feature flags** — new flag IDs
>    ```bash
>    # Find the current flag function name (changes every release)
>    rg -o '\w+\("[0-9]{6,}"\)' /tmp/claude-new/app/.vite/build/index.js | head -1
>    # Then compare flag sets between old and new
>    diff <(rg -o '\w+\("[0-9]{6,}"\)' /tmp/claude-old/app/.vite/build/index.js | sort -u) \
>         <(rg -o '\w+\("[0-9]{6,}"\)' /tmp/claude-new/app/.vite/build/index.js | sort -u)
>    ```
>
> 4. **Unavailable/unsupported gates** — new feature restrictions
>    ```bash
>    diff <(rg -o '.{0,80}status:"unavailable".{0,80}' /tmp/claude-old/app/.vite/build/index.js | sort -u) \
>         <(rg -o '.{0,80}status:"unavailable".{0,80}' /tmp/claude-new/app/.vite/build/index.js | sort -u)
>    ```
>
> 5. **IPC handlers** — new `handle("...")` registrations
> 6. **Native module refs** — new `require("...")` calls
> 7. **Linux/darwin/win32 refs** — new platform-specific code
> 8. **Claude Code / Cowork refs** — changes to these subsystems
>
> For each finding, classify as:
> - **Rename only** — minified variable name changed, no action needed
> - **New feature** — new functionality, may need a Linux patch
> - **Changed behavior** — existing logic changed, existing patches may break
> - **Removed** — feature or code path removed, clean up patches/docs if affected
>
> After analysis, update docs to reflect the new version:
> - `baseline/CLAUDE_FEATURE_FLAGS.md` — new/removed flags, renamed functions, updated version history table
> - `baseline/CLAUDE_BUILT_IN_MCP.md` — new/removed MCP servers, renamed registration functions
> - `CHANGELOG.md` — add entry summarizing what changed, what was patched, what's new upstream

---

## Prompt 3: Feature Flag Audit

Run this on EVERY version update to catch new/changed feature flags:

> **Audit feature flags for the new Claude Desktop version.**
>
> 1. Read `baseline/CLAUDE_FEATURE_FLAGS.md` first — this is your version A baseline. Note the current:
>    - Feature count and names
>    - Static registry function name
>    - Async merger function name
>    - GrowthBook flag IDs
>    - Version history table (last entry = previous version)
>
> 2. Find the static registry function (name changes every release):
>    ```bash
>    # Anchor on a known flag name to find the function
>    rg -o '.{0,30}ccdPlugins.{0,30}' /tmp/claude-new/app/.vite/build/index.js | head -3
>    # Extract the function name pattern
>    rg -o '[\w$]+\(\)\{return\{.*ccdPlugins' /tmp/claude-new/app/.vite/build/index.js | head -1
>    ```
>
> 3. Extract all feature names from the static registry
>
> 4. Compare against your baseline (`baseline/CLAUDE_FEATURE_FLAGS.md`) — flag any:
>    - **New features** not in the doc
>    - **Removed features** missing from the new registry
>    - **Renamed functions** (static registry, async merger, gate functions)
>
> 5. Check for gate changes:
>    - Features that moved into/out of platform-gating wrappers
>    - Platform checks added/removed
>    - New async overrides in the feature merger function
>    ```bash
>    # Find the async merger (returns Promise with feature overrides)
>    rg -o '.{0,40}async\(\)=>\(\{.{0,60}' /tmp/claude-new/app/.vite/build/index.js | head -5
>    ```
>
> 6. Check if `enable_local_agent_mode.nim` needs new flags in its override list
>
> 7. Verify the feature schema includes all flags we override:
>    ```bash
>    # Find the Zod schema for features
>    rg -o '.{0,20}ccdPlugins.*z\.\w+' /tmp/claude-new/app/.vite/build/index.js | head -3
>    ```
>
> 8. Update `baseline/CLAUDE_FEATURE_FLAGS.md`:
>    - Add/remove features from the catalog
>    - Update all function names to match the new version
>    - Update GrowthBook flag IDs (new/removed)
>    - Add row to version history table
>    - Update patches if needed
>
> **Why:** Feature flags control which UI elements appear (Code tab, Cowork tab,
> plugin buttons, etc.). Missing a new flag means features silently disappear.

---

## Prompt 4: ion-dist (3P Config SPA) Audit

Run this on EVERY version update to check the bundled Third-Party Inference UI:

> **Audit the ion-dist SPA for the new Claude Desktop version.**
>
> 1. Read `baseline/ION.md` first — this is your baseline for bundle stats, key files, and patched patterns.
>
> 2. Check if ion-dist exists in the new upstream resources:
>    ```bash
>    # ion-dist is in the .deb's resources, NOT inside app.asar
>    ION="/tmp/claude-new/usr/lib/claude-desktop/resources/ion-dist"
>    ls "$ION/index.html" && echo "ion-dist present" || echo "ion-dist MISSING"
>    ```
>
> 3. Find the config UI chunk (the file containing the patched `org-plugins` pattern):
>    ```bash
>    rg -l 'org-plugins' "$ION/assets/v1/"*.js
>    ```
>    Note the new filename — it changes every release due to content hashing.
>
> 4. Compare bundle stats against `baseline/ION.md` baseline:
>    ```bash
>    du -sh "$ION"
>    find "$ION" -name "*.js" | wc -l
>    ```
>    Large changes in file count or total size indicate a structural refactor.
>
> 5. Check if the patched patterns still exist (mountPath with only mac/win, platform ternary):
>    ```bash
>    rg -o 'mountPath:\{.{0,200}\}' "$ION/assets/v1/"*.js
>    rg -o '/Library/Application Support.{0,60}' "$ION/assets/v1/"*.js
>    rg -o '%ProgramFiles%.{0,60}' "$ION/assets/v1/"*.js
>    ```
>    If `mountPath` now includes a `linux` key, the patch may have been upstreamed.
>
> 6. Check for NEW platform-gated code or mac/win-only paths without linux:
>    ```bash
>    rg -l 'darwin' "$ION/assets/v1/"*.js | wc -l
>    rg -o 'Darwin="darwin".*Linux="linux"' "$ION/assets/v1/index-"*.js
>    ```
>
> 7. Check for new IPC bridges, config keys, or structural changes:
>    ```bash
>    rg -c 'claudeAppBindings' "$ION/assets/v1/index-"*.js
>    ```
>
> 8. Update `baseline/ION.md` baseline if anything changed (file count, total size, key filenames, new config keys, new platform gates).
>
> 9. Update `fix_ion_dist_linux.nim` if patterns changed (new chunk filename pattern, mountPath restructured, ternary moved).
>
> **Why:** The ion-dist SPA has content-hashed filenames that change every release.
> `fix_ion_dist_linux.nim` patches a specific chunk to add a Linux org-plugins path
> and fix a platform ternary. If the patterns shift or new mac/win-only code appears,
> Linux users lose access to the 3P config UI features.

---

## Prompt 5: Platform Gate Re-Audit (Linux opportunities)

Run this to answer *"is there anything new we could make Linux-compatible?"* without re-investigating settled ground:

> **Re-audit Claude Desktop platform gates for new Linux-compatibility opportunities.**
>
> 1. Read `baseline/PLATFORM_GATE_BASELINE.md` first — this is your baseline. It classifies every
>    macOS/Windows-only gate as PATCHED / NATIVE / STUB / PORTABLE. You only care about
>    gates that DON'T map to an existing row.
>
> 2. Compare the platform-conditional counts against the baseline (large swing = investigate):
>    ```bash
>    NEW=/tmp/claude-new/app/.vite/build/index.js
>    echo "darwin: $(rg -o 'platform==="darwin"' "$NEW" | wc -l)"   # baseline v1.9659.2: 60
>    echo "win32:  $(rg -o 'platform==="win32"'  "$NEW" | wc -l)"   # baseline v1.9659.2: 111
>    echo "linux:  $(rg -o 'platform==="linux"'  "$NEW" | wc -l)"   # baseline v1.9659.2: 5
>    ```
>
> 3. List the darwin/win32-only gates and the "not-mac-not-win → unavailable" gates:
>    ```bash
>    rg -o '.{0,60}process\.platform==="darwin".{0,80}' "$NEW" | sort -u
>    rg -o '.{0,60}process\.platform==="win32".{0,80}'  "$NEW" | sort -u
>    rg -o '.{0,80}!=="darwin".{0,40}!=="win32".{0,80}' "$NEW" | sort -u
>    rg -o '.{0,80}status:"unavailable".{0,40}' "$NEW" | sort -u
>    ```
>
> 4. For each gate, classify against the baseline table:
>    - **PATCHED** → maps to a `patches/*/*.nim` area → skip
>    - **NATIVE** → genuine Apple/Win API (`@ant/claude-swift`, Login Items, IOKit, XPC, BLE pairing) → skip
>    - **STUB** → hardcoded `!1`, prod-gate (`Em()`-style wrapper), or dev-prototype, disabled on ALL platforms → skip (nothing to enable)
>    - **PORTABLE** → mac/win-only, no real native dep, not patched → **this is the only actionable class**
>
> 5. **Verify before reporting.** For any PORTABLE candidate, trace the exact gate code yourself
>    (don't trust a subagent's summary — past audits hallucinated removed features and fake UUIDs).
>    Quote the verbatim snippet. Confirm there's a real feature behind the gate (not a STUB).
>
> 6. Update `baseline/PLATFORM_GATE_BASELINE.md`:
>    - Refresh `Last audited` version + the conditional counts
>    - Add new NATIVE/STUB rows with stable anchors + evidence
>    - Add any PORTABLE finding with the gate snippet + proposed patch (or confirm "Currently: NONE")
>
> **Why:** Without a baseline, every audit re-scans 150+ platform conditionals from scratch and
> risks re-flagging settled ground (already-patched features) or unshipped stubs (disabled on all
> OSes, not a Linux issue). The baseline turns a multi-agent fan-out into a quick diff.

---

## Cowork backend

Cowork runs on the **official native Cowork VM backend** bundled inside the Linux `.deb` (cowork-linux-helper + virtiofsd + smol-bin + QEMU/OVMF; requires `/dev/kvm`). We just preserve it through the repackage - there is no separate daemon to maintain. The old `claude-cowork-service` Go daemon is **deprecated/archived**; you do not need to update it on an upstream bump.

---

## Duplicated Agent SDK (since v1.12603.0)

Since v1.12603.0 the main bundle embeds **two** copies of `@anthropic-ai/claude-agent-sdk` (e.g. 0.3.170 + 0.3.167; check with `rg -o 'CLAUDE_AGENT_SDK_VERSION="[0-9.]+"' index.js | sort | uniq -c`). Any patch whose pattern matches SDK-internal code now has TWO match sites - a patch asserting "exactly 1 match" against SDK code will fail, and a single-replace will silently patch only one copy. When writing patches against SDK-internal patterns, decide explicitly whether to patch all copies (`replace` with a counter) and verify the match count.

---

## Common Variable Renames

Minified names change every release. The pattern is always the same — just the identifier changes. Key categories:

| Category | Examples | Regex tip |
|----------|----------|-----------|
| Electron module | `ce`, `de`, `Pe` | Usually stable as `Pe` |
| Path module | `tt`, `rt` | Use `\w+` |
| Assert module | `oo`, `lo` | Use `\w+` |
| Feature flag fn | `la()`, `Xi()` | Use `\w+\("[0-9]+"\)` |
| Status enum | `Cs`, `$s`, `ps` | Use `[\w$]+` ($ is valid in JS identifiers) |
| CCD gate fn | `Hb`, `Gw` | Use `\w+` — don't hardcode |
| Spawn helper | `xu`, `Cu`, `ti` | Use `\w+` |

---

## Change Detection Summary

| What changes | How to detect | Impact |
|-------------|---------------|--------|
| Minified variable names | Build fails - patch regex doesn't match | Update `\w+` patterns in `patches/*/*.nim`, recompile |
| New platform gate (`darwin`/`win32`) | Prompt 2 step 2 — `process.platform` diff | New patch needed to add Linux support |
| New feature flag | Prompt 3 — static registry diff | Add to `enable_local_agent_mode.nim` override |
| Feature flag removed | Prompt 3 — flag missing from registry | Remove from override, update docs |
| New IPC handler | Prompt 2 step 5 — `handle("...")` diff | May need Linux implementation |
| Structural JS refactor | Multiple patches fail + new code shape | Rewrite affected patches to match new structure |
| New MCP server | Search for `registerInternalMcpServer` | Update `baseline/CLAUDE_BUILT_IN_MCP.md` |
| ion-dist SPA restructured | Prompt 4 — bundle stats + pattern check | Update `fix_ion_dist_linux.nim`, update `baseline/ION.md` baseline |
| New darwin/win32-only gate (Linux opportunity?) | Prompt 5 — platform conditional count swing + gate diff | Classify vs `baseline/PLATFORM_GATE_BASELINE.md`; if PORTABLE, write a patch; update the baseline |

---

## Patch Reference

See **[PATCHES.md](PATCHES.md)** for the full list of all patches including break risk and debug `rg` patterns for finding new code when a patch fails.
