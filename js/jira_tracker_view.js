;/*__CDB_JIRA_VIEW__*/(function () {
  "use strict";
  if (typeof process === "undefined" || process.platform !== "linux") return;
  var DIR = "cdb-jira-tracker";
  var SCRIPT_SLOT = "/*__CDB_JIRA_SCRIPT__*/";
  var HASH_SLOT = "__CDB_JIRA_SCRIPT_HASH__";
  var MAX_EDGE = 100000, REFIT_MS = 50, REFOCUS_MS = 50, PAGE_KEY_MS = 200;
  var WINDOW_EVENTS = ["resize", "maximize", "unmaximize", "restore", "enter-full-screen", "leave-full-screen"];

  function rectOk(r) {
    return !!r && typeof r === "object" && ["x", "y", "width", "height"].every(function (k) {
      return typeof r[k] === "number" && isFinite(r[k]) && r[k] >= 0 && r[k] <= MAX_EDGE;
    });
  }
  function pageHtml(sources, crypto) {
    var script = sources.adf + "\n" + sources.page;
    if (/<\/script/i.test(script)) throw new Error("the page script must not contain </script");
    if (sources.html.split(SCRIPT_SLOT).length !== 2 || sources.html.split(HASH_SLOT).length !== 2) throw new Error("the page template lost a slot");
    var hash = crypto.createHash("sha256").update(script, "utf8").digest("base64");
    return sources.html.split(HASH_SLOT).join(hash).split(SCRIPT_SLOT).join(script);
  }

  function create(deps) {
    var log = deps.log || function () {};
    var view = null, host = null, claude = null, shown = false, written = false, watched = null, refitTimer = null, fullCover = null;

    function same(a, b) { try { return !!a && !!b && !a.isDestroyed() && !b.isDestroyed() && a.id === b.id; } catch (e) { return false; } }
    function hostOf(wc) {
      try {
        if (!wc || wc.isDestroyed()) return null;
        var wins = deps.electron.BrowserWindow.getAllWindows();
        for (var i = 0; i < wins.length; i++) {
          var w = wins[i];
          if (w.isDestroyed() || same(w.webContents, wc)) continue;
          var kids = (w.contentView && w.contentView.children) || [];
          for (var j = 0; j < kids.length; j++) if (same(kids[j].webContents, wc)) return { win: w, view: kids[j] };
        }
      } catch (e) {}
      return null;
    }
    function assets() {
      var dir = deps.path.join(deps.userData(), DIR);
      var html = deps.path.join(dir, "tracker.html"), preload = deps.path.join(dir, "preload.js");
      if (!written) {
        deps.fs.mkdirSync(dir, { recursive: true, mode: 448 });
        deps.fs.writeFileSync(html, pageHtml(deps.sources, deps.crypto), { encoding: "utf8", mode: 384 });
        deps.fs.writeFileSync(preload, deps.sources.preload, { encoding: "utf8", mode: 384 });
        written = true;
      }
      return { html: html, preload: preload };
    }
    function harden(wc) {
      wc.on("will-navigate", function (e) { e.preventDefault(); });
      wc.on("will-redirect", function (e) { e.preventDefault(); });
      wc.on("will-attach-webview", function (e) { e.preventDefault(); });
      wc.setWindowOpenHandler(function () { return { action: "deny" }; });
      wc.on("before-input-event", function (e, input) {
        if (zoomKey(e, input)) return;
        if (deps.onKey) deps.onKey(wc, e, input);
      });
      wc.on("zoom-changed", function () { setTimeout(syncZoom, 0); });
      wc.on("render-process-gone", function () { log("view: page process gone"); destroy(); });
      wc.on("focus", function () { if (deps.onFocus) deps.onFocus(wc); });
    }
    function syncZoom() {
      try {
        if (!view || view.webContents.isDestroyed() || !claude || claude.isDestroyed()) return;
        var z = claude.getZoomFactor() || 1;
        if (view.webContents.getZoomFactor() !== z) view.webContents.setZoomFactor(z);
      } catch (e) {}
    }
    function askPage(sign) {
      var page;
      try { page = Promise.resolve(view.webContents.executeJavaScript("window.__cdbJiraLightboxKey?window.__cdbJiraLightboxKey(" + JSON.stringify(sign) + "):false")).then(function (r) { return r; }, function () { return false; }); }
      catch (x) { page = Promise.resolve(false); }
      return Promise.race([page, new Promise(function (r) { setTimeout(function () { r(false); }, PAGE_KEY_MS); })]);
    }
    function zoomKey(e, input) {
      if (!input || input.type !== "keyDown" || !(input.control || input.meta) || input.alt) return false;
      var k = String(input.key || "");
      var step = k === "=" || k === "+" ? 0.5 : k === "-" || k === "_" ? -0.5 : k === "0" ? 0 : null;
      if (step === null) return false;
      e.preventDefault();
      var sign = step > 0 ? "+" : step < 0 ? "-" : "0";
      askPage(sign).then(function (handled) {
        if (handled === true) return;
        log("view: zoom key " + sign + " from page");
        try {
          if (claude && !claude.isDestroyed()) claude.setZoomLevel(step === 0 ? 0 : claude.getZoomLevel() + step);
        } catch (x) {}
        syncZoom();
        scheduleRefit();
      });
      return true;
    }
    function place(rect) {
      syncZoom();
      var zoom = 1;
      try { zoom = claude.getZoomFactor() || 1; } catch (e) { zoom = 1; }
      var vb = host.view.getBounds();
      var x = Math.ceil(rect.x * zoom), y = Math.ceil(rect.y * zoom);
      var w = Math.max(0, Math.floor((rect.x + rect.width) * zoom) - x), h = Math.max(0, Math.floor((rect.y + rect.height) * zoom) - y);
      w = Math.min(w, Math.max(0, vb.width - x));
      h = Math.min(h, Math.max(0, vb.height - y));
      view.setBounds({ x: vb.x + x, y: vb.y + y, width: w, height: h });
      var full = rect.x < 1;
      if (full !== fullCover) {
        fullCover = full;
        try { if (!view.webContents.isDestroyed()) view.webContents.send("cdb-jira:cover", full); } catch (e) {}
      }
    }
    function refit() {
      refitTimer = null;
      if (!shown || !deps.remeasure) return;
      Promise.resolve(deps.remeasure(claude)).then(function (r) { if (shown && view && rectOk(r)) place(r); }, function () {});
    }
    function scheduleRefit() {
      if (!shown) return;
      if (refitTimer) clearTimeout(refitTimer);
      refitTimer = setTimeout(refit, REFIT_MS);
    }
    function onClaudeZoom() {
      setTimeout(function () {
        try { if (claude && !claude.isDestroyed()) log("view: claude zoom level " + Math.round(claude.getZoomLevel() * 100) / 100); } catch (e) {}
        syncZoom();
        scheduleRefit();
      }, 0);
    }
    function unwatch() {
      if (!watched) return;
      WINDOW_EVENTS.forEach(function (n) { try { watched.win.removeListener(n, scheduleRefit); } catch (e) {} });
      try { if (!watched.wc.isDestroyed()) watched.wc.removeListener("zoom-changed", onClaudeZoom); } catch (e) {}
      try { if (typeof watched.view.removeListener === "function") watched.view.removeListener("bounds-changed", scheduleRefit); } catch (e) {}
      watched = null;
    }
    function watch(h) {
      if (watched && watched.win === h.win && watched.view === h.view) return;
      unwatch();
      WINDOW_EVENTS.forEach(function (n) { try { h.win.on(n, scheduleRefit); } catch (e) {} });
      try { if (typeof h.view.on === "function") h.view.on("bounds-changed", scheduleRefit); } catch (e) {}
      try { h.view.webContents.on("zoom-changed", onClaudeZoom); } catch (e) {}
      watched = { win: h.win, view: h.view, wc: h.view.webContents };
    }
    function open(wc, rect) {
      if (!rectOk(rect)) return { ok: false, error: "bad rectangle" };
      var h = hostOf(wc);
      if (!h) return { ok: false, error: "not the main window" };
      if (view && host && host.win !== h.win) destroy();
      host = h;
      claude = wc;
      if (!view) {
        var a;
        try { a = assets(); } catch (e) { log("view: cannot write the page"); return { ok: false, error: "The Jira page could not be written to the profile folder." }; }
        view = new deps.electron.WebContentsView({ webPreferences: { preload: a.preload, sandbox: true, contextIsolation: true, nodeIntegration: false,
          webviewTag: false, spellcheck: false } });
        harden(view.webContents);
        view.webContents.loadFile(a.html);
      }
      h.win.contentView.addChildView(view);
      watch(h);
      place(rect);
      view.setVisible(true);
      shown = true;
      try { view.webContents.focus(); } catch (e) {}
      return { ok: true };
    }
    function bounds(wc, rect) {
      if (!shown || !same(wc, claude)) return { ok: false, error: "the Jira page is not open" };
      if (!rectOk(rect)) return { ok: false, error: "bad rectangle" };
      place(rect);
      return { ok: true };
    }
    function close(reason) {
      if (!shown) return { ok: true };
      shown = false;
      if (refitTimer) { clearTimeout(refitTimer); refitTimer = null; }
      var win = host && !host.win.isDestroyed() ? host.win : null, hadFocus = false;
      try { hadFocus = !!win && typeof win.isFocused === "function" && win.isFocused(); } catch (e) {}
      try { view.setVisible(false); } catch (e) {}
      // Upstream mounting its own view over claude.ai leaves focus to that view; upstream's own exit does not refocus.
      if (reason !== "upstream-view") {
        try { if (claude && !claude.isDestroyed()) claude.focus(); } catch (e) {}
        var wc = claude;
        setTimeout(function () {
          if (shown) return;
          try {
            if (hadFocus && win && !win.isDestroyed() && !win.isFocused()) win.focus();
            if (wc && !wc.isDestroyed() && typeof wc.isFocused === "function" && !wc.isFocused()) wc.focus();
          } catch (e) {}
        }, REFOCUS_MS);
      }
      log("view: closed (" + reason + ")");
      if (deps.onHidden) deps.onHidden(reason);
      return { ok: true };
    }
    function destroy() {
      close("destroyed");
      unwatch();
      var v = view;
      view = null;
      if (!v) return;
      try { if (host && !host.win.isDestroyed()) host.win.contentView.removeChildView(v); } catch (e) {}
      try { if (!v.webContents.isDestroyed()) v.webContents.close(); } catch (e) {}
    }

    return {
      hostOf: hostOf, open: open, bounds: bounds, close: close, destroy: destroy,
      isOpen: function () { return shown; },
      isFullCover: function () { return fullCover === true; },
      isTracker: function (wc) { return !!view && same(view.webContents, wc); },
      trackerContents: function () { return view && !view.webContents.isDestroyed() ? view.webContents : null; },
      hostWindow: function () { return host && !host.win.isDestroyed() ? host.win : null; },
      claudeContents: function () { return claude && !claude.isDestroyed() ? claude : null; },
      fullRect: function (wc) {
        var h = hostOf(wc);
        if (!h) return null;
        var b = h.view.getBounds(), zoom = 1;
        try { zoom = wc.getZoomFactor() || 1; } catch (e) { zoom = 1; }
        return { x: 0, y: 0, width: b.width / zoom, height: b.height / zoom };
      }
    };
  }

  globalThis.__cdbJiraViewFactory = create;
  globalThis.__cdbJiraPageHtml = pageHtml;
})();
