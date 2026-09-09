/*
 * window_controls_pref.js - the SYNCHRONOUS readers for the two titlebar-mode
 * opt-ins, injected at the head of the main bundle by
 * patches/community/add_feature_window_controls.nim.
 *
 *   globalThis.__cdbNativeTb()   <- `nativeTitlebar`    / CLAUDE_NATIVE_TITLEBAR=1
 *   globalThis.__cdbNoWinCtl()   <- `noWindowControls`  / CLAUDE_NO_WINDOW_CONTROLS=1
 *
 * Why this is its own file, separate from window_controls_main.js: the answers
 * are needed at BrowserWindow CONSTRUCTION time (frame/titleBarStyle/hasShadow
 * are constructor-only on Linux - setTitleBarOverlay(false) throws and there is
 * no setFrame), so patches/linux/fix_native_frame.nim has to ask plain
 * functions and get booleans back in the same tick. Nothing here may be async,
 * and nothing here may throw: a config file a user hand-edited into invalid
 * JSON must degrade to "feature off", never to a window that fails to open.
 *
 * The two modes are the ones the launcher already exposes as --native-titlebar
 * and --no-window-controls; these keys are the persisted equivalents, switched
 * from Settings -> Extra -> Community Features. Both need an app RESTART to
 * take effect, which is why the rows say so and why the readers may memoize.
 *
 * ---------------------------------------------------------------------------
 * PRECEDENCE - two levels, and they are deliberately kept apart
 * ---------------------------------------------------------------------------
 * WITHIN a mode: env var OR config key, a plain OR with no ranking. The env
 * var is checked first only because it is cheaper; a one-off launcher flag and
 * a persisted key mean exactly the same thing.
 *
 * RUNNING vs SAVED: because neither mode can apply live, the two values can
 * legitimately differ between a toggle and the next start. activeFor() reports
 * what the open window was built with (the memo, observed without disturbing
 * it) and savedFor() what the config files hold (a fresh read); the Settings
 * rows compare them to decide whether a restart is still pending. See both
 * functions below.
 *
 * BETWEEN the modes (native wins over bare wins over the default integrated
 * titlebar): NOT here. Each function below is dumb and independent - it
 * answers only "is MY mode requested", whichever surface asked for it.
 * __cdbNoWinCtl() therefore still returns true when native is also on, and
 * patches/linux/fix_native_frame.nim resolves the three-way choice. Baking the
 * ranking in here would hide it inside a boolean and give the window patch no
 * way to tell "bare was not asked for" from "bare lost to native".
 */
