/*
 * github_alerts_main.js - main-process half of the GitHub alert callouts,
 * injected by patches/community/add_feature_github_alerts.nim.
 *
 * Runs js/github_alerts_page.js (embedded below) in every claude.ai / claude.com
 * page on dom-ready, after inserting js/github_alerts.css with insertCSS (not
 * subject to the page CSP and scoped to the live document, so it is re-inserted
 * per document with the previous key dropped). app://localhost (3P mode) is
 * skipped: the chat there is served by the ion-dist bundle, which this patch
 * does not touch.
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
 * after a switch or a lock changes) re-runs the page script in every open
 * claude.ai page, including the teardown call when the feature is switched off.
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
    var ud;
    try { ud = _electron.app.getPath("userData"); } catch (e) { return { enabled: false, icons: true }; }
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
  // sender's exact origin. 1P hosts only (no app://localhost).
  function injectHost(rawUrl) {
    var u;
    try { u = new _URL(String(rawUrl)); } catch (e) { return false; }
    if (u.protocol !== "https:") return false;
    var host = u.hostname;
    return host === "claude.ai" || host.endsWith(".claude.ai") ||
      host === "claude.com" || host.endsWith(".claude.com");
  }

  var cssKeys = new WeakMap(); // webContents -> the insertCSS key of the live document
  var injected = new WeakSet(); // webContents that already carry the page script

  function runPage(wc, opts) {
    var src = "var __CDB_GH_ALERTS_OPTS=" + JSON.stringify(opts) + ";\n" + PAGE_SRC;
    var p = wc.executeJavaScript(src);
    if (p && p.catch) p.catch(function () {});
    if (opts.enabled) injected.add(wc);
  }

  function dropCss(wc) {
    var old = cssKeys.get(wc);
    cssKeys.delete(wc);
    if (old) { var r = wc.removeInsertedCSS(old); if (r && r.catch) r.catch(function () {}); }
  }

  function inject(wc) {
    try {
      if (!wc || wc.isDestroyed() || !injectHost(wc.getURL() || "")) return;
      var opts = settings();
      if (!opts.enabled) {
        dropCss(wc);
        // Only a page that already carries the script needs the teardown run.
        if (injected.has(wc)) { injected.delete(wc); runPage(wc, opts); }
        return;
      }
      dropCss(wc);
      var q = wc.insertCSS(PAGE_CSS);
      if (q && q.then) q.then(function (k) { if (!wc.isDestroyed()) cssKeys.set(wc, k); }, function () {});
      runPage(wc, opts);
    } catch (e) {}
  }

  _electron.app.on("web-contents-created", function (_ev, wc) {
    wc.on("dom-ready", function () { inject(wc); });
  });

  globalThis.__cdbGithubAlertsRefresh = function () {
    try { _electron.webContents.getAllWebContents().forEach(inject); } catch (e) {}
  };
})();
