/*
 * cowork_device_icon_web_main.js - main-process half of the Cowork device icon
 * in the claude.ai chat header (1P mode), injected by
 * patches/linux/fix_cowork_device_icon_web.nim.
 *
 * Runs js/cowork_device_icon_web_page.js (embedded below) in every claude.ai /
 * claude.com page on dom-ready, after inserting its stylesheet (insertCSS is
 * not subject to the page's CSP and is scoped to the live document, so it is
 * re-inserted per document with the previous key dropped). The page script
 * installs only in the main view (the one with the cdbExtra bridge).
 * app://localhost (3P) is skipped: cloud Cowork does not exist there.
 * globalThis.__cdbCoworkIconWebRefresh() re-runs it in every such page.
 *
 * The page talks to main only through the fixed cdbExtra channels
 * cdb-cu-status:icon, cdb-extra:open-settings and cdb-extra:diag
 * (js/extra_settings_main.js, origin-checked).
 */
;/*__CDB_COWORK_ICON_WEB__*/(function () {
  "use strict";
  if (typeof process === "undefined" || process.platform !== "linux") return;
  if (globalThis.__cdbCoworkIconWebMain) return;
  globalThis.__cdbCoworkIconWebMain = true;

  var _electron = require("electron");
  var _URL = require("url").URL;
  var PAGE_SRC = "__CDB_COWORK_ICON_WEB_PAGE_SRC__";
  // Theme tokens only (claude.ai's --cds-* design tokens), with neutral
  // fallbacks so a renamed token degrades to a plain look, never to nothing.
  var PAGE_CSS = [
    ".cdb-cowork-icon-slot{display:inline-flex;align-items:center}",
    ".cdb-cowork-icon{position:relative;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;",
    "width:var(--cds-h-control,2rem);height:var(--cds-h-control,2rem);padding:0;margin:0;border:0;",
    "border-radius:var(--cds-radius--sm,.375rem);background:transparent;color:var(--cds-text-secondary,currentColor);cursor:pointer}",
    ".cdb-cowork-icon:hover,.cdb-cowork-icon[aria-expanded=\"true\"]{background:var(--cds-fill-ghost-hover,rgba(127,127,127,.14));color:var(--cds-text-primary,currentColor)}",
    ".cdb-cowork-icon:focus-visible,.cdb-cowork-icon-action:focus-visible{outline:none;box-shadow:var(--cds-focus-shadow,0 0 0 2px Highlight)}",
    ".cdb-cowork-icon>svg{width:1.125rem;height:1.125rem;display:block}",
    ".cdb-cowork-icon-badge{position:absolute;right:15%;bottom:18%;width:.625rem;height:.625rem;border-radius:999px;display:none;",
    "box-shadow:0 0 0 2px var(--cds-page-bg,Canvas);color:var(--cds-page-bg,#fff)}",
    ".cdb-cowork-icon-badge>svg{width:100%;height:100%;display:block}",
    ".cdb-cowork-icon[data-cdb-cowork-icon=\"keyless\"] .cdb-cowork-icon-badge{display:block;background:var(--cds-fill-danger,#c9372c)}",
    ".cdb-cowork-icon[data-cdb-cowork-icon=\"keyed-unbound\"] .cdb-cowork-icon-badge{display:block;background:var(--cds-fill-warning,#c98a14)}",
    ".cdb-cowork-icon-pop{position:fixed;z-index:2147483000;box-sizing:border-box;width:280px;max-width:calc(100vw - 16px);padding:.75rem;",
    "border-radius:var(--cds-radius--lg,.75rem);border:1px solid var(--cds-border,rgba(127,127,127,.3));",
    "background:var(--cds-surface-popover,var(--cds-page-bg,Canvas));color:var(--cds-text-primary,CanvasText);",
    "box-shadow:var(--cds-shadow-popover,0 8px 24px rgba(0,0,0,.18));font-size:var(--cds-font-size-body,.875rem);line-height:1.4}",
    ".cdb-cowork-icon-pop-title{font-weight:600;margin:0 0 .25rem}",
    ".cdb-cowork-icon-pop-text{color:var(--cds-text-secondary,inherit);font-size:var(--cds-font-size-footnote,.8125rem);margin:0 0 .5rem}",
    ".cdb-cowork-icon-action{display:flex;align-items:center;justify-content:flex-start;width:100%;box-sizing:border-box;",
    "min-height:var(--cds-h-control,2rem);padding:0 .75rem;border:0;border-radius:var(--cds-radius--sm,.375rem);",
    "background:transparent;color:var(--cds-text-primary,inherit);font:inherit;cursor:pointer;text-align:left}",
    ".cdb-cowork-icon-action:hover{background:var(--cds-fill-ghost-hover,rgba(127,127,127,.14))}"
  ].join("");

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
  function inject(wc, withCss) {
    try {
      if (!wc || wc.isDestroyed() || !injectHost(wc.getURL() || "")) return;
      if (withCss) {
        var old = cssKeys.get(wc);
        cssKeys.delete(wc);
        if (old) { var r = wc.removeInsertedCSS(old); if (r && r.catch) r.catch(function () {}); }
        var q = wc.insertCSS(PAGE_CSS);
        if (q && q.then) q.then(function (k) { if (!wc.isDestroyed()) cssKeys.set(wc, k); }, function () {});
      }
      var p = wc.executeJavaScript(PAGE_SRC);
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }

  _electron.app.on("web-contents-created", function (_ev, wc) {
    wc.on("dom-ready", function () { inject(wc, true); });
  });

  globalThis.__cdbCoworkIconWebRefresh = function () {
    try { _electron.webContents.getAllWebContents().forEach(function (wc) { inject(wc, false); }); } catch (e) {}
  };
})();
