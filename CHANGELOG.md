# Changelog

All notable changes to the claude-desktop-extra packages will be documented in this file.

## 2026-09-04

### Upstream bump to Claude Desktop v1.46388.2

Anthropic's v1.46388.2 re-minified the bundle: string literals are double-quoted again instead of
backticks, and the second chunk family (`index2.chunk-*`) is gone - everything is `index.chunk-*`
once more. Five patches lost their anchors and are re-fitted; nothing was upstreamed and no patch was
added or removed (47 patches).

- **Computer Use** (`fix_computer_use_linux`): the seven tool-description rewrites were anchored on
  backtick literals and now accept either quote style. The two availability gates gained an
  upstream Cowork HIPAA compliance check; the Linux path now honours it too, so an org compliance
  lock disables Computer Use on Linux exactly as on macOS and Windows. Upstream also denies every
  tool call under a compliance lock; the non-KDE Linux dispatch, which runs before that check, now
  applies the same per-call deny with upstream's message, so a compliance change mid-session stops
  tool calls exactly as on macOS and Windows (new harness `scripts/tests/linux/test-cu-hipaa-deny.mjs`).
  The `open_application` description became a plain string, so its Linux wording is concatenated
  instead of interpolated.
- **Files quick open**: the worker-host fork site is matched with either quote style; the env
  passthrough that carries the feature switch to the file-index worker is unchanged.
- **Native title bar**: upstream turned the titleBarOverlay style helper into a function taking
  `main`/`popout`; the background capture follows the new declarator shape.
- **Dock bounce**: `requestUserAttention` now returns a boolean that callers chain, so the Linux
  guard returns `false` ("nothing flashed") instead of falling through.
- **Renderer-gone log**: upstream turned the suppression into two early returns; both now log
  `Main webview render process gone (suppressed)` before returning, so a silently swallowed
  renderer death stays visible in main.log.

The 2026-08-30 v1.40609.0 release was auto-released and never hand-audited, so the catalogs below
cover two releases:

- **Feature flags**: the GrowthBook override template grows from 225 to 291 catalogued flags (66
  added, 12 removed). The static merger swapped `epitaxyMcpApps` and
  `chillingSlothSshWorktreeLocation` (now static) for `sideSessions` and `wslForkSession`. Notable
  new flags: multi-account, Code session keep-awake, side sessions, terminal scrollback, file
  checkpointing. `enable_local_agent_mode` needed no change.
- **Deployment panel**: the managed-settings key catalog grows from 117 to 143 keys, matching the
  bundle's zod schema and the 3P setup SPA. New groups include the network egress proxy, Entra ID
  sign-in, Microsoft 365 add-in policies and the built-in browser domain policy.
- **Built-in MCP**: three new internal servers (`ccd_session`, `ccd_pr`, `ccd_sidebar`) and new
  session hand-off / PR monitoring tools; none is platform-gated.
- **Platform gates**: no new Linux-blocking gate and no new native module. New capability keys
  `codeSessionKeepAwake`, `computerUseComplianceGate`, `multiAccount`, `sessionMentions` are
  supported on Linux; `popoutTitleBarOverlay` is unsupported only under Wayland. Claude Code's
  sandbox now needs `bubblewrap` on Linux when a managed egress or workspace policy requires it.
- **ion-dist**: the 3P setup SPA patch still hits its two sites (Linux org-plugins mount path).

Also fixed: `scripts/validate-patches.sh` aborted on the first failing patch instead of reporting
all of them (`set -e` swallowed the exit status of the nim branch).

## 2026-08-30

### Files quick open (new community feature)

**Ctrl+P over the Files panel.** A new opt-in switch in Settings → Extra → Community Features adds a
VS Code-style quick-open box to the Code tab: type part of a file name, move with the arrow keys or
the mouse, press Enter and the file opens as a tab inside the Files panel (the same path a click on
the tree takes); `name:42` opens at a line, and an empty query lists recently opened files. The box
asks Anthropic's own file index, so results and highlighting match the panel's filter and the
composer's `@` picker. It stays out of the way of a focused terminal.
If the panel is open but its file tree is collapsed, Ctrl+P presses Anthropic's own "Show file tree"
button first and opens the box as soon as the tree is back - that is also the only state in which the
panel exposes no way to open a file at all. The box waits for the tree's *rows*, not just the tree,
and keeps looking for a few seconds: the panel paints the empty tree first, and the way in to opening
a file only exists once a row is on screen.

**Spaces in a file search now mean "and".** Anthropic's fuzzy file index treated a space as a
character to find, so `user service` returned nothing while `user-service` worked. With the
switch on, the index splits the query into pieces that must all match, in any order, and merges the
highlights - the way VS Code's quick open scores multi-word queries. This reaches the Files panel's
filter and the `@` picker too. Off leaves the index exactly as shipped.

**Multi-word results are ranked by file name.** The pieces of a multi-word query are matched
separately, and merging them by the index's own per-piece ordering put whole directories above the
file being looked for - `user service` led with three unrelated sibling folders and
`user service spec` did not show `user-service.spec.ts` at all. Matches are now scored the way
VS Code scores them, on the file name first and the folder only as a fallback, with short names and
shallow paths preferred. Which files match is unchanged - only their order.

The switch reaches the index through an environment variable, and Electron hands a utility process
the app's *initial* environment unless the fork asks for the current one - so a patch now makes
Anthropic's worker host pass the live environment explicitly. Without it the switch was set in the
main process and never seen by the index. It still applies to file-index workers started after the
switch flips (a running one keeps what it was born with until it restarts, or the app does).

**The panel no longer has to be open first.** Ctrl+P works with the Files panel closed: it
opens the panel through Anthropic's own session menu, waits for it, and opens the file you pick.
The panel is only ever opened when there is none, because that menu entry is a toggle and
pressing it with a panel already open would close the one the feature needs. The handler files
are opened through is found by descending from the panel rather than by walking up from a tree
row, so it is found whether or not a single row has rendered yet.

Three patches (`add_feature_files_quick_open`, `_bridge`, `_worker`), three test harnesses, and a new
`baseline/FILES_QUICK_OPEN_ANCHORS.md` with the remote-DOM anchors the box depends on.

Contributed by [@dels07](https://github.com/dels07) in [#238](https://github.com/patrickjaja/claude-desktop-extra/pull/238) - thanks!

### Feature test harnesses can no longer stall the pipeline

A harness that wedges now fails its own suite instead of the whole job. One of them held the runner
open until GitHub's 6h workflow timeout killed it, twice - a stall that reports nothing and looks
identical to "still running".

The cause is specific. The quick-open DOM suite is the only harness that loads its fixture over
loopback HTTP rather than `file://`, because the page module arms Ctrl+P only under a real
`/epitaxy` path. A pending network fetch pauses headless Chrome's virtual clock, so
`--virtual-time-budget` never expires and `--dump-dom` never fires: against a server that accepts a
connection and never answers, a 2.5s budget was measured still running at 45s. A `file://` load
cannot stall that way, which is why no other harness could burn a job - and with no timeout on the
browser call, the wedge was unbounded.

Every harness now runs under a wall clock (`FEATURE_TEST_TIMEOUT`, default 600s) and a timeout is
reported as a named failure, and the quick-open suite bounds each browser launch and names the
scenario that hung.

The suite that wedged no longer touches the network at all. It was the only one serving its fixtures
over loopback HTTP, because the quick-open hotkey arms only under an `/epitaxy` path and a local file
cannot have one; a pending network fetch pauses the browser's virtual clock, so the page dump never
happened. It now loads fixtures as plain files like every other suite, and the page script accepts
its route from an attribute when (and only when) it is running from a local file, which the real app
never is. Reproduced and fixed: with networking removed, the old suite cannot run and the new one
passes in full.

Each suite also runs under a wall clock now, and reports a timeout as a named failure rather than
holding the job open.

### Files quick open: three correctness fixes

Found while reviewing the feature against the shipped build.

**A query of five or more words no longer depends on the order you type them in.** Words past the
fourth were being glued together into one, which silently reimposed an order on them: for
`modules/user/src/domain/user-run/factories/user.service.ts`, `modules user domain service factories`
found nothing while the same five words as `... factories service` found the file. The cap now bounds
the index scans, not the words, and the extra words are applied afterwards as a filter, so all of
them still have to match and the order never matters.

**An IME composition no longer opens the wrong file.** Enter, Escape and the arrow keys belong to the
input method while a candidate is open; the box was acting on them, so committing a word could open
whatever file happened to be selected and close the box mid-word. It now leaves composing keys alone.

**Holding Ctrl+P no longer strobes the box.** A held key auto-repeats, and Ctrl+P is a toggle, so the
box opened and closed many times a second and re-drove the panel menu with it.

## 2026-08-26

### Claude Desktop v1.37937.0

Rebased on the official v1.37937.0 Linux `.deb` (bundled Electron 42.10.0, up from 42.9.2). Two
patches needed re-fitting after the re-minify; everything else applied unchanged, and the
Linux-compatibility, platform-gate, ion-dist and built-in-MCP audits all came back clean - no
feature moved behind a new macOS/Windows gate, and no new native module was added.

**The feature merger anchor no longer depends on its neighbour.** `enable_local_agent_mode` finds
the async capability merger - the function whose overrides turn on Code, Cowork and Computer Use for
Linux - and appends our six capability overrides to it. It used to locate the merger by matching its
closing `}}` followed by `;` or `,`. That trailing character was never part of the merger: it is
whatever separator the minifier happened to emit for the *next* statement, and in v1.37937.0 it
became `var` (`...p}}var hB=null;` where v1.34493.1 had `...l}},fR=null;`), so the patch stopped
matching. The patch now matches the merger structurally and then *verifies* the match: the spread
callee must be the static feature registry, proven by its body listing `quietPenguin:`. A generic
shape plus a domain assertion is both more robust across re-minifies and harder to land on the wrong
site than a tighter regex hung on an incidental character. The sub-patch also gained a proper
idempotency branch that checks for its own injected overrides.

**The renderer-death log survived a second `let` declarator.** `fix_renderer_gone_suppressed_log`
logs main-webview renderer deaths that the upstream handler decides to swallow (#128). Its pattern
spans a `let` statement interposed in the handler, which upstream widened from one declarator to two
(`let i=ONt(),a=hOt();`). The capture now accepts a comma-separated run of call-initialised
declarators.

### Feature flags

The catalog in `claude-desktop-extra.jsonc` tracks every GrowthBook flag observed being read from
the feature store, so users can force one without a patch. It moves from 203 to 225 entries: 23
added and one removed. The removed flag, `3673327456`, gated host-RAM-tiered Cowork VM memory
sizing - the whole mechanism is gone upstream, though the `vmMemoryGB` and `vmCpuCount` preferences
remain.

The capability registry grew from 59 to 62 entries. Three of the four new capabilities
(`sessionFolderFileAccess`, `spawnTaskPendingPop`, `chillingSlothSshWorktreeLocation`) carry no
platform gate and work on Linux as shipped; the fourth (`violinBowHomeSettings`) is hardcoded off on
every platform. `parkaMeetings` was removed upstream; it had been dev-gated and macOS-13-only, so it
was already inert here.

The `plugins` built-in MCP server gained a `search_connectors` tool. It is gated on 3p mode only,
with no platform check, so it is available on Linux.

### Panel tabs verified against live claude.ai

The tab bar and the diff-scope dropdown bind to DOM that claude.ai serves remotely, not to anything
in the desktop bundle: `.epitaxy-view-panel` and the `tileId` fiber prop appear zero times in
v1.34493.1 and zero times in v1.37937.0. A desktop bump therefore cannot break them, and equally
cannot prove them healthy - only a claude.ai redeploy moves these anchors, which is what broke them
before.

The check that does work is the `[cdb-tabs]` drift warnings, and they land in
`~/.config/Claude/logs/claude.ai-web.log` (the page-context log), not in `claude-patches.log`. Every
recorded drift warning predates the fix that went in on 2026-08-22, and none has fired since across
subsequent sessions in which the page code demonstrably ran. The anchors are holding.

### Deployment panel: eight new managed-settings keys

Settings -> Extra -> Deployment renders a catalog pinned to the bundle's own schema, so a key
upstream adds is one users cannot set from the panel. Upstream added eight and removed none, taking
the catalog from 109 to 117: `inferenceModelPricing`, `inferenceModelPricingEnabled` and
`inferenceModelPricingMultiplier` (a USD cost estimate on the Usage page, with per-model rates and a
scaling factor), `mcpToolTimeoutSec` (a per-call MCP tool deadline), `organizationInstructions` (org
text appended after the app's own system prompt), `skipWebFetchPreflight` (drops Claude Code's
per-domain blocklist lookup, for sites where that host is firewalled), and
`userPluginMarketplacesEnabled` / `userPluginUploadsEnabled`.

The multiplier is a fraction between 0 and 1, which none of the existing field types could express -
the integer type rejects `0.85` and the text type would write a string upstream's number validator
refuses - so the panel gained a `num` field type. `organizationInstructions` now carries an enforced
3000-character cap matching upstream's own limit. That matters more than a tidier error message:
`managed-settings.json` is validated as a single object, so one out-of-range field can invalidate
the entire file rather than just that key.

The five new macOS `process.platform` gates are a single cluster: iCloud/File-Provider
cloud-placeholder handling, which detects an undownloaded file by `st_blocks == 0` and reports
"open it in Finder to download it first". There is no Linux analog - Drive on Linux is a FUSE mount
that hydrates on open - so Linux correctly takes the plain-read path. Nothing to patch.

## 2026-08-24

### Bringing the window back to the front now works again (#233)

`fix_dock_bounce` exists to stop the taskbar demanding attention on KDE and GNOME - what upstream's
macOS dock bounce turns into on Linux. It did that by overriding six Electron methods whenever no
Claude window was focused, two of which mattered a lot more than intended:
`BrowserWindow.show()` silently became `showInactive()`, and `BrowserWindow.focus()` became a no-op.
If the window was already visible, `show()` became a no-op with no fallback at all.

Every path that reveals a hidden window runs precisely when nothing of Claude is focused - the tray's
"Show App", launching the app while it is already running, and our own Computer Use teach-mode
restore - so all of them were being swallowed. The patch is now scoped to the attention APIs it was
written for (`flashFrame` and `requestUserAttention`); `show`, `focus`, `moveTop`, `app.focus` and
`webContents.focus` are back to stock Electron behaviour.

### The autostart entry now points at the launcher

Upstream builds the "Start at login" entry as `Exec=<bundled electron> --startup`, bypassing our
launcher entirely. A login launch therefore started with none of its setup: no
`--ozone-platform=wayland` (so on a Wayland session the autostarted instance came up under XWayland
while a manual launch was native Wayland), no `GlobalShortcutsPortal` feature flag, no PATH repair
(Cowork could not find qemu), no `--password-store`, no systemd scope, and for a named profile no
`--user-data-dir` - meaning an autostarted named profile silently used the default profile's data.
The launcher now exports `CLAUDE_LAUNCHER` and `fix_startup_settings` builds the entry from it,
re-adding `--profile=<name>` when a profile is active.

### Launching the app shortly after login no longer opens it hidden (#233)

Session-restore detection used to key off one signal: if the graphical session had started less
than 60 seconds ago, the launch was treated as a restore and the main window was created hidden.
That caught the case it was written for - gnome-session relaunches saved clients without
`--startup`, so "start in system tray" was ignored on every login - but it also caught anyone who
simply clicked the launcher icon shortly after logging in. They got a tray icon, no window, and
`born_hidden_reason: 'os_login'` in the log, and had to click a second time to get in.

The heuristic now requires two conditions instead of one: the session must be young **and** an
enabled XDG autostart entry must exist, meaning the user actually asked for a hidden start. Someone
with autostart switched off is never suppressed. Every error path - missing entry, unreadable
socket, no `/run/user` - falls back to showing the window, since a wrongly hidden window is
invisible and hard to report while a wrongly shown one is a minor annoyance.

The predicate moved out of the patch into `js/startup_session_restore_gate.js`, where it is
syntax-checked and unit-tested (`scripts/tests/linux/test-startup-gate.mjs`, 10 checks covering
both users, X11 and Wayland, absolute `WAYLAND_DISPLAY` paths, `XDG_CONFIG_HOME`, and the
fail-safe direction). It also records its decision as a `[startup-gate]` line in
`claude-patches.log`.

### New: activation diagnostics

Launching Claude while it is already running hands the request to the running process, which is meant
to reveal and focus its window. Upstream logs nothing whatsoever on that path, so when the window
does not come back there is no evidence to work from. `fix_second_instance_diag` records the received
argv and cwd, whether Chromium forwarded an `--xdg-activation-token` (the Wayland raise depends on
one, and the bundle never reads one itself), and each window's visible/focused/minimized state,
geometry and display - before the reveal, right after it, and again at +500 ms and +2 s. It also
names the case where the request arrived before any window existed. Output goes to
`~/.config/Claude/logs/claude-patches.log`. Behaviour-neutral, and it hooks only a public Electron
event, so there are no minified anchors to re-fit on an upstream bump.

## 2026-08-22

### Claude Desktop v1.34493.1

All 43 patches apply. Only one needed re-fitting - `add_growthbook_overrides` (below) - and the full audit came back clean: no new darwin/win32 gate lacks Linux support, no new native module, Electron stays 42.9.2, and the four bundled native artifacts are byte-identical. Upstream still ships no native Linux Computer Use executor, so our CU patch stays load-bearing.

Notable upstream additions, none of which intersect our patch sites: SSH remote sessions with reattach, Design PDF export (a new `designWindow.js` preload), an Artifact "host tools" MessagePort bridge, Claude in Chrome local pairing / Remote Control, scratch workspaces and worktrees, workspace cwd-trust prompts, and scheduled-task folder grants. Local PR creation was removed from the desktop app in favour of a cloud-session path. The dangerous-switch startup blocklist grew from 2 entries to 16 (`--disable-web-security`, `--ignore-certificate-errors`, …) - none of our launcher flags collide, but a user passing one of those now gets a hard exit with a message on stderr.

Two features worth knowing about that stay macOS-only by construction: **watch-record** (the "show Claude how to do it" demonstration recorder) grew from a stub into a full Electron-side controller, but its `InputRecorder` provider is pruned to `Promise.resolve(null)` in the Linux bundle, so widening its platform gate would achieve nothing - a real port means writing a global input recorder from scratch. `violinBow` is hardcoded unavailable on every platform. The new `coworkThinkingInSend` capability is unconditionally supported and works on Linux as-is.

Baselines re-validated: feature flags (+14/-2 flag IDs, registry 57 -> 59, all three override layers intact), built-in MCP (the `ccd_directory` server gained a `change_directory` tool), ion-dist (partial rebuild, both `fix_ion_dist_linux` targets still found by content signature), platform gates (darwin 88, win32 147, linux 20). The managed-settings deploy catalog gained `claudeInChromeEnabled` (109 keys).

Correction to the v1.32885.1 notes: `bootPlaceholder` was **not** removed - it is still a registry entry and a zod key, carrying `{status:"unsupported"}` in both builds.

### Computer Use no longer freezes the app when the GNOME portal bridge stops answering (#232)

Reported on Ubuntu 26.04 / GNOME Wayland: Computer Use locked the whole app until the OS offered "Force Quit or Wait". The bridge itself was not answering, but what turned that into a freeze was ours - every bridge call on the capture and input paths was a blocking `execFileSync`, and a failed `session-start` left no memo, so each action re-paid the full bill: `screens` (15 s) + `session-start` (30 s) + the command itself (30 s), and the next click did it all again.

- **The screenshot path is async end to end.** It was already an `async` function awaiting an `async` caller, so nothing was gained by blocking - it now uses `execFile` throughout and cannot stall the main process at all.
- **A failed portal session is latched for 60 seconds.** Input and capture fail immediately with a message naming the portal and pointing at the bridge command to run by hand, instead of blocking on a session that just failed. A fresh Computer Use lock clears the latch, so a real retry - consent dialog and all - still happens on the next user gesture.
- **The synchronous session-start backstop is capped at 8 s** (was 30). It only fires when a portal command beats the lock hook; waiting out a consent dialog belongs to the async lock path, which keeps the full 30 s budget. One failed click now costs at most 8 s of blocking, once, instead of two minutes, repeatedly.
- **No x11-bridge fallback on a covered Wayland session.** Under a rootless XWayland server the X root window holds nothing, so `zoom` there can only answer `BadMatch` - which is exactly the confusing error the report ended on. The covered cascade now goes straight to the `desktopCapturer` last resort, matching what the diagnostics line has always advertised. Exotic (uncovered) Wayland compositors keep their x11-bridge tier.
- An empty bridge monitor list is now called out in the log, because it means the capture region is sent in global coordinates with no `--display` - wrong on any multi-monitor layout.
- `claude-desktop --diagnose` gains a GNOME Wayland section: GNOME Shell and PipeWire versions plus a timed, portal-free `gnome-portal-bridge screens` self-test. There was only a KDE self-test before, so a GNOME report could not show whether the bridge worked.

New harness `scripts/tests/linux/test-cu-nonblocking.mjs` (18 assertions) pins all of it against the real executor with `child_process` stubbed - the screenshot path spawning nothing synchronously, the latch costing zero spawns, the exotic-Wayland tier surviving, and the sync budget staying click-sized. `scripts/tests/linux/` is a new third test category.

### Packages are ~5 MB smaller

v1.34493.1 ships a V8 bytecode compile-cache inside `app.asar`. We patch two of the three files it covers, so 5.04 MB of the 5.05 MB is guaranteed rejected at load - dead weight in every artifact plus a pointless read at startup. The build now drops it before repacking. V8 validates the cache against the source and recompiles on mismatch, and upstream already handles the directory being absent, so nothing changes at runtime.

### add_growthbook_overrides re-fitted for Claude Desktop v1.34493.1

Upstream reshaped the features-store setter: it now takes a second (source/status) parameter, drops the dirty flag, and routes the stored value through the deployment-mode hardcoded-features filter, which used to be a separate load path calling the setter. Sub-patch B now wraps that transform call instead of reassigning the raw parameter, so overrides still apply to the map that is actually stored - the same layering as before (user override > any rollout). Anchor unchanged: the `[growthbook] loaded %d features (%d changed)` log line.

Contributed by [@dels07](https://github.com/dels07) in [#231](https://github.com/patrickjaja/claude-desktop-extra/pull/231).

## 2026-08-21

### Two community-feature fixes: panel tabs revived after a remote claude.ai redeploy, diff-scope dropdown no longer leaks into other panels

Both breaks were in the remote claude.ai page (epitaxy), so they arrived without any desktop release. Diagnosed live over CDP against a running 1.32352.1 install.

- **Panel tabs stopped rendering entirely.** A remote redeploy put an `aria-hidden="true"` `.epitaxy-view-panel` ghost node (no `[data-pane-root]`, no fiber `tileId`, no chrome) inside the chat column's `.tiles-shell`. The chat-column discriminator required every shell to be empty, so it failed each frame, warned `no-chat-column`, and the tab bar never armed. Fix: an aria-hidden view panel no longer counts as shell occupancy (`chatLooksRight` in `panel_tabs_page.js`, and the harvester's `.epitaxy-view-panel` fallback in `panel_tabs_harvest.js` skips ghosts too). A non-hidden view panel still disqualifies, so the decoy defense is unchanged. The DOM suite's chat fixture now ships the ghost, plus a new `ghost-decoy` scenario (380 assertions).
- **The diff-scope dropdown (Working tree / Branch changes / Latest turn) mounted in the browser and Files panels.** With a non-working scope applied, an empty in-app browser tab ("New tab", no iframe mounted yet) passed every gate of the empty-diff fallback (`qualifiesAsEmptyDiffView`): non-working mode, real `.epitaxy-view-panel` wrapper, and nothing for the negative terminal/browser surface check to match. Fix: a positive identity gate - the React fiber's `memoizedProps.tileId` must be `"diff"` before the fallback fires; a resolvable non-diff id is a hard no, while a null id (unreadable fiber) falls back to the old gates so the emptied-diff rescue survives a React internals rename. The same gate runs in the re-validation sweep, so an already-leaked dropdown is removed on the next sweep. New `leak` DOM scenario pins install-refusal, the dead-end rescue, re-validation stripping, and the null-fiber fallback (117 assertions).

`baseline/PANEL_TABS_ANCHORS.md` re-validated against the live page (A1 updated with the ghost exception). Patch count unchanged.

Contributed by [@dels07](https://github.com/dels07) in [#231](https://github.com/patrickjaja/claude-desktop-extra/pull/231).

## 2026-08-19

### Claude Desktop v1.32885.1 - zero patch changes; release healed after a CI infrastructure timeout

The v1.32885.1 auto-release (issue #229) failed on a transient GitHub artifact-upload timeout in the arm64 `.deb` job - the package itself had built, patched, and install-tested green. Rerunning the failed job released normally; all 43 patches applied unchanged, with no pattern fixes needed.

The full audit came back clean: no new darwin/win32 gate lacks Linux support, no new native modules, the built-in MCP roster is unchanged, Cowork VM probes are count-identical, and ion-dist re-verified (a partial rebuild - nearly half its chunks carried over byte-identical). The main bundle shrank ~730 KB because upstream replaced its generated per-method eIPC IPC boilerplate (~833 literal `.handle()` registrations) with a table-driven runtime builder - the channel wire format is unchanged and our suffix-matching diff-views hook survives by design, but this compact format also shrank some string anchors the audits count (grandPrix, VirtualMachinePlatform). Bundled Electron stays 42.9.2; renderer fonts switched from ttf to woff2 (new `@ant/typography` dep); the bundled Microsoft 365 MCP server gained a SharePoint search-excerpt-stripping security hardening.

What upstream added: static bootstrap-fetch auth headers plus a headers-helper script for 3P deployments (`bootstrapHeaders`/`bootstrapHeadersHelper`), an `autoContinueAtUsageLimit` setting (wait out the usage-limit reset and continue the session), a POSIX env-name sanitizer in the Claude Code spawn path (runs on Linux, drops malformed env names before spawn), OAuth `private_key_jwt` client assertions for enterprise MCP, friendlier SSH error classification, and the always-supported `coworkSeededSummon` capability (the `bootPlaceholder` stub was removed).

Kept in sync with the release: the Extra -> Deployment panel offers the two new bootstrap-header keys (108 keys total); the GrowthBook flag catalog gained 3 flags and lost 1 to a rename (191 entries: `751369921` renames the hybrid-detect latch, `2099281725` ssh-launch-preconnect, `1477483922` CCD SDK-snapshot staleness); baseline docs (feature flags, platform gates, built-in MCP, ION) re-validated - the platform-gate audit found zero new PORTABLE gates, and ION's platform-enum monitor check was fixed to be location-agnostic after the enum hopped shared chunks again.

## 2026-08-18

### Claude Desktop v1.32352.1 - seven patches re-fitted after upstream's bundler switch to Rolldown

The auto-releases for v1.32352.0 and v1.32352.1 (issues #227, #228) failed loudly as designed, on seven patches at once. All seven breaks trace to a single cause: upstream switched its JS bundler to Rolldown, which changed the minified output globally - callbacks passed as call arguments are now parenthesized (`.on(x,(e=>{...}))`) and non-ASCII characters in string literals are emitted as `\uXXXX` escapes instead of raw bytes. No anchor site was refactored away, removed, or upstreamed.

- `fix_computer_use_linux` (9 of 36 sub-patch anchors): re-fitted for both output changes (wrapped arrows plus escaped em-dash needles). Upstream still ships no Linux Computer Use input or screenshot backend - the patch stays load-bearing in full.
- `fix_quick_entry_cli_toggle`, `fix_quick_entry_ready_wayland`, `fix_quick_entry_wayland_blur_guard`: re-fitted for the wrapped callback arrows; the injected behavior is unchanged and all five quick-entry patches coexist on the new bundle.
- `fix_renderer_gone_suppressed_log`: upstream split the crash-handler condition into an early-return guard plus a second check, so the suppressed-crash log now covers both silent paths instead of one.
- `fix_utility_process_kill`: upstream hoisted its kill calls into a `killOrDeferToSpawn()` method but still never hard-kills; the patch now threads a signal parameter through that method and passes `SIGKILL` only at the timeout-fallback call site, as before.
- `fix_native_frame`: one sub-patch removed - it had been assert-only since v1.13576.0 (upstream's `setTitleBarOverlay` theme update is ungated) and only the minifier's new arrow style broke its match. The patch keeps its two real injections. Patch count stays 43.

The full audit came back clean: no new darwin/win32 gate lacks Linux support, no new native modules, the IPC handler set and the built-in MCP roster are byte-identical to v1.30096.1, the Cowork VM resources are unchanged, and ion-dist re-verified with only content hashes moved. Bundled Electron moved 42.7.0 -> 42.9.2. One new audit trap is documented in the baseline docs: Rolldown emits large numeric object keys unquoted, so a quoted-literal-only flag sweep falsely reports flags as removed.

What upstream added: a flag-gated Remote Control feature (other signed-in devices can start and drive Claude Code sessions on this desktop; the transport shells out to the system `ssh`), import of claude.ai and Chrome browsing data via `node:sqlite`, an `inferenceCredential` auth mode that lets gateway-served plugin marketplaces reuse the 3P bearer, deeper CDP-based control of the Cowork in-app browser, and a session-PR-ownership placeholder capability (unavailable on every platform).

Kept in sync with the release: the Extra -> Deployment panel offers the one new managed-settings key `relocateUncUserData` (Windows-only UNC-share relocation, inert on Linux; 106 keys total); the GrowthBook flag catalog gained 21 flags (189 entries), among them the Remote Control plumbing, two SSH-transport switches, and a browser-tools mouse-guard kill-switch; baseline docs (feature flags, platform gates, built-in MCP, ION) re-validated.

## 2026-08-14

### Claude Desktop v1.30096.1 - two patches re-fitted, fix_tray_dbus retired as obsolete

The v1.30096.1 auto-release (issue #226) failed on a transient GitHub API rate limit in the version-check step, before any patch ran. The local update run then surfaced the real breaks:

- `fix_computer_use_linux` (1 of 36 sub-patches): the grant-tier rework hoisted `allowedApps`/`grantFlags`/`userDeniedBundleIds` out of the CU tool-handler's options object into their own bindings feeding the new `grants:` tier lookup, which broke the screenshot-note seed anchor. The seed now tolerates interleaved simple declarations; the injection binds to the new names unchanged.
- `fix_tray_icon_theme`: upstream extracted the tray icon filename switch into a helper that returns (with a crash-retry fallback parameter), so the assign-and-break anchor got 0 matches. The patch now rewrites the `png` case's return expression; the Linux gap itself is unchanged upstream (a light desktop theme still gets the invisible icon without us).
- **`fix_tray_dbus` removed (43 patches now):** the destroy-and-recreate-per-update tray architecture it serialized is gone upstream - the tray updates in place via `setImage`, destroys only when the tray is disabled, and this release gained its own crash-containment wrapper. That wrapper split exposed the patch as broken: it async-converted the wrapper but injected its `await` into the still-synchronous worker, failing the post-patch syntax check while reporting all sub-patches green. With the race structurally gone there is nothing left to inject.

The full audit came back clean: the bundle consolidated from 339 to 104 chunks (no size growth), no new darwin/win32 gate lacks Linux support, no new native modules, the built-in MCP roster and Cowork VM probes are unchanged, ion-dist's patch sites re-verified, and Electron stays 42.7.0. Audit-recipe hardening from this round: bundle-wide greps must span `index.pre.js` plus both chunk families (`index.chunk-*` and `index2.chunk-*`) - a concat missing either produces plausible-looking but wrong counts (the baseline docs now say so).

What upstream added: session export/import as zip bundles (replacing v1.28929.0's local-session scan/import handlers), scheduled-task cron shapes with self-resume wakeups, tray crash containment with a forced-dark fallback icon, structured spawn-error telemetry, GrowthBook targeting by device class and RAM, and the Parka meeting-recording interface moved to its own IPC origin.

Kept in sync with the release: the Extra -> Deployment panel offers the two new OTLP managed-settings keys `otlpAuthMode` and `otlpHeadersHelper` (105 keys total); the GrowthBook flag catalog gained `1942337209` (local MCP version-negotiation kill-switch; 168 entries); `enable_local_agent_mode` dropped the vestigial `chillingSlothPool` override key; baseline docs (feature flags, platform gates, built-in MCP, ION) re-validated.

## 2026-08-12

### Claude Desktop v1.28929.0 - two patches re-fitted, one retired as upstreamed

The v1.28929.0 auto-release (issue #225) failed loudly as designed, on two anchors:

- `fix_computer_use_linux` (2 of 36 sub-patches): upstream reworded the desktop-shell hint ("To click on the desktop, ...") and added a win32-only "click-only" caveat as a second interpolation, and it changed the shell-grant predicate from `.some(...)` (a boolean) to `.find(...)` - the caller now reads `.tier` off the returned granted app. Our kwin-wayland branch now returns the matching plasmashell app object instead of a boolean, preserving the tier lookup.
- `fix_ion_dist_linux`: the 3P config SPA split the org-plugins `mountPath` data object and its platform-ternary consumer into two different chunks. The patch now locates each sub-patch's target file independently by content signature and patches every file that matches.

The shell-grant change is part of a new upstream permission-tier framework (`full`/`click`/`read` grants; on Windows, shell grants become click-only). Verified against the KDE flow: plasmashell is not in upstream's shell click-tier classifier, so KDE shell grants keep full tier, and our auto-grant path already produces `tier:"full"` grant objects - no behavior change for Linux Computer Use. The four bundled bridges sit below the executor CLI/JSON contract and are unaffected.

The full audit (platform gates, feature flags, IPC surface, built-in MCP roster, ion-dist) retired **one patch as upstreamed: `fix_computer_use_tcc`** (44 patches now). Upstream registers a ComputerUseTcc implementation on every platform - real TCC on macOS, a `not-supported` fallback elsewhere - via an eIPC mechanism that replaces any earlier handler, so our ready-time stubs have been dead code at runtime since at least v1.26832.0 and the "No handler registered" error the patch prevented can no longer occur. **Every other patch stays load-bearing**: upstream still ships no Linux Computer Use input or screenshot backend, and the built-in MCP roster and Cowork VM resources are byte-identical to v1.26832.0.

What upstream added: a local session importer (Claude Code CLI sessions, another local install, or a claude.ai export zip - 17 new IPC handlers, gated on the `localSessions` capability), a staged 1P/3P "hybrid transition" deployment switch with credential handoff, SSH-session force-reconnect, and immediate delivery of queued steered messages. The build toolchain moved to Electron Forge 8 alpha and Tailwind 4; bundled Electron stays 42.7.0.

Kept in sync with the release: the Extra -> Deployment panel offers the one new managed-settings key `modelPrefer1mContext` (103 keys total); the GrowthBook flag catalog in the config template was refreshed for v1.28929.0 (+7/-6 flag IDs upstream, plus 23 pre-existing hoisted-const flags earlier extractions had missed - the template now lists 167 flags, and a stale expected-count constant that made a drift diagnostic fire on every launch is fixed); baseline docs (feature flags, platform gates, built-in MCP, ION) re-validated.

### AUR is back - skip_aur dispatch flag retired

The AUR came back from its maintenance window (issue #218 follow-up), so this release pushes the AUR package again and it catches up automatically from 2026-07-31. The `skip_aur` workflow input added for the outage is removed from CI and the /deploy skill; the fail-fast AUR preflight stays.

## 2026-08-11

### Every release download is attested (#224)

Contributed by Kaj Kowalski ([@kjanat](https://github.com/kjanat)). The release job now publishes a GitHub build-provenance attestation for every release asset - tarballs, .deb, .rpm, AppImage, the pacman packages and repo database - before anything goes live, so `gh attestation verify --owner patrickjaja <file>` works on any download. The step is fail-closed ahead of all publishing: if attestation fails, the release aborts cleanly with every channel still on the previous version. The reproducibility probe now also reuses the release pipeline's own bridge binaries from its cache (restore-only) and prints its digest next to the latest release asset's, so probe and release attestations can cover the very same bytes.

## 2026-08-10

All three changes in this entry were contributed by Kaj Kowalski ([@kjanat](https://github.com/kjanat)) - thank you!

### Page-injection gates match hostnames, not substrings (#219)

The dom-ready injection gates for Diff views and Panel tabs matched `claude.ai`/`claude.com` anywhere in the URL string, so a foreign page with `?x=claude.ai` in its query also received the (inert) page script - flagged by CodeQL. Both gates now parse the URL: Diff views reuses its own strict origin allowlist, Panel tabs compares the parsed hostname and keeps any claude.ai/claude.com subdomain. The DOM test harnesses also share one HTML entity decoder now, decoding `&amp;` last - three of them previously decoded it first, which turned a literal `&lt;` in a test result into `<`.

### Panels get the icon size made for them (#220)

The official .deb ships the app icon at 16, 32, 48, 128 and 256 px, but the tarball carried only the 256 px one, so panels, window lists and notifications downscaled it. The tarball now mirrors the .deb's hicolor tree, and every package format (pacman, deb, rpm, AppImage, Nix) installs all five sizes.

### CI: a reproducibility probe, parallel tarball builds, and asar from the Arch repos (#222, #223)

A new `repro-probe` workflow builds the amd64 tarball twice on separate runners from one GPG-verified official .deb, fails unless the two are byte-identical, and publishes a GitHub build-provenance attestation for the probe's artifact when they match. It runs on manual dispatch and on pushes touching the tarball script, so it stays out of normal CI.

The release pipeline now builds the Computer Use bridges in their own job and fans both tarball builds out from it, so amd64 and aarch64 build concurrently (about five minutes off a release run). All GitHub Actions moved to their current majors. The build containers install `asar` from the Arch `extra` repo instead of cloning and building yay from the AUR - one unpinned fetch removed from the release supply chain, and several minutes off each container run.

### Two builds of the same .deb produce the same tarball, byte for byte (#221)

Entry order, mtimes, ownership, the gzip header and the pigz-or-gzip compressor lottery all leaked build-host state into the tarball, so a published artifact could not be checked against a local rebuild. tar now sorts entries, pins mtimes to the .deb's own timestamps (`SOURCE_DATE_EPOCH`) and zeroes ownership; compression is pinned to gzip with `-n` (`CLAUDE_ALLOW_PIGZ=1` opts local builds back into pigz for speed, at the cost of byte-identical output). `build-info.txt` gains `TAR_SHA256` and `SOURCE_DATE_EPOCH`, so a hash mismatch between two builds can be pinned on either the tree or the compressor. The uncompressed tar layer is deterministic outright; the `.gz` is byte-identical when built with the same gzip version.

## 2026-08-08

### Claude Desktop v1.26832.0 - upstream switched its minifier, 31 of 45 patches re-anchored

Anthropic's v1.25927.0/v1.26832.0 releases (issue #218) came out of a new bundler toolchain, and the auto-release failed loudly as designed. Three output changes invalidated most of our regex anchors at once: string literals are now backtick template literals (`` process.platform===`darwin` `` instead of `"darwin"`), the `"use strict";` prologue is gone from bundle heads (files open with a Sentry preamble), and the code-split bundle gained a second chunk family (`index2.chunk-*.js`, 130 files, next to 195 `index.chunk-*.js`).

All 31 affected patches are re-anchored with quote-tolerant patterns (`` ["`] `` character classes), so they survive either quoting style. The patch orchestrator and validator now stage both chunk families as one logical bundle. `fix_computer_use_linux` additionally lost its silent-failure path: a sub-patch that does not match now exits nonzero instead of quietly writing the file back unpatched.

Substantively this release is the same app re-emitted through a new toolchain: the capability map (36 `status:"unavailable"` entries), the built-in MCP server roster, the Cowork VM probe shapes and every stable feature anchor are count-identical to v1.24012. There is still no native Linux Computer Use backend, so all four bundled bridges stay load-bearing. Upstream did ship new native Linux pieces alongside: a `cowork-linux-helper` binary and a raw `smol-bin.x64.img` VM image (the Cowork VM path keeps maturing on Linux), plus a `chrome-native-host` native-messaging binary for the Claude browser extension.

**One sub-patch retired as upstreamed:** the `.deb` now bundles that `chrome-native-host` binary in `resources/`, exactly where the packaged app looks for it - so `fix_browser_tools_linux` no longer redirects the native-host path to the Claude Code host under `~/.claude` (that redirect existed only because the binary used to be absent from the official Linux build). Claude in Chrome now runs on upstream's own bundled native host; our patch still adds Chromium, Brave, Vivaldi and Opera discovery, the extension auto-install path and the DevTools opener.

The minifier switch also exposed one latent false success: `add_growthbook_overrides` anchored its injection on `"use strict";` via plain string search, and the only remaining occurrence of that string now sits inside a vendored template literal - the injection landed as inert string content while reporting success. It now prepends at the bundle head and asserts its own injected marker. The other head-injecting patches already used a safe prefix check with a prepend fallback and needed no change; all ten were verified together in orchestrator order, twice for idempotency, with `node --check` clean on all 326 re-split bundle parts.

### Settings → Extra → Deployment follows the new managed-settings schema

The key catalog now carries the six keys upstream added: `skillCreationEnabled`, `trustBootstrapDelivery`, `endUserAttribution` (renamed from all-lowercase `enduserAttribution`, which remains readable as a legacy key), the `inferenceGatewayOidcAuthFlow`/`inferenceVertexWorkforceAuthFlow` sign-in flow enums, and `updateViaUpdatesHost` (marked `@next` upstream, listed but not yet active).

### Gaming themes: all six spinners redrawn as retro pixel art

The gaming themes' loading spinners were flat single-color glyphs (and the Dragon Ball a flat orange blob). Each is now a proper two-frame pixel sprite in the spirit of its game, drawn from period references on a 14-21px grid: the four PlayStation button symbols orbiting in their classic colors, a Game Boy DMG with a blinking screen, a Final Fantasy Black Mage casting sparkles, Link swinging his sword, a Warcraft peon striking a gold pile, and a shimmering 4-star Dragon Ball. All of them stay flat-fill paths with the existing `flip` animation, so nothing changes in the renderer.

![The Black Mage spinner on the Final Fantasy theme](themes/ff/2026-08-08_22-23.png)

### Feature flag catalog refreshed for v1.26832.0

`claude-desktop-extra.jsonc`'s commented-out flag list gains 14 new flags (among them the CliGovernor `throttleEnabled`/`pressureEvictionEnabled` pair, a renderer crash-loop watchdog, and `resolveCloudBranch`) and drops 4 that upstream removed.

## 2026-08-07

### Settings → Extra: our switches and Anthropic's flags are now two separate pages

The **Features** page held two unrelated things: the handful of optional features this project adds, and Anthropic's own 134 rollout flags. They are now one page each.

**Community Features** holds our switches - Diff view modes, Panel tabs, Calm the Cowork glow, and the new Theme picker hotkey - and gains the same filter box the flag list has, so a growing list stays quick to search. **Anthropic Features** holds the upstream flag list, the per-flag overrides and the "changes require a restart" notice with its Restart now button, unchanged. Nav order is Themes, Community Features, Anthropic Features, Deployment. Like the other Extra pages, Community Features ends in a link to the config file behind it - the hand-edited `claude-desktop-extra.jsonc` wins over the switches per key.

The new **Theme picker hotkey** switch (config key `themePicker`, on by default) turns the <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> gallery off for anyone who wants that shortcut back for something else. The theme list in Settings → Extra → Themes is unaffected.

Nothing moves on disk: both `claude-desktop-extra.jsonc` (yours, wins) and `claude-desktop-extra.json` (written by the UI) keep the same keys in the same places.

### The Cowork glow switch named the wrong config file

When `coworkGlow` is set by hand, the switch locks itself and explains where the value came from - but it named `claude-desktop-bin.jsonc`, the filename from before the project was renamed. It now names `claude-desktop-extra.jsonc`, which is the file actually being read.

### The README is an overview again; the details moved into their own files

The README had grown to the point where finding out *what* the project offers meant scrolling past everything about *how* it works. It now carries a short teaser per feature and links onward.

The patch catalog moved to [`PATCHES.md`](PATCHES.md), one table per directory, with every description tightened to one sentence saying what the patch does and why you would want it - the mechanism it depends on stays documented in the patch source, which each row now links to. Custom Themes, Multiple Profiles, Quick Entry, Cowork setup and Feature Flag Overrides each moved into `docs/`, following the pattern Computer Use already used. Every README heading stayed exactly where it was, so existing links into the README still land on the right section.

Installation is now a list of collapsed per-distro sections - open the one you are on instead of scrolling past eight you are not. The badges at the top still jump straight to the right one. The hand-written table of contents is gone; GitHub's own outline button does the same job without going stale.

### Patches are grouped by what they are for

`patches/` was a flat directory of 45 `.nim` files where nothing distinguished a Linux bug fix from an optional feature. It is now three:

- `patches/linux/` (32) - Linux compatibility. Always on, nothing to configure.
- `patches/community/` (6) - optional features, each with a switch in Settings → Extra → Community Features.
- `patches/core/` (7) - always-on infrastructure the other two build on: the Extra settings pages, the theme engine, the flag-override mechanism, the multi-profile plumbing.

Patches still apply in basename order, so the split changes classification only, not behavior. `scripts/apply_patches.py` now pins the total in `EXPECTED_PATCH_COUNT` and refuses to run if discovery finds a different number - a patch cannot be added or lost without someone saying so. The README documents the recipe for adding a community feature.

### Feature tests are grouped the same way, and CI actually runs them

The ten feature test harnesses sat flat in `scripts/` and nothing ever ran them - they were manual tools, so a broken feature only surfaced after a release. They now sit beside the patches they cover, in `scripts/tests/community/` (5) and `scripts/tests/core/` (5), with the shared plumbing in `scripts/tests/lib/`.

A new `scripts/run-feature-tests.sh` runs them all, reports PASS / FAIL / SKIP per harness, and fails the run on any failure; `scripts/run-feature-tests.sh community` runs one group. Like `EXPECTED_PATCH_COUNT`, it pins `EXPECTED_TEST_HARNESSES` and refuses to run if discovery finds a different number, so a harness cannot go missing quietly. CI runs the script in the `lint-scripts` job, where the Nim patch binaries the tests need have just been compiled - on every pull request and every release. `scripts/validate-patches.sh` now delegates to the same script instead of keeping its own copy of the suite list.

### validate-patches.sh can finally exit green

The one patch whose target lives in the .deb's resources tree instead of inside app.asar (`fix_ion_dist_linux`) made every full local `validate-patches.sh` run end with a failure it could do nothing about. The script now resolves such targets against an extracted .deb tree (second argument, or the conventional `tmp/extract/` sibling) and validates the patch for real; without a tree it reports SKIP instead of FAIL. A healthy checkout now validates 55/55 with exit 0.

### CI: the smoke test no longer fails on its own cleanup

The smoke test could report a pass and then fail the job anyway: Electron's shutdown crashes in headless containers, and crash reporting kept writing into the temporary profile while the test was deleting it. Cleanup now waits for the process tree to end and retries the delete, and a cleanup hiccup can no longer override the test verdict.

### The Code tab's side panels can open as tabs instead of a split

Diff, terminal, browser, files, artifacts and background tasks have always shared the panel area as a fixed split, each one shrinking to make room for its neighbours. A new **Panel tabs** switch (Settings → Extra → Community Features → Layout) turns that into a tab strip instead: each panel gets the full width of the panel area. Open panels the way you always have - the app's own toolbar buttons and its **Session actions** menu - and each one arrives as a new tab. <kbd>Ctrl</kbd>+<kbd>1</kbd>-<kbd>9</kbd> jump straight to a tab, and closing one replays it through the panel's own close control, so panel teardown itself is unchanged. The chat column is unaffected.

Switching tabs shows and hides panels rather than rebuilding them, so **every panel keeps its state**: the diff panel's expanded and collapsed files are still expanded and collapsed when you come back, and the terminal keeps its scrollback and its size. Upstream's own layout is never rewritten to switch - the panels you are not looking at are still in it, just hidden - which is also why a switch is instant instead of taking the second a rebuild used to.

The consequence worth knowing: a hidden panel keeps running. A live preview goes on rendering and a browser tab goes on loading in the background, where closing a split pane would have torn them down. That is what makes them instant to come back to, and it costs some CPU for a preview that never stops moving.

**The chat/side boundary stays where you put it.** The panel area is sized as if it were a two-pane split - chat versus one panel - and that proportion is remembered per session, so opening or closing a panel no longer moves the boundary. Drag the divider between chat and the panel area to resize, exactly as before; where you drop it is where it stays, on every tab and after a reload.

The tab bar carries the expand control, at its right edge. Expanding spans the active panel across the window, and it **stays** expanded while you switch tabs, so you can flick between two panels at full width. Upstream discards the other panels while one is expanded, so the panel you switch *to* while expanded comes back fresh - collapse first if you want to keep where you were. With many tabs open the chips scroll sideways while the expand control stays pinned at the right edge, so it is always reachable.

Opening and closing panels does not disturb the layout. A panel the app has only just inserted is hidden before it can paint, rather than appearing as a second split for a few frames and then being tidied away, so the boundary holds still through the whole operation - measured at zero pixels of movement across every frame of an open and a close, where it previously jumped 165 px for around 90 ms each way.

Off by default, and off is a complete retreat: the tab bar and its styling are removed and upstream's real split layout is simply there again, because it was never replaced. Nothing you had open is lost. Only the active tab and the chat/side proportion are remembered per session - which panels are open is upstream's own record, so opening, closing or reordering panels in its UI is reflected in the tabs.

Because the Code tab is remote claude.ai code, the bar degrades rather than fights: if an update moves the internals it drives, it renders no bar and warns once, leaving the layout exactly as the app left it - and since it never rewrites that layout, the degraded state is just the stock split UI. Everything it reaches into is read-only: the only upstream controls it ever presses are the active panel's own close and expand buttons, and only when you press them. The anchors it depends on are inventoried with re-derivation recipes in `baseline/PANEL_TABS_ANCHORS.md`, which joins the per-release audit checklist.

Designed, built and hardened by [@dels07](https://github.com/dels07) in [#216](https://github.com/patrickjaja/claude-desktop-extra/pull/216) - thanks!

### Diff views: the scope dropdown no longer survives a panel swap

Upstream reuses a panel's chrome row when one panel replaces another in the same slot, and the diff-views scope dropdown installed on that row could survive the swap and appear on a view it does not apply to. Installed dropdowns are now revalidated against the row's current view and removed when it no longer qualifies. A pre-existing bug, found and fixed in [#216](https://github.com/patrickjaja/claude-desktop-extra/pull/216) because panel tabs made it easy to hit.

### Release pipeline: releases can skip the AUR during an extended outage

The AUR preflight added on 2026-08-03 did its job: when the AUR went into maintenance again, the v1.24012.11 auto-release (run 30868900341) stopped before publishing anything, keeping every channel consistent. The right call for a blip - but this maintenance window has lasted days, freezing all channels behind one that is down. The release workflow now takes a `skip_aur` dispatch input: the AUR preflight and push are skipped, every other channel (GitHub Release, pacman repo assets, Pages apt/dnf repos, README/Nix versions) publishes normally, and the AUR catches up automatically on the next non-skipped release, since the push diffs the PKGBUILD against whatever the AUR currently holds. Unattended auto-releases keep the default `false`, so the fail-fast preflight still guards them.

## 2026-08-03

### Launching from a panel or menu no longer freezes startx/xinit desktops

On a session started with `startx`/`xinit` instead of a display manager, launching Claude Desktop from a panel button or the applications menu suspended the entire desktop: the window mapped blank, nothing redrew, only the pointer and VT switching kept working. The desktop on such a session runs on a VT and shares one process group, and the app's Claude Code integration probes the user environment with an interactive login shell (`bash -l -i -c '... env'`). Bash's job-control init finds that shell in a background process group of its controlling terminal and raises `SIGTTIN` against the whole group - which on a startx session is xfce4-session, the window manager, the panel and everything else. Terminal launches were always fine, because there the launcher is the foreground job.

The launcher now detaches via `setsid` before exec, but only when it is genuinely a background job on a controlling terminal (`tpgid` exists and differs from `pgid`). Display-manager sessions (`tpgid == -1`) and foreground terminal launches (`tpgid == pgid`) are untouched - terminal users keep live output and Ctrl-C. On a detached launch the app's stdout/stderr now lands in `~/.cache/claude-desktop/stdout.log` (2 MiB rotation) instead of an unreadable VT, which also makes issue reports from menu-launched sessions possible. `CLAUDE_KEEP_TTY=1` restores the old behaviour.

Root-caused (down to the `wchan do_signal_stop` capture) and fixed by Marco Bucchiarone ([@Eresy](https://github.com/Eresy)) in [#213](https://github.com/patrickjaja/claude-desktop-extra/pull/213) - thanks!

### Release pipeline: an AUR outage can no longer half-deploy a release

The AUR push runs last in the release job, so when the AUR went down for maintenance (run 30741060085) the job died after the GitHub Release, pacman repo assets and README versions were already live - but before the Pages deploy jobs ran. Result: apt/dnf repos, badges and the AUR stayed one release behind while everything else advanced.

The release job now probes the AUR over SSH before publishing anything. If the AUR is unreachable, the run stops while every channel is still consistently on the previous version, and can simply be re-run once the AUR is back. The clone and push at the end additionally retry three times to ride out short blips in the window after the preflight.

### NixOS: pinned flakes no longer break - release tarballs are now immutable

`nixos-rebuild` against a pinned `flake.lock` could fail with a fixed-output hash mismatch through no fault of the user ([#214](https://github.com/patrickjaja/claude-desktop-extra/issues/214)). `package.nix` fetched the tarball from the version-only URL (`v1.24012.9/...`), and every re-release of the same upstream version overwrote that asset with the new build - 13 times for v1.24012.9 - invalidating the hash recorded in every flake.lock pinned in between.

`package.nix` now records the release the Arch way - `version` (upstream's, unchanged) plus a `pkgrel` counter - and fetches from that release's own tag (`v1.24012.9-14/...`), whose assets are written once and never touched again. The pipeline step that overwrote the base-tag tarballs is deleted. CI stamps `version`, `pkgrel` and `hash` together on each release, so a locked flake input now stays valid forever; updating remains the usual `nix flake update` away.

If you are currently stuck on the mismatch: `nix flake update claude-desktop-extra` (or `nix flake lock --update-input claude-desktop-extra` on older Nix) onto latest master resolves it.

### Version check: a transient GitHub error no longer misfires the gh-pages bootstrap

The badge-update step decided whether the gh-pages branch exists by piping `git ls-remote` into `grep`. When GitHub answered with a transient HTTP 503 (run 30801072411), the empty pipe read as "branch missing", the step bootstrapped a fresh root-commit repo containing only the badge files, and its push was rejected non-fast-forward - failing the run. The probe now retries three times and refuses to bootstrap when `ls-remote` itself fails, so only a genuinely absent branch triggers first-run setup.

### Computer Use executor: remaining probe/timing exec calls converted to argument arrays

The residual shell-string `execSync` calls in `js/cu_linux_executor.js` now run through `execFileSync` with argument arrays: the `systemd-detect-virt` VM probe, the `which`-based command cache, the `pgrep -x ydotoold` daemon check, and the ydotool hold-key `sleep`. None of these carried attacker-controlled input (the model-supplied paths were already converted 2026-07-13), so this is defensive consistency, not a vulnerability fix. The now-unused `_exec`/`_execBuf` shell helpers are gone.

Contributed by [@anupamme](https://github.com/anupamme) ([#212](https://github.com/patrickjaja/claude-desktop-extra/pull/212)) - thanks!

Post-merge follow-up: the PR also whitespace-split `COWORK_SCREENSHOT_CMD` into an `execFileSync` argument array, which would have broken quoted arguments and pipes in user templates (e.g. `grim -g "{X},{Y} {W}x{H}" {FILE}`). That variable is a user-supplied command template from the user's own environment - shell evaluation is its documented contract and carries no injection surface - so the follow-up commit restores it verbatim.

## 2026-08-01

### The Code tab's diff panel gets view modes - and stops comparing against the wrong branch

The diff panel had one view: everything between the remote default branch and your working tree. Committed work and uncommitted edits arrived in one undifferentiated list, so "what have I actually committed on this branch" and "what did Claude just change" were questions the panel could not answer.

A dropdown in the panel's own header row now switches between three scopes:

- **Working tree** - what the panel always showed.
- **Branch changes** - committed work only, from the fork point to `HEAD`.
- **Latest turn** - what changed during the most recent conversation turn, untracked files included.

Nothing is re-rendered. Rather than draw a second diff view, this rewrites the arguments of the app's own git IPC and lets the stock renderer draw every mode - so syntax highlighting, virtualized scrolling, theming and line comments work in Branch changes exactly as they do in Working tree. Refs are handed over as full SHAs, because the app resolves a name by trying `origin/<ref>` first and would otherwise turn `HEAD` into `origin/HEAD` and diff a commit against itself.

### The diff panel now finds the branch you actually branched from

Upstream takes the base branch from the remote default (`origin/HEAD`) and nothing else. In a repository whose default is `develop`, a branch cut from `master` is measured from whatever old commit `develop` and `master` last shared, so the panel lists files nobody on the branch has touched - and the breadcrumb names a branch the diff was never computed against.

Base detection now scores candidates - `origin/HEAD`, `main`, `master`, `develop`, `trunk` and the branch's own upstream - by how few commits separate each candidate's merge-base from `HEAD`, and takes the closest fork point. Nothing hardcodes a branch-naming scheme, and a repository whose default really is the closest fork point is left exactly as upstream had it. The breadcrumb is corrected with the comparison, so the label always names the branch the diff was computed against.

To pin a base by hand:

```bash
git config branch.<branch-name>.cdbBaseBranch master
```

Everything degrades to the stock panel rather than breaking, and each refusal is logged once with its reason. Git runs on fixed argument vectors in the directory observed on the session's own CLI spawn, never one supplied by the page, and every ref and path is checked before it reaches a command. A diff or file over 2 MiB is refused rather than served truncated: collection is killed mid-stream, so a partial patch presented as a complete one would be a wrong answer that looks like a right one.

### Latest turn keeps its snapshot per repository, and says so when it has none

Latest turn compares two `git write-tree` snapshots taken from a temporary index at each turn boundary - no commits, no stashes, no refs, and untracked files included. Snapshots are kept per repository, because the app spawns its CLI for other directories (plain `$HOME` among them) every few seconds.

When a repository has no turn recorded yet, the **Latest turn** entry is disabled and explains itself on hover - the menu does not offer a scope that would show you something else. Sending one message arms it.

### The diff view modes are opt-in, behind their own switch

Everything above is **off by default**. A **Source control** switch at the top of Settings -> Extra -> **Features** turns it on, and leaving it alone is the supported way to use this build: the feature reshapes a first-party surface - it rewrites the arguments of Anthropic's own git IPC and corrects the base branch the stock panel compares against - and that is worth asking for rather than assuming. A fresh install therefore behaves exactly like the official one.

Off is a genuine retreat, not a hidden control: no dropdown, a byte-for-byte pass-through, no base-branch correction (the breadcrumb names upstream's own base again), no turn snapshots, and every remembered mode reset to Working tree. Both directions apply live, with no restart.

The modes arm per repository, once a CLI session has been observed in it, so turning the switch on mid-session leaves the dropdown reading **Working tree** until the next message lands. That wait is deliberate: the file list and the content of each file in it are gated on the same fact, so the panel can never show one from the branch and the other from the working tree.

The setting is `diffViewModes` in `claude-desktop-extra.json`; "off" is the absence of the key, so only an explicit opt-in ever writes anything. Set it by hand in the `.jsonc` and the switch shows itself as locked rather than silently disagreeing with the file.

### Expand or collapse every file in the Code tab's diff panel

The diff panel opens one file at a time. A new button in the panel's own header row, between the scope dropdown and the ⤢/✕ controls, does the whole list at once.

Expanding is not a single sweep, and cannot be: the app fetches each file's patch lazily as it scrolls into view, and a file whose patch has not arrived has a disabled header that cannot be expanded at all. So one press expands everything already loaded and **stays armed** - files keep expanding as you scroll and their patches land. Press again to collapse everything and turn that off. Collapsing runs bottom-up on purpose: the app scrolls each file into view as it closes, so top-down would leave you staring at the bottom of the diff.

It never fights you. A file you collapse by hand stays collapsed, even while the button is armed. Changing the diff scope disarms it, so a large branch diff is never dumped open unasked, and closing the last open file by hand disarms it too - the button then reads Expand again rather than promising a Collapse it no longer offers. Closing the panel, or expanding it to fullscreen, tears the old instance down instead of leaving it running invisibly.

The button is a clone of its neighbouring control, so it inherits the panel's hover, focus ring and theme rather than approximating them, and its caret glyph comes from Anthropic's own icon font - but only after two checks agree it will actually draw: the font is loaded, and a canvas ink probe finds ink at **both** codepoints it can paint (the expand caret and the collapse caret). That font renders nothing at all for an unmapped codepoint, so a codepoint that shifts in a future release would silently produce an invisible button - and when the font is missing altogether, the browser substitutes one whose tofu box the ink check alone would read as success. Either check failing leaves the hand-drawn SVG in place.

Part of the existing **Diff view modes** switch (Settings → Extra → Features), still off by default. A new headless-Chromium suite, `scripts/test-diff-views-expand-dom.mjs`, covers placement, the ARIA contract, both press directions, sticky expansion, auto-disarm, and every teardown path (panel unmount, fullscreen, feature switch); a missing icon font is reported as an explicit SKIP rather than quietly shrinking the run. Also fixed a build trap found on the way: `patches/Makefile` had no `staticRead` dependency line for `add_feature_diff_views`, so editing its JS did not rebuild the patch binary - and `scripts/validate-patches.sh` piped this suite through `sed`, so it reported PASS on the pipeline's exit status no matter how many assertions failed.

Merged with one hardening on top: the dropdown's status query now refuses to run git in a directory nothing in the main process has vouched for - only the panel's own fetches and the session's CLI spawns make a directory queryable, so the remote page cannot use the status call to probe arbitrary paths.

Contributed by [@dels07](https://github.com/dels07) ([#211](https://github.com/patrickjaja/claude-desktop-extra/pull/211)) - thanks!

## 2026-07-31

### Settings → Extra → Deployment: a 1P/3P switch, and the whole 3P config as toggles

Third-party inference was a one-way door. Turning it on took a root shell to place `/etc/claude-desktop/managed-settings.json`, and getting back to a personal claude.ai login took knowing that deleting that file is *not* enough - the app keeps its own stored 3P config and boots from that, so the only way out was a launcher flag or hand-editing JSON in a directory most people never look at.

The new **Deployment** panel makes both directions a button. It has:

- **The mode switch.** `1P` / `3P`, showing what the running session is, what the next start will use, and which config source decided that. It writes upstream's own `deploymentMode` key, which overrides a stored 3P configuration - so a machine that got stuck in 3P is one click and one restart from personal again, with nothing deleted.
- **The configuration, as a form.** Every key of the managed-settings schema this build accepts, grouped the way upstream's own schema groups it: provider and credentials, model list, surfaces (Chat/Cowork/Code), workspace and egress allowlists, disabled built-in tools, connectors and extensions, plugins, telemetry, update policy, usage limits, branding, bootstrap. Booleans are switches, enums are selects, lists are one-per-line, and a key you never touch stays absent from the file so Claude Desktop keeps its own default. Provider-specific fields stay hidden until that provider is selected.
- **The stored configurations.** The panel edits the *applied* entry of the same store upstream's 3P Setup wizard uses, so the two show each other's values. Its *Active configuration* picker switches between them - and picking **None** boots 1P while leaving every file on disk.
- **A raw JSON editor** for anything the form does not cover, which rejects a key this build does not know instead of writing a file the app would then ignore whole.
- **Undo for everything.** Each set key has a `clear` chip, the mode switch has one that forgets the saved choice so the stored configuration decides again, and the section heading has a `clear all` (two clicks, because it throws work away) for a handful of toggles flipped by mistake. Clearing never deletes a configuration file - the entry stays listed and can be filled in again.

Everything is written to your own profile directory (`~/.config/Claude-3p/`, per profile), `0600` in a `0700` dir, using only files upstream already reads - so no `sudo`, and no patch to the app's startup path. Stored credentials are write-only: the panel can replace one but never displays it, and it will not hand one to the claude.ai page it renders in. Two keys stay read-only there and remain yours to deploy through the policy file: `disableDeploymentModeChooser`, which is precisely what locks a machine into 3P, and `managedMcpServers`, whose entries can start a process. A valid `/etc/claude-desktop/managed-settings.json` still wins over all of it; the panel says so and turns read-only.

Also in this release: **`betaFeaturesEnabled` no longer exists upstream.** If your policy file still carries it, remove it - one unrecognized key makes Claude Desktop discard the entire managed file. [docs/third-party-inference.md](docs/third-party-inference.md) documents the new route and this trap.

### Themes: Built-in and Community are one "Common" section

Whether a palette ships as a built-in or came from the community collection is a packaging detail, not something to pick a theme by - so the two sections are now one **Common** list, alphabetically, in both the Settings panel and the <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> picker. Your themes and Gaming are unchanged.

### The Extra panels link the config file behind them

Each panel ends in the file it is really about, as a link: click the path to open it in your editor, or the **folder** button to show it in your file manager. Files that do not exist yet open their containing folder rather than failing. Themes names the file a click there actually persists to, which depends on which of `claude-desktop-extra.jsonc` / `.json` exists; Features links the `.jsonc` - the file you edit by hand, and the one whose flag ids win over the panel. The page asks for a location by name and never sends a path, so it cannot ask the desktop to open anything but our own files.

## 2026-07-30

### The project is now claude-desktop-extra

The packages are renamed from `claude-desktop-bin` to **`claude-desktop-extra`**. The name says what the project does: the official Claude Desktop Linux build covers Debian-based distros only, and this project fills the gaps - Arch, Fedora, RHEL, NixOS and AppImage packaging - plus the extra features on top (Computer Use backends, custom themes, multi-profile, Quick Entry, and the growing Extra settings hub).

Upgrades are automatic on every distro:

- **Arch**: the new package carries `replaces=claude-desktop-bin`, so `pacman -Syu` swaps it in. The pacman repo section is now `[claude-desktop-extra]`; the old `[claude-desktop-bin]` section keeps working for the transition (the repo publishes both database names), and the package prints a one-line note if your pacman.conf still uses the old one. The install dir moves to `/usr/lib/claude-desktop`, the same path deb and rpm always used.
- **Debian/Ubuntu**: a transitional `claude-desktop-bin` package depends on the new name, so `apt upgrade` migrates in place.
- **Fedora/RHEL**: the rpm carries `Obsoletes: claude-desktop-bin`, so `dnf upgrade` migrates in place.
- **NixOS**: the flake gains a `claude-desktop-extra` attribute; the existing `claude-desktop` and `default` attributes keep working.
- **Config**: `~/.config/Claude/claude-desktop-extra.jsonc` is the config file now. On first start the app copies an existing `claude-desktop-bin.jsonc`/`.json` over automatically - themes and flag overrides survive, and the old files stay in place as backups.

Version numbers keep their `{upstream}-{pkgrel}` format. The `/deploy` skill now documents the rule (new upstream version resets pkgrel to 1; any re-release at the same upstream bumps it) and decides `force_rebuild` itself from what actually changed since the last release.

### The GitHub repository moved - and a compatibility mirror keeps old installs working

The repository is now [github.com/patrickjaja/claude-desktop-extra](https://github.com/patrickjaja/claude-desktop-extra); every documented URL follows it. The old `claude-desktop-bin` repository stays in place as a compatibility mirror for the transition: its Pages keep serving the APT and DNF repositories at the pre-rename URLs, its releases mirror the new repository's assets (so pre-rename pacman sections and AppImage self-updates keep resolving), and its flake re-exports the new one (so `github:patrickjaja/claude-desktop-bin` inputs keep evaluating). Upgrading migrates the APT/DNF repo configuration to the new URLs automatically; pacman users get the new stanza printed once. The mirror is fed by CI on every release and will be retired after the transition window.

### claude-desktop-extra is on the AUR

CI publishes the release PKGBUILD to the [`claude-desktop-extra`](https://aur.archlinux.org/packages/claude-desktop-extra) AUR package on every release, so `yay -S claude-desktop-extra` works alongside the signed pacman repo (which remains the recommended path).

### The Code and Cowork transcript follows a running response again

Watching Claude work meant grabbing the mouse. Partway through a response the transcript would stop following the output and simply stay where it was, and nothing brought it back except scrolling down by hand. In the floating side chat it was worse - that viewport is a few hundred pixels tall, so once it fell behind, the part you wanted to read was always off-screen.

The cause is how narrow claude.ai's own test is. Its transcript scroller decides whether to keep itself at the bottom by watching a 1px sentinel element with an `IntersectionObserver`, and it sets `overflow-anchor: none`, so the browser's own scroll anchoring does not step in either. Being at the bottom therefore means being at it exactly. Measured in a live session: park the transcript at the bottom, move `scrollTop` up by **3 pixels**, and it never follows again - content grew from 1280 to 3080 pixels while the scroll position stayed frozen at 641, stranding the view 1803 pixels behind the output. A 3px drift is not an edge case during streaming; sub-pixel layout, `scrollbar-gutter: stable both-edges`, a font finishing loading and `[contain:strict]` reflow all produce one.

`fix_epitaxy_autoscroll.nim` attaches our own stick-to-bottom to the transcript scrollers in both surfaces. It treats a band of a few lines as "at the bottom" rather than a single pixel, re-asserts the position on every content resize and mutation, and gives up following the moment you scroll up on purpose - wheel, touch and <kbd>PageUp</kbd>/<kbd>Home</kbd>/<kbd>↑</kbd> unpin synchronously, so a message arriving in the same frame as your gesture cannot yank you back down. Scroll back to the bottom and it resumes on its own.

This markup belongs to the remote claude.ai SPA rather than to the bundle we patch, so a claude.ai deploy can rename the anchors it keys on. It fails soft when that happens: the sweep finds nothing and the view behaves exactly as it does today.

Contributed by [@Felitendo](https://github.com/Felitendo) ([#209](https://github.com/patrickjaja/claude-desktop-bin/pull/209)) - thanks!
### The pulsing Cowork glow can be held still, for laptops and weak GPUs

The glow behind the Cowork hero never sits still. Its element carries `.cowork-hero-glow`, and claude.ai gives that class a single declaration - `animation: 3.2s ease-in-out infinite cowork-hero-glow-pulse`, whose keyframes swing opacity between 55% and 100%.

`infinite` is the part that matters on a laptop. The animation never ends, so for as long as a Cowork view is open the compositor is handed work every frame and the display pipeline never gets to idle - battery spent on decoration. An opacity animation is cheap while it is GPU-composited, but this is Linux, and our own launcher falls back to `--disable-gpu-compositing` on software/llvmpipe setups and to `--disable-gpu` outright when the GPU is blocklisted. In those configurations the glow is redrawn on the CPU for every one of those frames. Upstream's only escape hatch is `prefers-reduced-motion: reduce`, an OS-wide switch that flattens every other animation in the app along with it.

The **Features** panel under Settings -> Extra now leads with a **Motion** switch that holds the glow still. The interesting part is what "still" has to mean: that class carries *nothing but* the animation, because the gradient and blur come from utilities on the same element. Setting `animation: none` on its own would therefore leave the glow parked at its own opacity - brighter than the pulse's average, not calmer. So the switch pins both, holding it at a fixed opacity that defaults to `0.55`, the dim end of upstream's own range.

No frame-time or power figure is claimed for this: the reasoning is the mechanism above, not a benchmark.

It is applied with `webContents.insertCSS` and removed again with `removeInsertedCSS`, so flipping it takes effect immediately in every open window and needs no restart. The choice is saved as `coworkGlow` in `claude-desktop-extra.json`; `coworkGlowOpacity` sets the fixed opacity if `0.55` is not to your taste. Setting `coworkGlow` by hand in the `.jsonc` still wins the startup merge, and the switch then shows itself as locked rather than silently disagreeing with the file.

The same stylesheet also defines an `animate-[conway-pulse-glow_2s_ease-in-out_infinite]` utility that looks related, but `@keyframes conway-pulse-glow` is not defined anywhere in the shipped CSS, so it animates nothing and is deliberately left alone.

As with anything keyed to remote claude.ai markup, a claude.ai deploy can rename the selector. It fails soft: the CSS matches nothing and the glow keeps pulsing exactly as it does today.

Contributed by [@Felitendo](https://github.com/Felitendo) ([#210](https://github.com/patrickjaja/claude-desktop-extra/pull/210)) - thanks!

## 2026-07-29

### 84 community color palettes now ship with the package

Alongside the seven curated built-in themes, the theme patch now bundles 84 palettes converted from the [Noctalia community-palettes](https://github.com/noctalia-dev/community-palettes) collection - Rose Pine, Gruvbox, Everforest, Kanagawa, Solarized, Tokyo Night, the Catppuccin accent variants and many more. Each one is a full dual light/dark token set, so `"activeTheme": "rose-pine-moon"` is all a config needs and Claude's own light/dark toggle keeps working. Theme resolution order is your own `themes` entries first, then the built-ins, then the community palettes, so a theme you author under the same slug replaces the bundled one instead of colliding with it.

The conversion is done by `scripts/generate-community-themes.mjs`, which maps each palette's Material-ish roles onto our CSS tokens, fixes border polarity (community palettes follow surface polarity; claude.ai needs the opposite), substitutes button-label colors that would be unreadable on their own accent, and renders one swatch card per palette. It is deterministic and takes the collection path as its argument, so refreshing after the upstream collection changes is a single command. The role-to-token mapping is documented in the script's header.

[themes/PALETTES.md](themes/PALETTES.md) is the visual catalog: all 97 bundled palettes with their swatch cards and slugs, an index, and notes on the ones with deliberately unusual variants (the AMOLED palettes' pure-black backgrounds, the muted mid-tone light variants of Everforest and the Kanagawa pair).

### Six gaming themes and a Gaming category

Six palettes drawn from games ship alongside the curated built-ins: **PlayStation** (PS1 console gray over charcoal blue-black, PlayStation-blue accent, status colors borrowed from the controller's button symbols), **Game Boy** (DMG shell gray with magenta buttons in light, pea-green LCD in dark), **Final Fantasy** (parchment cream over the classic menu blue with a crystal-gold accent), **Zelda** (forest green and gold), **Warcraft** (parchment gold and Alliance blue, with orc-green success) and **Dragon Ball** (sky and white over deep blue, bright orange accent). They resolve at built-in rank, so `"activeTheme": "gameboy"` is all a config needs, and they are authored in `js/gaming_themes.json`.

They are grouped by a new `category` field rather than by which registry they come from, so they get their own divider-separated **Gaming** section in both the <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> picker and Settings -> Extra -> Themes. Mario carries the same category, so it moves into that section too - seven cards in all. A theme of your own can join it with `"category": "gaming"`.

### Every bundled palette now has its own loading spinner

The spinner reshape used to be a built-in-only luxury. All 84 community palettes now carry one too, drawn from the palette's name or its colors: a stag for Everdeer, aurora ribbons for Nord Aurora, a great-wave curl across the Kanagawa family, one curled sleeping cat across every Catppuccin variant, an ensō brush circle for Zenbones, a crescent moon for Tokyo Night Moon. There are 53 distinct designs across the 84 slugs, because families share a shape on purpose.

The glyphs are curated in `scripts/community-spinners.json` and merged into the palettes by `scripts/generate-community-themes.mjs`, so regenerating after the upstream collection changes is still one command. The generator hard-fails rather than shipping a broken glyph: slug parity is checked in both directions, path data must tokenize as SVG, and any explicitly colored fill must clear 2.5:1 against both variants' backgrounds. The same spec contract is asserted while the patch compiles, for every bundled theme.

### Theme switches now re-theme the loading glyph too

Switching theme changed the colors live but left the loading glyph on the old shape until the app was restarted, because reshaping it rewrote the star's SVG paths in place and the original geometry the matcher keys on was gone after the first pass.

The engine now takes custody of the original glyph: the first time it reshapes an element it stashes that element's untouched markup, keeps the first capture as a document-wide fallback for glyphs the page later clones, and tracks every element it owns. A theme switch re-renders all of them with the new spec and sweeps for any that appeared since; reverting to **Claude default** puts Claude's own star back. Its `MutationObserver` installs the spec in effect now rather than the one baked in at injection time, so glyphs rendered after a switch get the new shape as well.

**Nothing about a theme switch needs a restart any more** - colors, fonts, `customCss` and the spinner all follow the click, in every open window. Hand-editing `claude-desktop-bin.jsonc` still does, since that file is read at startup.

### A "flip" spinner animation for two-frame sprites

Spinner specs accept a fourth animation, `flip`, next to `pulse`, `spin` and `bounce`. It renders two frames at once (`paths` and `paths2`) and hard-cuts between them at about two frames per second with no interpolation, the way a retro sprite animates: the Zelda hero takes a step, the Warcraft peon swings his pick. Six community glyphs use it as well, among them a blinking terminal cursor and a checker-diamond flicker.

`paths2` is required exactly when the animation is `flip` and ignored otherwise, and that pairing is asserted at build time, so a half-authored sprite fails the build instead of shipping as a glyph that flickers against nothing.

### Theme picker on Ctrl+Shift+T

Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> in any Claude Desktop window and a searchable gallery opens with every theme available to you - your own, the gaming palettes, the built-ins, and the community palettes, each in its own section - every card showing a dark and a light row of swatches. Click one and it applies immediately in every open window; no restart, no editing a file by hand. A "Claude default" entry at the top reverts to Claude's stock palette.

The choice is persisted to `claude-desktop-bin.jsonc` by a surgical text edit that replaces only the `activeTheme` value, so comments and every other key survive; if the file does not exist yet it is created from a short commented template. Colors, the `chatFont` override, `customCss` and the loading spinner all switch live.

The picker is a local window driven by a key handler in the main process, so it does not depend on anything in claude.ai's bundle.

### An "Extra" page in Claude's own Settings dialog

Claude's Settings dialog now carries an **Extra** group with two panels:

- **Themes** - the same registry as the picker, rendered as rows with color dots. Clicking one applies it live and saves it exactly as the picker does.
- **Features** - the 134 catalogued GrowthBook feature flags as switches, so browsing and flipping a flag no longer means hand-editing a config file. Flags upstream already enables start switched on, and turning one off writes an explicit `false`. Flags that carry a value rather than a switch are read-only, and the one flag documented as breaking Cowork is not toggleable.

Flag changes are written to `growthbookOverrides` in `claude-desktop-bin.json`; the panel states in red that they need a restart (the features they gate are wired up at startup) and offers a Restart now button. Anything set by hand in `claude-desktop-bin.jsonc` is shown as owned by that file and left alone - the hand-edited value still wins per flag ID.

The group looks native because it is not drawn from scratch: its header and its two rows are clones of Claude's own, so font, size, indentation, the icon box and the selected pill all come from Claude's stylesheet, and the selected look is handed back to the row it was borrowed from when you navigate away. Only the word "Extra" and the two glyphs are ours.

Because the Settings dialog is claude.ai markup this package does not control, the injector anchors on semantics only and fails soft: if it cannot find the dialog it logs one line and changes nothing. The shape it is fitted to is recorded verbatim in [baseline/SETTINGS_NAV_CAPTURE.md](baseline/SETTINGS_NAV_CAPTURE.md), and a sanitized DOM-shape line in `claude-patches.log` names the anchor to refit when claude.ai changes. <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> is entirely local and always available.

### Fix: uncommenting a single flag line no longer invalidates the whole config

`claude-desktop-bin.jsonc` is auto-created as a template with every known flag commented out, one per line, each already ending in a comma - so uncommenting exactly one entry left a trailing comma before the closing brace, which is not valid JSON. The parser rejected the file silently, and with it every other setting in it, `activeTheme` included: the documented "uncomment an entry to activate it" workflow appeared to do nothing. All readers of the file now tolerate trailing commas.

### Fix: chat header, "Quick answer" band and disclaimer strip now follow the theme

With a custom theme active, three chat regions kept Claude's stock background: the sticky conversation header, the "Quick answer" band above the composer, and the disclaimer strip below it. claude.ai's desktop-frame stylesheet redefines the background token on the container that wraps the whole chat view, and a CSS variable set directly on an element always beats one inherited from an ancestor - so those regions never saw the theme's value. The theme engine now re-asserts its background ramp at that container too (via collision-proof mirror variables), which also fixes the two regions that paint the token through gradients. A regression suite renders the affected elements against the real claude.ai CSS and asserts the computed colors in both modes.

## 2026-07-28

### Arch / Manjaro: install from our own signed pacman repository

The `claude-desktop-bin` AUR package was deleted by the AUR maintainers after a third party filed a duplicate-package request against it. Rather than return to the AUR, Arch and Manjaro users are now served by our own pacman repository, matching how we already ship to Debian/Ubuntu and Fedora/RHEL:

```bash
curl -fsSL https://patrickjaja.github.io/claude-desktop-bin/install-pacman.sh | sudo bash
sudo pacman -Syu claude-desktop-bin
```

Packages and the repository database are GPG-signed with the same key as the APT and RPM repos (`SigLevel = Required DatabaseRequired`) and hosted as GitHub release assets. Updates arrive with `sudo pacman -Syu`; AUR helpers wrap pacman, so `yay -Syu` keeps working. Because flat release assets cannot express per-arch directories, the repo section is `[claude-desktop-bin]` on x86_64 and `[claude-desktop-bin-aarch64]` on aarch64 - the package name is `claude-desktop-bin` on both. The README documents the manual `pacman.conf` stanza for anyone who prefers not to pipe a script into `sudo bash`.

Building from source stays supported for users who avoid third-party repositories: the `PKGBUILD` is still generated and CI-tested on every release, and it is now published as a release asset along with `.SRCINFO` and `claude-desktop-bin.install`, so `makepkg -si` works without an AUR clone.

The AUR push step has been removed from the release workflow.

`install-pacman.sh` runs `pacman-key --init` before importing the key. A normal Arch install already has the keyring's local signing key, but containers, chroots and wiped keyrings do not, and without it `--lsign-key` fails with a cryptic "There is no secret key available to sign with".

### Manual pacman setup now pins the key fingerprint

The manual `pacman.conf` instructions (README, under "Advanced") previously read the key id out of the `.asc` file they had just downloaded and locally signed that - trust-on-first-use, which would have accepted a substituted key without complaint. They now print the fingerprint, state the expected value, and pass the full fingerprint to `pacman-key --lsign-key`, so the key is checked against a value published in git before it is trusted. They also run `pacman-key --init`, which the install script already did and the manual path did not.

### Repository signing key: user id now names the maintainer

The signing key's user id read `Claude Desktop Linux <claude-desktop-linux@users.noreply.github.com>`, an address belonging to no GitHub account. It now reads `Claude Desktop Linux (claude-desktop-bin repo signing key) <patrickjajaa@gmail.com>`. The old user id is revoked, and the revocation is published together with the key.

**The key itself is unchanged** - same RSA 4096 key, same fingerprint `825A 7D15 D78B ABE4 5646  D5DF 3824 09F5 9790 8867`, same key id `382409F597908867`. A user id is not part of an OpenPGP fingerprint, so there is nothing to re-import: existing keyrings keep verifying every package and repository database exactly as before, and simply show the old user id until the key is next imported. Packages signed before and after the change verify against the same key.

## 2026-07-27

### Fix: Nix sign-in did not persist across restarts (libsecret dropped from the closure)

On Nix, `safeStorage.isEncryptionAvailable()` was false regardless of keyring backend, so the OAuth token was never stored and every restart went through the login flow again ([#206](https://github.com/patrickjaja/claude-desktop-bin/issues/206)). The backend choice was fine (`gnome_libsecret`); the `dlopen("libsecret-1.so.0")` behind it was what failed.

nixpkgs' electron does account for this - it patchelfs the dlopen-only libraries into the electron binary's RPATH - and that RPATH survived our copy of the dist. stdenv's patchelf fixup hook then ran `patchelf --shrink-rpath` over our output, which by design removes every RPATH entry no `DT_NEEDED` library lives in. Because Chromium dlopens them rather than linking them, that took out all of `libsecret`, `libnotify`, `pipewire`, `libpulseaudio` and `speechd`: they left the binary's RUNPATH, and with the source-built electron that nixpkgs defaults to, their store references went too, so the libraries dropped out of the closure entirely.

`packaging/nix/package.nix` now sets `dontPatchELF = true` to keep the RPATH nixpkgs intended, and a build-time tripwire fails the build if a future nixpkgs electron stops shipping libsecret there. `libsecret` is additionally declared on the wrapper's `LD_LIBRARY_PATH`, so the requirement is now stated as explicitly as in every other packaging format (`PKGBUILD.template`, the `.deb` and the `.rpm` all declared it; Nix was the only one that did not). The same RUNPATH entries also carried notifications, PipeWire and audio, which the fix restores alongside credential storage. Existing installs need one final sign-in.

## 2026-07-25

### Fix: KDE sessions without KWallet had to sign in again after every reboot

The launcher's Secret Service detection skipped KDE outright, assuming Chromium's `KDE -> kwallet` mapping always yields a working backend. It does not when KWallet is switched off (`kwalletrc` `Enabled=false`) or not installed: `safeStorage.isEncryptionAvailable()` returns false, the OAuth token never persists, and Plasma users who run gnome-keyring as their Secret Service were sent through the login flow on every boot. Checking the bus name is not sufficient either - `org.kde.kwalletd6` stays D-Bus activatable in that state and activation simply fails.

KDE is now only treated as keyring-native when `kwalletd` answers a real `org.kde.KWallet.wallets` call (bounded by a 5s D-Bus timeout, so a pending wallet-creation wizard cannot stall startup); otherwise it falls through to the existing `gnome-libsecret` fallback from [#191](https://github.com/patrickjaja/claude-desktop-bin/issues/191). Working KWallet setups, GNOME, and `CLAUDE_PASSWORD_STORE=auto` are unaffected.

## 2026-07-20

### Fix: Hardware Buddy (Nibblet BLE) in-app scan found no device on Linux

`fix_buddy_ble_linux` forced the Buddy flag (`2358734848`) at the `isFeatureEnabled` read site, which showed the UI but never fired the store-level `onFeatureChange` listener that arms the BLE transport - so `scanDevices` silently returned nothing. The flag is now forced at the store level instead, via a built-in Linux force in `add_growthbook_overrides` (merged before user overrides, so `"2358734848": false` still opts out); the standalone patch is removed. `bluez` added as a soft dependency (Arch optdepends, RPM/deb Suggests) since Web Bluetooth needs the daemon running.

### Fix: Hardware Buddy scan needed Web Bluetooth enabled on Linux (second half of the fix)

Arming the BLE transport (above) was necessary but not sufficient. The Buddy scan runs `navigator.bluetooth.requestDevice(...)` in the mainView renderer, and on Linux Chromium gates Web Bluetooth behind the `WebBluetooth` Blink feature at the process level - so `navigator.bluetooth` was undefined and the in-app scan found nothing even when the OS bluetooth scan saw the device (macOS/Windows have Web Bluetooth on by default). The launcher now passes `--enable-blink-features=WebBluetooth`, which enables it (a per-webContents `enableBlinkFeatures` webPreference does not - only the process-level switch works; verified on Linux). With both halves in place `navigator.bluetooth.requestDevice` runs and the scan can enumerate the Nibblet. Web Bluetooth on Linux is still marked experimental by Chromium.

## 2026-07-16

### Computer Use teach mode: display targeting and superseded-step fixes ([#200](https://github.com/patrickjaja/claude-desktop-bin/pull/200))

Contributed by [@mosi0815](https://github.com/mosi0815) (author of the bundled [kwin-portal-bridge](https://github.com/mosi0815/kwin-portal-bridge)) - the JS companion to the bridge 0.2.4 fixes released yesterday:

- Teach steps no longer restart the overlay twice: the redundant `teach-display` call before each step is gone, since `teach-step` retargets atomically and the bridge prefers the screen containing the step's anchor anyway.
- A teach step superseded by a newer one no longer resolves or stops the session prematurely - the newer call owns the pending step.
- The display fallback no longer guesses from the main window (it is hidden during teach mode, and on Wayland Electron then resolves to whatever screen happens to be active); it now follows the display the session overlay was last actually placed on.
- The Linux executor's `hostBundleId` is now `com.anthropic.claude`, matching the app-identity alignment.
- Build: tarball compression uses `pigz` when available (parallel gzip, noticeably faster builds).

### Release notes no longer show stale changelog history on automated releases ([#199](https://github.com/patrickjaja/claude-desktop-bin/issues/199))

Fully automated upstream bumps (like v1.21459.3) attached the newest CHANGELOG.md section to the GitHub release body even when that section described an earlier, manually handled release. The release workflow now checks whether CHANGELOG.md actually changed since the last release tag: unchanged means the release gets an accurate generic note ("automated upstream bump, patch set applied cleanly, no new changelog entries"), while manual releases keep embedding the new section, now prefixed with its CHANGELOG.md date so it can't be misread as release-specific.

## 2026-07-15

### Updated to Claude Desktop v1.21459.0

Routine upstream bump. Computer Use is still macOS/Windows-only upstream, so our Linux Computer Use support stays. One tool-description tweak re-fitted (`open_application` on Linux no longer tells the model to request allowlist access first, since our bridges reach every app). No new Linux-relevant changes upstream.

### App identity aligned to upstream: `com.anthropic.Claude`

All packages now ship the official build's app identity end to end. Previously the build pinned the bundle's `desktopName` back to `claude-desktop.desktop` and named every `.desktop` file, `StartupWMClass`, and systemd scope to match. The pin is removed: the bundle keeps upstream's `desktopName` (`com.anthropic.Claude.desktop`), every package (AUR, deb, rpm, AppImage, Nix) installs `com.anthropic.Claude.desktop` with `StartupWMClass=com.anthropic.Claude`, the launcher scope is `app-com.anthropic.Claude-PID.scope`, and the `claude://` handler registers on the new name. A build tripwire fails loud if upstream ever renames `desktopName` again.

The point of the reverse-DNS id: `xdg-desktop-portal` resolves an unsandboxed app from its systemd scope back to a `.desktop` file, which is what makes portal activation routing and KDE's persistent screen-share / Computer Use grants work. The single-segment `claude-desktop` id could not do that, and keeping it meant permanent naming drift from the official package.

One-time migration on upgrade:

- Pinned taskbar/dock shortcuts referencing the old `claude-desktop.desktop` orphan - re-pin once (deliberately no compat symlink: it would surface a duplicate app entry in launchers).
- Custom WM rules matching `claude-desktop` need updating to `com.anthropic.Claude`.
- KDE screen-share / Computer Use consent asks once more (portal grants are keyed to the app id), then persists - persistence is precisely what the reverse-DNS id fixes.
- Named profiles: per-profile `.desktop` files become `com.anthropic.Claude-<name>.desktop`; `--delete-profile` cleans up both old and new names. The window `app_id` itself is shared across profiles; distinct per-profile grouping needs a per-profile `desktopName` override (follow-up).
- Quick Entry keeps its own `claude-quick-entry` id. Launcher binary (`claude-desktop`), icon name, and userData (`~/.config/Claude`) are all unchanged - no re-login.

### kwin-portal-bridge 0.2.4: Computer Use screenshots fixed on KDE Plasma Wayland ([kwin-portal-bridge#1](https://github.com/mosi0815/kwin-portal-bridge/issues/1))

Two bridge bugs broke screenshots on KDE Plasma Wayland (reported on 6.7.2): the KWin helper script declared its DBus constants *after* the functions that close over them, which KWin's QJSEngine rejects ("Variable 'DBUS_DESTINATION' is used before its declaration") - so window-control scripts never ran; and un-activatable `plasmashell` overlay surfaces (OSD/notifications) in the pre-capture activation set aborted the whole preparation, cascading into "session daemon did not become ready in time". Window activation is now gated to activatable windows and best-effort, the constants precede the header, and a separate race (activation verified with a single immediate read of the active window) polls for the requested window instead. Bundled bridge is now 0.2.4 with regression tests for both fixes.

### `--diagnose`: new Computer Use section

`claude-desktop --diagnose` now prints the installed package version (which pins every bundled bit, bridges included), bundled-bridge presence, and - on KDE Wayland - the KWin version with the `>= 6.6` gate verdict plus a portal-free `windows` enumeration self-test through the kwin-portal-bridge, the exact KWin scripting path the 0.2.4 fixes repair. No consent dialog is opened and window titles are never included in the output. The README now also states the KDE Plasma 6.6 floor for the native KWin route explicitly.

### Removed 4 patches: we no longer keep "guard-only" patches

Dropped 4 patches (41 -> 37) that no longer modified the bundle and only asserted upstream's own behavior: the CLI-governor memory fix ([#128](https://github.com/patrickjaja/claude-desktop-bin/issues/128)), the `/etc/claude-desktop/managed-settings.json` reader (main + boot bundle), and the title-bar fix - all native in the official build. We keep only patches that modify the bundle.

### KDE Plasma Wayland no longer misrouted to the "exotic" XWayland fallback ([#194](https://github.com/patrickjaja/claude-desktop-bin/issues/194))

Computer Use on a KDE Plasma 6.6+ Wayland session could fall through to the "exotic - ydotool/x11-bridge" fallback (ending on XWayland) instead of the native `kwin-portal-bridge`. The mode gate in `cu_mode_preamble.js` keyed off `XDG_SESSION_DESKTOP === "KDE"` - an exact-match on a variable set by the display manager, whose value is not standardized (SDDM/GDM may report `plasma`, an absolute path, or nothing). The downstream DE detection in `cu_linux_executor.js` used the reliable `XDG_CURRENT_DESKTOP` (Plasma sets it to `KDE`), so the two disagreed: diagnostics printed `de=kde` while the bridge was never selected. The gate now keys off `XDG_CURRENT_DESKTOP` (case-insensitive substring) and accepts `WAYLAND_DISPLAY` as a Wayland signal, matching the downstream logic and the label the `kwin-portal-bridge` itself reads. The KWin `>= 6.6` version probe still guards the route, so a non-KWin or too-old session correctly falls back.

### Diagnostics surface the raw session env behind KDE routing

To make a future routing mismatch diagnosable without shell access, `--diagnose` now prints `XDG_SESSION_DESKTOP` next to `XDG_CURRENT_DESKTOP`, and the runtime `[claude-cu] diagnostics:` block adds a line with the raw `XDG_CURRENT_DESKTOP` / `XDG_SESSION_DESKTOP` / `XDG_SESSION_TYPE` values plus the resolved `kwin-mode`. A `de=kde` with `kwin-mode=false` now reads as a self-explaining signature in `claude-patches.log`.

### Quick Entry no longer restores a stale window app_id after first use

After Quick Entry is shown, `fix_quick_entry_app_id` resets `CHROME_DESKTOP` so later windows get the main app_id back. That reset target was a hardcoded `claude` literal, but upstream renamed the app identity (`desktopName`) to `com.anthropic.Claude` in v1.19367.0, so on Wayland compositors that create a separate toplevel after Quick Entry (GNOME, wlroots) those windows could inherit a stale, non-matching app_id - breaking taskbar/dock grouping and per-app window rules. The reset now reads `desktopName` from the app's own `package.json` at runtime (falling back to the literal only if that read fails), so it can't go stale on the next upstream rename. Verified non-breaking on KDE Plasma 6 Wayland (main window kept the then-pinned `claude-desktop`, Quick Entry `claude-quick-entry`; with the app-identity alignment above, the runtime read now resolves the main id to `com.anthropic.Claude`).

### Launcher: `CLAUDE_GPU_BACKEND=angle-gl` escape hatch

New opt-in launcher env var that renders via ANGLE's GL backend (`--use-gl=angle --use-angle=gl`) instead of the native Wayland/GBM path. Some GPU + kernel-driver combos (e.g. Intel `xe`) abort Electron's Ozone/Wayland GPU-process init ("GPU process isn't usable. Goodbye.") but work fine through ANGLE-GL, which keeps GPU acceleration - a milder fallback to try before `CLAUDE_DISABLE_GPU`.

## 2026-07-13

### Docs: how to reset a stuck Dispatch conversation

The Cowork/Dispatch troubleshooting section in the README now covers Dispatch sessions that stop responding: the conversation persists its state (including past errors) across restarts, so the fix is the **⋮** menu next to the Dispatch title -> **Delete conversation** (with screenshot).

### RPM fixed for RHEL 9: bundled CU bridges no longer poison the package's glibc requirement

The RPM had been uninstallable on RHEL 9 / Rocky 9 since the gnome/kwin CU bridges were bundled (2026-07-06): rpm's automatic ELF dependency scan harvested the bridges' deliberate glibc-2.39 symbols and turned them into package-level requirements, while RHEL 9 ships glibc 2.34 (`nothing provides libc.so.6(GLIBC_2.39)`). The bridges are supposed to be inert on RHEL 9 - their sessions (KDE 6.6+, GNOME on PipeWire >= 1.0.5) do not exist there and X11/wlroots Computer Use uses the static bridges. The spec now excludes the bundled tree from the automatic requires/provides generators and declares runtime deps by hand, mirroring the official .deb's Depends (and our own .deb, which never had the problem). Verified: the fixed rpm installs and boots on rockylinux:9 and fedora:40; it carries no glibc auto-requires and no longer leaks bundled sonames (libffmpeg.so, ...) as provides.

### CI: pipeline now boots the packages on Debian 12, RHEL 9 (Rocky) and a real Wayland session

The install-and-boot test matrix previously proxied whole distro families (ubuntu:22.04 for all deb targets, fedora:40 for all rpm targets) and ran every boot under Xvfb, i.e. X11 only. Three gates added, each prototyped locally against real containers before landing:

- **debian:12**: apt install of the .deb + structural asserts + 15s boot - real Debian coverage instead of the Ubuntu proxy.
- **rockylinux:9**: dnf install of the .rpm + boot - pins the actual RHEL 9 glibc-2.34 floor and permanently guards the requires-filter fix above.
- **Wayland boot** (ubuntu:24.04): a headless weston compositor plus `--ozone-platform=wayland` boots the installed package on a genuine Wayland display - the first automated coverage of the Wayland code path; catches ozone/wayland init regressions the Xvfb tests cannot see.

`smoke-test.sh` gained `SMOKE_WAYLAND=1` (boot on a caller-provided Wayland socket instead of Xvfb) and `SMOKE_TIMEOUT_SECONDS` (default 15), and now kills the whole process group so no orphaned Electron processes outlive the test.

### Layout refactor: packages now ship the official install tree verbatim - 4 repackaging patches removed

All packages (AUR, deb, rpm, AppImage, Nix) now install the official `.deb`'s `usr/lib/claude-desktop/` tree byte-identical except for the patched `resources/app.asar`, our four CU bridge binaries added to `resources/`, and the entrypoint binary renamed to `claude`. Electron auto-loads the exe-adjacent `resources/app.asar` (the official build's `OnlyLoadAppFromAsar` fuse permits nothing else), so the launcher no longer passes the asar on the command line and `process.resourcesPath` / `app.isPackaged` behave exactly as on the stock Anthropic `.deb`. Verified up front: the `EnableEmbeddedAsarIntegrityValidation` fuse is on but not enforced on Linux (a modified asar boots), and an instrumented boot of the verbatim tree confirmed correct `resourcesPath`, `isPackaged: true`, and clean argv.

This deletes the entire "repackaging fixes" patch group - patches that existed only to compensate for our previous split layout (`app.asar` + a `locales/` resource dir decoupled from the binary, asar passed via argv):

- `fix_locale_paths` - the blanket rewrite of every `process.resourcesPath` in the bundle is unnecessary when the asar sits at its upstream position. This also removes a standing hazard: every new upstream `resourcesPath` consumer was silently redirected (the class behind [#140](https://github.com/patrickjaja/claude-desktop-bin/issues/140)).
- `fix_0_node_host` - existed only to repair sidecar paths the blanket rewrite corrupted.
- `fix_asar_folder_drop` and `fix_asar_workspace_cwd` - the asar path no longer appears in argv, so it can no longer be treated as a dropped folder or workspace cwd ([#24](https://github.com/patrickjaja/claude-desktop-bin/issues/24); the [#191](https://github.com/patrickjaja/claude-desktop-bin/issues/191) sanitizer class is gone with it).

Other consequences: locale JSONs, ion-dist, virtiofsd, cowork-linux-helper and the smol images stay at their upstream `resources/` locations (the i18n mirror-into-asar step is gone); the CU bridges resolve via plain `process.resourcesPath`; `CLAUDE_APP_ASAR` is deprecated and ignored by the launcher (a warning explains why); the smoke test boots the finished tree directly. On NixOS, package.nix now merges the nixpkgs Electron dist and our `resources/` into one directory so the same exe-adjacent autoload applies (the bundled Electron still cannot run on NixOS). Per-profile installs already mirrored `resources/` as a sibling symlink of the per-profile binary, so profiles work unchanged. Remaining patch count: 41.

### README rewritten fact-based: every patch now states the upstream gap it closes

The Patches section was audited against all 45 patch sources and restructured into four groups - value-adds, Linux fixes (macOS/Windows gates + Linux environment quirks), repackaging fixes (needed only because we relocate `app.asar`), and regression guards (assert-only, previously unlisted). Each entry now explains why the patch exists on the official Linux build; historical narrative (MSIX-era references, retirement anecdotes) was removed. Also corrected stale claims: CI polls every 2 hours (not daily), the `.jsonc` flag template is CI-sync-checked (not regenerated per release), only the Computer Use and Buddy gates are forced directly, upstream gates Computer Use to macOS/Windows (not macOS-only), and the primary-monitor limitation now mentions `switch_display` retargeting.

### Simplification: 14 GrowthBook rollout forces retired - flags now follow Anthropic's rollout, with .jsonc opt-in

Since the `growthbookOverrides` config landed (2026-07-11), users can flip any store-read feature flag themselves in `~/.config/Claude/claude-desktop-bin.jsonc`. That made a whole class of our patches redundant: forces that merely bypassed Anthropic's server-side rollout for flags that have no platform gate. A full trace of every forced flag through the v1.20186.1 bundle confirmed all 14 of them read from the feature store (so the `.jsonc` override reaches them), none is gated on `process.platform`, and none is compensated elsewhere - so they now behave exactly as upstream ships them.

Removed: `fix_imagine_linux.nim` entirely (Imagine/Visualize MCP server, `3444158716` + `3516166472`), and 12 flag sub-patches from `enable_local_agent_mode.nim`: coworkKappa `123929380`, coworkArtifacts `2940196192`, chillingSlothPool `1992087837`, toolResultFormatting `2192324205`, deterministicSorting `2800354941`, pluginEnabledState `4274871493`, claudePreview `2976814254`, canLaunchCodeSession `2067027393`, canSaveSkill `3246569822`, suggestSkillsEnabled `245679952`, consolidateMemoryV2 `1824824999`, coworkOnboarding `2114777685`. All 14 are now listed (commented out, with descriptions) in the `.jsonc` template - if a feature you relied on disappears because Anthropic's rollout has it off for you, uncomment its line to get it back.

What stays: the platform-enablement core of `enable_local_agent_mode` (Code-tab/Cowork platform gates, capability merger, preference defaults, regression guards), the Computer Use gate (`2486083521` gets a Linux branch so a remote flag flip cannot disable CU), and the Buddy BLE Linux force (`2358734848`, which preserves the user's hardware toggle) - those cover features upstream gates by platform, which a flag override cannot express. For 3p/enterprise deployments nothing changes at all: upstream itself force-enables several of these flags in deployment mode.

### v1.20186.1: four patches re-fitted after the upstream bump ([#192](https://github.com/patrickjaja/claude-desktop-bin/issues/192))

Upstream released v1.20186.1 (full re-minify; the code-split main bundle grew from ~45 to 82 chunks) and the auto-release failed on four patches. All four were upstream refactors of our anchor sites, not upstreamed features - every patch stays active:

- `fix_computer_use_linux` (4 sub-patches): the CU lock field was renamed `holder` -> `exclusiveHolder` and `acquire()` restructured into an early-return shape; the screenshot intro-note seed re-anchored past a new takeover-approval flow in the tool wrapper; the `handleToolCall` isEnabled ternary arms became method calls (`n.isComputerUseEnabled()`). 36/36 sub-patches apply.
- `fix_builtin_mcp_open_url_handler`: the 82-chunk split introduced a second, unrelated module using `safeStorage.decryptString`, breaking the bundle-global "exactly one electron var" discovery. The scan is now scoped to the chunk containing the msal-cache-get injection site (still fails loud on any ambiguity).
- `fix_asar_folder_drop`: the second-instance argv loop gained a leading directory-collector block; folded into the pattern.
- `fix_imagine_linux`: the `hasImagine` flag read became a member call (`o.isFeatureEnabled("3444158716")`); the callee matcher now accepts dotted paths. The flag ID itself is unchanged.

The parallel audits confirmed a mechanical bump otherwise: the capability map is identical (41 keys), no new platform gates, no new native modules, no new PORTABLE Linux opportunities, Electron unchanged at 42.5.1. Notable upstream changes: a new "heavy work" utility process that computes Claude Code usage stats from `~/.claude/projects`, and agent-sdk 0.3.202 -> 0.3.205. GrowthBook delta: +`3602629573` (process kill-switch), -`1295378343` (CLI stream robustness) - the overrides template and docs catalog are updated; a new `launch` async feature override (flag `2976814254`) is already force-enabled by the existing Code/Cowork enablement patch. ion-dist grew 102 -> 128 MB from three new code-split chunks, no structural changes.

### Code tab fixed: Local sessions failed with "__cdb_sanitizeCwd is not defined" ([#191](https://github.com/patrickjaja/claude-desktop-bin/issues/191))

On the v1.19367.0 packages, every Code-tab Local session failed - as "Trust check couldn't be completed" when picking a folder, or "Something went wrong: __cdb_sanitizeCwd is not defined" when sending a message. Chat was unaffected.

Root cause was ours, a consequence of the code-split re-plumbing above: `fix_asar_workspace_cwd` injects a path-sanitizer helper at the top of the bundle and rewrites five LocalSessions/startCodeSession bridge call sites to use it. On the staged concatenation both live in one file, but after the split-back the injection point (the `index.js` loader stub) and the call sites (two `index.chunk-*.js` files) are separate CommonJS modules - the module-scoped `var` helper was invisible to the chunks, and every bridge call threw `ReferenceError` on its first statement. That is also why `main.log` stayed silent: `checkTrust` died before reaching its own log line. The helper is now defined on `globalThis`; the stub's top level runs before it requires any chunk, so the definition is guaranteed visible at every call site.

Why no gate caught it: the strict per-site match counts validate on the concatenation, where a single scope really does exist; `node --check` on each split file passes because an unresolved identifier is a runtime error, not a syntax error; and the smoke test does not start a Code session. `apply_patches.py` now closes the class at the split-back chokepoint: any injected `__cdb*` identifier referenced in more than one chunk part must be defined via `globalThis`, otherwise the build fails loud. The guard was verified in both directions - it rejects the broken v1.19367.0-4 bundle and passes the fixed one. An audit of all other injected identifiers found no second instance of the pattern (the remaining cross-chunk helpers were already `globalThis`-based).

### Launcher: sign-in now persists on Hyprland/sway/XFCE and other keyring-less-by-Chromium desktops ([#191](https://github.com/patrickjaja/claude-desktop-bin/issues/191))

Chromium picks its encryption backend from `XDG_CURRENT_DESKTOP`. On desktops it does not map to a keyring backend - all wlroots compositors (Hyprland, sway, river, niri), COSMIC, and also XFCE/LXQt, which it maps to `basic_text` by policy - `safeStorage.isEncryptionAvailable()` is false, OAuth tokens do not persist across launches, and the app tells the user to "install and unlock a system keyring" they may already be running.

The launcher now detects a Secret Service (`org.freedesktop.secrets`, owned or D-Bus-activatable) on the session bus and, on those desktops, adds `--password-store=gnome-libsecret` automatically (suggested and verified by the #191 reporter on Hyprland). Desktops Chromium already handles (GNOME family -> libsecret, KDE -> kwallet) are left untouched. Escape hatches: an explicit `--password-store=...` argument always wins, `CLAUDE_PASSWORD_STORE=<value>` forces a backend, and `CLAUDE_PASSWORD_STORE=auto` disables the detection. One-time side effect on machines that previously ran on `basic_text`: data encrypted under the old hardcoded key cannot be read after the switch, so the first launch may ask you to sign in again - after that, sign-in finally sticks.

## 2026-07-12

All three Computer Use fixes below were contributed by Craig ([@F1nny](https://github.com/F1nny)) in [#188](https://github.com/patrickjaja/claude-desktop-bin/pull/188), [#189](https://github.com/patrickjaja/claude-desktop-bin/pull/189), [#190](https://github.com/patrickjaja/claude-desktop-bin/pull/190) - thanks!

### Computer Use: action tools no longer reject on executor errors - return a normal tool error

The Computer Use handler wrapped its non-action tools (screenshot, zoom, open_application, …) in a top-level try/catch that turns a thrown executor error into a normal `{isError:true}` tool result, but the action-tool branch (left_click, type, scroll, drag, key, …) had no such guard. A throw from `ex.click`/`ex.type`/etc. propagated out of `handleToolCall` as a rejected promise instead of a tool error, so a transient backend failure (e.g. a missing bridge on an input action) surfaced as an unhandled error rather than a message the model could see and retry. The action-tool branch now has the same top-level guard, so both paths report executor failures consistently.

### Computer Use: bridge stdout parsed defensively (clear error instead of bare SyntaxError)

All four bridge invokers (`_x11Bridge`, `_bridge`, `_bridgeAsync` in the regular executor; `execBridgeJson` in the kwin executor) fed bridge stdout straight into `JSON.parse`. A bridge that crashed mid-write, printed a stray warning, or emitted anything but one JSON value surfaced as an anonymous `SyntaxError: Unexpected token` with no hint of which bridge misbehaved or what it printed. Parsing now goes through a guard that fails with the bridge name and a 300-char stdout preview, and the kwin executor also logs the preview to `claude-patches.log` via `__cdbDiag`.

### Computer Use: shell-string exec calls converted to argument arrays (ydotool path had a real injection vector)

The regular executor built shell command strings for ydotool, spectacle/convert, and app launching. On the ydotool tier (exotic Wayland sessions), model-supplied input reached the shell: `ydotool type -- "+JSON.stringify(text)` and `ydotool key <mapped>` - JSON.stringify quoting is not shell quoting, so typed text or an unmapped key name containing `$(...)` or backticks would be command-substituted by the shell. `setsid xdg-open <name>` / `setsid <resolved>` in `openApp` had the same exposure via model-supplied app names. All of these now go through argument arrays with no shell involved (new `_ydotool` and `_launchDetached` helpers): ydotool via `execFileSync`, and detached app launches via `spawn` with `detached:true` + `stdio:"ignore"` + `unref()`, which reproduces the old `>/dev/null 2>&1` fire-and-forget semantics exactly - `execFile` would have piped and buffered the app's output and killed a long-running app once it exceeded `maxBuffer`. The spectacle/convert screenshot tier was moved to `execFileSync` for consistency. `COWORK_SCREENSHOT_CMD` stays intentionally shell-evaluated (a user-supplied template from the user's own environment, pipes/redirects are part of its contract) and is now commented as such.

## 2026-07-11

### v1.19367.0: upstream code-split the main bundle - orchestrator now patches stub + chunks as one logical file

Upstream restructured the app: `.vite/build/index.js` went from a 15 MB monolith to a 773-byte loader stub, with the real main-process code in ~44 content-hashed `index.chunk-<hash>.js` siblings, and `index.pre.js` (now the `package.json` entry point) grew to 4.5 MB. Chunk hashes change every release, so no patch can target them by name. Every pattern-matching patch 0-matched and the auto-release failed (#187).

The fix is in the patch orchestrator, not in 40 regexes: `apply_patches.py` (and `validate-patches.sh`) now stage the stub plus all sibling chunks as one concatenated file with boundary markers, run every `index.js` patch against it, then split it back and write each file. Patches keep their `@patch-target: .../index.js` headers and their strict aggregate match counts work across the whole logical bundle exactly as on the old monolith; a corrupted boundary fails the build loudly, and each split file is `node --check`ed. This proved necessary beyond convenience: `fix_asar_workspace_cwd`'s five anchor sites now span two different chunks.

31 of 40 patches applied verbatim on the concatenation. Nine needed real fixes, almost all one shared root cause: the code-split minifier turned module-local identifiers into dotted cross-chunk member paths that `[\w$]+` cannot match - the main window is now `exports.mainWindow` (fix_window_bounds, fix_profile_window_title, fix_quick_entry_cli_toggle), loggers are `n.logger.info` (fix_asar_workspace_cwd), and flag reads are `p.isFeatureEnabled("...")` instead of `rt("...")` (fix_imagine_linux, fix_buddy_ble_linux, enable_local_agent_mode - the latter's standalone flag matchers would otherwise have produced dangling `l.!0` syntax errors). The remaining drifts were minifier hoisting (`var r;` before the folder-drop handler in fix_asar_folder_drop) and a renamed tray icon variable (fix_tray_icon_theme). SSH plugin/MCP forwarding remains unconditional upstream (regression guard re-anchored, satisfied).

Two latent pre-existing bugs were found and fixed along the way: `fix_quick_entry_cli_toggle`'s second-instance argv sub-patch reported "already applied" on pristine bundles because its idempotency probe matched a sibling sub-patch's own injected text (it now checks the real end-state and genuinely applies), and `fix_buddy_ble_linux` reported success on files containing no buddy code at all (absence now fails loud).

### v1.19367.0: desktopName pinned to claude-desktop.desktop (upstream renamed to com.anthropic.Claude.desktop)

Upstream renamed its `desktopName` to `com.anthropic.Claude.desktop`, matching the .desktop file the official .deb installs. Chromium derives the window's Wayland `app_id` / X11 `WM_CLASS` from that value, and every .desktop entry we ship (Arch/deb/rpm/AppImage/Nix, the launcher's per-profile entries, `StartupWMClass`, the `claude://` xdg-mime handler) is built around the `claude-desktop` identity - the window-to-icon matching fixed in #148 would have silently broken on Wayland. The tarball build now pins `desktopName` back to `claude-desktop.desktop` after extraction (the JS bundle references neither name, so the pin is safe) and fails loud if the key ever disappears.

### New: local feature-flag overrides via claude-desktop-bin.jsonc (shared with themes)

New patch `add_growthbook_overrides.nim`: Claude Desktop's GrowthBook flags are served by Anthropic with no local override layer (the fcache disk cache is encrypted), so the only way to flip a flag used to be a binary patch. Now every flag load (startup, the ~hourly refresh, account changes) runs through a hook that merges a `growthbookOverrides` map from the local config over the freshly loaded feature map - user overrides win over the server rollout, applied on a copy so the raw payload and its disk cache stay untouched. Uncommenting a line is all it takes; changes apply on the next refresh without a restart, and active overrides are logged to `claude-patches.log`. Booleans flip switches; numbers/strings/objects set value flags.

The config is the same file custom themes already use, now under a `.jsonc`-first scheme: `~/.config/Claude/claude-desktop-bin.jsonc` is the documented home going forward, and a legacy `claude-desktop-bin.json` keeps working - both files are JSONC-parsed and merged per key with `.jsonc` winning, themes maps merged per name. The theme reader was taught the same comment-tolerant dual-file parsing, so nothing breaks for existing theme configs and both features can live in one file. The auto-created template is a full catalog: all 110 GrowthBook flags observed being read from the feature store in v1.19367.0, each commented out with a description (from the baseline flag docs where catalogued), dangerous entries marked (hostLoopMode carries a DO-NOT-ENABLE warning), value flags and inverted/inert gates annotated. Flags our patches force at the call site are excluded from the list since they bypass the store. The same catalog also ships as a browsable file, [docs/claude-desktop-bin.jsonc](docs/claude-desktop-bin.jsonc), linked from the README; a CI guard (`scripts/check-jsonc-template-sync.sh`) fails the build if that file ever drifts from the template the app actually writes.

Deliberate scope: flags our patches force at the call site (the Code/Cowork/Computer Use enablement set) never consult the store, so this file cannot accidentally disable the Linux enablement; and server-side account capabilities remain out of reach by design. The immediate use case: anyone who wants tool search back after the ENABLE_TOOL_SEARCH change below can set `"1129419822": true` themselves.

### Local agent sessions: stop forcing ENABLE_TOOL_SEARCH (Patch 3f disabled)

`enable_local_agent_mode.nim` no longer forces GrowthBook flag `1129419822` (`ENABLE_TOOL_SEARCH='auto'` for local agent sessions); the flag now follows Anthropic's server-side rollout. Forcing it put a `ToolSearch` tool into every Cowork/Code session, but with a session inventory of ~79 tools nothing was ever deferred, so the tool had nothing to load - and its mere presence primed the model into a bogus "load tools first" detour (observed in a live session: `Skill({"skill":"ToolSearch"})` -> "Unknown skill" error, one wasted turn before recovering). All computer-use and MCP tools were always fully loaded; removing the force removes the confusion surface without losing anything.

### v1.19367.0: what else changed upstream

The bundle actually shrank 1.7 MB - the old build double-shipped agent-sdk (0.3.198 + 0.3.202), the new one ships only 0.3.202. Electron stays 42.5.1; the built-in MCP server set, the Cowork VM backend files, and the CU platform gates are unchanged. No newly darwin/win32-gated features exclude Linux; the new `file-index-worker` (fuzzy file scorer) and `coworkScheduledTaskProjects` capability are ungated and work on Linux natively. Three new GrowthBook flags (session-concurrency limits, device-tool artifact read gate, GPU crash-streak marker) - none patch-relevant; all 13 flags forced by `enable_local_agent_mode` are unchanged. ion-dist needed no patch changes (one new config key upstream: `inferenceFoundryAuthFlow` for Entra ID device-code vs browser sign-in). Eleven new IPC channels landed (LocalSessions remote-target trust/WSL/cwd handling, a DocumentFunnel bridge, `Extensions.isLocalExtensionInstallAllowed`), none removed. One structural caveat for future audits, now noted in the baseline docs: minified helper names differ per chunk (the flag reader is `rt()` in the big chunk but `isFeatureEnabled()` in smaller ones), so greps must cover all `index*.js` files.

## 2026-07-08

### Computer Use: GNOME Wayland froze on opening a Code session - portal consent dialog fired on plain window enumeration (#184)

Opening (or resuming) a Code session makes upstream warm it with a `listRunningApps` call. On GNOME Wayland our executor routed that through `gnome-portal-bridge` with a blanket "ensure the portal session first" before every bridge call, so a plain window enumeration popped GNOME's Remote Desktop consent dialog ("Un'app vuole condividere lo schermo") and the synchronous `session-start` (`execFileSync`, 30s timeout) froze the Electron main process while the dialog was pending - cancelling it led to GNOME's force-quit prompt. Downgrading to v1.18286.0-2 avoided it only because that release predates the bundled bridges; upstream 1.18286.2 itself is not at fault.

Two changes fix it: (1) the portal session is now ensured only for subcommands that actually go through the XDG RemoteDesktop/ScreenCast portal (pointer, key, type, capture); enumeration subcommands (`windows`, `frontmost-app`, `app-under-point`, `screens`) are plain GNOME Shell Introspect / Mutter D-Bus calls inside the bridge and never touch the portal - so opening a Code session no longer shows any dialog. (2) The session lifecycle driven by the CU lock hook (`__setLockHeld`) runs through async `execFile` instead of blocking `execFileSync` - the same non-blocking pattern the KDE/kwin executor already used - so even the legitimate consent dialog during real Computer Use can no longer freeze the UI. A synchronous session-start backstop remains only for a portal command issued without the lock hook having fired, where a consent dialog is expected. Verified with a stubbed-bridge harness: session warm-up performs `windows` only (no `session-start`); input commands still bring the session up first; enumeration calls also drop from the 30s portal timeout to the standard 15s bridge timeout.

## 2026-07-06

### Cowork: troubleshooting docs + Arch install hint (prompted by an Arch setup report)

An Arch user's Cowork setup note (assembled by an AI terminal agent) turned out to be mostly obsolete workarounds, so the audit produced documentation instead of code changes. The OVMF/virtiofsd symlinks it recommends are unnecessary since v1.17377.1 (`fix_cowork_firmware_paths_linux` already probes the distro-native paths); socat is not a Cowork dependency; and the `vhost_vsock` modprobe step is redundant on systemd distros - systemd pre-creates `/dev/vhost-vsock` as a static device node at boot and the kernel auto-loads the module the moment QEMU opens it (verified live on Arch; only non-systemd inits, containers, or kernels built without the module ever need a manual modprobe).

README gains a "Troubleshooting Cowork" section keyed on the popup wordings users actually see ("Download failed", "Virtualization isn't fully set up" / "Cowork requires QEMU", "requires the vhost_vsock kernel module"), leading with `claude-desktop --diagnose` and spelling out the per-distro package commands. The in-app popup keeps upstream's Debian-only `sudo apt install` wording on every distro - deliberately left unpatched (a cosmetic string is not worth another release-blocking patch anchor). The section also states that no firmware/virtiofsd symlinks or manual path configuration are needed - the probe already searches the distro-native locations.

The AUR package now prints the optional Cowork stack once on fresh installs (`sudo pacman -S --needed qemu-system-x86 edk2-ovmf virtiofsd` plus the `kvm` group step, aarch64-aware), since pacman does not install optdepends.

### Release pipeline fixed; gnome-portal-bridge floor corrected to glibc 2.39 / PipeWire 1.0.5+

The first release runs with the new bridges failed on three CI bugs, fixed in sequence: the static-linking verify step only accepted `ldd`'s non-PIE phrasing ("not a dynamic executable") and rejected our genuinely-static static-pie musl binaries (which print "statically linked"); the bridge builds did not pass `--locked`, leaving them exposed to dependency re-resolution; and a comment apostrophe inside a single-quoted `bash -c` block truncated the docker command, leaking build steps onto the bare runner.

The fourth failure was real: gnome-portal-bridge never compiled on the ubuntu:jammy build base, because its pipewire client library (`lamco-pipewire` 0.4.x) needs the `spa_video_info_raw` layout and stream-time APIs (`pw_stream_get_nsec`, `pw_stream_get_time_n`, extended `pw_time`) that only exist in PipeWire >= 1.0.5. Ubuntu 22.04 (PipeWire 0.3.48) and Debian 12 (0.3.65) cannot even load such a binary - the documented jammy floor was never achievable. Decision: build on ubuntu:noble like kwin-portal-bridge. gnome-portal-bridge now requires glibc 2.39 + PipeWire 1.0.5 (Ubuntu 24.04+, Fedora 40+, Debian 13+); GNOME Wayland on older distros falls back to X11/XWayland or `GNOME_PORTAL_BRIDGE_BIN`. Docs updated across README, CLAUDE.md, and computer-use-dependencies.md.

### Quick Entry: cursor + focus via bundled x11-bridge - xdotool and hyprland dropped from packaging

Quick Entry was the last consumer of `xdotool` (cursor position for monitor placement, window activation for focus) and the reason `hyprland` sat in the dependency lists. `fix_quick_entry_position.nim` now calls the bundled `x11-bridge` (`cursor-position`, `activate-window`) on X11/XWayland; on Hyprland it uses `hyprctl`, which ships with the compositor itself and needs no package. With that, `xdotool` and `hyprland` are gone from Arch optdepends, Debian/Ubuntu and Fedora/RHEL Suggests, and the Nix package inputs - on Nix this also stops `callPackage` from pulling the entire Hyprland compositor into the closure just for `hyprctl`. The remaining soft CU deps are only the residual tiers: `ydotool` (exotic Wayland compositors) and `imagemagick`+`spectacle` (KDE below Plasma 6.6).

### Diagnostics visible again: new claude-patches.log (official build discards console output)

The official `.deb` Electron build silently discards main-process `console.log`/`console.warn` - not to the terminal, not to `main.log`, the lines just vanish (the file descriptors are healthy; proven by writing into `/proc/<pid>/fd/1` directly while `console.log` in the same process produced nothing). All our patch diagnostics (`[claude-cu]`, `[quick-entry]`, `[CustomThemes]`, `[claude-profile-route]`, …) were therefore invisible since the pivot to the official `.deb`. They now go through an injected `__cdbDiag` sink that writes to `~/.config/Claude/logs/claude-patches.log` (profile/3p-aware, 2 MiB rotation) and to raw fd 2, which does reach a terminal launch. Docs updated accordingly - "run from a terminal and copy the output" no longer works for console-based lines.

### Bridge resolution simplified: fixed bundled path, like upstream's own binaries

The four CU bridges now resolve the same way upstream resolves its bundled binaries (e.g. `chrome-native-host`): the `*_BRIDGE_BIN` env override, else the fixed bundled `locales/` dir - one shared resolver instead of three copy-pasted candidate loops. The `$PATH` fallback is gone: bridges ship in the package, so a missing bridge is a packaging bug that should fail loud, not be masked by a stray system binary.

### Docs: one Computer Use entrypoint instead of per-distro sections

Since all four bridges are bundled, the near-identical "Computer Use - nothing to install" paragraphs in the Arch, Debian/Ubuntu, and Fedora/RHEL install sections were removed; the Installation intro now says it once and the `## Computer Use` section is the single entrypoint. The NixOS note was trimmed to Cowork plus a one-sentence caveat linking to a new `## NixOS` section in `docs/computer-use-dependencies.md`.

### CI: install host gcc for the static bridge container builds

The first real run of the new x11-bridge/wlroots-bridge build steps failed with `linker 'cc' not found`: cargo build scripts always compile for the host gnu triple and need a host `cc`, even though the musl targets themselves link via rust-lld. Both container steps now install `gcc` + `libc6-dev` (still no cross-gcc or musl-gcc).

### Computer Use: bundled wlroots-bridge + gnome-portal-bridge - every supported session is now first-party (no more ydotool/grim/gnome-screenshot)

Two new first-party bridges complete the Computer Use backend family, so every supported session type now ships a bundled binary and users install nothing:

- **wlroots-bridge** (github.com/patrickjaja/wlroots-bridge) serves Sway, Hyprland, and Niri via native Wayland protocols: virtual-pointer + virtual-keyboard for input, wlr-screencopy for screenshots, and foreign-toplevel for window listing and activation (activation verified working on all three compositors). Pure Rust, fully static (x86_64 + aarch64, runs on NixOS), daemonless, no permission dialogs. It replaces `ydotool`, `grim`, and the `hyprctl` / `swaymsg`+`jq` / `niri msg` window queries.
- **gnome-portal-bridge** (github.com/patrickjaja/gnome-bridge) serves GNOME Wayland via the XDG RemoteDesktop + ScreenCast portal with PipeWire capture. One system consent dialog per Computer Use session, scoped to the tool-use lock; on GNOME 46+ the grant persists via restore token and is never asked again. It replaces `ydotool` and the whole GNOME screenshot cascade (embedded python3+GStreamer portal script, `gnome-screenshot`+`convert`, `gdbus`), and adds best-effort window enumeration via GNOME Shell Introspect - a capability GNOME previously had none of. Floor: glibc 2.39 + PipeWire 1.0.5 (built on ubuntu:noble; see the pipeline-fix entry above), x86_64 + aarch64.

The third-party cascades for these sessions were removed from the executor, mirroring the earlier x11-bridge cutover: on wlroots and GNOME sessions the bridge is the path, with `COWORK_SCREENSHOT_CMD` as the only override and Electron `desktopCapturer` as the last-resort screenshot tier. `ydotool` remains only for exotic Wayland compositors (none of wlroots/GNOME/KDE), and `spectacle`+`convert` only for KDE without KWin 6.6+. Packaging was simplified accordingly: `grim`, `jq`, `gnome-screenshot`, `glib2`/`libglib2.0-bin` (gdbus), `python-gobject`/`python3-gi`, and `gst-plugin-pipewire`/`gstreamer1.0-pipewire` are gone from optdepends/Suggests across Arch, Debian/Ubuntu, Fedora/RHEL, and Nix; `ydotool`/`imagemagick` stay with residual-only descriptions. On NixOS the static bridges work as bundled; GNOME Wayland needs a natively built gnome-portal-bridge passed via `.override { gnome-portal-bridge = ...; }`.

CI builds both new bridges from their repos (cached by HEAD SHA, static assert for wlroots-bridge, glibc-2.39 floor check for gnome-portal-bridge) and bundles all four bridges into every package. Docs (README install sections, computer-use docs, support matrices) were rewritten for the new reality.

### Computer Use: new bundled x11-bridge is the first-party X11 backend (no more xdotool/scrot/etc.)

X11 / XWayland Computer Use is now served by a bundled first-party binary, `x11-bridge`, instead of the third-party tools. It handles input, screenshots, and window activation natively by talking to the X server directly, and it fully replaces `xdotool`, `scrot`, `imagemagick` (`import`), `wmctrl`, and the X11 use of `gnome-screenshot`. There is no third-party fallback on X11 anymore - the bridge is the path. It is a fully-static Rust binary (no C dependencies, no glibc floor), so it runs on every distro and every arch we ship (x86_64 and aarch64). X11 users now install nothing for Computer Use, mirroring how KDE Plasma Wayland already relies on the bundled `kwin-portal-bridge`. Wayland-native sessions are unchanged: `ydotool` plus `grim` / `gnome-screenshot` / portal + PipeWire remain required for wlroots (Sway/Hyprland/Niri) and GNOME. The bridge lives in its own repo (github.com/patrickjaja/x11-bridge) and CI builds both arches from source and bundles them into the tarball.

### Computer Use: v1.18286 handler realignment and Cowork gate fix

Several Computer Use fixes landed for the v1.18286 bundle:

- The `chicagoEnabled` gate that had disabled Computer Use inside Cowork sessions was corrected, so CU is available in Cowork again.
- The Linux CU handler was realigned to v1.18286's schema changes: the zoom region format, `computer_batch` image handling, coordinate scaling, and teach-mode anchor mapping.
- `open_application` now activates an already-open window (via the bridge) instead of only launching a new instance.
- `request_access` de-duplicates grants so repeated access requests no longer stack.

### Launcher: --1p / --3p deployment-mode selector (upstream removed --boot-1p-once)

The upstream one-shot flag `--boot-1p-once` (MSIX-era) is no longer read by the official `.deb` bundle - the only remaining user-side switch is the persisted `deploymentMode` key in `~/.config/Claude-3p/claude_desktop_config.json`. The launcher now offers `claude-desktop --1p` / `--3p` to write that key before launch (per-profile aware; persistent until switched back), and passing the removed `--boot-1p-once` exits with a pointer to the new flags. Root cause worth knowing: after deleting `managed-settings.json` the app can still boot 3P because the applied local-settings entry in `~/.config/Claude-3p/configLibrary/` (written by the in-app 3P Setup UI) also carries the inference provider - `docs/third-party-inference.md`'s gotchas section was rewritten to describe the real config-source chain and the exit paths.

### Computer Use: recognize Niri (issue #181)

The Linux executor's wlroots detection only checked `SWAYSOCK` and `HYPRLAND_INSTANCE_SIGNATURE`, so on Niri the `grim` screenshot path was never tried even with `grim` installed - Computer Use screenshots failed. `_isWlroots()` now also checks `NIRI_SOCKET` (Niri speaks the same wlr-screencopy protocol grim uses). The same gap existed in Wayland window discovery: `getFrontmostApp` and `listRunningApps` only had Hyprland/Sway backends; both gained a Niri backend via `niri msg --json focused-window` / `windows`. Startup diagnostics now list `niri` as a relevant tool on Niri sessions. Docs updated to include Niri in the Wayland session matrix.

## 2026-07-03

### Full 45-patch + distro-gap audit vs v1.18286.0: all patches valid, three hygiene fixes

A five-agent audit re-verified every patch 1:1 against a fresh v1.18286.0 extract (semantic match sites, upstreaming checks, guard validity) plus a four-surface Debian-bias sweep (hardcoded paths, Cowork VM probes, updater, desktop integration) against the Arch/Fedora/RHEL/NixOS/AppImage matrix. Result: no patch is obsolete or matching a wrong site; the bump was a pure re-minify; no new distro gaps introduced. Verified our own .deb postinst does not inherit upstream's dormant apt self-update repo. Two known latent items logged, not fixed (no user reports): MCPB signature verify hardcodes `-CApath /etc/ssl/certs` (only affects Fedora/RHEL minimal images without the compat symlink), and the missing-QEMU error hint says `sudo apt install` on every distro.

Hygiene fixes from the audit:

- **`fix_cross_device_rename`**: the "already patched" guard was unreachable - re-running the patch on patched output would double-wrap all 19 rename sites instead of no-opping. Added a lookahead that skips already-wrapped calls; verified twice-apply is now a clean no-op (marker count stays 19).
- **`fix_computer_use_linux`**: corrected a stale Patch 11 comment (Patch 2 adds "linux" to the CU platform set, so `dq()`'s `IRA.has()` is true on Linux; the stub path stays unreachable because Patch 6 dispatches before it).
- **`baseline/ION.md`**: CSS bundle count row updated to 27 (v1.18286.0); removed a stale "possibly new this bump" tag.

### Upstream bump v1.17377.2 -> v1.18286.0: three patches re-anchored after the auto-release failed

The 2-hourly version check dispatched an auto-release for v1.18286.0 and it failed (tracking issue #176). The bump is a full re-minify plus a few small refactors; three patches needed work:

- **`enable_local_agent_mode`**: GrowthBook flag `1496676413` (SSH remote MCP/plugin passthrough) was removed upstream - the feature went unconditional (`createSpawnFunction` lost the flag argument, `resolveSshControllerForMcp` returns the controller whenever an sshConfig exists). Patch 3n deleted (19/19 sub-patches), with a guard that fails the build if the flag ever reappears.
- **`fix_buddy_ble_linux`**: the Buddy flag gate gained a new `workspace.hardwareBuddyEnabled` setting in its chain (upstream's new Cowork "Hardware Buddy & Maker Devices" BLE feature). Re-anchored so only the GrowthBook half is forced - the user's hardwareBuddyEnabled toggle keeps working.
- **`fix_computer_use_linux`**: upstream re-shaped the CU enable gates - the old isEnabled/rj pair merged into a `wS()` (pref-respecting) / `bue()` (flag-gated, pref-ignoring) / `dq()` (stub-mode nudge) family, the `handleToolCall` body was extracted into `vgn()` with teach-mode telemetry, and the tool wrapper gained an abort timeout. Patches 5b/6/11/12 re-anchored: `wS` gets the Linux pref-respecting branch, `bue` delegates to the patched `wS` on Linux (so a remote flip of its gating flag can't switch CU back off), and `dq` stays untouched (false on Linux keeps the "enable in settings" nudge path off). CI only reported 2 of the 4 - Patch 6's abort-on-failure had masked the downstream 11/12 failures. 36/36 sub-patches apply; a live Computer Use smoke-test after install is recommended since the handler was restructured.

Audits came back clean: platform-gate counts byte-identical (darwin 78 / win32 128 / linux 12 - no new PORTABLE opportunities, no new Linux blockers), the Cowork VM capability probe is structurally unchanged, resources identical (no new binaries), IPC additions purely additive (Claude Code PR/CLI-status channels, CU remote-lock release, file-preview open-in-default-app), ion-dist patch applies unchanged, GrowthBook +8/-4 with nothing needing forcing. Official docs (code.claude.com/docs/en/desktop-linux) still list Computer Use as not available on Linux - our CU stack remains the only one. Baseline docs updated (CLAUDE_FEATURE_FLAGS.md renames `sM()`/`Yue`/`rt()` + history row, PLATFORM_GATE_BASELINE.md, ION.md).

@boommasterxd independently root-caused and fixed the same three patches in PR #179 (merged) - both analyses agreed on every root cause. Where the approaches differed, the stricter/pref-preserving variant won: his `resolveSshControllerForMcp` regression guard and the `\6` setTimeout backref were adopted; our ternary-anchored CU gate patches (which keep the `chicagoEnabled` user pref working for tool listing) and the toggle-respecting Buddy anchor were kept.

### NixOS Cowork "requires QEMU" while --diagnose passes: root-caused, diagnose false-positive fixed, env overrides added (#177)

On NixOS the in-app probe failed on **virtiofsd** while `claude-desktop --diagnose` claimed the capability probe "SHOULD pass". Two distinct bugs:

- **`--diagnose` false positive**: the launcher listed the bundled `resources/locales/virtiofsd` as an unconditional candidate, but the app only uses the bundled copy on Ubuntu 22.x (`/etc/os-release` gate) - on every other distro a missing system virtiofsd means `virtiofsdPath=null` and the "Cowork requires QEMU ... virtiofsd" message. The diagnose replica now mirrors the Ubuntu-22 gate and prints an actionable NOT-FOUND hint instead.
- **No way to point the probe anywhere on NixOS**: the probe's candidate lists are fixed `/usr/...` paths that NixOS never populates. `fix_cowork_firmware_paths_linux` now prepends two env-var overrides to the probe arrays (conditional spreads, no-ops when unset): `CLAUDE_VIRTIOFSD_PATH` and `CLAUDE_OVMF_CODE_PATH` (CODE image; the VARS sibling is derived by name next to it). Injected into both the x86_64 OVMF and arm64 AAVMF arms (3 sub-patches, strict).

The Nix package now resolves `virtiofsd` and `OVMF` from nixpkgs automatically (like `qemu`) and wires them via those env vars - Cowork on NixOS needs no tmpfiles symlink hacks from this release on. README and package.nix notes corrected: they previously claimed "virtiofsd is bundled" and omitted the system-virtiofsd requirement entirely; the Cowork setup section now documents it for all non-Ubuntu-22 distros, plus the new env overrides.

Independently root-caused and fixed in parallel by @boommasterxd (PRs #178 and #179, merged) - both analyses agreed on the Ubuntu-22-gate root cause and the diagnose bug. Merged from his PRs on top of the above: the `/run/current-system/sw/bin/virtiofsd` probe candidate (covers NixOS installs that bypass our Nix wrapper, e.g. AppImage, via `pkgs.virtiofsd` in `environment.systemPackages`), the `--diagnose` hint line when the bundled virtiofsd exists but is correctly ignored, and the stronger `enable_local_agent_mode` Patch 3n regression guard (asserts `resolveSshControllerForMcp` stays unconditional instead of only checking the removed flag ID is absent).

## 2026-07-02

### M365 local connector: OAuth browser now opens reliably on KDE (and everywhere else) (#139)

The built-in Microsoft 365 connector's sign-in browser failed to open on KDE even after the env-allowlist fix: with `XDG_CURRENT_DESKTOP=KDE` but no `KDE_SESSION_VERSION`, `xdg-open` falls into its KDE3-era `kfmclient exec` fallback, which exits 0 without opening anything - a silent no-op that ends in `LocalAuthSignInCooldownError` after the 300s sign-in ceiling. Fixed twice over:

- **`fix_builtin_mcp_browser_env`**: `KDE_SESSION_VERSION` added to the forwarded vars, so `xdg-open` uses `kde-open5`/`kde-open` (kde-cli-tools, present on every Plasma install) and real failures exit loud instead of lying.
- **New patch pair `fix_office365_mcp_open_url` + `fix_builtin_mcp_open_url_handler`**: the connector's browser-open is delegated to the Electron main process. The MCP child posts `{type:"open-url", url}` over its existing `parentPort` channel and the host's message handler routes it to `shell.openExternal` (https-only) - the exact mechanism remote OAuth connectors (Atlassian) already use, which is why those worked on KDE all along. Immune to every `xdg-open` quirk; the in-child spawn remains as fallback for standalone (non-utilityProcess) runs.

Also re-verified empirically (remove patch -> browser dead, restore -> works) that upstream v1.17377.2 still strips `DISPLAY` from the MCP host env, so the allowlist patch stays load-bearing; the "official build works on GNOME" report in the issue traces to a cached token, not a working browser launch. Upstream cannot open a sign-in browser for this connector on any Linux DE.

### Packaging hygiene: complete dependency declarations + license file shipped in every package

Prompted by a community PKGBUILD comparison (thanks marcelvdh), audited our dependency declarations against the actual ELF linkage of every binary we ship (`objdump -p | grep NEEDED` on the Electron main binary, crashpad handler, bundled virtiofsd, and node-pty's `pty.node`) plus the official `.deb`'s control file:

- **AUR:** `depends` grown from 3 packages (`alsa-lib gtk3 nss`) to the full grounded list of 31. Notable additions most Electron PKGBUILDs miss: `libcap-ng` + `libseccomp` (linked by the bundled virtiofsd the official `.deb` ships), `libsecret` (dlopened by Chromium's keyring credential storage, invisible to linkage scans), `systemd-libs` (libudev), and `gcc-libs` (libstdc++ for `pty.node`). New optdepends: `gnome-keyring` and `xdg-desktop-portal-gtk`. Also added `!emptydirs`.
- **Our .deb:** `Depends`/`Recommends` now fully mirror the official control - added the trash-handling alternation (`kde-cli-tools | ... | gvfs`), the portal backend alternation (`xdg-desktop-portal-gtk | -gnome | -kde`), and `gnome-keyring | kwalletd6 | kwalletd5`.
- **RPM:** added `libsecret`, `xdg-utils`, `xdg-desktop-portal` (rpm's auto-requires scan catches linked sonames but not dlopen), plus `Suggests: gnome-keyring`.
- **License file:** no package shipped one. The tarball now carries the official `.deb`'s `usr/share/doc/claude-desktop/copyright` at its root, and every packager installs it: AUR to `/usr/share/licenses/claude-desktop-bin/LICENSE`, deb to `usr/share/doc/claude-desktop-bin/copyright` (Debian policy), RPM via `%license`, AppImage into the AppDir, Nix to `$out/share/licenses/` (guarded - the flake may pin an older tarball without the file).
- **Deleted dead `packaging/debian/control`** - the shipped `.deb`'s control file is generated by a heredoc in `packaging/debian/build-deb.sh`; the standalone file was an unused leftover that invited editing the wrong place.
- **Clarified why the official `.deb` bundles its own `virtiofsd`** (and corrected a wrong comment in `fix_cowork_firmware_paths_linux.nim` that claimed a general bundled fallback): the capability probe uses the bundled `resources/virtiofsd` **only on Ubuntu 22.x** (`os-release` check - jammy's apt has no standalone Rust virtiofsd); on every other distro a system virtiofsd is required or Cowork reports "tools missing". Our `virtiofsd` optdepends (Arch, found via our added `/usr/lib/virtiofsd` probe path) and Recommends (deb/rpm) are therefore load-bearing and stay.

### Upstream version bumps now release fully automatically; manual update flow becomes the failure path

Consequence of the `.deb` pivot: upstream maintains 1p Linux support and the patch strictness rules make the pipeline itself the arbiter (every sub-patch applies or the build fails loud), so the human-in-the-loop on the green path was removed. `version-check.yml` now dispatches `build-and-release.yml` in **release mode** on a new version (previously auto-PR mode, which needed a human merge plus a second manual dispatch). Green run → packages published, AUR pushed, README versions + Nix hash + `.upstream-version` committed, and the tracking issue closed automatically (new `close-version-issue` job). Red run → a new `notify-version-issue-failure` job comments on the tracking issue with the failed-run link; that comment is the signal to run `/update <version>`, where the first question per failing patch is now explicit: pattern moved (fix the regex) vs feature natively implemented upstream (remove the patch or convert to a regression guard). The `auto_pr` mode stays available as a manual conservative alternative. Docs realigned (CLAUDE.md Update Workflow + `.upstream-version` row, update-prompt.md, UPDATE-PROMPT-CC-INPUT-MANUAL.md, the `/update` skill, and the new-version issue template - which also lost its stale `claude-cowork-service` clone instructions). Known limit stated in the docs: a green build proves patches applied, not runtime correctness (#173 was remote-side); the guard is strict counts + positive assertions + smoke test, plus a spot-check after notable bumps.

### Full patch sweep vs the official .deb: 43 of 44 patches earn their keep; 1 removed, 2 cleaned up

A 5-agent review of every patch against a fresh unpatched v1.17377.1 bundle (lens: "which patches still assume the old MSIX/Windows build?") confirmed the pivot cleanup is essentially complete. Outcomes:

- **`fix_locale_paths_pre` removed.** The bootstrap bundle (`index.pre.js`) has zero `process.resourcesPath` references, so the patch was a byte-identical no-op - deleted under the same delete-pure-no-op-guards policy as yesterday's removals. If upstream ever moves locale resolution into the bootstrap, it needs a new dedicated `@patch-target` patch (noted in `fix_locale_paths`).
- **`fix_process_argv_renderer` simplified.** Dropped two dead fallback anchors (one matched a phantom `.platform="win32"` spoof pattern that no longer exists anywhere); the primary `exposeInMainWorld` anchor is the only live path and still applies cleanly.
- **`fix_tray_icon_theme` header rewritten.** The comment described the pre-v1.13576 win32-only ternary; it now documents the actual native Linux switch (`ere()==="gnome"||shouldUseDarkColors` picking `TrayIconLinux*.png`) and why we deliberately override that heuristic (Linux trays are dark regardless of theme). Code unchanged.
- Everything else verified KEEP: upstream v1.17377.1 still ships zero Linux Computer-Use backends, still gates browser tools / file dialogs / Visualize behind darwin/win32, and the profile/Quick Entry/theme features remain entirely ours. Two agent claims that patches were "fully upstreamed" (`fix_cross_device_rename`, `fix_utility_process_kill`) were refuted by running the patch binaries against the fresh bundle - both still mutate (19 and 1 sites) and stay.
- A follow-up sweep of the build infrastructure (scripts, CI, launcher) found the pivot equally clean - only ~40 lines of dead weight removed: the disabled `cowork-vm-service` socket-cleanup block in the launcher and the matching noise filter in `smoke-test.sh` (both referenced the removed Go daemon), two stale MSIX-era comments, and CLAUDE.md's link to `validate_and_fix_claude-setup-x64.md` (an MSIX-era scratch file that was never tracked in git). Docs refreshed to match today's patch changes: README rows for `enable_local_agent_mode` and `fix_tray_icon_theme`, and the "What We Patch on Linux" section of `CLAUDE_FEATURE_FLAGS.md` (7-key merger override, Patch 1b as regression guard, removed-spoofs note).
- The ~15 GrowthBook force-flips in `enable_local_agent_mode` were considered for removal now that the app reports `linux` honestly - and ruled out with live evidence. The feature payload a real session fetches from `/api/desktop/features` (disk cache `~/.config/Claude/fcache`, gzip after an 8-byte `CLF` header) contains all 200 features as `null` with zero rules, and the post-fix fetch logged `0 changed` versus the spoofed-era cache - so honest platform reporting unlocked nothing server-side. Without the force-flips every gated lookup returns null and the features (Code session launch, tool search, skills, Visualize, plugin state, ...) switch off. They stay.

### Removed the MSIX-era platform spoofs - fixes Cowork showing "not supported on Windows" on Linux (#173)

`enable_local_agent_mode` no longer spoofs the platform anywhere: sub-patches 5 (HTTP header `anthropic-client-os-platform: darwin`), 5b (Macintosh `User-Agent`), 6 (`getSystemInfo` IPC returning `win32`), and 8 (`navigator.platform = "Win32"` + Windows `userAgentFallback` injected into every renderer window) were deleted. They date from the repackaged-Windows-build era, when claude.ai had to be tricked into enabling Cowork on Linux. Against the official Linux `.deb` - which reports `linux` natively and is supported by claude.ai - they backfired: the renderer's client-side platform check saw Windows and its Cowork gate replied "Cowork is not currently supported on Windows" (the message is remote claude.ai code, so it appeared without any desktop release). The renderer now sees the real platform. Two positive guards replace the spoofs: the header builder must send the raw `.platform` read, and the old navigator-spoof marker must be absent from the output (catches stale pre-patched inputs).

### README: documented Arch Linux ARM's missing `edk2-aarch64` package (#170)

Arch Linux ARM (and derivatives like EndeavourOS ARM, Manjaro ARM) doesn't carry `edk2-aarch64` in its repos, even though the package is `arch=any` upstream on archlinux.org - so `pacman -S edk2-aarch64` fails with `target not found` on native aarch64 hosts (e.g. Raspberry Pi 5), even after a full `-Syu`. Since the package is architecture-independent, the workaround is to grab it directly from an x86_64 Arch mirror and install it locally with `pacman -U`. Added this note (with the manual-install command) to both Arch Cowork-deps sections in the README.

### Removed two no-op regression guards (`fix_disable_autoupdate`, `fix_terminal_shell_linux`)

Both patches had become pure no-ops - they mutated nothing and only asserted upstreamed behavior - so they were deleted rather than kept as empty guards. `fix_disable_autoupdate` used to inject a Linux short-circuit into the Squirrel `isInstalled` check; the official `.deb` now bails out of the update manager unless `forceInstalled` (false on our repackaged app), so auto-update is already off. `fix_terminal_shell_linux` used to rewrite a hardcoded `powershell.exe` default into a `$SHELL → /bin/bash → /bin/sh` ternary; the official `.deb` ships a proper POSIX shell resolver and the `powershell.exe` default is gone. Verified against a fresh unpatched v1.17377.1 bundle: both ran to exit 0 with zero byte changes. `PLATFORM_GATE_BASELINE.md` updated.

### Removed `fix_claude_code` (Claude Code binary resolution is upstream-native on Linux)

The `fix_claude_code` patch was deleted after verifying against a fresh unpatched v1.17377.1 bundle that the official `.deb` resolves and downloads the Claude Code CLI natively on Linux. Its two mutating sub-patches did more harm than good: `getBinaryPathIfReady()`/`getStatus()` searched `/usr/bin/claude`, `~/.local/bin/claude`, `/usr/local/bin/claude`, then `which claude`, and preferred that over the app's own managed binary - bypassing `requiredVersion` + checksum verification. Anyone with a stale or wrong-major-version `claude` on `PATH` (e.g. a global npm install) got it silently substituted, a source of bug reports rather than a fix.

None of it is needed anymore: `getHostPlatform()` returns `linux-x64`/`linux-arm64` natively, the manifest carries a checksum-verified `linux-x64` entry, and `prepare() -> prepareForTarget() -> binaryExistsForTarget() -> downloadBinaryForTarget()` fetches and verifies the CLI matching `requiredVersion` with no darwin/win32 gating. Users who genuinely want to pin their own binary use the sanctioned opt-in `CLAUDE_CODE_LOCAL_BINARY=/path/to/claude` (routed through upstream's `initLocalBinary()`). The third sub-patch was already just a no-op regression guard asserting the native `getHostPlatform()` Linux branch, so the whole patch was removed rather than kept as an empty guard. README (patch table, per-distro setup notes, Cowork section), `PLATFORM_GATE_BASELINE.md`, and the AUR `optdepends` note updated to drop the "Claude Code CLI required" claim. (Contributor-reported.)

### Cowork VM deps recommended (matching upstream); README slimmed (3P, env-vars, Computer-Use deps moved to docs; optional deps inlined per distro)

- **QEMU + UEFI firmware + virtiofsd declared as recommended deps, mirroring Anthropic's official `.deb`.** The official Claude Desktop `.deb` lists `qemu-system-x86, ovmf, virtiofsd` in `Recommends:` (verified by extracting v1.17377), and its docs mention no KVM/QEMU prerequisite at all. We match that: `apt`/`dnf` pull the Cowork VM deps by default (so Cowork works out of the box) but they stay soft - never blocking install on minimal/headless/KVM-less or immutable hosts, and no forced ~400 MB of QEMU on Chat/Code-only installs. Package names are architecture- and distro-specific: Arch `qemu-system-x86` + `edk2-ovmf` (x86_64) / `qemu-system-aarch64` + `edk2-aarch64` (aarch64) as `optdepends`; Fedora `qemu-system-x86` / `qemu-system-aarch64` (RHEL uses `qemu-kvm`, gated with `%if 0%{?rhel}`) + `edk2-ovmf` / `edk2-aarch64` as `Recommends`; deb `qemu-system-x86` + `ovmf` (amd64) / `qemu-system-arm` + `qemu-efi-aarch64` (arm64) as `Recommends`. Corrected two wrong names caught in review: Arch's `qemu-base` carries no emulator binary (and is x86_64-only), and `qemu-system-x86`/`-aarch64` don't exist on RHEL (it uses `qemu-kvm`). Using Cowork still needs the `kvm` group and the Claude Code CLI - a package can't do either. Computer Use tools stay optional; AppImage/Nix can't auto-install system packages, so they keep the manual instructions.
- **README Installation section reworked for a quicker start** - each distro subsection (Arch/Debian/Fedora/Nix/AppImage/source) now carries its own "Optional deps" note with the distro-correct Cowork + Computer Use commands, right under the install command. The notes are accurate per package manager: apt `Recommends` / dnf weak deps pull the VM deps in by default, but pacman does **not** auto-install `optdepends` (explicit command given), and AppImage/Nix can't auto-install at all. The two universal setup steps (kvm group + Claude Code CLI) are stated once up top.
- **`Third-Party / Enterprise Inference` trimmed to a teaser + link.** The full content already lived in [`docs/third-party-inference.md`](docs/third-party-inference.md); the README now points there instead of duplicating it.
- **`Environment Variables` moved to [`docs/environment-variables.md`](docs/environment-variables.md).** The README keeps the four most-reached-for vars inline and links out for the full table.
- **`Computer Use dependencies` section removed; deps inlined per distro + reference moved to [`docs/computer-use-dependencies.md`](docs/computer-use-dependencies.md).** Each Installation subsection now lists the Computer Use packages for that distro (session-broken-out) alongside the Cowork deps; the new doc holds the full matrix, the KDE/GNOME portal behavior notes, `COWORK_SCREENSHOT_CMD`, and the `ydotool` v1.0+ setup (incl. the Ubuntu/Debian build script).
- **`Computer Use` feature section trimmed to a teaser + link → [`docs/computer-use.md`](docs/computer-use.md).** The README keeps a short USP paragraph; the new doc holds "how it works on Linux," the notes (primary-monitor, app discovery, teach overlay), and the tool-reference link. The `#computer-use` anchor is preserved so existing cross-links still resolve.
- **Fixed `ydotool` scope in the install notes:** it's needed on Sway/Hyprland/GNOME Wayland; KDE Plasma Wayland needs none (the bundled `kwin-portal-bridge` handles input). Each distro's Computer Use deps became a per-session copyable command block.

### Removed `fix_dispatch_linux` (Dispatch is upstream-native on Linux)

Dispatch (phone->desktop task orchestration) now works on the official Linux `.deb` with no patch - live-tested by sending a task from phone to desktop and receiving the rendered response on v1.17377.1. Over several releases upstream shipped everything the patch used to force: the sessions-bridge inits on Linux, the mobile remote-session-control path runs, the platform label returns "Linux", and the terminal MCP server's old `pj` (darwin||win32) gate was dropped entirely. The patch was deleted; docs (README patch table, `PLATFORM_GATE_BASELINE.md`, `CLAUDE_FEATURE_FLAGS.md`, `CLAUDE_BUILT_IN_MCP.md`) updated to note the upstreamed behavior.

Also re-audited the remaining 47 patches against a fresh unpatched v1.17377 bundle. Every other patch either still mutates the bundle (the bug/gate it fixes is still present) or is already a regression guard - so no further patches were redundant. Dispatch was the only one.

### Pivot: repackage the official Claude Desktop Linux `.deb`

Anthropic shipped an official Claude Desktop Linux beta ([docs](https://code.claude.com/docs/en/desktop-linux)). This project now repackages that official `.deb` instead of the Windows MSIX, and the sibling `claude-cowork-service` daemon is deprecated.

- **New ingest pipeline.** The build downloads the official `.deb` from the apt repo (`https://downloads.claude.ai/claude-desktop/apt`), verifies GPG + SHA256, extracts and patches its `app.asar`, and repackages for Arch/Fedora/RHEL/Nix/AppImage plus our own Debian/Ubuntu `.deb`. `version-check.yml` now polls the apt Packages index.
- **Dropped the Electron pin and node-pty rebuild.** The official `.deb` bundles Electron 42.5.1 and pre-built `node-pty` for x86_64 and arm64. Deleted `.electron-version`, `.electron-shasums`, and the `resolve-electron-version.sh` / `update-electron-shasums.sh` / `verify-electron.sh` / `rebuild-pty-for-arch.sh` scripts.
- **Cowork now runs on the official native VM backend.** The `.deb` bundles cowork-linux-helper + virtiofsd + smol-bin + QEMU/OVMF (requires `/dev/kvm`), so the `claude-cowork-service` Go daemon is no longer needed or installed. The 7-patch "cowork-wiring" cluster (`fix_cowork_linux`, `fix_cowork_first_bash`, `fix_cowork_spaces`, `fix_cowork_error_message`, `fix_cowork_download_status_linux`, `fix_cowork_sandbox_refs`, `fix_vm_session_handlers`) was removed; what remained became regression guards asserting the upstreamed native behavior.
- **Dropped the obsolete `@ant/claude-native` stub (`patches/claude-native.js`), which fixed "Download failed".** The MSIX-era stub overwrote upstream's real Linux NAPI binding and lacked `connectUnixSocketSameUid`, so the VM capability probe returned `virtualization_entitlement_missing`. The official `.deb` ships a real Linux binding; removing the stub lets it through and Cowork starts.
- **New patch `fix_cowork_firmware_paths_linux`.** On non-Debian distros the VM probe only searched the Debian OVMF paths, so `firmwarePath` was null and Cowork stayed unsupported. The patch adds the Fedora/RHEL and Arch UEFI firmware paths (only those whose `OVMF_CODE`→`OVMF_VARS` derivation yields a real VARS file) plus Arch's `/usr/lib/virtiofsd`. openSUSE and generic-qemu symlinks are a known gap.
- **Launcher guarantees a usable `$PATH`.** Menu launches gave `systemd --user --scope` an empty `PATH`, so the backend's `qemu-system-x86_64` lookup found nothing and reported "VM not supported". The launcher now injects the standard system bindirs via `systemd-run --setenv`.
- **Cowork runtime dependencies declared** (QEMU + OVMF/AAVMF firmware + virtiofsd; not bundled). Cowork needs them plus `/dev/kvm` and `kvm`-group membership. Kept soft (recommended, matching the official `.deb`) - see the "Cowork VM deps recommended (matching upstream)" entry above for the final per-arch/-distro package names.
- **Full patch re-audit vs the official `.deb`.** Three cleanups: `enable_local_agent_mode` no longer force-marks the Cowork VM features (`yukonSilver`/`yukonSilverGems`/`coworkKappa`/`coworkArtifacts`) as supported, so support reflects the real native probe; `fix_sensitive_dirs_linux` tightened its anchor to stop an over-application into an unrelated array; `fix_claude_code`'s `getHostPlatform()` sub-patch became a regression guard (upstream now returns `linux-x64`/`linux-arm64` natively).
- **glibc floor raised to 2.34** (RHEL 9 / Ubuntu 22.04). Debian 11 (bullseye) is no longer supported.
- **Retained Linux value-adds:** Computer Use (our exclusive feature, absent from the official beta), custom themes, multi-profile instances, and Quick Entry.
- **Doc fix:** the managed config path is `/etc/claude-desktop/managed-settings.json` (read natively; top-level key still `managedMcpServers`), not the old `enterprise.json`. Updated README, CLAUDE.md, and the `/3p` reference.
- **`.upstream-version` bumped to 1.17377.0.**

## 2026-06-30

### Upstream bump v1.15962.1 -> v1.17282.0 (7 patches fixed; all apply)

Full re-minify release, routine for Linux: no new platform gate locks out a Linux feature, no new native modules, no new built-in MCP servers. Seven patches needed rebasing.

- **Native Linux Cowork VM bundle.** The VM-bundle config grew a `unix` key (real `rootfs.img`) alongside `win32` (vhdx), routed through a platform→key mapper (`linux`→`unix`). `fix_cowork_linux` Patch C2 became a regression guard asserting that mapping still exists. (KVM daemon users had to update `claude-cowork-service` to boot `rootfs.img`; native-backend and non-Cowork users unaffected.)
- **`enable_local_agent_mode`:** the removed-upstream `markTaskComplete` GrowthBook flag sub-patch was deleted; the HTTP-header platform spoof was re-anchored on the `"anthropic-client-os-platform"` header string after upstream inlined it as an array literal.
- **`fix_cowork_first_bash` + `fix_cowork_linux` Patch H:** the events-socket connect routine was split into a thin delegating wrapper; both patches gained the new shape.
- **`fix_native_frame`:** widened the `setTitleBarOverlay` anchor to tolerate a new memoization guard.
- **`fix_tray_dbus` + `fix_tray_icon_theme`:** rewritten for the restructured tray destroy expression; the icon switch now uses upstream's newly-shipped `TrayIconLinux*.png` assets.
- **`fix_enterprise_config_linux_pre`:** fixed a `$`-escaping bug when the captured reader fn name (`o$`) was embedded raw into a regex.
- **Baselines re-validated:** registry `QR()`→`xR()`, merger→`X0A`, reader `it()`→`et()`; ion-dist unchanged. New upstream features (DeviceRegistry, DocumentFunnel, Launch preview, PR-review suite, Epitaxy) touch no platform/spawn/native code and need no patch.

## 2026-06-29

### Fix: Fedora package name `gstreamer1-plugin-pipewire` -> `pipewire-gstreamer` (#161)

- **The Fedora/RHEL GNOME-Wayland install command referenced a non-existent package.** `gstreamer1-plugin-pipewire` does not exist in Fedora's repos, so `dnf install` failed with `No match for argument: gstreamer1-plugin-pipewire` ([#161](https://github.com/patrickjaja/claude-desktop-bin/issues/161), reproduced on Fedora 44 Workstation, thanks to the reporter). Fedora ships the PipeWire GStreamer integration as `pipewire-gstreamer` (verified against `mdapi.fedoraproject.org`: present on f43/f44, and it `Provides: gstreamer1(element-pipewiresink)`; the old name returns 400 on every release). This package is a genuine dependency, not boilerplate: the GNOME-Wayland screenshot path in `js/cu_linux_executor.js` runs a GStreamer `pipewiresrc ! videoconvert ! pngenc ! filesink` pipeline, so `pipewiresrc` (from the PipeWire GStreamer plugin) is required for the preferred portal+pipewire screenshot method (it degrades gracefully to `gnome-screenshot` -> `gdbus` -> Electron `desktopCapturer` if absent, which is why it's a `Suggests`/optdepend). Swapped the name in both the README install line and the `Suggests:` in `packaging/rpm/claude-desktop-bin.spec`. Kept `gnome-screenshot` in the README command (valid screenshot fallback).
- **The shipped `.deb` was missing the GNOME-Wayland screenshot deps entirely.** `packaging/debian/build-deb.sh` generates its `control` inline (it does not consume the `packaging/debian/control` template, despite the template being correct), and its `Suggests:` had drifted - missing `gstreamer1.0-pipewire`, `python3-gi`, and `kde-spectacle`. So Debian/Ubuntu `.deb` users (the path CI actually ships) were never suggested the portal-screenshot deps or the KDE screenshot fallback. Brought the generated `Suggests:` back in sync with the template. Audited Arch (`gst-plugin-pipewire`), Debian/Ubuntu (`gstreamer1.0-pipewire`), and the README one-liners - all other distro package names were already correct; Fedora was the only wrong name. Docs/packaging only; no patch or build changes.

### Upstream bump v1.15962.0 -> v1.15962.1 (patch-level, no patch changes)

- **Version bump v1.15962.0 -> v1.15962.1**, a patch-level upstream rebuild with no re-minification. Every minified identifier our patches anchor on is byte-identical to v1.15962.0 - all 53 patches (49 on `index.js`, 2 on `index.pre.js`, 1 on `MainWindowPage`, 1 on `mainView.js`) plus both ion-dist patches applied unchanged, and the patched bundle passes `node --check`. The bundle grew ~170 KB but only in non-patched, non-Linux-relevant code.
- **Baselines re-validated, no updates needed.** Feature-flag registry `QR()`, async merger `HSA`, dev/prod gate `gM()`, flag reader `it()` and yukonSilver fn `Uae()` all still resolve; the GrowthBook flag set is identical (91 IDs, no new/removed), so `enable_local_agent_mode.nim`'s override list and Zod schema still cover every targeted flag. Platform-gate counts and classifications in `PLATFORM_GATE_BASELINE.md` hold exactly (darwin/win32/linux 76/125/10); no new PORTABLE gate, no new native module (`sshcrypto.node` remains the only `.node` require). ion-dist config chunk still carries the `mountPath:{mac:...}` signature.
- **Cowork daemon:** no change required. The RPC surface (`getNetworkDrives` + `configure.networkDrives`) is unchanged from v1.15962.0, still absorbed by the daemon's unknown-method passthrough and non-strict `json.Unmarshal`.

## 2026-06-26

### Themes: dual light/dark variants, corrected token map, per-theme spinners, new Mario theme

- **Light mode was broken for every theme.** The patch forced a single palette onto `:root` *and* `.darkTheme` with `!important` regardless of the app's mode, so the Settings -> Appearance toggle did nothing and dark values bled into light mode (washed-out, unreadable). Each built-in is now **dual-variant** - a `light` block injected on `:root,[data-mode=light]` and a `dark` block on `.darkTheme,[data-mode=dark],.dark` (dark last so it wins on a specificity tie) - and the app toggle now switches variants live. Setting just `activeTheme` is enough; no `themes` block to copy.
- **The override CSS targeted tokens that no longer exist.** A live token extract showed `--accent-main-*`, `--accent-secondary-*` and `--tw-prose-*` were removed upstream, so a chunk of the old theming was dead. Retargeted to the real tokens (`--accent-brand`/`--accent-*`/`--accent-pro-*`), dropped the dead prose block, and added `--df-*` (window chrome: sidebar/content) + `--cds-*` (Code/Cowork, popovers) coverage so those surfaces recolor too. Borders are alpha'd (dark-mode border tokens are authored near-white, so a raw dark value was invisible); decorative glows are gated to dark only. The patch derives `--accent-main-*`/`-secondary-*` aliases so older custom themes still work.
- **`nordic` applied nothing** - the built-in key is `nord` but the folder is `nordic`, so an `activeTheme: "nordic"` silently bailed. Added a `nordic` -> `nord` alias and a loud "theme not found" fallback (no false success). **`catppuccin-latte`** contrast failures fixed.
- **New `mario` theme** (Nintendo): a sky-blue **overworld** light variant and a warm-brick **underground** dark variant, Mario-red brand, coin-gold/pipe-green status colors.
- **Per-theme spinner reshape.** The loading "starburst" is rendered by remote claude.ai code (not the local bundle), so a new injected installer (`js/spinner_injector.js`) swaps its SVG path for a per-theme shape via the patch's `executeJavaScript` hook - mushroom (mario), blossom (sweet), snowflake (nord), cat (catppuccin), coffee cup (latte). Detection matches the star path signature with fallback fragments and fails loud (console `[spinner] matched 0`) if upstream geometry ever drifts.
- All 7 themes ship coordinated light+dark palettes verified to WCAG AA. Docs: `themes/README.md` rewritten for the new schema, `themes/THEME_PREVIEW.html` added, and `baseline/THEME_TOKEN_MAP.md` + `SPINNER_INJECTION_NOTES.md` + `SPINNER_SHAPES.md` capture the v1.15962 token reality. Also fixed `patches/Makefile` to declare the `add_feature_custom_themes -> js/spinner_injector.js` `staticRead` dependency (a JS-only edit now rebuilds the binary). No upstream-version bump.

### Fix: Computer Use broken on Linux - Cowork executor factory fell through to `throw` (#159)

- **Cowork / agent Computer Use failed on Linux with `computer-use executor not implemented for linux`** ([#159](https://github.com/patrickjaja/claude-desktop-bin/issues/159), thanks @Adiker for the precise diagnosis). As of v1.15200 upstream split executor resolution into **two** factories. `fix_computer_use_linux.nim` already (a) injects our full `globalThis.__linuxExecutor` (ydotool/xdotool input, grim/spectacle/scrot screenshots, multi-monitor, KDE kwin-bridge) at app-ready and (b) routes `createDarwinExecutor` to it. But the **second** factory - the one the Cowork/agent path actually calls - has the shape `{const{…,hostBundleId:Z()};if(win32)return …;if(darwin)return …;throw "computer-use executor not implemented for ${platform}"}` with no `linux` branch, so on Linux it fell straight to the throw. This is a *factory dispatch*, not a `process.platform===` guard, which is why a platform-gate count diff didn't surface it.
- **Fix:** new sub-patch (Patch 4d, count 35 -> 36) injects `if(process.platform==="linux"&&globalThis.__linuxExecutor)return globalThis.__linuxExecutor;` immediately before that throw, anchored on the unique `if(process.platform==="darwin")return X(Y);throw "…executor not implemented…"` site. Both factories now resolve to the same already-injected `__linuxExecutor`; the `&&globalThis.__linuxExecutor` guard preserves a clean fallback to the original throw (no regression). Idempotency keys on the linux branch being present *at this throw-site* (Rule 6), not merely existing somewhere (Patch 4 injects an identical string into `createDarwinExecutor`). Matches the one-line fix the reporter verified working (screenshot/click/type/multi-monitor). (Gotcha fixed along the way: the throw interpolates `${process.platform}`, whose body has a `.`, so the placeholder anchor is `[\w$.]+` - `[\w$]+` stops at the dot and silently 0-matches.)

### Upstream bump v1.15200.0 -> v1.15962.0 (4 patches fixed; all apply)

- **Version bump v1.15200.0 -> v1.15962.0**, a full re-minify release. Routine for Linux: no new platform gate locks out a Linux feature (darwin/win32/linux gate counts unchanged at 76/125/10; the only structural change is the *removal* of a macOS-only `disclaimer` Helpers command wrapper, a Linux no-op), no new native modules, no new built-in MCP servers, and the Cowork RPC contract between Desktop and `claude-cowork-service` is functionally identical (same socket name, framing, 22 prior methods, 7 event types, spawn args/env). Three patches needed rebasing for the re-minify (a fourth, `fix_computer_use_linux`, gained a sub-patch for #159 - see the entry above).
- **`fix_quick_entry_cli_toggle`: the Quick Entry show-handler's focus branch gained an argument.** Upstream changed the registration arrow from `?(w.focus(),i9t())` to `?(w.focus(),GZt(tt))` - the focus-branch call now takes the window var. Sub-patch A's anchor required empty parens (`,[\w$]+\(\)\)`), so it matched 0 times. Widened both ternary-branch call arg-lists from `\(\)` to `\([\w$]*\)`. The arrow prefix/body slice is unchanged; sub-patch B (second-instance) was unaffected.
- **`fix_window_bounds`: a new setup call was inserted into the main-window factory.** The factory went from `…Mk(w.webContents,MAIN_WINDOW),w}` to `…ev(tt.webContents,MAIN_WINDOW),Cft(tt),tt}` - a `Cft(tt)` call now sits between the `MAIN_WINDOW` setup call and the trailing `,w}` return, breaking the adjacency the regex anchored on. Added a second lazy `(.*?)` group after the setup call (re-emitted verbatim, so the new call is preserved and the bounds-fix IIFE is injected just before `,w}`).
- **`fix_cowork_linux` Patch G: the smol-bin copy gate was wrapped in a GrowthBook-readiness await.** Upstream changed `if(process.platform==="win32"){const …}` to `if(await BO(),process.platform==="win32"){await L9(5e3),await Promise.race([…]);const …}` (`BO` = `waitForGrowthBookReady`). The old anchor keyed on `if(` immediately before the gate plus the `{const …}` body shape. Re-anchored on the gate expression only (`process.platform==="win32")({…\`smol-bin.`)` via a `[^}]+` body matcher terminated by the `smol-bin.` tail (unique - the bare gate appears 68x but only this one precedes a resourcesPath/smol-bin join), and dropped the leading `if(` from the replacement so the `await BO(),` prefix is preserved. The Linux KVM opt-in (`||process.platform==="linux"&&globalThis.__coworkKvmMode`) is unchanged.
- **New in v1.15962, no patch needed:** upstream now ships **bundled skills** (`resources/bundled-skills/` with `docx`/`pdf`/`pdf-reading`/`pptx`/`xlsx`/`frontend-design` + a manifest), and `usesLocalSkillStorage()` now returns those bundled skills instead of an empty list. This may partially close the gap where document-skills were unavailable on 3p/gateway deployments (a manual workaround we documented) - worth a re-test on 3p, but it adds no platform-gated code. Also added: 14 renderer<->main IPC handlers (an external-browser-preview surface that is hard-disabled in this build, MCP-OAuth + folder-picker channels for local sessions, an SSH-target setter, and a plugin-bridge `listServers`) - none touch platform/spawn/native code.
- **Cowork daemon:** no change required. v1.15962 adds a `getNetworkDrives` RPC and a `networkDrives` field on `configure`; both are absorbed by the daemon's existing tolerance (unknown-method default returns null -> Desktop falls back to `[]` inside a try/catch; the unknown `configure` field is dropped by a non-strict `json.Unmarshal`). `COWORK_RPC_PROTOCOL.md` updated to record this.
- Baselines re-validated and updated: `CLAUDE_FEATURE_FLAGS.md` (registry `z_()` -> `QR()`, merger `yDA` -> `HSA`, gate `HR()` -> `gM()`, reader `nt()` -> `it()`, yukonSilver fn `$oe()` -> `Uae()`; 4 GrowthBook flags added / 1 removed, none gating a cowork/code/dispatch surface, so the `enable_local_agent_mode` override list is unchanged - all 15 forced flag IDs + 12 merger override names still present), `ION.md` (97 MB / 758 JS / 984 files / 25 CSS; config chunk `QjesmIoF` -> `DAO_m0do`; ternary obj var `ft` -> `mt`; `fix_ion_dist_linux.nim` still applies cleanly), and `PLATFORM_GATE_BASELINE.md` (gate counts unchanged; one macOS-only gate removed). `.electron-version` stays 42.0.0, so no `.electron-shasums` update.

## 2026-06-25

### Fix: built-in theme text contrast (unreadable muted text + white-on-pale-accent labels)

- **Muted/secondary text was below the WCAG AA readability floor in several built-in themes.** With a theme active, sidebar items, secondary text, links and suggestion-chip labels render from `--text-400`/`--text-500`; in `nord` these were `220 10% 55%`, only 3.47:1 against the background (AA needs 4.5:1), which read as dark-grey-on-dark. Raised the muted-text tokens to reference-faithful values that clear 4.5:1: `nord` -> `219 18% 66%` (also restores the Nord Snow Storm hue the old desaturated grey had lost), `catppuccin-latte` -> `233 13% 41%` (= Catppuccin Subtext1), `catppuccin-frappe` -> `228 28% 77%`, `sweet` `--text-500` -> `300 18% 64%`. Matching `--claude-text-500` (legacy hex, used by renderer chrome) bumped for `nord`/`latte`/`sweet`. `catppuccin-mocha` and `catppuccin-macchiato` already passed.
- **White button labels were invisible on the themes' pale accent fills.** All dark themes set `--oncolor-*` (text on accent-filled buttons/badges/checkboxes) to white, but copied Catppuccin/Nord's *bright* accent colours into `--accent-main-100`, so white-on-accent computed to 1.5-2.7:1. Set `--oncolor-*` to each theme's darkest base tone (e.g. `nord` Polar Night `220 16% 15%`, Catppuccin Mantle/Crust), giving 5.7-11.5:1. `catppuccin-latte` keeps white oncolor (it's a light theme with darker accents).
- Values mirrored into the `themes/*/claude-desktop-bin.json` reference files. Patch compiles, applies clean, and the output passes `node --check`. No upstream-version bump.
- **Known remaining item (deferred):** bold notice-banner / card-section headings (e.g. the "Claude Fable 5 is currently unavailable" title) still read muddy. claude.ai draws those dimmed (reduced opacity / a CDS component token) on surfaces the theme darkens; the token is remote-only and not in the app bundle, so it needs a targeted selector override verified against the live UI - to be tackled in a follow-up.

### Fix: enterprise.json / 3p mode broken on Linux since v1.15200.0, plus a class of silent-no-op patch bugs

A user reported enterprise.json "broken" after the v1.15200.0 release: the app hit `api.anthropic.com` instead of the configured inference gateway, userData stayed in `~/.config/Claude` instead of relocating to `~/.config/Claude-3p`, and the startup banner had no `[custom-3p]` lines. Investigating it surfaced a systemic defect class, fixed across several patches.

- **Root cause - two compounding defects.** *(a) A load-bearing patch silently patched nothing.* The orchestrator (`scripts/apply_patches.py`) stages each `@patch-target` into an isolated tmpfs copy, so a patch can only reliably touch the single file in its `@patch-target:` header. `fix_enterprise_config_linux` correctly patched `index.js` (main process) but tried to patch `index.pre.js` (the early bootstrap that decides the `-3p` userData split) as a *sibling* (`parentDir(filePath)/"index.pre.js"`) - a guaranteed no-op, since the sibling is never next to the staged temp file. So the bootstrap shipped unpatched. *(b) Even patched, the Linux reader returned raw JSON.* v1.15200 refactored the bootstrap's "is this a managed/3p deployment?" gate to depend on a module-scoped `Set` that gets populated only as a side effect of the upstream key-registration function (`kW`/`Hzi`), which Windows calls while walking the registry. Our reader returned `JSON.parse(...)` directly, bypassing that function, so the `Set` stayed empty, the gate evaluated false, and 3p never activated (inference stayed on `api.anthropic.com`). In v1.14271 the gate checked config keys directly (`t.inferenceProvider!==void 0`), so the bypass didn't matter then - a textbook "re-validate patches every upstream release" regression.
- **Fix:** `index.pre.js` is now patched by a dedicated `fix_enterprise_config_linux_pre.nim` with its own `@patch-target: index.pre.js` (first-class orchestrator target, `required`, `quit(1)` on miss). The dead sibling block was removed from `fix_enterprise_config_linux.nim`. And both readers now route the parsed JSON through the captured key-registration fn - `return kW(JSON.parse(...))` / `Hzi(...)` instead of returning it raw - which populates the gate `Set` and runs the same validation Windows gets (the fn name is captured dynamically from its body, not hardcoded). Verified on a fresh-from-msix v1.15200.0 bundle: the reader is present and routed through the fn in BOTH files, the full patch suite applies clean, and both files pass `node --check`.
- **Swept the whole patch suite for the same class.** Two other patches had the identical sibling-no-op or a related silent-failure shape:
  - **`fix_locale_paths`** patched `index.pre.js` as a sibling too. As of v1.15200.0 the bootstrap no longer references `process.resourcesPath`, so there was nothing to patch and no runtime breakage - but the absence-keyed skip could not tell "absent (fine)" from "pattern changed (broken)". Split into a dedicated `fix_locale_paths_pre.nim` that positively asserts the bootstrap state (and rewrites a `process.resourcesPath` if a future version reintroduces one).
  - **`enable_local_agent_mode`** had a vestigial "Patch 7" that spoofed `window.process.platform` in the sibling `mainView.js`. It never applied (same staging no-op) yet its "skipped" branch counted as success, and Cowork/Code work fine without it - the keyboard-shortcut need it was added for is already covered by Patch 8's `navigator.platform="Win32"` spoof. Removed it and corrected the patch count (25 -> 24). (`mainView.js`'s real `process.argv` fix is unaffected - it has its own `@patch-target` patch.)
- **Hardened three latent guard-robustness defects** (all currently correct in v1.15200.0, but would silently ship broken on a future upstream refactor): `fix_asar_workspace_cwd` now asserts each of its 5 IPC-bridge cwd-sanitizers matches exactly once instead of summing match counts across 6 sites (a sum could let an over-match mask a zero-match); `fix_dispatch_linux` Patch B (remote-session-control bypass) now keys its "already patched" check on the produced `&&!1` shape rather than the absence of the old pattern plus a generic error string (CLAUDE.md Rule 6); `fix_window_bounds` Patch #1 now raises on its own non-match instead of relying on a shared guard that Patch #2 could satisfy.
- **Added a CI guard** (`scripts/check-patch-sibling-noop.sh`, wired into the `lint-scripts` job) that fails the build if any patch derives a second file's path from its staged target - so this no-op class cannot silently return.
- No upstream-version bump - these are patch-correctness fixes against the same v1.15200.0 bundle. Full orchestrator run is clean (all targets patched, `node --check` passes).

## 2026-06-23

### Upstream bump v1.14271.0 -> v1.15200.0 (2 patches + 1 build-script fix; all 52 apply)

- **Version bump v1.14271.0 -> v1.15200.0**, a full re-minify release. Routine for Linux: no new platform gate locks out a Linux feature, no new native modules, no new built-in MCP servers, and the Cowork RPC contract between Desktop and `claude-cowork-service` is byte-identical in both directions (same socket name, framing, 22 methods, 7 event types, spawn args). The six new IPC handlers (`directMcpCallTool`/`directMcpListResources`/`directMcpReadResource`, `getCrForSession`/`getCrRefSummary`, `reportCommitHash`) are renderer<->Electron-main only and never reach the daemon. Three things needed work.
- **`enable_local_agent_mode`: rebased the `yukonSilver` (Cowork) gate bypass.** Upstream renamed the support function `hre()` -> `$oe()` and added a leading `var r,n;` hoist between the opening `{` and the delegate chain (`const A=j4r();if(A)...`). Patch 1b's anchor regex required `{const` immediately, so it matched 0 times and the patch failed. The pattern now allows an optional `var <ids>;` after the brace; the Linux early-return is injected before the hoist (the vars stay declared but unused on the Linux path - harmless). All 25 sub-patches apply; all 15 forced GrowthBook flag IDs and all 12 merger override feature names are still present (3 new upstream flags, none gating a cowork/code/dispatch surface, so nothing new to force on).
- **`fix_enterprise_config_linux`: tracked the renamed managed-config log.** Upstream renamed the debug log `"Enterprise config loaded: %o"` -> `"Managed config loaded: %o"` and the loaded-variant redact argument is now a nested call (`yXA(zJ(l))` vs the old single `ZZA(o)`). The debug->info promotion (which makes a successful non-empty enterprise load visible in `main.log` at the default level) matched 0 times and failed. Updated the string and loosened the arg pattern to match any non-`{}` call expression, so only the loaded case is promoted and the empty/"none" case stays at debug. The Linux `/etc/claude-desktop/enterprise.json` reader sub-patch was unaffected.
- **Build-script fix: node-pty 1.2.0-beta.13 moved to a `prebuilds/` layout.** Upstream bumped node-pty (Electron devDep now 42.4.0) to a `prebuild`-style package that ships `prebuilds/win32-x64/` and **no** `build/Release/` directory. `build-patched-tarball.sh` rebuilds node-pty for Linux and drops the result into `build/Release/pty.node` (which node-pty's loader still checks first), but the `cp` failed because the destination directory no longer exists. Added `mkdir -p` for the asar-contents `build/Release` dir, mirroring what the unpacked path already did. node-pty + spawn-helper now rebuild and the package completes.
- Baselines re-validated and updated: `CLAUDE_FEATURE_FLAGS.md` (registry `D_()` -> `z_()`, merger `PwA` -> `yDA`, gate `pR()` -> `HR()`; 3 new flags noted), `ION.md` (96 MB / 747 JS / 973 files; config chunk `Cjzc-_Hc` -> `QjesmIoF`; vendor bundle now split per-lib), `PLATFORM_GATE_BASELINE.md` (darwin 73->76 / win32 124->125; one new darwin-only `getExternalRelayConfig` partner-extension relay classified NATIVE), and `claude-cowork-service`'s `COWORK_RPC_PROTOCOL.md` (re-validated, no change). `.electron-version` stays 42.0.0 (the 42.4.0 is upstream's build-time devDep, used only for node-pty header matching; our shipped runtime is unchanged), so no `.electron-shasums` update.

### Fix: missing GNOME/KDE dock icon - `StartupWMClass` did not match the real window class (#148)

- **Every `.desktop` we ship now sets `StartupWMClass=claude-desktop` instead of `claude`.** The dock/taskbar icon was missing on GNOME (Fedora, Wayland) and KDE Plasma 6.7 ([#148](https://github.com/patrickjaja/claude-desktop-bin/issues/148)) because the running window's real X11 WM_CLASS / Wayland app_id is `claude-desktop`, not `claude` - confirmed here with `xprop`/`wmctrl`. GNOME/KDE match a window to its installed `.desktop` entry by `StartupWMClass` first, so the mismatch meant no icon. The window id comes from Chromium's `GetXdgAppId()`, which reads the app's `desktopName` (`claude-desktop.desktop`, set by upstream in app.asar `package.json`) and **ignores the renamed Electron binary / `--class` / argv[0]** - so renaming the binary to `claude` never set the window class, contrary to the old build comments. Fixed across **all** packaging formats: AUR (`PKGBUILD.template`), the `.deb` build script (`packaging/debian/build-deb.sh`, the path CI actually ships), the static `packaging/debian/claude.desktop`, the RPM spec, the AppImage build script, the Nix package, and the launcher's runtime-generated AppImage `.desktop`.
- **Corrected the misleading "Electron derives WM_CLASS from the binary basename" comments** in those files and the launcher header to state the real source (`desktopName`). The binary rename and `APP_ID="claude"` (systemd scope / `.desktop` filename / cgroup portal identity) are unchanged - that is a separate identity signal and was already correct.
- **Known limitation, not addressed here:** per-profile instances (`--create-profile`) still all report `claude-desktop` for the same reason (the shared app.asar `desktopName` wins over the per-profile binary basename), so they don't yet get distinct dock icons. A per-profile `desktopName`/`CHROME_DESKTOP` override (the mechanism `fix_quick_entry_app_id.nim` already uses) is the follow-up. Launcher/packaging-only change; no patch or upstream-version bump.
- Builds on [#154](https://github.com/patrickjaja/claude-desktop-bin/pull/154) by [@noprogressinpleasure](https://github.com/noprogressinpleasure), which had the right diagnosis but covered only the static deb file (inert for CI releases) and the RPM spec.

## 2026-06-22

### Fix: no window opens on Wayland (Vulkan incompatible with `--ozone-platform=wayland`)

- **The launcher now passes `--disable-features=Vulkan` on native Wayland sessions.** On GPUs where Chromium (Electron 42) brings up Vulkan - real Intel/AMD/NVIDIA with a recent Mesa driver - it refuses to pair Vulkan with `--ozone-platform=wayland`, so the Wayland surface factory fails (`wayland_surface_factory.cc: '--ozone-platform=wayland' is not compatible with Vulkan`) and no window is ever created: a silent no-UI startup (the main process logs its `[claude-cu] diagnostics:` lines and stays alive, but nothing renders). Machines where Chromium never selects Vulkan (VMs, software GL) are unaffected and never hit this. Disabling the Vulkan feature is therefore a no-op on the unaffected machines and the fix on the affected ones - Chromium refuses Vulkan+Wayland outright, so no working render path is removed. Only the `wayland` arm is touched; X11 and XWayland (`CLAUDE_USE_XWAYLAND=1`) use `--ozone-platform=x11` and keep Vulkan. Opt back in with `CLAUDE_ENABLE_VULKAN=1`.
- `claude-desktop --diagnose` now prints the assembled `electron_args` so future no-window reports show the active flags.
- README gained a "No window opens on Wayland" troubleshooting section and a `CLAUDE_ENABLE_VULKAN` env-var row. Launcher-only change; no patch or upstream-version bump.

### Custom themes: theme the desktop-shell surfaces that ignore `--bg-*` (#149)

- **`add_feature_custom_themes.nim`: the built-in element overrides now recolor the surfaces that don't read `--bg-*`,** so the bundled `catppuccin-*` themes (and any custom theme) color the whole desktop shell out of the box instead of just the chat text. Three token layers paint independently of `--bg-*` and were staying their hardcoded neutral grey: the `dframe-*` frame classes (`.dframe-sidebar` -> `--bg-200`, `.dframe-content`/`main` -> `--bg-100`); the CDS/epitaxy **surface tokens** (`--cds-surface-0…3`, `--cds-surface-popover`/`-panel`, `--surface-primary`/`-primary-elevated`/`-popover`/`-panel`/`-hud`) that back the Settings dialog, popovers, cards, HUD and the Code tab; and the transcript **scrims** (`.epitaxy-top-scrim`/`.epitaxy-bottom-scrim`) that fade content under the titlebar with a fixed gradient. Each is now mapped onto the active theme's `--bg-*`, so they follow whatever theme is selected.
- **Corrects the scope note from the 2026-06-21 entry.** `insertCSS()` *does* reach the chat webview and its `a.claude.ai/isolated-segment.html` iframe - the unthemed surfaces were never a cross-origin-iframe block, they were these token layers bypassing `--bg-*`. `themes/README.md` is updated to describe the real layers and how to target them. The one thing genuinely out of reach is the OS window-control buttons (min/max/close), which the window manager draws as native decorations - themed from the desktop environment, not from here.

## 2026-06-21

### Prevent VM bundle provisioning in Linux native Cowork (#150)

- **`fix_cowork_download_status_linux.nim` now blocks VM provisioning in Linux native mode ([#150](https://github.com/patrickjaja/claude-desktop-bin/issues/150)).** The existing patch made `getDownloadStatus()` report `Ready`, which hid the false setup banner, but the renderer still called the public `download()` entry point and `setYukonSilverConfig()` independently started a stale/missing bundle refresh whenever `autoDownloadInBackground` was enabled. These paths downloaded and unpacked about 9 GB of `rootfs.vhdx`, `vmlinuz`, and `initrd` even though `claude-cowork-service` runs the CLI directly on the host. The patch now returns success from `download()` and preserves the Yukon Silver config update before returning, both only when `process.platform==="linux"&&!globalThis.__coworkKvmMode`. Linux KVM, Windows, and macOS keep the original provisioning paths. (The native daemon never downloads a VM bundle; it only consumes one in KVM mode from `~/.config/Claude/vm_bundles`, so the KVM-keeps-download gate is load-bearing.)
- Added a fixture regression test covering fresh and partial patch states, idempotency, preservation of the non-native fallback expressions, and JavaScript syntax.
- Thanks to [@Adiker](https://github.com/Adiker) for the patch ([#151](https://github.com/patrickjaja/claude-desktop-bin/pull/151)).

### Custom themes: raw `customCss` field for the renderer windows (#149)

- **`add_feature_custom_themes.nim`: themes can now carry a `customCss` field.** Previously a theme object only accepted CSS-variable keys (`--*`) plus `chatFont`, then a fixed block of element overrides was appended. `customCss` lets a theme inject raw CSS rules beyond variables. It accepts a raw CSS string or an array of strings (joined with newlines), at the top level (applies under the active theme) and/or inside a theme object (applies only for that theme). Both are injected after the variable declarations and built-in overrides; per-theme is appended after global. Optional and fully backward-compatible - configs without it behave exactly as before. Startup logs `[CustomThemes] customCss appended (N chars)` when present. **Scope caveat (documented in `themes/README.md`):** injection uses `webContents.insertCSS()`, which is per-frame, so `customCss` reaches the local renderer windows (Quick Entry, Find-in-Page, About) and the `top` `https://claude.ai/` document, but **not** the main chat UI - sidebar/conversation-list/composer render in a cross-origin child iframe (`a.claude.ai/isolated-segment.html`) that `insertCSS` cannot enter. Theme the chat UI via CSS variables (which the iframe inherits through claude.ai's own styling); selector-level styling of the chat surface needs a future patch-level sub-frame injection change.

## 2026-06-18 - v1.14271.0 bump (2 patches fixed) + new patch: suppress false VM-download banner on Linux native (#143)

### Upstream (v1.14271.0) - 2 patches fixed, all 52 apply

- **Version bump v1.13576.4 -> v1.14271.0** (~700 builds, full re-minify). Routine re-minify release for Linux: no new platform gates lock out a Linux feature, no new native modules, no new built-in MCP servers, and the Cowork RPC contract is unchanged in both directions. Two patches needed work for the re-minified bundle.
- **`fix_cowork_linux`: fixed C2's idempotency backreference.** The C2 "bundle lookup alias" fallback asserts upstream's hardcoded-win32 VM-bundle lookup (`(<var>=<map>.files["win32"])!=null&&<var>[arch]`) is present, but the deref var was hardcoded as literal `r`; re-minify renamed it `r` -> `i`, so the assertion stopped matching and C2 reported FAIL. Now captures the deref var and backreferences it so it tracks the rename.
- **`fix_browser_tools_linux`: rewrote 3 sub-patches for a real upstream refactor.** The Chrome native-host install path was restructured, not just renamed: the per-browser install loop is gone, and the manifest is now written to a single `userData/ChromeNativeHost` dir on all platforms (which Chrome/Chromium never read on Linux), while the per-browser enumerator became uninstall-only. The binary-path resolver and Chrome user-data-dir lookup likewise collapsed to flat win-only forms. Rewrote Patch A (binary path: inject Linux `~/.claude/chrome/chrome-native-host` short-circuit), Patch B (reuse the manifest writer to install into all 6 real Linux `NativeMessagingHosts` dirs at the start of the installer), and Patch C (return the 5 Linux browser user-data dirs). This native-host area is structurally volatile - watch it on the next release.
- **No baseline-doc internals moved structurally** beyond the usual minified-name churn; flag/ion-dist/platform-gate baselines updated with the new function names, config-chunk hash, and gate counts (see below). `enable_local_agent_mode.nim` (all 25 sub-patches) and `fix_ion_dist_linux.nim` apply unchanged.

### New patch: suppress the false "Download a one-time package" agent-mode banner on Linux native

- **New `fix_cowork_download_status_linux.nim` (52 patches total): the Cowork "Get set up for agent mode - Download a one-time package" banner no longer appears on Linux in native backend mode.** Desktop decides the agent-mode VM-image download status locally (it stopped calling the daemon RPC for this in v1.7196.0) via `getDownloadStatus(){return ...?Downloading:p5()?Ready:NotDownloaded}`, where `p5()` looks for the `claudevm.bundle` VM image on disk. On Linux native there is no VM image (Cowork runs the `claude` CLI on the host via claude-cowork-service), so the check always reported `NotDownloaded` and the remote claude.ai UI rendered a misleading "you're not set up" banner - even though Cowork works (sessions spawn and turns complete behind the banner). The patch rewrites `getDownloadStatus` so Linux native returns the enum's `Ready`; the original expression is preserved byte-for-byte for win32/darwin **and Linux-KVM**, where the guest image genuinely must be downloaded. Gated on `process.platform==="linux"&&!globalThis.__coworkKvmMode` (the KVM flag the cowork mode preamble already sets), so it never suppresses a legitimate KVM download prompt. **Not 3p/enterprise-specific** - it applies to 1p and 3p alike; it was first noticed in a gateway `enterprise.json` setup but a plain 1p Linux native user hits the identical false banner. Anchored on the unique `getDownloadStatus(){return ...}` method with the enum var captured by backreference (verified to survive the v1.14271.0 re-minify: `xX/p5/eN` -> `Z5/Rz/mM`); idempotency asserts the patched end-state.

### Bug fix: CoworkSpaces `getRemoteSessionSpaces is not a function` on Linux

- **`fix_cowork_spaces.nim`: added 6 CoworkSpaces methods the renderer now invokes.** On startup the main process logged `TypeError: (intermediate value).getRemoteSessionSpaces is not a function` (twice) because the renderer's `CoworkSpaces` interface calls 24 methods but our injected Linux file-based service only registered 18 IPC handlers. Six were missing - `getRemoteSessionSpaces`, `setRemoteSessionSpace`, `removeRemoteSessionSpace`, `classifySessions`, `setAutoDescription`, `summarizeSpace` - so those invokes fell through to an unhandled stub and threw. Implemented all six to match the upstream native contract (return types are validated renderer-side): the three remote-session-space methods are real local CRUD backed by a separate `remote-session-spaces.json` (Map, `cse_`->`session_` id normalization, folder-preservation on empty re-set, 1000-entry LRU cap evicting oldest - mirroring upstream `Ajr=1e3`); `setAutoDescription` only updates `origin:"auto"` spaces (returns `null` otherwise); and `classifySessions`/`summarizeSpace` are safe stubs (`[]`/`null`, both valid per the renderer guards) since neither has an inference backend on Linux. Verified: patch applies on the clean v1.14271.0 bundle, `node --check` passes, and the injected remote-session logic passes a standalone assertion suite (normalization, folder preservation, boolean returns, LRU eviction).

### Forward-looking audit fixes (patches + CI hardening, verified against v1.13576.4)

A full audit of patches/docs/CI against the current bundle found the suite healthy (51/51 apply, Cowork contract intact in both native and KVM modes, no new Linux gaps). Four items were worth fixing, all low-risk:

- **`fix_quick_entry_ready_wayland`: fixed a latent runtime bug.** The replacement hardcoded a logger (`R.error`) that does not exist at the patched call site (the live logger is `S`); the patch applied cleanly and passed `node --check`, but a rejected ready-to-show promise would throw a ReferenceError in the very catch meant to swallow it. Now captures and reuses the upstream logger var + catch param so it survives re-minifies.
- **`fix_imagine_linux`: retargeted Patch C to the renamed flag.** The Visualize/Imagine CCD gate `2204227020` was renamed to `3516166472` upstream, so Patch C had silently become a no-op (its standalone uses, including the `read_widget_context` tool registration, were no longer forced ON). Retargeted to the new ID. Also rewrote the Patch B/C idempotency checks to assert the patched end-state and fail loudly if the flag disappears, instead of treating flag-absence as success.
- **`fix_native_frame_renderer`: converted to a regression guard.** Upstream upstreamed the fix (the main-window title-bar component now returns `null` natively), so the patch had been silently no-opping via an accidental guard. It now positively asserts the upstream null short-circuit and fails the build if a future release reintroduces the pointer-absorbing drag region.
- **CI: glibc floors are now enforced, not just logged.** The node-pty rebuild asserts the GLIBC_2.31 floor (Debian 11 / Ubuntu 22.04) and fails loudly instead of silently shipping an un-rebuilt binary when version detection fails; the aarch64 kwin-portal-bridge gained the same objdump-based GLIBC_2.39 gate the x86_64 binary already had.

Docs: added the missing `fix_open_in_editor_linux` row to the README patch table and corrected the obsolete `fix_native_frame_renderer` row; noted the `2204227020 -> 3516166472` rename and fixed contradictory version headers in `CLAUDE_FEATURE_FLAGS.md`. CLAUDE.md gained a strictness rule forbidding false-success reporting - an "already patched" line must assert the patched end-state, never the mere absence of the pre-patch pattern.

### Docs: third-party inference (`enterprise.json`) expanded

- **`docs/third-party-inference.md`: added a 5-minute LiteLLM gateway quickstart and a feature-complete "maximum `enterprise.json`" reference.** The quickstart stands up a local LiteLLM proxy (Anthropic passthrough, secrets via env) and points Claude Desktop at it with one JSON file. The maximum example documents every managed-config key (enumerated from the v1.14271.0 schema) - surfaces, MCP/plugins, sandbox/egress governance, telemetry, usage limits - plus a per-provider "minimum required keys" table.
- **Surface toggles documented (`scopes:["3p"]`): `chatTabEnabled`, `coworkTabEnabled`, `isClaudeCodeForDesktopEnabled`, `betaFeaturesEnabled`.** These bring the Chat / Cowork / Code tabs back in 3P/gateway mode. README and the static site (`site/index.html`) gained matching coverage; README also embeds a Gateway-mode screenshot and links the official Anthropic 3P config docs. No app screenshots on the public static site (copyright) - it uses a copy-paste config block instead.

### Upstream (v1.13576.4) - build bump, no patch work

- **Version bump v1.13576.1 -> v1.13576.4** (patch-level rebuild of build 13576, hash `414f858c`). Re-minify only; bundle functionally identical.
- **All 52 patches apply unchanged.** Package built cleanly; `node --check` passes. The lone validator "FAIL" (`fix_ion_dist_linux`) is a manual-extract artifact - ion-dist lives in the MSIX resources, not `app.asar`; the patch applies fine against the extracted SPA.
- **No semantic changes vs v1.13576.1:** platform-conditional counts (linux 10, darwin 77, win32 +1 vendored path helper), Agent SDK copies (0.3.174 / 0.3.177), built-in MCP servers (1), and all fragile anchors are unchanged - the diff is pure minified-identifier churn.
- **No baseline-doc changes.** Bumped `.upstream-version` -> 1.13576.4.

### Built-in terminal fixed (re: #143)

- **New `fix_terminal_shell_linux.nim` (51 patches total): the built-in agent/Cowork terminal now spawns a Linux shell instead of PowerShell.** Upstream hardcodes the node-pty shell to `powershell.exe` on every platform, so on Linux `execvp(3)` fails and the PTY dies instantly ("Shell exited." / exit code 1). The patch rewrites only the shell string into a platform-aware ternary, anchored on the sole `shell:"powershell.exe"` occurrence. Thanks to **Yannick Schäfer ([@boommasterxd](https://github.com/boommasterxd))** for the fix ([#144](https://github.com/patrickjaja/claude-desktop-bin/pull/144)).
- **Off-Windows shell selection falls back `$SHELL` → `/bin/bash` → `/bin/sh`.** The `/bin/sh` tier was added on top of the PR for **NixOS** (Nix flake target), which ships no `/bin/bash` by default; a runtime `require("fs").existsSync` check keeps the PTY from going dead when `$SHELL` is unset.

## 2026-06-17 (v1.13576.0 / v1.13576.1) - Major version bump: 7 patches fixed, 1 removed, 1 added (50 total), all apply

### Cowork startup-error visibility (re: #142)

- **`fix_cowork_error_message` gained Patch C: replay the stored Cowork startup error once the mainView is ready.** When the Cowork VM startup fails before the web view exists (e.g. `claude-cowork-service` is not running on Linux), the upstream dispatcher stored the error in a module var but only logged `Cannot dispatch startup error (no mainView): <err>` and never replayed it - so the helpful "install claude-cowork-service" message (Patch A/B) never reached the UI, and the uncaught throw crash-looped the app (or bounced the renderer back to the start screen on chat-open). Confirmed in `cowork_vm_node.log` (`[VM:start] VM boot failed: ...` + `Cannot dispatch startup error (no mainView): ...`). Patch C rewrites the no-mainView branch to install a one-shot poller (Linux only, ~30s budget, `globalThis.__cdbStartupErrReplay` guard) that waits for the view's webContents to finish loading, then re-dispatches the stored error through the same dispatcher. Anchored on the unique `Cannot dispatch startup error (no mainView): ` literal; all minified identifiers captured from the match. `EXPECTED_PATCHES` 2 -> 3.

### Launcher `log: command not found` (re: #142)

- **Moved the `log()` definition (and its `LOG_DIR`/`LOG_FILE` setup + rotation block) to the top of `claude-desktop-launcher.sh`, right after `APP_ID`.** `log()` was defined at the bottom (~line 1131), but `_appimage_integrate()` calls it and runs much earlier during startup (`_appimage_integrate quiet || true`, ~line 948). Bash resolves a called function's name at call time, so the early invocation printed `claude-desktop: line 498: log: command not found` to stderr on every AppImage launch (the line-498 call is the "system `.desktop` exists - skipping" branch). Cosmetic only - the `|| true` swallowed the failure and integration still succeeded, but the integrate log line was silently dropped and the stderr noise was alarming. Surfaced in #142's startup output (reproduces on every machine running the AppImage, independent of the Cowork issue in the same report). Pure reordering; behavior otherwise unchanged. Verified with `bash -n`.

### Enterprise config visibility

- **`fix_enterprise_config_linux` now promotes the upstream "Enterprise config loaded" log from `debug` to `info`** so a successful, non-empty managed-config load is visible in `main.log` at the default log level (previously the only signal was a `debug` line below the default threshold, plus upstream's own `managedMcpServers entry N dropped - <reason>` validation warnings). Only the *loaded* variant is promoted (second arg is a redact-fn call); the empty/"none" case stays at `debug` so launches without `/etc/claude-desktop/enterprise.json` don't spam `info`. Applied to both `index.js` and `index.pre.js`; idempotent. The Linux reader injection itself is unchanged.
- **Clarified the `enterprise.json` schema for users (re: #140):** the top-level key the v1.13576 build reads is **`managedMcpServers`** - an **array** of objects each requiring `name` (unique), `transport` (`"http"`/`"sse"`/`"stdio"`), and `url`/`command`. A top-level object-keyed `mcpServers` map (or per-entry `type` instead of `transport`) is silently ignored by the schema parser - no entries reach the per-entry validator, so no "dropped" warning is emitted. Managed servers apply unconditionally (no `allowManagedMcpServers` enable-gate; `allowManagedMcpServersOnly` only restricts the allowlist to managed-only).

### Upstream (v1.13576.1) - build bump, no patch work

- **Version bump v1.13576.0 -> v1.13576.1 (patch-level rebuild of the same major build 13576).** Upstream `.latest` reports `1.13576.1` (hash `772d01ffc175c3795a49154acdecf043d634b5d1`). Bundle re-minified but functionally identical: unpatched `index.js` 15.12 MB, vendored `@anthropic-ai/claude-agent-sdk` copies unchanged at **0.3.174 / 0.3.177** (still two copies). Unpatched platform-conditional counts: darwin 77, win32 137, linux 10 - consistent with v1.13576.0.
- **All 50 patches apply unchanged; 51/51 validate** (`validate-patches.sh`), `node --check` passes on both `index.js` and `index.pre.js`. No regex updates needed.
- **Documented fragile anchors re-verified, all match v1.13576.0:** enterprise wrapper `function Mei(){const A=Rei();...}` (readPlistValue refs still 1), Cowork `yukonSilver:Zce()`, tray-icon `switch(...){case"ico":...}` (build-time const renamed `G1r`->`GJr`, absorbed by the flexible pattern), feature-flag fn present.
- **No baseline-doc changes:** feature flags, built-in MCP servers (1 `registerInternalMcpServer`), ion-dist patterns, and platform gates all unchanged. `.electron-version` stays 42.0.0 (shasums verified OK). Package built as `claude-desktop-bin-1.13576.1-1-x86_64.pkg.tar.zst`.

### CI

- **`version-check.yml` now tracks handled versions via a committed `.upstream-version` file** (mirrors claude-cowork-service) instead of the highest GitHub release tag. Bump + commit `.upstream-version` once a version is handled - even a trivial build bump with no public release - to silence the "new version detected" issue and turn the badge green. Seeded the file at `1.13576.1`.

### Upstream (v1.13576.0)

- **Version bump v1.12603.1 -> v1.13576.0 (~970 builds, full re-minify).** Bundle 15.03 -> 15.12 MB (+0.6%). Vendored `@anthropic-ai/claude-agent-sdk` copies bumped 0.3.170/0.3.167 -> **0.3.174/0.3.177** (still two copies - the duplicated-SDK match-site hazard still applies). Package built as `claude-desktop-bin-1.13576.0-1-x86_64.pkg.tar.zst`; `node --check` passes on the patched bundle.
- **8 patches failed on first build; the failures were upstream refactors, not just renames.** 7 fixed, 1 removed -> **50 -> 49 patches**, all apply.
- **Several macOS/Windows-only platform gates were DROPPED upstream (Linux now covered natively):**
  - **Dispatch platform label:** the `switch(process.platform){...default:return"Unsupported Platform"}` label fn became a ternary `process.platform==="darwin"?"macOS":process.platform==="win32"?"Windows":"Linux"` - Linux is now labelled correctly upstream.
  - **Dispatch telemetry gate:** the `cn=darwin,zo=win32,cAA=cn||zo` triple + `if(!cAA)return;` early-returns are gone; telemetry now runs unconditionally (gated only on `disableNonessentialTelemetry`), so Linux gets dispatch telemetry without a patch.
  - **Office-addin connected-file detection:** `(darwin||win32)&&await FN(e.app,e.document)` lost its platform gate (now `if(await FN(e.app,e.document))`) - the feature is gated only on the `louderPenguinEnabled` flag (which `enable_local_agent_mode` already forces). The whole `fix_office_addin_linux.nim` patch is now **obsolete and removed**.
  - **setTitleBarOverlay theme-update gate:** the win32-only `zo&&...getAllWindows().forEach(...)` guard was removed; the call is unconditional, so the integrated titlebar already receives theme updates on Linux.
- **Enterprise managed-config loader collapsed:** the `process.platform==="darwin"?macReader():process.platform==="win32"?winReader():{}` ternary became a single wrapper `function Mei(){const A=Rei();return Object.keys(A).length>0?A:void 0}` that unconditionally calls the win32 registry reader (mac plist reader removed; `readPlistValue` refs 3 -> 1). `fix_enterprise_config_linux` rebased to inject the Linux `/etc/claude-desktop/enterprise.json` branch into that wrapper (both `index.js` and `index.pre.js`).
- **Cowork (yukonSilver) support gate refactored:** static registry now wires `yukonSilver:Zce()`, where `Zce()` delegates to `Q3i()`/`C3i()` and `C3i()` **hardcodes `const A="win32"`** for the VM-bundle arch lookup (`fo.files["win32"][arch]`) - the explicit `process.platform!=="darwin"&&!=="win32"` Cowork gate is gone. `enable_local_agent_mode` Patch 1b rebased to inject the Linux early-return into `Zce()`; `fix_cowork_linux` Patch A (VM client loader) and Patch C2 (bundle lookup alias) rebased (see below).
- **Tray icon selection refactored:** the win32 `isWin?e=...:e="TrayIconTemplate.png"` ternary became `switch(G1r){case"ico":...case"template-image":...case"png":...}` keyed on a build-time icon-type constant (`G1r="ico"` on Windows builds). `fix_tray_icon_theme` now injects a Linux override after the switch (`process.platform==="linux"&&(e="TrayIconTemplate-Dark.png")`).
- **Sensitive-dirs array** gained two new intervening arrays (`["Scheduled","Artifacts"]`, scheduled-tasks/agents/...) between the win32 block and the old `.zshrc` anchor; `fix_sensitive_dirs_linux` re-anchored on the stable `"PowerShell")]:[]` win32 close.

### Patches fixed (7) + removed (1)

- **`fix_tray_icon_theme`** - rewrote for the new `switch(G1r)` icon selector; injects a post-switch Linux override (forces `TrayIconTemplate-Dark.png`, since the win32 `.ico` files the `"ico"` build-type picks don't ship on Linux). **Note:** trailing `;` on the injected expression is required - it's followed immediately by `const t=...` with no line terminator (ASI does not apply in minified code).
- **`fix_sensitive_dirs_linux`** - re-anchored on `"PowerShell")]:[]` (win32-array close) instead of the now-displaced `.zshrc` next-var.
- **`fix_enterprise_config_linux`** - rebased onto the new `Mei()`/`Rei()` wrapper (captures the registry-reader fn from its `SOFTWARE\Policies` body); applies to `index.js` and `index.pre.js`.
- **`fix_native_frame`** - Patch 2 (setTitleBarOverlay gate) now detects the upstreamed unconditional call and skips without failing; Patches 1 + 3 unchanged.
- **`fix_dispatch_linux`** - Patch C (platform label) and Patch D (telemetry gate) detect their upstreamed forms (ternary returning `"Linux"`; telemetry no longer platform-gated) and skip without failing; A/B/E unchanged.
- **`enable_local_agent_mode`** - Patch 1b (yukonSilver) rebased to inject the Linux early-return into the new `Zce()` delegate-chain (`const A=Q3i();...const e=C3i();if(e.status!=="supported")return AW(e)`), keeping the historical `process.platform` forms as fallbacks. All 25 sub-patches apply.
- **`fix_cowork_linux`** - Patch A (VM client loader) rebased: the old win32 ternary `zo?IM={vm:X}:IM=(await import("@ant/claude-swift"))` became `function d_t(){return tu()?...{vm:qti}...:null}` gated on `tu()` (MSIX/appPath install detection); we widen the gate to `(tu()||process.platform==="linux")`. Patch C2 (bundle lookup alias) detects that the platform-indexed `Io.files[process.platform]` lookup is gone - the only remaining lookup hardcodes `"win32"` (`C3i`), which already gives Linux the win32 bundle, so the linux->win32 alias is now upstream's default; it skips without failing. All 10 sub-patches apply.
- **`fix_office_addin_linux`** - **REMOVED** (obsolete; the connected-file-detection platform gate it widened was dropped upstream - the feature now runs on all platforms gated only on `louderPenguinEnabled`).

### Audits (re-validated against the new bundle)

- **Feature flags:** static registry **37 -> 39** (added `iosSimulatorH264`, `quickEntryGlobalShortcut`; removed none) + 5 async-only (`louderPenguin`/`coworkKappa`/`coworkArtifacts`/`markTaskComplete`/`epitaxyMcpApps`). Function renames: registry `aD()`->`sR()`, async merger `fSA`->`c0A`, prod dev-gate `vR()`->`rM()`, GrowthBook bool reader `dt()`->`Ct()`; electron var `lA` unchanged. **GrowthBook delta vs v1.12603.0:** +3 (`1703762832` onModelRefusalFallback retry [already present in v1.12603.1], `1985784543` an isEnabled gate, `3646818354` shouldKillOnIdlePause), 0 removed. `enable_local_agent_mode` 12-flag override list unchanged - none of the new flags is darwin/win32-gated.
- **Built-in MCP servers:** internal roster unchanged; `registerInternalMcpServer` present. Bundled Microsoft 365 server (`resources/office365-mcp/`) still ships.
- **Platform gates:** darwin 79 -> 77 / win32 141 -> 137 / linux 9 -> 10. The net drop is the upstreamed gates above (dispatch label/telemetry, office-addin, setTitleBarOverlay) collapsing explicit `process.platform` checks. **No new PORTABLE (Linux-compat) opportunity.**
- **ion-dist SPA:** 94 -> 95 MB, 730 JS (unchanged), config chunk `c71860c77-upcFhKtF.js` -> `c71860c77-DXc_sfB9.js`; both `fix_ion_dist_linux.nim` sub-patterns still match (`mountPath` still mac/win-only, platform ternary `_===M.Win32?...win:...mac`). New 3P config keys: Vertex `inferenceVertexProjectId`/`inferenceVertexRegion`/`inferenceVertexWorkforceOidc`/`inferenceVertexWorkforceUserProject`, Gateway `inferenceGatewayBaseUrl`/`inferenceGatewayHeaders`.

### New patch (1)

- **`fix_builtin_mcp_browser_env` - built-in MCP connectors couldn't open a browser for OAuth on Linux ([#139](https://github.com/patrickjaja/claude-desktop-bin/issues/139)).** The Microsoft 365 connector's local sign-in failed with `local_auth_browser_open_failed` / `spawnErrorCode: exit_3` and no browser appeared. Root cause: the built-in MCP host is forked via `utilityProcess.fork` with a **filtered env allowlist** (`vre()`), which on Linux forwards only `["HOME","LOGNAME","PATH","SHELL","TERM","USER"]` - stripping `DISPLAY`, `WAYLAND_DISPLAY`, `XDG_CURRENT_DESKTOP`, `DBUS_SESSION_BUS_ADDRESS`, `BROWSER`, `XDG_DATA_DIRS`, etc. The bundled `office365-mcp.mjs` opens the auth URL with `spawn("xdg-open",[url])` and passes no `env`, so it inherits the stripped environment; `xdg-open`'s `has_display()` is then false, it skips the `x-scheme-handler/https` default-browser resolution, falls through to the text-only browser list, finds none, and exits 3 (`exit_failure_operation_impossible`). The patch widens the Linux allowlist to forward the standard freedesktop / X11 / Wayland session vars, so `xdg-open` inside the MCP process launches the user's default browser exactly as it does from a terminal. Distro- and session-agnostic (only standard env vars; `vre()` forwards each only when set). The win32 branch of the allowlist is untouched. `vre()` is the base env for all stdio MCP server forks (the built-in host plus user-configured stdio servers via `jMt`/`StdioClientTransport`), so the wider session env reaches every one of them - strictly more correct, since it only adds standard vars a terminal-launched process already has. The other `utilityProcess.fork` sites (which pass `{...process.env}`) are unaffected.

### Runtime fix

- **`getSystemInfo` crash on Linux:** v1.13576.0 dropped the `win32`-only guard around the `getWindowsElevationType()` call in `getSystemInfo` (and the `desktop_windows_elevation_detected` telemetry), so it's now invoked on every platform. Our Linux `@ant/claude-native` stub lacked the method -> `TypeError: i.getWindowsElevationType is not a function`, spamming on every Settings/feedback system-info request. Added `getWindowsElevationType: () => "default"` to the stub (`patches/claude-native.js`) - `"default"` is the non-elevated state, matching both call sites' `?? null` / `?? "default"` fallbacks (`can_elevate_to_admin` -> `false` on Linux). Other native methods that lost guards this release (`cuGetOwnBundleId`, `getActiveWindowHandle`) are still safe (darwin-only path / wrapped in try-catch).
- **Remote MCP servers fail with `ERR_MODULE_NOT_FOUND` (issue #140):** connecting a direct/remote MCP server (e.g. atlassian via enterprise.json) crashed the `custom3p-mcp host` utility process immediately - it tried to load `directMcpHost.js` from `resources/locales/app.asar/.vite/build/mcp-runtime/directMcpHost.js`, which does not exist. Root cause: two sidecar loaders build their path as `join(process.resourcesPath,"app.asar",...)`, and `fix_locale_paths` blanket-rewrites every `process.resourcesPath` to `dirname(getAppPath())+"/locales"` - injecting a spurious `locales/` segment before `app.asar`. `fix_0_node_host` already collapsed the same `isPackaged` ternary for nodeHost.js and shellPathWorker.js to `app.getAppPath()`; extended it to also cover the directMcpHost loader (`ohi()`) and the generic worker loader (`l7i()`, used for transcript-search-worker, which had the same latent bug). All four sub-patches now use `[\w$]+` wildcards, capture-group backreferences, and idempotency markers (`fix_0_node_host` is now fully re-run-safe). On Linux the package is always "packaged" and `getAppPath()` already resolves to the real app.asar, so the packaged and non-packaged branches are equivalent.

### Build tooling

- **`build-local.sh` rebuild checksum fix:** the local `claude-desktop-*.tar.gz` is a build artifact regenerated every run (bytes/sha change each build), but makepkg cached it in `cache/` under its download name and re-validated the **stale** cached copy against the freshly-generated `sha256sums` -> `One or more files did not pass the validity check`. The script now purges any cached `claude-desktop-*-linux.tar.gz` before makepkg so it re-copies the fresh artifact; the upstream **electron zip stays cached** (checksummed, reused across builds). Removed the dead `cp` that copied the tarball under a basename makepkg never looked up.
- **CI `test-pkgbuild` Electron-verify fix:** the job sourced `scripts/verify-electron.sh` (added with the shasum checks) but had no `actions/checkout` step, so the script and `.electron-shasums` were absent at runtime -> `scripts/verify-electron.sh: No such file or directory`. Added a checkout step to the job; artifact downloads and the makepkg step are unaffected.

### Docs updated

- `CHANGELOG.md` (this entry), `baseline/CLAUDE_FEATURE_FLAGS.md`, `baseline/CLAUDE_BUILT_IN_MCP.md`, `baseline/ION.md`, `baseline/PLATFORM_GATE_BASELINE.md` refreshed to v1.13576.0. `README.md` patch table - removed `fix_office_addin_linux` row, added `fix_builtin_mcp_browser_env` row, count 50 (50 -> 49 -> 50).

### Security (community audit #137)

- **Electron zip now SHA-256 verified everywhere (was `SKIP`).** Added `.electron-shasums` (per-arch official digests from Electron's `SHASUMS256.txt`, pinned to `.electron-version`), a `scripts/update-electron-shasums.sh` generator/`--check`er, and a sourceable `scripts/verify-electron.sh` (`verify_electron_zip`). Wired into `build-deb.sh`, `build-rpm.sh`, `build-appimage.sh`, the `test-pkgbuild` cache step, and the PKGBUILD (`PKGBUILD.template` + `generate-pkgbuild.sh` now emit real digests so makepkg verifies natively). `lint-scripts` fails the build if `.electron-shasums` drifts from the pinned version. Nix is unaffected (uses nixpkgs Electron). Verified: makepkg reports `electron-...zip ... Passed` on a good build and `FAILED` on a wrong digest.
- **GPG repo signing-key fingerprint published** in `README.md` (`825A 7D15 D78B ABE4 5646  D5DF 3824 09F5 9790 8867`, RSA 4096) so users can verify the APT/DNF key out-of-band.
- **`packaging/apt/install.sh` GPG key hardening:** download the key to a temp file and validate it parses (`gpg --show-keys`) before writing the system keyring, instead of piping `curl` straight into `gpg --dearmor` (guards against a truncated/corrupt download leaving a broken keyring).
- **Documented as non-issues** (in the issue thread): msix integrity rests on TLS - the `.latest` endpoint `hash` is an opaque release ID, not a content digest (no upstream signature to verify); the ydotool `0666` socket lives in user-private `/run/user/$UID` (0700); the Computer-Use TCC/sandbox-ref patches don't weaken a real boundary (macOS-only TCC; Linux genuinely has no VM); the manual CI `download_url` is admin-gated.

## 2026-06-12 (v1.12603.1) - Point release, all 50 patches apply unchanged

### Upstream (v1.12603.1)

- **Point release on v1.12603.0** (+446 bytes, full re-minify of essentially the same code). All 50 patches applied without modification.
- **Static registry renamed:** `sD()` -> `aD()`. All other function names unchanged (`fSA` merger, `vR()` dev-gate, `dt()` flag reader). `[\w$]+` wildcards in patches absorbed the rename.
- **New GrowthBook flag `1703762832`:** gates `onModelRefusalFallback` retry behavior in `AgentModeSessionManager` - when ON, a refusal with `direction:"retry"` triggers a fallback. No platform gate; Linux unaffected.
- **ion-dist config chunk renamed:** `c71860c77-C2vlLTGm.js` -> `c71860c77-upcFhKtF.js` (~307 KB, was ~313 KB). Both `fix_ion_dist_linux.nim` sub-patterns (mountPath mac/win keys, platform ternary) still match. No structural change; file count 730 JS / 978 total (unchanged).
- **Platform gates:** darwin 79 / win32 141 / linux 9 - all identical to v1.12603.0. Zero new gates, zero new PORTABLE opportunities.
- `enable_local_agent_mode.nim` 12-flag override list unchanged; no new darwin/win32-gated features.

### Docs updated

- `baseline/CLAUDE_FEATURE_FLAGS.md` - added v1.12603.1 version history row + new flag `1703762832` catalog entry.
- `baseline/ION.md` - updated last-verified version, config chunk filename, file count.
- `baseline/PLATFORM_GATE_BASELINE.md` - bumped last-audited version and baseline counts.

## 2026-06-11 (v1.12603.0) - Version bump, all 50 patches apply unchanged

### Upstream (v1.12603.0)

- **Version bump:** v1.11847.5 -> v1.12603.0 (~760 builds). Full re-minify - every minified identifier shifted - but zero structural changes hit our patch targets: **all 50 patches applied without modification** (their `[\w$]+` wildcards absorbed the renames). Package built as `claude-desktop-bin-1.12603.0-1-x86_64.pkg.tar.zst`; `node --check` passed on the patched JS (38 `[claude-cu]` markers present).
- **Bundle grew 13.6 -> 15.0 MB (+11%):** the entire growth is a **second vendored copy of `@anthropic-ai/claude-agent-sdk`** (0.3.167 embedded alongside 0.3.170), bringing a ~290-entry `CLAUDE_CODE_*`/`DISABLE_*` env-flag registry module. **Patch-maintenance hazard:** any future patch matching SDK-internal code now has TWO match sites - "exactly 1 match" assertions against SDK code will fail or silently patch only one copy (note added to update-prompt.md).
- **Microsoft 365 MCP server now ships:** `resources/office365-mcp/` (office365-mcp.mjs 6.5 MB + pdfExtractorProcess.mjs + pdf.worker.mjs) is new inside app.asar - the loader existed in v1.11847.5 but the bundle was missing ("not included in this build"). Graph-based Outlook/OneDrive/SharePoint/Teams tools, MSAL auth with encrypted `msal-cache.enc` via `safeStorage`, GovCloud environments, write scopes withheld on public builds (`MCP_GRANTED_DELEGATED_SCOPES`). **No platform gate - works on Linux**; resolved via `app.getAppPath()`, preserved by our repackaging (verified present in the built asar). Worth a runtime smoke test (`safeStorage` without a keyring).
- **New upstream features:** `artifactsPane` feature (new GrowthBook flag `2115990222`, no platform gate - new `claudePagePreview.js` preload embedding claude.ai pages in the preview pane); `device_request_folder_access` remote-device tool with "Always allow this folder on this device" prompts (flag `2745857735`); `oauthScope` passthrough into CLI session env (flag `884132720`); VM optional mounts (value flag `3932491586`, force-OFF upstream). Two new IPC handlers: `ClaudeCode.getPeriodUsage` (CLI usage probe) and `Launch.exportPreview`. Removed: cowork git-init no longer creates an empty initial commit.

### Audits (re-validated against the new bundle)

- **Feature flags:** registry now 37 static + `louderPenguin` async-only = 38 (added `artifactsPane`, removed none). `artifactsPane` is now the FIRST registry key - future `nativeQuickEntry`-anchored searches must re-anchor. `builtinMcpPresets` lost its dev-gate wrapper (now unconditionally supported - upstreamed to all platforms incl. Linux). 4 GrowthBook flags added, 0 removed; new `LC(id,default)` value-with-default reader. Renames: registry `Rw()`->`sD()`, merger `PBA`->`fSA`, prod gate `OS()`->`vR()`, flag reader `lt()`->`dt()`. **`enable_local_agent_mode.nim` needs no changes** - none of the new flags is darwin/win32-gated.
- **Built-in MCP servers:** internal roster unchanged; registration fn `KqA()`->`iAe()`, registry `CT`->`YL`, labels `TUA`->`jVA`, enumerator `J3()`->`s9()`; server-UUID map byte-identical. New doc section for the bundled Microsoft 365 server.
- **Platform gates:** darwin 73->79 / win32 122->141 / linux 5->9 - the entire swing is the duplicated vendored CLI/SDK helper code (which/cross-spawn/isexe/WSL-detect/signal-list duplicates), verified via stable-string counts. Zero new Electron-side platform gates. **No new PORTABLE (Linux-compat) opportunity.**
- **ion-dist SPA:** modest growth (93->94 MB, 715->730 JS, 23->25 CSS); config chunk `c71860c77-BBQ3iytl.js`->`c71860c77-C2vlLTGm.js`; both `fix_ion_dist_linux.nim` sub-patterns still match (`mountPath` still mac/win-only); ternary vars `V`/`E`/`xt`. New Vertex config key `inferenceVertexOAuthLoginHint`. NFC path normalization now darwin-gated upstream (was unconditional - Linux-friendly, no patch impact).
- **claude-cowork-service cross-check:** wire protocol unchanged except Desktop's `spawn` now optionally reads a `failedMounts` array from the response (absent-tolerant - the Go daemon keeps working as-is). Optional follow-ups for that repo: implement `failedMounts` (mount-failure telemetry/UI demotion) and document the pre-existing `pruneSessionCaches` RPC (VMDiskJanitor calls it in both versions; unknown-method null-passthrough covers it).

### Docs updated

- `baseline/CLAUDE_FEATURE_FLAGS.md`, `baseline/CLAUDE_BUILT_IN_MCP.md`, `baseline/ION.md`, `baseline/PLATFORM_GATE_BASELINE.md` - all refreshed to v1.12603.0. `update-prompt.md` - added duplicated-SDK match-site warning. README patch table unchanged (no patch changes).

## 2026-06-10 (v1.11847.5-2) - 2 new patches: Linux memory-pressure metric + suppressed renderer-death logging (#128) + launcher log rotation (#132)

### Issue

- [#128](https://github.com/patrickjaja/claude-desktop-bin/issues/128): `[CliGovernor] memory pressure (critical)` log spam on Linux plus silent renderer "eviction" forcing a claude.ai re-login. Root cause of the spam: Electron's `process.getSystemMemoryInfo().free` is `MemFree` on Linux, which excludes reclaimable page cache. A healthy 32 GB box measured MemFree/MemTotal = 5.3% while MemAvailable/MemTotal = 61.8%, so the governor (warning <5%, critical <2%, 10s poll, `M$r=.05`/`N$r=.02` in v1.11847.5) fires constantly on perfectly healthy systems. The pressure events only log + send telemetry - they never touch the renderer. Separately, the main webview's `render-process-gone` handler early-returns with no log when the reason is `killed`/`clean-exit` or an expected kill is pending - a kernel OOM SIGKILL maps to `killed`, so the renderer death that precedes the re-login was invisible in main.log (the reporter's "no render-process-gone events" proved nothing).

### New patches (2)

- **`fix_cli_governor_memavailable.nim`** - rewrites `getFreeMemoryRatio` to read `MemAvailable`/`MemTotal` from `/proc/meminfo` (clamped with `Math.min(1, ...)`), re-emitting the captured upstream expression verbatim as the fallback if the `/proc` read throws. `require("fs")` is cached by Node's module loader, so the 10s poll costs one ~1.5 KB procfs read. Idempotency marker: `/proc/meminfo` within 200 chars of `getFreeMemoryRatio:`. macOS is unaffected (native pressure events bypass the polling path). Upstream's own MCP timeout diagnostics already compensate with `free + fileBacked` elsewhere - the governor just never got the fix.
- **`fix_renderer_gone_suppressed_log.nim`** - inserts `D.info("Main webview render process gone (suppressed): %o",{reason,exitCode,expectedKills})` inside the early-return branch of the main-webview `render-process-gone` handler, before the counter decrement (`expectedKills > 0` = app-initiated kill via the unresponsive handler; `0` with reason `killed` = external kill, e.g. kernel OOM). All identifiers captured via `[\w$]+` groups; the trailing `"Main webview render process gone: %o"` literal pins the one correct site out of 8 `render-process-gone` registrations. Pure observability - suppression behavior (no reload) unchanged.

### Tooling

- **`scripts/validate-patches.sh`** - added a `nim-dir` branch (copy directory to a temp dir, run the binary on it) and a directory-aware existence check. Previously `fix_ion_dist_linux.nim` always failed standalone validation with "target file not found" because the script `-f`-tested its directory target; suite is now 51/51.

### Not addressed (still open in #128)

- `preferencesChanged` MaxListeners warning - upstream claude.ai web-app bug (the shipped preload's `onPreferencesChanged` correctly returns an unsubscribe closure; the remote web app re-subscribes without cleanup). Trivial magnitude (~KBs per page session); masking it would hide real regressions.
- The re-login mechanism itself - the claude.ai view runs on persistent `session.defaultSession` and the recovery path is a plain `webContents.reload()`, so the web session should survive; needs incident-time evidence from the reporter (asks posted on the issue).

### Verification

- Patch count 48 -> 50; both new patches idempotent (second run exits 0 via marker detection); `node --check` passes on the patched JS; `./scripts/validate-patches.sh` 51/51 green; pure-JS text patches, identical on x86_64 and aarch64.

### Launcher log rotation (#132)

> **Credit:** boommasterxd (Yannick Schäfer) - triaged [#132](https://github.com/patrickjaja/claude-desktop-bin/issues/132) (located the reported awk hang in `aaddrick/claude-desktop-debian`, not this repo) and contributed the rotation fix ([#133](https://github.com/patrickjaja/claude-desktop-bin/pull/133)). Merged after the `-2` release - ships with the next release, not in the v1.11847.5-2 artifacts.

- **Issue:** [#132](https://github.com/patrickjaja/claude-desktop-bin/issues/132): Reported that `_previous_launch_hit_gpu_fatal` hangs the launcher on large log files via an O(n^2) awk scan of the whole `launcher.log` on every startup. **Investigation result:** that function, `setup_logging`, `build_electron_args` and the `~/.cache/claude-desktop-debian/` cache path do not exist anywhere in this repo - they belong to the separate `aaddrick/claude-desktop-debian` project. This launcher writes to `~/.cache/claude-desktop/launcher.log` and only ever reads it via `tail -10` for `--diagnostics`, so the reported O(n^2) hang cannot occur here. The one applicable half of the report - unbounded log growth - did apply: `log()` appended without any size cap.
- **Fix:** **`scripts/claude-desktop-launcher.sh`** - rotate `launcher.log` to `launcher.log.old` once it exceeds 2 MiB, checked once per startup before `log()` is defined. Every step is guarded (`stat` failure -> `0`, numeric regex guard, `mv` failure ignored) so the rotation can never itself prevent Claude from launching.
- **Post-merge fixup:** `_diagnose`'s "Recent launcher log" section now reads across the rotated backup (`cat launcher.log.old launcher.log 2>/dev/null | tail -10 || true`) so the last 10 lines survive a rotation that just happened at startup. The `|| true` is required under the launcher's `set -euo pipefail`: `cat` exits non-zero when one of the files is missing, which is the common state (no `.old` exists before the first rotation) and would otherwise abort `--diagnose` mid-output.

## 2026-06-09 (v1.11847.5) - Version bump, 1 patch fixed for refactored upstream code

> **Credit:** boommasterxd (Yannick Schäfer) independently produced the same update in parallel ([#130](https://github.com/patrickjaja/claude-desktop-bin/pull/130)), reaching identical findings (same `fix_claude_code` getStatus fix, same feature-flag/platform-gate/ion-dist results) and additionally verifying the RPM build on Fedora. The `mountPath` `caption`-key-drop note in `baseline/ION.md` is from his audit.

### Upstream (v1.11847.5)

- **Version bump:** v1.11187.4 -> v1.11847.5 (~660 builds). Full re-minify - every minified identifier shifted. One patch needed a regex update because upstream restructured the code (not just renamed variables); the other 47 patches absorbed the renames via their `[\w$]+` wildcards.

### Patches fixed (1)

- **`fix_claude_code.nim`** (Patch 3, `getStatus()`) - upstream added a second check to the first if-condition: `if(await this.getLocalBinaryPath())` became `if(await this.getLocalBinaryPath()||await this.getHostPreseedInPlacePath())`. The old regex required the bare `getLocalBinaryPath()` call immediately followed by `)return`. New regex captures the whole condition and tolerates an optional run of `||await this.<fn>()` clauses, then re-emits the original condition verbatim in the patched code so the `getHostPreseedInPlacePath()` check is preserved. Patches 1 and 2 (`getHostPlatform`, `getBinaryPathIfReady`) were unaffected.

### No other patch changes needed

- **All 48 patches apply** - package built as `claude-desktop-bin-1.11847.5-1-x86_64.pkg.tar.zst`; `node --check` passed on the patched JS.

### Audits (re-validated against the new bundle)

- **Feature flags:** 3 new static features (`coworkRemoteSessionSpaces`, `coworkBranchSession`, `epitaxyMcpApps`); async merger now 5-way; 8 new GrowthBook flag IDs, 1 removed. `enable_local_agent_mode.nim` needs no changes (`epitaxyMcpApps` intentionally left server-gated - experimental). Function renames: registry `Dw()`->`Rw()`, merger `SBA`->`PBA`, dev-gate `MS()`->`OS()`.
- **Built-in MCP servers:** roster unchanged (22 servers + 4 per-session SDK). Registration fn `uqA()`->`KqA()`, registry `sT`->`CT`, labels `cUA`->`TUA`, enumerator `b3()`->`J3()`.
- **Platform gates:** darwin 72->73 (re-minify noise, both NATIVE - macOS Handoff `setUserActivity` + memory-pressure governor which falls back to `setInterval` polling on Linux), win32/linux unchanged. **No new PORTABLE (Linux-compat) opportunity.**
- **ion-dist SPA:** modest growth (92->93 MB, 706->715 JS chunks); config chunk `c71860c77-CyMvMS7K.js`->`c71860c77-BBQ3iytl.js`. Both `fix_ion_dist_linux.nim` sub-patterns still match (`mountPath` still mac/win-only); no patch change needed.

### Docs updated

- `baseline/CLAUDE_FEATURE_FLAGS.md`, `baseline/CLAUDE_BUILT_IN_MCP.md`, `baseline/ION.md`, `baseline/PLATFORM_GATE_BASELINE.md` - new version-history rows + refreshed stats/counts/minified names.

## 2026-06-06 (v1.11187.4) - Version bump, 2 patches fixed for refactored upstream code

### Upstream (v1.11187.4)

- **Version bump:** v1.10628.2 -> v1.11187.4 (~560 builds). Full re-minify - every minified identifier shifted. Two patches needed regex updates because upstream restructured the code (not just renamed variables); the other 46 patches absorbed the renames via their `[\w$]+` wildcards.

### Patches fixed (2)

- **`fix_utility_process_kill.nim`** - upstream inserted a `r&&this.noteKillOnce(),` statement between `.kill()` and the `\`Killing utiltiy proccess again\`` log call. Old regex required `.kill();[\w$]+.info(\`Killing...` immediately adjacent. New regex tolerates a short run of intervening statements: group 3 is now `;[^\`]{0,80}\.info(\`Killing utiltiy proccess again`. Patched result: `n.kill("SIGKILL");r&&this.noteKillOnce(),D.info(...)`.
- **`fix_asar_folder_drop.nim`** (Patch B, second-instance argv parser) - the `.slice(1).filter(...)` was hoisted into a local var, so the loop changed from `for(const X of Y.slice(1))if(!Z(X))` to `for(const X of <var>)if(!Z(X))`. Rewrote the regex to drop the hardcoded `.slice(1)` and anchor on the trailing `"skill file"` arg for uniqueness (exactly one such loop in the bundle). Patch A (noe file-drop filter) was unaffected. Patched result: `for(const n of r)if(!/\.asar/.test(n)&&!VXr(n)){...`.

### No other patch changes needed

- **All 48 patches apply** - package built as `claude-desktop-bin-1.11187.4-1-x86_64.pkg.tar.zst`; `node --check` passed on the patched JS.

### Semantic verification (not just regex-match)

Traced the **raw unpatched** upstream code around every changed site and the 14 highest-stakes structural patches to confirm intent still holds after the re-minify (a matching regex alone doesn't prove the surrounding logic is unchanged):

- **`fix_utility_process_kill`** - the function has two `.kill()` calls (first SIGTERM via `const i=this.process.kill()`, 5s fallback via `const r=(n=this.process)==null?void 0:n.kill()`). Confirmed our regex matches **only the fallback** (distinct syntactic form), so the first kill stays graceful SIGTERM and only the timeout escalates to SIGKILL. The new `noteKillOnce()` is logging-only and is preserved. Semantics intact.
- **`fix_asar_folder_drop`** - upstream refactored `jXr()` and **added a new pre-filter** `A.slice(1).filter(n=>n.startsWith("-")||resolve(n)!==appPath)`. Verified this does NOT make our guard redundant: upstream only drops the single arg whose resolved path exactly equals `getAppPath()`, whereas our `!/\.asar/.test(n)` rejects any `.asar` path (covers symlinked/non-canonical paths and the case where `getAppPath()` returns the unpacked `app` dir). Our guard sits in the loop condition before the `existsSync(n)->e.push(n)->wQA(e)` dispatch, so a `.asar` arg never reaches the file-drop handler. Still correct defense-in-depth.
- **14 highest-stakes patches verified SOLID** against raw upstream: `enable_local_agent_mode` (25 sub-patches; merger override `{...Dw(),louderPenguin:A,...}` is authoritative), `fix_dispatch_linux`, `fix_cowork_linux` (10 sub-patches), `fix_computer_use_linux`, `fix_tray_dbus`, `fix_quick_entry_position`, `fix_native_frame`(+renderer), `fix_window_bounds`, `fix_locale_paths`, `fix_marketplace_linux`, `fix_startup_settings`, `fix_updater_state_linux`, `fix_vm_session_handlers`, `fix_sensitive_dirs_linux`. Every anchor lands in a semantically correct location.
- **Stale comment fixed:** `enable_local_agent_mode` Patch 1 comment claimed it ungates `chillingSlothFeat + quietPenguin`; in v1.11187.4 `chillingSlothFeat` moved to the non-platform `oW` gate, so only `quietPenguin` (`WEr`) matches here now. Behavior unchanged (Patch 1 already accepts `>=1` matches and Patch 3's merger force-overrides every feature regardless) - updated the comments + the 2-match log label to be version-agnostic.
- **Noted, not changed:** `fix_locale_paths` still does a global replace of all `process.resourcesPath` sites - a long-standing over-broad approach (not a v1.11187.4 regression); the affected non-locale paths are win32/darwin-gated and not exercised on Linux.

### Audit findings

- **Feature flags:** no `enable_local_agent_mode.nim` override changes needed (all 25 sub-patches still match; merger return `{...Dw(),louderPenguin:A,coworkKappa:e,coworkArtifacts:t,markTaskComplete:i}` intact). **1 new static feature** `coworkArtifactPopout:_d` (always supported, no platform gate, no override needed); `bootstrapConfig` changed from `MS()`-gated to bare `_d`. Function renames: registry `Aw()`->`Dw()`, async merger `LCA`->`SBA`, dev-gate `Dm()`->`MS()` (2nd gate `xEr()` for `builtinMcpPresets`), GrowthBook bool reader `It()`->`lt()`, supported constant `Xd`->`_d`, electron var `aA`->`sA`, `louderPenguin` async helper `Fsr()`->`XEr()` (still `darwin||win32` gate, now also reads flag `4116586025`), cowork helper `pRA()`->`mNA()`. **GrowthBook delta** (vs v1.9659.4 baseline, the only local prior bundle): 5 added (`124685897` template-subst, `1323782925` APe qualifier, `1609612026` marketplace install, `2720310975` side-chat tools, `790863764` device_bash), 1 removed (`3638165567`).
- **Built-in MCP:** **no servers added/removed** - identical roster (imagine/visualize/marketplace/skills/radar/echo/Framebuffer/Window Halo, etc.). Registration fn renamed `jHA`->`uqA` (registry obj `sT`, label map `cUA`, enumerator `b3()`). node-pty **1.1.0-beta34** unchanged.
- **Cowork protocol:** **unchanged** - `control_request` 14, `control_response` 46, `sessions-bridge` 3, `environments/bridge` 1, `work/poll` 1, all identical to baseline; 20 `CoworkArtifacts_$_*` IPC handlers byte-for-byte identical (the +8 raw `CoworkArtifacts` occurrences are new log strings, not protocol). **`claude-cowork-service` is NOT affected by this release.**
- **ion-dist (3P config SPA):** still required, applies cleanly. **92 MB / 706 JS / 950 files / 23 CSS** (up from 90 MB / 691 JS / 909 files / 21 CSS - modest growth, no structural refactor). Config chunk `c71860c77-CV0D52ti.js` -> **`c71860c77-CyMvMS7K.js`** (content-hash bump). `mountPath` **still mac/win-only** (no `linux` key, not upstreamed); platform ternary vars this release `K`/`C`/`pt`. Both sub-patterns matched; verified the compiled patch applies (exit 0, 2/2).
- **Platform gates:** darwin **65->72** (+7), win32 **113->122** (+9), linux **5** (unchanged). All new gates classify as NATIVE (path NFC normalization, updater channel msix/squirrel, dock bounce, Mission Control, TouchID, codesign verify, plist/registry reads, endpoint-security SIGKILL classification, dev-only `chrome://inspect` launcher) or STUB/config-gated (chat features gated by config flag, not `process.platform`). **No new PORTABLE (Linux-actionable) gate.** The `louderPenguin` Code-tab gate became async (`XEr()` + flag `4116586025`) but remains PATCHED via the existing override.

## 2026-06-04 (v1.10628.2) - Re-minify point release, all patches clean

### Upstream (v1.10628.2)

- **Version bump:** v1.10628.0 -> v1.10628.2 (webpack re-minify point release on top of v1.10628.0; v1.10628.1 was not observed on the public download channel). **No behavioral change vs v1.10628.0:** same feature-flag architecture, same patch surface, only fresh minified identifiers in a handful of spots.
- **All 48 patches applied without modification** - zero regex changes needed. The flexible `[\w$]+` patterns absorbed every minified rename. `node --check` passed on the patched JS; ion-dist patch matched both sub-patterns; `fix_tray_dbus.nim` this release: tray fn `Y5A`, tray var `VE`.
- **Feature flags unchanged:** still **32 static + `louderPenguin` async-only = 33 total**; identical static feature names (`claudeDesignWindow`/`builtinMcpPresets` both present, none removed); merger return identical (`{...Aw(),louderPenguin:e,coworkKappa:A,coworkArtifacts:t,markTaskComplete:i}` via `Promise.all([Fsr(),pRA(()=>It("123929380")),pRA(()=>It("2940196192")),pRA(()=>It("3732274605"))])`); both new features still in the Zod `.partial()` schema (`...builtinMcpPresets:Mo,surfaceTogglesPreview:Mo,chatTab:Mo,chatCodeExecution:...`).
- **Function names mostly held** (unusually light re-minify): registry `Aw()`, async merger `LCA`, dev-gate `Dm()` (`function Dm(e){return aA.app.isPackaged?{status:"unavailable"}:e()}`, electron var `aA`), `louderPenguin` async helper `Fsr()` (still `darwin||win32` gate), cowork async helper `pRA()`, GrowthBook bool reader `It()`, computer-use Set `MCA` (`new Set(["darwin","win32"])`, `MCA.has(process.platform)`), win32 var `ro`, darwin||win32 var `O$` - **all unchanged from v1.10628.0**. Renamed: supported constant `XQ`->`Xd` (`{status:"supported"}`); chatTab/chatCodeExecution gate fns `R6e`->`R5e` / `M6e`->`M5e`; cowork 5s-delay helper `u9e`->`u6e`; yukonSilver `WjA`->`W8A`; misc `zKA`->`z1A`, `$jA`->`$8A`; tray fn `Y6A`->`Y5A` (`fix_tray_dbus.nim`).
- **No structural changes:** file-level diff vs the installed v1.10628.0 shows only content-hashed renderer asset renames (about/buddy/find_in_page/main/quick) plus the expected patched-vs-raw artifacts (node-pty Linux spawn-helper, `resources/i18n/*.json` are added by the build, not upstream); **IPC `handle()` channel set identical** after normalizing the per-build UUID; **`require()` set identical**; built-in MCP roster unchanged (imagine/visualize/marketplace/skills/radar/echo/Framebuffer/Window Halo); **no cowork protocol changes** (`control_request`/`control_response` 8/7, `sessions-bridge` 3, `environments/bridge` 1, `work/poll` 1, `CoworkArtifacts` 5 - all unchanged); node-pty **1.1.0-beta34** unchanged.
- **GrowthBook:** 68 distinct boolean flag IDs in `It()` calls in the raw v1.10628.2 bundle; all documented key flags present and stable (`123929380`/`2940196192`/`3732274605` cowork, `4116586025` louderPenguin master, `2216414644` dispatch, `2688060585`/`3269331205` autoMode force-ON defaults). No clean prior-version MSIX is served upstream, so a literal old-vs-new flag diff is dominated by our own patch rewrites (`enable_local_agent_mode.nim`/`fix_dispatch_linux.nim` turn several `It("...")` calls into `!0`/`!1` in the installed build); structural flag continuity verified directly in the new bundle instead.
- **ion-dist (3P config SPA):** no structural change - **90 MB / 691 JS / 909 files / 21 CSS** (byte-for-byte counts identical to v1.10628.0). Config chunk `c71860c77-CDhE5jkR.js` -> **`c71860c77-CV0D52ti.js`** (content-hash bump only). `mountPath` **still mac/win-only** (no `linux` key) -> `fix_ion_dist_linux.nim` still required and both sub-patterns matched. Platform enum `Darwin="darwin",Win32="win32",Linux="linux"` intact; only 1 `/Library/Application Support` + 1 `%ProgramFiles%` path (both inside mountPath).
- **Platform gates:** darwin **65**, win32 **113**, linux **5** - **exactly identical to v1.10628.0** (zero swing). The three "not-mac-not-win -> unavailable" gates (`Fsr()` louderPenguin, `Lsr()` quietPenguin inner, `ksr()` cowork architecture check) all map to existing PATCHED rows. **No new PORTABLE (Linux-actionable) gate.**
- **`enable_local_agent_mode.nim` 12-flag override list unchanged** - build applied the patch without modification (12 features overridden, coworkKappa/coworkArtifacts/markTaskComplete/chillingSlothPool flags forced ON).

### No patch changes needed

## 2026-06-03 (v1.10628.0) - 2 new features, all patches clean

### Upstream (v1.10628.0)

- **Version bump:** v1.9659.4 -> v1.10628.0. Feature-flag architecture and patch surface structurally unchanged: minified-identifier renames, 2 new static features, and a GrowthBook flag delta.
- **All 48 patches applied without modification** - zero regex changes needed. The flexible `[\w$]+` patterns absorbed every minified rename. Build sub-pattern health verified in the build log: **166x `[OK]`, 0x `[FAIL]`** (the single `0 matches` is the explicitly `(optional)` `hardcoded electron paths` sub-pattern). `node --check` passed on all patched JS; ion-dist patch matched both sub-patterns (`[OK] org-plugins linux path`, `[OK] mount path platform ternary`); node-pty + spawn-helper rebuilt for Linux (ELF x86-64); RPM built successfully on Fedora.
- **2 new static feature flags** (32 static + `louderPenguin` async-only = **33 total**, was 31):
  - `claudeDesignWindow` - `claudeDesignWindow:XQ` in the registry (always `{status:"supported"}`, **no platform gate**, no dedicated renderer-window directory). Linux-clean, no patch needed.
  - `builtinMcpPresets` - `builtinMcpPresets:Dm(()=>XQ)` (**dev-gated** via the production wrapper -> `{status:"unavailable"}` in all packaged builds, on every platform). Gates the built-in MCP server preset list (e.g. **Microsoft 365 / `m365`**, `https://microsoft365.mcp.claude...`). STUB-class (disabled on all OSes), not a Linux exclusion - no patch needed.
  - **No features removed.** All 30 static features from v1.9659.4 retained; `chatTab`/`surfaceTogglesPreview`/`chatIn3p`/`chatCodeExecution` all still present. Both new features are in the Zod `.partial()` validation schema (`...builtinMcpPresets:Mo,surfaceTogglesPreview:Mo,...).partial()`).
- **Function renames** (re-minify): static registry `Yp()`->`Aw()`, async merger const `IlA`->`LCA` (still `{...Aw(),louderPenguin:e,coworkKappa:A,coworkArtifacts:t,markTaskComplete:i}` via `Promise.all([Fsr(),pRA(()=>It("123929380")),pRA(()=>It("2940196192")),pRA(()=>It("3732274605"))])`), dev-gate wrapper `um()`->`Dm()` (`function Dm(e){return aA.app.isPackaged?{status:"unavailable"}:e()}`, electron var `aA` unchanged), `louderPenguin` async helper `Frr()`->`Fsr()` (still `darwin||win32` gate, `unavailable` on Linux), `quietPenguin` inner `Lsr`, cowork async helper `V0A`->`pRA`, GrowthBook bool reader `Bt()`->`It()`, supported constant -> `XQ` (`{status:"supported"}`), computer-use Set `rlA`->`MCA` (`new Set(["darwin","win32"])`, `MCA.has(process.platform)`), platform vars `Or`/`mo`/`P3` -> `Yr`(darwin)/`ro`(win32)/`O$`(darwin||win32), `fix_tray_dbus.nim` this release: tray fn `Y6A`, tray var `VE`.
- **GrowthBook flags: ~17 newly present, 3 removed** (empirical delta of the **v1.9659.4 install binary** vs the fresh **v1.10628.0** binary; each add/remove confirmed by a **whole-bundle raw presence-check across all `.vite` chunks** - not just call-site grep in `index.js` - so a flag merely moving between chunks is not miscounted as new/removed). Newly present and traced: `124685897` (template-substitution gate, `ru()`), `1609612026` (marketplace install/migration path), `2143883161` (`/code/` deep-link route gate), `2720310975` (side-chat allowed tools), `2688060585`+`3269331205` (`autoModeEnabled` force-ON defaults, `Sa(!0)`); newly present (documented-historical flags re-appearing): `1129419822`, `1496676413`, `1824824999`, `2067027393`, `2114777685`, `2192324205`, `2204227020`, `245679952`, `2800354941`, `3444158716`, `4274871493`. Removed (absent in new): `3242661803`, `3638165567`, `3858743149` (maxThinkingTokens). **Caveat:** upstream serves no prior-version MSIX, so the only available "old" binary is the patched v1.9659.4 install; 3 force-ON flags our patches rewrite (`1992087837`, `2216414644`, `3732274605`) were excluded as patch artifacts. Several "new" IDs are historical flags that were tree-shaken out of v1.9659.4 and re-included here, not brand-new concepts.
- **`enable_local_agent_mode.nim` 12-flag override list unchanged** - all forced flags (`123929380`, `2940196192`, `1992087837`, `3732274605` + the 12 feature overrides) still exist in the new bundle; the 2 new features don't gate any Linux Cowork/Code/Agent-Mode path (`claudeDesignWindow` is ungated, `builtinMcpPresets` is dev-gated on all platforms). Build applied the patch without modification.
- **ion-dist (3P config SPA):** minor growth, no structural refactor - **90 MB** (was 88), **691 JS** (was 682), **909 files** (was 899), 21 CSS unchanged. Config chunk `c71860c77-BOyfE2Py.js` -> **`c71860c77-CDhE5jkR.js`** (content-hash bump). `mountPath` **still mac/win-only** (no `linux` key) -> `fix_ion_dist_linux.nim` still required and both sub-patterns matched. Platform enum `Darwin="darwin",Win32="win32",Linux="linux"` intact.
- **Platform gates:** darwin 64->65, win32 112->113, linux 5 (unchanged). The +1/+1 swing is re-minify/refactor noise: the 2 new features are **not** platform-gated, and every listed darwin/win32 gate maps to NATIVE (TouchID, codesign, ESF endpoint-security, `getSystemVersion`, NFC normalization, efivars), a platform-var declaration, or an already-Linux-handled else-branch. **No new PORTABLE (Linux-actionable) gate.**
- **Built-in MCP servers:** roster unchanged (imagine/visualize/marketplace/skills/radar/echo/Framebuffer/Window Halo present; office/browser-tools/buddy targeted by their Linux patches, all applied cleanly). The internal-registration function name (`LYA()`-line) was **not** separately re-verified this release - quick anchors didn't resolve and `registerInternalMcpServer` appears only as a context-bridge method key, not a verifiable registration call; low-risk for a roster-stable release. The only MCP-adjacent addition is the `builtinMcpPresets` **preset** list (m365 etc.), not a new internal server.
- **No structural changes:** identical renderer windows (about/buddy/find_in_page/main/quick) and main-process chunks; IPC is interface-based RPC (`CoworkArtifacts` etc.), no flat-channel additions; Electron **41.6.1** and node-pty **1.1.0-beta34** unchanged.
- **No cowork protocol changes** - `control_request`/`control_response` (8/7 refs), `sessions-bridge`, `environments/bridge`, `work/poll` all present and unchanged; **claude-cowork-service not affected**.

### No patch changes needed

## 2026-06-02 (v1.9659.4) - Point release on v1.9659.2, all patches clean

### Upstream (v1.9659.4)

- **Version bump:** v1.9659.2 -> v1.9659.4 (webpack re-minify point release - fresh identifiers, no behavioral change vs v1.9659.2). v1.9659.3 was not observed on the public download channel (the version API only serves `latest`).
- **All 47 patches applied without modification** - zero regex changes needed. The flexible `[\w$]+` patterns absorbed every minified variable rename, including `fix_tray_dbus.nim` (this release: tray fn `Jfi`, tray var `RQ`, menu var `mm`). JS syntax valid (`node --check`) on the patched bundle, RPM built successfully on Fedora.
- **Same 31 feature flags** as v1.9659.2 (30 static + `louderPenguin` async-only): exact same 30 static feature names, `chatTab`/`surfaceTogglesPreview` still the 2 newest, no features added or removed.
- **Function renames vs v1.9659.2** (re-minify only): static registry `xp()`->`Yp()`, async merger `olA`->`IlA` (still `{...Yp(),louderPenguin:e,coworkKappa:A,coworkArtifacts:t,markTaskComplete:i}` via `Promise.all([Frr(),V0A(()=>Bt("123929380")),V0A(()=>Bt("2940196192")),V0A(()=>Bt("3732274605"))])`), dev-gate wrapper `Em()`->`um()` (`function um(e){return aA.app.isPackaged?{status:"unavailable"}:e()}`, electron var `aA` unchanged), `louderPenguin` async helper `wrr()`->`Frr()`, cowork async helper `V0A` (`Frr()` keeps the `darwin||win32` gate). GrowthBook bool reader `Bt()` unchanged. Computer-use Set `XEA`->`rlA` (`new Set(["darwin","win32"])`, checked via `rlA.has(process.platform)`).
- **71 GrowthBook flag IDs** unchanged vs v1.9659.2. Note: upstream no longer serves prior-version MSIX metadata, so the flag-ID set was re-confirmed against the fresh v1.9659.4 binary and matches the documented count.
- **ion-dist (3P config SPA):** byte-identical to v1.9659.2 - config chunk still `c71860c77-BOyfE2Py.js`, main `index-C_tZnXTW.js`, 88 MB (682 JS / 21 CSS / 899 files), `mountPath` still mac/win-only (no `linux` key), `fix_ion_dist_linux.nim` still required and both sub-patterns matched (`[PASS]`).
- **Platform gates:** darwin 60->64, win32 111->112, linux 5 (unchanged). The feature registry is byte-identical (same 30 static feature names), so there is **no new feature-flag-borne gate**, and the listed darwin/win32 gates still map to NATIVE / STUB / PATCHED in `baseline/PLATFORM_GATE_BASELINE.md`. **No new PORTABLE (Linux-actionable) gate.** The exact cause of the +4/+1 literal `process.platform===` count delta (spanning the .2 -> .4 jump) can't be pinned to a specific mechanism without an old-binary diff, since upstream no longer serves prior-version MSIX.
- **Built-in MCP servers:** all MCP Linux patches (office, browser-tools, imagine, marketplace, buddy-BLE) applied cleanly, so the code structures they target still exist. The full server roster was **not separately re-enumerated** this release (the internal-registration anchor changed shape and a quick grep returns tool names, not server names); a deep MCP re-audit was deferred as low-risk for a re-minify point release.
- **`enable_local_agent_mode.nim`** 12-flag override list unchanged - the build applied it without modification.

### No patch changes needed

## 2026-06-01 (v1.9659.2) - Point release on v1.9659.1, all patches clean

### Upstream (v1.9659.2)

- **Version bump:** v1.9659.1 -> v1.9659.2 (webpack re-minify point release - fresh identifiers, no behavioral change vs v1.9659.1)
- **All 47 patches applied without modification** - zero regex changes needed. Flexible `[\w$]+` patterns absorbed every minified variable rename, including `fix_tray_dbus.nim` (this release: tray fn `G9A`, tray var `PE`). JS syntax valid (`node --check`) on all targets.
- **Same 31 feature flags** as v1.9659.1 (30 static + `louderPenguin` async-only): `chatTab`, `surfaceTogglesPreview` still the 2 newest, no features added or removed.
- **Function renames vs v1.9659.1** (re-minify only): static registry `Yp()`->`xp()`, async merger `slA`->`olA`, production gate `lm`->`Em()` (`function Em(e){return aA.app.isPackaged?{status:"unavailable"}:e()}`, electron var `aA`), `louderPenguin` async helper -> `wrr()`. GrowthBook bool reader `Bt()` and computer-use Set `XEA` (`new Set(["darwin","win32"])`, checker `AlA()`) unchanged from v1.9659.1.
- **ion-dist (3P config SPA):** unchanged from v1.9659.1 - config chunk still `c71860c77-BOyfE2Py.js` (21 sub-chunks, main `index-C_tZnXTW.js`), 88 MB, `mountPath` still mac/win-only (no `linux` key), `fix_ion_dist_linux.nim` still required and both sub-patterns matched.
- **Built-in MCP servers:** roster unchanged from v1.9659.1. Server-UUID map present (renderer var `mL`); `ios_simulator`/`android_emulator`/`echo` still reserved/inactive labels (no server implementation).
- **No GrowthBook flag changes** vs v1.9659.1. Note: upstream no longer serves prior-version MSIX metadata, so the flag-ID delta was re-confirmed against the v1.9659.1 doc baseline rather than a fresh binary diff.

---

## 2026-05-28 (v1.9659.1) - All patches clean, no new platform gates, no Linux patch needed

### Upstream (v1.9659.1)

- **Version bump:** v1.9255.2 -> v1.9659.1 (~400 builds)
- **All 47 patches applied cleanly** - zero failures, no regex changes needed. The flexible `[\w$]+` patterns absorbed every minified variable rename automatically. No new and no changed Linux patch required.
- **2 new feature flags** (30 static, was 28; +`louderPenguin` async-only = 31 total):
  - `surfaceTogglesPreview` - dev-gated via `PM()` production gate, always `unavailable` in production
  - `chatTab` - 3p-bootstrap-gated (`aze()` = `desktopBootFeatures.chatIn3p.status==="supported"` && `chatTabEnabled===true`), only active in third-party whitelabel builds; does not replace the Code tab (`louderPenguin`) or Chat
- **No feature flags removed.** All 28 static features from v1.9255.2 are still present.
- **Feature flags - function renames** (webpack re-minify only): static registry `Yp()` (was `Gp()`), async merger `slA` (was `mEA`/`pEA`), GrowthBook bool reader `Bt` (was `Ct`), async helper `x0A` (was `A0A`), `PM()`-gate wrapper `lm` (was `wD`), supported constant `Ww` (was `_M`)
- **No GrowthBook flag changes** - 71 boolean flag IDs identical to v1.9255.2 (clean diff, verified against freshly extracted old bundle). One new numeric remote-config value `1629866860` (claude_code session limit, read via `ad()` - not a boolean toggle, not flag-relevant)
- **`enable_local_agent_mode.nim` unchanged** - the 12-flag override list stays correct (the 2 new features are dev-/3p-gated and don't block the Linux Cowork/Code/Agent-Mode paths we force-enable). Validated 25/25 sub-patches, all overridden flags still in the Zod `.partial()` schema, `node --check` OK
- **15 new IPC handlers** (all platform-neutral, no Linux implementation needed): `ClaudeAiImport_*` (OAuth import of claude.ai data: `startAuth`/`runImport`/`getAuthState`/`clearAuth`/`isAvailable`/`reopenAuthTab` + `onAuthStateChange`/`onAuthUserCode` events), `Custom3pSetup_*` (`signInWithAnthropicApi`/`applyAnthropicApiShortcut`), `ClaudeCode_setEnableWorkflows`, `CoworkArtifacts_setArtifactLastModifiedSession`, `Launch_loadFramePreview`, `LocalAgentModeSessions_grantRemoteSessionFolder`, `LocalSessions_getSessionMediaStreamUrl`
- **MCP:** registration function renamed `HHA()` (was `KPA()`), mcp-registry const `mlA` (was `OEA`). **Server roster and tool sets unchanged.** New static `yL` server-UUID map that feeds `server_uuid` into the existing internal-tool telemetry. Three reserved/inactive labels in the map: `ios_simulator` and `android_emulator` (new, no server implementation yet - precursors for future MCP servers), plus `echo`
- **ion-dist SPA:** config chunk `c71860c77-BOyfE2Py.js` (was `c71860c77-DFJHDHrp.js`), 88 MB total (was 87 MB), file counts unchanged (682 JS, 21 CSS, 899 total). `mountPath` is still mac/win only (no `linux` key) - `fix_ion_dist_linux.nim` is still required; both sub-patterns matched ([PASS]). No new platform gates, plugin/config keys unchanged
- **New OS detection** (`ZEA()`): returns `macos`/`windows`/`wsl`/`linux` with proper `/proc/version` WSL sniffing; feeds Claude Code managed-settings path resolution (Linux/WSL falls through to `/etc/claude-code` via the default branch). Linux-clean, no patch needed (`fix_enterprise_config_linux.nim` already covers the consumer paths)
- **macOS/Windows-only upstream features** (Linux-irrelevant, no patch needed): tear-off halo overlay, Cowork VM virtualization (`@ant/claude-swift` entitlement, `secureVmFeaturesEnabled`), device simulator panel, native QuickEntry dictation. New win32-only gates are child-process kill (Linux takes the `SIGTERM` else-branch) and WSL settings inheritance
- **No cowork protocol changes** - `control_request`/`control_response` event-stream proxy unchanged, claude-cowork-service not affected
- **Electron** v41.6.1 and **node-pty** 1.1.0-beta34 - unchanged from v1.9255.2

### No patch changes needed

All 47 Nim patches (44 on `index.js`, 1 on `mainView.js`, 1 on `MainWindowPage-*.js`, 1 ion-dist `nim-dir`) applied without modification, plus the `claude-native.js` replace patch. The flexible regex patterns (`[\w$]+` for minified identifiers) absorbed all upstream variable renames automatically. JS syntax valid (`node --check`) on all targets.

---

## 2026-05-27 (v1.9255.2)

- **Version bump:** v1.8555.2 -> v1.9255.2
- **2 new feature flags:** `chatIn3p`, `chatCodeExecution` (29 total, was 27)
- **Patch fix:** `fix_tray_dbus.nim` rebased for merged variable declarations (#109 by @boommasterxd)
- All other 46 patches applied without modification
- **AppImage: auto-register `claude://` protocol handler** (fixes #111, reported by @vastworks) - OAuth sign-in now works on immutable distros (Bazzite, Silverblue, SteamOS). Launcher auto-registers the protocol handler on every AppImage launch. New `--integrate` / `--unintegrate` subcommands for manual control. Also adds `--no-sandbox` for AppImage X11 sessions

---

## 2026-05-23 (v1.8555.2) - All patches clean, new upstream features, Computer Use toggle fix

### Upstream (v1.8555.2)

- **Version bump:** v1.8089.1 -> v1.8555.2
- **All patches applied cleanly** - zero failures, no regex changes needed. Flexible `[\w$]+` patterns absorbed all minified variable renames.
- **3 new feature flags** (27 total, was 25):
  - `tearOffHalo` - macOS 13+ only, visual halo overlay behind controlled windows (uses `@ant/claude-swift`)
  - `grandPrixRequest` - macOS only, device pairing service request availability
  - `bootstrapConfig` - dev-gated (PM() production gate), bootstrap config access
- **New MCP server: "Window Halo"** - macOS-only, hardcoded disabled. Tools: `halo_attach`, `halo_detach` for visual window highlighting
- **Office add-in no longer an MCP server** - functionality moved to IPC-only bridge pattern (`focusOfficeDocument`, `focusBrowserTab`, etc.)
- **New MCP tools** in existing servers:
  - `mcp-registry`: `list_connectors` (lists installed connectors)
  - `plugins`: `list_plugins` (lists installed plugins)
  - `skills`: `suggest_skills` (renders addable skills widget)
  - `cowork`: `list_artifacts`, `read_widget_context` (artifact listing and widget context reading)
- **Operon fully removed** - zero references remain; startup cleanup paths still delete old caches
- **New GrowthBook flags:**
  - Boolean `434204418` (MCP connection non-blocking mode)
  - Listeners `4150329283` (cloud sync drive detection), `2358734848` (hardware buddy)
  - Removed: `658929541`, `2815031518` (setModel buffer checks)
- **New CLAUDE_CODE env vars:** `CLAUDE_CODE_ENABLE_XAA`, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, `CLAUDE_CODE_DISABLE_AGENTS_FLEET`, `CLAUDE_CODE_DISABLE_AGENT_VIEW`, `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING`, `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`, `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_RATE_LIMIT_TIER`, `CLAUDE_CODE_CERT_STORE`, `CLAUDE_CODE_CLIENT_CERT`, `CLAUDE_CODE_CLIENT_KEY`, `CLAUDE_SESSION_INGRESS_TOKEN_FILE`, and more
- **New ANTHROPIC env vars:** `ANTHROPIC_FOUNDRY_API_KEY`, `ANTHROPIC_FOUNDRY_BASE_URL`, `ANTHROPIC_FOUNDRY_RESOURCE`, `ANTHROPIC_SERVICE_ACCOUNT_ID`
- **ion-dist SPA:** 13 new config keys including Bedrock SSO support (`inferenceBedrockSsoStartUrl`, `inferenceBedrockSsoRoleName`, `inferenceBedrockSsoRegion`, `inferenceBedrockSsoAccountId`), credential helpers (`inferenceCredentialKind`, `inferenceCustomHeaders`), gateway auth (`inferenceGatewayOidc`, `inferenceGatewayApiKey`), Foundry (`inferenceFoundryApiKey`), and org banners (`banner.enabled`, `banner.text`)
- **ion-dist bundle:** 667 JS files (was 652), 22 CSS (was 21), 87 MB total (was 86 MB). ZST compressed variants remain removed
- **Voice onboarding audio:** full set of voice onboarding MP3s bundled in ion-dist (`airy`, `buttery`, `glassy`, `mellow`, `round` voices with intro/final/recommendations/pre-voice/pre-recommendations tracks, plus selection samples and SFX)
- **New value/object flag reader split:** `Lh()` for simple values, `Pr()` for structured object reads (was unified in `OQ()`)
- **Session config changes:** removed `artifactMcpConcurrencyLimit` and `artifactSampleConcurrencyLimit` keys; scheduled tasks gained `scheduledTaskOfflineGateEnabled`
- **Feature flags:** function names renamed - `Np()` (static, was `eD()`), `SIA` (async, was `UcA`), `PM()` (gate, was `Nb()`), `wt()` (reader, was `St()`), `Bm()` (listener, was `AS()`)
- **No new platform gates** blocking Linux
- **Electron:** v42.0.0 (check package.json - renderer reports 41.6.1 in extracted bundle but build uses 42.0.0)

### Computer Use toggle fix (#102)

- **Computer Use toggle now works on Linux** - Patch 12 in `fix_computer_use_linux.nim` previously unconditionally bypassed the `chicagoEnabled` preference check. Now reads the user's preference (defaulting to enabled when unset), so users who see the toggle via GrowthBook rollout can actually disable Computer Use.

### No other patch changes needed

All 47+ Nim patches applied without modification. The flexible regex patterns (`[\w$]+` for minified identifiers) absorbed all upstream variable renames automatically.

---

## 2026-05-20 (v1.8089.1) - Point release, integrated titlebar, cowork graceful degradation, landing page, DEB822, build improvements

### Upstream (v1.8089.1)

- **Version bump:** v1.8089.0 -> v1.8089.1
- **All patches applied cleanly** - zero failures, no regex changes needed
- **New upstream: musl/glibc detection** (`bKi()` function) - Linux improvement: properly detects musl vs glibc runtime for `claude-agent-sdk` binary selection
- **New upstream: `getRunningLocalSessions` IPC handler** - auto-updater checks for running cowork/dispatch sessions before applying updates
- **New upstream strings:** OIDC federation env vars (`ANTHROPIC_IDENTITY_TOKEN`, `ANTHROPIC_FEDERATION_RULE_ID`, etc.), device attestation statuses, "claude-mythos-preview" model reference, `CLAUDE_CODE_USE_COWORK_PLUGINS` env var, `ccRemoteControlDefaultEnabled` preference
- **ion-dist SPA:** code unchanged from v1.8089.0 - only change is removal of 704 `.zst` compressed file variants
- **sqlite-worker removed** from upstream build
- **Renderer assets deduplicated** (build tooling cleanup)
- **Feature flags:** identical to v1.8089.0 - same 25 features, same function names (`eD`, `UcA`, `Nb`, `St`, `AS`), same 60 boolean + 5 listener GrowthBook flags
- **No new platform gates** blocking Linux

### Integrated titlebar on Linux

- **Linux now uses the Windows-style integrated titlebar** (`frame:false` + `titleBarOverlay` themed via Anthropic's own background helper, theme-aware) instead of the native frame. Opt out with `CLAUDE_NATIVE_TITLEBAR=1` or the launcher flag `--native-titlebar`. Quick Entry is unaffected.
- New patches: `fix_native_frame.nim` (main process, conditional window options + theme-update gate + opaque overlay color in integrated mode) and `fix_native_frame_renderer.nim` (collapses the upstream `nc-drag` div in `MainWindowPage-*.js` so it no longer absorbs pointer events over the UI buttons).
- Contributed by [@boommasterxd](https://github.com/boommasterxd) ([#100](https://github.com/patrickjaja/claude-desktop-bin/pull/100)).

### Cowork graceful degradation

- **Cowork preamble** now detects socket availability at startup and logs a helpful message with install link when the cowork service is not running.
- **Event subscription guard** (Patch H): skip `createConnection` call when the cowork socket is absent, with a lazy 60s retry that auto-connects once the service appears.
- **Error message URLs** now include full `https://` prefix for clickability.

### Patch fix: restore fix_ion_dist_linux

- **`fix_ion_dist_linux.nim` restored** - the v1.8089.0 update incorrectly claimed Anthropic upstreamed Linux support for the ion-dist 3P config SPA. Verification against the **unpatched** MSIX shows: only the file manager label ("Show in file manager") was upstreamed. The `mountPath` object still lacks a `linux` key, and the platform ternary still falls back to the macOS path on Linux. Both sub-patches are still needed.
- **Regex updated** for v1.8089.0 minified variable names: ternary pattern now uses `[\w$.]+ ` wildcards instead of hardcoded `r`/`t` variable names (v1.8089.0 uses `C===V.Win32?Ve.mountPath.win:Ve.mountPath.mac`).

### APT repo: DEB822 format

- **APT install script now uses DEB822 `.sources` format** instead of legacy one-line `.list` format ([#101](https://github.com/patrickjaja/claude-desktop-bin/issues/101))
- `install.sh` creates `/etc/apt/sources.list.d/claude-desktop.sources` with structured `Types`/`URIs`/`Suites`/`Signed-By`/`Architectures` fields
- **Migration:** re-running `install.sh` automatically removes the old `claude-desktop.list` to prevent duplicate APT entries
- **Manual setup docs** (`packaging/apt/index.html`) updated to match
- Compatible with all supported distros (Debian 11+, Ubuntu 22.04+) - DEB822 has been supported since APT 1.1

### Promotional landing page

- **New static landing page** (`site/index.html`) replaces the minimal APT setup guide at the gh-pages root
- Single-file HTML/CSS/JS - no build step, no framework dependencies
- Dark theme with violet accent, responsive design (mobile/tablet/desktop)
- **UA-based distro detection:** hero terminal and install tabs auto-select the right commands based on visitor's OS
- Sections: hero, tabbed quick-install (Arch/Ubuntu/Fedora/Nix/AppImage), 12-card feature grid, distro+arch compatibility matrix, session type table, Cowork Service (native vs KVM), footer with live badges
- No screenshots included (upstream UI is copyrighted)
- CI change: `build-and-release.yml` now copies `site/index.html` instead of `packaging/apt/index.html` to gh-pages root
- **No impact on package repos** - `deb/`, `rpm/`, `badges/`, `install.sh`, `install-rpm.sh`, `gpg-key.asc` paths all untouched

### Build improvements

- **Smoke tests skipped by default** in all local build scripts (`build-local.sh`, `build-ubuntu-local.sh`, `build-fedora-local.sh`). Pass `--smoke-test` to opt in. CI is unaffected - smoke tests still run there automatically.
- **Electron zip cached across Arch builds** - `build-local.sh` now uses `SRCDEST` to cache `electron-v*.zip` in `cache/`, avoiding ~120MB re-download on every build.
- Removed redundant `--no-smoke-test` flag (default is now skip).
- Updated docs: `CLAUDE.md`, `update-prompt.md`, issue template.

### Update workflow distro-agnostic

- **Issue template, update-prompt, CC prompt** now show build commands for all supported distros (Arch, Ubuntu/Debian, Fedora/RHEL) instead of hardcoding `./scripts/build-local.sh` (Arch-only)
- **Stale extraction paths** replaced: `Claude-Setup-x64.exe` / Squirrel nupkg references updated to `Claude.msix` extraction in issue template, update-prompt.md, and themes/README.md

---

## 2026-05-19 - Enhanced version-check issue template with Linux compatibility checklist

- **Version-check workflow** now creates comprehensive issues with:
  - Copy-paste Claude Code update prompt (injected from `UPDATE-PROMPT-CC-INPUT-MANUAL.md`)
  - Linux compatibility reference tables (5 session types, 7 distros/archs)
  - Full update checklist with dedicated Linux compatibility analysis step
  - Collapsible quick reference commands for platform gate diffs, flag audits
- **New file:** `.github/issue-templates/new-version-body.md` - Markdown template with `{{UPSTREAM}}`, `{{RELEASED}}`, `{{REPO}}`, `{{CC_PROMPT}}` placeholders rendered at workflow runtime
- **UPDATE-PROMPT-CC-INPUT-MANUAL.md** - converted code blocks to indented style (fence-safe for embedding)

---

## 2026-05-19 (v1.8089.0) - Upstream update, ion-dist upstreamed, 12 new flags, Chrome integration, sandbox dirs

- **Version bump:** v1.7196.0 -> v1.8089.0
- **4 patches refreshed** for new minified variable names:
  - `enable_local_agent_mode.nim` - upstream added a compound `&&process.platform!=="win32"` check to the `quietPenguin` inner function (`A5i()`); made regex optional. Async merger terminator changed from `;` to `,` (comma-separated const); updated to match both.
  - `fix_marketplace_linux.nim` - upstream changed scope normalization from a `push(...);continue` loop to a `return` expression. Added new regex for the return-style pattern, old push-style kept as fallback.
  - `fix_tray_dbus.nim` - tray function name `i$A` contains `$` (regex metacharacter). Added `escapeRe()` helper; updated all dynamically-constructed regexes to escape `$`. Also updated listener pattern to handle `zf.on("menuBarEnabled",...)` prefix object.
  - `fix_imagine_linux.nim` - added sub-patch C to force-enable `2204227020` (Visualize in CCD sessions). Total sub-patches: 2 -> 3.
- **1 patch simplified (upstream change):**
  - `fix_office_addin_linux.nim` - office-addin MCP server platform gate `(darwin||win32)&&louderPenguinEnabled` was **removed upstream**. Patches A (isEnabled) and B (init block) are no longer needed. Patch C (connected file detection) remains. Reduced from 3/3 to 1/1 expected patches.
- **1 patch incorrectly removed** (restored in 2026-05-20 fix):
  - `fix_ion_dist_linux.nim` - was removed claiming Anthropic upstreamed Linux support, but only the file manager label was upstreamed. `mountPath` linux key and platform ternary still need patching. See 2026-05-20 entry.
- **1 new patch added:**
  - `fix_sensitive_dirs_linux.nim` - adds Linux-specific sensitive directories to the sandbox protection array: `.local/share/keyrings` (GNOME/KDE credential storage), `.pki` (NSS certificate database), `.config/autostart` (XDG autostart entries). The upstream array had macOS and Windows entries but no Linux-specific ones.
- **12 new GrowthBook flags force-enabled** for Linux (in `enable_local_agent_mode.nim` + `fix_imagine_linux.nim`):
  - High priority: `1129419822` (ENABLE_TOOL_SEARCH auto), `2192324205` (tool use result formatting), `2800354941` (deterministic sorting), `4274871493` (plugin enabled state fetch)
  - Medium priority: `2204227020` (Visualize in CCD sessions - in `fix_imagine_linux.nim`), `2976814254` (Claude Preview dev server), `2067027393` (canLaunchCodeSession), `3246569822` (canSaveSkill)
  - Also enabled: `245679952` (suggestSkills default), `1496676413` (SSH remote MCP/plugin), `1824824999` (consolidate-memory v2), `2114777685` (cowork onboarding)
- **Chrome browser integration improved** (`fix_browser_tools_linux.nim`, 3 new sub-patches):
  - **Chrome user data dir detection** (`O2A` function) - returned `[]` on Linux, breaking extension detection and file watching. Added paths for Chrome (`~/.config/google-chrome`), Chromium (`~/.config/chromium`), Brave (`~/.config/BraveSoftware/Brave-Browser`), Vivaldi (`~/.config/vivaldi`), Opera (`~/.config/opera`). Edge excluded (no Linux version).
  - **Chrome extension auto-install** (`vkr` function) - returned "Unsupported platform" error on non-darwin. Added Linux support: writes External Extensions JSON to both `~/.config/google-chrome` and `~/.config/chromium` directories.
  - **Chrome DevTools opener** (`YOr` function) - had handlers for darwin (`open -a`) and win32 (`start chrome`) but none for Linux. Added `xdg-open "chrome://inspect"` handler.
- **All other patches applied cleanly** without modification
- **Function renames (minification changes):**
  - `pw()`->`eD()` (static registry), `woA`->`UcA` (async merger), `DT()`->`Nb()` (production gate)
  - `pt()`->`St()` (flag reader), `Cm()`->`AS()` (listener)
  - `or`->`Lr` (darwin), `fn`->`Io` (win32), `OiA`->`pj` (darwin||win32)
  - `QoA`->`NcA` (computer-use Set), `saA`->`C5` (supported constant)
- **GrowthBook flags upstream:** 60 boolean (`St()`), 5 listeners (`AS()`). 7 new flags added, 8 removed.
  - New upstream: `1129419822`, `1496676413`, `2049450122`, `2192324205`, `245679952`, `2800354941`, `4274871493`
  - Removed upstream: `982691970`, `1802019210`, `2216480658`, `2860753854`, `3298006781`, `3858743149`, `3885610113`, `4019128077`
  - New listener: `180602792` (midnightOwl prototype)
- **Notable upstream changes:**
  - Visualize (Imagine) MCP server now also enabled for CCD sessions (gated by `2204227020`), not just cowork
  - Office Addin tools refactored: 5 tools reduced to 2 (`office_addin_run`, `office_addin_task`). Bridge architecture changed from MCP server pattern to listener/dispatcher. Platform gate removed.
  - New `floatingPenguinEnabled` preference (config-only, not yet a feature flag in static registry)
- **ion-dist SPA:** 86 MB total (was 100 MB), 652 JS chunks (was 632). File manager label upstreamed (shows "Show in file manager" on Linux), but `mountPath` linux key and platform ternary still need patching.
- **Patch count:** 46 (was 45 - 1 restored + 1 added). All pass, JS syntax validated via `node --check`.

---

## 2026-05-16 - Fix cowork sandbox refs for v1.7196.1

- **`fix_cowork_sandbox_refs.nim` sub-patch A updated** for Claude Desktop v1.7196.1 - upstream collapsed the bash tool description from a three-piece string concat into a single literal, breaking the existing regex. Adds a new pattern for the collapsed literal while keeping the old concat pattern as a fallback for v1.6608.x and v1.7196.0. Contributed by [@boommasterxd](https://github.com/boommasterxd) in [#95](https://github.com/patrickjaja/claude-desktop-bin/pull/95). Fixes [#94](https://github.com/patrickjaja/claude-desktop-bin/issues/94), [#93](https://github.com/patrickjaja/claude-desktop-bin/issues/93).

---

## 2026-05-14 — Sandbox compatibility: systemd user scope optional

- **Launcher skips `systemd-run --user --scope` automatically** when the systemd private socket (`$XDG_RUNTIME_DIR/systemd/private`) is missing or unreachable. Fixes a hard start failure in sandboxes (bwrap, distrobox, containers) where the binary exists but the socket is filtered. Contributed by [@boommasterxd](https://github.com/boommasterxd) in [#92](https://github.com/patrickjaja/claude-desktop-bin/pull/92). Fixes [#89](https://github.com/patrickjaja/claude-desktop-bin/issues/89).
- **`--no-systemd-scope` CLI flag** and **`CLAUDE_DISABLE_SYSTEMD_SCOPE=1` env var** for explicit opt-out when the socket exists but is unreachable (SELinux, bind-mount filters).
- **`--diagnose` output** now shows systemd user socket status.

---

## 2026-05-14 (v1.7196.0) — Upstream update, 3 patch refreshes, no new Linux patches needed

- **Version bump:** v1.6608.2 → v1.7196.0
- **3 patches refreshed** (contributed by @boommasterxd in [#91](https://github.com/patrickjaja/claude-desktop-bin/pull/91)):
  - `fix_imagine_linux.nim` — upstream extended the Visualize MCP server's `isEnabled` callback with an optional `ccd` session type gate (flag `2204227020`). Patch now tries the new disjunction pattern first, falls back to the v1.6608 cowork-only pattern. Forces both `cowork` and `ccd` sessions enabled on Linux.
  - `fix_cowork_first_bash.nim` — upstream may rewrite the events-socket helper from an early-return guard to a Promise-based singleton. Added a second regex for the `Promise.resolve()` pattern. Falls back to the v1.6608 `if(VAR)return` pattern.
  - `fix_dispatch_linux.nim` — upstream added an optional telemetry call (`D8(e,A),`) before the flag return expression in `pt()`. Extended the regex with an optional non-capturing group `(?:[\w$]+\([\w$,]+\),)?`. Existing capture groups unchanged. Falls back to the v1.6608 pattern without telemetry.
- **All other patches applied cleanly** without modification
- **No new features requiring Linux patches** — no new platform gates, no new darwin/win32-only features
- **Function renames (minification changes):**
  - `DoA`→`woA` (async merger — reverted to v1.6608.0 name)
  - `BrA()`→`lrA()` (MCP registration — reverted to v1.6608.0 name)
  - `QoA`→`BoA` (computer-use Set)
  - `xSA`→`FSA` (MCP display labels)
  - `I_` unchanged (MCP registry storage)
  - `or` (darwin), `fn` (win32), `OiA` (darwin||win32) — all unchanged
  - `pw()` (static registry), `pt()` (flag reader), `Cm()` (listener), `OQ()` (value reader), `DT()` (production gate), `Gu` (GrowthBook storage) — all unchanged
- **`wr()` single-value flag reader removed** — function no longer exists. `pr()` now handles all value/object flag reads with nested property access.
- **GrowthBook flags:** 60 boolean (`pt()`), 9 value/object (`pr()`), 5 listeners (`Cm()`), 10 multi-key (`OQ()`). No new or removed flags compared to v1.6608.2.
- **MCP servers unchanged:** Same 22 servers (3 renderer-facing, 14 backend, 4 dynamic per-session, 1 per-artifact). No new servers, no removed servers, no new tools.
- **ion-dist SPA:** 100 MB total, 632 JS chunks, 21 CSS files (unchanged). New `.zst` compressed variants of JS chunks added (704 total). org-plugins mountPath still lacks `linux` key — `fix_ion_dist_linux.nim` patch still required.
- **All 45 patches pass**, JS syntax validated via `node --check`

---

## 2026-05-10 (v1.6608.2) — Point release, doc-only updates

- **Version bump:** v1.6608.1 → v1.6608.2
- **No patch changes required:** All 35+ sub-patches applied cleanly without modification — no minified variable name renames in the main JS (function names `pw()`, `DoA`, `mT()`, etc. all unchanged)
- **MCP registration renames:** `lrA()`→`BrA()` (registration function), `MG`→`I_` (registry storage), `VqA`→`xSA` (display labels), `Y7()`→`pq()` (enumerator)
- **No new MCP servers** — all servers (including Framebuffer, ccd_directory, ccd_session_mgmt) already existed in v1.6608.0; now documented as standalone entries in CLAUDE_BUILT_IN_MCP.md (total documented: 22)
- **21 new GrowthBook server-side flags added** (no feature flag structural changes)
- **Notable new flag capabilities:** session handoff (`2049450122`), cowork memory sync (`975112542`), cowork CU-only mode (`3371831021`), auto-update nudge (`3023518717`), tool-use summaries (`66187241`, `3792010343`)
- **ion-dist SPA:** unchanged (identical build timestamp `1778285308`)
- **All 35+ patches pass**, JS syntax validated

---

## 2026-05-08 (v1.6608.1) — Point release, re-minify only

- **Version bump:** v1.6608.0 → v1.6608.1
- **No patch changes required:** All 35+ sub-patches applied cleanly without modification — this is a pure webpack re-minify with no structural changes
- **No new features, flags, MCP servers, or platform gates**
- **Minified variable renames:** `MW()`→`DT()` (production gate), `woA`→`DoA` (async merger), `fM()`→`Cm()` (listener), `ew()`→`wr()` (single-value reader), `Bn()`→`OQ()` (multi-key reader), `Nvi()`→`vbi()` (louderPenguin async), `D1A()`→`dhA()` (cowork async helper), `Zr`→`sr` (darwin bool), `ys`→`fn` (win32 bool), `BwA`→`YiA` (darwin||win32), `BoA`→`QoA` (computer-use Set), `lrA`→`BrA` (MCP registration)
- **New `1978029737` session config keys:** `coworkWebFetchPrompt`, `memoryIndexSnapshotIdleMs`, `peakHoursStartPst`, `peakHoursEndPst`
- **ion-dist SPA:** JS file count 627→632 (+5), CSS 22→21 (-1), main index bundle ~7.9→~6.9 MB, c71860c77 chunks 12→13; patched patterns unchanged

---

## 2026-05-07 (v1.6608.0) — Upstream update, computer-use patch fix, operon removed

- **Version bump:** v1.6259.1 → v1.6608.0
- **1 patch fix required:** `fix_computer_use_linux.nim` Patch 11 (isEnabled gate) — upstream simplified the function from a ternary `return X(Y)?Z.has(process.platform)&&W():V()` to a direct `return Z.has(process.platform)&&W()`. Updated regex to try new pattern first, old pattern as fallback. All other 42 patches applied cleanly without modification.
- **`operon` feature removed upstream:** Was always `{status:"unavailable"}`, now completely deleted from code. 6 related GrowthBook flags removed: `1306813456`, `1496450144`, `2216480658`, `2433104842`, `2486083521`, `4019128077`. None were referenced by our patches.
- **4 new features added upstream:** `framebufferPreview` (dev-only + flag `1928275548`), `iosSimulator` (dev+darwin-only), `androidEmulator` (dev+darwin-only), `grandPrix` (darwin-only device pairing). None require Linux patches.
- **Async merger reduced:** 5 → 4 overrides (operon evaluator removed); now: louderPenguin, coworkKappa, coworkArtifacts, markTaskComplete
- **New Windows env passthrough:** `$oA()` function passes Windows-specific env vars to CLI spawns; returns `{}` on Linux — no patch needed
- **Function renames:** `v_()→pw()` (static registry), `ZDA→woA` (merger), `Jt()→pt()` (GrowthBook accessor), `qwA→lrA` (MCP registration IPC), computer-use Set `qDA→BoA`, `mVt→ITi` (isEnabled)
- **ion-dist SPA:** minor shrinkage (1612→1552 files, 660→627 chunks, 105→100 MB); patched patterns unchanged
- **No new MCP servers, IPC handlers, or platform gates**

---

## 2026-05-06 — Dispatch hostLoop fix, autostart migration, CLAUDE.md MSIX updates

- **Dispatch patch (`fix_dispatch_linux.nim`):** Force GrowthBook flag `1143815894` (hostLoopMode) OFF alongside dispatch ON. HostLoop bypasses cowork-svc, breaking skills/plugins on Linux. Patch E now handles three states: fully patched, stale combined override, and dispatch-only — adding hostLoop OFF in all cases. Renamed references from `Jr()` to `Pt()` to match v1.6259.1 minified names.
- **Autostart migration (`fix_startup_settings.nim`):** `isStartupOnLoginEnabled()` now migrates old `com.anthropic.claude-desktop[-PROFILE].desktop` files to `claude[-PROFILE].desktop` before checking, so users upgrading from the old APP_ID don't lose their startup-on-login setting.
- **CLAUDE.md:** Updated all references from `Claude-Setup-x64.exe` / nupkg extraction to `Claude.msix` extraction paths. Added per-binary glibc floor table (node-pty 2.31, kwin-portal-bridge 2.39).

---

## 2026-05-06 — Pin Electron version, cache in CI

- **Pinned Electron version:** New `.electron-version` file at project root (currently `42.0.0`). To bump: edit the file and commit — all scripts and CI pick it up automatically.
- **Shared resolution helper:** `scripts/resolve-electron-version.sh` replaces duplicated GitHub API calls in 4 scripts (`generate-pkgbuild.sh`, `build-appimage.sh`, `build-deb.sh`, `build-rpm.sh`). Resolution chain: env override → `.electron-version` → GitHub API fallback.
- **CI caching:** `test-pkgbuild` job now caches the Electron zip (~90MB) with `actions/cache@v4`, avoiding re-download on every run. All packaging jobs receive the pinned version via `ELECTRON_VERSION` env from the `check-version` job output.
- **Removed:** hardcoded `33.2.1` fallback in `build-rpm.sh`, per-build `build/.electron-version` cache in `generate-pkgbuild.sh`.

---

## 2026-05-06 — MSIX migration, APP_ID rename to `claude`, kwin-portal-bridge rebased on Noble

- **MSIX migration:** Anthropic switched the upstream Windows artifact from the Squirrel installer (`Claude-Setup-x64.exe` → nupkg → `lib/net45/resources/`) to a flat MSIX package (`Claude.msix` → `app/resources/`). All build paths updated:
  - `scripts/build-patched-tarball.sh`, `scripts/build-local.sh`, `scripts/build-ubuntu-local.sh`, `scripts/build-fedora-local.sh`, `scripts/extract-version.sh`, and `.github/workflows/build-and-release.yml` now download/extract `Claude.msix`
  - Version is read from `AppxManifest.xml` (`Identity.Version` is `X.Y.Z.0`; trailing `.0` stripped)
  - URL-decoding pass added after extract — MSIX encodes `@` as `%40` (e.g. `@scope` → `%40scope`), which breaks asar's unpacked-file resolver
  - Icon now extracted from `assets/Square150x150Logo.png` (300×300) and resized to 256×256 via ImageMagick; `icotool`/`icoutils` dependency dropped, replaced by `imagemagick`
  - `smol-bin.*.vhdx` now lives under `app/resources/`; missing vhdx is now a hard fail (was best-effort)
  - `.gitignore`: added `/Claude.msix`
- **APP_ID renamed `com.anthropic.claude-desktop` → `claude`:** Chromium auto-generates its inner systemd scope as `app-<app.getName().toLowerCase()>-PID.scope` = `app-claude-…`. Aligning every identifier on the same string (binary basename, `.desktop` filename, `StartupWMClass`, Wayland `app_id`, systemd outer scope, autostart entry, executor `hostBundleId`) makes KDE global shortcuts and persistent xdg-desktop-portal RemoteDesktop authorizations stick across sessions.
  - Launcher: `scripts/claude-desktop-launcher.sh` (`APP_ID='claude'`)
  - Packaging: `PKGBUILD.template`, `packaging/debian/build-deb.sh` + `rules` + new `claude.desktop` (old `com.anthropic.claude-desktop.desktop` deleted), `packaging/rpm/claude-desktop-bin.spec`, `packaging/nix/package.nix`, `packaging/appimage/build-appimage.sh`
  - Patches: `fix_computer_use_linux.nim` (`hostBundleId`), `fix_quick_entry_app_id.nim` (main + Quick Entry app_ids → `claude` / `claude-quick-entry`), `fix_startup_settings.nim` (autostart filename)
  - JS: `js/executor_linux.js` (`DEFAULT_HOST_BUNDLE_ID = 'claude'`)
  - CI smoke tests updated to assert the new binary name
  - **User-visible breaking change:** anyone with the old `com.anthropic.claude-desktop.desktop` pinned to their taskbar must re-pin once after this update; custom WM rules matching `Claude` or `com.anthropic.claude-desktop` need to switch to `claude` (named profiles get `claude-<name>`); GNOME shell extension users (Rounded Window Corners Reborn, Unite, Blur My Shell, ...) who blacklisted `com.anthropic.claude-quick-entry` to hide the shadow rectangle behind Quick Entry must update that entry to `claude-quick-entry`
- **kwin-portal-bridge CI rebased Trixie+zigbuild → Noble+native cross:** Build now uses `ubuntu:noble` with a deb822 multiarch sources file (host=amd64, ports=arm64), `gcc-aarch64-linux-gnu` for cross-link, and rustup-installed toolchain. Removed `cargo-zigbuild` and the glibc 2.31 target. Rationale: kwin-portal-bridge requires KWin 6.6+, and Noble (glibc 2.39) is the oldest base any 6.6+ distro ships — older glibc targeting was buying nothing. The glibc check now version-compares with `sort -V` instead of lexicographic `[[ > ]]` (which would mis-rank `2.10 < 2.4`) and asserts ≤ 2.39.
- **KWin 6.6+ gate in `js/cu_mode_preamble.js`:** Auto-mode now runs `kwin_wayland --version` on KDE Wayland sessions and only enables the kwin-portal-bridge path when `>= 6.6`. Older Plasma sessions fall back to the cross-distro path; the diagnostic line includes the detected KWin version (`auto: cross-distro fallback; KWin 6.5 < 6.6`).
- **`scripts/build-local.sh --pkgrel <REL>`:** New flag (also `-r`) overrides the package release number passed to `generate-pkgbuild.sh`. Unknown args now error out instead of being silently swallowed.
- **`js/executor_linux.js`:** Added `debugLog` calls to `resolvePrepareCapture`, `screenshot`, and `type` for runtime diagnosis of computer-use input/capture issues.

---

## 2026-05-06 (v1.6259.1) — Point release, 3 features removed, new MCP servers & tools

- **Version bump:** v1.6259.0 → v1.6259.1
- **No patch changes needed** — all 43 patches applied cleanly without modification
- **3 features removed upstream:** `floatingAtoll` (was always-supported, now gone), `androidEmulator` (was dev-gated macOS-only), `grandPrix` (was macOS-only device pairing) → static registry 26→23 features
- **New MCP server:** `"skills"` — `list_skills` (interactive skill widget), `search_skills`
- **New tools on existing servers:**
  - Chrome: `browser_batch` (batch browser tool calls), `list_connected_browsers`, `select_browser`
  - ccd_session: `mark_chapter` (flag out-of-scope issues)
  - Radar: `retire_card` (retire no-longer-actionable cards)
  - Cowork: `propose_skills`
- **New Operon tools** (NOT MCP — part of Nest local agent runtime): `copy_file_user_to_claude`, `delete_host_files`, `select_relevant_inputs`
- **Removed tool:** `update_plan` (Chrome)
- **Function renames:** `Y_()→v_()`, `xDA→ZDA`, `UO()→MW()`, `Jt()→Pt()`, `kM()→fM()`, `lp()→ew()`, `dn()→Bn()`; platform vars `Xi→Zr`, `Ds→ys`, `ryA→BwA`; computer-use Set `rwA→qDA`; async helpers `DFA→D1A`, `j_r→evr`, `mFt→jxt`
- **Force-ON defaults:** `2307090146` (plugin OAuth storage) removed from force-ON map; remaining 5 flags unchanged
- **ion-dist SPA:** minor shrinkage (1634→1612 files, 669→660 JS chunks); patched patterns unchanged (same content hashes)
- **New ion-dist config keys:** Bootstrap (bootstrapEnabled/Url/Oidc), Bedrock (AwsDir, BearerToken, ServiceTier), Vertex (BaseUrl, CredentialsFile, OAuth*), Gateway auth scheme `"sso"`, OTLP resource attributes, Cowork/Sandbox (requireCoworkFullVmSandbox, secureVmFeaturesEnabled)
- **All 43 patches pass**, JS syntax validated

---

## 2026-05-06 — Fix duplicate tray icon on theme change

- **Fixed:** Toggling appearance (light/dark/system) in Settings caused a ghost tray icon on XFCE and other StatusNotifierWatcher-based panels. Root cause: the `nativeTheme.on("updated")` handler needlessly destroyed and recreated the tray, even though the Linux icon is always `TrayIconTemplate-Dark.png` regardless of theme. The panel couldn't process the DBus unregistration before the new registration arrived. Fix: `fix_tray_dbus.nim` Step 7 removes the tray function call from the theme handler.

---

## 2026-05-06 (v1.6259.0) — Upstream update, 1 patch fixed, 2 new macOS-only features, auth refactor

- **Version bump:** v1.5354.0 → v1.6259.0
- **Fixed patches:**
  - `fix_asar_workspace_cwd.nim` — upstream removed `return` keyword before `LocalSessions.start:` log statement; regex updated to match standalone log call instead of `return <var>.info(...)` pattern
- **New upstream features (macOS-only, no action needed):**
  - `androidEmulator` — Android emulator integration (dev-gated via `UO()` + macOS-only)
  - `grandPrix` — Device pairing system with pair/disconnect/status IPC bridge (macOS-only + GrowthBook `873030668` partner config)
- **Auth refactor:** Vertex-specific auth (`vertexAuth`, `triggerVertexAuth`, `revokeVertexAuth`) replaced by generic `interactiveAuth` system; gateway SSO endpoints (`gatewaySsoUserCode`, `triggerGatewaySso`) replaced by `authorizeAndProbeMcpServer`
- **New IPC endpoints:** 18 added including `GrandPrix_$_pair`, `interactiveAuth` store, credential helper (`Custom3pHelperRun`, `Custom3pSetup`), `FileSystem_$_writeFileDownload`, `LocalSessions_$_cancelQueuedMessage`, `resolveSSHSettings`, `submitFeedback`
- **New GrowthBook flags:** 3 new boolean flags (`982691970` cowork plugin host ops, `1802019210` cowork plugin upload migration, `2307090146` plugin OAuth storage — added to force-ON defaults); 3 new value flags (`873030668` grandPrix partner config, `1126577245` cowork memory remote sync config, `2921038508` cowork memory guide prompt); 1 removed (`839037100` cowork OAuth configs)
- **New feature:** `desktopTopBar` — always supported (unconditional), new UI chrome element
- **Feature flag renames:** `v_()` → `Y_()`, `ZDA` → `xDA`, `MW()` → `UO()`, `Pt()` → `Jt()`, `fM()` → `kM()`
- **ion-dist SPA:** minor growth (1612→1634 files, 660→669 JS chunks); patched patterns unchanged
- **Cleanup:** Removed duplicate tray implementation from `claude-native.js` — the real tray is created by upstream code (patched by `fix_tray_dbus.nim`); the stub now returns `null` instead of creating a second tray
- **All 43 patches pass**, JS syntax validated

---

## 2026-05-05 — Fix aarch64 tarball path in CI release job

- **Fixed:** `build-aarch64-tarball` job wrote the tarball to `/tmp/` instead of the working directory due to `$(pwd)` resolving inside a subshell after `cd` into a temp dir. Capture absolute path before `cd` (matches DEB/RPM job pattern).

---

## 2026-05-05 — Fix session name leaking into bash tool description (native mode)

- **Fixed:** Patch A in `fix_cowork_sandbox_refs.nim` leaked `vmProcessName` into the native-mode bash tool description — the session name variable was concatenated between two separate ternaries instead of being inside a single ternary's KVM branch. This caused the model to hallucinate `/sessions/<name>/mnt/outputs` paths that don't exist without root.

---

## 2026-05-05 — CI: add PR validation + kwin-portal-bridge cache

- **Added:** `pull_request` trigger on `build-and-release.yml` — contributors now get the full build pipeline on PRs (patches, kwin-portal-bridge, all packaging formats, glibc verification, both architectures)
- **Added:** Concurrency control — pushing new commits to a PR cancels in-progress CI runs
- **Added:** `paths-ignore` — docs-only PRs skip the pipeline
- **Changed:** Release-only jobs (`release`, `deploy-rpm-repo`, `deploy-pages`, `validate-nix`) gated with `github.event_name == 'workflow_dispatch'` — skipped on PRs, no code duplication
- **Optimized:** Cache kwin-portal-bridge binaries keyed on upstream repo HEAD SHA — skips the ~13min Rust build on cache hit, glibc verification still runs every time

---

## 2026-05-04 — AUR: add aarch64 architecture support

- **Added:** `PKGBUILD.template` now declares `arch=('x86_64' 'aarch64')` with arch-specific source arrays and Electron downloads
- **Added:** CI produces a dedicated aarch64 tarball (node-pty + kwin-portal-bridge swapped) uploaded alongside the x86_64 tarball in GitHub releases
- **Updated:** `.SRCINFO` generation emits both architectures and both `source_aarch64`/`sha256sums_aarch64` arrays
- **Updated:** `generate-pkgbuild.sh` accepts `SHA256SUM_AARCH64` and `DOWNLOAD_URL_AARCH64` env vars

---

## 2026-05-01 — kwin-portal-bridge CI: glibc 2.31 compat + aarch64 cross-build

- **Fixed:** Bridge build uses `rust:1-trixie` (PipeWire 1.4, needed for `pw_stream_get_nsec`) + `cargo-zigbuild` targeting glibc 2.31 (was Bullseye/Bookworm which lacked the required PipeWire APIs)
- **Added:** aarch64 cross-compilation in the same Docker step; aarch64 binary uploaded as artifact and swapped into tarball for ARM64 AppImage, DEB, and RPM packages
- **Hardened:** Bridge build failure now stops the pipeline (was a non-fatal warning)

---

## 2026-04-30 — KWin portal bridge & KVM mode for cowork/computer-use

- **New:** Runtime-configured KWin portal bridge support for KDE/Wayland users. `cu_mode_preamble.js` sets `__cuKwinMode` dynamically based on desktop session and environment (detects `kwin-wayland`). `cowork_mode_preamble.js` configures `__coworkKvmMode` based on backend environment or auto-detect (KVM detection via socket presence). ([#54](https://github.com/patrickjaja/claude-desktop-bin/pull/54)) — contributed by [@mosi0815](https://github.com/mosi0815)
- **New:** `executor_linux.js` — full Linux executor implementation (1614 lines) for computer-use input simulation and screenshot capture
- **Refactored:** `fix_computer_use_linux.nim` — major rework with new `cu_mode_preamble.js` dependency
- **Refactored:** `fix_cowork_linux.nim` — reworked with new `cowork_mode_preamble.js` dependency
- **Refactored:** `fix_cowork_sandbox_refs.nim` — Nim port alignment for runtime compatibility
- **Simplified:** `fix_dispatch_linux.nim` — reduced from 89 to 2 lines
- **Removed:** `fix_dispatch_outputs_dir.nim` — no longer needed
- **Bundled:** `kwin-portal-bridge` binary built in CI (`rust:1-bookworm` for glibc compat) and shipped in `locales/` — KDE Plasma Wayland users need zero extra packages for Computer Use
- **Changed:** `cu_mode_preamble.js` resolves bridge binary via `process.resourcesPath` (bundled) before `$PATH` scan; `executor_linux.js` reads resolved path from `globalThis.__cuKwinBridgeBin`

---

## 2026-04-29 — Marketplace plugin scope fix

- **Fix:** Personal plugins installed via Claude Code CLI now appear under "Personal Plugins" instead of the current project header ([#74](https://github.com/patrickjaja/claude-desktop-bin/issues/74), [#75](https://github.com/patrickjaja/claude-desktop-bin/pull/75)). The CLI stores personal plugins with `scope="project"` + `projectPath=$HOME`, and since `$HOME` is a prefix of every project path, they matched the project branch instead of the user branch. New sub-patch B in `fix_marketplace_linux.nim` promotes these entries to `scope="user"` at read time (on-disk JSON unchanged). — contributed by [@boommasterxd](https://github.com/boommasterxd)
- **Hardened:** Moved `patchesApplied` counter inside `proc apply*` (codebase convention), added `process.env.HOME` guard against undefined, added brace-balance verification

---

## 2026-04-29 (v1.5354.0) — Upstream update, 3 patches fixed, 2 new dev-gated features, 13 new GrowthBook flags

- **Version bump:** v1.4758.0 → v1.5354.0
- **Fixed patches:**
  - `fix_window_bounds.nim` — regex now tolerates optional code (profile title hook) between BrowserWindow creation and setup call
  - `fix_dispatch_linux.nim` — sessions-bridge gate variable no longer assumed to be last in `let` declaration; uses two-step find-then-replace approach
  - `fix_dispatch_outputs_dir.nim` — upstream added `Tc()` path-translation wrapper in `shell.openPath()`; regex updated to optionally match wrapper function
- **New upstream features (dev-gated, no action needed):**
  - `framebufferPreview` — VNC framebuffer preview (GrowthBook `1928275548`), gated by `MW()` production gate
  - `iosSimulator` — iOS Simulator integration, macOS-only + dev-gated
- **New GrowthBook flags:** 13 new boolean flags (OAuth configs, memory sync, session notifications, updater rollback, PreToolUse hook, etc.), 2 new value flags, 1 new listener flag; 1 removed (`365342473` telemetry scrub)
- **ion-dist SPA:** bundle grew from 85 MB / 842 files to 105 MB / 1612 files; config UI code-split into 12 lazy-loaded chunks; new MCP server sub-schema fields (`headersHelper`, `oauth`, `transport`, `toolPolicy`, `source`); new `probeEgressHosts` IPC method. Patched patterns unchanged — no patch updates needed.
- **MCP registration:** `gpA()` → `qwA()`, registry `RL` → `MG`, labels `VJA` → `VqA`, enumerator `v7()` → `Y7()`
- **Feature flag renames:** `d_()` → `v_()`, `$yA` → `ZDA`, `yFA()` → `MW()`, `zt()` → `Pt()`, `FG()` → `fM()`
- **All 44 patches pass**, JS syntax validated

---

## 2026-04-26 — Multiple Profiles (multi-instance support)

Run several Claude Desktop windows side by side, each logged in to a different account, with fully isolated state for both Desktop and the Claude Code CLI it spawns. Closes [#58](https://github.com/patrickjaja/claude-desktop-bin/issues/58). — contributed by [@dcelasun](https://github.com/dcelasun) ([#70](https://github.com/patrickjaja/claude-desktop-bin/pull/70))

- New launcher subcommands: `--create-profile=NAME`, `--delete-profile=NAME`, `--list-profiles`
- New flags / env: `--profile=NAME`, `CLAUDE_PROFILE=NAME`, or auto-resolved from basename (`claude-desktop-work`)
- Per-profile isolation: Electron userData, Claude Code config (`~/.claude-NAME`), Quick Entry socket, systemd scope, WM_CLASS / Wayland `app_id`, XDG autostart
- Per-profile Electron binary (hardlink → reflink → copy fallback) for distinct app identity — auto-refreshed on package upgrades
- SSO callback routing via auth-marker mechanism (`fix_profile_url_routing.nim`) — multiple SSO logins work sequentially across profiles
- Profile name in window title: `Claude` → `Claude (work)` in title bar, taskbar, and Alt-Tab (`fix_profile_window_title.nim`)
- Default profile (no flag) is byte-identical to single-instance behavior — no migration needed
- New patches: `fix_profile_url_routing.nim`, `fix_profile_window_title.nim`
- Updated patches: `fix_startup_settings.nim`, `fix_quick_entry_app_id.nim`, `fix_quick_entry_cli_toggle.nim`, `fix_cowork_linux.nim`

---

## 2026-04-25 (v1.4758.0) — Upstream update, 6 patches fixed, 2 new feature flags, GNOME session restore fix

- **Fix:** "Start in system tray" now works with GNOME session restore ([#67](https://github.com/patrickjaja/claude-desktop-bin/pull/67)). GNOME's `gnome-session-service` re-launches saved apps after reboot without the `--startup` flag, so Claude's main window would always appear even when "Start in system tray" was enabled. New heuristic: checks the mtime of the Wayland compositor socket (or D-Bus bus socket on X11) — if Claude starts within 60s of that timestamp, it assumes session-restore and suppresses the main window. — contributed by [@boommasterxd](https://github.com/boommasterxd)
- **Version bump:** v1.3883.0 → v1.4758.0
- **6 patches updated:**
  - `enable_local_agent_mode.nim` — yukonSilver `formatMessage` now called via `Qe().formatMessage` (function invocation before property access); made `()` optional in regex with `(?:\(\))?` to match both old and new intl forms. Added 2 new GrowthBook force-ON patches (3d: `chillingSlothPool` flag `1992087837`, 3e: `markTaskComplete` flag `3732274605`). Merger overrides expanded from 10 to 12. — regex improvement contributed by [@boommasterxd](https://github.com/boommasterxd)
  - `fix_asar_workspace_cwd.nim` — `checkTrust`/`saveTrust` methods gained intermediate `DQ()` path expansion call. Simplified regex to match method signature only (not body), making it robust against future body changes.
  - `fix_computer_use_linux.nim` — CU teach overlay gate moved from after TCC stub to before it (ternary wrapping). Added before-stub ternary check alongside existing after-stub check.
  - `fix_dock_bounce.nim` — Removed `backgroundThrottling` sub-patch (EXPECTED_PATCHES 4→3). Upstream dropped `backgroundThrottling:!1` from webPreferences; Electron now uses its default (`true`), which is what our patch was achieving.
  - `fix_ion_dist_linux.nim` — Platform enum variable renamed `W`→`G` in ion-dist SPA. Changed from hardcoded literal matching to regex capture for dynamic enum variable detection.
  - `fix_locale_paths_pre.nim` — **Removed.** Redundant with `fix_locale_paths.nim` which already handles `index.pre.js` (lines 68-81). Upstream also removed `process.resourcesPath` from `index.pre.js` in this release.
- **2 new feature flags** (22 total, was 20): `chillingSlothPool` (concurrent session pooling, GrowthBook `1992087837`), `markTaskComplete` (task completion, GrowthBook `3732274605`)
- **1 feature moved:** `louderPenguin` moved from static registry to async-only (now solely in $yA merger)
- **0** new MCP servers (17 remain), **0** new `process.platform` gates requiring patches

---

## 2026-04-23 (v1.3883.0) — Bundle all upstream resources, 3P Inference, theme fixes, CI fix, XDG autostart

- **Fix:** "Start at login" toggle now works on Linux ([#60](https://github.com/patrickjaja/claude-desktop-bin/issues/60), [#61](https://github.com/patrickjaja/claude-desktop-bin/pull/61)). The previous patch disabled startup settings entirely on Linux (always returned `false`, write was a no-op). Replaced with proper XDG autostart management: creates/removes `~/.config/autostart/com.anthropic.claude-desktop.desktop` with `Exec=claude-desktop --startup` so the app starts hidden in tray. The toggle now correctly reflects actual autostart state. — contributed by [@boommasterxd](https://github.com/boommasterxd)

- **Fix:** Third-Party Inference configuration now works on Linux ([#57](https://github.com/patrickjaja/claude-desktop-bin/issues/57)). The `ion-dist/` web frontend (85MB, 842 files) was missing from the package — the `app://` protocol handler had nothing to serve. Main process code is already Linux-compatible; the SPA needed minor patching (see below).
- **New patch: `fix_ion_dist_linux.nim`** — patches the ion-dist 3P configuration SPA for Linux:
  - Adds Linux org-plugins mount path (`/etc/claude-desktop/org-plugins`) — upstream only has macOS and Windows paths, so on Linux it showed the macOS path
  - Fixes mount-path display component to use the Linux path when `platform === "linux"` instead of falling back to macOS
  - Dynamically finds the target JS file (content-hashed filename changes every upstream release)
- **Updated: `fix_vm_session_handlers.nim`** — extended IPC error suppression to also cover `LocalSessions` and `QuickEntry` handlers (in addition to existing `ClaudeVM` and `LocalAgentModeSessions`)
- **Build: future-proof resource copying** — replaced individual `cp` commands for locales, tray icons, claude-ssh, and cowork-plugin-shim with a bulk copy of all upstream resources to `locales/`. Windows-only files (`.exe`, `.dll`, `.vhdx`, `.ico`) are excluded. New resources Anthropic adds in future releases will be automatically included.
- **Build: ion-dist post-copy patching** — new build step applies `fix_ion_dist_linux` to ion-dist after resource copy, with graceful skip if ion-dist or the patch binary is unavailable
- **Newly bundled resources:** `ion-dist/` (web frontend), `fonts/`, `drizzle/` (DB migrations), `seed/`, `claude-screen*.png`
- **Fix:** Custom theme `chatFont` override now applies to user-sent messages (not just Claude responses). Added `[data-user-message-bubble]` selectors to both the main theme injection and the cowork font fix.
- **Fix:** `generate-pkgbuild.sh` caches the Electron version in `build/.electron-version` to avoid GitHub API rate limits on repeated builds. Delete the cache file to force a re-fetch.
- **Fix:** CI `deploy-rpm-repo` job failed because `.deb`/`.rpm` packages (~129MB each) exceed GitHub's 100MB git file size limit. Switched from `git push --force` to artifact-based Pages deployment (`actions/upload-pages-artifact` + `actions/deploy-pages`), which supports up to 10GB. No URL or user-facing changes — APT/RPM repos work exactly as before.
- **Docs:** Removed `--install` from CLAUDE.md build examples.

---

## 2026-04-22 (v1.3883.0) — Upstream update, 1 patch fixed, Live Artifacts

- **Version bump:** v1.3561.0 → v1.3883.0
- **1 patch updated:** `fix_dispatch_linux.nim` — Patch F (rjt() text forward) updated to match new upstream pattern. Upstream expanded the message filter with dispatch tool name variables (`SU`/`T4`) behind a gate parameter; our patch now preserves the upstream additions while adding `mcp__dispatch__send_message` and `mcp__cowork__present_files`. Also fixed Patch E idempotency (Jr() already-applied detection used hardcoded param name `t` instead of regex).
- **New feature flag:** `coworkArtifacts` (20 total features, was 19) — persistent HTML artifact storage in cowork sessions (`create_artifact`, `update_artifact`, `list_artifacts` tools). Force-enabled on Linux: merger override + GrowthBook `2940196192` forced ON (4 call sites) in `enable_local_agent_mode.nim`.
- **Live Artifacts working on Linux** — requires [claude-cowork-service](https://github.com/patrickjaja/claude-cowork-service) fix: reverse mount path remapping was applied unconditionally, producing `/sessions/` paths that don't exist on native Linux
- **2** new GrowthBook flags: `2049450122` (session handoff), `2192324205` (dispatch structured content forwarding); **0** removed
- **0** new MCP servers (17 remain), **0** new `process.platform` gates
- Locale i18n JSON files removed from `app.asar` (moved to `resources/` alongside asar — build script already handles this)
- New `@ant/claude-swift` module (macOS-only, no Linux impact)
- `@ant/claude-native-binding.node` now bundled inside asar (handled by existing native shim)

### Upstream diff summary (v1.3561.0 → v1.3883.0)

Variable renames only (all handled by `\w+`/`[\w$]+` wildcards):
- Static registry: `A_()` → `s_()`
- Async merger: `gwA` → `FwA`
- Production gate: `GGA()` → `lUA()`
- Flag reader: `fi()` → `Ii()`
- Listener: `bG()` → `FG()`
- Value flags: `zn()`/`f_()` → `y_()`/`zn()`
- MCP registration: `gpA()` → `FpA()`

---

## 2026-04-20 (v1.3561.0) — Upstream update, all patches applied (no fixes needed)

- **Version bump:** v1.3109.0 → v1.3561.0
- **All 42 patches applied without modification** — webpack re-minify only, no structural changes
- **2** new GrowthBook boolean flags: `1496676413` (SSH plugins/MCP forwarding), `2023768496` (trusted device token); **0** removed
- `123929380` (coworkKappa) promoted to force-ON defaults map — Anthropic enabling consolidate-memory by default
- **0** new MCP servers, **0** new tools (same 17 servers)
- **0** new `process.platform` gates — no new Linux restrictions
- Locale i18n files moved into `ion-dist/i18n/` with `.overrides.json` sidecar files (same language set)

### Upstream diff summary (v1.3109.0 → v1.3561.0)

Variable renames only (all handled by `\w+`/`[\w$]+` wildcards):
- Static registry: `J0()` → `A_()`
- Async merger: `ewA` → `gwA`
- Production gate: `aFA()` → `GGA()`
- Flag reader: `Ti()` → `fi()`
- Listener: `wG()` → `bG()`
- Value flags: `Es()`/`di()` → `zn()`/`f_()`
- MCP registration: `DfA()` → `gpA()`
- Platform vars: `ws` → `ys` (win32), `WhA` → `bfA` (darwin||win32), `en` unchanged (darwin)
- Computer-use Set: `ele` → `rwA`, checker `Jne()` → `nBA()`

---

## 2026-04-20 — Fix Cowork font preference + theme font override ([#52](https://github.com/patrickjaja/claude-desktop-bin/issues/52))

### Fixed
- **Cowork tab font**: The Cowork tab rendered with default Serif font instead of the user's chosen font preference. The claude.ai SPA lazy-initializes font preferences when the Chat view mounts — if Cowork is visited first, the font was wrong. Fixed by injecting CSS on `dom-ready` that reads the font preference from localStorage and applies it immediately. (`fix_cowork_font.nim`)

### Added
- **Theme `chatFont` override**: Custom themes can now override the chat font via a `"chatFont"` key in `~/.config/Claude/claude-desktop-bin.json`. Works per-theme or as a global setting. Only system-installed fonts are supported (`fc-list` to browse).

---

## 2026-04-19 — Quick Entry: socket trigger + Wayland retry gate + timeout reductions (#47, based on PR #50 by @boommasterxd)

### Added
- **`claude-desktop --toggle`**: Fast Quick Entry toggle via Unix domain socket.
  Toggles in ~5-25 ms instead of ~300 ms (no Electron process spawn). Starts the
  app automatically if not running.
  **GNOME users:** run `claude-desktop --install-gnome-hotkey` once to update the
  stored shortcut command.

### Performance
- **`fix_quick_entry_cli_toggle`** (sub-patch D): Unix domain socket server
  injected on startup. Any connection directly calls the Quick Entry toggle
  handler, bypassing the Electron process-spawn + `second-instance` IPC path.
- **`fix_quick_entry_cli_toggle`**: Debounce window reduced from 900 ms to
  100 ms. The GNOME double-fire regression (issue #38) is eliminated by the
  socket path bypassing `second-instance` entirely.
- **`fix_quick_entry_position`**: Position+focus retries (50/150/300 ms) gated
  to X11 only. On Wayland the compositor never repositions windows after
  `show()`, so the retries caused jitter with no benefit.
- **`fix_quick_entry_ready_wayland`**: `ready-to-show` timeout reduced from
  200 ms to 100 ms (Chromium first-paint on Wayland: typically 30-50 ms).
- **`fix_quick_entry_cli_toggle`**: First-instance trigger delay reduced from
  500 ms to 250 ms.
- **`fix_quick_entry_position`**: `execFileSync` timeouts for `xdotool` and
  `hyprctl` reduced from 200 ms to 100 ms.

---

## 2026-04-19 — Add missing patches to README table

### Fixed
- **README patch table** was missing 4 patches: `fix_locale_paths_pre.nim`, `fix_quick_entry_app_id.nim` ([#39](https://github.com/patrickjaja/claude-desktop-bin/issues/39), [PR #46](https://github.com/patrickjaja/claude-desktop-bin/pull/46)), `fix_quick_entry_cli_toggle.nim`, `fix_quick_entry_wayland_blur_guard.nim`. Updated patch count from 38+ to 42+.

---

## 2026-04-18 — Quick Entry gets its own Wayland app_id ([PR #46](https://github.com/patrickjaja/claude-desktop-bin/pull/46) by [@boommasterxd](https://github.com/boommasterxd))

### Fixed
- **Quick Entry window inherits main window's Wayland `app_id`**, causing shell extensions like GNOME Blur My Shell to apply blur/animations to it. New patch `fix_quick_entry_app_id.nim` sets a distinct `app_id` so compositors can treat Quick Entry differently. Fixes [#39](https://github.com/patrickjaja/claude-desktop-bin/issues/39).

---

## 2026-04-18 — Include patch release in version badges

### Fixed
- **Badge version mismatch**: APT, RPM, AppImage, Nix, and version-check badges showed only the base version (e.g. `v1.3109.0`) while AUR showed the full version with patch release (`v1.3109.0-5`). All badges now include `${PKGREL}` to match.

---

## 2026-04-18 — Bundle Electron instead of depending on system package

### Changed
- **AUR PKGBUILD bundles Electron** from GitHub releases instead of depending on the system `electron` package (flagged out-of-date on Arch, installs to version-specific paths that broke the build). Matches how deb/rpm/AppImage packages already work.
- **Runtime deps** changed from `electron` to `alsa-lib`, `gtk3`, `nss` (the shared libraries bundled Electron links against).
- **Electron version fallback removed** across all packaging scripts (deb, AppImage, AUR). Build now fails with a clear error if the GitHub API is unreachable, instead of silently bundling a stale version.
- **Launcher** updated to search `resources/app.asar` path (new bundled Electron layout).

---

## 2026-04-18 — Fix .gitignore excluding Nim patch sources from CI

### Fixed
- **CI build broken**: `patches/.gitignore` patterns (`fix_*`, `add_*`, `enable_*`) excluded `.nim` source files from git. All 41 Nim patches were never committed, causing CI to apply zero patches and crash on `en-US.json` ENOENT. Added `!*.nim` negation to track sources while still ignoring compiled binaries.
- **Nim compile fails on read-only mount**: CI bind-mounts `/input` as read-only, so Nim can't write `.nimcache` or compiled binaries. Build script now copies patches to a writable temp dir when the source dir is read-only.

---

## 2026-04-18 — Fix PKGBUILD cross-device link failure + add makepkg CI test

### Fixed
- **Build fails on cross-device setups** (CachyOS, separate /home partition, btrfs subvolumes): `ln` (hard link) in PKGBUILD can't cross filesystem boundaries. Replaced with `cp` for consistent behavior across all systems.

### Added
- **CI: `test-pkgbuild` job** — runs `makepkg` on a tmpfs (cross-device) inside an Arch container, then runs `namcap` to catch dependency issues before release.

---

## 2026-04-18 — Migrate patch system from Python to Nim

### Changed
- **All 41 patches rewritten in Nim** for ~10x faster build times. Python interpreter startup overhead eliminated.
- Patches compile to native binaries via `patches/Makefile` (`make -j$(nproc)`).
- New orchestrator `scripts/apply_patches.py` runs compiled Nim binaries, stages files on tmpfs.
- `scripts/compile-nim-patches.sh` handles Nim compilation with Docker fallback.
- Large inline JS snippets extracted to `js/` directory (shared between patches via `staticRead`).
- CI updated: Nim + nimble installed in build container, ruff lint replaced with Nim compile check.

### Removed
- All `patches/*.py` files (replaced by `patches/*.nim`)
- `pyproject.toml` (was only for ruff linting of Python patches)

---

## 2026-04-18 — Fix computer-use broken by upstream parameter reorder

### Fixed
- **All computer-use tools returning `Unknown tool: [object Object]`**: Upstream reordered the `handleToolCall(toolName, input, sessionCtx)` parameters. Our `LINUX_HANDLER_INJECTION_JS` template used hardcoded `e`/`t`/`r` matching the old order where `t` was the tool name. After the upstream swap, `t` became the session context object, causing every tool dispatch to hit the `default` branch and stringify the object.
- **Fix**: Replaced hardcoded single-letter param references with placeholders (`__TOOL_NAME__`, `__INPUT__`, `__SESSION__`) that are dynamically substituted with the captured minified parameter names from the regex match at patch time. This makes the injection resilient to future parameter renamings or reorderings.
- **`ese` Set false-positive "already applied"**: Upstream added `"linux"` to an *unrelated* Set (not the computer-use gate `BmA`). Initial fix detected it as "already applied" and skipped the real `BmA` Set, leaving `SdA()` returning `false` on Linux — computer-use MCP server never registered (0 tools). Fixed: always apply to all `["darwin","win32"]` Sets first, only fall back to "already applied" if zero unpatched Sets remain.

---

## 2026-04-17 — Fix computer-use zoom on HiDPI / multi-monitor (issue #32)

### Fixed
- **Zoom returns incorrect region on HiDPI / multi-monitor setups**: `_captureRegion` now accepts and applies a `scaleFactor` parameter, converting Electron's logical pixel coordinates to physical pixels before passing to screenshot tools (grim, spectacle+convert, scrot, etc.). Previously coordinates were passed unscaled, causing wrong crop regions when `scaleFactor > 1`.
- **Zoom ignored active display**: The zoom handler passed hardcoded `displayId=0` instead of the user's pinned display (`switch_display`). Now passes `__cuPinnedDisplay` when set, otherwise auto-detects the monitor from the zoom coordinates.

### Added
- **`_findMonByPoint(px, py)`** helper: determines which monitor contains a given coordinate point, used by both zoom and `_captureRegion` for automatic scaleFactor detection.
- **Display diagnostics at startup**: `[claude-cu] diagnostics: displays=[...]` now logs all detected monitors with dimensions, origins, and scale factors — visible when running `claude-desktop` from a terminal.
- **Zoom debug logging**: `[claude-cu] zoom: rect=... sf=...` logs coordinates, scaleFactor, and target monitor for each zoom call.

---

## 2026-04-17 — Cowork crash fix (`t.platform` → `e.platform`) + patch strictness hardening

### Fixed
- **`patches/fix_computer_use_linux.py`** sub-patches 13b/13c/13d injected `(t.platform==="linux"?...)` inside function `qir(e,A,t)`. In that scope `t` is the installed-apps array (no `.platform`) and `e` is the CU config. On win32 the ternary short-circuited; on darwin/linux every cowork session init crashed with `Cannot read properties of undefined (reading 'platform')`, blocking the CLI spawn entirely. Fixed by using the correct parameter `e`. Comment at line 1015–1019 now documents the scope to prevent regression.

### Changed — patch strictness (prevention for the class of bug above)
Four patches previously allowed `[WARN]` + continue / no counter, so silent anchor drift after an upstream release could hide as "everything's fine" while a feature was broken. All four now enforce `EXPECTED_PATCHES` / `patches_applied` with loud `[FAIL]` on any sub-patch miss (see CLAUDE.md §5b):

- `patches/enable_local_agent_mode.py` — `EXPECTED_PATCHES=11`; yukonSilver NH, coworkKappa flag, navigator spoof, single-file test mode all converted WARN→FAIL; idempotency counting added across 6 sub-patches.
- `patches/fix_cowork_spaces.py` — `EXPECTED_PATCHES=3`; silent `"__spaceMgr__"` fallback (the exact silent-bug class) **removed** — missing singleton regex now fails with an investigation hint.
- `patches/fix_asar_folder_drop.py` — `EXPECTED_PATCHES=2`; second-instance argv parser miss no longer marked "non-critical".
- `patches/fix_dock_bounce.py` — `EXPECTED_PATCHES=4`; `requestUserAttention` required (Option A — drift should surface); `app.focus({steal})` split into real-idempotent vs miss.

### Other
- `scripts/claude-desktop-launcher.sh` — cowork socket age-based cleanup disabled (kept as commented-out block). The 24 h `find -mmin +1440` heuristic was deleting live sockets of healthy long-running daemons; pending replacement with a proper connect-probe health check.

---

## 2026-04-17 — Quick Entry hotkey: GNOME bypass via `gsettings` + CLI trigger (issue #38)

The portal-based path from commit 814e8fb is correct for KDE/Hyprland but unreliable on GNOME — the xdg-desktop-portal GlobalShortcuts approval notification is easy to miss, and Electron's `globalShortcut.register()` returns `true` either way, so the hotkey silently doesn't fire. Empirical check: on this project's Ubuntu GNOME Shell 48 VM, `gsettings get org.gnome.settings-daemon.global-shortcuts applications` was `@as []` — no app had completed the approval flow — despite the portal being available and all identity signals correctly aligned.

### Added
- **New patch `patches/fix_quick_entry_cli_toggle.py`** (3 sub-patches, strict `EXPECTED_PATCHES=3`):
  - **A**: capture the Quick Entry show handler into `globalThis.__ceQuickEntryShow`. Anchored on the stable `.QUICK_ENTRY` enum property name inside `XYe(Iw.QUICK_ENTRY, () => {...})`. All minified identifiers captured with `[\w$]+`.
  - **B**: prepend an argv pre-check to `app.on("second-instance", ...)`. If argv contains `--toggle-quick-entry`, invoke the captured handler and return early — don't fall through to upstream main-window show. Anchored on the literal `"second-instance"` (Electron API surface, stable).
  - **C**: first-instance path — schedule a 500 ms `setTimeout` that fires the handler if `process.argv.includes("--toggle-quick-entry")`. Covers the cold-start case where no `second-instance` event fires. Emitted as part of sub-patch A's replacement so A and C either both apply or both don't.
- **New patch `patches/fix_quick_entry_wayland_blur_guard.py`** — replaces the upstream `Po.on("blur", () => EHA(null))` with a focus-tracked variant. On GNOME Wayland, Mutter's focus-stealing prevention declines to transfer focus to Po on show but Chromium still emits phantom `blur` events because the logical focus state changed. The guard registers `focus`/`blur`/`show`/`hide` listeners and only dismisses on blur **if Po was ever focused since the last show**. If focus never fired (phantom blur), the dismiss is skipped — Po stays open until the user presses Escape or submits. X11 / KDE / Hyprland paths are unchanged (Po focuses normally there, so blur-click-outside-dismiss keeps working).
- **Debounce guard in `patches/fix_quick_entry_cli_toggle.py` handler** — on GNOME the `claude-desktop --toggle-quick-entry` CLI gets delivered as TWO `second-instance` events ~500 ms apart for a single Ctrl+Alt+Space press (empirical: launcher fires once, Electron's `second-instance` event fires twice). Upstream `U$t()` implements toggle semantics (`IHA && Po.isVisible() ? EHA(null) : show`), so the second fire saw Po visible and dismissed it via `kjA()` → `Po.blur()` + `Po.hide()` — the "flashes open, closes" symptom. The handler now debounces with a 900 ms window (`if Date.now() - globalThis.__ceQEInvokedAt < 900 return;`); a deliberate second press >900 ms later still toggles normally.
- **Three launcher subcommands** (`scripts/claude-desktop-launcher.sh`):
  - `--install-gnome-hotkey [ACCEL]` — binds ACCEL (default `<Primary><Alt>space`) to `claude-desktop --toggle-quick-entry` via `gsettings`, under slot `/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/claude-desktop-quick-entry/`. Preserves any other custom keybindings (Python helper for safe array manipulation). Idempotent — re-run with a different accelerator to change it.
  - `--uninstall-gnome-hotkey` — removes the slot from the array and resets the per-slot schema.
  - `--diagnose` — one-shot snapshot: session env vars, Electron path + version (reads the bundled `version` file rather than invoking the binary, which would spawn Claude), systemd-run / gsettings / gdbus availability, `.desktop` file presence at the APP_ID path, portal GlobalShortcuts version, `org.gnome.settings-daemon.global-shortcuts applications` contents (empty means no app has completed approval), whether the project hotkey slot is installed with its name/command/binding, recent launcher log tail.

### Behavior
- Portal path (`--enable-features=GlobalShortcutsPortal`) is **unchanged** and remains the default on native Wayland. Sites where it works — KDE via `kglobalaccel` persistent grants, Hyprland via `xdg-desktop-portal-hyprland` — are unaffected.
- GNOME users get a single-command alternative that bypasses the portal entirely. Paths are independent (no auto-fallback, no double-firing).
- `--toggle-quick-entry` is **not** intercepted by the launcher — it passes through to Electron so the patch sees it in `process.argv` / second-instance argv.

### Deliberately out of scope
- No auto-install of the GNOME hotkey on first launch. Silent gsettings writes conflict with users' existing custom keybindings and are hard to audit afterward — opt-in only.
- No portal-Activated verification or self-healing. Two code paths racing is the class of bug we're avoiding.
- No new IPC channel. `app.on('second-instance')` already gives argv in the main process; bouncing through `ipcMain.handle` adds no capability.
- No changes to the XWayland escape hatch (`CLAUDE_USE_XWAYLAND=1`). GNOME 49 has tightened XWayland key-grab policy anyway, so `--install-gnome-hotkey` is the recommended GNOME path.

### References
- [aaddrick/claude-desktop-debian#404](https://github.com/aaddrick/claude-desktop-debian/issues/404) — same symptom reproduced independently on Fedora 43 GNOME 49.
- `wayland.md` has a new Quick Entry section with full troubleshooting and `--diagnose` reference.

---

## 2026-04-17 (v1.3109.0) — Dispatch rename fix + strict-mode patch hardening

### Upstream diff summary (v1.3036.0 → v1.3109.0)
Re-audited 2026-04-17 by diffing both extracted bundles side-by-side. This version bump is **webpack re-minification only** — no structural or feature-flag changes upstream:

- **0** new files in `app.asar` (only renderer asset-hash bumps)
- **0** new `ipcMain.handle(...)` registrations
- **0** new `process.platform` gates (diff lines are all renames)
- **0** new `status:"unavailable"` feature gates
- **0** new GrowthBook flags, **0** removed (same flag set as v1.3036.0)
- **0** new or removed MCP servers (same 17: 3 renderer-facing + 14 backend)
- **Same 19 features** in the static registry + async merger

No new Linux compatibility patches needed; `[\w$]+` regex wildcards absorbed every minifier rename automatically — except the dispatch IPC bridge, fixed below.

Function renames (full list in CLAUDE_FEATURE_FLAGS.md and CLAUDE_BUILT_IN_MCP.md version-history tables): static registry `nA()`→`J0()`; async merger `ode`→`ewA`; gate wrapper `ESe()`→`aFA()`; flag reader `Wr()`→`Ti()`; value flag readers `fs()`→`Es()` and `wA()`→`di()`; listener `Xk()`→`wG()`; platform vars `hi`→`en` (darwin), `xce`→`ws` (win32), `UMe`→`WhA` (darwin\|\|win32); MCP registration `kce()`→`DfA()`.

### Fixed
- **`fix_dispatch_linux.py` sub-patches F (rjt text forward) & J (auto-wake cold parent)** stopped matching on v1.3109.0 because webpack re-minified the dispatch IPC bridge. Variable rename cascade: rjt item `s→n`; auto-wake session `n→i`, notification `s→n`, child session `e→A`, index `r→t`, logger `B/P→M`. Both patterns now use `[\w$]+` captures with backreferences so future minification shifts self-heal.

### Changed — strict-mode patch hardening
Per project rule "a failed sub-patch means upstream changed — investigate, don't silently skip", converted `[WARN]` (silent continue) to `[FAIL] + return False` in every case where a required pattern was not found and no already-patched marker exists:
- `fix_dispatch_linux.py` — C (platform label), D (telemetry gate), F (rjt), J (auto-wake)
- `fix_updater_state_linux.py` — idle-state version/versionNumber
- `fix_native_frame.py` — titleBarStyle, autoHideMenuBar, window icon
- `fix_dock_bounce.py` — backgroundThrottling
- `fix_window_bounds.py` — Quick Entry blur-before-hide
- `fix_cross_device_rename.py` — now idempotent via EXDEV-catch marker detection
- `fix_0_node_host.py` — shellPathWorker

Idempotency tails ("No changes made") and counter-enforced patches left unchanged — those paths are already safe.

---

## 2026-04-16 — Quick Entry fixes: portal identity + transparency (issues #38, #39)

### Fixed
- **Quick Entry hotkey only works when Claude has focus** (issues #38, upstream aaddrick #404): root cause is app identity. `xdg-desktop-portal` identifies unsandboxed apps by their systemd-scope / cgroup name and matches them against the installed `.desktop` file. We previously shipped as `"Claude"` (`app.setName` default, plus `claude-desktop.desktop`), which is not a valid reverse-URL and can't be resolved by the portal → GlobalShortcuts registrations succeed but Activated events never route back to the app. Fix aligns every identity signal on `com.anthropic.claude-desktop`. Credit to the KDE-side reporter who diagnosed the same class of problem for persistent grants in KDE Settings.
- **Quick Entry window shows opaque square behind the rounded card** (issue #39): Chromium transparency silently fails on some Wayland compositors when `--enable-transparent-visuals` isn't set. Adding the flag forces ARGB visuals; the 606×470 Quick Entry window now renders its outer area transparently as intended.

### Changed — launcher (`scripts/claude-desktop-launcher.sh`)
- New constant `APP_ID='com.anthropic.claude-desktop'` — the canonical reverse-URL id used across packaging and runtime.
- **Launch via `systemd-run --user --scope --unit=app-${APP_ID}-$$.scope`** — gives the Electron process a named systemd user scope so the portal resolves cgroup → scope name → matching `.desktop` file. Falls back to direct `exec` if `systemd-run` is unavailable.
- **New Chromium flag `--class=${APP_ID}`** — Wayland `app_id` / X11 `WM_CLASS` now match the `.desktop` filename and `StartupWMClass`.
- **New Chromium flag `--enable-transparent-visuals`** — fixes the #39 "opaque rectangle" symptom on most Wayland configs. Harmless on X11.
- **Electron <40 warning** — prints a clear message on startup (`log` + stderr) pointing users at [electron/electron#49806](https://github.com/electron/electron/issues/49806) and asking them to update. No silent XWayland fallback — the bug is upstream, users should update Electron. `CLAUDE_USE_XWAYLAND=1` remains as a manual escape hatch for users who can't.
- `app.setName("Claude")` is **not** changed — userData (`~/.config/Claude`) stays put.

### Changed — packaging
- `.desktop` filename is now `com.anthropic.claude-desktop.desktop` across every format (RPM, DEB, AUR, AppImage, Nix). `StartupWMClass` updated to match. `Name=` / `Icon=` unchanged.
- Existing pinned shortcuts referencing `claude-desktop.desktop` will need to be re-pinned once (minor one-time inconvenience; the new desktop entry is picked up by `update-desktop-database` automatically).

### Known limitation
- **Nix flake**: the Nix package uses `makeWrapper` rather than our shared launcher script, so the `systemd-run` scope wrap does not apply to Nix builds. `--class` and `--enable-transparent-visuals` are wired in. Portal identity on Nix would require a small wrapper-of-wrapper; deferred.

### Patches — unchanged
- `fix_quick_entry_position.py`, `fix_quick_entry_ready_wayland.py`, `fix_window_bounds.py`, `fix_native_frame.py` — all still correct and still needed; the current symptoms were outside the asar surface they touch.

### References
- electron/electron#49806 — `globalShortcut` fails on Wayland with `GlobalShortcutsPortal` feature enabled.
- electron/electron#49842 — Fix merged 2026-02-19, backported to 40-x-y and 41-x-y. Not backported to 39.

---

## 2026-04-16 (v1.3036.0) — Upstream update, 1 patch removed (obsolete)

### Upstream
- **Version bump:** v1.2773.0 → v1.3036.0
- Same 19 features — no additions or removals
- Function renames: `Hb()`→`nA()` (static registry), `Mle`→`ode` (async merger), `G1e()`→`ESe()` (gate function), `QR()`→`Xk()` (listener), `us()`→`fs()` / `cA()`→`wA()` (value flags), `ooe()`→`kce()` (MCP registration)
- Platform variables renamed: `vs`→`xce` (win32), `r6e`→`UMe` (darwin||win32). `hi` (darwin) unchanged.
- **`Wr()` boolean flag reader name unchanged** — first release in a while without a flag-reader rename
- 4 new GrowthBook flags: `658929541` (LAM setModel buffer check / ccd_lock mitigation), `1496450144` (CLAUDE_CODE_ENABLE_TASKS env var), `2800354941` (plugin/skill alphabetical sort), `2815031518` (LocalSessionManager setModel buffer check / ccd_lock mitigation)
- 3 removed GrowthBook flags: `159894531` (ENABLE_TOOL_SEARCH env-var override — upstream dropped the Desktop-side `"false"` override entirely, user settings.json now passes through), `919950191` (LAM-specific tool search), `2678455445` (MCP SDK server mode)
- Same 17 MCP servers

### Patches
- **Removed: `enable_local_agent_mode.py` Patch 3c** — flag `159894531` no longer exists. Upstream removed the ENABLE_TOOL_SEARCH="false" Desktop override that the patch was working around. `ENABLE_TOOL_SEARCH` now passes through from the user's environment / `~/.claude/settings.json` without Desktop interference. The patch replaced the only failing sub-patch — everything else applied cleanly.
- All other 39 patches (38 Python + 1 JS) applied without modification — `[\w$]+` regex patterns handled all renames automatically

### Documentation
- **CLAUDE_FEATURE_FLAGS.md** — updated all function names (static registry, async merger, gate function, listener, value-flag readers, MCP registration) and platform-variable names, added new flags section, removed flags section, version history entry
- **CLAUDE_BUILT_IN_MCP.md** — version number updated, registration function rename noted, version history entry
- **CHANGELOG.md** — this entry

---

## 2026-04-16 (v1.2773.0) — Upstream update, all patches applied (no fixes needed)

### Upstream
- **Version bump:** v1.2581.0 → v1.2773.0
- Same 19 features, no additions or removals
- `chillingSlothFeat` gate changed: `process.platform!=="darwin"` → `r6e` (darwin||win32 combined variable). Our patches handle this gracefully (Patch 1 finds 1 match instead of 2, elif branch; Patch 3 merger override still forces supported)
- `floatingAtoll` now always `{status:"supported"}` unconditionally (was preference-gated via `floatingAtollActive` + GrowthBook `1985802636` listener). Listener for `1985802636` removed
- Function renames: `iA()`→`Hb()` (static registry), `jue`→`Mle` (async merger), `XEe()`→`G1e()` (gate function), `Yr()`→`Wr()` (flag reader), `VI()`→`QR()` (listener), `xs()`→`us()` / `_A()`→`cA()` (value flags)
- Platform variables renamed: `_s`→`vs` (win32), `c3e`→`r6e` (darwin||win32), new named `pi` (darwin)
- MCP registration function renamed: `One()`→`ooe()`
- Computer-use Set variable renamed: `ese`→`ele`, checker `Lte()`→`Jne()`
- 4 new GrowthBook flags: `919950191` (LAM tool search), `2140326016` (author stubs error), `2216480658` (VM outputs), `3858743149` (maxThinkingTokens config, default 4000)
- 3 removed GrowthBook flags: `1585356617` (epitaxy routing), `2199295617` (AutoArchiveEngine), `4201169164` (remote orchestrator — was already hardcoded off)
- Same 17 MCP servers (Chrome, mcp-registry, office-addin, radar, computer-use, terminal, visualize, scheduled-tasks, cowork-onboarding, dev-debug, plugins, Claude Preview, dispatch, cowork, session_info, workspace, ccd_session)

### Patches
- **Enhanced: `enable_local_agent_mode.py`** — added Patch 3c: force GrowthBook flag `159894531` to true (2 call sites). Without this, Desktop sets `ENABLE_TOOL_SEARCH="false"` as env var when spawning the CLI, silently overriding the user's `~/.claude/settings.json`. With the patch, CCD sessions get `"auto"` and LAM sessions get the correct gate value — matching macOS/Windows behavior.
- All other 39 patches applied without modification (38 Python + 1 JS) — `[\w$]+` regex patterns handled all renames automatically

---

## 2026-04-15 — Fix integrated terminal (node-pty) loading on all distros

### Bug Fix
- **Integrated terminal broken** — `node-pty`'s native `pty.node` was packed inside `app.asar` where Electron can't `dlopen()` native modules. Fixed `build-patched-tarball.sh` to use `asar pack --unpack "{**/*.node,**/spawn-helper}"` so Electron's loader redirects `require()` to `app.asar.unpacked/`.
- **Missing `spawn-helper`** — `@electron/rebuild` only builds `.node` modules, not executables. Added `gcc` build of `spawn-helper` from node-pty source (pure C, no Node deps). Required by `pty.fork()` to spawn PTY shell processes.
- **All distros covered** — the tarball produced by `build-patched-tarball.sh` is consumed by all packaging scripts (Arch PKGBUILD, Debian, RPM, AppImage, Nix) via `cp -r app/*`, so the fix propagates automatically.
- **ARM64 + glibc-compat** — updated `scripts/rebuild-pty-for-arch.sh` and the CI inline glibc-compat Docker rebuild step to also build and install `spawn-helper` alongside `pty.node`.

---

## 2026-04-14 (v1.2581.0) — Upstream update, all patches applied (1 fixed)

### Upstream
- **Version bump:** v1.2278.0 → v1.2581.0
- **New feature: `coworkKappa`** — 19th feature flag added. Static entry `sPn()` always unavailable; async override `aPn()` depends on `yukonSilver` + GrowthBook flag `123929380`. Gates a `consolidate-memory` skill ("Reflective pass over memory files — merge duplicates, fix stale facts, prune the index") and auto-memory directory for typeless sessions. **Enabled on Linux** — forced flag `123929380` to true (3 call sites) and added merger override. Purely local file I/O, no VM needed.
- Async merger `jue` now uses 3-way `Promise.all([tPn(), Xsr(), aPn()])` (was 2-way) adding `coworkKappa` alongside `louderPenguin` and `operon`
- Function renames: `eA()`→`iA()` (static registry), `yue`→`jue` (async merger), `CEe()`→`XEe()` (gate function), `Zr()`→`Yr()` (flag reader)
- Platform variables renamed: `vs`→`_s` (win32), `IOe`→`c3e` (darwin||win32)
- 1 new GrowthBook boolean flag: `123929380` (coworkKappa / consolidate-memory skill)
- 1 removed GrowthBook flag: `4040257062` (memory path routing — was new in v1.1348.0)
- Same 6 MCP servers (Chrome, mcp-registry, office-addin, radar, visualize, computer-use)

### Patches
- **Fixed: `fix_tray_dbus.py`** — tray variable pattern was too strict: used `\w+` which can't match `$` in JS identifiers (tray variable is now `$m`), and required `});` immediately before `let XX=null;` but the event listener registration now sits in between. Changed to `[\w$]+` and removed the `\}\);` prefix from the pattern.
- **Enhanced: `enable_local_agent_mode.py`** — added `coworkKappa` as 9th feature override in merger + bypassed GrowthBook flag `123929380` (3 call sites). Enables `/consolidate-memory` skill and auto-memory directory for sessions on Linux.
- All other 34 patches applied without modification — `[\w$]+` regex patterns handled the renames automatically

### ARM64 / Raspberry Pi 5
- **ARM64 integrated terminal** — node-pty is now cross-compiled for arm64 via Docker + QEMU in CI, replacing the old "strip x86_64 pty.node" workaround. All ARM64 packages (deb, rpm, AppImage) now include a working integrated terminal.
- **New: `scripts/rebuild-pty-for-arch.sh`** — reusable script for cross-compiling node-pty to any target architecture. Verifies the produced binary matches the target arch.
- **Nix aarch64-linux** — `packaging/nix/package.nix` now lists `aarch64-linux` in `meta.platforms`
- **Raspberry Pi 5** — added to supported devices in README alongside DGX Spark and Jetson
- **`enable_local_agent_mode.py`** — added `coworkKappa:{status:"supported"}` to feature merger overrides and force-enabled GrowthBook flag `123929380` (consolidate-memory skill, auto-memory for typeless sessions)

### Documentation
- **CLAUDE_FEATURE_FLAGS.md** — added `coworkKappa` (19th feature), updated all function names, added flag `123929380`, removed flag `4040257062`, version history entry
- **CLAUDE_BUILT_IN_MCP.md** — version number updated
- **CHANGELOG.md** — this entry

---

## 2026-04-14 (v1.2278.0) — Upstream update, all patches applied (3 fixed)

### Upstream
- **Version bump:** v1.1617.0 → v1.2278.0
- **No structural changes** to feature flag architecture — same 18 features, same 3-layer system
- Function renames only: `wb()`→`eA()` (static registry), `Soe`→`yue` (async merger), `bbe()`→`CEe()` (gate function), `rn()`→`Zr()` (flag reader), `Db()`→`_A()` / `Gs()`→`xs()` (value flags)
- **`chillingSlothFeat` gate changed** from darwin-only (`g5e`) to darwin||win32 (`IOe`) — Linux still excluded, handled by merger override
- Platform booleans now named `hi` (darwin), `vs` (win32), `IOe` (combined)
- 5 new GrowthBook boolean flags: `286376943` (plugin skills), `1434290056` (dispatch permissions), `2345107588` (GrowthBook cache), `2392971184` (replay messages), `2725876754` (org CLI exec policies)
- 1 new value flag: `1893165035` (SDK error auto-recovery config)
- New `index.pre.js` bootstrap file with enterprise config loading
- Enterprise config switched from switch/case to ternary structure
- Same 6 MCP servers (Chrome, mcp-registry, office-addin, radar, visualize, computer-use)

### Patches
- **Fixed: `fix_cowork_first_bash.py`** — upstream renamed event socket functions (`ZVt`→`$er`, `Sq`→`oH`, `Ts`→`Ps`) and variable (`mA`→`nE`). Converted from exact byte match to regex pattern with dynamic variable detection. Now finds the events socket variable by anchoring on `subscribeEvents` context.
- **Fixed: `fix_cowork_linux.py` Patch F** — `$w` function renamed to `ub`. Changed hardcoded `\$w\(` in regex to `([\w$]+)\(` to match any function name dynamically.
- **Fixed: `fix_enterprise_config_linux.py`** — enterprise config structure changed from switch/case (`case"win32":VAR=FUNC();break;default:VAR={};break`) to ternary chain (`process.platform==="darwin"?FUNC_D():process.platform==="win32"?FUNC_W():{}`). Updated regex pattern to match the new ternary form. Now also patches `index.pre.js` (new bootstrap file) for early-boot enterprise config.
- All other 35 patches applied without modification — `[\w$]+` regex patterns handled the renames automatically

### Documentation
- **CLAUDE_FEATURE_FLAGS.md** — updated all function names, added 5 new boolean flags + 1 value flag, version history entry, `chillingSlothFeat` gate change noted
- **CLAUDE_BUILT_IN_MCP.md** — version number updated
- **CHANGELOG.md** — this entry

---

## 2026-04-11 (v1.1617.0) — Fix Cowork skills/plugins broken by hostLoopMode

### Patches
- **Critical fix: `fix_dispatch_linux.py`** — removed erroneous override of GrowthBook flag `1143815894` (hostLoopMode). Forcing this flag `true` made Desktop bypass the cowork service spawn entirely, falling back to a bare HostLoop SDK that lacks `mcp__workspace__bash` and plugin skill mapping. Result: all Cowork skills (`/pdf`, `/docx`, `/pptx`, etc.) returned "Unknown skill" and sessions completed in ~12ms with zero API calls. Fix: only override flag `3558849738` (dispatch agent name), leave `1143815894` to its default so the cowork service handles session spawning.
- **New sub-patch: `fix_cowork_linux.py` Patch F** — allows `present_files` MCP tool to accept native host paths. Previously, `present_files` only accepted `/sessions/` VM paths; on native Linux without root (no `/sessions/` symlink), all files failed the accessibility check. The patch falls back to checking the host outputs directory.

### Build
- **Copy missing `cowork-plugin-shim.sh`** — the plugin permission bridge file was present in the upstream exe but not copied during build. Without it, Desktop logs a `[warn] ENOENT` on every session start. The shim enables the confirmation UI for plugin operations (e.g., "allow send email?") but is not required for skills to load — the actual skills breakage was caused by the hostLoopMode flag above.

---

## 2026-04-10 (v1.1617.0) — Fix RPM glibc compatibility

### Build
- **Fix RPM install failure on Fedora 40** — the node-pty rebuild (added in `6509b00`) compiled `pty.node` inside the `archlinux:base-devel` CI container, which links against glibc 2.42 (Arch rolling release). rpmbuild auto-detected this as a package dependency, making the RPM uninstallable on Fedora 40 (glibc 2.39). Fix: added a post-processing CI step that rebuilds `pty.node` inside a `node:20-bullseye` container (Debian 11, glibc 2.31), then repackages the tarball. This makes the RPM compatible with Fedora 38+, Ubuntu 20.04+, Debian 11+, and RHEL 9+.

---

## 2026-04-10 (v1.1617.0) — New patch: fix dispatch outputs dir

### Patches
- **New patch: `fix_dispatch_outputs_dir.py`** — fixes "Show folder" opening an empty outputs directory for dispatch sessions. On Linux with the native Go backend, the dispatch parent and child sessions have separate directories. When the parent's outputs dir is empty, the patch scans sibling session directories for one that has files and opens that instead. Uses `[\w$]+` regex wildcards and `require("fs")`/`require("path")` for version resilience.

---

## 2026-04-10 (v1.1617.0) — Upstream update, 38 patches (3 new)

### Upstream
- **Version bump:** v1.1348.0 → v1.1617.0
- **No structural changes** to feature flag architecture — same 18 features, same 3-layer system
- Function renames only: `gb()`→`wb()` (static registry), `eoe`→`Soe` (async merger), `Kwe()`→`bbe()` (gate function), `tn()`→`rn()` (flag reader), `LI()`→`ZI()` (listener), `js()`→`Gs()` / `$b()`→`Db()` (value flags)
- Platform gate variable renamed: `z5e`→`g5e` (same `darwin||win32` pattern)
- computerUse Set variable renamed: kept as `Hae` with `Lte()` checker
- No new GrowthBook flag IDs added or removed
- **New MCP server: `radar`** — records actionable items (`record_card` tool), currently **disabled** (`isEnabled:()=>!1`)
- **New renderer windows:** `buddy_window/`, `find_in_page/`
- **New infrastructure:** `transcript-search-worker/`, `sqlite-worker/`
- **New dependencies:** `node-pty` (1.1.0-beta34), `ws` (^8.18.0), `@ant/imagine-server`
- Operon: same 33 sub-interfaces, no changes
- 3 force-ON GrowthBook flags upstream: `2976814254`, `3246569822`, `1143815894` (hardcoded in `m6r` map) — note: our patch no longer overrides `1143815894` (see 2026-04-11 fix)

### Patches
- All 35 existing patches applied without modification — minified variable names changed but `[\w$]+` regex patterns handled the renames automatically
- **New patch: `fix_imagine_linux.py`** — enables Imagine/Visualize MCP server on Linux by forcing GrowthBook flag `3444158716`. Provides `show_widget` (inline SVG/HTML rendering) and `read_me` (CSS/theme guidance) tools in Cowork sessions. No platform gate exists upstream — only the server-side flag was blocking it.
- **New patch: `fix_cowork_sandbox_refs.py`** — replaces upstream system prompts and tool descriptions that tell the model it runs in "a lightweight Linux VM (Ubuntu 22)" / "isolated sandbox". On Linux with the native Go backend there is no VM — the model now correctly understands it runs directly on the host. Patches: bash tool description (Edn function), cowork identity prompt, computer use explanation, and 3× "isolated Linux environment" references.
- **New patch: `fix_cowork_first_bash.py`** — fixes first bash command in Cowork sessions returning empty output. Root cause: events socket (`yUt`) opens async but `qTe()` sends spawn immediately via the RPC socket — on Linux the command completes before events are subscribed. Fix: poll-wait for `mA` (events socket connection) before spawning. Not visible on macOS/Windows where the VM boot delay masks the race.

### Documentation
- **CLAUDE_FEATURE_FLAGS.md** — updated function names, version history table
- **CLAUDE_BUILT_IN_MCP.md** — new `radar` server (full tool schema), expanded `visualize` server docs, platform gate variable renames, node-pty status, version notes
- **README.md** — added `fix_imagine_linux.py` to patch table
- **CHANGELOG.md** — this entry

### Build
- **node-pty rebuilt for Linux** in `build-patched-tarball.sh` — installs source from npm, rebuilds against Electron 40.8.5 headers via `@electron/rebuild`, replaces Windows PE32+ binaries with Linux ELF. Enables the integrated terminal and `read_terminal` MCP tool. Build dependency: `npx` (already required for asar).

### Known Limitations
- **Radar**: Server disabled at MCP level (`isEnabled:()=>!1`), session creation in renderer code. Not activatable yet.

## 2026-04-08 (v1.1348.0) — Upstream update, all 34 patches apply cleanly

### Upstream
- **Version bump:** v1.1062.0 → v1.1348.0
- **No structural changes** to feature flag architecture — same 18 features, same 3-layer system
- Function renames only: `Ow()`→`gb()` (static registry), `xse`→`eoe` (async merger), `m0e()`→`Kwe()` (gate function), `rn()`→`tn()` (flag reader), `wR()`→`LI()` (listener), `Js()`→`js()` / `j1()`→`$b()` (value flags)
- New GrowthBook boolean flag: `4040257062` (memory path routing for non-session contexts)
- New GrowthBook value flags: `254738541` (prompt), `4066504968` (setup-cowork skill config), `365342473` (shouldScrubTelemetry)
- New value flag keys: `1978029737` gained `artifactMcpConcurrencyLimit`, `idleGraceMs`, `disableSessionsDiskCleanup`, `sessionsBridgePollIntervalMs`, `coworkMessageTimeoutMs`; `3300773012` gained `scheduledTaskPostWakeDelayMs`, `dispatchJitterMaxMinutes`
- Removed GrowthBook flags: `927037640` (subagent model config), `3190506572` (Chrome permission control)
- Operon sub-interfaces: 31 → 33 (new: `OperonDesktop`, `OperonMcpToolAccessProvider`)
- 3 new cowork tools: `create_artifact`, `update_artifact` (flag `2940196192`), `save_skill` (conditional)
- New `Buddy` BLE device pairing IPC (macOS hardware accessory)
- Terminal server upstream regression: `z5e` (darwin||win32) replaced `LRe` (which included Linux) — already handled by `fix_dispatch_linux.py` `z5e` patch
- `chillingSlothFeat` gate changed from `process.platform!=="darwin"` to `z5e` variable — also handled by `z5e` patch + merger override
- Electron 40.8.5

### Patches
- All 34 existing patches applied without modification — minified variable names changed but `[\w$]+` regex patterns handled the renames automatically
- Terminal server Linux support maintained via existing `fix_dispatch_linux.py` `z5e` patch (no new patch needed)
- **New patch: `fix_buddy_ble_linux.py`** — enables Hardware Buddy (Nibblet M5StickC Plus BLE device) on Linux by forcing GrowthBook flag `2358734848`. BLE communication uses Web Bluetooth via BlueZ — no native code needed. Requires `bluez` package.

### Documentation
- **CLAUDE_FEATURE_FLAGS.md** — updated function names, GrowthBook flag catalog, version history table
- **CLAUDE_BUILT_IN_MCP.md** — new cowork tools, terminal regression note, Operon sub-interfaces
- **CHANGELOG.md** — this entry

## 2026-04-07 — Fix CU system prompt: model no longer misidentifies Linux as macOS

### Fixed
- **fix_computer_use_linux.py** sub-patch 14a: "Separate filesystems" system prompt paragraph replaced with "Same filesystem" on Linux — the CLI and desktop share the same machine, there is no sandbox
- **fix_computer_use_linux.py** sub-patch 14b: macOS app names "Maps, Notes, Finder, Photos, System Settings" replaced with distro-generic terms "the file manager, image viewer, terminal emulator, system settings" (works across Arch, Ubuntu, Fedora, NixOS)
- **fix_computer_use_linux.py** sub-patch 14c: File manager name "Finder" → "Files" on Linux in host filesystem guidance

### Root cause
The CU system prompt builder only distinguished Windows vs non-Windows, giving Linux sessions macOS-specific text ("Separate filesystems", "Finder", sandbox references). The model used these cues plus visual similarity to misidentify Linux desktops as macOS. The `.host-home` path examples (`/Users/alice/...`) were already skipped on Linux due to `hostLoopMode=true`.

## 2026-04-07 — Strict patch validation, `[\w$]+` regex hardening, built-in MCP/flag audit

### Fixed
- **fix_dispatch_linux.py** Patch D: telemetry gate variable `F$e` not matched by `\w+` (contains `$`)
- **fix_startup_settings.py** Patch 2: logger variable changed `re` → `R` upstream; now uses flexible `[\w$]+` pattern
- **fix_computer_use_linux.py** Patch 7: teach overlay gate function `nee()` not in hardcoded allowlist; now uses generic `[\w$]+()&&(` pattern

### Changed
- **16 patch files**: All `\w+` regex patterns matching JS identifiers replaced with `[\w$]+` to handle minified names containing `$`
- **8 patch files**: Lenient success criteria (`patches_applied == 0`) replaced with strict `EXPECTED_PATCHES` check — all sub-patches must succeed or the build fails
- **fix_app_quit.py**: Changed silent `sys.exit(0)` on failure to `sys.exit(1)`

### Docs
- **CLAUDE.md**: Added Section 5b "Patch Strictness Rules" — all sub-patches must match, `[\w$]+` required for JS identifiers
- **CLAUDE_BUILT_IN_MCP.md**: Added `update_plan` Chrome tool, `read_me` widget tool, `cowork-artifact` dynamic servers, `web_search` API built-in, fixed `scheduled-tasks` server name, Operon expanded to 31 sub-interfaces, v1.1062.0 version notes
- **CLAUDE_FEATURE_FLAGS.md**: Added Operon tool inventory (14 brain + 7 compute + 1 dynamic + 4 internal LLM tools), 3 new Operon interfaces, new/removed GrowthBook flags for v1.1062.0

## 2026-04-07 — Portal+PipeWire screenshots for GNOME Wayland 46+ (#28)

### Added
- **fix_computer_use_linux.py**: XDG ScreenCast portal screenshot method with PipeWire restore tokens for GNOME Wayland 46+. First screenshot shows a one-time permission dialog, all subsequent screenshots are silent. Token-aware cascade: if restore token exists, portal goes first (fast, silent); if not, `gnome-screenshot` is tried first (no dialog on older GNOME), with portal as fallback after `gdbus`. Fixes repeated permission dialogs on GNOME 46+ where `gnome-screenshot` and `gdbus ScreenshotArea` are both broken.
- **PKGBUILD.template**: New optdepends `python-gobject` and `gst-plugin-pipewire` for portal screenshots.

### Technical details
- Python script embedded inline (spawned via `python3 -` stdin pipe), no extra files needed
- GStreamer pipeline: single frame capture (`num-buffers=1`) — ~300ms per screenshot with restore token
- Restore token persisted at `~/.config/Claude/pipewire-restore-token`
- Graceful degradation: missing `python3-gi` returns exit code 2, cascade falls through to next method

## 2026-04-07 (v1.1062.0) — Upstream update, fix 3 patches for minified name changes

### Fixed
- **enable_local_agent_mode.py**: HTTP header platform spoof pattern — upstream changed separator from `;` to `,` after `getSystemVersion()` (more declarations on same line). Updated regex to accept `[;,]`.
- **fix_asar_folder_drop.py**: File-drop convergence function renamed (`noe` → `Coe`). Replaced hardcoded `noe` with `\w+` wildcard so the pattern survives future renames.
- **fix_quick_entry_ready_wayland.py**: Ready-to-show variable names changed (`NEe` → `YEe`, `nK` → `AK`). Replaced hardcoded literal match with regex-based extraction of variable names.

### Changed
- Upstream version: v1.569.0 → v1.1062.0
- Feature flag function renames: `$w()` → `Ow()`, `tse` → `xse`, `V0e()` → `m0e()`, `Sn()` → `rn()`
- 2 new GrowthBook flags: `2114777685` (cowork session CU gate), `3371831021` (cuOnlyMode)
- 6 dispatch-era GrowthBook flags removed upstream

### Docs
- **CLAUDE_FEATURE_FLAGS.md**: Updated all function names, GrowthBook catalog, version history table for v1.1062.0
- **CLAUDE_BUILT_IN_MCP.md**: Added new `cowork-onboarding` MCP server (#8) with `show_onboarding_role_picker` tool (gated by GrowthBook `2114777685`); renumbered servers 9→16; version header updated

## 2026-04-06 (v1.569.0) — Linux-aware CU tool descriptions, gnome-screenshot priority

### Added
- **fix_computer_use_linux.py** sub-patch 13 (13a–13g): Fix computer-use tool descriptions for Linux. The upstream `V7r()` builder produces descriptions that tell the model "This computer is running macOS", reference Finder/bundle identifiers, and warn about allowlist gates that are bypassed on Linux. Seven sub-patches wrap key description strings in `process.platform` checks: (a) `Lf` allowlist gate suffix → empty on Linux, (b) `request_access` says "Linux" with correct file-manager info, (c–d) app identifiers use WM_CLASS not macOS bundle IDs, (e) `open_application` drops allowlist requirement, (f–g) `screenshot` removes allowlist references. Non-fatal — descriptions don't affect tool functionality.

### Changed
- **fix_computer_use_linux.py**: Reordered GNOME Wayland screenshot cascade — `gnome-screenshot` now takes priority over `gdbus` (GNOME Shell D-Bus). `gnome-screenshot` is more widely available (works on Ubuntu GNOME where the D-Bus interface may be absent), so it should be tried first with `gdbus` as fallback.

### Docs
- **CLAUDE_BUILT_IN_MCP.md**: Rewrote Computer Use tools table with verbatim upstream descriptions (v1.569.0) and platform-dependent notes showing what Linux patches change.
- **CLAUDE.md**: Updated Wayland GNOME screenshot tool order, sub-patch count (12→13), added sub-patch 13 row.

## 2026-04-06 (v1.569.0) — Add gnome-screenshot fallback for Wayland GNOME, Ubuntu build script

### Fixed
- **fix_computer_use_linux.py**: `gnome-screenshot` was never tried on Wayland GNOME sessions — it was only in the X11 code path. If `gdbus` (GNOME Shell D-Bus) failed, screenshots fell through directly to the Electron `desktopCapturer` fallback. Added `gnome-screenshot` as a Wayland GNOME fallback (full capture + ImageMagick crop, with uncropped fallback). Updated diagnostics to include it in relevant-tools and cascade-order output.

### Added
- **scripts/build-ubuntu-local.sh**: Local build script for Ubuntu/Debian — downloads the latest exe, applies patches, and builds an installable `.deb`.

### Changed
- **scripts/build-patched-tarball.sh**: Added `SKIP_SMOKE_TEST=1` env var to allow skipping the Electron smoke test on systems without `electron`/`xvfb-run`.

## 2026-04-06 (v1.569.0) — Add runtime diagnostics logging for all patches

### Added
- **fix_computer_use_linux.py**: Startup diagnostics IIFE logs session type, DE, available/missing tools, input backend, and screenshot cascade order to stdout/stderr (visible when running `claude-desktop` from a terminal). First-use logging for each input operation (mouse, click, key, type, scroll, drag) shows which backend handled it.
- **fix_browser_tools_linux.py**: Logs native host presence and detected browser profiles at startup.
- **fix_claude_code.py**: Logs which path the CLI binary was found at, or warns with install instructions if missing.
- **fix_quick_entry_position.py**: One-time log for cursor positioning method (xdotool, hyprctl, or Electron fallback).
- **CLAUDE.md**: Added supported distros and session managers reference table.

### Notes
- All diagnostics use structured `[tag] category: detail` format. Visible when running `claude-desktop` from a terminal. Not written to `main.log` (that file uses Electron's structured logger).

## 2026-04-05 (v1.569.0) — Fix Quick Entry focus on X11/XWayland

### Fixed
- **fix_quick_entry_position.py**: Quick Entry window opened but didn't receive keyboard focus on X11 — typing, Escape, and click-outside-to-dismiss all failed until manually clicking inside. Root cause: X11 WMs ignore Electron's `_NET_ACTIVE_WINDOW` focus request due to focus-stealing prevention. Fix uses `xdotool windowactivate` on X11/XWayland (detected via `XDG_SESSION_TYPE` and `--ozone-platform=x11` argv) with graceful fallback to Electron APIs. Wayland path uses pure Electron `focus()` + `focusOnWebView()` via `xdg_activation_v1`. Retries at 50/150/300ms for async WM processing.

## 2026-04-05 (v1.569.0) — Fix Quick Entry global shortcut on Wayland

### Fixed
- **fix_quick_entry_ready_wayland.py** (new): Quick Entry overlay never appeared on native Wayland even though the global shortcut fired correctly. Root cause: Electron's `ready-to-show` event never fires for transparent frameless BrowserWindows on Wayland, and Claude's code awaits it indefinitely. Fix adds a 200ms `Promise.race` timeout so the window proceeds to show.

### Added
- **scripts/build-fedora-local.sh**: Local build script for Fedora — downloads the latest exe, applies patches, and builds an installable RPM.
- **wayland.md**: Troubleshooting guide for stale kglobalaccel entries that can block global shortcut registration on KDE Wayland.

### Notes
- Electron's native `GlobalShortcutsPortal` (`--enable-features=GlobalShortcutsPortal`) works correctly on KDE Wayland — no external D-Bus helper needed. On first launch KDE shows an approval dialog; the permission persists in `kglobalshortcutsrc` across restarts.

## 2026-04-04 (v1.569.0) — Fix app.asar Cowork file-drop on every launch (#24)

### Fixed
- **fix_asar_folder_drop.py**: Rewrote patch to filter `.asar` paths at the `noe()` function — the single convergence point for all file-drop dispatches to Cowork. The previous patch only guarded the `isDirectory` helper, but app.asar fell through to the `existsSync` check and got dispatched as a file instead of a folder. Also guards the second-instance argv parser (`KXn`) as defense-in-depth. Credit: @dvolonnino for identifying the fix.

## 2026-04-03 (v1.569.0) — Fix app menu launch, upstream version bump

### Fixed
- **Desktop files**: Remove `Path=%h` from all .desktop files (#26). `%h` is a field code only valid in the `Exec` key — in `Path` it's treated as a literal string, causing desktop environments (Cinnamon, others) to fail silently when launching from the app menu. The `fix_asar_workspace_cwd.py` patch already handles cwd sanitization in JS, so the .desktop `Path` was unnecessary.

## 2026-04-03 (v1.569.0) — Upstream version bump, patch regex fix

### Fixed
- **enable_local_agent_mode.py**: Async feature merger regex failed because the static registry function was renamed to `$w()` — the `$` character isn't matched by `\w`. Changed regex from `\w+` to `[\w$]+` to handle `$`-prefixed minified names.

### Added
- **fix_dispatch_linux.py**: Force-enable GrowthBook flag `3558849738` (dispatch agent name) on Linux. ~~Also forced `1143815894` (hostLoopMode) — later reverted in 2026-04-11 as it bypassed the cowork service spawn, breaking all skills/plugins.~~

### Changed
- **Version bump to v1.569.0** — upstream switched from 4-part versioning (v1.2.234) to 3-part (v1.569.0). All 31 patches apply cleanly. Same 18 feature flags, no structural changes.
- Function renames: `Uw()`→`$w()` (static registry), `Lse`→`tse` (async merger), `I_e()`→`V0e()` (production gate), `fn()`→`Sn()` (flag reader).
- 3 new GrowthBook flags: `286376943`, `1434290056`, `2392971184`. Flag `1143815894` re-added.

### Docs
- **CLAUDE_FEATURE_FLAGS.md**: Updated all function names, version history table, GrowthBook catalog for v1.569.0.
- **CLAUDE_BUILT_IN_MCP.md**: Updated version header.

## 2026-04-03 (v1.2.234) — Fix workspace trust dialog showing "app.asar" (#24)

### Fixed
- **fix_asar_workspace_cwd.py** (new): On first launch, the workspace trust dialog could show "Allow Claude to change files in 'app.asar'?" because the web app resolved `app.getAppPath()` as the default workspace. The new patch injects a `__cdb_sanitizeCwd()` helper that redirects any workspace path containing `app.asar` to `os.homedir()` on Linux. Patches 5 IPC bridge functions: `checkTrust`, `saveTrust`, `start`, and both `startCodeSession` handlers.
- **.desktop files**: Added `Path=%h` across all packaging formats (Arch, RPM, DEB, AppImage) so the working directory defaults to `$HOME` when launching from the app menu, preventing the desktop environment from inheriting an arbitrary cwd.

## 2026-04-02 (v1.2.234) — Session-aware Computer Use tool selection

### Fixed
- **fix_computer_use_linux.py**: Tool selection now uses session type and compositor detection instead of binary existence. Prevents wrong tools on wrong sessions (e.g., grim on KDE Wayland, scrot on Wayland, gnome-screenshot on Wayland GNOME 42+).
- **fix_computer_use_linux.py**: `_isWayland()` now trusts `XDG_SESSION_TYPE` over `WAYLAND_DISPLAY` — fixes false positive when XWayland sets `WAYLAND_DISPLAY` on X11 sessions.
- **fix_computer_use_linux.py**: grim restricted to wlroots compositors (`SWAYSOCK`/`HYPRLAND_INSTANCE_SIGNATURE`), scrot/import/gnome-screenshot restricted to X11.
- **fix_computer_use_linux.py**: Fixed `type()` redundant `_checkYdotool()` that could fall back to xdotool on Wayland if daemon crashed mid-operation.

## 2026-04-02 (v1.2.234) — Nix build fix, docs & packaging improvements

### Fixed
- **flake.nix**: Pass `claude-code = null` to avoid pulling yanked npm tarballs from nixpkgs (e.g. `@anthropic-ai/claude-code@2.1.88` → 404). Users can still override.

### Changed
- **README.md**: Split KDE Plasma / GNOME install commands into separate lines, added socat as optional dependency, improved session-type guidance.
- **packaging/nix/package.nix**: Added `glib` optional dependency for GNOME `gsettings` (flat mouse acceleration).
- **patches/fix_computer_use_linux.py**: Updated doc comment (switch_display uses Electron screen API, not xrandr).

## 2026-04-02 (v1.2.234) — Computer Use multi-monitor & teach overlay fixes

### Fixed
- **fix_computer_use_linux.py**: Multi-monitor coordinate translation — clicks used display-relative coordinates directly with xdotool (absolute). Added `__txC()`/`__untxC()` to translate using the active display's origin offset.
- **fix_computer_use_linux.py**: Teach overlay spawned on wrong monitor — patched `xlr()` to always resolve to primary display on Linux.
- **fix_computer_use_linux.py**: Teach overlay buttons (Next/Exit) unclickable (Electron bug #16777) — override `setIgnoreMouseEvents` to no-op so overlay stays interactive.
- **fix_computer_use_linux.py**: Teach tooltip stuck in upper-left — `getDisplaySize()` missing `originX`/`originY`, `_findMon()` didn't match Electron native display IDs.

### Changed
- **fix_computer_use_linux.py**: Default screenshot display → primary (was displayId=0). Now 12 sub-patches (was 8).

### Docs
- **README.md**: Documented multi-monitor limitation (primary monitor only) and teach overlay behavior.
- **CLAUDE_BUILT_IN_MCP.md**: Updated sub-patch table (8→12), expanded feature flag docs.

## 2026-04-01 (v1.2.234) — Computer Use Wayland fix

### Fixed
- **fix_computer_use_linux.py**: Computer Use now works on all Wayland compositors (tested KDE Plasma + GNOME on Ubuntu). Three bugs fixed:
  1. **Window click-through** — Added `setIgnoreMouseEvents` wrapper so clicks pass through Claude's window to the target app.
  2. **Cursor positioning** — Split ydotool `--absolute` into origin-reset + delay + relative move (single-command was too fast for libinput).
  3. **Keyboard input** — `_mapKeyWayland()` returns raw Linux numeric keycodes. ydotool v1.0.4 `key` only accepts numeric codes, not names.

### Added
- **scripts/setup-ydotool.sh**: One-command setup for Ubuntu/Debian Wayland users. Builds ydotool v1.0.4 from source, configures uinput permissions, starts daemon. Also sets flat mouse acceleration on GNOME.
  Usage: `curl -fsSL https://raw.githubusercontent.com/patrickjaja/claude-desktop-bin/master/scripts/setup-ydotool.sh | sudo bash`

### Docs
- **README.md**: All Wayland compositors need ydotool for input (not just wlroots). Added ydotool setup section with `curl | sudo bash` for Ubuntu/Debian, one-liners for Arch/Fedora, and GNOME flat acceleration note.

### Changed
- **Version bump to v1.2.234** — Major upstream release. Feature flag registry unchanged (same 18 features), but internal function names renamed across the board.
- **fix_computer_use_linux.py**: Platform gate changed from inline `process.platform==="darwin"` to Set-based `ese = new Set(["darwin","win32"])` with `vee()` checker. Updated patch to add `"linux"` to the Set instead of removing individual gates. This single change fixes all computer-use platform checks (server push, chicagoEnabled, overlay init). handleToolCall regex updated for new code structure (Y5e opted-out block before dispatcher).
- **read_terminal MCP server**: Upstream now natively supports Linux (`LRe = isDarwin || isWin32 || isLinux`). **Removed `fix_read_terminal_linux.py`** — patch no longer needed.

### Upstream Changes
- **Computer use**: Platform gate now uses a Set (`ese`) gating `vee()` function, adding Windows support alongside macOS. Linux still requires our patch to add to the Set.
- **Terminal server**: Now natively supports Linux (variable `LRe` includes all three platforms).
- **Registration function renamed**: `Are()` → `One()` for internal MCP server registration.
- **Feature flag function renames**: Static registry `_b()` → `Uw()`, async merger `Cie` → `Lse`, production gate `fve()` → `I_e()`.
- **GrowthBook expansion**: 38+ flag IDs now in use (was ~33 in v1.1.9669). New flags for floatingAtoll state sync (`1985802636`).
- **Operon**: Static entry now unconditionally returns `{status:"unavailable"}` (`$gn()`). Async override introduces 5-second delay before GrowthBook check.

### Docs
- **CLAUDE_FEATURE_FLAGS.md**: Updated for v1.2.234 — new function names (`Uw`, `Lse`, `I_e`), same 18 features.
- **CLAUDE_BUILT_IN_MCP.md**: Updated for v1.2.234 — registration function `Are()` → `One()`, terminal server now natively supports Linux.

## 2026-04-01 (v1.1.9669)

### Changed
- **fix_computer_use_linux.py**: Replaced external clipboard tools (`xclip`, `xsel`, `wl-clipboard`) with Electron's built-in `clipboard` API. Clipboard read/write and type-via-clipboard now use `electron.clipboard.readText()`/`writeText()` directly — no external packages needed.
- **fix_computer_use_linux.py**: Replaced external display enumeration tools (`xrandr`, `wlr-randr`) with Electron's built-in `screen.getAllDisplays()` API for both X11 and Wayland. Eliminates 2 optional dependencies.
- **fix_computer_use_linux.py**: Added `desktopCapturer` + `nativeImage.crop()` as last-resort screenshot fallback before the error throw. Helps on exotic Wayland compositors where no CLI screenshot tool is available.
- **Packaging**: Removed `xclip`, `xsel`, `wl-clipboard`, `wlr-randr`, `xorg-xrandr` from optional dependencies across all formats (PKGBUILD, deb, rpm). 5 fewer packages to install.

### Fixed
- **fix_computer_use_linux.py**: Computer Use clicks now work on all Wayland compositors (KDE, GNOME, wlroots). Three bugs fixed:
  1. **Window hiding before actions** — Added `setIgnoreMouseEvents` wrapper (matching upstream macOS `lB()` behavior) so clicks pass through Claude Desktop's window to the target app behind it.
  2. **ydotool absolute positioning** — Split `mousemove --absolute X Y` into two commands with 50ms delay (origin reset + relative move). The single-command approach sent both events too fast for libinput to process correctly, causing the cursor to land at (0,0).
  3. **ydotool keyboard input** — `_mapKeyWayland()` now returns raw Linux numeric keycodes (e.g. 29 for Ctrl, 56 for Alt) instead of symbolic names. ydotool v1.0.4 `key` command parses names as `strtol()` = 0, silently dropping all key events.
- **fix_computer_use_linux.py**: Screenshot support on non-wlroots Wayland compositors (GNOME, KDE). New fallback chain: `COWORK_SCREENSHOT_CMD` env override → grim (wlroots) → GNOME Shell D-Bus `ScreenshotArea` → spectacle + crop (KDE) → gnome-screenshot → scrot → import. Fixes [claude-cowork-service#13](https://github.com/patrickjaja/claude-cowork-service/issues/13).
- **fix_computer_use_linux.py**: ydotool robustness — `_checkYdotool()` verifies ydotoold daemon is running before attempting ydotool commands. Falls back to xdotool via XWayland if daemon not found.

### Added
- **scripts/setup-ydotool.sh**: One-command ydotool v1.0.4 setup for Ubuntu/Debian Wayland users. Builds from source, configures uinput permissions, and creates a systemd service. Ubuntu/Debian ship ydotool 0.1.8 which has incompatible command syntax. Usage: `curl -fsSL https://raw.githubusercontent.com/patrickjaja/claude-desktop-bin/master/scripts/setup-ydotool.sh | sudo bash`

### Docs
- **README.md**: Fixed Computer Use dependencies — all Wayland compositors (KDE, GNOME, wlroots) require `ydotool` for input automation, not just wlroots. The `xdotool (XWayland)` fallback cannot click native Wayland windows.
- **README.md**: Added `ydotool setup` section with one-liner for Arch/Fedora and `curl | sudo bash` setup script for Ubuntu/Debian.
- **Packaging**: Updated optional dependency descriptions across all formats (PKGBUILD, deb control, rpm spec, nix) to reflect ydotool requirement for all Wayland compositors.

## 2026-03-31 (v1.1.9669)

### Changed
- **Version bump to v1.1.9669** — New upstream release with structural changes to feature flag system.
- **New `computerUse` feature flag** added to static registry (`jun()`, darwin-only). Added override to `enable_local_agent_mode.py` merger patch (8 features now overridden, up from 7).
- **`chillingSlothFeat` darwin gate re-introduced** — Was removed upstream in v1.1.9134, now back. Our Patch 1 regex already handles it.

### Fixed
- **enable_local_agent_mode.py**: Fixed `yukonSilver` regex — function name `$un()` contains `$` which `\w+` doesn't match. Updated pattern to use `[\w$]+` for function names.

### Docs
- **CLAUDE_FEATURE_FLAGS.md**: Updated for v1.1.9669 — 18 features (was 17), new function names, new GrowthBook flags (`3691521536` stealth updater, `3190506572` Chrome perms), remote orchestrator flag `4201169164` removed.
- **CLAUDE_BUILT_IN_MCP.md**: Updated for v1.1.9669 — registration function renamed `Pee()`→`Are()`.

### New Upstream (not patched — not needed)
- **Stealth updater** (flag `3691521536`) — nudges updates when no sessions active. Works on Linux as-is.
- **Epitaxy route** (flag `1585356617`) — new CCD session URL routing with `spawn_task` tool. Not platform-gated.
- **Org plugins path** — returns `null` on Linux (graceful no-op). Only needed for enterprise deployments.
- **Remote orchestrator (manta)** — hardcoded off (`Qhn=!1`). Flag `4201169164` removed from GrowthBook.

## 2026-03-29 (v1.1.9493)

### Changed
- **Version bump to v1.1.9493** — Upstream metadata-only re-release; JS bundles are byte-for-byte identical to v1.1.9310. No new features, MCP servers, or platform checks.
- **Custom themes: visual polish** — Borders now use accent color with subtle alpha (e.g. `#cba6f718`) instead of neutral gray, matching each theme's palette. Added accent-colored scrollbars, dialog/menu/tooltip glow shadows, button hover glow, smooth transitions on interactive elements, and transparent input borders/focus rings for a cleaner look. All 6 theme JSON files updated.

### Fixed
- **fix_process_argv_renderer.py**: Platform spoof pattern (`platform="win32"`) no longer exists in mainView.js. Added primary pattern matching `exposeInMainWorld("process",<var>)` to insert `argv=[]` before the expose call. Old spoof-based and appVersion-based patterns retained as fallbacks.
- **enable_local_agent_mode.py**: Async feature merger restructured from arrow function `async()=>({...Oh(),...})` to block body with `Promise.all` and explicit `return{...vw(),...}`. Added new regex for the block-body format; old arrow-function pattern retained as fallback.

### Docs
- **CLAUDE_BUILT_IN_MCP.md**: Expanded Claude Preview section with full tool catalog (13 tools), `.claude/launch.json` configuration, and architecture description. Updated to v1.1.9493.
- **CLAUDE.md**: Added CI-managed files section documenting that README install command versions are updated automatically by CI.

## 2026-03-29 (v1.1.9310-5)

### Fixed
- **Nix hash mismatch** (#19) — CI computed the Nix SRI hash from the locally-built tarball artifact, but users download from GitHub Releases. Non-deterministic tar builds across CI re-runs caused the hash to drift from the actual release asset. Fixed by computing the hash from the downloaded release tarball instead of the build artifact. Reverted `package.nix` hash to match the actual released tarball.

## 2026-03-28 (v1.1.9310-4)

### Fixed
- **Dispatch: SendUserMessage now works natively** — CLI v2.1.86 fixed the `CLAUDE_CODE_BRIEF=1` env var parser. The Ditto dispatch orchestrator agent now calls `SendUserMessage` directly — no synthetic transform needed. Removed Patch I (bridge-level text→SendUserMessage workaround)

### Changed
- **Dispatch: removed Patch I** — The synthetic `SendUserMessage` transform in `fix_dispatch_linux.py` is no longer needed. Patch F (rjt bridge filter widening) retained as defense-in-depth for edge cases
- **Dispatch: documented Ditto architecture** — Added [Dispatch Architecture](#dispatch-architecture) section to README documenting the orchestrator agent, session types (`chat`/`agent`/`dispatch_child`), and Linux adaptations
- **SEND_USER_MESSAGE_STATUS.md** — Complete rewrite reflecting fixed state: Ditto architecture, `--disallowedTools` discovery, `present_files` interception, `SendUserMessage` full signature, version bisect updated through v2.1.86

## 2026-03-28 (v1.1.9310-3)

### Fixed
- **Launcher shebang**: Removed two leading spaces before `#!/usr/bin/env bash` that caused `Exec format error` when launched from desktop entries or protocol handlers (kernel requires `#!` at byte 0). Terminal launches were unaffected. (#17)

### Changed
- **Build: shebang validation**: `build-patched-tarball.sh` now validates that the launcher script has `#!` at byte 0 before creating the tarball, preventing this class of bug from reaching users

## 2026-03-27 (v1.1.9310)

### Changed
- **Launcher: native Wayland by default** — Wayland sessions now use native Wayland instead of XWayland. Global hotkeys (Ctrl+Alt+Space) work via `xdg-desktop-portal` GlobalShortcuts API (KDE, Hyprland; Sway/GNOME pending upstream portal support). Set `CLAUDE_USE_XWAYLAND=1` to force XWayland if needed. Niri sessions still auto-forced to native Wayland. The old `CLAUDE_USE_WAYLAND=1` env var is now a no-op (native is the default).
- **CI**: Remove push trigger from release workflow — now runs only on nightly schedule (2 AM UTC) or manual dispatch

### Fixed
- **fix_utility_process_kill.py**: Logger variable changed from `\w+` name to `$` — updated pattern to `[\w$]+` for the `.info()` call
- **fix_detected_projects_linux.py**: Same `$` logger issue — updated pattern to `[\w$]+` for the `.debug()` call
- **fix_dispatch_linux.py**: Same `$` logger issue in sessions-bridge gate pattern and auto-wake parent pattern — updated all logger references to `[\w$]+`. Dispatch now applies 8/8 sub-patches (was 6/8)

### New Upstream
- **Operon (full-stack web agent)**: Still gated behind flag `1306813456`, returns `{status:"unavailable"}` unconditionally. Will need Cowork-style patch when activated
- **Epitaxy (new sidebar mode)**: No platform gate — works on Linux as-is
- **Imagine (visual creation MCP server)**: No platform gate — works on Linux as-is

## 2026-03-27 (v1.1.9134)

### Fixed
- **enable_local_agent_mode.py — Patch 7 (mainView.js platform spoof)**: Variable `$s` contains `$` which isn't matched by `\w+`. Changed regex to use `[\w$]+` for filter variable names in `Object.fromEntries(Object.entries(process).filter(([e])=>$s[e]))`.
- **fix_computer_use_linux.py — Sub-patch 6 rewrite (hybrid handler)**: Replaced full `handleToolCall` replacement with a hybrid early-return injection. Teach tools (`request_teach_access`, `teach_step`, `teach_batch`) now fall through to the upstream chain (which uses `__linuxExecutor` via sub-patches 3-5), enabling the teach overlay on Linux. Normal CU tools keep the fast direct handler. Also fixed: variable name collisions (`var c` hoisting vs upstream `const c`).
- **fix_computer_use_linux.py — Sub-patch 8 rewrite (tooltip-bounds polling)**: Previous fix polled cursor against `getContentBounds()` (= full screen) so `setIgnoreMouseEvents(false)` was permanently set, blocking the entire desktop. Now queries the `.tooltip` card's actual `getBoundingClientRect()` from the renderer via `executeJavaScript`, checks cursor against card bounds with 15px padding. Also fixed stale cursor: Electron's `getCursorScreenPoint()` returns frozen coordinates on X11 when cursor isn't over an Electron window — now uses `xdotool getmouselocation` → `hyprctl cursorpos` → Electron API fallback chain (cached 100ms).
- **fix_computer_use_linux.py — Sub-patches 9a/9b (step transition)**: Neutralized `setIgnoreMouseEvents(true,{forward:true})` calls in `yJt()` (show step) and `SUn()` (working state) on Linux. These fought with the polling loop during step transitions. Polling now has sole control of mouse event state on Linux, with 400ms grace period.
- **fix_computer_use_linux.py — `listInstalledApps()` app resolution**: Teach mode failed with `"reason":"not_installed"` because `.desktop` display names (e.g., "Thunar File Manager") didn't match model requests (e.g., "Thunar"). Now emits multiple name variants per app: full name, short name (first word), exec name, Icon= bundleId (reverse-domain), .desktop filename. Also scans Flatpak app directories.
- **fix_computer_use_linux.py — `switch_display`**: Real implementation using `xrandr` display enumeration and `globalThis.__cuPinnedDisplay` state tracking. Screenshots respect pinned display. Replaces the previous "not available" stub.
- **fix_computer_use_linux.py — `computer_batch`**: Fixed return format to match upstream's `{completed:[...], failed:{index,action,error}, remaining:[...]}` structure instead of only returning the last result.

### Removed
- **fix_tray_path.py** — Deleted: redundant since `fix_locale_paths.py` already replaces ALL `process.resourcesPath` references globally (including the tray path function). Patch count: 33→32.

### New Upstream
- **New MCP server: `ccd_session`** — Provides `spawn_task` tool to spin off parallel tasks into separate Claude Code Desktop sessions. Gated by CCD session + server flag `1585356617`. Already Linux compatible (no platform gates).
- **5 new Computer Use tools** — `switch_display` (multi-monitor), `computer_batch` (batch actions), `request_teach_access`, `teach_step`, `teach_batch` (guided teach mode). Total tools: 22→27. All 5 now Linux compatible.
- **New feature flag: `wakeScheduler`** — macOS-only Login Items scheduling (gated by `Kge()` + darwin). Not needed on Linux — the scheduled tasks engine is platform-independent (`setInterval` + cron evaluation). Tasks fire on wake-up if missed during sleep.
- **Operon expanded**: 18→28 sub-interfaces (9 new: `OperonAgentConfig`, `OperonAnalytics`, `OperonAssembly`, `OperonHostAccessProvider`, `OperonImageProvider`, `OperonQuitHandler`, `OperonServices`, `OperonSessionManager`, `OperonSkillsSync`). Still gated behind flag `1306813456`.
- **New GrowthBook flags**: `66187241` + `3792010343` (tool use summaries), `1585356617` (epitaxy/session routing), `2199295617` (auto-archive PRs), `927037640` (subagent model config), `2893011886` (wake scheduler timing). All cross-platform, no patching needed. Removed: `3196624152` (Phoenix Rising updater).

### Added
- **Unified launcher across all packaging formats** — RPM, DEB, and AppImage now use the full launcher script (Wayland/X11 detection, SingletonLock cleanup, cowork socket cleanup, logging) instead of minimal 2-3 line stubs. Launcher auto-discovers Electron binary and app.asar paths at runtime. Fixes [#13](https://github.com/patrickjaja/claude-desktop-bin/issues/13).
- **GPU compositing fallback (`CLAUDE_DISABLE_GPU`)** — New env var to fix white screen on systems with GBM buffer creation failures (common on Fedora KDE / Wayland). `CLAUDE_DISABLE_GPU=1` disables GPU compositing; `CLAUDE_DISABLE_GPU=full` disables GPU entirely.
- **AppImage auto-update support** — AppImages now embed `gh-releases-zsync` update information and ship with `.zsync` delta files. Users can update via `appimageupdatetool`, `--appimage-update` CLI flag, or compatible tools (AppImageLauncher, Gear Lever). Only changed blocks are downloaded.
- **Wayland support in Computer Use executor** — Full auto-detection via `$XDG_SESSION_TYPE`. On Wayland: `ydotool` for input, `grim` for screenshots (wlroots), `wl-clipboard` for clipboard, Electron APIs for display enumeration and cursor position. On X11: existing tools (`xdotool`, `scrot`, `xclip`, `xrandr`). Falls back to X11/XWayland if Wayland tools are not installed. Compositor-specific window info via `hyprctl` (Hyprland) and `swaymsg` (Sway).
- **Fedora/RHEL DNF repository** — RPM packages now published to GitHub Pages alongside APT. One-line setup: `curl -fsSL .../install-rpm.sh | sudo bash`. Auto-updates via `dnf upgrade`. Scripts: `packaging/rpm/update-rpm-repo.sh`, `packaging/rpm/install-rpm.sh`.

### Changed
- **Dependencies** — Moved `nodejs` from `depends` to optional across all formats (Electron bundles Node.js; system node only needed for MCP extensions requiring specific versions). Added Wayland optdeps (`ydotool`, `grim`, `slurp`, `wl-clipboard`, `wlr-randr`) and `xorg-xrandr` with (X11)/(Wayland) annotations. Updated: PKGBUILD.template, debian/control, rpm/spec, nix/package.nix.
- **CLAUDE_BUILT_IN_MCP.md** — Updated for v1.1.9134: new `ccd_session` server, 5 new computer-use tools, registration function rename `IM()`→`Pee()`, expanded Operon sub-interfaces.
- **CLAUDE_FEATURE_FLAGS.md** — Updated for v1.1.9134: new `wakeScheduler` (17 features total), function renames (`dA`→`rw`, `JX`→`yre`, `Oet`→`Kge`, `Hn`→`kn`, `Hk`→`bC`), 4 new GrowthBook flags, 1 removed flag.
- **README.md** — Fedora section updated from manual download to DNF repo with auto-updates. Computer Use feature description updated with Wayland/X11 tool split.

### CI
- **Parallelized GitHub Actions workflow** — Refactored monolithic single-job pipeline into fan-out/fan-in pattern with 8 jobs. Package builds (AppImage, DEB, RPM × 2 architectures), Nix test, and PKGBUILD generation now run in parallel on separate runners after the tarball build. Estimated ~6 min savings per run.

### Notes
- **All 32 patches pass** with zero failures on v1.1.9134.
- **Computer Use teach mode** now works on Linux — the teach overlay is pure Electron `BrowserWindow` + IPC, not macOS-specific. The hybrid handler routes teach tools through the upstream chain while keeping the fast direct handler for normal tools.
- **No new platform gates** blocking core Linux functionality. The 4 new GrowthBook flags and `ccd_session` MCP server are all platform-independent.
- **Verified all existing patches still needed** — upstream has NOT removed darwin gates for chillingSlothFeat, yukonSilver, or navigator spoofs despite initial false positive (caused by inspecting already-patched files).

## 2026-03-25 (v1.1.8629)

### Fixed
- **fix_dispatch_linux.py — Patch A (Sessions-bridge gate)**: Variable declaration changed from single (`let f=!1;const`) to triple (`let f=!1,p=!1,h=!1;const`). Updated regex to handle comma-separated declarations with `(?:\w+=!1,)*` prefix. The gate variable `h` is now `h = f || p` where `p` is the new remote orchestrator flag.
- **fix_dispatch_linux.py — Patch J (Auto-wake parent)**: Logger variable renamed `B` → `P`. Converted from hardcoded byte string to regex with dynamic capture group for the logger variable.
- **fix_dispatch_linux.py — Patch K (present_files unblock)**: Removed `mcp__cowork__present_files` from `RIt` renderer-dependent disallowed tools list. This tool works through the MCP proxy and doesn't need the local renderer. Without this, dispatch file sharing (e.g. PDF generation from phone) gets "Permission denied".

### New Upstream
- **Feature flag `4201169164`** — Remote Orchestrator (codename "manta" / `yukon_silver_manta_desktop`). Alternative to local Cowork: connects to Anthropic's cloud via WebSocket (`wss://bridge.claudeusercontent.com`) instead of local `cowork-svc`. Enabled via env var `CLAUDE_COWORK_FORCE_REMOTE_ORCHESTRATOR=1` or developer setting `isMantaDesktopEnabled`. Not tested on Linux — likely requires Pro account or server-side enablement.
- **16 i18n locale files** — de-DE, en-US, en-XA, en-XB, es-419, es-ES, fr-FR, hi-IN, id-ID, it-IT, ja-JP, ko-KR, pt-BR, xx-AC, xx-HA, xx-LS. Already handled by build script's i18n copy step.
- **Developer setting `isMantaDesktopEnabled`** — New toggle in developer settings: "Forces yukon_silver_manta_desktop (remote orchestrator mode) regardless of GrowthBook".

### Changed
- **CLAUDE_FEATURE_FLAGS.md** — Updated for v1.1.8629: new flag `4201169164` (remote orchestrator), function renames (`Qn`→`Hn`, `Bx`→`Hk`, `lA`→`dA`, `jY`→`JX`, `VKe`→`Oet`), documented remote orchestrator architecture and env vars.

### Notes
- **No new platform gates** — No new `darwin`/`win32`-only patterns found. All 32 existing patches still required.
- **All 32 patches pass** with zero failures on v1.1.8629. Only variable name renames (handled by `\w+` wildcards).

## 2026-03-24 (v1.1.8359)

### Added
- **fix_computer_use_linux.py** — New patch: enables Computer Use on Linux with 6 sub-patches. Removes 3 upstream platform gates (`b7r()`, `ZM()`, `createDarwinExecutor`), provides a Linux executor using xdotool/scrot/xclip/wmctrl, bypasses macOS TCC permissions (`ensureOsPermissions` returns granted), and replaces the macOS permission model (`rvr()` allowlist/tier system) with direct tool dispatch. 22 tools work immediately without `request_access` — no app tier restrictions, no bundle ID matching, no permission dialogs.
- **fix_detected_projects_linux.py** — New patch: enables Recent Projects on Linux. Maps VSCode (`~/.config/Code/`), Cursor (`~/.config/Cursor/`), and Zed (`~/.local/share/zed/`) workspace detection paths. Home directory scanner already works cross-platform.
- **fix_enterprise_config_linux.py** — New patch: reads enterprise config from `/etc/claude-desktop/enterprise.json` on Linux. Returns `{}` if file doesn't exist (preserving current behavior).

### Changed
- **fix_marketplace_linux.py** — Simplified: removed dead Pattern A (runner selector, refactored upstream) and Pattern B (search_plugins, removed upstream). Only Pattern C (CCD gate) remains.
- **CLAUDE_FEATURE_FLAGS.md** — Updated for v1.1.8359: new `operon` feature (#16), function renames, 4 new GrowthBook flags, 2 removed flags.
- **CLAUDE_BUILT_IN_MCP.md** — Updated for v1.1.8359: Operon IPC system (120+ endpoints), visualize factory rename, all 14 MCP servers unchanged.
- **README.md** — Added new patches to table, removed `fix_mcp_reconnect.py`, added Known Limitations section (Browser Tools).

### Removed
- **fix_mcp_reconnect.py** — Deleted: close-before-connect fix is now upstream (since v1.1.4088+). Patch was a no-op.

### Notes
- **Computer Use MCP is back** — Removed in v1.1.7714 (commit 2c69b13) when upstream dropped the standalone `computer-use-server.js`. Now reintroduced as a built-in internal MCP server integrated into `index.js`. Upstream gates it to macOS-only (`@ant/claude-swift`); our patch provides a Linux-native implementation.
- **Operon (Nest)** — Major new upstream feature (120+ IPC endpoints). Currently server-gated (flag `1306813456`), requires VM infrastructure. Not patched — waiting for Anthropic to enable.
- **Browser Tools** — Documented as known limitation. Server registration requires `chrome-native-host` binary (Rust, proprietary, Windows/macOS only).

## 2026-03-23 (v1.1.8308)

### Added
- **fix_office_addin_linux.py** — New patch: enable Office Addin MCP server on Linux by extending the `(ui||as)` platform gate in 3 locations (MCP isEnabled, init block, connected file detection). The underlying WebSocket bridge is platform-agnostic; this enables future compatibility with web Office or LibreOffice add-ins.
- **fix_read_terminal_linux.py** — New patch: enable `read_terminal` built-in MCP server on Linux (was hardcoded to `darwin` only). Reads integrated terminal panel content in CCD sessions.
- **fix_browse_files_linux.py** — New patch: add `openDirectory` to the browseFiles file dialog on Linux. Electron fully supports directory selection on Linux but upstream only enabled it for macOS.

### Fixed
- **fix_process_argv_renderer.py** — Fix for v1.1.8308: hardcoded `Ie` variable name → dynamic `\w+` capture. Upstream renamed the process proxy from `Ie` to `at`.
- **fix_quick_entry_position.py** — Fix for v1.1.8308: hardcoded `ai` window variable → dynamic `[\w$]+` capture group. Upstream renamed Quick Entry window var from `ai` to `Js`.
- **fix_dispatch_linux.py** — Enhanced Patch I: now also transforms `mcp__cowork__present_files` tool_use blocks into SendUserMessage attachments, so file sharing renders on the phone.

### Previous (2026-03-23)

### Fixed
- **fix_dispatch_linux.py — Restore Patch I (text→SendUserMessage transform)** — Claude Code CLI 2.1.x has a bug where `--brief` + `--tools SendUserMessage` does not expose the `SendUserMessage` tool to the model. The model falls back to plain text, which the sessions API silently drops (only `SendUserMessage` tool_use blocks are rendered on the phone). Patch I injects a transform in `forwardEvent()` that wraps plain text assistant messages as synthetic `SendUserMessage` tool_use blocks before writing to the transport.

### Changed
- ~~fix_dispatch_linux.py — Removed Patch I~~ — Reverted: Patch I is needed as a workaround for the CLI `SendUserMessage` bug

### Added
- **CLAUDE_BUILT_IN_MCP.md — Per-session dynamic MCP servers** — Documented 4 SDK-type MCP servers created dynamically per cowork/dispatch session: `dispatch` (6 tools), `cowork` (4 tools), `session_info` (2 tools), `workspace` (2 tools). Includes tool schemas, registration method, allowedTools/disallowedTools logic, and SDK server architecture diagram comparing Mac/Windows VM vs Linux native paths.
- **fix_updater_state_linux.py** — New patch: add `version`/`versionNumber` empty strings to idle updater state so downstream code calling `.includes()` on `version` doesn't crash with `TypeError: Cannot read properties of undefined`
- **fix_process_argv_renderer.py** — New patch: inject `Ie.argv=[]` into preload so SDK web bundle's `process.argv.includes("--debug")` no longer throws TypeError

### Fixed
- **Dispatch text responses now render** — Patched the sessions-bridge `rjt()` filter (Patch F) to forward text content blocks and SDK MCP tool_use responses (`mcp__dispatch__send_message`, `mcp__cowork__present_files`)
- **Navigator platform timing gap** — Changed navigator.platform spoofing from `dom-ready` only to both `did-navigate` + `dom-ready` fallback, closing the window where page scripts see real `navigator.platform` while `process.platform` is already spoofed to `"win32"`
- **Removed diagnostic patches G/H** — forwardEvent and writeEvent logging removed from fix_dispatch_linux.py (no longer needed)

### Documentation
- **CLAUDE.md** — Added "Dispatch Debug Workflow" section with step-by-step debug commands for bridge events, audit analysis, cowork-service args, and session clearing
- **README.md** — Added "Clear Dispatch session" troubleshooting section

## 2026-03-20

### Added
- **Custom Themes (Experimental)** — New `add_feature_custom_themes.py` patch: inject CSS variable overrides into **all windows** (main chat, Quick Entry, Find-in-Page, About) via Electron's `insertCSS()` API. Ships 6 built-in themes (sweet, nord, catppuccin-mocha, catppuccin-frappe, catppuccin-latte, catppuccin-macchiato). Configure via `~/.config/Claude/claude-desktop-bin.json`.
- **themes/** — Community theme directory with ready-to-use JSON configs, screenshots, CSS variable reference (`css-documentation.html`), and `README.md` documenting how to extract app HTML/CSS for theme creation
- **Full-window theming** — Quick Entry gradient, prose/typography (`--tw-prose-*`), `--always-black/white` shadows, checkbox accents, title bar text now all follow the active theme

### Changed
- **CLAUDE_FEATURE_FLAGS.md** — Comprehensive update for v1.1.7714: new `yukonSilverGemsCache` feature (15 total), complete GrowthBook flag catalog (34 boolean + 9 object/value + 3 listener flags), function renames (fp/cN/r1e/xq), version history table updated

### Added
- **fix_quick_entry_position.py** — Two new sub-patches for v1.1.7714:
  - Patch 3: Override position-save/restore (`T7t()`) to always use cursor's display (short-circuits saved position check)
  - Patch 4: Fix show/positioning + focus on Linux — pure Electron APIs, no external dependencies

### Fixed
- **fix_quick_entry_position.py (Patches 1 & 2)** — Fix stale cursor position on Linux: `Electron.screen.getCursorScreenPoint()` only updates when the cursor passes over an Electron-owned window, causing Quick Entry to always open on the app's monitor. Now uses `xdotool getmouselocation` (X11/XWayland) → `hyprctl cursorpos` (Hyprland/Wayland) → Electron API as defensive fallback chain. Both tools are optional — graceful degradation if unavailable.
- **Packaging** — Added `xdotool` as optional dependency across all formats (AUR `optdepends`, Debian `Suggests`, RPM `Suggests`, Nix optional input with PATH wiring)
- **fix_quick_entry_position.py (Patch 4)** — Complete rewrite of Linux Quick Entry positioning and focus:
  - **Positioning**: `setBounds()` before + after `show()` with retries at 50/150ms to counter X11 WM smart-placement. Works on X11, XWayland, and best-effort on native Wayland.
  - **Focus**: Three-layer focus chain — `focus()` (OS window) → `webContents.focus()` (renderer) → `executeJavaScript` to focus `#prompt-input` DOM element (only auto-focuses on initial page load, not on hide/show cycle).
  - Previously the Quick Entry would always open on Claude Desktop's monitor after interacting with the app, making it unusable in multi-monitor setups.
- **CLAUDE_BUILT_IN_MCP.md** — New documentation: built-in MCP server reference
- **docs/** — Screenshots directory

### Fixed
- **fix_dispatch_linux.py** — Fix sessions-bridge logger variable pattern: hardcoded `T` → `\w+` wildcard (logger renamed `T`→`C` in v1.1.7714)
- **fix_cowork_spaces.py** — Fix `createSpaceFolder` API: takes `(parentPath, folderName)` not `(spaceId, folderName)`; adds duplicate folder name dedup with numeric suffix
- **enable_local_agent_mode.py** — Promote platform spoof patches from WARN to FAIL (patches 5, 5b, 6, 7 are now required — if they don't match, the build should fail)
- **fix_utility_process_kill.py** — Promote from WARN/pass to FAIL (exit 1 on 0 matches so CI catches pattern changes)

### Removed
- **computer-use-server.js** — Linux Computer Use MCP server removed (upstream removed `computer-use-server.js` from app root in v1.1.7714; `existsSync` guard fails at runtime, server never registers)
- **fix_computer_use_linux.py** — Computer Use registration patch removed (no server file to register)
- **PKGBUILD** — Removed `scrot` optional dependency (Computer Use removed); added `hyprland` (hyprctl cursor fallback) and `socat` (cowork socket health check)

### Improved
- **scripts/build-local.sh** — Auto-download latest exe with version comparison: queries version API first, skips download if local exe matches latest, saves downloaded exe for future builds

## 2026-03-19

### Changed
- **Update to Claude Desktop v1.1.7464** (from v1.1.7053)

### Added
- **fix_dispatch_linux.py** — New patch: enables Dispatch (remote task orchestration from mobile) on Linux. Four sub-patches:
  - A: Forces sessions-bridge init gate ON (GrowthBook flag `3572572142` — `let f=!1` → `let f=!0`)
  - B: Bypasses remote session control check (GrowthBook flag `2216414644` — `!Jr(...)` → `!1`)
  - C: Adds Linux to `HI()` platform label (`"Unsupported Platform"` → `"Linux"`)
  - D: Includes Linux in `Xqe` telemetry gate so dispatch analytics are not silently dropped
- **fix_window_bounds.py** — New patch: fixes three window management issues on Linux:
  - Child view bounds fix: hooks maximize/unmaximize/fullscreen/moved events to manually set child view bounds (fixes blank white area on KWin corner-snap)
  - Ready-to-show size jiggle: +1px resize then restore after 50ms to force Chromium layout recalculation on first load
  - Quick Entry blur before hide: adds `blur()` before `hide()` for proper focus transfer
- **scripts/claude-desktop-launcher.sh** — New launcher script replacing the bare `exec electron` one-liner:
  - Wayland/X11 detection (defaults to XWayland for global hotkey support, `CLAUDE_USE_WAYLAND=1` for native Wayland)
  - Auto-detects Niri compositor (forces native Wayland — no XWayland)
  - Electron args: `--disable-features=CustomTitlebar`, `--ozone-platform`, `--enable-wayland-ime`, etc.
  - Environment: `ELECTRON_FORCE_IS_PACKAGED=true`, `ELECTRON_USE_SYSTEM_TITLE_BAR=1`
  - SingletonLock cleanup (removes stale lock files from crashed sessions)
  - Cowork socket cleanup (removes stale `cowork-vm-service.sock`)
  - `CLAUDE_MENU_BAR` support (auto/visible/hidden)

### Fixed
- **Navigator spoof changed from Mac to Windows** — `navigator.platform` now returns `"Win32"` instead of `"MacIntel"` and `userAgentFallback` spoofs as Windows, so the frontend shows Ctrl/Alt shortcuts instead of ⌘/⌥. Server-facing HTTP headers still send "darwin" for Cowork feature gating.

### Notes
- 27/27 patches pass (fix_mcp_reconnect.py: upstream fix, no patch needed)
- Feature flag architecture unchanged from v1.1.7053 — same 14 flags, same 3-layer override
- New upstream features in v1.1.7464: SSH remote CCD sessions, Scheduled Tasks (cron), Teleport to Cloud, Git/PR integration, DXT extensions, Keep-Awake
- New sidebar mode: `"epitaxy"` (purpose unknown)
- CoworkSpaces fully implemented on Linux — file-based `_SpacesService` with JSON persistence, 17 CRUD/file methods, push events, and SpaceManager singleton integration. Spaces UI is rendered by the claude.ai web frontend (server-side gated by Anthropic, not desktop feature flags). Dispatch works independently of Spaces (spaceId is optional in session creation)
- Function renames: rp/zM/$Se/oq (was Kh/$M/Qwe/K9)
- eipc UUID: `fcf195bd-4d6c-4446-98e4-314753dfa766` (dynamically extracted)

## 2026-03-17

### Changed
- **Update to Claude Desktop v1.1.7053** (from v1.1.3189)

### Added
- **fix_cowork_spaces.py** — New patch: injects a full file-based CoworkSpaces service on Linux. The renderer calls `getAllSpaces`, `createSpace`, `getAutoMemoryDir`, etc. via eipc but no handler is registered in the main process on Linux (native backend doesn't load). The `_SpacesService` class provides JSON persistence (`~/.config/Claude/spaces.json`), full CRUD for spaces/folders/projects/links, file operations with security validation, push event notifications, and SpaceManager singleton integration so `resolveSpaceContext` works.

### Fixed
- **enable_local_agent_mode.py** — Fix mC() merger pattern: `\w+` → `[\w$]+` for the async merger variable name (was `$M` in this version, `$` not matched by `\w`)

### Notes
- 24/24 patches pass (fix_mcp_reconnect.py: upstream fix, no patch needed)
- New feature flag `floatingAtoll` added upstream (always `{status:"unavailable"}` — disabled for all platforms, no Linux patch needed)
- New settings: `chicagoEnabled`, `keepAwakeEnabled`, `coworkScheduledTasksEnabled`, `ccdScheduledTasksEnabled`, `sidebarMode`, `bypassPermissionsModeEnabled`, `autoPermissionsModeEnabled`
- New developer flags: `isPhoenixRisingAgainEnabled` (new updater), `isDxtEnabled`/`isDxtDirectoryEnabled` (browser extensions), `isMidnightOwlEnabled`
- eipc UUID changed to `316b9ec7-48bb-494d-b1a8-82f8448548fb` (dynamically extracted by fix_computer_use_tcc.py)
- Function renames: Kh/$M/Qwe/K9 (was nh/rO/Ebe/J5)
- `fix_marketplace_linux.py` Patches A & B return 0 matches (patterns refactored upstream); Patch C (CCD gate) still active

## 2026-03-15

### Fixed
- **fix_dock_bounce.py** — Comprehensive fix for taskbar attention-stealing on KDE Plasma and other Linux DEs ([#10](https://github.com/patrickjaja/claude-desktop-bin/issues/10)). Previous approach only patched `BrowserWindow.prototype` methods but missed `WebContents.focus()` which bypasses those overrides entirely and triggers `gtk_window_present()`/`XSetInputFocus()` at the C++ level, causing `_NET_WM_STATE_DEMANDS_ATTENTION`. New approach:
  - **Layer 1 (prevent):** No-op `flashFrame(true)`/`app.focus()`, guard `BrowserWindow.focus()`/`moveTop()`, use `showInactive()` instead of `show()` when app not focused, enable `backgroundThrottling` on Linux, early-return `requestUserAttention()`, **intercept `WebContents.focus()` via `web-contents-created` event** (the key fix — only allow when parent window is focused)
  - **Layer 2 (cure):** On every window blur, actively call the real `flashFrame(false)` on a 500ms interval to continuously clear demands-attention state set by Chromium internals. Stops on focus.

## 2026-03-11

### Changed
- **Update to Claude Desktop v1.1.6041** (from v1.1.5749)

### Fixed
- **fix_computer_use_tcc.py** — Dynamically extract eipc UUID from source files instead of hardcoding it. The UUID changed from `a876702f-...` to `dbb8b28b-...` between versions, causing `No handler registered for ComputerUseTcc.getState` errors. Now searches index.js (fallback: mainView.js) for the UUID at patch time, making the patch resilient to future UUID rotations.

### Notes
- 22/22 patches pass (fix_mcp_reconnect.py: upstream fix, no patch needed)
- No new platform gates requiring patches — all critical darwin/win32 checks already handled
- Upstream now ships Linux CCD binaries (linux-x64, linux-arm64, musl variants) and Linux VM rootfs images in manifest
- New IPC handler groups: CoworkScheduledTasks, CoworkSpaces, CoworkMemory, LocalSessions SSH/Teleport, expanded Extensions
- New `sshcrypto.node` native addon for SSH support (not yet needed for core functionality)
- `louderPenguin` (Office Addin) remains darwin+win32 only — no action needed for Linux

## 2026-03-09

### Changed
- **Update to Claude Desktop v1.1.5749** (from v1.1.4498)

### Fixed
- **fix_disable_autoupdate.py** — Handle new `forceInstalled` check before platform gate in isInstalled function (pattern: `if(Qm.forceInstalled)return!0;if(process.platform!=="win32")...`)
- **claude-native.js** — Add stubs for new native methods: `readRegistryValues`, `writeRegistryValue`, `readRegistryDword`, `getCurrentPackageFamilyName`, `getHcsStatus`, `enableWindowsOptionalFeature`, `getWindowAbove`, `closeOfficeDocument`, `isProcessRunning`, `readCfPrefValue`
- **fix_marketplace_linux.py** — Downgrade runner selector and search_plugins handler patterns from FAIL to INFO (patterns removed in v1.1.5749 marketplace refactor; CCD gate patch C remains the essential fix)

### Added
- **fix_computer_use_tcc.py** — Register stub IPC handlers for ComputerUseTcc on Linux. The renderer (mainView.js) always calls `ComputerUseTcc.getState` but handlers are only registered by `@ant/claude-swift` on macOS. Stubs return `not_applicable` for permissions, preventing repeated IPC errors.
- **computer-use-server.js** — Linux Computer Use MCP server using xdotool (input) and scrot (screenshots) on X11. Provides 14 actions: left_click, right_click, double_click, triple_click, middle_click, type, key, screenshot, scroll, left_click_drag, hover, wait, zoom, cursor_position.
- **fix_computer_use_linux.py** — Registers computer-use-server.js as an internal MCP server via BR() (registerInternalMcpServer), spawning it as a Node.js child process with ELECTRON_RUN_AS_NODE=1. Only activates on Linux.
- **Packaging** — Added `xdotool` and `scrot` as optional dependencies across all formats: `optdepends` (Arch PKGBUILD), `Suggests` (Debian control, RPM spec), optional inputs with PATH wiring (Nix package.nix)

### Notes
- 22/22 patches pass (fix_mcp_reconnect.py: upstream fix, no patch needed)
- Computer Use requires `xdotool` and `scrot` packages (X11). Wayland not yet supported. Both are declared as optional dependencies across all packaging formats (AUR, Debian, RPM, Nix).
- No new feature flags detected (same 7: quietPenguin, louderPenguin, chillingSlothFeat, chillingSlothLocal, yukonSilver, yukonSilverGems, ccdPlugins)
- getLocalFileThumbnail uses pure Electron nativeImage API — no native stub needed
- Bridge methods (respondPluginSearch, kickBridgePoll, BridgePermission) are Electron IPC only

## 2026-03-02

### Fixed
- **scripts/build-patched-tarball.sh** — Bundle `claude-ssh` binaries from Windows package into `locales/claude-ssh/` to fix SSH remote environment feature ([#8](https://github.com/patrickjaja/claude-desktop-bin/issues/8))
- **patches/fix_0_node_host.py** — Fix shell path worker error (`Shell path worker not found at .../locales/app.asar/...`) by replacing `process.resourcesPath,"app.asar"` with `app.getAppPath()` before the global locale path redirect
- **PKGBUILD.template** — Restore `{{placeholders}}` so `generate-pkgbuild.sh` can substitute version/URL/SHA; hardcoded values caused local builds to use stale cached tarballs missing `claude-ssh` binaries
- **patches/claude-native.js** — Fix patch target from `app.asar.contents/node_modules/claude-native/` to `app.asar.unpacked/node_modules/@ant/claude-native/` to eliminate `ERR_DLOPEN_FAILED` invalid ELF header error
- **scripts/build-patched-tarball.sh** — Remove Windows `claude-native-binding.node` DLL after asar repack to prevent shipping unusable PE32 binary
- **packaging/debian/build-deb.sh** — Set SUID permission (4755) on `chrome-sandbox` after Electron extraction and in `postinst` script to fix startup crash on Ubuntu/Debian
- **packaging/rpm/claude-desktop-bin.spec** — Set SUID permission on `chrome-sandbox` in `%post` and `%files` sections to fix startup crash on RPM-based distros

## 2026-02-27

### Changed
- **PKGBUILD.template** — Set `url` to GitHub packaging repo instead of claude.ai per AUR guidelines

## 2026-02-25

### Changed
- **Update to Claude Desktop v1.1.4328** (from v1.1.4173)

### Fixed
- **enable_local_agent_mode.py** — Make yukonSilver formatMessage `id` field optional in regex (`(?:,id:"[^"]*")?`) to handle v1.1.4328 adding i18n IDs
- **enable_local_agent_mode.py** — Use `[\w$]+` instead of `\w+` for getSystemInfo `total_memory` variable (`$r` contains `$`)

### Notes
- 4 new IPC handlers: `CoworkSpaces.copyFilesToSpaceFolder`, `CoworkSpaces.createSpaceFolder`, `FileSystem.browseFiles`, `LocalSessions.delete`
- All 19 patches pass, no structural changes to platform gating or feature flags
- Key renames: chillingSlothFeat=TMt, quietPenguin=MMt, yukonSilver=RMt, os module=`$r`

## 2026-02-24

### Changed
- **Update to Claude Desktop v1.1.4088** (from v1.1.3918)

### Fixed
- **fix_disable_autoupdate.py** — Use `[\w$]+` instead of `\w+` for Electron module variable (`$e` contains `$`)
- **fix_marketplace_linux.py** — Use `[\w$]+` for all variable patterns; gate function renamed `Hb`→`$S`, managers `gz`→`CK`/`$K`
- **fix_quick_entry_position.py** — Use `[\w$]+` for Electron module variable; make fallback display patch optional (lazy-init pattern removed upstream)
- **fix_tray_icon_theme.py** — Use `[\w$]+` for Electron module variable (`$e`)
- **fix_mcp_reconnect.py** — Detect upstream close-before-connect fix and skip gracefully (upstream added `t.transport&&await t.close()`)
- **enable_local_agent_mode.py** — Add second regex variant for the yukonSilver (NH/WOt) platform gate to support v1.1.4173+ `formatMessage` pattern alongside the old template literal pattern

### Added
- **update-prompt.md** — New "Step 0: Clean Slate" section for removing stale artifacts before version updates
- **CLAUDE.md** — Added log files section documenting runtime logs at `~/.config/Claude/logs/`

### Notes
- Key renames: Electron module `Pe`→`$e`, CCD gate `Hb`→`$S`, marketplace managers `gz`/`mz`→`CK`/`$K`
- MCP reconnect fix is now upstream — patch detects and skips
- Common fix: `$` in minified JS identifiers requires `[\w$]+` in regex patterns

## 2026-02-21

### Changed
- **Update to Claude Desktop v1.1.3918** (from v1.1.3770)

### Added
- **RPM packaging** — `packaging/rpm/build-rpm.sh` + `claude-desktop-bin.spec` for Fedora/RHEL; builds in `fedora:40` container during CI, `.rpm` included in GitHub Release assets
- **NixOS packaging** — `flake.nix` + `packaging/nix/package.nix` using system Electron via `makeWrapper`; `packaging/nix/update-hash.sh` helper for version bumps
- **CI: RPM build/test** — Fedora container builds and smoke-tests the `.rpm` before release
- **CI: Nix build** — Validates `nix build` succeeds during CI; uses local `file://` tarball to avoid hash mismatch with not-yet-created GitHub release

### Fixed
- **enable_local_agent_mode.py** — Use `[\w$]+` instead of `\w+` for async merger function names (`$Pt` contains `$`); also make User-Agent spoof pattern variable-agnostic (`\w+\.set` instead of hardcoded `s\.set`)
- **fix_cowork_linux.py** — Use regex instead of literal match for error detection pattern; variable name changed from `t` to `e` in v1.1.3918

### Added
- **fix_mcp_reconnect.py** — New patch: fix MCP server reconnection error ("Already connected to a transport") by calling `close()` before `connect()` in the `connect-to-mcp-server` IPC handler

### Documentation
- **CLAUDE_FEATURE_FLAGS.md** — Updated for v1.1.3918: function renames (Oh→Fd, mC→mP, QL→o_e), `chillingSlothEnterprise` moved to static layer, `mP` simplified to only override `louderPenguin`, `ccdPlugins` inlined, added version history table

### Notes
- Key renames: Oh()→Fd(), mC()→mP, QL()→o_e(), all individual feature functions renamed
- `chillingSlothLocal` now unconditionally returns supported (no more win32/arm64 gate)
- `louderPenguin` removed from Fd() entirely, only exists in mP async merger

## 2026-02-20

### Changed
- **Update to Claude Desktop v1.1.3770** (from v1.1.3647)

### Fixed
- **fix_quick_entry_position.py** — Use `[\w$]+` instead of `\w+` for function name in position function pattern; minified name `s$t` contains `$` which `\w` doesn't match
- **fix_locale_paths.py / fix_tray_path.py** — Replace hardcoded `/usr/lib/claude-desktop-bin/locales` with runtime expression `require("path").dirname(require("electron").app.getAppPath())+"/locales"` so locale/tray paths resolve correctly for Arch, Debian, and AppImage installs (fixes [#7](https://github.com/patrickjaja/claude-desktop-bin/issues/7))
- **fix_node_host.py → fix_0_node_host.py** — Renamed so it runs before fix_locale_paths.py; regex updated to match original `process.resourcesPath` instead of post-patch hardcoded path
- **build-deb.sh** — Bundle Electron instead of depending on system `electron`; fix dependencies from Arch package names to Ubuntu/Debian shared library deps; fix launcher to use bundled binary

## 2026-02-19

### Changed
- **Update to Claude Desktop v1.1.3647** (from v1.1.3363, +284 builds)

### Fixed
- **fix_tray_path.py** — Use `[\w$]+` instead of `\w+` for function/variable names; minified name `f$t` contains `$` which `\w` doesn't match
- **fix_app_quit.py** — Same `[\w$]+` fix for variables `f$` and `u$` in the cleanup handler
- **fix_claude_code.py** — `getHostPlatform()` pattern updated: win32 block now has arm64 conditional (`e==="arm64"?"win32-arm64":"win32-x64"`) instead of hardcoded `"win32-x64"`. Also tightened the "already patched" idempotency check to prevent false positives from other patches' `if(process.platform==="linux")` injections
- **fix_claude_code.py** / **fix_cowork_linux.py** — Claude Code binary resolution now falls back to `which claude` dynamically when not found at standard paths, supporting npm global, nvm, and other non-standard install locations. `getStatus()` also gains the `which` fallback so the Code tab submit button no longer shows "Downloading dependencies..." for non-standard installs

### Documentation
- **CLAUDE_FEATURE_FLAGS.md** — Updated for v1.1.3770: added `ccdPlugins` (#13), updated `louderPenguin` gate info (async override in mC), added org-level settings section
- **enable_local_agent_mode.py** — Added `ccdPlugins:{status:"supported"}` to mC() override (7 features total)
- **update-prompt.md** — Added Feature Flag Audit prompt (Prompt 3) for version updates

### Notes
- New upstream feature: `ccdPlugins` added to Oh() static registry, `louderPenguin` moved from QL()-wrapped to direct call with `Xi()` feature check
- New settings: `chillingSlothLocation`, `secureVmFeaturesEnabled`, `launchEnabled`, `launchPreviewPersistSession`
- Key renames: function names now use `$` in identifiers (e.g., `f$t`, `f$`, `u$`)

## 2026-02-18

### Changed
- **Update to Claude Desktop v1.1.3363** (from v1.1.3189, 174 builds ahead)

### Fixed
- **fix_claude_code.py** — `getStatus()` regex now uses `[\w$]+` instead of `\w+` for the status enum name, fixing match failure when minifier produces `$`-prefixed identifiers (e.g. `$s`)
- **fix_marketplace_linux.py** — CCD gate function name and runner selector now use flexible `\w+` patterns instead of hardcoded `Hb`/`oAt` (function renamed to `Gw` in v1.1.3363)

### Added
- **update-prompt.md** — Reusable prompts for future version updates (build & fix, diff & discover)

### Notes
- Diff analysis shows only minified variable renames between v1.1.3189 and v1.1.3363
- One new feature flag `4160352601` (VM heartbeat auto-restart) — no Linux patch needed
- Key renames: `la()` → `Xi()` (feature flags), `Hb` → `Gw` (CCD gate), `Cs` → `$s` (status enum), `tt` → `rt` (path module)

## 2026-02-17

### Changed
- **Adapt download pipeline to new CDN structure** — Old `/latest/Claude-Setup-x64.exe` URL now returns 404 and the redirect endpoint returns a 6.7MB bootstrapper instead of the full installer. Updated `build-local.sh` and CI workflow to query the `.latest` JSON API for version+hash, then download the full 146MB installer from the hash-named URL.

### Fixed
- **"Manage" plugin sidebar flashes and closes on Cowork tab** — Patch `Hb()` (the CCD/Cowork gate function) to return true on Linux, routing all plugin operations through host-local CCD paths instead of account-scoped Cowork paths. On Linux there's no VM, so the CCD path is always correct. This single change fixes 5 call sites: runner selection (`oAt`), getPlugins, uploadPlugin, deletePlugin, and setPluginEnabled. The sidebar was closing because `getPlugins` looked in account-scoped directories where `gz` (host runner) hadn't installed anything.
- **Browse Plugins empty on Cowork tab** — New `fix_marketplace_linux.py` forces the host CLI runner (`gz`) for marketplace operations on Linux. Previously, the Cowork tab selected the VM runner (`mz`) which routed `claude plugin marketplace` commands through the daemon, failing with `MARKETPLACE_ERROR:UNKNOWN`. Since marketplace management is a host filesystem operation, the host runner is always correct on Linux.

### Known Issues
- **Cowork sidebar sessions** — Previous local sessions may not appear in the sidebar due to `local_`-prefixed UUIDs failing server-side validation. This is an upstream issue in the claude.ai renderer code.

## 2026-02-16

### Fixed
- **AUR sha256sum mismatch on patch releases** — Source filename now includes `pkgrel` (`claude-desktop-VERSION-PKGREL-linux.tar.gz`) so makepkg cache is busted on patch rebuilds. CI reordered to create GitHub Release before pushing to AUR, with a download verification step to prevent referencing non-existent tarballs.

- **Browse/Web Search in Cowork sessions** — MCP server proxying now works end-to-end. Requires `claude-cowork-service >= 0.3.2` which stops blocking MCP traffic between Claude Code and Desktop.

- **fix_cowork_linux.py** — Use empty bundle file list (`linux:{x64:[]}`) instead of copying win32's list. No VM files are needed since the native Go backend runs Claude Code directly. Empty array makes download status return Ready immediately, avoiding ENOSPC (tmpfs full) and EXDEV errors.
- **fix_cross_device_rename.py** — Use flexible `\w+` pattern for fs module name (changes between versions: `zr`, `ur`, etc.) and negative lookbehind to skip rename calls already inside try blocks

## 2026-02-11

### Changed
- **Multi-distro cowork install docs** — README Cowork section now includes universal curl one-liner alongside AUR instructions

### Added
- **Cowork Linux support (experimental)** — New `fix_cowork_linux.py` patch enables the Cowork VM feature on Linux:
  - Extends TypeScript VM client (`vZe`) to load on Linux instead of requiring `@ant/claude-swift`
  - Adds Unix domain socket path (`$XDG_RUNTIME_DIR/cowork-vm-service.sock`) as Linux alternative to Windows Named Pipe
  - Adds Linux platform to bundle config for VM image downloads
  - Requires `claude-cowork-service` daemon running on the host (QEMU/KVM-based)
- **claude-cowork-service optional dependency** — PKGBUILD now lists `claude-cowork-service` as optional for Cowork VM features
- **Cowork error messages** — New `fix_cowork_error_message.py` replaces Windows-centric "VM service not running" errors with Linux-friendly guidance pointing users to `claude-cowork-service`
- **Cross-device rename fix** — New `fix_cross_device_rename.py` handles EXDEV errors when moving VM bundles from `/tmp` (tmpfs) to `~/.config/Claude/`
- **Force rebuild workflow** — New `force_rebuild` checkbox in GitHub Actions manual trigger to rebuild and release when patches/features change without an upstream version bump. Auto-increments `pkgrel`, generates git changelog grouped by date, and updates AUR + GitHub Release

### Fixed
- **Claude Code binary discovery** — `fix_claude_code.py` and `fix_cowork_linux.py` now check multiple paths (`/usr/bin/claude`, `~/.local/bin/claude`, `/usr/local/bin/claude`) instead of only `/usr/bin/claude`, fixing "Downloading dependencies..." stuck state and cowork spawn failures for npm-installed Claude Code

### Changed
- **fix_vm_session_handlers.py** — Removed Linux platform stubs (getDownloadStatus, getRunningStatus, download, startVM); these methods now call through to the real TypeScript VM client which talks to the daemon via Unix socket. Only the global uncaught exception handler remains as a safety net.

### Removed
- **fix_hide_cowork_tab.py** — Deleted; the Cowork tab is now functional on Linux when the daemon is running. Without the daemon, connection errors appear naturally in the UI.

## 2026-02-10

### Added
- **Runtime smoke testing in CI** — Three layers of defense to prevent broken builds reaching users:
  - Brace mismatch in `fix_vm_session_handlers.py` now fails the build instead of warning
  - `node --check` validates JavaScript syntax on all patched files before repacking
  - New `scripts/smoke-test.sh` runs the Electron app headlessly via `xvfb-run` for 15s to catch runtime crashes
  - CI Docker container now installs `electron` and `xorg-server-xvfb` for smoke testing

### Fixed
- **fix_vm_session_handlers.py** — Replace false-positive absolute brace count check with delta check (comparing before/after patching); add support for new `try/catch` wrapper in `getRunningStatus` pattern (v1.1.2685+)
- **enable_local_agent_mode.py** — Update mC() merger pattern for v1.1.2685: `desktopVoiceDictation` was removed from async merger, now uses flexible pattern matching the full async arrow function instead of hardcoding the last property name

## 2026-02-06

### Fixed
- **fix_hide_cowork_tab.py** — Use flexible `\w+` regex instead of hardcoded `xg` function name, preventing breakage on minified variable name changes across releases

## 2026-02-05

### Added
- **Auto-hide menu bar on Linux** — Native menu bar (File, Edit, View, Help) is now hidden by default; press Alt to show it temporarily
- **Window icon on Linux** — Claude icon now appears in the window title bar

### Fixed
- **Disable non-functional Cowork tab** — Cowork requires ClaudeVM (unavailable on Linux); tab is now visually disabled with reduced opacity and click prevention via `fix_hide_cowork_tab.py`
- **Suppress false update notifications** — New `fix_disable_autoupdate.py` patch makes the isInstalled check return false on Linux, preventing "Update heruntergeladen" popups
- **Stop force-enabling chillingSlothFeat** — `enable_local_agent_mode.py` no longer patches the chillingSlothFeat (Cowork) function or overrides it in the mC() merger; only quietPenguin/louderPenguin (Code tab) are enabled
- **Gate chillingSlothLocal on Linux** — Added Linux platform check to prevent it from returning "supported"
- **Fix startVM parameter capture** — `fix_vm_session_handlers.py` now uses dynamic parameter name capture instead of hardcoded `e`
- **Fix getBinaryPathIfReady pattern** — `fix_claude_code.py` updated for new `getLocalBinaryPath()` code path in v1.1.2102

## 2026-02-02

### Fixed
- **Top bar now clickable on Linux** - Fixed non-clickable top bar elements (sidebar toggle, back/forward arrows, Chat/Code tabs, incognito button):
  - **Root cause**: `titleBarStyle:"hidden"` creates an invisible drag region across the top ~36px on Linux, intercepting all mouse events even with `frame:true`
  - **Fix**: `fix_native_frame.py` now replaces `titleBarStyle:"hidden"` with `"default"` on Linux via platform-conditional (`process.platform==="linux"?"default":"hidden"`), targeting only the main window (Quick Entry window preserved)
  - Removed `fix_title_bar.py` and `fix_title_bar_renderer.py` (no longer needed — the native top bar works correctly once the invisible drag region is eliminated)

## 2026-01-30

### Fixed
- **Code tab and title bar for v1.1.1520** - Fixed two UI regressions after upgrading to Claude Desktop v1.1.1520:
  - **Code tab disabled**: The QL() production gate blocks `louderPenguin`/`quietPenguin` features in packaged builds. Added mC() async merger patch to override QL-blocked features, plus preferences defaults patch (`louderPenguinEnabled`/`quietPenguinEnabled` → true)
  - **Title bar missing**: Electron 39's WebContentsView architecture occludes parent webContents. Created a dedicated WebContentsView (`tb`) for the title bar that loads the same `index.html` with its own IPC handlers, positioned at y=0 with 36px height, pushing the claude.ai view down
  - Removed `fix_browserview_position.py` (title bar is now a separate WebContentsView)

### Added
- **Feature flag documentation** (`CLAUDE_FEATURE_FLAGS.md`) - Documents all 12 feature flags, the 3-layer override architecture (Oh → mC → IPC), and the QL() production gate

### Changed
- **validate-patches.sh** - Fixed exit code checking (was checking sed's exit code instead of python3's due to piping)

## 2026-01-26

### Fixed
- **Title bar and sidebar issues for v1.1.886** - Fixed two related issues where title bar hides and sidebar toggle is not clickable:
  - New patch `fix_browserview_position.py`: Fixes BrowserView y-positioning - changes `c=Ds?eS+1:0` to `c=Pn?0:eS+1` so Linux gets the 37px title bar offset like Windows
  - Updated `fix_title_bar.py`: Disables both early returns in renderer with `false&&` prefix instead of removing negation

## 2026-01-20

### Added
- **Multi-distro packaging** - Claude Desktop now available for multiple Linux distributions:
  - **AppImage** - Portable, runs on any distro without installation (bundles Electron)
  - **Debian/Ubuntu (.deb)** - Native package for apt-based systems
  - All formats built automatically in CI and uploaded to GitHub Releases
- **Pre-built package distribution** - CI now builds and uploads pre-patched tarballs to GitHub Releases:
  - Reduced dependencies for users (no python, asar, p7zip needed)
  - Faster package installation
  - Changelog included in GitHub release notes

### Changed
- **Refactored build architecture** - Separated patching logic from package generation:
  - New `scripts/build-patched-tarball.sh` contains all patching logic in one place
  - `PKGBUILD.template` is now a simple tarball-based installer (no patches)
  - `generate-pkgbuild.sh` simplified to just template substitution
  - CI builds tarball once, then builds AppImage/.deb/Flatpak from it
  - Users download pre-patched tarball (no build-time patching needed)
- **Electron version** - AppImage/Flatpak now fetch latest stable Electron automatically

## 2026-01-19

### Fixed
- **Patch patterns for v1.1.381** - Updated patches to use flexible regex patterns:
  - enable_local_agent_mode.py: Use `\w+` wildcard for minified function names (qWe→wYe, zWe→EYe)
  - fix_claude_code.py: Use regex with capture group for status enum name (Yo→tc)
  - fix_tray_icon_theme.py: Always use light tray icon on Linux (trays are universally dark)
  - fix_vm_session_handlers.py: Use regex patterns for all VM functions (WBe→Wme, Zc→Xc, IS→YS, ty→g0, qd→Qd, Qhe→Hme, Jhe→MB, ce→oe)

## 2026-01-13

### Added
- **Local Agent Mode for Linux** - New patch (enable_local_agent_mode.py) enables the "chillingSloth" feature on Linux:
  - Enables Local Agent Mode sessions with git worktree isolation
  - Enables Claude Code for Desktop integration
  - Patches qWe() and zWe() platform checks to return "supported" on all platforms
  - Note: SecureVM (yukonSilver) and Echo features still require macOS-only Swift modules
- **ClaudeVM Linux handling** - New patch (fix_vm_session_handlers.py) to gracefully handle VM features not supported on Linux:
  - getDownloadStatus returns NotDownloaded on Linux
  - getRunningStatus returns Offline on Linux
  - download/startVM fail with helpful error messages
  - Error handler suppresses unsupported feature errors

### Fixed
- **Claude Code Linux platform support** - Updated fix_claude_code.py to add Linux support:
  - Added Linux platform detection to getHostPlatform() (root cause of "Unsupported platform: linux-x64" error)
  - Linux checks now run BEFORE getHostTarget() to avoid throwing errors

## 2026-01-12

### Fixed
- **Patch patterns for v1.0.3218** - Updated patches to use flexible regex patterns:
  - fix_claude_code.py: Updated for new `getHostTarget()` and `binaryExistsForTarget()` APIs, status enum `Rv→Yo`
  - fix_app_quit.py: Use dynamic capture for variable names (`S_&&he→TS&&ce`)
  - fix_tray_dbus.py: Fix async check to avoid matching similar function names, handle preamble code before first const

## 2026-01-08

### Added
- **App quit fix** - Fix app not quitting after cleanup on Linux (fix_app_quit.py). After `will-quit` handler calls `preventDefault()`, `app.quit()` becomes a no-op. Solution uses `app.exit(0)` with `setImmediate` after cleanup completes.
- **UtilityProcess SIGKILL fix** - Use SIGKILL as fallback when UtilityProcess doesn't exit gracefully (fix_utility_process_kill.py)
- **Custom app icon** - Extract full-color orange Claude logo from setupIcon.ico at build time (requires icoutils)

### Fixed
- Fixed app hanging on exit when using integrated Node.js server for MCP

## 2025-12-17

### Added
- **MCP node host path fix** - Fix incorrect path for MCP server node host on Linux (fix_node_host.py)
- **Startup settings fix** - Handle Linux platform in startup settings to avoid validation errors (fix_startup_settings.py)
- **Tray icon theme fix** - Always use light tray icon on Linux since system trays are universally dark (fix_tray_icon_theme.py)

## 2025-12-02

### Fixed
- **Patch patterns for v1.0.1405** - Updated fix_quick_entry_position.py to use backreference pattern for fallback display variable (r→n)

## 2025-11-26

### Added
- **CLAUDE.md** - Patch debugging guidelines for developers

### Fixed
- **Patch patterns for v1.0.1307** - Updated fix_quick_entry_position.py and fix_tray_path.py to use flexible regex patterns (ce→de, pn→gn, pTe→lPe)

## 2025-11-25

### Added
- **Patch validation in CI pipeline** - Test build in Docker container before pushing to AUR
- **validate-patches.sh script** - Local validation tool for developers to test patches
- **Claude Code CLI integration** - Patch to detect and use system-installed `/usr/bin/claude`
- **AuthRequest stub** - Added AuthRequest class stub to claude-native.js for Linux authentication fallback
- **Native frame patch** - Use native window frames on Linux/XFCE while preserving Quick Entry transparency
- **Quick Entry position patch** - Spawn Quick Entry on the monitor where cursor is located
- **Tray DBus fix** - Prevent DBus race conditions with mutex guard and cleanup delay
- **Tray path fix** - Redirect tray icon path to package directory on Linux
- Isolated patch files in `patches/` directory for easier maintenance
- Local build script `scripts/build-local.sh` for development testing

### Changed
- **Patches now fail on pattern mismatch** - All Python patches exit with code 1 if patterns don't match
- **generate-pkgbuild.sh captures exit codes** - Build fails if any patch fails to apply
- Refactored all inline patches into separate files
- Refactored PKGBUILD generation to use template approach

### Fixed
- **Native frame patch** - Handle upstream code changes in v1.0.1217+ where main window no longer explicitly sets frame:false
- **Patch validation script** - Fixed handling of replace-type patches that create new files
- **CI pipeline** - Improved error handling with pipefail to catch build failures in piped commands
- Fixed tray icon loading - copy TrayIconTemplate PNG files to locales directory for Electron Tray API

### Removed
- Removed .SRCINFO from git tracking (auto-generated file)
- Removed PKGBUILD from repo (generated from template)

## 2025-11-24

### Changed
- Update to version 1.0.1217

## 2025-11-17

### Changed
- Update to version 1.0.734

## 2025-11-13

### Added
- Add GitHub repository link to PKGBUILD
- Add manual download URL input for workflow_dispatch

### Changed
- Update to version 1.0.332

## 2024-09-16

### Added
- Initial working package with patched claude-native module
- GitHub automation for AUR package maintenance
- Locale file loading patches for Linux compatibility
- Desktop entry and icon installation

### Fixed
- Title bar detection on Linux
- Tray icon functionality
- Notification support
