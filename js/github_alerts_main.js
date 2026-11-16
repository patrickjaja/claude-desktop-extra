/*
 * github_alerts_main.js - main-process half of the GitHub alert callouts,
 * injected by patches/community/add_feature_github_alerts.nim.
 *
 * Runs js/github_alerts_page.js (embedded below) in every claude.ai / claude.com
 * and 3P app://localhost chat page (skipping /setup-desktop-3p) on dom-ready,
 * after inserting js/github_alerts.css with insertCSS (not subject to the page
 * CSP and scoped to the live document, so it is re-inserted per document with
 * the previous key dropped).
 *
 * Both switches live in claude-desktop-extra.json / .jsonc and are read here on
 * every page load, so a change applies to the next page and no restart:
 *   githubAlerts      - the feature, off by default
 *   githubAlertIcons  - draw the SVG icon next to the label, default off (the
 *                       accent bar and the label carry the callout on their own)
 * The .jsonc wins per key over the .json, the same merge the settings page and
 * the app use.
 *
 * globalThis.__cdbGithubAlertsRefresh() (called by the Extra settings handlers
 * after a switch or a lock changes) re-runs the page script in every open chat
 * page, including the teardown call when the feature is switched off.
 */
;/*__CDB_GITHUB_ALERTS__*/(function () {
  "use strict";
  if (typeof process === "undefined" || process.platform !== "linux") return;
  if (globalThis.__cdbGithubAlertsMain) return;
  globalThis.__cdbGithubAlertsMain = true;

  var _electron = require("electron");
  var _fs = require("fs");
  var _path = require("path");
  var _URL = require("url").URL;
  // Both placeholders are replaced by the patch with escaped source strings.
  var PAGE_SRC = "__CDB_GH_ALERTS_PAGE_SRC__";
  var PAGE_CSS = "__CDB_GH_ALERTS_CSS__";

  // __cdbDiag (claude-patches.log) is defined inside upstream's app "ready"
  // handler, which runs after this IIFE, so lines logged before the sink
  // exists are queued and flushed one tick after "ready".
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
    var line = "[github-alerts] " + m;
    if (logQueue && typeof globalThis.__cdbDiag !== "function") { logQueue.push(line); return; }
    flushLog();
    emitLog(line);
  }
  try { _electron.app.whenReady().then(function () { setTimeout(flushLog, 0); }, function () {}); }
  catch (e) { setTimeout(flushLog, 0); }

  // JSONC comment + trailing-comma stripping. Byte-identical in behavior to
  // __cdbEx_strip() in js/extra_settings_main.js and stripJsonComments() in
  // js/growthbook_overrides.js: the three must agree about what a key is set to.
  function stripJsonc(s) {
    var out = "", inStr = false, i = 0;
    while (i < s.length) {
      var c = s[i];
      if (inStr) {
        out += c;
        if (c === "\\" && i + 1 < s.length) { out += s[i + 1]; i++; }
        else if (c === '"') inStr = false;
        i++;
        continue;
      }
      if (c === '"') { inStr = true; out += c; i++; continue; }
      if (c === "/" && s[i + 1] === "/") { while (i < s.length && s[i] !== "\n") i++; continue; }
      if (c === "/" && s[i + 1] === "*") { i += 2; while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++; i += 2; continue; }
      if (c === ",") {
        var j = i + 1;
        while (j < s.length) {
          if (s[j] === " " || s[j] === "\t" || s[j] === "\r" || s[j] === "\n") { j++; continue; }
          if (s[j] === "/" && s[j + 1] === "/") { while (j < s.length && s[j] !== "\n") j++; continue; }
          if (s[j] === "/" && s[j + 1] === "*") { j += 2; while (j < s.length && !(s[j] === "*" && s[j + 1] === "/")) j++; j += 2; continue; }
          break;
        }
        if (s[j] === "}" || s[j] === "]") { i++; continue; }
      }
      out += c;
      i++;
    }
    return out;
  }

  function readKey(file, key) {
    var raw;
    try { raw = _fs.readFileSync(file, "utf8"); } catch (e) { return undefined; }
    try {
      var cfg = JSON.parse(stripJsonc(raw) || "{}");
      if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) return cfg[key];
    } catch (e2) {}
    return undefined;
  }

  function settings() {
    try { (globalThis.__cdbCfgMigrate || function () {})(); } catch (e) {}
    var ud;
    try { ud = _electron.app.getPath("userData"); } catch (e) { return { enabled: false, icons: false }; }
    var json = _path.join(ud, "claude-desktop-extra.json");
    var jsonc = _path.join(ud, "claude-desktop-extra.jsonc");
    var jcOn = readKey(jsonc, "githubAlerts");
    var jsOn = readKey(json, "githubAlerts");
    var jcIcons = readKey(jsonc, "githubAlertIcons");
    var jsIcons = readKey(json, "githubAlertIcons");
    return {
      enabled: (jcOn === undefined ? jsOn : jcOn) === true,
      icons: (jcIcons === undefined ? jsIcons : jcIcons) === true
    };
  }

  // Only decides where to run the page script; the IPC handlers re-check the
  // sender's exact origin. Covers 1P hosts and 3P app://localhost chat pages
  // (excluding the 3P setup wizard).
  function injectHost(rawUrl) {
    var u;
    try { u = new _URL(String(rawUrl)); } catch (e) { return false; }
    if (u.protocol === "app:" && u.host === "localhost") {
      return !/^\/+setup-desktop-3p(?:\/|$)/i.test(u.pathname || "");
    }
    if (u.protocol !== "https:") return false;
    var host = u.hostname;
    return host === "claude.ai" || host.endsWith(".claude.ai") ||
      host === "claude.com" || host.endsWith(".claude.com");
  }

  var cssKeys = new WeakMap(); // webContents -> the insertCSS key of the live document
  var cssGen = new WeakMap(); // webContents -> generation counter to drop stale insertCSS resolves
  var injected = new WeakSet(); // webContents that already carry the page script

  function runPage(wc, opts) {
    var src = "var __CDB_GH_ALERTS_OPTS=" + JSON.stringify(opts) + ";\n" + PAGE_SRC;
    var p = wc.executeJavaScript(src);
    if (p && p.catch) p.catch(function () {});
    if (opts.enabled) injected.add(wc);
  }

  function dropCss(wc) {
    var g = (cssGen.get(wc) || 0) + 1;
    cssGen.set(wc, g);
    var old = cssKeys.get(wc);
    cssKeys.delete(wc);
    if (old) { var r = wc.removeInsertedCSS(old); if (r && r.catch) r.catch(function () {}); }
  }

  function inject(wc) {
    try {
      if (!wc || wc.isDestroyed()) return;
      if (!injectHost(wc.getURL() || "")) {
        if (cssGen.has(wc)) dropCss(wc);
        injected.delete(wc);
        return;
      }
      var opts = settings();
      if (!opts.enabled) {
        dropCss(wc);
        // Only a page that already carries the script needs the teardown run.
        if (injected.has(wc)) { injected.delete(wc); runPage(wc, opts); }
        return;
      }
      dropCss(wc);
      var myGen = cssGen.get(wc);
      var q = wc.insertCSS(PAGE_CSS);
      if (q && q.then) {
        q.then(function (k) {
          if (wc.isDestroyed()) return;
          if (cssGen.get(wc) !== myGen) {
            var r = wc.removeInsertedCSS(k);
            if (r && r.catch) r.catch(function () {});
            return;
          }
          cssKeys.set(wc, k);
        }, function () {});
      }
      runPage(wc, opts);
    } catch (e) {}
  }

  _electron.app.on("web-contents-created", function (_ev, wc) {
    wc.on("dom-ready", function () { inject(wc); });
  });

  globalThis.__cdbGithubAlertsRefresh = function () {
    var opts = settings();
    log("refresh: githubAlerts=" + opts.enabled + ", githubAlertIcons=" + opts.icons);
    try { _electron.webContents.getAllWebContents().forEach(inject); } catch (e) {}
  };

  setTimeout(function () {
    var opts = settings();
    log("installed (main); githubAlerts=" + opts.enabled + ", githubAlertIcons=" + opts.icons);
  }, 0);
})();
