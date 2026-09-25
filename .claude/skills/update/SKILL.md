---
name: update
description: For claude-desktop-extra - handle a new upstream Claude Desktop version end-to-end: build, fix failing patches, diff old vs new JS for new platform gates, audit feature flags + ion-dist + platform gates, update baseline docs + CHANGELOG, bump .upstream-version, then commit.
disable-model-invocation: true
---

# Update to a new upstream Claude Desktop version

**When to run this:** normally you don't. CI auto-releases new upstream versions (version-check.yml dispatches build-and-release.yml; green run = released + `.upstream-version` bumped + tracking issue closed). Run this skill when the **auto-release failed** (a comment on the "new version detected" issue links the failed run) or when you want a deep audit of a bump. On a patch failure, decide FIRST: did the re-minify just move the anchor (fix the regex), or did upstream natively implement what we patch (**remove the patch** - the expected direction, since Anthropic maintains 1p Linux support)?

Run from the repo root. The official Linux `.deb` is remotely managed and re-minifies every release; patches use `[\w$]+` wildcards on stable string anchors. Step 1 runs `/fresh-upstream` for a clean extract; Step 9 ends with `/deploy` to release. `$ARGUMENTS` may name a target version.

Use sequential thinking and delegate independent analysis (diff, flag audit, ion-dist, platform gates) to parallel sub-agents where useful; you coordinate and edit.

## Search rules (apply to every step)
- The main bundle is code-split since v1.19367.0: `index.js` is a loader stub, the code lives in `index.chunk-<hash>.js` siblings (hashes change every release) + `index.pre.js`. For any "search the bundle" command, use a concatenation per side:
  ```bash
  B=./tmp/app.asar.contents/.vite/build
  cat $B/index.pre.js $B/index.js $B/index*.chunk-*.js > ./tmp/new-bundle.js   # same for the OLD extract -> ./tmp/old-bundle.js
  ```
- Use `grep -a` on extracted bundles. `rg -a --no-ignore` silently fails on them (raw NUL bytes); a zero-hit `rg` is not evidence.
- Match JS identifiers with `[\w$]+`, never bare `\w+` - minified names contain `$` (`F$e`, `$S`) and `\w+` silently misses them.
- Since v1.12603.0 the bundle embeds **two** copies of `@anthropic-ai/claude-agent-sdk` (`grep -ao 'CLAUDE_AGENT_SDK_VERSION="[0-9.]*"' ./tmp/new-bundle.js | sort | uniq -c`). A pattern on SDK-internal code matches twice: decide explicitly whether to patch both copies and assert the count.

## Step 0 - clean slate
```bash
cd "$(git rev-parse --show-toplevel)"
git status                  # must be clean before starting
rm -rf build/ extract/      # old artifacts
```
Note current `.upstream-version`. If you're here because the auto-release failed, read the failed run's log first - it names exactly which patch (and which sub-patch counter) failed.

