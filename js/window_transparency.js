/*
 * window_transparency.js - translucent main window, injected at the head of the
 * main bundle by patches/community/add_feature_window_transparency.nim.
 *
 * Two keys in <userData>/claude-desktop-extra.json(c):
 *   windowTransparency       bool    default false  (env CLAUDE_WINDOW_TRANSPARENCY=1|0)
 *   windowTransparencyLevel  number  default 0.2    (env CLAUDE_WINDOW_TRANSPARENCY_LEVEL=0..0.9)
 *
 * Precedence for both: env > .jsonc (hand-owned, locks the Settings control)
 * > .json (written by Settings -> Extra) > default.
 *
 * The level is how see-through the surfaces are (0 = solid, 0.9 = most
 * see-through); the CSS works with its complement, alpha = 1 - level. The
 * previous release's opacity key `windowOpacity` (0.1..1) and env
 * CLAUDE_WINDOW_OPACITY are still read, converted to a level: the legacy env
 * ranks below the new env, and in each file the new key wins over the legacy
 * one. A legacy key in the .jsonc locks the slider like the new one; a save
 * from Settings writes the new key and drops the legacy one from the .json.
 *
 * What it does when on:
 *   1. The main BrowserWindow is created with transparent:true and a fully
 *      transparent backgroundColor: the patched options literal spreads
 *      globalThis.__cdbWinTransExtra() in AFTER upstream's backgroundColor, so
 *      its keys win. Constructor-only options, so the switch needs an app
 *      RESTART - same as the titlebar modes.
 *   2. Upstream re-paints the window with opaque colours on every theme change
 *      (setBackgroundColor, and setTitleBarOverlay for the integrated
 *      titlebar). On the window we just built (caught by browser-window-created)
 *      the first becomes a no-op and the second has its colour forced to
 *      transparent, so a theme flip cannot bring the solid background back.
 *   3. A stylesheet is inserted into the window's own shell page and into its
 *      claude.ai view that clears the page background and gives the visible
 *      surfaces (sidebar, bg-surface-N) an alpha of 1 - level. Blur behind
 *      the window is the COMPOSITOR's job (Hyprland decoration:blur, KWin
 *      "Blur" effect, ...) - the app only has to stop being opaque.
 *   4. The transparency slider in Settings -> Extra swaps that claude.ai stylesheet
 *      live (insertCSS the new alpha, removeInsertedCSS the old key); only the
 *      on/off switch needs a restart.
 *   5. Pop-out windows (a popped-out Code session, chat, project or artifact,
 *      and the idle pool windows upstream pre-creates) follow the main window:
 *      upstream's window manager builds them from an options literal that the
 *      patch wraps in globalThis.__cdbWinTransPopout(); while the main window
 *      is transparent, a pop-out its own claude.ai view opens gets the same
 *      constructor keys, the same paint guards (2) and the same stylesheet (3,
 *      4). A pop-out is never transparent while the main window is not.
 *
 * Transparency needs a frameless window, so it is skipped (and logged) when the
 * native titlebar is in use (frame:true). Why the patch is a spread in the options
 * literal and not a wrapper around the window factory: patches/core/
 * fix_profile_window_title.nim and patches/linux/fix_window_bounds.nim anchor on
 * that factory's exact shape.
 *
 * Everything here is synchronous where the window needs it and never throws:
 * a broken config file means "feature off", never a window that fails to open.
 */
