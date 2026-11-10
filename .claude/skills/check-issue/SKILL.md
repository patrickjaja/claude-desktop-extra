---
name: check-issue
description: Take one or more claude-desktop-extra GitHub bug reports from triage to a shipped fix - read, classify ours vs upstream, reproduce without touching the user's running app, spec with the maintainer, implement and review in parallel, verify live, commit, release, and close the loop with the reporter. Self-improving - every run ends by folding what it learned back into this file. Invoke as "/check-issue <issue numbers or URLs>".
disable-model-invocation: true
argument-hint: "<issue numbers or URLs>"
---

# Check issue - from bug report to shipped fix

Issues: **$ARGUMENTS**

Open issues right now: !`gh -R patrickjaja/claude-desktop-extra issue list --state open --limit 10 2>/dev/null || echo "(gh not ready)"`
Latest release: !`gh -R patrickjaja/claude-desktop-extra release list --limit 1 2>/dev/null || echo "(gh not ready)"`
Upstream version patches target: !`cat .upstream-version 2>/dev/null`

The main thread orchestrates. Investigation, implementation, review and live tests run in dispatched workers. Follow the global subagent tier rules: name the tier and the reason in every dispatch.

**Gates.** Ask before each of these, and treat each approval as covering only its own step:
- the spec
- building or installing (the maintainer does this themselves)
- commit and push
- the release
- every public issue comment

## Phase 1 - read everything

```bash
for n in <numbers>; do gh issue view $n --json title,author,createdAt,body; gh issue view $n --comments; done
```

- `--comments` shows only the comments, never the body. Always fetch the body separately with `--json body`.
- Pull any `--diagnose` gist the reporter linked with `gh gist view <id> --raw > <scratch>/gist<n>/diagnose.txt`. Then grep it for session type, compositor, scale, bridges and versions.
- Compare the reporter's version with `.upstream-version` and the installed package (`pacman -Q claude-desktop-extra`). `tmp/` is reusable read-only only when `tmp/app.asar.contents/package.json` says the same version: its mtime lies (a fresh-looking `tmp/` held the previous release in #318). Otherwise re-extract before any probe or real-release harness section runs.

## Phase 2 - investigate in parallel (read-only)

Dispatch one worker per issue. A contained parsing or logic bug goes to `sonnet`. Coordinate math, renderer lifecycle, or minified-anchor work goes to `opus`.

Each brief carries:
- the issue text and the suspected file:line
- "READ-ONLY, no edits, no commits"
- a scratch dir per issue
- this question: **ours or upstream?**

**Ours or upstream:**
- Computer Use (`js/cu_*`, the bridges) is always ours, because upstream ships no Linux CU.
- For anything else:
  - Find upstream's code in the pristine bundle (`grep -a` across `tmp/app.asar.contents/.vite/build/index*.js`).
  - Confirm that our patches do not touch that path.
  - Search `anthropics/claude-code` issues for the same symptom.
- An upstream bug that only breaks on Linux is still ours to patch. It counts as a functional gap, not a cosmetic one.
- A refusal or a gate that one of our patches already touches: resolve the upstream predicate behind it and list ALL its consumers (export aliases, lazy requires, derived values) before calling it an upstream change. `scripts/check-predicate-consumers.py` on a patched tree does this (docs/census-gates.md); #323 was a call-site patch that covered 1 of 3 consumers. When the cause is a class of gap, dispatch a second read-only worker for the sibling audit in the same phase.

