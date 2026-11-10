---
name: check-pr
description: Review one or more contributor pull requests to claude-desktop-extra the way the maintainer wants it - read, classify (category, switch, cost, Linux exposure), build the branch locally, audit the upstream code paths around every patched site in the pristine bundle, run the harnesses, decide with the maintainer, fix gaps with our own commits on top instead of review ping-pong, merge to master, release, and thank the author. Self-improving - every run ends by folding what it learned back into this file. Invoke as "/check-pr <PR numbers or URLs>".
disable-model-invocation: true
argument-hint: "<PR numbers or URLs>"
---

# Check PR - from contributor branch to released feature

PRs: **$ARGUMENTS**

Open PRs right now: !`gh -R patrickjaja/claude-desktop-extra pr list --state open --limit 10 2>/dev/null || echo "(gh not ready)"`
Latest release: !`gh -R patrickjaja/claude-desktop-extra release list --limit 1 2>/dev/null || echo "(gh not ready)"`
Upstream version patches target: !`cat .upstream-version 2>/dev/null`
Local master vs origin: !`git fetch -q origin master 2>/dev/null; git rev-list --left-right --count master...origin/master 2>/dev/null | awk '{print "ahead " $(1) ", behind " $(2)}'`

The main thread orchestrates and reads; audits, implementation and reviews run in dispatched workers. Follow the global subagent tier rules: name the tier and the reason in every dispatch.

**How the maintainer works with contributor PRs** (these are the rules the rest of this file serves):
- Assume good faith and say thanks, but verify everything. A green CI and a long "Validation" section in the PR body prove the patch *applied*, not that the feature works.
- **No review ping-pong.** When a PR has a gap, fix it with our own commit on top of the author's commits and merge, instead of a "request changes" round-trip. The author's commits stay intact and are credited.
- The author is credited in `CHANGELOG.md`, in the section heading: `### <What now works> (thanks @login, #N)`. Nothing in README or docs prose.
- A live end-to-end test is wanted when the host can do it. When it needs something the maintainer does not have (a second GitHub account, a GitHub App, another plan), say so in the PR comment, ship it anyway behind its switch, and ask the author to test after the release. A feature behind a Community switch that turns out broken gets a follow-up PR or is removed; that is acceptable.
- The maintainer installs packages themselves: build, hand over the `sudo pacman -U ...` line, wait.

**Gates.** Ask before each of these, and treat each approval as covering only its own step:
- building (ask once, up front, together with the review questions)
- the decision per PR (merge as is / fix on top / request changes)
- commit, push, merge
- the release
- every public PR comment

## Phase 1 - read everything

```bash
gh pr view <n> --json title,author,body,headRefName,headRepositoryOwner,baseRefName,files,commits,mergeable,statusCheckRollup
git fetch origin master && git fetch origin pull/<n>/head:pr-<n>
git merge-base origin/master pr-<n>; git diff --stat origin/master...pr-<n>
git diff origin/master...pr-<n> -- . ':!scripts/tests' ':!docs'   # code first, tests and docs second
```

- Diff against `origin/master`, never local `master`: the release job commits README versions and the Nix hash, so local master is often behind and the diff would show unrelated noise.
- Read the PR's own tests last, and read them for what they *assume*: a fixture that starts in a state upstream never produces (e.g. `own: true` on a binding upstream refuses to mark as own) makes every assertion green and the feature dead. The PR body's test counts are not evidence.
- **Docs-only PR:** no build, no workers. Grep each corrected claim against the code, and check AGENTS.md/CLAUDE.md for bare `@path` lines: they are imports loaded into every agent session, so they become plain links (on-top fix). No release needed; the CHANGELOG credit rides along.
- Several PRs from the same author off the same base each bump `EXPECTED_PATCH_COUNT` and `EXPECTED_TEST_HARNESSES` by one from the same number; merging both means re-bumping in the integration commit. Same for the per-directory counts in README and `docs/patches.md`.

## Phase 2 - classify

Answer these in the first reply, because the maintainer asks them every time:

