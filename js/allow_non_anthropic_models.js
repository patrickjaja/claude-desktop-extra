/*
 * allow_non_anthropic_models.js - let a third-party gateway's non-Anthropic
 * models through the model list, injected at the head of the main bundle by
 * patches/community/add_feature_allow_non_anthropic_models.nim.
 *
 * WHY THIS EXISTS
 * Upstream (Anthropic's own bundle, not this package) validates every model ID
 * in a 3P config against a name check: a denylist regex of non-Anthropic
 * families (deepseek, qwen, glm, kimi/moonshot, gpt-oss, ...) plus an allowlist
 * of Anthropic families (sonnet|opus|haiku|fable|mythos). A gateway route whose
 * ID is neither - e.g. `melious/deepseek-v4.1-flash` or `inceptron/zai-org/GLM-5.3`
 * - is dropped from the model list, and the runtime session gate falls back to
 * the default model. On a gateway the user controls, that is exactly the model
 * they asked for, so this module offers a switch to relax that one check.
 *
 * WHAT IT CHANGES
 * Nothing by itself. It exposes globalThis.__cdbAllowNonAnthropicModels() and
 * the patch consults it at upstream's three gateway name checks (the gateway
 * model validator, /v1/models discovery and the tier-pin sanitizer), so a
 * non-Anthropic route is accepted ONLY while the user has opted in.
 * Every other check is left alone: tier aliases, admin allow-lists, the
 * app-catalog / newer-desktop gate, and the HIPAA restriction all still apply.
 *
 * CONFIG
 *   allowNonAnthropicModels  bool  default false
 * in <userData>/claude-desktop-extra.json (written by Settings -> Extra) or
 * .jsonc (hand-owned, WINS; the Settings control then shows as locked). No env
 * override. The value is per mode: 3P/gateway mode runs with its own userData
 * (~/.config/Claude-3p), so set it while in that mode. The model list is built
 * once at startup, so a change applies on the next RESTART - the same as the
 * other constructor-time switches.
 *
 * Everything here never throws: a broken config file means "off".
 */