;/*__CDB_WINCTL_PREF__*/(function () {
  "use strict";

  var PREF_DEFAULT = false;
  var JSONC_NAME = "claude-desktop-extra.jsonc";
  var JSON_NAME = "claude-desktop-extra.json";

  // The two modes this module owns. One module for both is deliberate: they are
  // the same concern (titlebar mode), read the same files and share the same
  // lock rule, so every helper below takes a mode instead of being duplicated.
  var MODES = {
    nativeTitlebar: { key: "nativeTitlebar", env: "CLAUDE_NATIVE_TITLEBAR", global: "__cdbNativeTb" },
    noWindowControls: { key: "noWindowControls", env: "CLAUDE_NO_WINDOW_CONTROLS", global: "__cdbNoWinCtl" }
  };

  var _fs = require("fs");
  var _path = require("path");

  // First answer each mode's function gave, keyed by config key. Kept on
  // globalThis rather than in this IIFE's scope so a double injection shares
  // one memo with the functions installed by the first pass, instead of the
  // fresh surface reporting an empty cache while the live function answers
  // from the old one.
  var MEMO = globalThis.__cdbWinCtlMemo || (globalThis.__cdbWinCtlMemo = {});
  // null (never "false") means "nothing has asked yet" - the two are different
  // facts and the IPC layer treats them differently, see activeFor below.
  function memoized(key) {
    return Object.prototype.hasOwnProperty.call(MEMO, key) ? MEMO[key] === true : null;
  }

  function userDir() {
    try { return require("electron").app.getPath("userData"); } catch (e) { return null; }
  }
  // Same as every other config consumer (js/panel_tabs_main.js,
  // js/diff_views_main.js, extra_settings_main.js, growthbook_overrides.js):
  // the one-time claude-desktop-bin.* -> claude-desktop-extra.* rename
  // migration is installed by the custom-themes patch and same-anchor prefix
  // injections stack in reverse, so it may not have run yet when we get here.
  // Nudging it before every path resolution is defence-in-depth against a read
  // (or a later write) missing a user's legacy config.
  function pathFor(name) {
    try { (globalThis.__cdbCfgMigrate || function () {})(); } catch (e) {}
    var d = userDir();
    return d ? _path.join(d, name) : null;
  }

  // Comment/trailing-comma stripper for the .jsonc/.json config files, same as
  // the panel-tabs and diff-views pref readers. A naive "strip from // to end
  // of line" heuristic corrupts any string VALUE that happens to contain "//"
  // - e.g. {"note":"see a//b for details"} truncates mid-string and the file
  // fails to parse. Matching whole quoted strings FIRST and passing them
  // through untouched is the only way to strip comments without risking string
  // contents, whatever they contain.
  function stripComments(s) {
    return String(s)
      .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, function (m, q) { return q ? q : ""; })
      .replace(/,(\s*[}\]])/g, "$1");
  }

  // LENIENT reader for the read-only paths (pref lookup / lock detection): any
  // problem - missing file, unparseable JSON, wrong shape - is reported the
  // same as "no pref set here" and falls through to the next source. That is
  // safe here because nothing is written back. window_controls_main.js's
  // writePref does NOT use this function for its own existing-file read: a
  // write must distinguish "absent" from "present but broken" instead of
  // silently treating both as empty, or a broken file gets overwritten and
  // every other key in it is lost.
  function readFileJson(p) {
    try {
      if (!p || !_fs.existsSync(p)) return null;
      var stripped = stripComments(_fs.readFileSync(p, "utf8"));
      var v = stripped.trim() ? JSON.parse(stripped) : {};
      return (v && typeof v === "object" && !Array.isArray(v)) ? v : null;
    } catch (e) { return null; }
  }

  // The .jsonc is the HUMAN-OWNED file and wins the startup merge, so a value
  // found there is reported as locked and pref-set refuses to fight it instead
  // of writing a .json the merge would then ignore.
  //
  // Deliberately NOT memoized: the Settings rows read through this on every
  // open and have to see what they just wrote. Only the two mode functions
  // below cache, because the window geometry they feed cannot change without a
  // restart anyway - and a cached answer keeps every window in the process
  // built the same way even if the file changes underfoot.
  function readPrefFromDisk(key) {
    var jsonc = readFileJson(pathFor(JSONC_NAME));
    if (jsonc && typeof jsonc[key] === "boolean") {
      return { value: jsonc[key], source: "jsonc-locked" };
    }
    var json = readFileJson(pathFor(JSON_NAME));
    if (json && typeof json[key] === "boolean") {
      return { value: json[key], source: "json" };
    }
    // "default" is the same word the panel-tabs reader uses for "the key is on
    // neither file" - the default being FALSE, absence IS off.
    return { value: PREF_DEFAULT, source: "default" };
  }

  function envForced(envKey) {
    try { return process.env[envKey] === "1"; } catch (e) { return false; }
  }

  // The SAVED setting, uncached: what the config files say and nothing else.
  // Deliberately NOT ORed with the env var - a launcher flag doing the work
  // while nothing is saved would render the Settings switch as ON, which is
  // the "switch out of step with the window" problem the row is meant to
  // avoid. The flag is reported alongside as `envForced` instead, so the row
  // can explain itself rather than misrepresent what is stored.
  //
  // Uncached because the Settings rows have to see what they just wrote, and
  // because comparing this against activeFor() is how the UI knows a restart
  // is still pending.
  function savedFor(mode) {
    var disk = readPrefFromDisk(mode.key);
    return { value: disk.value === true, source: disk.source, envForced: envForced(mode.env) };
  }

  // What the RUNNING session is actually using. The memo is the record of it:
  // patches/linux/fix_native_frame.nim calls each mode's function while it
  // builds the main window's options, so the cached answer is literally the
  // value the open window was constructed with - env var included, since the
  // function ORs it in.
  //
  // PURE OBSERVATION: it reads the memo and never calls the mode function, so
  // it cannot disturb the cache the window patch depends on, and an IPC read
  // can never fix the running value before a window has asked for it.
  //
  // Two cases the caller must distinguish:
  //   - boolean: a window (or anything else) has already asked. This is a
  //     historical fact about the running session, and comparing it against
  //     savedFor().value is what decides whether a restart is pending.
  //   - null: nothing has asked yet - no window built so far, or a build
  //     without the window patch. There is no running value in existence to
  //     report, so the honest answer is "unknown"; the UI shows no restart
  //     notice rather than inventing a comparison.
  function activeFor(mode) {
    return memoized(mode.key);
  }

  // Shared surface for window_controls_main.js (the IPC half), which must read
  // and write exactly the same keys, the same files and the same lock rule.
  // Assigned unconditionally so a rebuilt half never talks to a stale one.
  globalThis.__cdbWinCtlPref = {
    MODES: MODES,
    PREF_DEFAULT: PREF_DEFAULT,
    JSON_NAME: JSON_NAME,
    JSONC_NAME: JSONC_NAME,
    pathFor: pathFor,
    stripComments: stripComments,
    readFileJson: readFileJson,
    readPrefFromDisk: readPrefFromDisk,
    envForced: envForced,
    savedFor: savedFor,
    activeFor: activeFor,
    memoized: memoized
  };

  // Each mode gets one memoized, never-throwing function: one file read per
  // mode per process, every later call answers from the cache, and any failure
  // means "not requested". Defined on EVERY platform (not gated on linux like
  // the IPC half): the window patch calls them unconditionally at construction
  // time, so the functions existing is part of the contract.
  //
  // The cache lives in the shared MEMO above, which is also what lets the IPC
  // layer report the running value without forcing a first call. Nothing here
  // may be relaxed to satisfy that: the window patch needs a stable answer for
  // the life of the process, so the memo is written exactly once per mode.
  function install(mode) {
    if (globalThis[mode.global]) return;
    globalThis[mode.global] = function () {
      var cached = memoized(mode.key);
      if (cached !== null) return cached;
      var v = false;
      try {
        v = envForced(mode.env) || readPrefFromDisk(mode.key).value === true;
      } catch (e) { v = false; }
      MEMO[mode.key] = v === true;
      return MEMO[mode.key];
    };
  }
  install(MODES.nativeTitlebar);
  install(MODES.noWindowControls);
})();
