---
name: update
description: For claude-desktop-extra - handle a new upstream Claude Desktop version end-to-end: build, fix failing patches, diff old vs new JS for new platform gates, audit feature flags + ion-dist + platform gates, update baseline docs + CHANGELOG, bump .upstream-version, then commit.
disable-model-invocation: true
---

# Update to a new upstream Claude Desktop version

**When to run this:** normally you don't. CI auto-releases new upstream versions (version-check.yml dispatches build-and-release.yml; green run = released + `.upstream-version` bumped + tracking issue closed). Run this skill when the **auto-release failed** (a comment on the "new version detected" issue links the failed run) or when you want a deep audit of a bump. On a patch failure, decide FIRST: did the re-minify just move the anchor (fix the regex), or did upstream natively implement what we patch (**remove the patch** - the expected direction, since Anthropic maintains 1p Linux support)?

**Upstream changelog:** https://claude.com/docs/cowork/changelog ("Release notes for Claude Desktop", one entry per version incl. the bundled Claude Code version). Read the entry for the new version before Step 3; it is a hint list, not the authority (past major-number jumps went unexplained there - the code decides). The page is very long and newest-first: read the entries of EVERY version after the last audited one (auto-released and never-released versions in between count), not only the target's. It can already list a version newer than the apt repo serves; the apt repo (`.github/scripts/apt-fetch-verify.sh poll`) decides the target. A fetch tool that summarizes the page can wrongly report "no entry for this version": check the raw head of the page.

**What a bump has to answer** (the reason this project exists is Linux compatibility; on a major-number bump answer all three explicitly in the final report):
1. Does everything upstream ships still work on Linux (X11, Wayland, XWayland; x86_64 and aarch64), and did upstream add a gate, refusal or compiled-off feature that keeps Linux out?
2. Do all of our Extra features still work on the new build (not only "the patch applied": the data flow the patch relies on)?
3. Did upstream replace one of our features natively (remove ours), or add a feature that needs Linux work or overlaps one of ours?