**Reproduce without the user's running app.** The user's Claude is in use: never signal its processes, and identify yours by your own `--user-data-dir`.
- **Renderer, main-process or Electron behaviour:** run on a private Xvfb display with `env -i` and a throwaway HOME, XDG_RUNTIME_DIR, CLAUDE_CONFIG_DIR and `--user-data-dir`. Use the installed binary or a scratch patched tree. A hung renderer is simulated with `SIGSTOP` on the main renderer.
- **A scratch 3P instance** (anything on `app://localhost`, managed/gateway deployments) needs no login and no `/etc`: a throwaway HOME where `<userData>-3p/configLibrary/_meta.json` applies an entry with `inferenceProvider: gateway` pointing at a stub HTTP server on 127.0.0.1, plus `deploymentMode: 3p` in `claude_desktop_config.json`; the launcher's `--user-data-dir` only identifies the pid. `main.log` must show upstream's `3P mode active`. Our IPC can be probed from an appended `index.js` probe that calls the Extra page's preload bridge. Crop screenshots to the Settings dialog: the account row shows `os.userInfo()`'s login name whatever `USER` says.
- **A logged-in scratch instance** (cloud session timing, anything that needs the account): copy `~/.config/Claude` minus logs, caches, vm_bundles and `bridge-state.json` into a 0700 scratch dir and use it as `--user-data-dir`, pass the real `DBUS_SESSION_BUS_ADDRESS` so libsecret can decrypt the cookies, and delete the copy afterwards. `--remote-debugging-port` makes the app refuse to start; append a probe to the scratch asar's `index.js` instead (wrap main-side hooks, `executeJavaScript` into the claude.ai page every few seconds). On Xvfb the CU overlay renders solid black, so the model never clicks anything: good for lock, turn-end and API timing, useless for click accuracy. Upstream re-shows the session page when the lock is released, so a 'page not mounted' run has to re-assert the home after that.
- **Wayland, wlroots or fractional scale:** use headless sway per `/test-native`, and run the bridge CLI directly against it. The Wayland socket path must stay under 108 bytes, so use a short `mktemp -d /tmp/xx.XXXX` runtime dir rather than the scratchpad.
- **GNOME portal (gnome-portal-bridge) without a VM:** headless nested GNOME on the host (`dbus-run-session -- gnome-shell --wayland --no-x11 --devkit --virtual-monitor WxH`, private XDG_RUNTIME_DIR, own xdg-desktop-portal + pipewire), with the consent dialog and "Stop sharing" driven over accessibility/Shell.Eval. Good for bridge-level session tests; it cannot host a logged-in Claude.
- **VMs:** allowed, but never start Cowork inside a VM. Install a build in a guest with its package manager (or an extracted tree under the user's home), never by copying onto `/usr`: a `cp -a` onto `/usr/share` changed its owner and broke sshd. Turn off the guest's idle lock before handing a VM to a worker: auto mode rightly refuses to get past a lock screen, so a locked VM stalls the run.

**Session types.** Upstream's Computer Use lock lives differently per session type: the Code tab and local Cowork release it after every turn, cloud Cowork only after an idle sweep or Stop. Anything of ours tied to the lock (bridge sessions, latches) must be checked against each type, and against the reporter's type from their first comment.

**Verify before presenting.** Spot-check a worker's key upstream claim in the pristine bundle yourself before calling it the root cause; the maintainer will ask whether it was audited, and whether there is an event to hook instead of a timer. When a report says one of our hooks never fired, check first whether the hook logs on entry: a silent early return (#293 `__cuTaskBoundary`) makes 'never arrived' and 'arrived too late' look the same. Reading the remote claude.ai SPA needs the Chrome worker: fetch chunks from the page origin with `fetch()` in javascript_tool (host curl gets 403), and expect its output filter to block raw minified code (swap `= & ; ?` for other characters to get snippets through).

**Fallback paths.** When a backend has a fallback path, check which path the reporter's data came from before blaming the primary one. In #298 the bridge was correct and the Electron fallback was not.

## Phase 3 - spec, with the maintainer

Load `agent-skills:spec-driven-development`. Write `.agent/SPEC-<slug>.md`. The `.agent/` dir is gitignored, so never commit it or mention it in tracked docs. The spec contains:
- **Capability map:** one module per issue, plus its dependencies.
- **Ours vs upstream table:** one row per issue, with the evidence.
- **Per-module design.**
- **A "Linux compatibility" section.** Check it against every row of the `/linux` matrix. No hard dependency on one distro's or one desktop's tools: optional tools are probed with `_hasCmd`, and the common path needs none of them. Name the Debian, AppImage and NixOS gaps explicitly.
- **Commands, testing strategy, boundaries and success criteria.**
- **A "Rulings during implementation" section,** appended as decisions are made.

Ask the real design forks with AskUserQuestion: one question per fork, with the recommended option first. Before proposing a default, ask whether an existing user's behaviour changes on update: if it does, the recommended option is a community switch that is off by default, with the upstream path untouched when off (the maintainer corrected two 'on by default' proposals in #323). Approval of the spec covers "break into tasks and dispatch". Save the plan and the ledger to `.agent/tasks/plan-<slug>.md` and `.agent/tasks/todo-<slug>.md`.

## Phase 4 - implement in parallel

**File ownership:**
- Two tasks that edit the same file each get their own worktree, or else run in sequence. A reviewer of a finished task whose files the next task is already editing gets a snapshot (`git diff` plus a tar of the untracked files) and builds a private clone from it. A worktree task leaves its diff uncommitted. The orchestrator then runs `git apply --check` and `git apply` on the main tree (`-3` fails on a dirty index) and copies over any untracked files.
- Implementers never touch `CHANGELOG.md`, `docs/`, `README.md`, or `EXPECTED_TEST_HARNESSES` in `scripts/run-feature-tests.sh`. The integration task owns those, so parallel edits cannot conflict. New harnesses run with plain `node <file>` until the count is bumped.

**Rules every brief must state:**
- No `build-*.sh`, no package build, no install, no commit.
- `make` does not track `js/`. After a JS edit, `touch` the embedding `.nim` file before `make`.
- Patch work follows AGENTS.md strictness: every sub-patch must apply, idempotency checks positive end state, `[\w$]+` anchors.
- A new harness must fail against the old code. Ask for the before/after count.
- A hook on an upstream event logs one line on entry, before any early return, so an empty grep later means the event never arrived.
- A harness that runs the compiled patch is only valid after `make` ran AFTER the last `js/` edit (the binary embeds the JS); reviewers rebuild in a scratch copy before trusting counts.
- A harness must fire the trigger upstream really uses. If it only calls our own injected hook (e.g. the CU lock hook), it misses upstream paths that bypass that hook: #300 passed ~400 harness cases and a private-display rig, then failed in the first real Code-tab turn.
- Live checks run on scratch trees only.
- Scratch budget: `/tmp` is a 16 GB tmpfs. A worker keeps its scratch under 2 GB and deletes it when done (one reviewer's 11 GB repo copy filled the disk and put a "Low disk space" toast into the after screenshots).
- A runtime global that one patch defines and others consume (`globalThis.__cdbX`) gets its idempotency marker from the DEFINING line (`globalThis.__cdbX = Object.freeze(`), never the bare name: consumers injected earlier in basename order mention the name, and a bare-name marker reads as a partial injection on a pristine build.

**Reviews:**
- Every task gets an independent per-task review.
- Feed the findings back to the same implementer through SendMessage, so it keeps its context.
- Do not re-review small verified fixes. A fix round that rewrites whole files is not small: name those files in the final review's brief.
- Compositor or desktop-service code written from documentation (Hyprland IPC, kglobalaccel) is not done until it ran on the real thing: schedule the VM run right after the task's review, before integration. In #323 it found a compositor crash and a keymap defect that mocks and reviews had passed.
- A new shared crate is a path dependency until its repo exists: bridge CI, and the local build's container build of the dynamic bridges, cannot see `../<crate>`. Tell the maintainer early that a new GitHub repo is needed.

## Phase 5 - integrate and gate

The integration worker (sonnet):
- bumps `EXPECTED_TEST_HARNESSES` by the number of new harness files
- updates `docs/patches.md` rows and feature docs only where they are now wrong
- writes one `## <today>` CHANGELOG section, as solutions not history, without blaming our patches and without naming contributors in prose
- runs the full local gate:

```bash
touch patches/linux/<embedding>.nim && (cd patches && make -j"$(nproc)")
python3 scripts/check-upstream-absorbed.py tmp/app.asar.contents tmp/extract/usr/lib/claude-desktop/resources/ion-dist.asar
bash scripts/check-patch-sibling-noop.sh
bash scripts/run-feature-tests.sh linux   # plus core and community
python3 scripts/apply_patches.py patches <scratch copy of tmp/app.asar.contents>
# then: node --check on every patched chunk
```

**Final review.** One review covers the whole change across all repos. Run it on `fable` when 2+ of these hold, and on `opus` otherwise:
- the change carries risk-bearing semantics
- tasks shared files
- a ruling changed a design decision
- the change is over 500 non-test lines

A worker that ends without a report (the notification says none was delivered) is asked for it with SendMessage; never re-dispatch the work.

Weigh each finding against the live evidence. A reviewer's mechanism claim can be contradicted by a measured run, as finding 1 of the #299 review was. Record accepted findings as rulings in the spec.

## Phase 6 - ship

1. **Local build and live check BEFORE committing** (the maintainer usually wants to test first):
   - `build-local.sh` bundles pre-built bridges from `../computer-use/<bridge>/target/x86_64-unknown-linux-musl/release/` when present, without checking freshness. Rebuild them (`cargo build --release --target x86_64-unknown-linux-musl`) after any bridge change, and verify the sha inside the package.
   - Build only when the maintainer asks; they install (`sudo pacman -U ...`). Check that the running app started after the install before testing.
   - Run the Xvfb repro against `/usr/lib/claude-desktop/claude` in a worker.
   - Exercise Computer Use in a real **Code tab session**. A plain chat never gets `computer_*` tools on Linux, and its "computer use is off" answer is misleading. When the maintainer authorizes it (e.g. while AFK), a worker may drive the real logged-in app with the bundled x11-bridge: back up and restore the settings files, kill only its own processes, never signal Claude, and use a virtual display for anything it starts.
     - Start the app detached (`setsid -f claude-desktop`), never under `timeout` or any wrapper that signals it. Make the maintainer restart the app after every reinstall (a running instance keeps the old asar). Before the first Code-tab turn, expect a "Sign in again" dialog after a long idle; ask the maintainer to log in, do not retry.
     - Multi-monitor, display names and compositor-vs-toolkit string differences (window titles, app ids) only show up live; the harness cannot. Plan one rebuild round for what the live run finds.
     - Bridge-level VM runs (KDE, Hyprland) need no login and are worth it when a backend's coordinate math has only run on a private bus. Run them in parallel with the host test.
   - Read `~/.config/Claude/logs/claude-patches.log` afterwards to confirm the exact argv or path.
2. **Bridge repos first.** That covers `patrickjaja/{wlroots,x11,gnome,kwin-portal}-bridge` (local checkouts usually sit next to this repo, e.g. `../computer-use/<bridge>`). CI fetches bridge HEAD from GitHub, so push the bridges before the main repo. A new shared crate goes first of all: bridges can only pin its git rev after it is pushed. Auto mode blocks pushes as external writes even after the maintainer's go; commit locally, then hand the maintainer one `! git -C <repo> push ...` line per repo.
3. **Main repo.** Commit to `master` per `/commit-fast`. A push rejected because CI committed README versions or the Nix hash is safe to `git rebase origin/master` and push again; check that the CI commits touch other files first. Reference the issue numbers without closing keywords, so the issues close with the release comment instead.
4. **Release:** `gh workflow run build-and-release.yml --ref master -f force_rebuild=true` (or `/deploy force`). Watch the run in the background with `gh run watch <id> --exit-status`, then confirm the tag with `gh release view v<ver>-<n>`.

## Phase 7 - close the loop with the reporter

Use the `/comment` voice for every comment:
- one per issue
- a fix comment is two or three sentences: thanks, what now works (and any new switch, by its menu path), the release. No bullet lists, no rationale, no edge cases
- name the fix and the **release** in bold. The maintainer may want it posted while the release run is still going; then say the build is running and name the expected tag, and close the issue once the tag exists
- no blame on our patches
- no internals and no speculation
- for a new UI feature, attach screenshots with a rectangle around what is new. The maintainer wants them as attachments of the comment itself. `gh` cannot upload those, so a worker uses claude-in-chrome with the maintainer's GitHub session (check they are signed in first). GitHub's comment editor creates its `<input type=file>` only when its attach button is clicked, so neither `read_page` nor `file_upload` finds one: in `javascript_tool` wrap `HTMLInputElement.prototype.click` to capture the input instead of opening the native picker, then `file_upload` each PNG on it, wait for the `<img ... user-attachments/...>` line, and revert the wrapper. `upload_image` only takes browser screenshots; the computer tool cannot drag a host file. Release assets (`gh release upload` plus embedded URLs) are only a fallback; ask before using them. Check every PNG for personal data (names, avatar, sidebar, paths, other windows) before uploading.

**Asking for more data.** Only after local reproduction is exhausted: the maintainer dislikes round-trips with reporters, and a logged-in scratch instance (Phase 2) answers most timing and lifecycle questions here. Give one action plus one copy-paste command, and end with "empty output is fine too" when that is true. Never ask them to look for strings themselves. Never explain what each line would mean. `claude-desktop --diagnose` is the default collector, but never ask for it again when the thread already has one. Use a targeted `grep` only when the evidence is not in `--diagnose`, which does not include `claude-patches.log`.

**After posting:**
- Close fixed BUG issues with `--reason completed`.
- A FEATURE REQUEST stays open: once the tag exists, EDIT the fix comment (never add a second one) so it links the release and asks whether they have time to test it and report back, naming `claude-desktop --diagnose` as the thing to attach for anything that fails. Close it once they confirm or go quiet.
- Keep a bug issue open only if its comment waits on reporter data.
- Answer follow-up questions from reporters in one or two lines.

## Phase 8 - self-improve (always, last step)

Before reporting done, update **this file**: `.claude/skills/check-issue/SKILL.md`.

1. List what went wrong or cost time in this run. That includes a wrong assumption, a confusing comment, a rejected push, a tool trap, a maintainer correction, or a gate that fired late.
2. **Fold, don't append.** If a lesson changes how a phase should be done, edit that phase's text. Only lessons with no natural home go under "Lessons" below, as one dated line each.
3. **Prune.** Delete a Lessons line once its rule lives in a phase. Keep this file under ~200 lines, and merge or drop the weakest lines rather than growing it.
4. Never write session-specific values into the phases (minified names, pids, versions). Those go stale on the next upstream release.
5. If a lesson belongs to another skill (`/comment`, `/test-native`, `/linux`, `/deploy`), edit that skill instead and leave a pointer only if it is needed.
6. Tell the maintainer in one line what changed in the skill. The edit ships with the next `/commit-fast` like any other tracked file.

## Lessons

- 2026-10-26 (#297-#299): an upstream reload that "should" run after a watchdog crash request was lost in live runs. Prefer guaranteed recovery over avoiding a duplicate reload, and measure before accepting a reviewer's claim about the mechanism.
- 2026-10-26: when a renderer is resumed after upstream's crash request, it executes the queued crash. Do not make "a resumed renderer must survive" an acceptance criterion.
- 2026-10-30 (#305): `nativeTheme.shouldUseDarkColors` follows Claude's own Appearance setting (upstream sets `themeSource` from it), not the desktop or panel. Anything "theme-aware" on Linux is only desktop-aware with Appearance = System; offer a switch for the mismatch instead of guessing the panel color.
- 2026-10-30 (#305): when a refresh hook calls into upstream code, call upstream's own wrapper (crash containment, retries) rather than the inner function it wraps.
- 2026-11-02 (#293 round 8): upstream main has no task-end signal for cloud Cowork sessions; the page's `releaseRemoteCuLock` is view-scoped and the model's `computer_release_lock` is optional. The server's `worker_status` (upstream's own `refreshRemoteChromeSessionMode`, cookie-authenticated) flips to idle with the `result` event; poll it instead of guessing with a timer.
- 2026-11-10 (#319): when a live run on the new build shows odd behaviour (a dialog, a hotkey that does not arm), run the released build through the same steps before calling it a regression; two of three KDE observations were already there. A change to the window identity also changes the portal app id on KDE (shortcut component, one confirmation dialog per profile).
- 2026-11-10 (#323): harnesses that spawn fake child processes must kill them and remove their temp dirs on exit and on signals; reviewers found orphans after interrupted runs. Workers' `rm` in shared /tmp can be denied: have them register cleanup in the harness instead.
- 2026-11-10 (#319): tell a host live-check worker up front that the maintainer may log in to an instance it started, so it never quits one; a later message can arrive after the quit. Do not run the full feature suite while other heavy runs are going: one harness flaked under load.