;/*__CDB_ALLOW_NONANTHROPIC__*/(function () {
  "use strict";
  if (typeof process === "undefined" || process.platform !== "linux") {
    globalThis.__cdbAllowNonAnthropicModels = function () { return false; };
    return;
  }
  if (globalThis.__cdbAllowNonAnthropicModels) return;

  var _fs = require("fs");
  var _path = require("path");
  var _electron = require("electron");
  var _ipc = _electron.ipcMain;

  var KEY_ON = "allowNonAnthropicModels";
  var PREF_DEFAULT = false;
  var JSONC_NAME = "claude-desktop-extra.jsonc";
  var JSON_NAME = "claude-desktop-extra.json";
  var LEGACY_JSONC_NAME = "claude-desktop-bin.jsonc";
  var LEGACY_JSON_NAME = "claude-desktop-bin.json";

  // __cdbDiag (claude-patches.log) is defined inside upstream's app "ready"
  // handler - not within one tick of this IIFE - and the official build
  // discards console.log. So a line is queued until the logger exists, polled
  // every 500 ms for up to 30 s (the same shape as transcript_limits_main.js);
  // after that console.log is the last resort.
  var logQueue = [], tries = 0;
  function emitLog(line) {
    try { (globalThis.__cdbDiag || console.log)(line); } catch (e) {}
  }
  function flushLog(force) {
    if (!force && typeof globalThis.__cdbDiag !== "function") return false;
    var q = logQueue;
    logQueue = [];
    for (var i = 0; i < q.length; i++) emitLog(q[i]);
    return true;
  }
  function log(m) {
    logQueue.push("[cdb-models] " + m);
    flushLog(false);
  }
  function poll() {
    if (flushLog(false)) return;
    if (++tries < 60) setTimeout(poll, 500);
    else flushLog(true);
  }

  // Same string-aware comment/trailing-comma stripper as the other pref readers.
  function cfgStrip(s) {
    return String(s)
      .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, function (m, q) { return q ? q : ""; })
      .replace(/,(\s*[}\]])/g, "$1");
  }
  function cfgReadFile(p) {
    try {
      if (!p || !_fs.existsSync(p)) return null;
      var stripped = cfgStrip(_fs.readFileSync(p, "utf8"));
      var v = stripped.trim() ? JSON.parse(stripped) : {};
      return (v && typeof v === "object" && !Array.isArray(v)) ? v : null;
    } catch (e) { return null; }
  }
  function cfgPaths() {
    try { (globalThis.__cdbCfgMigrate || function () {})(); } catch (e) {}
    var d = _electron.app.getPath("userData");
    return {
      json: _path.join(d, JSON_NAME),
      jsonc: _path.join(d, JSONC_NAME),
      legacyJson: _path.join(d, LEGACY_JSON_NAME),
      legacyJsonc: _path.join(d, LEGACY_JSONC_NAME)
    };
  }
  function cfgPick(newPath, oldPath) {
    var v = cfgReadFile(newPath);
    return v !== null ? v : cfgReadFile(oldPath);
  }
  // {value, source}. The .jsonc is the human-owned file and wins, so a value
  // found there is reported as locked and pref-set refuses to fight it.
  function readPrefFromDisk() {
    var p = cfgPaths();
    var jsonc = cfgPick(p.jsonc, p.legacyJsonc);
    if (jsonc && typeof jsonc[KEY_ON] === "boolean") {
      return { value: jsonc[KEY_ON], source: "jsonc-locked" };
    }
    var json = cfgPick(p.json, p.legacyJson);
    if (json && typeof json[KEY_ON] === "boolean") {
      return { value: json[KEY_ON], source: "json" };
    }
    return { value: PREF_DEFAULT, source: "default" };
  }
  // Writes ONLY the .json, tmp + rename, and every other key survives. The
  // default is false, so "off" is the ABSENCE of the key.
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
        try { _fs.writeFileSync(p.json + ".cdb-bak", raw, { flag: "wx" }); } catch (e3) {}
      }
    }
    if (value === PREF_DEFAULT) delete cfg[KEY_ON];
    else cfg[KEY_ON] = value;
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

  // The value the RUNNING process uses, memoized: the model list was built with
  // this answer at startup, and the row compares it against the saved value to
  // know whether a restart is pending.
  var active = null;
  function wanted() {
    if (active !== null) return active;
    active = readPrefFromDisk().value === true;
    return active;
  }

  // The patch consults this at upstream's three gateway name checks and when
  // it builds the Setup window's --desktop-features (the ion-dist half).
  globalThis.__cdbAllowNonAnthropicModels = wanted;

  // ---- the Extra settings switch -------------------------------------------
  //
  // OUR channels, invoked from the Extra settings page through window.cdbExtra,
  // the same cross-patch arrangement the diff-views and panel-tabs switches use.
  // The upstream check runs once at startup, so both handlers report; only the
  // on-disk value changes without a restart.
  // The IPC sender validator is shared: js/sender_guard.js (issue #318). Looked up
  // at call time; a missing guard fails closed.
  function okSender(ev) { var g = globalThis.__cdbSenderGuard; return !!g && g.okSender(ev); }

  function handle(channel, fn) {
    try {
      _ipc.handle(channel, function (ev) {
        if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
        try {
          return fn.apply(null, Array.prototype.slice.call(arguments, 1));
        } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
      });
    } catch (e) { log("could not register " + channel + ": " + ((e && e.message) || e)); }
  }

  handle("cdb-mb:pref-read", function () {
    var disk = readPrefFromDisk();
    var p = cfgPaths();
    return {
      ok: true,
      // enabled is the SAVED value, activeNow what this running process
      // started with; the row says "after a restart" while they differ.
      enabled: disk.value === true,
      activeNow: wanted() === true,
      source: disk.source,
      defaultEnabled: PREF_DEFAULT,
      // A hand-edited .jsonc wins the startup merge, so the switch shows itself
      // as locked instead of silently disagreeing with the file.
      lockedByJsonc: disk.source === "jsonc-locked",
      key: KEY_ON,
      jsonPath: p.json,
      jsoncPath: p.jsonc
    };
  });

  handle("cdb-mb:pref-set", function (enabled) {
    if (typeof enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
    var disk = readPrefFromDisk();
    if (disk.source === "jsonc-locked") {
      return { ok: false, error: KEY_ON + " is set in " + JSONC_NAME + " - edit that file to change it" };
    }
    var w = writePref(enabled);
    if (!w.ok) return w;
    var pending = enabled !== wanted();
    log("pref " + KEY_ON + " set to " + enabled + " (" + w.path + ")" +
        (pending ? " - takes effect on restart" : " - matches the running app"));
    return { ok: true, enabled: enabled, path: w.path, pendingRestart: pending };
  });

  log("installed - non-Anthropic model bypass " + (wanted() ? "active" : "off") +
      " (restart applies a change)");
  setTimeout(poll, 0);
})();