**This skill improves itself.** Whatever the user adds about the task during a run, and whatever the run learns that would have saved time (a new trap, a new upstream layout, a missing audit step), goes into this file before the run ends (Step 10) - as a rule or a step, not as a run log.

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
- Check how many copies of `@anthropic-ai/claude-agent-sdk` the bundle embeds: `grep -ao 'CLAUDE_AGENT_SDK_VERSION="[0-9.]*"' ./tmp/new-bundle.js | sort | uniq -c`. It was 2 from v1.12603.0 and 1 by v2.42304.2 (0.3.299; 0.3.304 in v3.1623.0). If >1, a pattern on SDK-internal code matches once per copy: decide explicitly whether to patch both and assert the count.
- Keep the previous version next to the new one for the whole run: extract the last audited `.deb` (kept in `./tmp/claude-desktop_<old>_amd64.deb`) to `./tmp/extract-<old>`, `./tmp/app.asar.contents-<old>` and `./tmp/ion-dist-<old>`, and build both search concatenations and both staged test inputs (Step 1.3's concatenation, saved as `./tmp/staged-pristine-<version>.js`) up front. Running a patch's CURRENT binary against the OLD staged file shows what it used to match; that is the fastest way to find the same code in the new bundle.
- On Arch there is no `dpkg-deb`: `ar x <deb> && tar -xf data.tar.*` inside an empty directory (control files: `control.tar.*`).
- `fnm` may not be installed; plain `node` runs the feature tests.
- The shell's `grep` may be a ugrep shim that rejects long context patterns (`.{0,200}` fails with "exceeds complexity limits"; `.{0,60}` works). For wide context windows use python: `python3 -I -c 'import re,sys;d=open(sys.argv[1],"rb").read().decode("latin1");[print(m) for m in sorted(set(re.findall(r".{0,200}ANCHOR.{0,200}",d)))]' "$NEW"`.

## Step 0 - clean slate
```bash
cd "$(git rev-parse --show-toplevel)"
git status                  # must be clean before starting
rm -rf build/ extract/      # old artifacts
```
Note current `.upstream-version`. If you're here because the auto-release failed, read the failed run's log first - it names exactly which patch (and which sub-patch counter) failed: `gh run view <id> --log-failed | grep -aE '\[FAIL\]|FAILED|ABSORBED|PARTIAL|absorbed-probe'`. A patch stops at its first failing sub-patch, so the log under-counts: the Computer Use patch showed 1 failure in CI and needed 14 re-fits at v6.28899.2.

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
4. Re-run the build until all patches pass. **Every sub-patch must succeed or `quit(1)`** - never `[WARN]`+continue. If a feature was upstreamed, **remove the patch** (`git rm`, bump `EXPECTED_PATCH_COUNT` in `scripts/apply_patches.py`). The absorption probe (`scripts/check-upstream-absorbed.py`, run by the build) flags ABSORBED/PARTIAL patches: audit that upstream ships the same behavior on Linux, then remove. FAILED means re-fit, not remove. A PARTIAL verdict can also be a false "already patched" in our own idempotency check (a prefix regex matching new, unrelated upstream code): read the matched site before removing anything. See AGENTS.md Rules 4/6.

5. The build then runs the two census gates on the patched tree (`python3 -I scripts/check-predicate-consumers.py <patched tree>`, `python3 -I scripts/check-refusal-strings.py --strict <patched tree>`, which turns warnings (weak-topic new strings, stale pins, `accepted` site-count changes) into failures so the pins are refreshed on every bump; see `docs/census-gates.md`). Red after a bump means a new consumer or refusal string, or a stale anchor/shape: audit the new code path, patch it at the definition, or add a reviewed baseline entry (loosening needs @patrickjaja in the commit); re-fit a stale anchor like a patch anchor.

6. Census red after a bump, typical causes: (a) dozens of `isComputerUseEnabled` consumers "uncovered" at once = the `definitionShape` pin no longer matches what `fix_computer_use_linux.nim` now emits at the definition - re-pin the shape, do not add entries; (b) a moved site makes an allowlist entry stale and its consumer uncovered - re-key the entry after re-reading the site; (c) a genuinely new consumer or refusal string - decide it. Copy the patched tree out of `build/work/app/app.asar.contents` (e.g. to `./tmp/patched-<version>`) so the census can be re-run without a rebuild. A new upstream gate is either server/org policy (managed key, HIPAA, an org's allowed-apps list: keep it on Linux, like upstream) or a technical platform refusal (decide whether our bridges make it wrong on Linux). Every loosening entry is listed in the final report for the maintainer's sign-off.
7. Run the full feature suite (`bash scripts/run-feature-tests.sh <group>` for all three groups) after the patches fit: many harnesses pin upstream shapes in fixtures and need the new shape added next to the old one. A harness that picks an extract by directory listing must prefer `tmp/app.asar.contents` (a version-named sibling such as `tmp/app.asar.contents-<old>` sorts last and was picked by mistake once). Then `grep -a SKIP` the test logs: a section that skips on "older bundle shape" when its pristine regex stops matching has silently lost its coverage (the managed `computerUseEnabled` gate test did at v6.28899.2); such a skip must be a failure whenever the bundle still has the feature.

### When many patches fail at once (major re-minify)
Do not fix them one after another in the main thread. Run the absorption probe (`python3 scripts/check-upstream-absorbed.py tmp/app.asar.contents tmp/extract/usr/lib/claude-desktop/resources/ion-dist.asar`) for the authoritative per-patch FAILED list (each patch on pristine input); `validate-patches.sh` additionally shows the messages, but it chains patches per target, so a line near a patch name can belong to its neighbour and some patches only fail there as a consequence of an earlier one. Then group the failing patches by the upstream area they touch and give each group to one parallel sub-agent (opus: absorb-vs-refit is a judgement) with a shared written brief: pristine inputs, the test loop, "only edit your patches, their js/ snippets and their tests", "only `make` your own targets", "work on your own copy under tmp/agents/<name>/", "do not `git rm`, report absorbed candidates with verbatim evidence", and a fixed report format (verdict, old/new snippet, change, test evidence, runtime risks, out-of-scope findings). Groups that worked at v6.28899.2: main-window factory (frame, transparency, title, bounds, focus, session-start dialog) / tray / app lifecycle + Computer Use + Quick Entry / feature flags + Step 4 / ion-dist + Step 5 / remaining community features + the anchor baselines / a read-only agent for Steps 2, 3 and 6. Patches that chain on one upstream site (the window group) must also be run in basename order on ONE staged copy, twice. Forward changelog hints to the agent whose patches they touch. After all agents report: full build, then one agent per census gate.

## Step 2 - Linux-compat analysis (new gates?)
Diff old vs new for newly darwin/win32-gated features that need Linux support (`OLD`/`NEW` = the two concatenations from the search rules):
```bash
diff <(grep -aoE '.{0,40}process\.platform.{0,40}' "$OLD"|sort -u) <(grep -aoE '.{0,40}process\.platform.{0,40}' "$NEW"|sort -u)
diff <(grep -aoE '.{0,80}status:"unavailable".{0,80}' "$OLD"|sort -u) <(grep -aoE '.{0,80}status:"unavailable".{0,80}' "$NEW"|sort -u)
diff <(grep -aoE 'require\("[^"]+"\)' "$OLD"|sort -u) <(grep -aoE 'require\("[^"]+"\)' "$NEW"|sort -u)   # new native modules -> need x86_64+aarch64
```
Validate any new input/screenshot feature across all 5 session types (X11, wlroots, GNOME, KDE, XWayland).

Also check, because these do not show up in the platform greps:
- **Compiled-off features:** the Linux bundle carries build-time constants such as `function <x>(){return!1}` behind a capability key (v6.28899.2: `artifactApps`, `gentleQuince` sign-in requests, `movedMenuKeys`). A new registry key whose gate is a constant `!1` is a feature upstream left out of the Linux build: report it (it needs a new implementation, not a gate flip).
- **Wayland-only refusals:** new consumers of the session predicates (`XDG_SESSION_TYPE`/`WAYLAND_DISPLAY`, the `ozone-platform` switch) - the predicate census lists them; our launcher defaults to native Wayland, so each one is user-visible.
- **Entry point and startup order:** `package.json` `main` and the non-chunk files in `.vite/build/` (since v6.28899.2: `launcher.js` -> `index.pre.js` -> optional `earlyShell.js` -> `index.js`). The early shell loads the main bundle only after app `ready` and replays events; it opts out when `process.argv.length>1` or on Wayland, and our launcher always passes a Chromium switch, so it never runs in our packages. Re-read `earlyShell.js`'s opt-out function on every bump: if that condition changes, every injection of ours that must run before `ready` needs a re-audit.
- **New windows and processes:** new `new <x>.BrowserWindow(` / `BaseWindow(` sites and new `utilityProcess.fork` sites (do our frame, transparency, title and profile patches need to cover them; does a worker need a native binary).

## Step 3 - diff old vs new JS
```bash
diff <(cd ./tmp/app.asar.contents-OLD && find . -type f | sed 's/-[A-Za-z0-9_-]\{8\}\.js$/.js/' | sort) \
     <(cd ./tmp/app.asar.contents && find . -type f | sed 's/-[A-Za-z0-9_-]\{8\}\.js$/.js/' | sort)   # new/removed files
diff <(grep -aoE 'handle\("[^"]+"' "$OLD"|sort -u) <(grep -aoE 'handle\("[^"]+"' "$NEW"|sort -u)      # IPC handlers
```
Read the new version's entry in the upstream changelog (https://claude.com/docs/cowork/changelog) and cross-check every item that touches something we patch or ship (Quick Entry, window chrome, settings pages, popouts, managed-settings keys, Computer Use) against the patches; the code stays the authority. Also skim Claude Code / Cowork subsystem changes. Classify each finding: rename-only (no action) / new feature (may need a Linux patch) / changed behavior (existing patches may break) / removed (clean up patches/docs).

The `en-US.json` i18n diff (`resources/i18n/en-US.json`, new keys and values) is the quickest list of new user-visible features; the capability-registry key diff (Step 4) is the second.

If earlier versions were auto-released without an audit, diff catalogs and baselines (Steps 4-6) against the LAST AUDITED version (the version stamped in the baseline docs), not just the previous release.

## Step 4 - feature-flag audit
Read `baseline/CLAUDE_FEATURE_FLAGS.md`. Find the new static-registry function name (changes every release; anchor on a known flag like `ccdPlugins`). Diff flag sets:
```bash
diff <(grep -aoE '[\w$]+\("[0-9]{6,}"\)' "$OLD"|sort -u) <(grep -aoE '[\w$]+\("[0-9]{6,}"\)' "$NEW"|sort -u)
```
Check `enable_local_agent_mode.nim`'s override list still covers the cowork/code flags and its Zod schema includes them. Update the doc + version-history table.

Also refresh the flag catalog in `js/growthbook_overrides.js` (TEMPLATE): it lists every store-consulted flag of the audited version, commented out. Extract IDs from EVERY quoted 6-10 digit literal, not only call-shaped ones (many IDs are hoisted into a variable first, e.g. `var Ou="1169442571";...t.u1(Ou,!0)`, or sit in arrays; a call-shaped grep found 516 of 619 at v3.1623.0): `grep -aoE '["`][0-9]{6,10}["`]' <new-bundle-concat> | tr -d '"`' | sort -u`, then drop non-flag constants (git modes like `100644`/`160000`, registry dwords, `0123456789`, size/limit literals) and dead gates, each after reading its site. Drop the IDs force-rewritten by patches (`grep -oI '"[0-9]{6,10}"' patches/*/*.nim`, minus IDs only mentioned in comments), and update descriptions + the version stamp in the header. Then regenerate the browsable copy and rebuild the binary:
```bash
bash scripts/check-jsonc-template-sync.sh --write   # updates docs/claude-desktop-extra.jsonc
touch patches/core/add_growthbook_overrides.nim && (cd patches && make)
```
CI runs `scripts/check-jsonc-template-sync.sh` (no `--write`) and fails if the docs catalog drifts from the shipped template.

## Step 5 - ion-dist SPA audit
Read `baseline/ION.md`. ion-dist is in the `.deb`'s resources, not inside `app.asar`. Since v4.29.0 it ships packed as `resources/ion-dist.asar` (the build extracts it, patches the extract and repacks it in place); extract it once for the audit:
```bash
asar extract ./tmp/extract/usr/lib/claude-desktop/resources/ion-dist.asar ./tmp/ion-dist
ION=./tmp/ion-dist
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
grep -aoE '.{0,60}processPlatform\(\).{0,60}' "$NEW" | sort -u   # injected gates, e.g. this.deps.processPlatform()!=="win32" - the process.platform greps miss these
```
Classify each: PATCHED (maps to a patch) / NATIVE (real Apple/Win API) / STUB (disabled on all platforms) / **PORTABLE** (mac/win-only, no native dep, not patched - the only actionable class). **Verify before reporting:** trace every PORTABLE candidate yourself and quote the verbatim snippet; past sub-agent audits hallucinated removed features and fake UUIDs. Update the baseline's `Last audited`, counts and rows.

## Step 7 - Cowork backend
Cowork runs on the `.deb`'s bundled native VM backend (cowork-linux-helper + virtiofsd + smol-bin + QEMU/OVMF; the local VM requires `/dev/kvm`). Nothing to update on a bump. Cowork has two backends: cloud Cowork (1P only; no KVM, desktop tools need a keyed device = TPM access) and the local Cowork VM (optional in 1P, the only Cowork in 3P). Settings -> Extra -> Cowork (Linux) shows both.

Re-check on every bump: `baseline/COWORK_HEADER_ICON_ANCHORS.md` (the claude.ai header icon anchors of `fix_cowork_device_icon_web.nim`) and the two core captures in `add_feature_extra_settings.nim` (`globalThis.__cdbNavigation`, `globalThis.__cdbCoworkVmProbe`) that the Cowork (Linux) page uses.

## Step 8 - docs
Update only what changed:
- `CHANGELOG.md` - add the new entry (one `##` section per day, newest at top; informative not a debug log).
- `baseline/CLAUDE_FEATURE_FLAGS.md`, `CLAUDE_BUILT_IN_MCP.md` (check `registerInternalMcpServer` calls), `ION.md`, `PLATFORM_GATE_BASELINE.md` - if their tracked internals moved.
- `docs/patches.md` patch tables - if patches added/removed/changed; the README's summary carries the per-directory counts. **Do NOT touch README install-command version numbers** (CI updates those via `sed`; manual edits cause merge conflicts).

## Step 9 - bump .upstream-version (required) + commit
```bash
echo "<NEW_VERSION>" > .upstream-version    # closes the "new version detected" issue, greens the README badge
```
Then commit + push to `master` directly, only when the user says to. After merge, release with `/deploy` (or `/deploy force` for patch-only changes where upstream version didn't move). The commit that carries loosened census entries needs @patrickjaja in its message (AGENTS.md).

## Step 10 - live spot-check and self-improvement
- **Live spot-check** (a green build proves the patches applied, not that they work): install the built package (the user allowed `sudo-pw.txt` in the repo root for this during `/update`; otherwise hand over the command) and check the items the re-fit reports marked as "runtime risk". Standing list: app starts and `claude-patches.log` shows the `[claude-cu]` init lines and no patch error; title-bar modes and transparent window; tray icon, left click and hidden start; Settings -> Extra pages open (Features lists the new flag count, Deployment the new keys); Code tab with custom models writes an `active:` line to `custom-models.log`; Ctrl+P quick open; the `[cdb-*]` and `[archive-grace-ui]` anchor warnings in the logs (remote claude.ai code moves without a desktop release).
- How to drive it on an X11 host without touching the user's sessions: record the log sizes first and read only the new bytes; `wmctrl -lx` + `import -window <id>` for screenshots; `xdotool key ctrl+comma` opens Settings; the tray's left click is `gdbus call --session --dest <bus name of the app's StatusNotifierItem> --object-path /StatusNotifierItem --method org.kde.StatusNotifierItem.Activate 0 0` (names from `RegisteredStatusNotifierItems` on `org.kde.StatusNotifierWatcher`); `claude-desktop --toggle` twice for Quick Entry (`[quick-entry] shown` in the log). Do not start Code or Cowork sessions in the user's account for a check: list those items as unverified (the Claude Code CLI of the new version is only downloaded when a session starts). Leave the app in the state it was found in.
- User-visible text must not carry a hardcoded upstream version (the Deployment page did, four majors stale): grep `js/*_page.js` for `v[0-9]+\.[0-9]+\.[0-9]+` inside UI strings.
- **Improve this skill:** add what this run learned (see "This skill improves itself" at the top) and save user guidance that outlives the run to memory.
- **Final report** answers the three questions from "What a bump has to answer", lists every census entry that loosens a gate, every runtime item that was not checked live, and every upstream feature that is off or limited on Linux.

## Guardrails
- Always re-extract fresh if `./tmp` is stale (different minified names -> wrong conclusions).
- A green build with all patches applied + docs synced + `.upstream-version` bumped is "done". Don't claim done with failing patches.
