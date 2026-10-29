/*
 * diff_views_main.js - main-process half of the diff view modes feature.
 * Injected into .vite/build/index.js by patches/add_feature_diff_views.nim.
 *
 * ============================================================
 * ARCHITECTURE (2026-07-31 pivot - ADDENDUM in
 * docs/superpowers/specs/2026-07-31-diff-view-modes-design.md)
 * ============================================================
 * We no longer render our own diff. The stock diff panel's DATA comes from
 * local, patchable main-process eipc handlers, so the three modes are
 * ARGUMENT REWRITES applied to those handlers and the STOCK renderer draws
 * everything (syntax highlighting, virtualisation, theming, line comments).
 *
 * Jobs:
 *   1. Learn the active Code session's project cwd + user-turn starts by
 *      wrapping child creation (runtime hook - no regex on minified code).
 *   2. Snapshot the working tree (temp-index write-tree) at each turn start.
 *   3. Intercept the LocalSessions git-diff IPC registrations and rewrite
 *      their arguments according to the current mode.
 *   4. Detect the TRUE base branch (closest fork point) and apply it in EVERY
 *      mode - including pass-through/"working" - plus report it back through
 *      getGitInfo so the breadcrumb names the branch we actually diff against.
 *      See "SMART BASE BRANCH DETECTION" and "MAKING THE UI HONEST" below.
 *      Escape hatch: `git config branch.<name>.cdbBaseBranch <ref>`.
 *   5. Register the bridge handlers (state, set-mode) and own the feature's own
 *      preference - `diffViewModes` in claude-desktop-extra.json, default FALSE
 *      (OPT-IN), read/written here and switched from Settings -> Extra ->
 *      Features. Off makes every wrapper a byte-identical pass-through and takes
 *      no turn snapshots, live, no restart; see "FEATURE PREFERENCE" below.
 *   6. Inject the page UI (diff_views_page.js) on every http(s) dom-ready.
 *
 * ------------------------------------------------------------
 * INTERCEPTION POINT - CORRECTION TO THE ORIGINAL PLAN
 * ------------------------------------------------------------
 * The pivot brief assumed the registrations go through electron's global
 * `ipcMain.handle`. They DO NOT. Verified in the 1.24012.9 bundle
 * (index.chunk-BOXWZA6T.js): the interface object registers with
 *
 *     e.ipc.removeHandler(<channel>), e.ipc.handle(<channel>, async (ev, ...) => ...)
 *
 * where `e` is a raw Electron **WebContents** (call sites: `R0e(e.webContents,
 * yo)` / `R0e(t.webContents, e)`), so `e.ipc` is electron's per-WebContents
 * `webContents.ipc`, NOT `ipcMain`. Electron dispatches `invoke` against
 * webFrameMain.ipc -> webContents.ipc -> ipcMain, first match wins, so a
 * webContents.ipc registration pre-empts the global map entirely: wrapping
 * only `ipcMain.handle` would have intercepted NOTHING.
 * We therefore wrap `wc.ipc.handle` for every WebContents (our
 * "web-contents-created" listener is registered at bundle top, so it runs
 * before the app's own per-WebContents setup), and ALSO wrap `ipcMain.handle`
 * as a belt-and-braces catch in case a future release moves registration
 * there. Both are stable Electron APIs - still no regex on minified code.
 *
 * Channel matching is SUFFIX-based ("..._$_LocalSessions_$_getGitDiff"): the
 * full literal embeds a codegen UUID
 * ($eipc_message$_<uuid>_$_claude.web_$_...) that changes per release - it went
 * af60bfbd-... -> a19a1434-... in v2.2553.0 alone.
 *
 * ------------------------------------------------------------
 * VERIFIED HANDLER CONTRACTS (1.24012.9) - all results are `T | null`, all
 * argument validation is imperative typeof checks that THROW on mismatch:
 *   getGitDiff(cwd, base, head?, options?)
 *       options validator accepts only {includePatches?: boolean}
 *       -> {base_ref, head_ref, merge_base, files:[{filename,status,additions,
 *           deletions,changes,patch?,previous_filename?}], ahead_by, behind_by,
 *          total_commits} | null
 *   getGitDiffStats(cwd, base, head?)            (NO options arg)
 *       -> {additions, deletions, fileCount, ahead_by, behind_by} | null
 *   getGitDiffFilePatch(cwd, mergeBase, filePath, prevFilePath?)
 *       -> string | null              (plain string, NOT {patch: ...})
 *   getDiffFileContent(cwd, mergeBase, filePath, prevFilePath?)
 *       -> {oldText: string|null, newText: string|null} | null
 *
 * The two per-file methods take only ONE ref (mergeBase) and diff it against
 * the WORKTREE internally, so an argument rewrite alone cannot express
 * "merge-base..HEAD" for Branch mode. Since their result shapes are confirmed
 * we COMPUTE those two ourselves with git and return the confirmed shapes, so
 * per-file content stays consistent with the rewritten file list. (For Turn
 * mode an arg rewrite would in fact suffice - the "now" tree IS the worktree -
 * but one code path for both modes is simpler and provably consistent.)
 *
 * REF SHAPES UPSTREAM ACCEPTS (verified against the 1.24012.9 pipeline and by
 * running the same git commands in a real repo, 2026-07-31):
 *   - Branch mode MUST pass 40-hex COMMIT shas. Symbolic refs are re-resolved
 *     by upstream with an origin/<ref> preference and collapse to an empty
 *     diff; see the long root-cause note above resolveBranchRefs.
 *   - Turn mode's TREE shas are fine. `rev-parse --verify <tree-sha>` succeeds,
 *     so both resolvers return them verbatim; `merge-base <tree> <tree>` fails
 *     with "is a tree, not a commit" and upstream's own catch falls back to the
 *     base ref, which is exactly the tree we want, and `git diff <tree> <tree>`
 *     is valid. Only ahead_by/behind_by/total_commits come back 0 (the rev-list
 *     probe fails and is caught) - cosmetic; nothing in the diff path gates on
 *     them (the sole aheadBy===0 short-circuit is in the commit-LIST function).
 *
 * SECURITY: the caller is remote claude.ai code. Our own handlers validate the
 * sender and take only a mode enum; cwd comes exclusively from our own spawn
 * hook, and every git invocation uses a fixed argv (no shell).
 */
