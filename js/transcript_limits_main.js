/*
 * transcript_limits_main.js - main-process half of "Load large sessions in full".
 *
 * Anthropic's session manager (the `[CCD]` class behind the Code tab) only loads
 * the last 50 MiB of a session's transcript, plus ONE shared 32 MiB for all of the
 * session's subagent transcripts, and hides the rest behind "This session is too
 * large to load in full". Sessions with many inline browser screenshots reach that
 * within hours: a screenshot is ~0.4 MB of base64 (tools scale it to ~2000 px wide),
 * and the main transcript stores each tool result twice (message.content and
 * toolUseResult), subagent transcripts once, so 60-80 of them reach a limit.
 *
 * That class already takes an optional `loadLimits` option which nothing in the
 * app ever sets. This module is what sets it - and ONLY when the user has opted
 * in. Off, `globalThis.__cdbTranscriptLimits()` returns undefined, the patched
 * constructors pass `loadLimits: undefined`, and every upstream number (and any
 * future change Anthropic makes to them) stays exactly as shipped.
 *
 * It owns:
 *   - the opt-in pref `transcriptLimits` (default OFF) plus two optional numbers,
 *     `transcriptLimitsMainMiB` / `transcriptLimitsSubagentMiB`, hand-edited in
 *     the .jsonc like `coworkGlowOpacity` (no GUI field);
 *   - the derivation of the two cache ceilings from those numbers (below);
 *   - globalThis.__cdbTranscriptLimits, read once per session manager when it is
 *     constructed (patches/community/add_feature_transcript_limits.nim);
 *   - the worker gate: process.env.CDB_TRANSCRIPT_LIMITS, for the heavy-work
 *     utility process, which bundles its own copy of the manager
 *     (patches/community/add_feature_transcript_limits_worker.nim);
 *   - the IPC pair behind the Settings -> Extra switch.
 *
 * NOT LIVE: the managers are constructed once at startup, so a saved change
 * applies on the next start. The module snapshots what it handed out
 * (`active`), and pref-read reports it next to the saved value so the row can say
 * "applies after a restart" for exactly as long as that is true.
 *
 * Cache ceilings are derived, not settings. The manager's parse cache must hold
 * one session's whole load (main + subagents) or it re-truncates the main window
 * to the ceiling, shrinks the subagent budget to what is left, and falls back to
 * a full reload instead of reading only appended bytes on every update.
 * Anthropic's own proportions are 50 + 32 MiB -> 100 per session (~1.22x) and a
 * 200 MiB total (2x that); we keep them, rounding the first up to 1.25x.
 *
 * SECURITY: the caller is remote claude.ai code. Every handler validates the
 * sender's ORIGIN (not a substring test of the URL - see okSender below) and
 * takes only a boolean; nothing page-supplied reaches the filesystem.
 */