;/*__CDB_WINTRANS__*/(function () {
  "use strict";
  if (typeof process === "undefined" || process.platform !== "linux") {
    globalThis.__cdbWinTransExtra = function () { return {}; };
    globalThis.__cdbWinTransPopout = function (_opener, _name, o) { return o; };
    return;
  }
  if (globalThis.__cdbWinTrans) return;

  var _fs = require("fs");
  var _path = require("path");
  var _electron = require("electron");

  var KEY_ON = "windowTransparency";
  var KEY_LEVEL = "windowTransparencyLevel";
  var KEY_LEGACY = "windowOpacity";
  var ENV_LEVEL = "CLAUDE_WINDOW_TRANSPARENCY_LEVEL";
  var ENV_LEGACY = "CLAUDE_WINDOW_OPACITY";
  var LEVEL_DEFAULT = 0.2;
  var LEVEL_MAX = 0.9;
  var JSONC_NAME = "claude-desktop-extra.jsonc";
  var JSON_NAME = "claude-desktop-extra.json";

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
    var line = "[window-transparency] " + m;
    if (logQueue && typeof globalThis.__cdbDiag !== "function") { logQueue.push(line); return; }
    flushLog();
    emitLog(line);
  }
  try { _electron.app.whenReady().then(function () { setTimeout(flushLog, 0); }, function () {}); }
  catch (e) { setTimeout(flushLog, 0); }

  function pathFor(name) {
    try { (globalThis.__cdbCfgMigrate || function () {})(); } catch (e) {}
    try { return _path.join(_electron.app.getPath("userData"), name); } catch (e) { return null; }
  }
  // Same string-aware comment/trailing-comma stripper as the other pref readers.
  function stripComments(s) {
    return String(s)
      .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, function (m, q) { return q ? q : ""; })
      .replace(/,(\s*[}\]])/g, "$1");
  }
  function readFileJson(p) {
    try {
      if (!p || !_fs.existsSync(p)) return null;
      var s = stripComments(_fs.readFileSync(p, "utf8"));
      var v = s.trim() ? JSON.parse(s) : {};
      return (v && typeof v === "object" && !Array.isArray(v)) ? v : null;
    } catch (e) { return null; }
  }
  // .jsonc (hand-owned) wins over .json (written by the Settings switch).
  function readKey(key, type) {
    var files = [JSONC_NAME, JSON_NAME];
    for (var i = 0; i < files.length; i++) {
      var cfg = readFileJson(pathFor(files[i]));
      if (cfg && typeof cfg[key] === type) {
        return { value: cfg[key], source: i === 0 ? "jsonc-locked" : "json" };
      }
    }
    return { value: undefined, source: "default" };
  }

  function envOn() {
    var raw;
    try { raw = process.env.CLAUDE_WINDOW_TRANSPARENCY; } catch (e) { return null; }
    if (raw === undefined || raw === null || raw === "") return null;
    return raw === "1";
  }
  function round3(n) { return Math.round(n * 1000) / 1000; }
  function clampLevel(n) {
    if (typeof n !== "number" || !isFinite(n)) return LEVEL_DEFAULT;
    return round3(Math.min(LEVEL_MAX, Math.max(0, n)));
  }
  // A legacy opacity (0.1..1) as a level.
  function fromOpacity(n) { return clampLevel(1 - n); }
  function envNum(name) {
    var raw;
    try { raw = process.env[name]; } catch (e) { return null; }
    if (raw === undefined || raw === null || raw === "" || !isFinite(parseFloat(raw))) return null;
    return parseFloat(raw);
  }
  // The env override as { value, name }, or null when neither variable holds a
  // number (an unusable value falls through to the files, as it always has).
  function envLevel() {
    var n = envNum(ENV_LEVEL);
    if (n !== null) return { value: clampLevel(n), name: ENV_LEVEL };
    n = envNum(ENV_LEGACY);
    if (n !== null) return { value: fromOpacity(n), name: ENV_LEGACY };
    return null;
  }
  // Where the level comes from: { value, source, name } with source "env",
  // "jsonc-locked", "json" or "default" and name the variable or key that
  // decides it (the legacy one when that is what is set).
  function levelInfo() {
    var env = envLevel();
    if (env) return { value: env.value, source: "env", name: env.name };
    var files = [JSONC_NAME, JSON_NAME];
    for (var i = 0; i < files.length; i++) {
      var cfg = readFileJson(pathFor(files[i]));
      if (!cfg) continue;
      var src = i === 0 ? "jsonc-locked" : "json";
      if (typeof cfg[KEY_LEVEL] === "number") return { value: clampLevel(cfg[KEY_LEVEL]), source: src, name: KEY_LEVEL };
      if (typeof cfg[KEY_LEGACY] === "number") return { value: fromOpacity(cfg[KEY_LEGACY]), source: src, name: KEY_LEGACY };
    }
    return { value: LEVEL_DEFAULT, source: "default", name: KEY_LEVEL };
  }
  function level() { return levelInfo().value; }
  function alphaOf(l) { return round3(1 - l); }
  function alpha() { return alphaOf(level()); }
  function savedOn() { return readKey(KEY_ON, "boolean").value === true; }

  // Memoized for the life of the process: the window was built with this
  // answer, and the Settings row compares it against the saved value to know
  // whether a restart is pending. null = nothing asked yet.
  var active = null;
  function wanted() {
    if (active !== null) return active;
    var forced = envOn();
    var on = forced === null ? savedOn() : forced;
    return on === true;
  }
  // Read-only view of the RUNNING state for js/window_controls_pref.js
  // (withoutOverlay): a transparent frameless window has no Window Controls
  // Overlay, so the header inset fix must run there too. Never calls wanted():
  // null (nothing asked yet) and false (native titlebar won, or switch off)
  // both answer false.
  globalThis.__cdbWinTransActive = function () { return active === true; };

  // Mirrors the native-titlebar decision of patches/linux/fix_native_frame.nim
  // (same defensive form: the config reader if present, else the env var).
  function nativeTitlebar() {
    try {
      if (globalThis.__cdbNativeTb) return !!globalThis.__cdbNativeTb();
      return process.env.CLAUDE_NATIVE_TITLEBAR === "1";
    } catch (e) { return false; }
  }

  // Spread into the MAIN window's options literal, after upstream's own keys.
  var pendingMain = false;
  var mainWin = null;
  globalThis.__cdbWinTransExtra = function () {
    try {
      if (active !== null) return active ? { transparent: true, backgroundColor: "#00000000" } : {};
      var on = wanted();
      if (on && nativeTitlebar()) {
        // frame:true; Electron cannot make a framed window translucent.
        log("native titlebar in use - transparency skipped (it needs a frameless window)");
        on = false;
      }
      active = on;
      if (!on) return {};
      pendingMain = true;
      log("main window built transparent (transparency " + level() + ")");
      return { transparent: true, backgroundColor: "#00000000" };
    } catch (e) {
      log("options hook failed: " + ((e && e.message) || e));
      return {};
    }
  };

  // Fires synchronously inside the BrowserWindow constructor; pendingMain says
  // which window that is.
  _electron.app.on("browser-window-created", function (_ev, win) {
    try {
      if (!pendingMain) return;
      pendingMain = false;
      mainWin = win;
      guardPaint(win);
      // patches/linux/fix_window_bounds.nim "jiggles" the window on
      // ready-to-show: setSize(w+1,h+1), then 50 ms later setSize(w,h) with the
      // size captured BEFORE the jiggle. On a tiling compositor the window has
      // been placed into its tile by then (1810x1020 inside the bar/gap
      // reservation), so that second call forces it back to the pre-tile size
      // (1920x1080). On a transparent window Chromium keeps rendering at that
      // size while the compositor shows the tile, so the bottom and right edges
      // are cut off - the page looks fine for a few frames, then cropped, until
      // the compositor sends another size. Drop setSize for the first seconds;
      // the initial size comes from the constructor options, not from here.
      var realSetSize = win.setSize;
      win.setSize = function () {};
      setTimeout(function () { try { win.setSize = realSetSize; } catch (e) {} }, 4000);
    } catch (e) { log("window hook failed: " + ((e && e.message) || e)); }
  });

  // The paint guards of a transparent window, shared by the main window and
  // the transparent pop-outs: setBackgroundColor becomes a no-op and every
  // titlebar-overlay colour ends at #00000000. They must be in place before
  // anything else wraps setTitleBarOverlay: the theme engine
  // (add_feature_custom_themes, __cdb_paintOverlay) wraps it later, on top of
  // this wrapper, so the colour is forced here, last.
  // `popOpts` (pop-outs only) is the window's own construction options: the
  // initial overlay push is seeded from them. The main window passes nothing
  // and keeps its fixed push. Answers the guard's state: `released` hands the
  // window back to upstream's own painting (a pop-out that left our pages).
  function guardPaint(win, popOpts) {
    var g = { released: false };
    var origBg = win.setBackgroundColor;
    win.setBackgroundColor = function () {
      if (g.released && typeof origBg === "function") return origBg.apply(win, arguments);
    };
    var orig = win.setTitleBarOverlay;
    g.origBg = origBg;
    g.origOverlay = orig;
    if (typeof orig !== "function") return g;
    win.setTitleBarOverlay = function (o) {
      if (!g.released && o && typeof o === "object") {
        var t = {};
        for (var k in o) t[k] = o[k];
        t.color = "#00000000";
        o = t;
      }
      return orig.call(win, o);
    };
    // The constructor already got upstream's opaque overlay colour; replace it
    // now. Windows without an overlay (bare mode, os-frame pop-outs) throw here.
    var seed = null;
    if (popOpts === undefined) {
      seed = {
        color: "#00000000",
        symbolColor: _electron.nativeTheme.shouldUseDarkColors ? "#fff" : "#000",
        height: 36
      };
    } else {
      // A pop-out has its own overlay (symbolColor, height - 44 on 5.1231.2):
      // keep what upstream gave it and force only the colour. No overlay in
      // its options (an OS-framed pop-out) = nothing to replace.
      var tb = popOpts && popOpts.titleBarOverlay;
      if (tb && typeof tb === "object") {
        seed = {};
        for (var k2 in tb) seed[k2] = tb[k2];
        seed.color = "#00000000";
      } else if (tb === true) {
        seed = { color: "#00000000" };
      }
    }
    if (seed) { try { orig.call(win, seed); } catch (e0) {} }
    return g;
  }

  // ---- pop-out windows ------------------------------------------------------
  // Every pop-out (popped-out Code session, chat, project, the shell of a
  // popped-out artifact, and the idle pool windows upstream pre-creates) comes
  // from upstream's window manager: the main view registers a window id, calls
  // window.open("about:blank", id), and the manager's open handler answers
  // {action:"allow", overrideBrowserWindowOptions:{..., show:false}} without a
  // createWindow. The patch wraps that options literal as
  // __cdbWinTransPopout(<opener webContents>, <frame name>, {...}); the call is
  // only reached for an about:blank open of a registered id the opener owns.
  //
  // Identity (the very same object, upstream's path untouched) unless ALL hold:
  // the main window was built transparent (`active`, so a pop-out never exceeds
  // it: switch off or native titlebar = identity), the opener is a view inside
  // the main window's contentView (not its shell page, not another window), its
  // main frame is on an app origin (the shared sender guard: file: and other
  // sites fail), and the options have the manager's show:false. A framed
  // pop-out (native Wayland, where upstream reports the titlebar overlay
  // unsupported and pop-outs get an OS frame) is made transparent too: measured
  // on sway, its content is see-through inside the compositor's frame.
  // Frame name -> {opener, timer}: an allowed open the window manager has not
  // turned into a window yet. An entry that never produces one (the open was
  // blocked later, the opener went away) must not pin its opener: it is dropped
  // when the opener is destroyed and expires after 10 s (upstream's own
  // pending sweep uses 10 s); it can never mark a window afterwards.
  var POP_PENDING_MS = 10000;
  var popPending = new Map();
  var popWatched = new WeakSet();   // openers with a destroyed listener
  var popState = new WeakMap();     // pop-out webContents -> {win, guard}
  function dropPending(name) {
    var e = popPending.get(name);
    if (!e) return;
    popPending.delete(name);
    try { clearTimeout(e.timer); } catch (x) {}
  }
  function addPending(name, opener) {
    dropPending(name);
    var timer = null;
    try {
      timer = setTimeout(function () {
        var cur = popPending.get(name);
        if (cur && cur.timer === timer) popPending.delete(name);
      }, POP_PENDING_MS);
      if (timer && typeof timer.unref === "function") timer.unref();
    } catch (x) {}
    popPending.set(name, { opener: opener, timer: timer });
    if (!popWatched.has(opener)) {
      popWatched.add(opener);
      try {
        opener.once("destroyed", function () {
          popPending.forEach(function (e, n) { if (e.opener === opener) dropPending(n); });
        });
      } catch (x) {}
    }
  }
  var popouts = new WeakSet();  // webContents of the transparent pop-outs
  var toldInactive = false;
  function mainViewHolds(wc) {
    try {
      if (!mainWin || mainWin.isDestroyed() || !wc || wc === mainWin.webContents) return false;
      return viewHolds(mainWin.contentView, wc);
    } catch (e) { return false; }
  }
  // Why a pop-out stays opaque, or null.
  function popoutRefusal(opener, name, o) {
    if (active !== true) return "the main window is not transparent";
    if (typeof name !== "string" || !name) return "no window id";
    if (!o || typeof o !== "object" || o.show !== false) return "not the window manager's options";
    if (!opener || typeof opener.isDestroyed !== "function" || opener.isDestroyed()) return "no opener";
    if (!mainViewHolds(opener)) return "the opener is not the main window's view";
    var f = opener.mainFrame;
    if (!f || !originAllowed(f.url)) return "the opener is not on an app origin";
    return null;
  }
  globalThis.__cdbWinTransPopout = function (opener, name, o) {
    try {
      var why = popoutRefusal(opener, name, o);
      if (why) {
        // Switch off / native titlebar: said once, not for every pool window.
        if (active !== true) {
          if (!toldInactive) { toldInactive = true; log("pop-outs stay opaque: " + why); }
        } else log("pop-out " + name + " left opaque: " + why);
        return o;
      }
      var c = {};
      for (var k in o) c[k] = o[k];
      c.transparent = true;
      c.backgroundColor = "#00000000";
      addPending(name, opener);
      return c;
    } catch (e) {
      log("pop-out options hook failed: " + ((e && e.message) || e));
      return o;
    }
  };
  // did-create-window is emitted on the opener with the new BrowserWindow right
  // after it is built, before the pop-out's about:blank document reports
  // dom-ready (where the theme engine first reaches it), so these guards end up
  // under the theme's overlay wrapper.
  function onPopoutCreated(opener, win, d) {
    var name = d && d.frameName;
    var pend = typeof name === "string" ? popPending.get(name) : null;
    if (!pend || pend.opener !== opener) return;
    dropPending(name);
    var wc = win && win.webContents;
    var o = (d && d.options) || {};
    var f = wc && wc.opener;
    if (!wc || o.transparent !== true || !f || f.parent !== null || !originAllowed(f.url)) {
      log("pop-out " + name + " not styled: the created window does not match the transparent options");
      return;
    }
    var guard = guardPaint(win, o);
    popouts.add(wc);
    popState.set(wc, { win: win, guard: guard });
    var framed = o.frame !== false && o.titleBarStyle !== "hidden" && o.titleBarStyle !== "hiddenInset";
    log("pop-out " + name + " built transparent (" + (framed ? "OS frame" : "frameless") + ")");
  }

  // ---- CSS -----------------------------------------------------------------
  // Tokens are the CDS/claude.ai ones also used by add_feature_custom_themes:
  // --bg-000/100/200 are "H S% L%" triplets, so hsl(var(--bg-N) / A) keeps the
  // active theme's colour and only lowers its alpha. `html` is prepended to
  // every selector to out-rank a custom theme's own !important rules.
  function buildCss(a) {
    var A = String(Math.round(a * 1000) / 1000);
    var P = String(Math.round(a * 100)) + "%";
    var FADE = String(Math.round(a * 50) / 100);
    function mix(v) { return "color-mix(in srgb,var(" + v + ") " + P + ",transparent)"; }
    // Only ONE layer may carry the alpha at any point of the screen: stacked
    // translucent layers multiply (0.6 over 0.6 is 0.84). In the app frame
    // .dframe-root is that layer: the wrappers around it and the page-level
    // surfaces inside it (sidebar, bg-surface-1, the Code tab's panel cards) go
    // clear. Outside the frame bg-surface-0/1 take the alpha. bg-page (the page
    // colour that sticky headers and the composer dock use to hide
    // scrolled content - hiding is exactly what a translucent window cannot do,
    // so those fade instead of masking). Surfaces are re-derived from upstream's
    // own --cds-* tokens with color-mix, so a custom theme's colours are kept.
    // bg-surface-2/3 are the CARD level - menus, popovers, the prompt box - and
    // stay solid so they read against whatever is behind the window.
    return "" +
      "html,html body,html #root,html [id=root],html .dframe-content,html .dframe-main,html main.dframe-main{background:transparent!important}" +
      // In the app frame the alpha layer is .dframe-root itself, and nothing
      // above or inside it may add a second one. Above it sit body.bg-surface-1
      // and a full-window bg-surface-1 wrapper ([data-sim-native-ground]); with
      // both tinted, the page was 0.96 and the sidebar and the Code tab's side
      // panels, one layer more, ~0.99. Pages without the frame keep body.
      "html :is(body,.bg-surface-0,.bg-surface-1,.bg-surface-2,.bg-page):has(.dframe-root){background:transparent!important}" +
      "html .dframe-root{background-color:" + mix("--cds-page-bg") + "!important}" +
      // Sidebar: two classes so a custom theme's "[data-darker] .dframe-sidebar"
      // (also !important) cannot put its solid colour back.
      "html .dframe-root .dframe-sidebar{background:transparent!important}" +
      "html .bg-surface-0{background-color:" + mix("--cds-surface-0") + "!important}" +
      "html .bg-surface-1{background-color:" + mix("--cds-surface-1") + "!important}" +
      "html .bg-page,html [data-cds-dock-masked] .in-data-cds-dock-masked\\:bg-page{background-color:" + mix("--cds-page-bg") + "!important}" +
      "html .bg-surface-2{background-color:var(--cds-surface-2)!important}" +
      // Claude Code's whole content area is ONE rounded-card on surface-2, whose
      // warm gray (#1a1a19) reads as a tint next to the neutral surface-1 the
      // rest of the app uses. It is a page-level panel, not a card to read on,
      // so it takes surface-1 at the window alpha like everything else.
      "html .bg-surface-2.rounded-card{background-color:" + mix("--cds-surface-1") + "!important}" +
      // ...but a design-system Dialog is a card too and has exactly those two
      // classes (the Settings modal is one). It must stay solid: whatever is
      // mounted on it directly - the Extra settings panel does that when upstream's
      // markup changes - would otherwise show the page behind the dialog. The
      // extra attribute makes this the more specific rule, whatever the order.
      "html [data-cds=Dialog].bg-surface-2{background-color:var(--cds-surface-2)!important}" +
      // Inside the frame, page-coloured surfaces and the Code tab's panel cards
      // (Terminal / Diff / File, data-surface=panel) sit on .dframe-root, so
      // they go clear instead of stacking a second alpha.
      "html .dframe-root .bg-surface-1,html .dframe-root .bg-surface-2.rounded-card:not([data-cds=Dialog]),html .dframe-root [data-surface=panel]{background:transparent!important}" +
      // The docked session rail and the other side panes sit on .cds-pane-ground
      // (bg-surface-2, no rounded-card, so the card rule above misses them): a
      // page-level pane on the frame's layer, so it goes clear like the other
      // in-flow surfaces. A floating one is an elevated card and is made solid
      // again by the rule after this one.
      "html .dframe-root .cds-pane-ground{background:transparent!important}" +
      // Elevated cards - the floating session rail (shadow-panel-md), large
      // panels (shadow-panel-lg), popovers (shadow-popover) - lie over the page,
      // so they must hide it, whatever surface class they carry. shadow-panel-sm
      // is NOT in the list: it is on in-flow panes and chips. :not(#_) puts this
      // above every clear rule here, whatever its specificity.
      "html .dframe-root .bg-surface-1:is(.shadow-panel-md,.shadow-panel-lg,.shadow-popover):not(#_){background-color:var(--cds-surface-1)!important}" +
      "html .dframe-root .bg-surface-2:is(.shadow-panel-md,.shadow-panel-lg,.shadow-popover):not(#_){background-color:var(--cds-surface-2)!important}" +
      // Notice cards in the composer stack (usage limit and the like) sit over
      // the scrolling transcript: they keep a solid ground like the composer.
      "html .dframe-root .rounded-composer.bg-surface-1:not(#_){background-color:var(--cds-surface-1)!important}" +
      // Our own panel-tabs bar is part of the one see-through layer.
      "html .dframe-root .cdb-tabs-bar{background:transparent!important}" +
      // The header ground of a toolbar or page header (z-index -1, behind the
      // title row) hides the transcript scrolling under it, so like the sticky
      // strips below it takes the page colour at the window alpha instead of
      // upstream's own fill (85%, or 100% with opaque toolbars) - it follows
      // the slider.
      "html .dframe-root [data-cds=Toolbar]>[data-cds-part=toolbar-ground],html .dframe-root [data-cds=Page] [data-cds-part=page-header-ground]{--_toolbar-ground-fill:" + P + "!important;background-color:" + mix("--cds-page-bg") + "!important}" +
      // The Code tab's content columns are tiles: each .tiles-shell paints
      // --tile-shell-ground (a page colour upstream sets inline) behind the
      // transcript, composer and panes, so the whole Code view stayed solid
      // while the sidebar next to it showed the desktop. Like the page surfaces
      // above it sits on .dframe-root, which is its backing, so it goes clear;
      // the variable is cleared too, for the borders and corner strips that
      // paint with it. No custom theme styles this surface.
      // A tile being dragged (.is-moving) floats over the tiles beneath it, so it
      // must hide them: upstream restores its ground, and it takes the page
      // colour at the window alpha like the frame layer, to stay readable.
      "html .dframe-root .tiles-shell:not(.is-moving){--tile-shell-ground:transparent!important;background:transparent!important}" +
      "html .dframe-root .tiles-shell.is-moving{background-color:" + mix("--cds-page-bg") + "!important}" +
      // Panel contents with an inline opaque code-theme colour: the terminal
      // (wrapper + xterm's scroll element) and the diff CodeView. The diff's
      // sticky file headers keep a page-coloured strip so scrolled lines fade
      // under them instead of showing through at full strength.
      "html .dframe-root [class~=\"group/terminal\"],html .dframe-root .xterm-scrollable-element,html .dframe-root .xterm-viewport,html .dframe-root [data-surface=panel] [data-cds=CodeView]{background:transparent!important}" +
      // The File tab's viewer is CodeMirror, whose generated theme class paints
      // the editor and its gutters in the code-theme colour.
      "html .dframe-root [data-surface=panel] .cm-editor,html .dframe-root [data-surface=panel] .cm-gutters{background-color:transparent!important}" +
      "html .dframe-root [data-surface=panel] .epitaxy-panel-subheader[data-sticky]{background-color:" + mix("--cds-page-bg") + "!important}" +
      // Embedded documents - artifacts, MCP app views, previews, other sites -
      // paint nothing where their own page has no background, so in a
      // see-through window the desktop would show through behind their text.
      // They get an opaque backing in the page colour, as in an opaque window
      // (an iframe or webview that upstream gives a bg-* utility keeps it).
      // Separate views (the in-app browser, WebContentsView) are opaque white
      // by default and never get this stylesheet.
      "html iframe:not([class*=bg-]),html webview:not([class*=bg-]){background-color:var(--cds-surface-1,Canvas)!important}" +
      "html .bg-surface-3,html .bg-surface-popover{background-color:var(--cds-surface-3)!important}" +
      "html [role=menu],html [role=listbox]{background-color:var(--cds-surface-3)!important}" +
      "html [class*=approval-dock]{background:transparent!important}" +
      "html .sticky.bottom-0.pointer-events-none[class*=\"bg-[var(--epitaxy-transcript-surface\"]{background-color:" + mix("--cds-surface-1") + "!important}" +
      "html .scroll-fade-strip-top,html .scroll-fade-strip-bottom,html .page-fade-t,html .page-fade-b{opacity:" + FADE + "!important}";
  }
  // The window's own shell page (title bar / boot placeholder / error UI).
  // The shell page also paints a "boot placeholder" (sidebar row shapes) that
  // an opaque claude.ai view normally covers; with a see-through view on top it
  // shows through as ghost rectangles behind the sidebar, so hide it. The drag
  // strip is left alone - it is the window's drag region.
  var SHELL_CSS = "html,html body{background:transparent!important}" +
    "html #boot-placeholder-sidebar,html #boot-placeholder-sidebar-rows,html [class*=boot-placeholder-seam],html [class*=boot-placeholder-frame],html [class*=boot-placeholder-row]{display:none!important}";

  // The IPC sender validator is shared: js/sender_guard.js (issue #318). Looked up
  // at call time; a missing guard fails closed.
  function originAllowed(u) { var g = globalThis.__cdbSenderGuard; return !!g && g.originAllowed(u); }
  function isShell(rawUrl) {
    return /^file:\/\/.*\/renderer\/main_window\//.test(String(rawUrl));
  }

  // Only the main window and its transparent pop-outs are see-through. The Code
  // and Design windows, artifact pop-ups and the 3P config window load
  // claude.ai in BrowserWindows of their own with an opaque background; the
  // pop-out windows the main view opens (a popped-out Code session, chat or
  // project) are about:blank children with the React tree portaled in, styled
  // only through the `popouts` set above. A claude.ai webContents that
  // another live window provably owns - as its own webContents or as a view in
  // its contentView tree - is left alone. Unclaimed (not attached yet, or the
  // main window's own view), no main window to tell apart, or any error: the
  // CSS goes in as before, so the main window never loses it here.
  function viewHolds(view, wc) {
    if (!view) return false;
    if (view.webContents === wc) return true;
    var kids = view.children || [];
    for (var i = 0; i < kids.length; i++) if (viewHolds(kids[i], wc)) return true;
    return false;
  }
  function otherWindowOwns(wc) {
    try {
      if (!mainWin || mainWin.isDestroyed()) return false;
      var wins = _electron.BrowserWindow.getAllWindows();
      for (var i = 0; i < wins.length; i++) {
        var w = wins[i];
        if (!w || w === mainWin || w.isDestroyed()) continue;
        if (w.webContents === wc || viewHolds(w.contentView, wc)) return true;
      }
    } catch (e) {}
    return false;
  }

  // ---- live transparency ----------------------------------------------------------
  // Every claude.ai webContents that carries our see-through stylesheet, with
  // the key insertCSS resolved to and the alpha it was built with. insertCSS is
  // per-DOCUMENT, so a navigation (a new dom-ready) inserts afresh and replaces
  // the stored key; the old key belonged to a document that is gone. Each entry
  // runs its stylesheet work through its own promise chain, so a dom-ready and
  // a burst of slider previews never interleave their insert/remove pairs, and
  // every step builds from the LATEST wanted alpha - a burst of previews
  // collapses to the last one instead of replaying each.
  var styled = new Map();
  // The alpha the stylesheet should carry now: a slider preview while one is
  // being dragged, else the saved value.
  var liveAlpha = null;
  function wantAlpha() { return liveAlpha !== null ? liveAlpha : alpha(); }

  function entryFor(wc) {
    var e = styled.get(wc);
    if (e) return e;
    e = { key: null, alpha: null, chain: Promise.resolve() };
    styled.set(wc, e);
    try { wc.once("destroyed", function () { styled.delete(wc); }); } catch (err) {}
    return e;
  }
  function settle(p) { return p.then(function () {}, function () {}); }

  // dom-ready: a new document, so a fresh insert (no remove - the old key is
  // not in this document).
  // The documents the stylesheet belongs in: an app page, or the about:blank
  // document of a transparent pop-out. Checked again right before every insert.
  function ownDocument(wc) {
    var url = wc.getURL() || "";
    return originAllowed(url) || (url === "about:blank" && popouts.has(wc));
  }
  function styleNewDocument(wc) {
    var e = entryFor(wc);
    e.chain = settle(e.chain.then(function () {
      if (wc.isDestroyed() || !ownDocument(wc)) return;
      var a = wantAlpha();
      return wc.insertCSS(buildCss(a)).then(function (key) { e.key = key; e.alpha = a; });
    }));
    return e.chain;
  }
  // Swap the stylesheet in place. The new sheet goes in BEFORE the old one comes
  // out, so there is never a frame with neither (an opaque flash); same
  // selectors, both !important, so the later-inserted sheet wins meanwhile.
  function restyle(wc) {
    var e = entryFor(wc);
    e.chain = settle(e.chain.then(function () {
      if (wc.isDestroyed() || e.key === null) return;
      if (!ownDocument(wc)) { styled.delete(wc); return; }
      var a = wantAlpha();
      if (a === e.alpha) return;
      var old = e.key;
      return wc.insertCSS(buildCss(a)).then(function (key) {
        e.key = key;
        e.alpha = a;
        return wc.removeInsertedCSS(old);
      });
    }));
    return e.chain;
  }
  // Re-style every live, styled webContents; answers how many carry the wanted
  // alpha afterwards.
  function applyLive() {
    var jobs = [];
    styled.forEach(function (e, wc) {
      try {
        if (wc.isDestroyed()) { styled.delete(wc); return; }
        jobs.push(restyle(wc).then(function () { return e.key !== null && e.alpha === wantAlpha(); }));
      } catch (err) {}
    });
    return Promise.all(jobs).then(function (r) {
      return r.filter(function (x) { return x; }).length;
    });
  }

  // A transparent pop-out whose document is no longer ours (it navigated to
  // another site) must not stay see-through: that page may have no background
  // of its own, so its text would sit on the desktop. It leaves the pop-out set
  // (and so never gets the stylesheet again), our paint guards stand down and
  // the window is painted opaque in upstream's stock chrome colour.
  function releasePopout(wc, url) {
    popouts.delete(wc);
    styled.delete(wc);
    var st = popState.get(wc);
    popState.delete(wc);
    if (!st) return;
    var win = st.win;
    st.guard.released = true;
    var dark = !!_electron.nativeTheme.shouldUseDarkColors;
    var chrome = dark ? "#151515" : "#fcfcfb";
    try { if (win && !win.isDestroyed()) win.setBackgroundColor(chrome); } catch (e) {}
    try {
      if (win && !win.isDestroyed() && typeof st.guard.origOverlay === "function") {
        win.setTitleBarOverlay({ color: chrome });
      }
    } catch (e) {}
    log("pop-out left the app (" + String(url).replace(/[?#].*$/, "").slice(0, 80) + ") - painted opaque " + chrome);
  }

  _electron.app.on("web-contents-created", function (_ev, wc) {
    try {
      wc.on("did-create-window", function (win, d) {
        try { onPopoutCreated(wc, win, d); }
        catch (e) { log("pop-out hook failed: " + ((e && e.message) || e)); }
      });
    } catch (e) {}
    wc.on("dom-ready", function () {
      try {
        if (active !== true) return;
        var url = wc.getURL() || "";
        if (url !== "about:blank" && popouts.has(wc)) {
          // A pop-out never gets a stylesheet for another document (an app
          // page included: its window is claimed by otherWindowOwns).
          styled.delete(wc);
          releasePopout(wc, url);
        } else if (originAllowed(url)) {
          if (!otherWindowOwns(wc)) styleNewDocument(wc);
        } else if (url === "about:blank" && popouts.has(wc)) {
          styleNewDocument(wc);
        } else {
          // Any other document - also a styled page or pop-out that navigated
          // to another site - is never styled: drop it from the live set, so a
          // slider move cannot insert into it.
          styled.delete(wc);
          if (isShell(url)) wc.insertCSS(SHELL_CSS).catch(function () {});
        }
      } catch (e) {}
    });
  });

  // ---- Settings -> Extra row (IPC) -------------------------------------------
  function okSender(ev) { var g = globalThis.__cdbSenderGuard; return !!g && g.okSender(ev); }

  // Writes keys of the .json in one go - `changes` maps key -> value, undefined
  // deletes the key - tmp + rename, every other key preserved; refuses to touch
  // a file it cannot parse instead of discarding the user's other settings.
  function writeKey(key, value) {
    var c = {};
    c[key] = value;
    return writeKeys(c);
  }
  function writeKeys(changes) {
    var p = pathFor(JSON_NAME);
    if (!p) return { ok: false, error: "no userData path" };
    var raw = null;
    try { raw = _fs.readFileSync(p, "utf8"); }
    catch (e) {
      if (e.code !== "ENOENT") return { ok: false, error: "cannot read " + p + ": " + ((e && e.message) || e) };
    }
    var cfg = {};
    if (raw !== null) {
      var s = stripComments(raw);
      try { cfg = s.trim() ? JSON.parse(s) : {}; }
      catch (e2) { return { ok: false, error: p + " is not valid JSON (" + e2.message + ") - nothing was written" }; }
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
        return { ok: false, error: p + " must contain a JSON object; nothing was written" };
      }
      if (s !== raw) { try { _fs.writeFileSync(p + ".cdb-bak", raw, { flag: "wx" }); } catch (e3) {} }
    }
    for (var key in changes) {
      if (!Object.prototype.hasOwnProperty.call(changes, key)) continue;
      if (changes[key] === undefined) delete cfg[key]; else cfg[key] = changes[key];
    }
    var tmp = p + ".cdb-tmp";
    try {
      _fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      _fs.renameSync(tmp, p);
    } catch (e4) {
      try { _fs.unlinkSync(tmp); } catch (e5) {}
      return { ok: false, error: "cannot write " + p + ": " + ((e4 && e4.message) || e4) };
    }
    return { ok: true, path: p };
  }

  // Why Settings may not change the level right now, or null.
  function levelRefusal() {
    var info = levelInfo();
    if (info.source === "env") return info.name + " is set - unset it to change the transparency here";
    if (info.source === "jsonc-locked") return info.name + " is set in " + JSONC_NAME + " - edit that file to change it";
    return null;
  }
  // A finite number, clamped to 0..0.9 and rounded to 0.001; null otherwise.
  function levelArg(v) {
    if (typeof v !== "number" || !isFinite(v)) return null;
    return clampLevel(v);
  }
  var BAD_LEVEL = "transparency must be a number from 0 to " + LEVEL_MAX;

  var ipc = _electron.ipcMain;
  ipc.handle("cdb-wt:pref-read", function (ev) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    var disk = readKey(KEY_ON, "boolean");
    var env = envOn();
    var lv = levelInfo();
    return {
      ok: true,
      enabled: disk.value === true,
      active: active,
      level: lv.value,
      levelSource: lv.source,
      levelSetBy: lv.name,
      levelLocked: lv.source === "jsonc-locked",
      levelEnvForced: lv.source === "env",
      lockedByJsonc: disk.source === "jsonc-locked",
      source: disk.source,
      envForced: env !== null,
      nativeTitlebar: nativeTitlebar()
    };
  });
  // Slider dragged: re-style the window, write nothing. `live` is how many
  // webContents now carry the new alpha (0 while the window is not transparent).
  ipc.handle("cdb-wt:level-preview", function (ev, value) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    var l = levelArg(value);
    if (l === null) return { ok: false, error: BAD_LEVEL };
    var no = levelRefusal();
    if (no) return { ok: false, error: no };
    if (active !== true) return { ok: true, level: l, active: active, live: 0 };
    liveAlpha = alphaOf(l);
    return applyLive().then(function (n) { return { ok: true, level: l, active: active, live: n }; });
  });
  // Slider released: persist windowTransparencyLevel to the .json (dropping a
  // legacy windowOpacity there in the same write), then re-style.
  ipc.handle("cdb-wt:level-set", function (ev, value) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    var l = levelArg(value);
    if (l === null) return { ok: false, error: BAD_LEVEL };
    var no = levelRefusal();
    if (no) return { ok: false, error: no };
    var changes = {};
    changes[KEY_LEVEL] = l;
    changes[KEY_LEGACY] = undefined;
    var w = writeKeys(changes);
    if (!w.ok) return w;
    liveAlpha = null;
    log("pref " + KEY_LEVEL + " set to " + l + " (" + w.path + ")" + (active === true ? " - applied live" : ""));
    if (active !== true) return { ok: true, level: l, active: active, live: 0, path: w.path };
    return applyLive().then(function (n) { return { ok: true, level: l, active: active, live: n, path: w.path }; });
  });
  ipc.handle("cdb-wt:pref-set", function (ev, enabled) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    if (typeof enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
    if (readKey(KEY_ON, "boolean").source === "jsonc-locked") {
      return { ok: false, error: KEY_ON + " is set in " + JSONC_NAME + " - edit that file to change it" };
    }
    var w = writeKey(KEY_ON, enabled ? true : undefined);
    if (!w.ok) return w;
    log("pref " + KEY_ON + " set to " + enabled + " (" + w.path + ") - takes effect on restart");
    return { ok: true, enabled: enabled, path: w.path };
  });

  globalThis.__cdbWinTrans = true;
  // The startup line is computed one tick after load, as before. __cdbDiag is
  // still missing then (it only appears once upstream's "ready" handler runs),
  // so log() queues the line and flushLog() delivers it after "ready".
  setTimeout(function () {
    log("installed; saved=" + savedOn() + ", transparency=" + level() +
      (envOn() !== null ? ", CLAUDE_WINDOW_TRANSPARENCY forces " + envOn() : ""));
  }, 0);
})();