;/*__CDB_DIFF_VIEWS__*/(function () {
  "use strict";
  if (typeof process === "undefined" || process.platform !== "linux") return;
  if (globalThis.__cdbDiffViewsMain) return;
  globalThis.__cdbDiffViewsMain = true;

  var _electron = require("electron");
  var _app = _electron.app;
  var _ipc = _electron.ipcMain;
  var _cp = require("child_process");
  var _fs = require("fs");
  var _os = require("os");
  var _path = require("path");

  var PAGE_SRC = "__CDB_DV_PAGE_SRC__";
  var MAX_DIFF_BYTES = 2 * 1024 * 1024;
  var GIT_TIMEOUT_MS = 30000;
  var NO_INTERCEPT_WARN_MS = 60000;

  // __cdbDiag (claude-patches.log) is defined inside upstream's app "ready"
  // handler, which runs after this IIFE, and console.log is discarded by the
  // official build. So a line logged before the sink exists is queued and
  // flushed one tick after "ready"; console.log stays the last resort for a
  // build without the CU patch that defines the sink. Only WHERE a line goes
  // waits for "ready" - nothing here delays what this module installs.
  var logQueue = [];
  function emitLog(line) {
    try { (globalThis.__cdbDiag || console.log)(line); } catch (e) {}
  }
  function flushLog() {
    var q = logQueue;
    logQueue = null;
    for (var i = 0; q && i < q.length; i++) emitLog(q[i]);
  }
  function log(m) {
    var line = "[DiffViews] " + m;
    if (logQueue && typeof globalThis.__cdbDiag !== "function") { logQueue.push(line); return; }
    flushLog();
    emitLog(line);
  }
  try { _electron.app.whenReady().then(function () { setTimeout(flushLog, 0); }, function () {}); }
  catch (e) { setTimeout(flushLog, 0); }

  // ---- BOUNDED DIAGNOSTICS ---------------------------------------------------
  // Every "say this once" line in this file used to carry its own dedup map (or a
  // bare boolean), plus its own convention for joining a composite key - two of
  // them joined with a raw NUL byte, which made this entire source a BINARY file
  // to git and rg. One helper replaces all of them.
  //
  //   logOnce(bucket, key, message)
  //
  // logs `message` the first time it sees (bucket, key) and never again. `bucket`
  // names the diagnostic, `key` is whatever makes an occurrence distinct - a cwd,
  // a channel suffix, a reason, or several joined with a plain space. Buckets are
  // separate nested maps, so no separator can ever collide between them and there
  // is nothing to escape. Pass "" for a strictly-once line. Returns whether it
  // logged, which is occasionally useful at a call site.
  var onceSeen = Object.create(null);
  function logOnce(bucket, key, message) {
    var seen = onceSeen[bucket] || (onceSeen[bucket] = Object.create(null));
    var k = String(key);
    if (seen[k]) return false;
    seen[k] = true;
    log(message);
    return true;
  }

  // ---- THE MODE VOCABULARY ---------------------------------------------------
  // One source of truth for the three modes, so the enum validation on the IPC
  // boundary, the mode-dispatch comparisons and the page's dropdown cannot drift
  // apart. The VALUES are part of the bridge contract with js/diff_views_page.js
  // and must stay these exact strings.
  var MODES = { WORKING: "working", BRANCH: "branch", TURN: "turn" };
  var MODE_LIST = [MODES.WORKING, MODES.BRANCH, MODES.TURN];
  function isMode(v) { return typeof v === "string" && MODE_LIST.indexOf(v) !== -1; }

  // ---- session registry ----------------------------------------------------
  // Single "active session" model (last Code session wins); documented limit.
  //
  // MODE IS SCOPED TO ONE REPO (2026-07-31 fix - live mode/session desync):
  //   S.mode     the selected mode
  //   S.modeCwd  the repo the mode was selected FOR (null in working mode)
  //   S.diffCwd  the repo the most recently intercepted git-diff call asked
  //              about, i.e. the repo whose diff panel is actually on screen
  //   S.cwd      the most recent spawn cwd THAT IS A GIT WORK TREE (non-repo
  //              spawns such as /home/deli are ignored outright now). Still a
  //              fallback only - S.diffCwd is what names the visible panel.
  //
  // TURN SNAPSHOTS ARE NO LONGER HERE. They live in the per-repo `turnSnapshots`
  // map below; a single global slot was the cause of the "Latest turn renders as
  // Working tree" bug (long note there).
  // A rewrite is applied ONLY when the intercepted call's cwd === S.modeCwd,
  // so a mode chosen in repo A can never silently reshape repo B's panel.
  //
  // WHY modeCwd IS BOUND TO S.diffCwd AND NOT TO S.cwd (do not "simplify"):
  // S.cwd comes from the spawn hook and does NOT track the visible session.
  // claude-patches.log (2026-07-31, 11:28-11:30) shows it churning to
  // /home/deli every few seconds while the open diff panel was querying
  // /home/deli/Documents/claude-desktop-extra - the CLI gets spawned for
  // home-dir and background sessions constantly. Binding the mode to S.cwd,
  // or resetting the mode from onSessionSpawn on a cwd change, would therefore
  // attribute the mode to the wrong repo and/or destroy the user's selection a
  // second after they made it. args[0] of the intercepted call is the only
  // signal that reliably names the repo whose diff panel is on screen.
  var S = {
    cwd: null,
    mode: MODES.WORKING, modeCwd: null, diffCwd: null
  };

  // ---- FEATURE PREFERENCE (Settings -> Extra -> Features -> Diff view modes) --
  //
  // DEFAULT FALSE - THE FEATURE IS OPT-IN (user decision, 2026-07-31). It changes
  // how the STOCK diff panel behaves: it rewrites the arguments of Anthropic's own
  // git IPC and corrects the base branch the panel compares against. Something
  // that reshapes a first-party surface should be asked for, not assumed, so a
  // fresh install behaves exactly like the official build until the switch in
  // Settings -> Extra -> Features is turned on. A MISSING key therefore means OFF.
  //
  // OWNERSHIP, deliberately: the pref is READ AND WRITTEN HERE, by the patch that
  // owns the behaviour, and the Extra settings page reaches it through two fixed
  // channels of OURS (cdb-diff:pref-read / cdb-diff:pref-set) exposed on
  // window.cdbExtra - the same cross-patch arrangement the theme picker already
  // has with cdb-themes:apply. The settings patch stays the single writer of
  // `growthbookOverrides`; it is NOT the writer of this key. Both writers
  // read-modify-write the same .json and rename atomically, and they never touch
  // each other's keys, so the only exposure is two simultaneous edits of
  // DIFFERENT keys - which is what the theme picker already lives with.
  //
  // WHEN OFF, EVERYTHING OF OURS IS INERT AND LIVE-REVERSIBLE:
  //   - wrapListener and wrapGitInfoListener hand the original arguments to the
  //     original handler and return its result, before ANY planning, git or ref
  //     resolution work happens (the early returns are the first statement),
  //   - every remembered mode is reset to "working", so nothing stays rewritten,
  //   - cdb-diff:state reports enabled:false and the page removes its dropdown,
  //   - onSessionSpawn and onUserTurn return immediately, so NO turn snapshot is
  //     taken: while off, snapshotTree's three git commands per turn would be
  //     work nobody can read. The stdin hook itself stays installed (it is pure
  //     string matching, no git), which is what lets turning the switch on
  //     mid-session start recording from that turn onward with no restart. The
  //     first turn after enabling may find no snapshot yet - the existing
  //     "Latest turn is disabled and says why" path covers exactly that.
  // The wrappers themselves STAY installed: they are put in place once, at
  // channel-registration time, and switching back on must not need a restart.
  var PREF_KEY = "diffViewModes";
  var PREF_DEFAULT = false;
  var prefEnabled = PREF_DEFAULT;
  var prefSource = "default";          // "default" | "json" | "jsonc-locked"

  // Same stripper and the same .json-then-.jsonc precedence the theme engine
  // uses, legacy claude-desktop-bin.* fallback included: the one-time
  // rename migration lives in the custom-themes patch and same-anchor
  // injections stack in reverse, so it may not have run yet when we read.
  function cfgStrip(s) {
    return String(s)
      .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, function (m, q) { return q ? q : ""; })
      .replace(/,(\s*[}\]])/g, "$1");
  }
  function cfgReadFile(p) {
    try {
      var stripped = cfgStrip(_fs.readFileSync(p, "utf8"));
      var v = stripped.trim() ? JSON.parse(stripped) : {};
      return (v && typeof v === "object" && !Array.isArray(v)) ? v : null;
    } catch (e) { return null; }
  }
  function cfgPaths() {
    try { (globalThis.__cdbCfgMigrate || function () {})(); } catch (e) {}
    var d = _app.getPath("userData");
    return {
      json: _path.join(d, "claude-desktop-extra.json"),
      jsonc: _path.join(d, "claude-desktop-extra.jsonc"),
      legacyJson: _path.join(d, "claude-desktop-bin.json"),
      legacyJsonc: _path.join(d, "claude-desktop-bin.jsonc")
    };
  }
  function cfgPick(newPath, oldPath) {
    var v = cfgReadFile(newPath);
    return v !== null ? v : cfgReadFile(oldPath);
  }
  // {value, source}. The .jsonc is the HUMAN-OWNED file and wins the startup
  // merge, so a value found there is reported as locked and pref-set refuses to
  // fight it instead of writing a .json the merge would then ignore.
  function readPrefFromDisk() {
    var p = cfgPaths();
    var jsonc = cfgPick(p.jsonc, p.legacyJsonc);
    if (jsonc && typeof jsonc[PREF_KEY] === "boolean") {
      return { value: jsonc[PREF_KEY], source: "jsonc-locked" };
    }
    var json = cfgPick(p.json, p.legacyJson);
    if (json && typeof json[PREF_KEY] === "boolean") {
      return { value: json[PREF_KEY], source: "json" };
    }
    return { value: PREF_DEFAULT, source: "default" };
  }
  // Writes ONLY the .json (the .jsonc is never created or rewritten here), tmp +
  // rename so a crash cannot leave half a file, and every other key survives.
  function writePref(value) {
    var p = cfgPaths();
    var raw = null;
    try { raw = _fs.readFileSync(p.json, "utf8"); }
    catch (e) {
      if (e.code !== "ENOENT") return { ok: false, error: "cannot read " + p.json + ": " + e.message };
    }
    var cfg = {};
    if (raw !== null) {
      var stripped = cfgStrip(raw);
      try { cfg = stripped.trim() ? JSON.parse(stripped) : {}; }
      catch (e2) {
        return { ok: false, error: p.json + " is not valid JSON (" + e2.message +
          ") - fix or remove it first; nothing was written" };
      }
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
        return { ok: false, error: p.json + " must contain a JSON object; nothing was written" };
      }
      if (stripped !== raw) {
        // Rewriting as plain JSON drops comments - keep the original once.
        try { _fs.writeFileSync(p.json + ".cdb-bak", raw, { flag: "wx" }); } catch (e3) {}
      }
    }
    // The default is FALSE, so "off" is the ABSENCE of the key: a fresh install
    // and one that switched the feature back off look the same on disk, and only
    // an explicit opt-in ever writes anything.
    if (value === PREF_DEFAULT) delete cfg[PREF_KEY];
    else cfg[PREF_KEY] = value;
    var tmp = p.json + ".cdb-tmp";
    try {
      _fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      _fs.renameSync(tmp, p.json);
    } catch (e4) {
      try { _fs.unlinkSync(tmp); } catch (e5) {}
      return { ok: false, error: "cannot write " + p.json + ": " + e4.message };
    }
    return { ok: true, path: p.json };
  }

  // Reset EVERY remembered mode. There is one mode plus the repo it is bound to,
  // so this is all of it - and it must happen on disable: a mode left set would
  // rewrite the panel again the moment the switch came back, instead of the
  // documented "comes back at Working tree".
  function resetAllModes() {
    S.mode = MODES.WORKING;
    S.modeCwd = null;
  }

  function applyPref(value, source) {
    var changed = (value !== prefEnabled) || (source !== prefSource);
    prefEnabled = value;
    prefSource = source;
    if (!value) resetAllModes();
    if (changed) log("pref " + PREF_KEY + "=" + value + " (source: " + source + ")");
    return changed;
  }

  try {
    var pref0 = readPrefFromDisk();
    prefEnabled = pref0.value;
    prefSource = pref0.source;
  } catch (e) {}

  // ---- per-repo turn snapshots ----------------------------------------------
  //
  // ROOT CAUSE THIS REPLACES (2026-07-31 live bug: "Latest turn" rendered
  // EXACTLY like Working tree, silently). The snapshot used to live in ONE
  // global slot - S.turnStartTree, keyed implicitly by the single S.cwd, with
  // one shared generation counter. claude-patches.log shows the CLI being
  // spawned for unrelated directories every few seconds (/home/deli, then one
  // repo, then another), and every such spawn ran
  //     S.turnStartTree = null; S.turnCount = 0; S.gen += 1;
  // So a snapshot taken for the repo on screen was erased - or attributed to
  // /home/deli - within a second or two, currentSnapshot's `S.cwd !== cwd` test
  // then failed, the plan came back null, and the call fell through to the
  // STOCK working-tree view. Nothing logged, so the pass-through was invisible.
  //
  // Now: ONE ENTRY PER RESOLVED REPO CWD, and the cwd a turn is credited to is
  // the one CAPTURED AT SPAWN TIME in that child's own closure - never the
  // global S.cwd, which does not track the visible session.
  //
  // The entry also carries `observed`: this cwd is one OUR OWN spawn hook saw a
  // CLI session in. That is the trust signal computeFilePlan binds to (see its
  // TRUSTED CWD note) - previously "the single most recent spawn", which is
  // exactly the accidental narrowness that broke turn mode.
  //
  // BOUNDED: LRU over MAX_TURN_REPOS entries, so neither the snapshot map nor
  // the observed-cwd set can grow without limit. Eviction only degrades a repo
  // to the stock view.
  var MAX_TURN_REPOS = 8;
  var turnSnapshots = Object.create(null);   // cwd -> {tree, gen, turns, at, observed}
  var turnOrder = [];                        // LRU: least-recently-used first

  function turnEntry(cwd) {
    if (!isNonEmptyString(cwd)) return null;
    return Object.prototype.hasOwnProperty.call(turnSnapshots, cwd) ? turnSnapshots[cwd] : null;
  }
  function touchTurnRepo(cwd) {
    var i = turnOrder.indexOf(cwd);
    if (i !== -1) turnOrder.splice(i, 1);
    turnOrder.push(cwd);
  }
  function ensureTurnEntry(cwd) {
    var e = turnEntry(cwd);
    if (!e) {
      e = { tree: null, gen: 0, turns: 0, at: 0, observed: false };
      turnSnapshots[cwd] = e;
    }
    touchTurnRepo(cwd);
    while (turnOrder.length > MAX_TURN_REPOS) {
      var victim = turnOrder.shift();
      if (victim !== cwd) delete turnSnapshots[victim];
    }
    return e;
  }
  function turnTreeFor(cwd) {
    var e = turnEntry(cwd);
    if (!e || !isNonEmptyString(e.tree)) return null;
    touchTurnRepo(cwd);            // a repo being displayed is recently used
    return e.tree;
  }
  function markObservedCwd(cwd) {
    if (!isNonEmptyString(cwd)) return;
    ensureTurnEntry(cwd).observed = true;
  }
  function isObservedCwd(cwd) {
    var e = turnEntry(cwd);
    return !!(e && e.observed === true);
  }

  // ---- "is this cwd inside a git work tree?" (cached per cwd) ----------------
  // The CLI is spawned for plain directories too (/home/deli, constantly, in
  // the live log). A turn boundary recorded there used to create state and log
  // `turn snapshot failed: ... not a git repository` on every single turn.
  // Non-repo spawns are now ignored outright and the verdict is cached, so the
  // probe costs one `git rev-parse` per distinct directory.
  var repoState = Object.create(null);       // cwd -> true | false
  var repoInFlight = Object.create(null);    // cwd -> [cb]

  // Synchronous read of the cache: true / false / null ("not probed yet").
  function knownRepoState(cwd) {
    if (!isNonEmptyString(cwd)) return false;
    if (Object.prototype.hasOwnProperty.call(repoState, cwd)) return repoState[cwd];
    return null;
  }
  function isInsideWorkTree(cwd, cb) {
    if (!isNonEmptyString(cwd)) return cb(false);
    var known = knownRepoState(cwd);
    if (known !== null) return cb(known);
    if (repoInFlight[cwd]) { repoInFlight[cwd].push(cb); return; }
    repoInFlight[cwd] = [cb];
    git(["rev-parse", "--is-inside-work-tree"], cwd, null, function (err, out) {
      var inside = !err && String(out || "").trim() === "true";
      repoState[cwd] = inside;
      var waiting = repoInFlight[cwd] || [];
      delete repoInFlight[cwd];
      for (var i = 0; i < waiting.length; i++) { try { waiting[i](inside); } catch (e) {} }
    });
  }
  // Fire-and-forget so a LATER synchronous reason check can say "not a git
  // repo" instead of something vaguer. Never blocks the intercept path.
  function primeRepoState(cwd) {
    if (isNonEmptyString(cwd) && knownRepoState(cwd) === null) {
      isInsideWorkTree(cwd, function () {});
    }
  }

  // The mode as it will ACTUALLY be applied to the panel that is fetching now.
  // A mode bound to a different repo is inert, so reporting S.mode verbatim to
  // the page would make a freshly mounted dropdown lie. cdb-diff:state returns
  // THIS, and the page sets the <select> value from it.
  function effectiveMode() {
    if (!prefEnabled) return MODES.WORKING;
    if (S.mode === MODES.WORKING) return MODES.WORKING;
    if (!isNonEmptyString(S.modeCwd)) return MODES.WORKING;
    if (isNonEmptyString(S.diffCwd) && S.diffCwd !== S.modeCwd) return MODES.WORKING;
    // ARMED, OR NOT AT ALL (2026-07-31 review). All four channels now require
    // the cwd our own spawn hook observed, so a mode bound to an unobserved repo
    // rewrites NOTHING. Reporting it verbatim would leave the dropdown saying
    // "Branch changes" above an untouched stock working-tree panel - the same
    // mismatch the shared cwd binding exists to prevent, just moved into the UI.
    // The live case is flipping the switch on mid-session: the session spawned
    // while the feature was off, so nothing observed it, and the next user turn
    // in that repo is what arms it.
    if (!isObservedCwd(S.modeCwd)) return MODES.WORKING;
    return S.mode;
  }

  // SPAWN MATCHER (anchors doc §SPAWN, Claude Desktop 1.24012.9, 2026-07-31):
  // verified via bundle + live process tree that the Code-tab CLI child is
  // created via child_process.spawn (NOT utilityProcess.fork). The argv pair
  // "--output-format","stream-json" + "--input-format","stream-json" is
  // distinctive - no other spawn/fork call site in the bundle shares it.
  function hasAdjacentFlagPair(args, flag) {
    for (var i = 0; i < args.length - 1; i++) {
      if (args[i] === flag && args[i + 1] === "stream-json") return true;
    }
    return false;
  }
  function looksLikeCliSpawn(_cmdOrModule, args) {
    if (!Array.isArray(args)) return false;
    return hasAdjacentFlagPair(args, "--output-format") && hasAdjacentFlagPair(args, "--input-format");
  }
  // TURN MATCHER (anchors doc §TURN). Mirrors the bundle's own string-level
  // predicate (`function KO`, byte ~933354 of the 1.24012.9 bundle) plus its
  // per-record companion `df`: a bare '"type":"user"' check also matches
  // tool-result echoes (tool results are type:"user" too), so tool_result /
  // isMeta / isCompactSummary lines are excluded. Both compact and
  // spaced-colon forms are checked, exactly as the bundle does.
  //
  // RE-VERIFIED AGAINST THE BUNDLE 2026-07-31 (turn detection was suspected of
  // never firing; it does fire - the pass-through had a different cause):
  //   - There is exactly ONE `--input-format","stream-json"` argv site. Its
  //     transport spawns with stdio ["pipe","pipe","pipe"], so child.stdin
  //     exists synchronously when our spawn hook runs.
  //   - The ONLY writer is that transport's `write(t)`, doing a bare
  //     `this.processStdin.write(t)` on a string - no Transform, no cork, no
  //     pipe() into stdin, and the stream is never swapped on a live child.
  //     `processStdin` is a plain value copy of `child.stdin`, which is why we
  //     wrap the STREAM OBJECT (not the child property) - the copy then points
  //     at the already-wrapped stream.
  //   - Frames are serialized with JSON.stringify and NO space argument, so the
  //     literal is the compact `"type":"user"` and `type` is the first key.
  //   - `isMeta` and `isCompactSummary` are NEVER set on outbound frames (they
  //     only appear in inbound transcript-reading code), so those exclusions can
  //     never cause a false negative.
  //   - Outbound user frames DO carry `parent_tool_use_id:null` on every turn -
  //     that must not be treated as a tool result.
  //
  // isSynthetic ADDED for the same reason isMeta is excluded: the bundle injects
  // `{type:"user", ..., isSynthetic:true}` notification frames, and a synthetic
  // injection is not a user turn - letting one move the turn boundary would make
  // "Latest turn" silently show an empty diff.
  //
  // KNOWN LIMITATION (documented, not a bug): an SSH-backed session replaces the
  // spawn with the transport's own `spawnClaudeCodeProcess`, whose stdin is a
  // PassThrough forwarded over RPC - no child_process.spawn happens, so our hook
  // never sees it and turn mode simply stays unavailable there (state() reports
  // hasTurnSnapshot:false and the page disables the option).
  function looksLikeUserTurn(chunk) {
    var s = String(chunk);
    var hasUserType = s.indexOf('"type":"user"') !== -1 || s.indexOf('"type": "user"') !== -1;
    if (!hasUserType) return false;
    if (s.indexOf('"tool_result"') !== -1) return false;
    if (s.indexOf('"isMeta":true') !== -1 || s.indexOf('"isMeta": true') !== -1) return false;
    if (s.indexOf('"isCompactSummary":true') !== -1 || s.indexOf('"isCompactSummary": true') !== -1) return false;
    if (s.indexOf('"isSynthetic":true') !== -1 || s.indexOf('"isSynthetic": true') !== -1) return false;
    return true;
  }

  // NON-REPO SPAWNS ARE IGNORED (2026-07-31). The live log is full of
  // `session cwd=/home/deli` followed by `turn snapshot failed: ... not a git
  // repository`: the CLI is spawned for the home directory and for background
  // sessions constantly. Recording anything for those directories is pure
  // noise, and under the old single-slot design it actively clobbered the
  // snapshot of the repo the user was looking at.
  function onSessionSpawn(cwd) {
    if (!cwd) return;
    // Opt-in feature switched off: record nothing and probe nothing. The probe is
    // a `git rev-parse` per directory, and the CLI is spawned constantly - none of
    // it is work anyone can read while the dropdown does not exist.
    if (!prefEnabled) return;
    isInsideWorkTree(cwd, function (inRepo) {
      if (!inRepo) {
        logOnce("non-repo-spawn", cwd, "ignoring spawn in " + cwd +
          " - not inside a git work tree (no turn boundary is recorded there)");
        return;
      }
      // A NEW SESSION IN A KNOWN REPO NO LONGER DISCARDS THAT REPO'S SNAPSHOT.
      // The old code reset the slot on every spawn, which is precisely how the
      // churn erased good snapshots. Per-repo entries survive; only a newer
      // turn IN THE SAME REPO supersedes one.
      markObservedCwd(cwd);
      if (S.cwd !== cwd) log("session cwd=" + cwd);
      S.cwd = cwd;
    });
  }

  // `cwd` is the directory captured when THIS child was spawned - the child's
  // own repo. Never S.cwd: that global follows the most recent spawn anywhere
  // in the app and is exactly what misattributed snapshots before.
  function onUserTurn(cwd) {
    if (!isNonEmptyString(cwd)) return;
    // Switched off: no snapshot. Deliberately checked HERE rather than by skipping
    // the stdin hook, so that enabling the switch mid-session starts recording at
    // the very next user turn - the hook is already in place on children that were
    // spawned while the feature was off.
    if (!prefEnabled) return;
    isInsideWorkTree(cwd, function (inRepo) {
      if (!inRepo) return;                      // /home/deli churn: ignored
      var entry = ensureTurnEntry(cwd);
      entry.observed = true;
      entry.turns += 1;
      entry.gen += 1;
      var gen = entry.gen;
      snapshotTree(cwd, function (err, tree) {
        if (err) { log("turn snapshot failed for " + cwd + ": " + err); return; }
        // STALENESS GUARD, PER ENTRY. Two independent things are checked, and
        // both matter:
        //   live !== entry   the entry was evicted (LRU) and recreated while we
        //                    were in flight - this snapshot belongs to a dead
        //                    object and must not be resurrected.
        //   live.gen !== gen a NEWER turn in the SAME repo already superseded us.
        // Because the map is re-read BY CWD rather than closed over, a late
        // completion can never write into another repo's entry either.
        var live = turnEntry(cwd);
        if (!live || live !== entry || live.gen !== gen) {
          log("discarding stale turn snapshot for " + cwd + " (superseded while in flight)");
          return;
        }
        live.tree = tree;
        live.at = Date.now();
        touchTurnRepo(cwd);
        log("turn snapshot recorded for " + cwd + " tree=" +
          String(tree).slice(0, 12) + " (turn #" + live.turns + ")");
      });
    });
  }

  // TURN-BOUNDARY DETECTION - one bounded diagnostic per cwd, so the NEXT live
  // log can distinguish the three failure shapes without another round:
  //   "turn-boundary hook installed" absent  -> the child has no stdin, or the
  //                                            CLI is not spawned the way we think
  //   installed but no "first CLI stdin write" -> the writes go somewhere else
  //   write seen with matchedUserTurn=no only  -> the MATCHER is wrong
  //   "turn snapshot recorded" present         -> detection works end to end
  // Wrap ONE stream object. Marked so a re-wrap (see the stdin accessor below)
  // cannot stack wrappers on the same stream.
  function wrapTurnStream(stream, cwd) {
    if (!stream || typeof stream.write !== "function") return false;
    if (stream.__cdbDvTurnHooked) return true;
    stream.__cdbDvTurnHooked = true;
    var w = stream.write;
    stream.write = function (chunk) {
      try {
        var matched = looksLikeUserTurn(chunk);
        logOnce("stdin-write", cwd,
          "first CLI stdin write for " + cwd + " matchedUserTurn=" + (matched ? "yes" : "no"));
        if (matched) onUserTurn(cwd);
      } catch (e) {}
      return w.apply(this, arguments);
    };
    return true;
  }

  // STREAM-SWAP HARDENING: the hook used to grab child.stdin once, at creation.
  // If a future release replaced that stream (a Transform in front of the pipe,
  // a lazily created stdio slot), the wrapper would sit on an orphan and turn
  // detection would silently never fire. An accessor re-wraps on assignment.
  function hookChildStdin(child, cwd) {
    try {
      if (!child) return;
      var current = child.stdin;
      var hooked = wrapTurnStream(current, cwd);
      try {
        Object.defineProperty(child, "stdin", {
          configurable: true, enumerable: true,
          get: function () { return current; },
          set: function (v) { current = v; wrapTurnStream(v, cwd); }
        });
      } catch (e) {}
      if (hooked) {
        logOnce("stdin-hook", cwd,
          "turn-boundary hook installed on the CLI child's stdin (cwd=" + cwd + ")");
      }
    } catch (e) {}
  }

  // Runtime hooks: stable Node/Electron APIs, immune to re-minification.
  (function installSpawnHooks() {
    var origSpawn = _cp.spawn;
    _cp.spawn = function (cmd, args, opts) {
      var child = origSpawn.apply(this, arguments);
      try {
        if (Array.isArray(args) && opts && opts.cwd && looksLikeCliSpawn(cmd, args)) {
          var spawnCwd = String(opts.cwd);
          onSessionSpawn(spawnCwd);
          // The cwd is captured HERE, in this child's own closure - turns are
          // credited to the repo the child actually runs in, not to S.cwd.
          hookChildStdin(child, spawnCwd);
        }
      } catch (e) {}
      return child;
    };
    // Defensive only: anchors doc confirmed the Code-tab CLI child is spawned
    // via child_process.spawn, not utilityProcess.fork, in this version. Kept
    // in case a future upstream release switches transports.
    try {
      var up = _electron.utilityProcess;
      if (up && typeof up.fork === "function") {
        var origFork = up.fork;
        up.fork = function (modulePath, args, opts) {
          var child = origFork.apply(this, arguments);
          try {
            if (looksLikeCliSpawn(modulePath, args) && opts && opts.cwd) {
              var forkCwd = String(opts.cwd);
              onSessionSpawn(forkCwd);
              var pm = child.postMessage;
              if (typeof pm === "function") {
                child.postMessage = function (msg) {
                  try { if (looksLikeUserTurn(JSON.stringify(msg))) onUserTurn(forkCwd); } catch (e) {}
                  return pm.apply(this, arguments);
                };
              }
              hookChildStdin(child, forkCwd);
            }
          } catch (e) {}
          return child;
        };
      }
    } catch (e) {}
  })();

  // ---- git ------------------------------------------------------------------
  //
  // A TRUNCATED PAYLOAD IS AN ERROR, NEVER A RESULT (2026-07-31 review).
  // The 2 MiB cap stays (it is in the spec), but the way it is enforced is a
  // SIGTERM in the middle of the stream: what we hold afterwards is a PREFIX of
  // git's real output. Handing that back as a normal success let
  // computeFilePatch serve a patch that stops mid-hunk, and computeFileContent
  // serve half a file, with nothing anywhere saying so. The cap therefore
  // surfaces as an ordinary error string, which every caller already handles by
  // falling through to the original (stock) handler - the same
  // reject-and-degrade posture the rest of this file uses.
  var TRUNCATED_MARK = "output exceeded the " + MAX_DIFF_BYTES + "-byte cap (truncated)";
  function isTruncationError(e) {
    return typeof e === "string" && e.indexOf(TRUNCATED_MARK) === 0;
  }

  // spawn-based collector: manual cap => clean truncation semantics.
  function git(args, cwd, extraEnv, cb) {
    var out = [], outLen = 0, errBuf = "", truncated = false, done = false;
    var env = Object.assign({}, process.env, extraEnv || {});
    var child;
    try { child = _cp.spawn("git", args, { cwd: cwd, env: env, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { return cb(String(e && e.message || e)); }
    var timer = setTimeout(function () { try { child.kill("SIGKILL"); } catch (e) {} }, GIT_TIMEOUT_MS);
    child.stdout.on("data", function (d) {
      if (truncated) return;
      outLen += d.length;
      if (outLen > MAX_DIFF_BYTES) { truncated = true; try { child.kill("SIGTERM"); } catch (e) {} }
      out.push(d);
    });
    child.stderr.on("data", function (d) { if (errBuf.length < 4096) errBuf += d; });
    child.on("error", function (e) { if (!done) { done = true; clearTimeout(timer); cb(String(e.message || e)); } });
    child.on("close", function (code) {
      if (done) return; done = true; clearTimeout(timer);
      // Truncation is checked FIRST and unconditionally: a SIGTERMed git also
      // exits non-zero, and the reason we must report is the cap, not the code.
      if (truncated) return cb(TRUNCATED_MARK + ": git " + args[0] + " in " + cwd);
      if (code !== 0) return cb("git " + args[0] + " exited " + code + ": " + errBuf.trim());
      cb(null, Buffer.concat(out).toString("utf8"));
    });
  }

  var idxSeq = 0;
  function snapshotTree(cwd, cb) {
    var idx = _path.join(_os.tmpdir(), "cdb-dv-idx-" + process.pid + "-" + (++idxSeq));
    var env = { GIT_INDEX_FILE: idx };
    function fin(err, tree) { _fs.unlink(idx, function () {}); cb(err, tree); }
    git(["read-tree", "HEAD"], cwd, env, function (err) {
      function addWrite() {
        git(["add", "-A"], cwd, env, function (err2) {
          if (err2) return fin("add -A: " + err2);
          git(["write-tree"], cwd, env, function (err3, sha) {
            if (err3) return fin("write-tree: " + err3);
            fin(null, sha.trim());
          });
        });
      }
      if (err) git(["read-tree", "--empty"], cwd, env, function (err1) {
        if (err1) return fin("read-tree: " + err1); addWrite();
      });
      else addWrite();
    });
  }

  // ---- branch-mode ref resolution -------------------------------------------
  //
  // ROOT CAUSE THIS EXISTS TO FIX (2026-07-31, live "No changes to show"):
  // Branch mode used to keep the SPA's symbolic base ("master") and set
  // head = "HEAD". Upstream then resolved those itself, and its HEAD resolver
  // PREFERS A REMOTE REF. Verified in tmp/staged-index.js (1.24012.9):
  //
  //   async function jt(t,e,r){ if(!e||e.startsWith("-")) throw ...;
  //     try{ await t.run(["rev-parse","--verify",`origin/${e}`],r); return `origin/${e}` }catch{}
  //     await t.run(["rev-parse","--verify",e],r); return e }
  //
  // `git rev-parse --verify origin/HEAD` SUCCEEDS in any clone with a remote
  // (origin/HEAD is a symref to the remote default branch), so resolvedHead
  // became "origin/HEAD" - i.e. origin/master - the very commit the base
  // resolves to. Its sibling base resolver (ht) prefers origin/<base> the same
  // way, so with base "master" upstream ended up computing
  //   mergeBase = merge-base(origin/master, origin/HEAD) = origin/master
  //   diff mergeBase..resolvedHead = diff X..X = EMPTY
  // which is exactly the `files=0 patches=true` lines in main.log. Reproduced
  // in this repo: symbolic refs -> 0 files, resolved shas -> 5 files.
  //
  // THE FIX: resolve both refs to 40-hex OBJECT SHAS ourselves and pass those.
  // `git rev-parse --verify origin/<40-hex>` fails ("Needed a single revision"),
  // so ht/jt both fall through to their second branch and return our sha
  // verbatim - no remote-ref substitution is possible any more. This also makes
  // us consistent with the per-file channels, which upstream already calls with
  // a resolved sha.
  //
  // DO NOT "simplify" this back to passing the string "HEAD".
  //
  // WHERE THIS GIT RUNS: the cwd is the one the intercepted call named, and
  // planIntercept only gets here once that cwd equals S.modeCwd (the repo the
  // user's mode selection is bound to). These are read-only plumbing queries
  // with a fixed argv, and their OUTPUT is consumed only by upstream's own
  // handler - which re-applies its own trusted-cwd gate - so nothing here can
  // surface data the stock view would not have served. (Contrast
  // computeFilePlan, where WE return the content and the stricter
  // snap.cwd === args[0] binding is therefore mandatory.)

  var HEX40 = /^[0-9a-f]{40}$/;
  // Object ids as git prints them: 40 hex in a sha1 repo, 64 in a sha256 one.
  var SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
  // Ref-name whitelist. `git check-ref-format` rejects every character missing
  // here, so nothing that could have resolved is lost by being strict.
  var REF_NAME_RE = /^[A-Za-z0-9._\/@+-]+$/;

  // ---- ARGV-INJECTION GUARDS (2026-07-31 review) -----------------------------
  //
  // git accepts option-shaped values ANYWHERE before the `--` separator, so a
  // "ref" of `--output=/home/me/pwned` turns a read-only `git diff` into a FILE
  // WRITE. Every ref that reaches OUR OWN argv must therefore be validated, not
  // merely checked for being a non-empty string - and several of them come
  // straight from the renderer, which is remote claude.ai code:
  //
  //   args[1] of getGitDiffFilePatch / getDiffFileContent  -> our `git diff` and
  //           `git show` (computeFilePlan / computeFilePatch / showFile)
  //   args[1] of getGitDiff / getGitDiffStats              -> our ref resolvers
  //           (resolveBaseRefLikeUpstream) before it goes back to upstream
  //   args[2]/args[3] filePath / prevFilePath              -> our pathspecs, and
  //           concatenated into `git show <ref>:<path>`
  //
  // POSTURE, everywhere: REJECT -> return null -> the ORIGINAL handler runs, so
  // the panel degrades to the stock view. Never sanitise, never repair, never
  // "fix up" a suspicious value - a rewritten ref would produce a diff nobody
  // asked for, which is its own kind of wrong answer.
  function isShaRef(v) { return typeof v === "string" && SHA_RE.test(v); }

  // A ref NAME we are willing to place in our argv (`main`, `origin/main`,
  // `refs/heads/x`, a sha). Rejects leading "-", `..` ranges and anything
  // outside the whitelist.
  function isSafeRefName(v) {
    if (!isNonEmptyString(v) || v.charAt(0) === "-") return false;
    if (v.indexOf("..") !== -1) return false;
    return REF_NAME_RE.test(v);
  }

  // The only two ref shapes our own git invocations ever need: a resolved object
  // id, or the literal "HEAD" (see the note in computeFilePlan).
  function isSafeOwnRef(v) { return v === "HEAD" || isShaRef(v); }

  // A repo-relative path we are willing to put in a pathspec AND to concatenate
  // into `git show <ref>:<path>`. Pathspecs sit after `--` so they cannot inject
  // an option, but the `<ref>:<path>` form has no separator at all, so the same
  // guard covers both call sites.
  function isSafeRelPath(p) {
    if (!isNonEmptyString(p)) return false;
    if (p.charAt(0) === "-" || p.charAt(0) === "/") return false;
    // A NUL cannot survive an argv element and a newline in a path is
    // pathological; spaces are deliberately ALLOWED, because "my notes.md" is an
    // ordinary tracked file and rejecting it would drop that one file back to the
    // stock view while the rest of the list stayed in branch scope.
    if (p.indexOf("\u0000") !== -1 || p.indexOf("\n") !== -1) return false;
    var parts = p.split("/");
    for (var i = 0; i < parts.length; i++) { if (parts[i] === "..") return false; }
    return true;
  }

  // Mirror of upstream's base resolver (ht) so our merge-base is computed
  // against the SAME ref the stock panel would have used - origin/<base> first,
  // then <base>. Flag-like refs are rejected, as upstream does; we additionally
  // hold the ref to the name whitelist above, because unlike upstream we splice
  // it into an `origin/<base>` argument of our own.
  function resolveBaseRefLikeUpstream(cwd, base, cb) {
    if (!isSafeRefName(base)) return cb(null);
    git(["rev-parse", "--verify", "--quiet", "origin/" + base], cwd, null, function (e1, out1) {
      if (!e1 && String(out1 || "").trim()) return cb("origin/" + base);
      git(["rev-parse", "--verify", "--quiet", base], cwd, null, function (e2, out2) {
        if (!e2 && String(out2 || "").trim()) return cb(base);
        cb(null);
      });
    });
  }

  // cb({branchBase, branchHead, baseRef}) on success, cb(null, why) otherwise.
  // Both returned refs are 40-hex shas; anything else is a failure, so a
  // half-resolved state can never reach the rewrite.
  function resolveBranchRefs(cwd, base, cb) {
    resolveBaseRefLikeUpstream(cwd, base, function (baseRef) {
      if (!baseRef) return cb(null, "base ref '" + base + "' does not resolve");
      git(["rev-parse", "--verify", "HEAD"], cwd, null, function (e1, headOut) {
        if (e1) return cb(null, "HEAD does not resolve: " + e1);
        var head = String(headOut || "").trim();
        if (!HEX40.test(head)) return cb(null, "HEAD did not resolve to a sha: " + head);
        git(["merge-base", baseRef, head], cwd, null, function (e2, mbOut) {
          if (e2) return cb(null, "merge-base " + baseRef + " HEAD failed: " + e2);
          var mb = String(mbOut || "").trim();
          if (!HEX40.test(mb)) return cb(null, "merge-base did not yield a sha: " + mb);
          cb({ branchBase: mb, branchHead: head, baseRef: baseRef });
        });
      });
    });
  }

  // Retained from the pre-pivot design: the diff refs now come from the SPA's
  // own arguments, so this is no longer on the diff path - it feeds the
  // baseRef field of cdb-diff:state, which is what the field needs to sanity
  // check "which branch is Branch mode comparing against?".
  function resolveBase(cwd, cb) {
    git(["rev-parse", "--abbrev-ref", "origin/HEAD"], cwd, null, function (err, out) {
      if (!err && out.trim()) return cb(out.trim());
      git(["rev-parse", "--verify", "--quiet", "refs/heads/main"], cwd, null, function (e2) {
        if (!e2) return cb("main");
        git(["rev-parse", "--verify", "--quiet", "refs/heads/master"], cwd, null, function (e3) {
          cb(e3 ? null : "master");
        });
      });
    });
  }

  // ---- SMART BASE BRANCH DETECTION ------------------------------------------
  //
  // PROBLEM THIS EXISTS TO FIX (2026-07-31, user-reported live):
  // upstream picks the diff base ITSELF and gets it wrong for any branch that
  // was not cut from the repo's mainline. The base it uses is
  // getGitInfo().defaultBranch, which is nothing but the REMOTE's default
  // branch - verified in the 1.24012.9 bundle's fetchGitInfoUncached:
  //
  //   symbolic-ref --short refs/remotes/origin/HEAD  ->  "origin/<name>"
  //   (and, when there is no origin/HEAD, a "main" then "master" probe)
  //
  // Real reported case: a branch cut from `master` in a repo whose origin/HEAD
  // is `develop`. When master carries commits develop does not have yet,
  // merge-base(develop, HEAD) is an OLDER ancestor than the true fork point, so
  // the panel shows every file master gained since develop last merged on top of
  // the branch's own work. The breadcrumb compounded it by reading
  // "develop -> <branch>", naming a base we were not usefully diffing against.
  //
  // DETECTION IS CONVENTION-AGNOSTIC. This is a public package, so no repo- or
  // employer-specific branch names appear here. The candidate set is bounded and
  // generic: the repository's own origin/HEAD default, the four generic mainline
  // names below, and the current branch's own tracking ref. The winner is the
  // candidate with the FEWEST commits in <candidate>..HEAD, i.e. the CLOSEST
  // fork point - the branch we most likely branched from.
  //
  // ESCAPE HATCH - pin a base per branch, no rebuild and no restart needed:
  //
  //     git config branch.<branch-name>.cdbBaseBranch <ref>
  //
  // This is the ONLY override key, and it wins OUTRIGHT over auto-detection: an
  // explicit pin is never second-guessed by a heuristic. Unset it to go back to
  // auto-detection:
  //
  //     git config --unset branch.<branch-name>.cdbBaseBranch
  //
  // PRIORITY: config override -> auto-detect -> upstream's own base argument.
  //
  // NOT honoured: `branch.<name>.gh-merge-base`. It was read as a second override
  // key for one round and has been removed. `gh` writes a merge-base COMMIT ID
  // there, not a base ref, so it would put a 40-hex sha into the field the
  // breadcrumb renders as a branch name - and `gh` does not invalidate that cache
  // across a rebase, so a stale entry would have beaten our own (correct)
  // detection. Auto-detection already finds the fork point `gh` cached.

  // Generic mainline names, most-plausible first. Deliberately short and
  // convention-agnostic - see the note above about this being a public package.
  var MAINLINE_CANDIDATES = ["main", "master", "develop", "trunk"];
  // Deterministic tie-break among candidates with EQUAL ahead-counts, applied
  // after "is this the origin/HEAD default?". Note this is NOT the same order as
  // MAINLINE_CANDIDATES: on a tie a `trunk` checkout is a stronger mainline
  // signal than `develop`, which is conventionally an integration branch.
  var TIEBREAK_ORDER = ["main", "master", "trunk", "develop"];
  // Coalesces the HEAD/branch probe for the burst of channels the SPA fires at
  // once (getGitInfo + getGitDiff + getGitDiffStats). Invalidation itself is
  // driven by HEAD/branch CHANGES, not by this window - it only skips the probe
  // for calls arriving within a couple of seconds of the last one.
  var BASE_PROBE_COALESCE_MS = 2000;

  function indexOfName(list, name) {
    for (var i = 0; i < list.length; i++) if (list[i] === name) return i;
    return -1;
  }

  // PURE. Rank for the documented tie-break; unknown names sort last.
  function tiebreakRank(name) {
    var i = indexOfName(TIEBREAK_ORDER, name);
    return i === -1 ? TIEBREAK_ORDER.length : i;
  }

  // PURE. "origin/develop" -> "develop". ANY OTHER remote prefix is left alone
  // on purpose: resolveRefWithSha probes origin/<name> first and then <name>, so
  // "upstream/main" resolves correctly as-is, whereas an unstripped
  // "origin/develop" would be probed as "origin/origin/develop" and miss.
  function stripOriginPrefix(ref) {
    if (!isNonEmptyString(ref)) return null;
    return ref.indexOf("origin/") === 0 ? ref.slice(7) : ref;
  }

  // PURE. The bounded candidate NAME list, in priority order.
  // Excluded: empty/flag-like names, the literal "HEAD" (never a fork point we
  // can reason about), and the CURRENT branch - which is what the tracking ref
  // normally strips down to (origin/<current> -> <current>), so a pushed branch
  // cannot be nominated as its own base.
  //
  // NOT excluded: a candidate whose sha equals HEAD's. That is the legitimate
  // "branch just cut, no commits yet" case - ahead=0, the smallest possible
  // count, and exactly the right answer. Filtering by sha would throw it away.
  function buildBaseCandidateNames(defaultBranch, trackingRef, currentBranch) {
    var out = [];
    function add(n) {
      if (!isNonEmptyString(n)) return;
      if (n.charAt(0) === "-") return;                 // flag-like, as upstream rejects
      if (n === "HEAD") return;
      if (isNonEmptyString(currentBranch) && n === currentBranch) return;
      if (indexOfName(out, n) !== -1) return;
      out.push(n);
    }
    add(defaultBranch);
    for (var i = 0; i < MAINLINE_CANDIDATES.length; i++) add(MAINLINE_CANDIDATES[i]);
    add(stripOriginPrefix(trackingRef));
    return out;
  }

  // PURE. Drop candidates that resolved to the SAME commit, keeping the
  // highest-priority (earliest) name - e.g. a repo where `main` and `master`
  // are the same ref, or where origin/HEAD already named a mainline candidate.
  // Deduping by RESOLVED SHA rather than by name is what makes that work.
  function dedupeCandidatesBySha(resolved) {
    var out = [];
    var seen = Object.create(null);
    for (var i = 0; i < resolved.length; i++) {
      var c = resolved[i];
      if (!c || !isNonEmptyString(c.name) || !isNonEmptyString(c.sha)) continue;
      if (seen[c.sha]) continue;
      seen[c.sha] = true;
      out.push(c);
    }
    return out;
  }

  // PURE. Is candidate `a` a better base than `b`? Smallest ahead-count wins
  // (closest fork point). Ties break deterministically, in this order:
  // the origin/HEAD default, then main, master, trunk, develop, then
  // alphabetical - so the same repo always yields the same answer.
  function baseCandidateBetter(a, b) {
    if (a.ahead !== b.ahead) return a.ahead < b.ahead;
    if (!!a.isDefault !== !!b.isDefault) return !!a.isDefault;
    var ra = tiebreakRank(a.name), rb = tiebreakRank(b.name);
    if (ra !== rb) return ra < rb;
    return a.name < b.name;
  }

  // PURE. The winning candidate, or null when nothing scored.
  function pickClosestBase(scored) {
    var best = null;
    for (var i = 0; i < scored.length; i++) {
      var c = scored[i];
      if (!c || !isNonEmptyString(c.name) || !isNonEmptyString(c.sha)) continue;
      if (typeof c.ahead !== "number" || !isFinite(c.ahead) || c.ahead < 0) continue;
      if (best === null || baseCandidateBetter(c, best)) best = c;
    }
    return best;
  }

  // PURE. THE OVERRIDE GATE. Our detection runs in every mode, but replacing
  // what upstream chose is only justified when we are demonstrably better off:
  //   - nothing to beat (upstream offered no base)            -> override
  //   - the user PINNED a base via git config                 -> override
  //   - same answer as upstream                               -> leave alone
  //   - strictly FEWER commits since the fork point           -> override
  //   - equal, larger, or unknown                             -> leave alone
  // The "strictly smaller" rule is what keeps a repo where upstream is already
  // right behaving exactly like stock.
  function shouldOverrideUpstreamBase(source, ourBase, ourAhead, upstreamBase, upstreamAhead) {
    if (!isNonEmptyString(ourBase)) return false;
    if (!isNonEmptyString(upstreamBase)) return true;
    if (ourBase === upstreamBase) return false;
    if (source === "config-override") return true;
    if (typeof ourAhead !== "number" || typeof upstreamAhead !== "number") return false;
    if (!isFinite(ourAhead) || !isFinite(upstreamAhead)) return false;
    return ourAhead < upstreamAhead;
  }

  // PURE. Rewrite ONLY getGitInfo's defaultBranch, preserving the rest of the
  // object verbatim. Fails closed (returns null) on anything that would not
  // satisfy upstream's own result validator - see wrapGitInfoListener.
  function rewriteGitInfoDefaultBranch(info, base) {
    if (!info || typeof info !== "object" || Array.isArray(info)) return null;
    if (typeof info.repo !== "string" || typeof info.branch !== "string") return null;
    if (!isNonEmptyString(base) || base.charAt(0) === "-") return null;
    if (info.defaultBranch === base) return null;
    var out = {};
    for (var k in info) {
      if (Object.prototype.hasOwnProperty.call(info, k)) out[k] = info[k];
    }
    out.defaultBranch = base;
    return out;
  }

  // Trust proxy for everything this section runs. A NON-NULL result from a stock
  // LocalSessions handler proves upstream's OWN requireTrustedCwd gate passed
  // for that cwd and that it is a git repo - so we piggyback on upstream's
  // decision instead of inventing a second trust model for a renderer-supplied
  // path. Until a cwd is marked, base detection is skipped entirely and
  // everything degrades to upstream's own base choice, i.e. stock behaviour.
  var trustedCwds = Object.create(null);
  function markTrustedCwd(cwd) { if (isNonEmptyString(cwd)) trustedCwds[cwd] = true; }
  function isTrustedCwd(cwd) { return isNonEmptyString(cwd) && trustedCwds[cwd] === true; }

  // Single trimmed line of stdout, or null on any failure. Never throws.
  function gitLine(args, cwd, cb) {
    git(args, cwd, null, function (err, out) {
      if (err) return cb(null);
      var s = String(out || "").trim();
      cb(s ? s : null);
    });
  }

  // ONE spawn for both facts: `git rev-parse HEAD --abbrev-ref HEAD` prints the
  // sha then the branch name ("HEAD" when detached). Option ORDER matters -
  // --abbrev-ref only affects the arguments that FOLLOW it, so the reversed
  // form prints the abbrev-ref twice. Verified 2026-07-31.
  function readHeadState(cwd, cb) {
    gitLine(["rev-parse", "HEAD", "--abbrev-ref", "HEAD"], cwd, function (out) {
      if (!out) return cb(null);              // unborn branch, or not a repo
      var lines = out.split("\n");
      var sha = String(lines[0] || "").trim();
      var branch = String(lines[1] || "").trim();
      if (!HEX40.test(sha)) return cb(null);
      cb({ head: sha, branch: isNonEmptyString(branch) ? branch : "HEAD" });
    });
  }

  // origin-first like upstream's ht/jt, but returns the SHA out of the SAME
  // rev-parse call (--verify --quiet prints it), halving the git spawns.
  // Deliberately NOT folded into resolveBaseRefLikeUpstream: that one answers
  // "which ref would the stock panel have used?" and returns a ref NAME for the
  // merge-base path, this one answers "which object does it point at?" for base
  // detection. Two callers, two return shapes - not a duplicate to be merged.
  function resolveRefWithSha(cwd, name, cb) {
    // `name` reaches our argv both bare and as `origin/<name>`; it comes from
    // git output or from a git-config pin, but the whitelist is what makes that
    // provenance irrelevant.
    if (!isSafeRefName(name)) return cb(null);
    gitLine(["rev-parse", "--verify", "--quiet", "origin/" + name], cwd, function (s1) {
      if (s1 && HEX40.test(s1)) return cb({ ref: "origin/" + name, sha: s1 });
      gitLine(["rev-parse", "--verify", "--quiet", name], cwd, function (s2) {
        if (s2 && HEX40.test(s2)) return cb({ ref: name, sha: s2 });
        cb(null);
      });
    });
  }

  // Commits on HEAD that <sha> does not have. Identical to
  // `rev-list --count $(merge-base <sha> HEAD)..HEAD` - both count exactly the
  // commits reachable from HEAD but not from <sha> - for ONE spawn instead of
  // two. Verified side by side in a real repo (19 == 19), 2026-07-31.
  function countAhead(cwd, sha, cb) {
    // Spliced into a `<sha>..HEAD` argument of ours - object id or nothing.
    if (!isShaRef(sha)) return cb(null);
    gitLine(["rev-list", "--count", sha + "..HEAD"], cwd, function (out) {
      if (!out || !/^[0-9]+$/.test(out)) return cb(null);
      cb(parseInt(out, 10));
    });
  }

  // Sequential map that DROPS null/undefined results. Sequential on purpose:
  // these are cheap plumbing queries and a burst of parallel git spawns in a
  // large repo is worse than a few extra milliseconds.
  function mapSeries(items, iter, done) {
    var out = [];
    var i = 0;
    (function step() {
      if (i >= items.length) return done(out);
      iter(items[i++], function (r) {
        if (r !== null && r !== undefined) out.push(r);
        step();
      });
    })();
  }

  // cb(decision | null, scored). decision:
  //   {base, baseRef, sha, ahead, source, configKey?, defaultBranch}
  // where source is "config-override" | "auto". A null decision means the
  // caller must fall back to upstream's own base argument.
  function detectBase(cwd, headState, cb) {
    var branch = headState.branch;

    function auto() {
      gitLine(["rev-parse", "--abbrev-ref", "origin/HEAD"], cwd, function (defRaw) {
        var defName = stripOriginPrefix(defRaw);
        gitLine(["rev-parse", "--abbrev-ref", "@{upstream}"], cwd, function (trackRaw) {
          var names = buildBaseCandidateNames(defName, trackRaw, branch);
          mapSeries(names, function (name, next) {
            resolveRefWithSha(cwd, name, function (r) {
              if (!r) return next(null);      // keep only refs that actually resolve
              next({ name: name, ref: r.ref, sha: r.sha, isDefault: name === defName });
            });
          }, function (resolved) {
            mapSeries(dedupeCandidatesBySha(resolved), function (c, next) {
              countAhead(cwd, c.sha, function (n) {
                if (n === null) return next(null);
                c.ahead = n;
                next(c);
              });
            }, function (scored) {
              var best = pickClosestBase(scored);
              if (!best) return cb(null, scored);
              cb({ base: best.name, baseRef: best.ref, sha: best.sha, ahead: best.ahead,
                source: "auto", defaultBranch: defName }, scored);
            });
          });
        });
      });
    }

    // An explicit pin wins outright. Skipped on a detached HEAD - there is no
    // branch whose config could be read.
    if (branch === "HEAD") return auto();
    // A LIST OF ONE, kept as a loop: the ladder (try a key, fall through to the
    // next, end at auto()) is the part worth keeping - adding a second key later
    // is one array entry, and the "unresolvable pin falls back to auto" path stays
    // exercised either way.
    var keys = ["branch." + branch + ".cdbBaseBranch"];
    var ki = 0;
    (function tryKey() {
      if (ki >= keys.length) return auto();
      var key = keys[ki++];
      gitLine(["config", "--get", key], cwd, function (val) {
        var name = stripOriginPrefix(val);
        if (!isNonEmptyString(name)) return tryKey();
        resolveRefWithSha(cwd, name, function (r) {
          if (!r) {
            logOnce("config-base-unresolved", cwd + " " + key + " " + val,
              "WARNING: configured base \"" + val + "\" (" + key + ") does not resolve in " +
              cwd + " - ignoring the pin and continuing with auto-detection");
            return tryKey();
          }
          countAhead(cwd, r.sha, function (n) {
            cb({ base: name, baseRef: r.ref, sha: r.sha, ahead: (n === null ? null : n),
              source: "config-override", configKey: key, defaultBranch: null }, []);
          });
        });
      });
    })();
  }

  // ---- base decision cache + diagnostics -------------------------------------
  // Cached per (cwd, current branch), invalidated whenever the branch OR the
  // HEAD sha changes - a commit, a checkout, a rebase or a reset all move the
  // fork point, so a stale answer would be wrong rather than merely old.
  var baseCache = Object.create(null);    // cwd -> entry
  var baseInFlight = Object.create(null); // cwd -> [cb]
  function describeScored(scored) {
    var parts = [];
    for (var i = 0; i < scored.length; i++) {
      parts.push(scored[i].ref + "(" + String(scored[i].sha).slice(0, 7) +
        ",ahead=" + scored[i].ahead + ")");
    }
    return parts.length ? parts.join(" ") : "<none resolved>";
  }

  // THE line the next live test is verified from: every candidate with its
  // ahead-count, the winner, where the winner came from, and whether we
  // actually overrode upstream. One-shot per (cwd, branch) so it can never
  // spam the log, and re-fires naturally on a branch switch.
  function logBaseDecisionOnce(cwd, entry, upstreamBase, upstreamAhead, overrode) {
    var dec = entry.dec;
    logOnce("base-decision", cwd + " " + entry.branch,
      "base decision for " + cwd + " @" + entry.branch +
      ": candidates [" + describeScored(entry.scored) + "]" +
      " -> base=" + (dec ? dec.base + " (" + dec.baseRef + ", ahead=" + dec.ahead + ")" : "<none>") +
      " source=" + (dec ? dec.source : "upstream-fallback") +
      (dec && dec.configKey ? " via " + dec.configKey : "") +
      " upstreamBase=" + (isNonEmptyString(upstreamBase) ? upstreamBase : "<none>") +
      (typeof upstreamAhead === "number" ? "(ahead=" + upstreamAhead + ")" : "") +
      " overrodeUpstream=" + (overrode ? "yes" : "no"));
  }

  // Ahead-count for an ARBITRARY base name (upstream's choice), so the override
  // gate can compare like with like. Reuses an already-scored candidate when
  // possible - upstream's base is normally candidate #1 - and otherwise memoises
  // per cache entry, so the comparison costs nothing after the first call.
  function aheadOfBase(cwd, entry, name, cb) {
    if (!isNonEmptyString(name)) return cb(null);
    for (var i = 0; i < entry.scored.length; i++) {
      if (entry.scored[i].name === name || entry.scored[i].ref === name) return cb(entry.scored[i].ahead);
    }
    if (Object.prototype.hasOwnProperty.call(entry.aheadOf, name)) return cb(entry.aheadOf[name]);
    resolveRefWithSha(cwd, name, function (r) {
      if (!r) { entry.aheadOf[name] = null; return cb(null); }
      countAhead(cwd, r.sha, function (n) { entry.aheadOf[name] = n; cb(n); });
    });
  }

  function finishBaseDecision(cwd, entry, upstreamBase, cb) {
    if (!entry.dec) {
      logBaseDecisionOnce(cwd, entry, upstreamBase, null, false);
      return cb(null);
    }
    aheadOfBase(cwd, entry, upstreamBase, function (upAhead) {
      var dec = entry.dec;
      var overrode = shouldOverrideUpstreamBase(dec.source, dec.base, dec.ahead, upstreamBase, upAhead);
      logBaseDecisionOnce(cwd, entry, upstreamBase, upAhead, overrode);
      cb({
        base: dec.base, baseRef: dec.baseRef, sha: dec.sha, ahead: dec.ahead,
        source: dec.source, configKey: dec.configKey || null,
        overrode: overrode,
        upstreamBase: isNonEmptyString(upstreamBase) ? upstreamBase : null,
        upstreamAhead: (typeof upAhead === "number") ? upAhead : null
      });
    });
  }

  function newBaseEntry(headState, dec, scored) {
    return {
      branch: headState.branch, head: headState.head, ts: Date.now(),
      dec: dec || null, scored: scored || [], aheadOf: Object.create(null)
    };
  }

  /**
   * Resolve the base branch we should diff against in `cwd`.
   *
   * cb(null) means "no confident answer" - the caller MUST fall back to
   * upstream's own base argument, i.e. stock behaviour. Never throws, never
   * rejects; every git failure degrades to cb(null).
   *
   * `upstreamBase` is what the SPA/upstream chose, and is used ONLY to compute
   * the `overrode` flag (the gate in shouldOverrideUpstreamBase). Pass null
   * when there is nothing to compare against.
   */
  function resolveSmartBase(cwd, upstreamBase, cb) {
    if (!isTrustedCwd(cwd)) return cb(null);
    var hit = baseCache[cwd];
    if (hit && (Date.now() - hit.ts) < BASE_PROBE_COALESCE_MS) {
      return finishBaseDecision(cwd, hit, upstreamBase, cb);
    }
    readHeadState(cwd, function (hs) {
      if (!hs) return cb(null);
      var cur = baseCache[cwd];
      if (cur && cur.branch === hs.branch && cur.head === hs.head) {
        cur.ts = Date.now();
        return finishBaseDecision(cwd, cur, upstreamBase, cb);
      }
      // Coalesce concurrent detections for the same cwd: the SPA fires
      // getGitInfo + getGitDiff + getGitDiffStats within milliseconds of each
      // other, and detection is ~15 git spawns.
      var q = baseInFlight[cwd];
      if (q) {
        q.push(function (entry) { finishBaseDecision(cwd, entry, upstreamBase, cb); });
        return;
      }
      baseInFlight[cwd] = q = [function (entry) { finishBaseDecision(cwd, entry, upstreamBase, cb); }];
      detectBase(cwd, hs, function (dec, scored) {
        var entry = newBaseEntry(hs, dec, scored);
        baseCache[cwd] = entry;
        delete baseInFlight[cwd];
        for (var i = 0; i < q.length; i++) {
          try { q[i](entry); } catch (e) { /* one waiter must not break the rest */ }
        }
      });
    });
  }

  // ---- IPC interception ------------------------------------------------------

  var SUF_DIFF = "_LocalSessions_$_getGitDiff";
  var SUF_STATS = "_LocalSessions_$_getGitDiffStats";
  var SUF_FILE_PATCH = "_LocalSessions_$_getGitDiffFilePatch";
  var SUF_FILE_CONTENT = "_LocalSessions_$_getDiffFileContent";

  function endsWith(s, suf) {
    return typeof s === "string" && s.length >= suf.length && s.indexOf(suf, s.length - suf.length) !== -1;
  }

  // SUFFIX match - the channel literal embeds a per-release codegen UUID.
  // Order matters only for readability: endsWith is exact, and no suffix here
  // is a suffix of another ("...getGitDiff" vs "...getGitDiffStats").
  function suffixFor(channel) {
    if (endsWith(channel, SUF_STATS)) return SUF_STATS;
    if (endsWith(channel, SUF_FILE_PATCH)) return SUF_FILE_PATCH;
    if (endsWith(channel, SUF_FILE_CONTENT)) return SUF_FILE_CONTENT;
    if (endsWith(channel, SUF_DIFF)) return SUF_DIFF;
    return null;
  }

  function isNonEmptyString(v) { return typeof v === "string" && v.length > 0; }

  /**
   * PURE rewrite decision for the two whole-diff channels.
   * Returns a NEW argument array (without the event), or null to pass the call
   * through untouched. Never throws; every unexpected shape returns null.
   *
   *   mode  one of MODES (see THE MODE VOCABULARY at the top)
   *   args  [cwd, base, head?, options?]  (getGitDiff)
   *         [cwd, base, head?]            (getGitDiffStats - no options)
   *   snap  {cwd, modeCwd, turnStartTree, nowTree, branchBase, branchHead}
   *
   * Branch mode needs snap.branchBase / snap.branchHead - object ids resolved
   * by resolveBranchRefs. They are REQUIRED, not optional: passing symbolic
   * refs is what produced an empty diff upstream (see the ref-resolution block
   * above), so a snapshot without them passes the call through to the stock
   * working-tree view rather than rendering a silently-empty branch diff.
   *
   * ONE CWD PREDICATE FOR ALL FOUR CHANNELS (2026-07-31 review). This function
   * feeds the FILE LIST; computeFilePlan feeds the CONTENT of each row in it.
   * The two used to disagree: this one needed only snap.modeCwd, while
   * computeFilePlan additionally required snap.cwd (the repo our own spawn hook
   * observed). Whenever the second held and the first did not, the panel showed
   * a branch-scoped file list whose rows were filled from the stock
   * working-tree handler - mismatched data, presented as one diff. Two ways in:
   * flipping the pref on mid-session (the pref-gated spawn hook never ran, so
   * nothing was ever observed), and LRU eviction of the repo's entry between
   * the list fetch and a lazy per-file fetch. Both are closed by requiring the
   * SAME snap.cwd binding here, so the coarse channel can never run ahead of
   * the per-file one. The cost is honest and visible: until the repo is
   * observed, all four channels serve stock and effectiveMode() reports
   * "working", so the dropdown does not claim a mode that is not applied.
   */
  function computeGitArgRewrite(mode, suffix, args, snap) {
    if (mode !== MODES.BRANCH && mode !== MODES.TURN) return null;
    if (suffix !== SUF_DIFF && suffix !== SUF_STATS) return null;
    if (!Array.isArray(args) || args.length < 2) return null;
    if (!isNonEmptyString(args[0])) return null;      // cwd
    if (!isNonEmptyString(args[1])) return null;      // base
    if (args[2] !== undefined && args[2] !== null && typeof args[2] !== "string") return null;
    // TRUSTED-CWD BINDING, shared with computeFilePlan (see the note above and
    // its own SECURITY block). Required for BOTH modes, before anything else.
    if (!snap || !isNonEmptyString(snap.cwd) || snap.cwd !== args[0]) return null;
    // MODE SCOPING (do not remove): the mode belongs to exactly one repo. A
    // call about any other repo must render stock, or a mode selected in repo A
    // silently reshapes repo B's panel while B's dropdown still says
    // "Working tree" - the live desync bug this scoping exists to prevent.
    if (!isNonEmptyString(snap && snap.modeCwd) || snap.modeCwd !== args[0]) return null;

    var out = args.slice();
    if (mode === MODES.BRANCH) {
      // BOTH refs are replaced with resolved shas. Keeping the SPA's symbolic
      // base and passing head="HEAD" is what upstream collapsed to
      // origin/HEAD == origin/<base> -> empty diff. Upstream still recomputes
      // merge-base(branchBase, branchHead) from these, which is branchBase
      // itself (it is an ancestor), so the rendered range stays
      // merge-base..HEAD - it just no longer goes through a remote ref.
      if (!isShaRef(snap.branchBase) || !isShaRef(snap.branchHead)) return null;
      out[1] = snap.branchBase;
      out[2] = snap.branchHead;
    } else {
      // Turn mode needs BOTH snapshot trees. They are only meaningful for the
      // repo we snapshotted, which the shared snap.cwd binding above already
      // established.
      if (!isShaRef(snap.turnStartTree) || !isShaRef(snap.nowTree)) return null;
      out[1] = snap.turnStartTree;
      out[2] = snap.nowTree;
    }

    if (suffix === SUF_DIFF) {
      // UNDECLARED-IN-UPSTREAM CHANGE, deliberate and documented in the spec
      // addendum: we do not just retarget the refs, we also FORCE
      // options.includePatches = true even when the SPA asked for false. Why:
      // with patches inline the file list arrives complete, so the SPA makes few
      // (ideally no) lazy per-file calls - and every one of those it does make
      // is a call we have to substitute ourselves, which is the narrowest and
      // most failure-prone path in this file. Cost: a larger single IPC payload
      // for the panel. The validator accepts only {includePatches?: boolean} and
      // ignores unknown keys, so the caller's other keys are preserved as-is.
      var src = (out[3] && typeof out[3] === "object") ? out[3] : null;
      var opts = {};
      if (src) {
        for (var k in src) {
          if (Object.prototype.hasOwnProperty.call(src, k)) opts[k] = src[k];
        }
      }
      opts.includePatches = true;
      out[3] = opts;
    } else if (out.length > 3) {
      // getGitDiffStats takes no options argument - never grow its arity.
      out.length = 3;
    }
    return out;
  }

  /**
   * PURE plan for the two per-file channels, which take a single ref
   * (mergeBase) and diff it against the worktree internally - so we compute
   * the content ourselves instead of rewriting args.
   *   args [cwd, mergeBase, filePath, prevFilePath?]
   * Returns {cwd, base, head, filePath, prevFilePath} or null (pass through).
   *
   * SECURITY - RENDERER-SUPPLIED REFS AND PATHS (do not weaken):
   * args[1] (upstream's mergeBase), args[2] (filePath) and args[3]
   * (prevFilePath) all come from the renderer and all land in OUR OWN argv -
   * args[1] BEFORE the `--` separator, where git still honours options, and
   * again in `git show <ref>:<path>` where there is no separator at all. A
   * mergeBase of `--output=/home/me/x` would therefore make our read-only
   * `git diff` WRITE A FILE. args[1] must be an object id (upstream computes it
   * with `git merge-base`, so nothing else is legitimate) and the two paths must
   * pass isSafeRelPath. See ARGV-INJECTION GUARDS above.
   *
   * SECURITY - TRUSTED CWD BINDING (do not weaken):
   * a plan returned here makes US run `git diff` / `git show` in args[0], and
   * OUR substitute path never reaches the stock handlers' own requireTrustedCwd
   * gate. args[0] is renderer-supplied (remote claude.ai code), so accepting it
   * unbound would hand the page an arbitrary-local-directory git-read primitive
   * that stock does not offer. EVERY plan - branch and turn, patch and content -
   * is therefore bound to the cwd our spawn hook actually observed; anything
   * else returns null, which passes the call through to the original handler
   * where the stock trust gate applies. (Turn mode additionally needs the two
   * snapshot trees, which are only meaningful for that same repo.)
   */
  function computeFilePlan(mode, suffix, args, snap) {
    if (mode !== MODES.BRANCH && mode !== MODES.TURN) return null;
    if (suffix !== SUF_FILE_PATCH && suffix !== SUF_FILE_CONTENT) return null;
    if (!Array.isArray(args) || args.length < 3) return null;
    if (!isNonEmptyString(args[0])) return null;      // cwd
    if (!isShaRef(args[1])) return null;              // mergeBase: object id only
    if (!isSafeRelPath(args[2])) return null;         // filePath
    if (args[3] !== undefined && args[3] !== null && !isSafeRelPath(args[3])) return null;
    // Trusted-cwd binding, enforced for BOTH modes before anything else - and
    // now enforced identically by computeGitArgRewrite, so the file list and the
    // per-file content can never be served from different scopes.
    if (!snap || !isNonEmptyString(snap.cwd) || snap.cwd !== args[0]) return null;
    // Mode scoping (see computeGitArgRewrite): the mode belongs to one repo.
    // Independent of the trust binding above - that one answers "may we run git
    // here?", this one answers "does the mode apply to this panel at all?".
    if (!isNonEmptyString(snap.modeCwd) || snap.modeCwd !== args[0]) return null;

    // NOTE ON head:"HEAD" HERE (deliberate, not the bug fixed above): this ref
    // is consumed by OUR OWN `git diff` / `git show` invocations, where plain
    // "HEAD" resolves to the local branch tip. The empty-diff bug was specific
    // to upstream's jt() resolver preferring origin/<ref>; nothing on this path
    // goes through it. args[1] is upstream's own merge_base, which - now that
    // the whole-diff rewrite passes shas - is exactly our resolved branchBase,
    // so the per-file range matches the file list's range.
    var plan = {
      cwd: args[0],
      base: args[1],
      head: "HEAD",
      filePath: args[2],
      prevFilePath: isNonEmptyString(args[3]) ? args[3] : null
    };
    if (mode === MODES.TURN) {
      if (!isShaRef(snap.turnStartTree) || !isShaRef(snap.nowTree)) return null;
      plan.base = snap.turnStartTree;
      plan.head = snap.nowTree;
    } else if (isShaRef(snap.branchBase)) {
      // CONSISTENCY WITH THE FILE LIST (2026-07-31, smart base detection).
      // args[1] is upstream's own merge_base, computed from whatever base IT
      // used. Now that we choose the base ourselves, prefer OUR resolved fork
      // point: a per-file patch must never be computed against a different
      // range than the list the user is looking at - which is exactly what a
      // merge_base the SPA cached from before the override would produce.
      // args[1] remains the fallback when our resolution did not land.
      plan.base = snap.branchBase;
    }
    // FINAL GATE. Whichever of upstream's merge_base, our resolved fork point or
    // the snapshot trees we ended up with, the two refs about to be handed to
    // `git diff` / `git show` must still be an object id (or the literal
    // "HEAD"). Cheap, and it means no later edit to the arms above can reopen
    // the argv hole.
    if (!isShaRef(plan.base) || !isSafeOwnRef(plan.head)) return null;
    return plan;
  }

  // PURE. Why a BRANCH-mode substitution was refused. Turn mode has its own
  // reason ladder (turnLateRejectReason); this one exists so a refusal on the
  // branch path is never silent either - a silent one is what let a mismatched
  // panel ship unnoticed.
  function wholeDiffRefuseReason(args, snap) {
    if (!snap || !isNonEmptyString(snap.cwd) || snap.cwd !== (args && args[0])) {
      return "no CLI session has been observed in this repo yet (untrusted cwd) - " +
        "send one message in it, or reopen the session, to arm the feature";
    }
    if (!isShaRef(snap.branchBase) || !isShaRef(snap.branchHead)) {
      return "branch refs did not resolve to object ids";
    }
    return "argument shape unusable";
  }

  // PURE. Same, for the per-file channels, whose refusals additionally include
  // the two argv guards.
  function filePlanRefuseReason(args, snap) {
    if (!snap || !isNonEmptyString(snap.cwd) || snap.cwd !== (args && args[0])) {
      return "no CLI session has been observed in this repo yet (untrusted cwd)";
    }
    if (!isShaRef(args && args[1])) {
      return "the merge_base upstream sent is not an object id: " + String(args && args[1]);
    }
    if (!isSafeRelPath(args && args[2])) {
      return "unusable file path: " + String(args && args[2]);
    }
    return "resolved refs unusable";
  }

  // getGitDiffFilePatch returns a PLAIN STRING (confirmed: the inline result
  // check is `c === null || typeof c === "string"`). The sibling getGitDiff
  // returns GitHub-compare-shaped file entries whose `patch` field is hunks
  // only, so we strip everything before the first hunk header to match that
  // convention. If there is no hunk at all we return the raw output (empty
  // string for "no change in this file"), never a rejected promise.
  function stripToHunks(patch) {
    if (typeof patch !== "string" || !patch) return patch || "";
    var idx = patch.indexOf("\n@@");
    if (idx !== -1) return patch.slice(idx + 1);
    return patch.indexOf("@@") === 0 ? patch : "";
  }

  function filePathspec(plan) {
    var spec = ["--", plan.filePath];
    if (plan.prevFilePath && plan.prevFilePath !== plan.filePath) spec.push(plan.prevFilePath);
    return spec;
  }

  function computeFilePatch(plan, cb) {
    // Belt and braces: computeFilePlan already validated these, but this is the
    // function that actually builds the argv, so it re-checks rather than trust
    // a caller. A truncated patch arrives here as an ordinary error (see git())
    // and therefore degrades to the stock handler like any other failure.
    if (!isShaRef(plan.base) || !isSafeOwnRef(plan.head) || !isSafeRelPath(plan.filePath)) {
      return cb("refusing unsafe git arguments");
    }
    var args = ["diff", "--no-color", plan.base, plan.head].concat(filePathspec(plan));
    git(args, plan.cwd, null, function (err, out) {
      if (err) return cb(err);
      cb(null, stripToHunks(out));
    });
  }

  // getDiffFileContent returns {oldText: string|null, newText: string|null}
  // (confirmed validator vK). A side that does not exist in its ref is null -
  // that is exactly the added/deleted-file case, so a non-zero `git show` for
  // one side is data, not an error.
  function showFile(cwd, ref, path, cb) {
    if (!path) return cb(null, null);
    if (!isSafeOwnRef(ref) || !isSafeRelPath(path)) return cb("refusing unsafe git arguments");
    git(["show", ref + ":" + path], cwd, null, function (err, out) {
      // A NON-ZERO `git show` is DATA - that side of the file does not exist in
      // that ref, i.e. the added/deleted-file case. A TRUNCATED one is NOT:
      // reporting null for it would render a real oversized file as "absent on
      // this side", i.e. a fabricated whole-file add or delete. So truncation
      // propagates as an error and the caller falls back to stock.
      if (isTruncationError(err)) return cb(err);
      if (err) return cb(null, null);
      cb(null, out);
    });
  }

  function computeFileContent(plan, cb) {
    var oldPath = plan.prevFilePath || plan.filePath;
    // A real error from either side (only truncation and an unsafe argv produce
    // one - a missing side is data) fails the WHOLE call: serving one good half
    // next to a silently empty one is the fabricated-add/delete case again.
    showFile(plan.cwd, plan.base, oldPath, function (e1, oldText) {
      if (e1) return cb(e1);
      showFile(plan.cwd, plan.head, plan.filePath, function (e2, newText) {
        if (e2) return cb(e2);
        cb(null, { oldText: oldText === undefined ? null : oldText, newText: newText === undefined ? null : newText });
      });
    });
  }

  // Per-call async prerequisites: branch mode needs both refs resolved to shas,
  // turn mode needs a fresh "now" tree. `baseRef` is the SPA's own base
  // argument and is only available on the whole-diff channels; the per-file
  // channels pass null (they already receive a resolved sha and do not need it,
  // see the note in computeFilePlan).
  function currentSnapshot(cwd, baseRef, cb) {
    // `snap.cwd` IS THE TRUST FIELD (see computeFilePlan's TRUSTED CWD note).
    // `cwd` here is args[0] - renderer-supplied - so it is echoed into snap.cwd
    // ONLY when our own spawn hook actually observed a CLI session in it.
    // Otherwise snap.cwd stays null and every per-file plan refuses, exactly as
    // before; the only change is that "observed" is now a per-repo fact instead
    // of "the single most recent spawn anywhere in the app".
    var base = {
      cwd: isObservedCwd(cwd) ? cwd : null,
      modeCwd: S.modeCwd, turnStartTree: turnTreeFor(cwd), nowTree: null,
      branchBase: null, branchHead: null, baseRef: null
    };
    if (S.mode === MODES.BRANCH) {
      // OUR resolved base, not the SPA's. Upstream's base argument is
      // getGitInfo().defaultBranch = the REMOTE's default branch, which is
      // simply wrong for a branch cut from anywhere else (see SMART BASE BRANCH
      // DETECTION above). `baseRef` - the SPA's own argument - is only the
      // FALLBACK, and it is null on the per-file channels, which is precisely
      // why those now resolve branch refs too: computeFilePlan prefers
      // branchBase so a per-file patch is computed against exactly the range
      // the file list the user is looking at was built from.
      return resolveSmartBase(cwd, baseRef, function (dec) {
        var eff = (dec && isNonEmptyString(dec.base)) ? dec.base : baseRef;
        if (!isNonEmptyString(eff)) return cb(base);
        resolveBranchRefs(cwd, eff, function (refs, why) {
          if (!refs) {
            logOnce("branch-ref-fail", cwd + " " + eff,
              "WARNING: branch ref resolution failed in " + cwd + " (base=" + eff + "): " +
              why + " - passing through to the stock working-tree view");
            return cb(base);
          }
          base.branchBase = refs.branchBase;
          base.branchHead = refs.branchHead;
          base.baseRef = refs.baseRef;
          cb(base);
        });
      });
    }
    // Turn mode: the "before" tree is this REPO'S recorded snapshot (per-cwd
    // map - no S.cwd comparison any more, that was the misattribution bug), and
    // the "now" tree is computed on demand for the same repo. A repo with no
    // recorded turn simply has no tree, and planIntercept has already refused
    // with a logged reason before we get here.
    if (S.mode !== MODES.TURN || !isNonEmptyString(base.turnStartTree)) return cb(base);
    snapshotTree(cwd, function (err, tree) {
      if (err) { logTurnRejectOnce(cwd, "now-tree snapshot failed: " + err); return cb(base); }
      if (tree) base.nowTree = tree;
      cb(base);
    });
  }

  // ---- turn-mode rejection reasons (OBSERVABILITY) ---------------------------
  //
  // WHY THIS EXISTS: the reported bug was not that turn mode computed the wrong
  // diff - it was that the plan returned NULL and the call fell through to the
  // stock working-tree view WITHOUT LOGGING ANYTHING. "Latest turn looks exactly
  // like Working tree" was therefore unobservable from the log. Every refusal
  // now names its reason.
  //
  // PURE, so the reason selection is unit-testable.
  //   askedCwd  args[0] of the intercepted call (the panel's repo)
  //   modeCwd   the repo the mode is bound to
  //   entry     that repo's snapshot entry, or null
  //   isRepo    true | false | null (null = not probed yet)
  function turnRejectReason(askedCwd, modeCwd, entry, isRepo) {
    if (!isNonEmptyString(askedCwd)) return "no cwd in the request";
    if (isRepo === false) return "not a git repo";
    if (!isNonEmptyString(modeCwd)) return "cwd mismatch: bound=<none> asked=" + askedCwd;
    if (modeCwd !== askedCwd) return "cwd mismatch: bound=" + modeCwd + " asked=" + askedCwd;
    // `turns === 0` distinguishes "we know this repo (a session spawned here)
    // but no user turn was ever recorded in it" from "a turn WAS recorded and
    // its snapshot is missing" - the second is a failure worth chasing, the
    // first is just the honest empty state.
    if (!entry || entry.turns === 0) return "no snapshot for this repo yet";
    if (!isNonEmptyString(entry.tree)) return "snapshot tree missing";
    return null;
  }

  // PURE. Reason for a turn-mode refusal that only becomes apparent AFTER the
  // snapshot step, i.e. every pre-check in turnRejectReason already passed.
  function turnLateRejectReason(snap, askedCwd) {
    if (!snap || !isNonEmptyString(snap.cwd) || snap.cwd !== askedCwd) {
      return "no CLI session was ever observed in this repo (untrusted cwd)";
    }
    if (!isNonEmptyString(snap.turnStartTree)) return "snapshot tree missing";
    if (!isNonEmptyString(snap.nowTree)) return "could not compute the current tree";
    return "unexpected argument shape";
  }

  // One line per (cwd, reason). Bounded, and it re-fires naturally when the
  // reason changes - which is what makes a live retest self-diagnosing.
  function logTurnRejectOnce(cwd, reason) {
    logOnce("turn-reject", cwd + " " + reason,
      "turn mode unavailable for " + cwd + ": " + reason +
      " - passing through to the stock working-tree view");
  }

  var interceptedAny = false;

  function summarizeArgs(args) {
    var parts = [];
    for (var i = 0; i < args.length && i < 5; i++) {
      var a = args[i];
      if (typeof a === "string") parts.push(JSON.stringify(a.length > 120 ? a.slice(0, 120) + "…" : a));
      else if (a && typeof a === "object") { try { parts.push(JSON.stringify(a).slice(0, 160)); } catch (e) { parts.push("[object]"); } }
      else parts.push(String(a));
    }
    return parts.join(", ");
  }

  // The repo whose diff panel is on screen, learned from the fetches the panel
  // itself makes. MUST be updated in working mode too: it is what set-mode binds
  // the new mode to, and before the first switch the mode is always "working".
  // Whole-panel fetches only - the per-file calls are lazy and can trail a
  // panel the user already navigated away from.
  function noteDiffCwd(suffix, args) {
    if (suffix !== SUF_DIFF && suffix !== SUF_STATS) return;
    var cwd = args && args[0];
    if (!isNonEmptyString(cwd) || cwd === S.diffCwd) return;
    S.diffCwd = cwd;
  }

  function logFailOnce(suffix, what) {
    logOnce("intercept-fail", suffix,
      "intercept failed for " + suffix + " (" + what + ") - falling through to stock handler");
  }

  // One line per (cwd, suffix, reason) for a NAMED branch-mode refusal. The
  // reason is part of the key so a live retest that changes the reason says so.
  function logRefuseOnce(cwd, suffix, why) {
    logOnce("substitution-refused", cwd + " " + suffix + " " + why,
      "substitution refused for " + suffix + " in " + cwd + ": " + why +
      " - passing through to the stock view");
  }

  // THE 2 MiB CAP IS NEVER SILENT (2026-07-31 review). One line per (cwd,
  // suffix): git was killed mid-stream, so what we hold is a prefix, and a
  // prefix served as a complete patch or a complete file is a wrong answer that
  // looks like a right one. We pass through to the stock handler instead.
  function noteSubstituteFailure(cwd, suffix, err) {
    if (!isTruncationError(err)) return logFailOnce(suffix, String(err));
    logOnce("truncated", cwd + " " + suffix,
      "WARNING: " + suffix + " output for " + cwd + " exceeded the " + MAX_DIFF_BYTES +
      "-byte cap; REFUSING to serve the truncated result and passing the call " +
      "through to the stock handler");
  }

  // ---- OUTCOME INSTRUMENTATION (mandatory, ships in production) --------------
  // The empty-branch-diff bug cost a whole round because the log recorded what
  // the SPA ASKED for but never what we SENT nor what came back. These lines
  // make the next live test self-diagnosing: for every rewrite we log the
  // rewritten argv and the resulting file count, and if a rewrite returns 0
  // files where the stock call returned some, we say so as a WARNING.
  // Bounded: one line per (channel, mode) pair, i.e. at most a handful ever.
  var stockFileCount = {};

  // getGitDiff resolves to {..., files:[...]} (or null). Tolerates a
  // {kind,data} envelope too, so a future upstream reshape degrades to "n/a"
  // instead of throwing on the logging path.
  function fileCountOf(res) {
    if (!res || typeof res !== "object") return null;
    if (Array.isArray(res.files)) return res.files.length;
    if (res.data && Array.isArray(res.data.files)) return res.data.files.length;
    return null;
  }

  // Baseline for the comparison warning: what the UNMODIFIED handler returns.
  // Recorded on every pass-through, which includes every working-mode call.
  function noteStockResult(suffix, res) {
    var n = fileCountOf(res);
    if (n !== null) stockFileCount[suffix] = n;
  }

  function logRewriteOnce(suffix, mode, rewritten, res) {
    var n = fileCountOf(res);
    logOnce("rewrite", suffix + " " + mode,
      "rewrote " + suffix + " mode=" + mode + " args: " + summarizeArgs(rewritten) +
      " -> files=" + (n === null ? "n/a" : n));
    if (n === 0 && stockFileCount[suffix] > 0) {
      logOnce("rewrite-empty", suffix + " " + mode,
        "WARNING: rewritten " + suffix + " (mode=" + mode + ") returned 0 files while the " +
        "stock call returned " + stockFileCount[suffix] +
        " - the rewritten refs produce an empty diff upstream");
    }
  }

  function logSubstituteOnce(suffix, mode, plan, value) {
    var size = typeof value === "string" ? value.length
      : (value && typeof value === "object" ? "old=" + ((value.oldText || "").length) +
        " new=" + ((value.newText || "").length) : "n/a");
    logOnce("substitute", suffix + " " + mode,
      "substituted " + suffix + " mode=" + mode + " " + plan.base + ".." + plan.head +
      " " + plan.filePath + " -> bytes=" + size);
  }

  // Observe a handler result WITHOUT changing what the caller receives: the
  // derived promise is discarded and `ret` is returned untouched. The rejection
  // handler is there only so observing cannot create an unhandled rejection.
  function tap(fn, ret) {
    try {
      if (ret && typeof ret.then === "function") ret.then(fn, function () {});
      else fn(ret);
    } catch (e) {}
    return ret;
  }

  // Returns a Promise of {rewrite: newArgs} | {value: result} | null (= pass
  // through). Never rejects: the caller treats a rejection as pass-through
  // anyway, but keeping it total makes the fall-through path unambiguous.
  function planIntercept(suffix, args) {
    return new Promise(function (resolve) {
      var mode = S.mode;
      if (mode === MODES.WORKING) return resolve(null);
      logOnce("first-args", suffix,
        "first intercepted call " + suffix + " args: " + summarizeArgs(args));
      var cwd = args && args[0];
      if (!isNonEmptyString(cwd)) return resolve(null);
      // TURN MODE REFUSALS ARE NAMED (2026-07-31). Previously every turn-mode
      // refusal - no snapshot, snapshot for a different repo, non-repo cwd -
      // returned null and logged nothing, so "Latest turn shows the working
      // tree" left no trace at all. One line per (cwd, reason), bounded.
      if (mode === MODES.TURN) {
        primeRepoState(cwd);   // so a LATER call can answer "not a git repo"
        var why = turnRejectReason(cwd, S.modeCwd, turnEntry(cwd), knownRepoState(cwd));
        if (why) { logTurnRejectOnce(cwd, why); return resolve(null); }
      }
      // Scope gate. The pure functions enforce this too (they are what the unit
      // tests exercise); doing it here as well keeps the diagnostic in one place
      // and, importantly, means NO GIT RUNS before the cwd is known to be the
      // one the mode is bound to - neither the "now tree" snapshot nor the
      // branch ref resolution. An unbound mode (modeCwd never set) is inert, so
      // it must not reach the resolvers either.
      if (!isNonEmptyString(S.modeCwd)) return resolve(null);
      if (cwd !== S.modeCwd) {
        logOnce("scope-skip", cwd,
          "mode \"" + S.mode + "\" is bound to " + S.modeCwd + " but this panel asked about " +
          cwd + " - passing through to the stock view (mode is scoped per repo)");
        return resolve(null);
      }
      var isWholeDiff = (suffix === SUF_DIFF || suffix === SUF_STATS);
      currentSnapshot(cwd, isWholeDiff ? args[1] : null, function (snap) {
        if (isWholeDiff) {
          var rewrite = computeGitArgRewrite(mode, suffix, args, snap);
          if (!rewrite) {
            if (mode === MODES.TURN) logTurnRejectOnce(cwd, turnLateRejectReason(snap, cwd));
            else logRefuseOnce(cwd, suffix, wholeDiffRefuseReason(args, snap));
          }
          return resolve(rewrite ? { rewrite: rewrite, mode: mode } : null);
        }
        var plan = computeFilePlan(mode, suffix, args, snap);
        if (!plan) {
          if (mode === MODES.TURN) logTurnRejectOnce(cwd, turnLateRejectReason(snap, cwd));
          else logRefuseOnce(cwd, suffix, filePlanRefuseReason(args, snap));
          return resolve(null);
        }
        if (suffix === SUF_FILE_PATCH) {
          return computeFilePatch(plan, function (err, patch) {
            if (err) { noteSubstituteFailure(cwd, suffix, err); return resolve(null); }
            logSubstituteOnce(suffix, mode, plan, patch);
            resolve({ value: patch });
          });
        }
        computeFileContent(plan, function (err, content) {
          if (err) { noteSubstituteFailure(cwd, suffix, err); return resolve(null); }
          logSubstituteOnce(suffix, mode, plan, content);
          resolve({ value: content });
        });
      });
    });
  }

  /**
   * PURE. Base substitution for the pass-through ("working") mode.
   *
   * WHY WORKING MODE IS TOUCHED AT ALL (user-approved, 2026-07-31): the base
   * upstream picks is wrong for any branch not cut from the remote default, and
   * "Working tree" is the DEFAULT view - so leaving it alone would mean the bug
   * the user reported is still what they see on open. This OVERRIDES a stock
   * choice, so it is gated hard: `dec.overrode` is only true when our candidate
   * differs from what the SPA sent AND is demonstrably closer (strictly smaller
   * ahead-count), or the user pinned it in git config. Otherwise the call is
   * left completely untouched and the panel behaves exactly like stock.
   *
   * The base is substituted as a 40-HEX SHA, never a branch name: upstream
   * re-resolves symbolic refs with an origin/<ref> preference, which is the
   * documented empty-diff trap (see the ref-resolution block above). `head` is
   * left EXACTLY as the SPA sent it - undefined means "working tree", which is
   * the whole point of this mode - and the options argument is not touched
   * either, so this is the minimum possible intervention.
   */
  function computeWorkingBaseRewrite(suffix, args, dec) {
    if (suffix !== SUF_DIFF && suffix !== SUF_STATS) return null;
    if (!Array.isArray(args) || args.length < 2) return null;
    if (!isNonEmptyString(args[0])) return null;      // cwd
    if (!isNonEmptyString(args[1])) return null;      // base
    if (!dec || dec.overrode !== true) return null;
    if (!isNonEmptyString(dec.sha) || !HEX40.test(dec.sha)) return null;
    if (dec.sha === args[1]) return null;             // already what upstream asked for
    var out = args.slice();
    out[1] = dec.sha;
    return out;
  }

  // Promise of {rewrite, mode:MODES.WORKING} | null (= leave the call alone).
  function planWorkingOverride(suffix, args) {
    return new Promise(function (resolve) {
      if (suffix !== SUF_DIFF && suffix !== SUF_STATS) return resolve(null);
      if (!Array.isArray(args) || !isNonEmptyString(args[0]) || !isNonEmptyString(args[1])) {
        return resolve(null);
      }
      resolveSmartBase(args[0], args[1], function (dec) {
        var rewrite = computeWorkingBaseRewrite(suffix, args, dec);
        resolve(rewrite ? { rewrite: rewrite, mode: MODES.WORKING } : null);
      });
    });
  }

  function wrapListener(suffix, orig) {
    return function (event) {
      // THE FEATURE SWITCH IS OFF: byte-identical pass-through, and the FIRST
      // statement of the wrapper on purpose - no diagnostics, no cwd bookkeeping,
      // no snapshot, no ref resolution, nothing that could cost a git call. The
      // handler sees exactly the arguments upstream sent and the renderer sees
      // exactly upstream's result, so the panel is stock while this is off.
      if (!prefEnabled) return orig.apply(this, arguments);
      var self = this;
      var origArgs = Array.prototype.slice.call(arguments);
      var args = origArgs.slice(1);
      // Every pass-through is also the BASELINE sample for the instrumentation
      // ("stock returned N files") AND the trust signal for base detection: a
      // non-null result from the STOCK handler is upstream's own
      // requireTrustedCwd verdict for args[0] (see markTrustedCwd).
      function passThrough() {
        return tap(function (r) {
          noteStockResult(suffix, r);
          if (r && typeof r === "object") markTrustedCwd(args[0]);
        }, orig.apply(self, origArgs));
      }
      try { noteDiffCwd(suffix, args); } catch (e) {}
      if (S.mode === MODES.WORKING) {
        if (suffix !== SUF_DIFF && suffix !== SUF_STATS) return passThrough();
        var wPlanned;
        try { wPlanned = planWorkingOverride(suffix, args); }
        catch (e) { logFailOnce(suffix, String(e && e.message || e)); return passThrough(); }
        return Promise.resolve(wPlanned).then(function (res) {
          if (!res) return passThrough();
          return tap(function (r) { logRewriteOnce(suffix, res.mode, res.rewrite, r); },
            orig.apply(self, [event].concat(res.rewrite)));
        }, function (e) {
          logFailOnce(suffix, String(e && e.message || e));
          return passThrough();
        });
      }
      var planned;
      try { planned = planIntercept(suffix, args); }
      catch (e) { logFailOnce(suffix, String(e && e.message || e)); return passThrough(); }
      return Promise.resolve(planned).then(function (res) {
        if (!res) return passThrough();
        if (Object.prototype.hasOwnProperty.call(res, "value")) return res.value;
        return tap(function (r) { logRewriteOnce(suffix, res.mode, res.rewrite, r); },
          orig.apply(self, [event].concat(res.rewrite)));
      }, function (e) {
        logFailOnce(suffix, String(e && e.message || e));
        return passThrough();
      });
    };
  }

  // ---- refetch nudge ---------------------------------------------------------
  // A mode switch changes nothing in git, so nothing upstream fires and the SPA
  // keeps showing the data it already has. We therefore replay upstream's OWN
  // diff-invalidation signal.
  //
  // EVIDENCE (1.24012.9, tmp/staged-index.js) - this is a real push channel, not
  // a guess. The eipc codegen builds a per-WebContents dispatcher whose event
  // methods are plain webContents.send calls:
  //   dispatchOnEvent(r){ if(!DJe(r)) throw ...;
  //     e.send("$eipc_message$_<uuid>_$_claude.web_$_LocalSessions_$_onEvent", r) }
  // and the session manager emits exactly this event after invalidating its own
  // git memos:
  //   for (const o of s) this.gitStatus.invalidateDiffsFor(o);
  //   this.emit("event", { type: "git_state_changed", sessionId: r })
  // Every emitted event reaches that dispatcher unfiltered - the intermediary
  // C8e/dispatchOrCaptureSessionEvent is only a try/catch + Sentry wrapper, it
  // drops nothing. (Note the events ride the same "$eipc_message$" prefix as
  // the invoke channels; searching for an "$eipc_event$" prefix finds nothing
  // and wrongly suggests there is no push path.)
  //
  // The channel literal is DERIVED from a channel we actually intercepted, by
  // swapping the trailing method name - so the codegen UUID never appears here
  // and a per-release UUID change cannot break it.
  var onEventChannel = null;   // derived from an intercepted channel literal
  var nudgeTargets = [];       // WebContents to replay the event to
  var focusedSessionId = null;

  function rememberOnEventChannel(channel) {
    if (onEventChannel) return;
    var cut = String(channel).lastIndexOf("_$_");
    if (cut === -1) return;
    onEventChannel = channel.slice(0, cut + 3) + "onEvent";
  }

  // Two independent sources so the nudge survives the registration point moving
  // to ipcMain (where no WebContents is in scope): the intercepted registration,
  // and the sender of our own bridge calls - which is by definition the
  // claude.ai renderer whose panel we need to refresh.
  function rememberNudgeTarget(wc) {
    if (!wc || typeof wc.send !== "function") return;
    for (var i = 0; i < nudgeTargets.length; i++) if (nudgeTargets[i] === wc) return;
    nudgeTargets.push(wc);
  }

  // Replay { type:"git_state_changed", sessionId } - byte-identical in shape to
  // what upstream sends. sessionId comes from the renderer's own
  // LocalSessions.setFocusedSession call (observed, never invented); if we have
  // not seen one we send "", which upstream itself does for non-session-scoped
  // events (e.g. initialization_status).
  function nudgeRefetch() {
    var sent = 0;
    if (onEventChannel) {
      var payload = { type: "git_state_changed", sessionId: focusedSessionId || "" };
      for (var i = 0; i < nudgeTargets.length; i++) {
        var wc = nudgeTargets[i];
        try {
          if (wc.isDestroyed && wc.isDestroyed()) continue;
          wc.send(onEventChannel, payload);
          sent++;
        } catch (e) { /* a dead WebContents must never break a mode switch */ }
      }
    }
    logOnce("nudge", "",
      "refetch nudge: synthetic git_state_changed sent to " + sent + " webContents" +
      " (sessionId=" + (focusedSessionId ? "observed" : "\"\"") + ")" +
      (sent ? "" : " - NO target channel known, the view must be reopened to refresh"));
    return sent;
  }

  // Observe-only wrapper: records the focused session id and always calls the
  // original handler with the original arguments. Verified arg shape in the
  // bundle: setFocusedSession(sessionId: string | null).
  var SUF_FOCUS = "_LocalSessions_$_setFocusedSession";

  function wrapFocusListener(orig) {
    return function (_event, sessionId) {
      try { if (isNonEmptyString(sessionId)) focusedSessionId = sessionId; } catch (e) {}
      return orig.apply(this, arguments);
    };
  }

  // ---- MAKING THE UI HONEST: the base-branch label ---------------------------
  //
  // VERIFIED RESULT CONTRACT (1.24012.9). The registration is
  //   e.ipc.handle("..._$_LocalSessions_$_getGitInfo", async (ev, cwd) => {...})
  // with `typeof cwd != "string"` throwing, and the result checked against
  // validator wK before it is returned:
  //
  //   function wK(e){ return !(!e || typeof e!="object"
  //     || typeof e.repo!="string" || typeof e.branch!="string"
  //     || typeof e.defaultBranch<"u" && typeof e.defaultBranch!="string"
  //     || typeof e.root<"u" && typeof e.root!="string") }
  //
  // i.e. {repo:string, branch:string, defaultBranch?:string, root?:string} | null.
  // The producer (fetchGitInfoUncached) also sets `remote`; wK ignores unknown
  // keys, so extra fields are legal and we preserve every one of them.
  //
  // WHY THIS IS THE RIGHT CHANNEL: `defaultBranch` is BOTH the breadcrumb's base
  // label ("develop -> <branch>") and the value the SPA passes as the `base`
  // argument to getGitDiff. Correcting this ONE field therefore fixes the label
  // and upstream's own base choice together - which is why in practice the
  // working-mode rewrite above rarely has to fire at all. The two layers agree
  // by construction: once getGitInfo reports our base, the SPA sends it, and
  // shouldOverrideUpstreamBase sees "same answer as upstream" and leaves it be.
  //
  // FAIL CLOSED. A null result, a shape that would not satisfy wK, a
  // non-promise return, no confident base of our own, or ANY thrown error all
  // return upstream's object UNTOUCHED. A stale label is bad; a header that
  // trips the validator and breaks the panel is worse.
  var SUF_GIT_INFO = "_LocalSessions_$_getGitInfo";
  function wrapGitInfoListener(orig) {
    return function (event) {
      // Switch off: upstream's own defaultBranch is what the breadcrumb shows
      // again, and no base detection runs. Same first-statement rule as
      // wrapListener - the base override must stop, not merely be hidden.
      if (!prefEnabled) return orig.apply(this, arguments);
      var self = this;
      var origArgs = Array.prototype.slice.call(arguments);
      var cwd = origArgs[1];
      // Not wrapped in try/catch: a synchronous throw here is upstream's own
      // argument validation and must reach the renderer exactly as stock.
      var ret = orig.apply(self, origArgs);
      if (!ret || typeof ret.then !== "function") return ret;
      return Promise.resolve(ret).then(function (info) {
        if (!isNonEmptyString(cwd)) return info;
        if (!info || typeof info !== "object") return info;   // null = not a repo / untrusted
        // A non-null result IS upstream's requireTrustedCwd verdict for this
        // cwd, which is what unlocks base detection (see markTrustedCwd).
        markTrustedCwd(cwd);
        return new Promise(function (resolve) {
          var upstreamBase = isNonEmptyString(info.defaultBranch) ? info.defaultBranch : null;
          resolveSmartBase(cwd, upstreamBase, function (dec) {
            if (!dec || dec.overrode !== true) return resolve(info);
            var out = rewriteGitInfoDefaultBranch(info, dec.base);
            if (!out) {
              logOnce("gitinfo-skip", cwd,
                "getGitInfo: leaving the label alone for " + cwd +
                " (result shape is not safe to rewrite) - passing upstream's result " +
                "through unchanged");
              return resolve(info);
            }
            logOnce("gitinfo-label", cwd + " " + upstreamBase + " " + dec.base,
              "getGitInfo: reporting defaultBranch \"" + dec.base + "\" instead of \"" +
              (isNonEmptyString(upstreamBase) ? upstreamBase : "<none>") + "\" for " + cwd +
              " - the breadcrumb now names the branch we actually diff against");
            resolve(out);
          });
        }).then(null, function () { return info; });
      });
    };
  }

  function wrapIpcObject(ipcObj, where, wc) {
    try {
      if (!ipcObj || typeof ipcObj.handle !== "function" || ipcObj.__cdbDvWrapped) return;
      ipcObj.__cdbDvWrapped = true;
      var origHandle = ipcObj.handle;
      ipcObj.handle = function (channel, listener) {
        if (typeof listener === "function" && endsWith(channel, SUF_FOCUS)) {
          return origHandle.call(this, channel, wrapFocusListener(listener));
        }
        // getGitInfo is NOT one of the diff channels (suffixFor never matches
        // it) - it carries the base-branch LABEL, so it gets its own wrapper.
        // It does not set interceptedAny: that flag guards the "no git-diff
        // channel was intercepted" warning, whose meaning must not change.
        if (typeof listener === "function" && endsWith(channel, SUF_GIT_INFO)) {
          logOnce("intercepting", SUF_GIT_INFO,
            "intercepting " + SUF_GIT_INFO + " (via " + where + ") - base-branch label");
          try { rememberOnEventChannel(channel); rememberNudgeTarget(wc); } catch (e) {}
          return origHandle.call(this, channel, wrapGitInfoListener(listener));
        }
        var suffix = null;
        try { suffix = suffixFor(channel); } catch (e) {}
        if (!suffix || typeof listener !== "function") {
          return origHandle.apply(this, arguments);
        }
        try { rememberOnEventChannel(channel); rememberNudgeTarget(wc); } catch (e) {}
        interceptedAny = true;
        logOnce("intercepting", suffix, "intercepting " + suffix + " (via " + where + ")");
        return origHandle.call(this, channel, wrapListener(suffix, listener));
      };
    } catch (e) { log("ipc wrap failed (" + where + "): " + e); }
  }

  // PRIMARY interception point (see the header note): per-WebContents ipc.
  // Our listener is registered at bundle top, so it runs before the app's own
  // per-WebContents setup registers the LocalSessions handlers.
  _app.on("web-contents-created", function (_ev, wc) {
    try { wrapIpcObject(wc.ipc, "webContents.ipc", wc); } catch (e) {}
  });
  // Belt and braces: catches a future release that moves registration to the
  // global map. Harmless if nothing matches. No WebContents is in scope here -
  // the nudge then relies on the sender of our own bridge calls instead.
  wrapIpcObject(_ipc, "ipcMain", null);

  setTimeout(function () {
    if (!interceptedAny) log("WARNING: no LocalSessions git-diff channel was intercepted within " +
      Math.round(NO_INTERCEPT_WARN_MS / 1000) + "s - upstream channel names or the registration point changed; modes will be inert");
  }, NO_INTERCEPT_WARN_MS);

  // ---- IPC (our own bridge channels) -----------------------------------------

  // Same origin allowlist the stock eipc validator enforces, verified in the
  // 1.24012.9 bundle (the "did not pass origin validation" chain compares the
  // sender origin against exactly these four). We deliberately do NOT mirror
  // its trailing `globalThis.isDeveloperApprovedDevUrlOverrideEnabled` escape
  // hatch: we never set that flag, and a mode switch is not worth widening the
  // gate. Tightened from the previous generic /^https?:\/\// test, which would
  // have accepted any http(s) page that somehow got our preload.
  //
  // app://localhost is the main window in 3P mode (upstream serves the bundled
  // SPA from it instead of claude.ai). Its URL.origin is the opaque "null", so
  // the origin is normalised to protocol + "//" + host first - the same
  // normalisation upstream's own eIPC sender validator applies. host keeps a
  // port, so app://localhost:1234 stays distinct and is rejected.
  var ALLOWED_ORIGINS = [
    "https://claude.ai",
    "https://preview.claude.ai",
    "https://claude.com",
    "https://preview.claude.com",
    "app://localhost"
  ];

  function originAllowed(rawUrl) {
    var origin;
    try {
      var u = new URL(String(rawUrl));
      origin = u.origin;
      if (!origin || origin === "null") origin = u.protocol + "//" + u.host;
    } catch (e) { return false; }
    for (var i = 0; i < ALLOWED_ORIGINS.length; i++) {
      if (origin === ALLOWED_ORIGINS[i]) return true;
    }
    return false;
  }

  function okSender(ev) {
    try {
      var wc = ev && ev.sender;
      if (!wc || wc.isDestroyed()) return false;
      if (!originAllowed(wc.getURL() || "")) return false;
      var frame = ev.senderFrame;
      if (frame && frame.parent) return false;
      return true;
    } catch (e) { return false; }
  }

  // `mode` is the EFFECTIVE mode (see effectiveMode): the page sets its
  // <select> value from it on every install, so a dropdown remounted by a view
  // change shows what the panel will really display instead of always
  // defaulting to "Working tree". rawMode/modeCwd/diffCwd are diagnostics.
  //
  // `hasTurnSnapshot` IS PER-REPO (2026-07-31). It used to be `!!S.turnStartTree`
  // - one global flag - so the page happily offered "Latest turn" for a repo that
  // had never recorded one, and selecting it silently showed the working tree.
  // It now answers for THE PANEL'S OWN REPO (S.diffCwd, falling back to the last
  // observed session cwd), and the page disables the option when it is false.
  function stateFields(extra) {
    var panelCwd = S.diffCwd || S.cwd;
    var entry = turnEntry(panelCwd);
    var base = {
      ok: true,
      // The pref rides on state() so the page has ONE source of truth for it and
      // needs no second channel: it removes its dropdown when this is false and
      // re-adds it when it flips back (both live, see the page's pref poll).
      enabled: prefEnabled,
      prefSource: prefSource,
      mode: effectiveMode(),
      rawMode: S.mode,
      modeCwd: S.modeCwd,
      // Whether the bound repo has been observed, i.e. whether a non-working
      // mode would actually be applied. `mode` above already collapses to
      // "working" when this is false; the field is here so the log and a future
      // panel notice can explain WHY rather than just showing stock.
      modeArmed: isObservedCwd(S.modeCwd),
      diffCwd: S.diffCwd,
      turnCwd: panelCwd || null,
      hasTurnSnapshot: !!(entry && isNonEmptyString(entry.tree)),
      turnCount: entry ? entry.turns : 0,
      turnRepos: turnOrder.length
    };
    for (var k in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, k)) base[k] = extra[k];
    }
    return base;
  }

  _ipc.handle("cdb-diff:state", function (ev) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    try { rememberNudgeTarget(ev.sender); } catch (e) {}
    // Prefer the repo the diff panel itself is fetching: S.cwd follows CLI
    // spawns and routinely points at an unrelated directory (see the S comment),
    // which would report isGitRepo:false for a perfectly good session and keep
    // the dropdown from ever activating.
    var cwd = S.diffCwd || S.cwd;
    if (!cwd) return stateFields({ available: false, isGitRepo: false, baseRef: null });
    // S.diffCwd is renderer-influenced: noteDiffCwd records it BEFORE the stock
    // handler gets a say, so upstream's requireTrustedCwd rejection never
    // filters it. A cwd nothing on the main side has vouched for must not
    // reach git here - not even the is-a-work-tree probe, which would hand
    // remote code an "is this absolute path a git repo" oracle plus that
    // repo's base branch name. Vouched means upstream's own gate passed
    // (markTrustedCwd via a non-null stock result) or our spawn hook observed
    // the session's CLI there - the same bar the substitution path uses.
    if (!isTrustedCwd(cwd) && !isObservedCwd(cwd)) {
      logOnce("state-unvouched", cwd, "state: refusing git probe for unvouched cwd " + cwd);
      return stateFields({ available: false, isGitRepo: false, baseRef: null });
    }
    return new Promise(function (resolve) {
      // Shares the per-cwd work-tree cache with the spawn gate, so the probe
      // runs once per directory and a "not a git repo" verdict learned here is
      // immediately available to the turn-mode rejection diagnostics.
      isInsideWorkTree(cwd, function (isGitRepo) {
        if (!isGitRepo) {
          return resolve(stateFields({ available: true, isGitRepo: false, baseRef: null }));
        }
        // isGitRepo just came back true from upstream-independent git, so the
        // path is a real repo we may query - enough to unlock base detection
        // for the diagnostic below.
        markTrustedCwd(cwd);
        resolveSmartBase(cwd, null, function (dec) {
          // Report OUR detected base when we have one: this field answers
          // "which branch is Branch mode comparing against?", and since the
          // smart detector now decides that, resolveBase's origin/HEAD-first
          // guess is only the fallback.
          if (dec && isNonEmptyString(dec.base)) {
            return resolve(stateFields({
              available: true, isGitRepo: true, baseRef: dec.base, baseSource: dec.source
            }));
          }
          resolveBase(cwd, function (baseRef) {
            resolve(stateFields({
              available: true, isGitRepo: true, baseRef: baseRef || null,
              baseSource: "upstream-fallback"
            }));
          });
        });
      });
    });
  });

  _ipc.handle("cdb-diff:set-mode", function (ev, mode) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    // THE enum validation for this IPC boundary - one validator over one list, so
    // it cannot drift from the modes the rest of the file dispatches on or from
    // the options the page offers.
    if (!isMode(mode)) return { ok: false, error: "invalid mode" };
    // Defence in depth: the page removes its dropdown when the switch goes off,
    // but a dropdown that outlived a pref change must not be able to arm a mode
    // behind the user's back.
    if (!prefEnabled) return { ok: false, error: "diff view modes are switched off in Settings -> Extra -> Features" };
    try { rememberNudgeTarget(ev.sender); } catch (e) {}
    S.mode = mode;
    // Bind the mode to the repo whose diff panel is on screen. S.diffCwd comes
    // from the panel's own fetches and is the only reliable signal for that;
    // S.cwd is a last-resort fallback for a switch made before any diff fetch
    // was intercepted (in which case the mode stays inert - see effectiveMode).
    S.modeCwd = mode === MODES.WORKING ? null : (S.diffCwd || S.cwd);
    log("mode=" + mode + " boundTo=" + (S.modeCwd || "<none>"));
    // Set the mode FIRST, then nudge, so the refetch we trigger reads the new
    // mode. `nudged` tells the page whether a refresh was actually pushed - if
    // not, it must say so instead of pretending the switch took effect.
    var nudged = nudgeRefetch() > 0;
    return { ok: true, mode: mode, boundTo: S.modeCwd, nudged: nudged,
      armed: mode === MODES.WORKING || isObservedCwd(S.modeCwd) };
  });

  // ---- the Extra settings switch ---------------------------------------------
  //
  // OUR channels, invoked from the Extra settings page through window.cdbExtra -
  // the arrangement the theme picker already uses for cdb-themes:apply, and the
  // reason the settings patch does not become the writer of this key.
  //
  // SAME POSTURE AS EVERY HANDLER ABOVE: the sender is validated against the four
  // stock origins, the argument is a plain boolean and nothing else, the answer is
  // always an {ok:...} record, and neither handler can throw - a rejected promise
  // in the settings dialog would render as a dead row.
  _ipc.handle("cdb-diff:pref-read", function (ev) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    try {
      // Read the FILES, not just our cached value: the user may have edited the
      // .jsonc since startup, and the panel must show the file's truth.
      var disk = readPrefFromDisk();
      applyPref(disk.value, disk.source);
      var p = cfgPaths();
      return {
        ok: true,
        enabled: prefEnabled,
        source: prefSource,
        defaultEnabled: PREF_DEFAULT,
        // A hand-edited .jsonc wins the startup merge, so the switch shows itself
        // as locked instead of silently disagreeing with the file. A separate
        // boolean rather than a value-or-null field, because the value here IS a
        // boolean and `false` must not read as "not locked". The FIELD NAME
        // matches the other rows' handlers so the settings page speaks of
        // exactly one spelling.
        lockedByJsonc: prefSource === "jsonc-locked",
        key: PREF_KEY,
        jsonPath: p.json,
        jsoncPath: p.jsonc
      };
    } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  });

  _ipc.handle("cdb-diff:pref-set", function (ev, enabled) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    if (typeof enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
    try {
      var disk = readPrefFromDisk();
      if (disk.source === "jsonc-locked") {
        applyPref(disk.value, disk.source);
        return { ok: false, error: PREF_KEY + " is set in claude-desktop-extra.jsonc - edit that file to change it" };
      }
      var w = writePref(enabled);
      if (!w.ok) return w;
      applyPref(enabled, enabled === PREF_DEFAULT ? "default" : "json");
      try { rememberNudgeTarget(ev.sender); } catch (e2) {}
      // The panel on screen holds data produced under the OLD setting, so replay
      // upstream's own invalidation exactly as a mode switch does: switching the
      // feature off has to restore the stock view now, not at the next restart.
      var nudged = nudgeRefetch() > 0;
      return { ok: true, enabled: enabled, path: w.path, nudged: nudged };
    } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  });

  // ---- page injection ---------------------------------------------------------
  // Injected in BOTH states: the page polls state() and mounts or removes its
  // dropdown from what it reports, which is what makes the switch live.

  _app.on("web-contents-created", function (_ev, wc) {
    wc.on("dom-ready", function () {
      try {
        var url = wc.getURL() || "";
        // Upstream's 3P setup wizard also lives on app://localhost but has no
        // Code tab, so it gets no injection.
        if (originAllowed(url) && !/^app:\/\/localhost\/setup-desktop-3p(?:[\/?#]|$)/i.test(url)) {
          wc.executeJavaScript(PAGE_SRC).catch(function () {});
        }
      } catch (e) {}
    });
  });

  // The startup line is computed one tick after load, as before. __cdbDiag is
  // still missing then (it only appears once upstream's "ready" handler runs),
  // so log() queues the line and flushLog() delivers it after "ready".
  setTimeout(function () {
    log("installed (main)");
    log("pref " + PREF_KEY + "=" + prefEnabled + " (source: " + prefSource + ")" +
      (prefEnabled ? "" : " - opt-in feature is off: no interception, no base override, " +
        "no turn snapshots, no dropdown"));
  }, 0);
})();