;/*__CDB_TRANSCRIPT_LIMITS__*/(function () {
  "use strict";
  if (typeof process === "undefined" || process.platform !== "linux") return;
  if (globalThis.__cdbTranscriptLimitsMain) return;
  globalThis.__cdbTranscriptLimitsMain = true;

  var _electron = require("electron");
  var _app = _electron.app;
  var _ipc = _electron.ipcMain;
  var _fs = require("fs");
  var _path = require("path");
  var _URL = require("url").URL;

  var PREF_KEY = "transcriptLimits";
  var MAIN_KEY = "transcriptLimitsMainMiB";
  var SUBAGENT_KEY = "transcriptLimitsSubagentMiB";
  var PREF_DEFAULT = false;
  var DEFAULT_MAIN_MIB = 256;
  var DEFAULT_SUBAGENT_MIB = 192;
  // Both directions are allowed: a weak machine may want LESS than Anthropic's
  // numbers. Outside this range a number is clamped, as coworkGlowOpacity is.
  var MIN_MIB = 8;
  var MAX_MIB = 4096;
  var MIB = 1048576;
  var ENV_NAME = "CDB_TRANSCRIPT_LIMITS";
  var JSONC_NAME = "claude-desktop-extra.jsonc";
  var JSON_NAME = "claude-desktop-extra.json";

  function log(m) { (globalThis.__cdbDiag || console.log)("[transcript-limits] " + m); }

  function userDir() {
    try { return _app.getPath("userData"); } catch (e) { return null; }
  }
  // Same as every other config consumer (js/files_quick_open_main.js,
  // extra_settings_main.js, growthbook_overrides.js): the one-time
  // claude-desktop-bin.* -> claude-desktop-extra.* rename migration is installed
  // by the custom-themes patch and same-anchor prefix injections stack in reverse,
  // so it may not have run yet when we get here. Nudging it before every path
  // resolution is defence-in-depth against a write landing first and orphaning a
  // user's legacy config.
  function pathFor(name) {
    try { (globalThis.__cdbCfgMigrate || function () {})(); } catch (e) {}
    var d = userDir();
    return d ? _path.join(d, name) : null;
  }

  // Comment/trailing-comma stripper for the .jsonc/.json config files. Whole
  // quoted strings are matched FIRST and passed through untouched, so a string
  // VALUE containing "//" (a path fragment, not just a URL) survives.
  function stripComments(s) {
    return String(s)
      .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, function (m, q) { return q ? q : ""; })
      .replace(/,(\s*[}\]])/g, "$1");
  }
  // LENIENT reader for the read-only paths: any problem - missing file,
  // unparseable JSON, wrong shape - is reported as "nothing set here" and falls
  // through to the next source. Safe because nothing is written back; writePref
  // below does NOT use it for its own existing-file read.
  function readFileJson(p) {
    try {
      if (!p || !_fs.existsSync(p)) return null;
      var stripped = stripComments(_fs.readFileSync(p, "utf8"));
      var v = stripped.trim() ? JSON.parse(stripped) : {};
      return (v && typeof v === "object" && !Array.isArray(v)) ? v : null;
    } catch (e) { return null; }
  }

  // The .jsonc is the HUMAN-OWNED file and wins the startup merge per key, so a
  // switch value found there is reported as locked and pref-set refuses to fight
  // it instead of writing a .json the merge would then ignore.
  function pick(jsonc, json, key, test) {
    if (jsonc && test(jsonc[key])) return { value: jsonc[key], source: "jsonc" };
    if (json && test(json[key])) return { value: json[key], source: "json" };
    return null;
  }
  function isBool(v) { return typeof v === "boolean"; }
  function isSet(v) { return v !== undefined; }

  function readConfig() {
    var jsonc = readFileJson(pathFor(JSONC_NAME));
    var json = readFileJson(pathFor(JSON_NAME));
    var en = pick(jsonc, json, PREF_KEY, isBool);
    // Same as coworkGlowOpacity (patches/community/add_feature_cowork_glow.nim):
    // a number, or a string parseFloat can read (a quoted "512" is an easy slip in
    // hand-edited JSON), is clamped into range; anything else falls back to the
    // default. Nothing here warns - the effective numbers are what the row and the
    // startup log show.
    function mib(key, dflt) {
      var hit = pick(jsonc, json, key, isSet);
      if (!hit) return dflt;
      var v = hit.value;
      var n = typeof v === "number" ? v : parseFloat(v);
      if (!isFinite(n)) return dflt;
      return Math.round(Math.min(MAX_MIB, Math.max(MIN_MIB, n)));
    }
    return {
      enabled: en ? en.value : PREF_DEFAULT,
      source: en ? (en.source === "jsonc" ? "jsonc-locked" : "json") : "default",
      mainMiB: mib(MAIN_KEY, DEFAULT_MAIN_MIB),
      subagentMiB: mib(SUBAGENT_KEY, DEFAULT_SUBAGENT_MIB)
    };
  }

  // See the header: per-session ceiling >= main + subagents (1.25x for headroom
  // while a live session grows), total = 2x the per-session ceiling.
  function derive(mainMiB, subagentMiB) {
    var entry = Math.ceil((mainMiB + subagentMiB) * 1.25);
    return {
      mainBytes: mainMiB * MIB,
      subagentBytes: subagentMiB * MIB,
      cachedEntryBytes: entry * MIB,
      cachedTotalBytes: entry * 2 * MIB
    };
  }

  // What this process hands out for its whole life. Read once here, at startup.
  var startup = readConfig();
  var active = startup.enabled ? derive(startup.mainMiB, startup.subagentMiB) : null;

  var handedOut = 0, handedPending = [];
  globalThis.__cdbTranscriptLimits = function () {
    // Two managers ask (the session manager and the sidebar's reader); log the
    // first two answers so the log proves the hook actually fired, not merely
    // that this module was installed.
    handedOut++;
    if (handedOut <= 2) handedPending.push(handedOut);
    flushLog();
    return active ? Object.assign({}, active) : undefined;
  };

  // The heavy-work utility process gets the same numbers through its
  // environment. Electron's utilityProcess.fork() with no `env` option hands the
  // child the browser process's INITIAL environment, not the live process.env -
  // sub-patch B of add_feature_files_quick_open.nim makes the generic worker host
  // fork with `env: Object.assign({}, process.env)`, which is what carries this to
  // the worker (add_feature_transcript_limits.nim asserts that as a precondition
  // and fails the build if it is ever missing). Unset when off, so an inherited
  // value can never switch it on behind the pref's back.
  try {
    if (active) {
      process.env[ENV_NAME] = [active.mainBytes, active.subagentBytes,
        active.cachedEntryBytes, active.cachedTotalBytes].join(",");
    } else {
      delete process.env[ENV_NAME];
    }
  } catch (e) {}

  function pendingRestart(cfg) {
    if (!!active !== cfg.enabled) return true;
    return cfg.enabled &&
      (cfg.mainMiB * MIB !== active.mainBytes || cfg.subagentMiB * MIB !== active.subagentBytes);
  }
  function report(cfg) {
    return {
      ok: true,
      enabled: cfg.enabled,
      lockedByJsonc: cfg.source === "jsonc-locked",
      source: cfg.source,
      mainMiB: cfg.mainMiB,
      subagentMiB: cfg.subagentMiB,
      // What the RUNNING app was started with, so the row can tell a saved
      // change from a live one.
      activeNow: !!active,
      activeMainMiB: active ? active.mainBytes / MIB : null,
      activeSubagentMiB: active ? active.subagentBytes / MIB : null,
      pendingRestart: pendingRestart(cfg)
    };
  }

  // Writes ONLY the .json (the .jsonc is never created or rewritten here), tmp +
  // rename so a crash cannot leave half a file, and every other key survives.
  //
  // An existing-but-broken file is NOT silently treated as empty: that would make
  // pref-set report success while quietly discarding every other extra's settings
  // the moment a hand-edited file has a stray comma. ENOENT is the only case that
  // proceeds with an empty object; every other read/parse/shape failure refuses
  // and writes nothing.
  function writePref(value) {
    var p = pathFor(JSON_NAME);
    if (!p) return { ok: false, error: "no userData path" };
    var raw = null;
    try { raw = _fs.readFileSync(p, "utf8"); }
    catch (e) {
      if (e.code !== "ENOENT") return { ok: false, error: "cannot read " + p + ": " + ((e && e.message) || String(e)) };
    }
    var cfg = {};
    if (raw !== null) {
      var stripped = stripComments(raw);
      try { cfg = stripped.trim() ? JSON.parse(stripped) : {}; }
      catch (e2) {
        return { ok: false, error: p + " is not valid JSON (" + e2.message +
          ") - fix or remove it first; nothing was written" };
      }
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
        return { ok: false, error: p + " must contain a JSON object; nothing was written" };
      }
      if (stripped !== raw) {
        // Rewriting as plain JSON drops comments - keep the original once.
        try { _fs.writeFileSync(p + ".cdb-bak", raw, { flag: "wx" }); } catch (e3) {}
      }
    }
    // The default is FALSE, so "off" is the ABSENCE of the key: a fresh install
    // and one that switched the feature back off look the same on disk, and only
    // an explicit opt-in ever writes anything.
    if (value === PREF_DEFAULT) delete cfg[PREF_KEY];
    else cfg[PREF_KEY] = value;
    var tmp = p + ".cdb-tmp";
    try {
      _fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      _fs.renameSync(tmp, p);
    } catch (e4) {
      try { _fs.unlinkSync(tmp); } catch (e5) {}
      return { ok: false, error: "cannot write " + p + ": " + ((e4 && e4.message) || String(e4)) };
    }
    return { ok: true, path: p };
  }

  // Exact-origin allowlist, same posture as the diff-views, cowork-glow and
  // quick-open sender checks: comparing parsed origins instead of testing whether
  // the raw URL STRING contains "claude.ai" anywhere, which would also pass a
  // lookalike such as "https://claude.ai.evil.example".
  var ALLOWED_ORIGINS = [
    "https://claude.ai",
    "https://preview.claude.ai",
    "https://claude.com",
    "https://preview.claude.com"
  ];
  function originAllowed(rawUrl) {
    var origin;
    try { origin = new _URL(String(rawUrl)).origin; } catch (e) { return false; }
    for (var i = 0; i < ALLOWED_ORIGINS.length; i++) {
      if (origin === ALLOWED_ORIGINS[i]) return true;
    }
    return false;
  }
  // FAILS CLOSED: wc.isDestroyed() is called unguarded - a sender object missing
  // the method throws, the catch below turns that into "not ok", not "assume
  // fine". Do not soften this to a typeof-guard.
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

  _ipc.handle("cdb-tlimits:pref-read", function (ev) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    return report(readConfig());
  });

  _ipc.handle("cdb-tlimits:pref-set", function (ev, enabled) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    if (typeof enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
    var cfg = readConfig();
    if (cfg.source === "jsonc-locked") {
      return { ok: false, error: PREF_KEY + " is set in " + JSONC_NAME +
        " - edit that file to change it" };
    }
    var w = writePref(enabled);
    if (!w.ok) return w;
    var out = report(readConfig());
    out.path = w.path;
    return out;
  });

  // LOGGING. __cdbDiag (the project's logger, fd 2 + userData/logs/claude-patches.log)
  // is defined later, inside upstream's app "ready" handler - NOT within one tick
  // of this IIFE - and plain console.log is discarded by the official build, so a
  // line written at load time (as Files quick open does) is silently lost. So we
  // never write until the logger exists: the "installed" line and each hand-out
  // are queued and flushed as soon as it does (polled, then on every hand-out).
  var announced = false, tries = 0;
  function summary() {
    return active
      ? "on: main " + startup.mainMiB + " MiB, subagents " + startup.subagentMiB + " MiB, parse cache " +
        (active.cachedEntryBytes / MIB) + " MiB per session / " + (active.cachedTotalBytes / MIB) + " MiB total"
      : "off - passing nothing, Anthropic's limits apply";
  }
  function flushLog() {
    if (typeof globalThis.__cdbDiag !== "function") return false;
    if (!announced) {
      announced = true;
      log("installed (main); " + PREF_KEY + "=" + (active ? "on" : "off") + " (source: " + startup.source +
        ")" + (active ? "" : " - Anthropic's limits untouched"));
    }
    while (handedPending.length) {
      log("session manager #" + handedPending.shift() + " asked for limits -> " + summary());
    }
    return true;
  }
  function poll() {
    if (flushLog()) return;
    if (++tries < 60) setTimeout(poll, 500);
  }
  setTimeout(poll, 0);
})();