1. **Category and switch - a judgement per patch, not a reflex.** The maintainer wants the project to be "for everyone": a contributor's Linux fix belongs in `patches/linux/` always on, infrastructure in `core/` always on, and only a feature that changes behavior or cost for every user goes behind a Community switch. The switch's default is a judgement too: ON when the feature is a plain improvement most people want and costs nothing (the theme picker and the Computer Use consent switch ship on), OFF when it spends model turns or API budget or replaces an upstream surface. Say which in the review and in the thank-you. `patches/linux/` is always on and must be a Linux fix. `patches/community/` is an opt-in feature with a row in Settings -> Extra -> Community Features (a toggle, or a list/editor whose empty state equals upstream behavior). `patches/core/` is always-on infrastructure that other patches build on. A new *feature* in `core/` with no switch is misplaced: it goes to `community/` behind a switch, default off, as an on-top commit.
   **Switch check (mandatory, the maintainer's first concern):** most contributions are features, and every feature must sit behind a Community switch, either its own or the switch of the feature it extends. Name the switch, then verify that switching it off preserves upstream: the off state renders upstream's output, and the injected code starts no timers, polling, IPC or network reads before it has read the switch. Code that renames or wraps upstream functions runs whatever the setting is, so read what it does while off. A patch that targets `resources/ion-dist` only reaches 3P mode (app://localhost); in 1P the UI is remote claude.ai code. Say so in the review, and in the docs if the PR leaves it out.
2. **Cost and blast radius.** Does it call GitHub/claude.ai APIs on a sweep (rate budget shared with upstream's own reads)? Does it inject messages into a running session (spends model turns)? Does it persist state (per-profile path via `app.getPath("userData")`, never a fixed home path)? Default off unless the maintainer says otherwise.
3. **Linux compatibility - always, for every PR.** Read `.claude/skills/linux/SKILL.md` and go through each axis of its matrix: distro/package format (Arch, deb, rpm incl. RHEL 9, Nix, AppImage), glibc floor, x86_64 + aarch64, X11/Wayland/XWayland, the desktop environments and compositors, input/screenshot backend, and profile isolation. Give a one-line verdict per axis in the review, "not touched" included. Touching the launcher, a bridge, packaging, session-type or compositor paths means checking every row in depth. Pure main-process or renderer JS still gets the per-axis lines, plus the 1P/3P mode split.
4. **Windows branch.** Custom models and the Extra settings page also load on win32 for the downstream fork; a new Extra row needs the `win32` handler refusal and must not change Linux behavior.

## Phase 3 - build and audit in parallel

**Worktree and build** (ask first, then run in the background):
```bash
git worktree add .claude/worktrees/pr-<n> pr-<n>
cd .claude/worktrees/pr-<n> && ./scripts/build-local.sh      # downloads the current official .deb into build/work/
```
Never `git add -A` in a PR worktree that holds a `tmp` symlink to another checkout's extract: `tmp/` is gitignored as a directory, the symlink is not, and it ends up in the commit (happened on #310; amend it out). Use `git add -u` plus explicit new paths. The build does not leave a pristine extract behind. For the audit, extract one into the worktree's `tmp/`: `ar x` + `tar xf` the `.deb` from `build/work/` into `tmp/extract/`, then `npx @electron/asar extract tmp/extract/usr/lib/claude-desktop/resources/app.asar tmp/app.asar.contents`. A second PR worktree can symlink that `tmp/`. Workers read the bundle with `python3 -I` or `grep -a`; `rg` silently finds nothing in it.

**Audit the upstream code around every patched site** - this is the step that finds the real bugs, and the main thread does the key read itself:
- For each regex site, dump the enclosing method and its **callers and gates upstream of it**. A patch that relaxes a check deep in a method is a no-op when an earlier gate (ownership, platform, feature flag, state machine) already refused. #308 patched two `not_author` checks that sat behind an `own`/`notOwnRead` ownership gate decided at bind time; the feature could never fire for its own use case.
- List every **runtime anchor** the injected JS assumes (property names, method arities, return shapes, option objects, message formats, Map key formats) and have an opus worker verify each one against the pristine bundle with a HOLDS / BROKEN / PARTIAL verdict and a quote. The build only checks the regex anchors.
- Check for **absorption**: does upstream already ship part of the behavior (same strings, same event)? Then that part is dropped, not duplicated.
- Harnesses: `bash scripts/run-feature-tests.sh <category>` for the touched category plus `core`, the PR's own harness with `tmp/` present (its "real release" branch must run, not SKIP), the absorption probe, `node --check` on a patched copy, `nph --check` + `nim check` on new Nim.

## Phase 4 - decide with the maintainer

One AskUserQuestion with one question per PR, recommended option first:
- **Fix on top (recommended when a gap is real and bounded):** our commit after the author's, then merge.
- **Merge as is:** nothing to fix; credit and ship.
- **Request changes:** only when the design itself is wrong and the fix would be a rewrite.

Also ask up front which identity or environment a live test needs, so "skip live, ask the author to test" is a conscious choice.

## Phase 5 - fix on top

Dispatch an implementer (opus for ownership/consent/state semantics, sonnet for contained plumbing) into the PR worktree with: the exact sites and host/scope variables you already found, the AGENTS.md strictness rules, "extend the PR's harness against the real extract", "do not commit, do not build", and the docs/CHANGELOG wording (regular `-` dashes, `->` not arrows, no em-dashes, author credited in the heading). Review per Phase 4 of `/check-issue`. Rebuild and rerun the category harnesses afterwards; the implementer's `make` is not a package build.

A feature moved from `core/` to `community/` gets: `git mv` of the patch, a `globalThis.__cdb...` predicate in `js/extra_settings_main.js` read by the patch (pattern: `fix_tray_icon_theme.nim` / `__cdbTrayAlwaysWhite`), a bridge channel pair in `js/extra_settings_bridge.js`, a row in `FEATURE_ROWS` of `js/extra_settings_page.js`, the win32 refusal, the DOM and bridge harness lines, and the `docs/patches.md` table move with both directory counts (README too).

## Phase 6 - ship

1. Build in the PR worktree, hand over `sudo pacman -U <worktree>/build/<pkg>`, wait for the maintainer to install and restart the app.
2. Live check what the host can check: the new Settings row (read, save, reload, JSONC lock), the `[...]` lines in `~/.config/Claude/logs/claude-patches.log`, and the feature path when an identity for it exists. A test PR in this repo via `gh` is fine for GitHub-side features; delete it afterwards. Run the feature path BEFORE pushing: a harness built from the shape the author believes upstream sends can be green while the real app never takes that path. When the live path silently falls back to upstream, the on-top fix adds one `claude-patches.log` line naming the check that refused, then retest. A desktop-driving worker re-activates the app window before every typed chunk and click; the maintainer typing elsewhere steals focus. On an X11 host the main thread can drive the app itself without the maintainer: `xdotool mousemove --window <id> x y click 1` + `xdotool type`, screenshots with `import -window <id>` (the Electron window, found via `wmctrl -lx | grep anthropic.Claude`) and `import -window root -crop WxH+X+Y` for GTK portal dialogs, whose `--window` coordinates are off by the frame height - use absolute root coordinates there, navigate the folder picker through its sidebar bookmark and click the row, then Select. A Code session on a test branch: Code tab -> folder dropdown -> Open folder..., untick Worktree, send a one-word prompt; the PR binding lands in `~/.config/Claude/claude-code-sessions/<org>/<account>/local_<id>.json` (`prs`, `autoArchiveOnPrClose`). Delete the test PR's file from master afterwards: merging it puts the file on master.
3. **Re-fetch every PR head right before merging, and before dispatching an implementer** (`git fetch origin pull/<n>/head:refs/remotes/pr/<n>` and compare with the SHA you reviewed; never compare via FETCH_HEAD, the next fetch overwrites it): an on-top fix written against a stale head has to be ported when the author has rewritten the same files. contributors push while you review, and a head that is not reachable from master leaves the PR open even after its earlier commits landed. A late commit is cherry-picked under the author's name (`--author`), then `git merge -s ours pr-<n>` makes the head reachable so GitHub marks the PR merged. Merge on `master`, directly, no feature branch: `git merge --no-ff pr-<n>` (or merge both PRs in sequence), then the integration commit (count re-bumps, CHANGELOG with credit, docs), then `git push origin master`. The PR shows as merged once its head commit is reachable from master.
4. Release: `gh workflow run build-and-release.yml --ref master -f force_rebuild=true` (or `/deploy force`), watch with `gh run watch <id> --exit-status`, confirm `gh release view`.
5. Clean up: `git worktree remove .claude/worktrees/pr-<n>`, delete the local `pr-<n>` branches.

## Phase 7 - thank the author

One comment per PR, in the `/comment` voice: thanks, what shipped (and its menu path), the **release** in bold, what we changed on top in one sentence and why (no blame, no internals), and - when the live test needed something we lack - one friendly sentence saying so and asking whether they can confirm it on the release. No bullet lists, no edge cases, no invitation to send more PRs.

For a PR with a UI change, attach two or three screenshots from the live check to the comment itself, each with a one-line caption saying what it shows: not only where the new row is, but what was tested (a refused input with its message, a saved state, the evidence behind any "could not reach X here" sentence). The maintainer takes the time to test and wants the thread to show it. Crop to the row or dialog in question (about 800 px wide): two full-window shots that differ in one value look identical on a phone, which is where the maintainer reads the thread. Draw a rectangle around what is new, and personal data blurred (name, org, sidebar recents, the config path line under the rows, project names in a session header, other windows); crop and view every blur strip before uploading, the path line moves when a row wraps. `gh` cannot upload attachments, so a worker uses claude-in-chrome with the maintainer's GitHub session and drags the PNGs into the comment editor (the same recipe as `/check-issue` Phase 7); check every PNG before uploading. The comment editor's own file input ignores the extension's `file_upload`: upload through the page's bottom "Add a comment" box instead, read the `user-attachments/assets/<uuid>` URL GitHub inserts there, clear that draft without submitting, and type the `![name](url)` line at the end of the edited comment. Verify afterwards with `gh pr view <n> --json comments` that each comment body references its asset and that no extra comment was posted.

## Phase 8 - self-improve (always, last step)

Before reporting done, update **this file**. Fold lessons into the phase they belong to; keep dated one-liners under "Lessons" only when they have no home; never write minified names or versions into the phases; keep this file under ~150 lines; tell the maintainer in one line what changed.

## Lessons

- 2026-11-04 (#308): a PR's harness can be green with the feature unreachable. Always trace the gates *before* the patched site in the pristine bundle, and read the fixtures' starting state.
- 2026-11-04 (#309): a contributor may put a new feature in `patches/core/` because the infrastructure patches live there; the category question is the first thing the maintainer asks.
- 2026-11-05 (#312): when two PRs append a `{ ... }` block at the same spot of a harness, git keeps the shared closing braces as common text and a keep-both resolution leaves the first block unclosed; `node --check` still passes when the block lives inside a driver string. Re-run the harness after every merge resolution and gate the commit on it.
- 2026-11-05 (#316): an ion-dist patch reaches 3P mode only, and React-compiler cache calls (`<alias>(<slot count>)`, `$[<n>]`) plus vendor export names are minified anchors too; demand `[\w$]+`/`\d+` and stable strings. The author force-pushed a rework mid-review (the on-top fix was ported onto it).
- 2026-11-06 (#316): the author's UI half patched ion-dist, which only 3P loads; the maintainer wanted it for everyone, so the port to the claude.ai page (runtime injection like panel tabs) was our follow-up, live-verified with the recipe in Phase 6. Ask "does this reach 1P users?" for every renderer patch.
- 2026-11-04: `run-feature-tests.sh` prints its Summary on the second-to-last line (a `===` rule follows); gate on `tail -2 | grep ' 0 failed'`, not `tail -1`.
- 2026-11-05 (#313): the patch keyed on the first-use folder sentence in the ask reason; live, upstream asked with its ordinary card (no reason) and the dialog never fired, although a 48-test harness incl. the real broker passed. Found only by the live run; fixed on top with a `card kept: <reason>` diag line.
- 2026-11-10 (#321, #322): a Nix module can be evaluated and its generated scripts built on a host without Nix through Docker (`nixos/nix`, a named volume for `/nix`, `path:` flake refs, stub packages instead of the app and the browser); say in the comment what only a real NixOS run can show. The PR's own CI step had never run (fork PRs get no CI).
- 2026-11-10 (#321, #322): our fix on top gets its own independent review before the merge. Both had a regression of ours (a bare-name spawn with a wide PATH; a transient failure turned into a permanent stop). A PR's CHANGELOG hunk conflicts with ours: take ours in the merge and write the credited entries in the integration commit.
- 2026-11-10 (#321): upstream narrows `process.env.PATH` to root-owned system folders at startup and keeps the launch PATH in an env variable. A wide PATH goes only to what the user named (the app to open); tools we choose are resolved on the narrowed PATH plus root-managed folders and spawned by absolute path.
