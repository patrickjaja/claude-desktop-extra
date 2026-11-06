/*
 * auto_archive_grace_web_main.js - main-process half of the archive grace UI
 * for 1P mode, injected by patches/community/add_feature_auto_archive_grace_web.nim.
 *
 * Runs js/auto_archive_grace_web_page.js (embedded below) in every claude.ai /
 * claude.com page on dom-ready, the same route as panel tabs. The page does one
 * read of the delay and installs nothing more while it is Immediately.
 * globalThis.__cdbArchiveGraceWebRefresh() re-runs it in every such page; the
 * Extra settings handler calls it after the delay changes, so a change applies
 * without a reload. app://localhost (3P) is skipped: there the ion-dist patch
 * renders the same UI inside upstream's components.
 *
 * The page talks to main only through the fixed cdbExtra channels
 * cdb-archive-grace:read / :keep (js/extra_settings_main.js, origin-checked).
 */
;/*__CDB_ARCHIVE_GRACE_WEB__*/(function () {
  "use strict";
  if (typeof process === "undefined" || process.platform !== "linux") return;
  if (globalThis.__cdbArchiveGraceWebMain) return;
  globalThis.__cdbArchiveGraceWebMain = true;

  var _electron = require("electron");
  var _URL = require("url").URL;
  var PAGE_SRC = "__CDB_ARCHIVE_GRACE_WEB_PAGE_SRC__";

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
  function inject(wc) {
    try {
      if (!wc || wc.isDestroyed() || !injectHost(wc.getURL() || "")) return;
      wc.executeJavaScript(PAGE_SRC).catch(function () {});
    } catch (e) {}
  }

  _electron.app.on("web-contents-created", function (_ev, wc) {
    wc.on("dom-ready", function () { inject(wc); });
  });

  globalThis.__cdbArchiveGraceWebRefresh = function () {
    try { _electron.webContents.getAllWebContents().forEach(inject); } catch (e) {}
  };
})();
