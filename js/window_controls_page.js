/*
 * window_controls_page.js - PAGE half of the two titlebar-mode opt-ins: closes
 * the empty strip claude.ai leaves where the window controls used to be.
 *
 * Injected into the claude.ai main world by js/window_controls_main.js (as a
 * string, via webContents.executeJavaScript on dom-ready), and only when the
 * RUNNING main window was built without the controls overlay - bare mode
 * (Hide window controls), native mode (Native titlebar) or a transparent
 * window (Transparent window; Electron gives it no overlay).
 *
 * WHY: claude.ai assumes every Windows/Linux desktop window has a Window
 * Controls Overlay and reserves room for its buttons in inline styles such as
 *
 *   paddingRight: calc(16px + max(0px, 100% - env(titlebar-area-x, 0px)
 *                 - env(titlebar-area-width, calc(100% - 120px))))
 *
 * With the overlay on, Chromium defines env(titlebar-area-*) and the fallback
 * is ignored. With it off (the three cases above), the env
 * vars are undefined and the FALLBACK wins - 120px on Linux (140px on Windows,
 * divided by the zoom factor in some callers), i.e. the gap.
 *
 * WHAT: rewrite only the fallbacks to "no caption buttons":
 *
 *   env(titlebar-area-x, <N>px)                 -> env(titlebar-area-x, 0px)
 *   env(titlebar-area-width, calc(<B> - <N>px)) -> env(titlebar-area-width, <B>)
 *
 * which covers both the LTR (x 0, width B - N) and RTL (x N, width B - 2N)
 * shapes upstream emits. Because a fallback only applies when the env var is
 * undefined, this cannot change a window that DOES have the overlay - the
 * gating in window_controls_main.js keeps the observer away from the default
 * integrated mode anyway, it is not what makes the rewrite safe.
 *
 * HOW: every use upstream ships is an inline style (none in a stylesheet), so
 * one MutationObserver on `style` attributes and inserted subtrees catches
 * them all. Observer callbacks run at the microtask checkpoint after React's
 * commit, before the next paint, so the gap never flashes. A rewritten value
 * no longer changes when rewritten again, so our own setAttribute cannot loop.
 */
;/*__CDB_WINCTL_PAGE__*/(function () {
  "use strict";
  if (window.__cdbWcoInset) return;

  var NEEDLE = "titlebar-area";
  var X_RE = /env\(\s*titlebar-area-x\s*,\s*[\d.]+px\s*\)/g;
  var W_RE = /env\(\s*titlebar-area-width\s*,\s*calc\(\s*([^()]+?)\s+-\s+[\d.]+px\s*\)\s*\)/g;

  function rewrite(s) {
    if (typeof s !== "string" || s.indexOf(NEEDLE) < 0) return s;
    return s
      .replace(X_RE, "env(titlebar-area-x, 0px)")
      .replace(W_RE, function (_m, base) { return "env(titlebar-area-width, " + base + ")"; });
  }

  function fixElement(el) {
    if (!el || el.nodeType !== 1) return;
    var s = el.getAttribute("style");
    if (!s || s.indexOf(NEEDLE) < 0) return;
    var n = rewrite(s);
    if (n !== s) el.setAttribute("style", n);
  }

  // React builds subtrees detached and sets their styles before insertion, so
  // an inserted node produces a childList record but no attribute record.
  function fixTree(node) {
    if (!node || node.nodeType !== 1) return;
    fixElement(node);
    var list = node.querySelectorAll('[style*="' + NEEDLE + '"]');
    for (var i = 0; i < list.length; i++) fixElement(list[i]);
  }

  window.__cdbWcoInset = { rewrite: rewrite, fixElement: fixElement };

  var root = document.documentElement;
  if (!root) return;
  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r.type === "attributes") {
        fixElement(r.target);
      } else {
        for (var j = 0; j < r.addedNodes.length; j++) fixTree(r.addedNodes[j]);
      }
    }
  }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["style"] });
  fixTree(root);
})();