## Step 1 - build & fix patches
Run the build for this OS (Arch here). It auto-downloads the latest official `.deb`, applies patches, packages:
```bash
./scripts/build-local.sh
# Ubuntu/Debian: SKIP_SMOKE_TEST=1 ./scripts/build-ubuntu-local.sh
# Fedora/RHEL:   ./scripts/build-fedora-local.sh
# Specific version / local .deb: --version 1.17282.0 | --deb /path/to/claude-desktop_amd64.deb
```
If patches fail (upstream renamed identifiers / refactored / removed a feature):
1. Get a clean unpatched extract (run `/fresh-upstream`, or it's already in `./tmp/app.asar.contents/.vite/build/`). `./scripts/validate-patches.sh ./tmp/app.asar.contents` runs every patch against it and lists the failures.
2. For each failing patch, find the new pattern with `grep -ao '.{0,50}anchor.{0,50}'`, then fix `patches/<group>/<name>.nim` with capture/replace, reusing the captured names:
   ```nim
   # BAD - hardcoded minified names break on the next release
   let pattern = re2"function pTe\(\)\{const t=ce\.screen\.getPrimaryDisplay\(\)"
   # GOOD - wildcard + capture, rebuild from the captured groups
   let pattern = re2"(function [\w$]+\(\)\{const t=)([\w$]+)(\.screen\.)getPrimaryDisplay\(\)"
   ```
   **Edit the `.js` in `js/`** for Computer Use / cowork-font and other `staticRead` patches, then `touch` the `.nim` (the Makefile tracks most but not all `staticRead` deps).
3. Recompile + test one patch against the stub+chunks concatenation (what the orchestrator stages):
   ```bash
   cd patches && make <patch_name> && cd ..
   B=./tmp/app.asar.contents/.vite/build
   { cat $B/index.js; for c in $B/index.chunk-*.js; do printf '\n/*__CDB_SPLIT__%s__*/\n' "$(basename $c)"; cat "$c"; done; } > ./tmp/test-index.js
   patches/<group>/<patch_name> ./tmp/test-index.js; echo "exit=$?"
   ```
   The staged concatenation never passes `node --check` as a whole; the per-chunk `node --check` in the build is authoritative. A syntax error there means the patch replaced only part of a construct.
4. Re-run the build until all patches pass. **Every sub-patch must succeed or `quit(1)`** - never `[WARN]`+continue. If a feature was upstreamed, **remove the patch** (`git rm`, bump `EXPECTED_PATCH_COUNT` in `scripts/apply_patches.py`). The absorption probe (`scripts/check-upstream-absorbed.py`, run by the build) flags ABSORBED/PARTIAL patches: audit that upstream ships the same behavior on Linux, then remove. FAILED means re-fit, not remove. See AGENTS.md Rules 4/6.

## Step 2 - Linux-compat analysis (new gates?)
Diff old vs new for newly darwin/win32-gated features that need Linux support (`OLD`/`NEW` = the two concatenations from the search rules):
```bash
diff <(grep -aoE '.{0,40}process\.platform.{0,40}' "$OLD"|sort -u) <(grep -aoE '.{0,40}process\.platform.{0,40}' "$NEW"|sort -u)
diff <(grep -aoE '.{0,80}status:"unavailable".{0,80}' "$OLD"|sort -u) <(grep -aoE '.{0,80}status:"unavailable".{0,80}' "$NEW"|sort -u)
diff <(grep -aoE 'require\("[^"]+"\)' "$OLD"|sort -u) <(grep -aoE 'require\("[^"]+"\)' "$NEW"|sort -u)   # new native modules -> need x86_64+aarch64
```
Validate any new input/screenshot feature across all 5 session types (X11, wlroots, GNOME, KDE, XWayland).

## Step 3 - diff old vs new JS
```bash
diff <(cd ./tmp/app.asar.contents-OLD && find . -type f | sed 's/-[A-Za-z0-9_-]\{8\}\.js$/.js/' | sort) \
     <(cd ./tmp/app.asar.contents && find . -type f | sed 's/-[A-Za-z0-9_-]\{8\}\.js$/.js/' | sort)   # new/removed files
diff <(grep -aoE 'handle\("[^"]+"' "$OLD"|sort -u) <(grep -aoE 'handle\("[^"]+"' "$NEW"|sort -u)      # IPC handlers
```
Also skim Claude Code / Cowork subsystem changes. Classify each finding: rename-only (no action) / new feature (may need a Linux patch) / changed behavior (existing patches may break) / removed (clean up patches/docs).

## Step 4 - feature-flag audit
Read `baseline/CLAUDE_FEATURE_FLAGS.md`. Find the new static-registry function name (changes every release; anchor on a known flag like `ccdPlugins`). Diff flag sets:
```bash
diff <(grep -aoE '[\w$]+\("[0-9]{6,}"\)' "$OLD"|sort -u) <(grep -aoE '[\w$]+\("[0-9]{6,}"\)' "$NEW"|sort -u)
```
Check `enable_local_agent_mode.nim`'s override list still covers the cowork/code flags and its Zod schema includes them. Update the doc + version-history table.

Also refresh the flag catalog in `js/growthbook_overrides.js` (TEMPLATE): it lists every store-consulted flag of the audited version, commented out. Extract IDs with `rg -o '[\w$]+(?:\.[\w$]+)*\("([0-9]{6,10})"[,)]' -r '$1' <new-bundle-concat> | sort -u`, drop the IDs force-rewritten by patches (`rg -oI '"[0-9]{6,10}"' patches/*/*.nim`, minus IDs only mentioned in comments), and update descriptions + the version stamp in the header. Then regenerate the browsable copy and rebuild the binary:
```bash
bash scripts/check-jsonc-template-sync.sh --write   # updates docs/claude-desktop-extra.jsonc
touch patches/core/add_growthbook_overrides.nim && (cd patches && make)
```
CI runs `scripts/check-jsonc-template-sync.sh` (no `--write`) and fails if the docs catalog drifts from the shipped template.

## Step 5 - ion-dist SPA audit
Read `baseline/ION.md`. ion-dist is in the `.deb`'s resources, not inside `app.asar`:
```bash
ION=./tmp/extract/usr/lib/claude-desktop/resources/ion-dist
ls "$ION/index.html" && du -sh "$ION" && find "$ION" -name '*.js' | wc -l   # vs baseline: big swing = refactor
grep -l 'org-plugins' "$ION/assets/v1/"*.js                                  # config chunk (hash changes every release)
grep -aoE 'mountPath:\{.{0,200}\}' "$ION/assets/v1/"*.js                     # a linux key here = maybe upstreamed
grep -aoE '/Library/Application Support.{0,60}|%ProgramFiles%.{0,60}' "$ION/assets/v1/"*.js
```
`fix_ion_dist_linux.nim` finds its target by content signature, not filename. Update `ION.md` / the patch if anything moved.

## Step 6 - platform-gate re-audit
Read `baseline/PLATFORM_GATE_BASELINE.md` first; only gates that don't map to an existing row matter.
```bash
for p in darwin win32 linux; do echo "$p: $(grep -ao "platform===\"$p\"" "$NEW" | wc -l)"; done   # vs baseline counts
grep -aoE '.{0,60}process\.platform==="(darwin|win32)".{0,80}' "$NEW" | sort -u
grep -aoE '.{0,80}!=="darwin".{0,40}!=="win32".{0,80}' "$NEW" | sort -u
```
Classify each: PATCHED (maps to a patch) / NATIVE (real Apple/Win API) / STUB (disabled on all platforms) / **PORTABLE** (mac/win-only, no native dep, not patched - the only actionable class). **Verify before reporting:** trace every PORTABLE candidate yourself and quote the verbatim snippet; past sub-agent audits hallucinated removed features and fake UUIDs. Update the baseline's `Last audited`, counts and rows.

## Step 7 - Cowork backend
Cowork runs on the `.deb`'s bundled native VM backend (cowork-linux-helper + virtiofsd + smol-bin + QEMU/OVMF; requires `/dev/kvm`). Nothing to update on a bump.

## Step 8 - docs
Update only what changed:
- `CHANGELOG.md` - add the new entry (one `##` section per day, newest at top; informative not a debug log).
- `baseline/CLAUDE_FEATURE_FLAGS.md`, `CLAUDE_BUILT_IN_MCP.md` (check `registerInternalMcpServer` calls), `ION.md`, `PLATFORM_GATE_BASELINE.md` - if their tracked internals moved.
- `docs/patches.md` patch tables - if patches added/removed/changed; the README's summary carries the per-directory counts. **Do NOT touch README install-command version numbers** (CI updates those via `sed`; manual edits cause merge conflicts).

## Step 9 - bump .upstream-version (required) + commit
```bash
echo "<NEW_VERSION>" > .upstream-version    # closes the "new version detected" issue, greens the README badge
```
Then commit + push to `master` directly, only when the user says to. After merge, release with `/deploy` (or `/deploy force` for patch-only changes where upstream version didn't move).

## Guardrails
- Always re-extract fresh if `./tmp` is stale (different minified names -> wrong conclusions).
- A green build with all patches applied + docs synced + `.upstream-version` bumped is "done". Don't claim done with failing patches.
