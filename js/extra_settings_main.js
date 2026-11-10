/*
 * extra_settings_main.js - main-process half of the "Extra" settings area.
 * Injected into .vite/build/index.js by patches/core/add_feature_extra_settings.nim.
 *
 * Three jobs:
 *   1. Register the ipcMain handlers the page's cdbExtra bridge talks to.
 *   2. Own the ONLY writer of growthbookOverrides in claude-desktop-extra.json
 *      (the .jsonc is human-owned and never created or rewritten here).
 *   3. Install the page-side UI on every http(s) dom-ready (insertCSS + one
 *      executeJavaScript whose return value is logged).
 *
 * Cross-patch state is read LAZILY through globalThis, never captured at load:
 * same-anchor prefix injections stack in reverse, so this IIFE runs BEFORE the
 * custom-themes IIFE that installs globalThis.__cdbThemes. Every handler
 * therefore tolerates a missing registry and answers {ok:false,error:...}.
 *
 * SECURITY: the caller is remote claude.ai code. Every handler validates its
 * sender's ORIGIN against an exact allowlist (main frame only - see
 * js/sender_guard.js, reached through __cdbEx_okSender below), flag ids must
 * exist in the catalog, and values are restricted to JSON scalars.
 *
 * The two placeholder string literals below are replaced at build time by the
 * Nim patch with the contents of js/extra_settings_page.js and
 * js/extra_settings_page.css. They stay plain strings here so this file passes
 * node --check on its own.
 */
;/*__CDB_EXTRA_SETTINGS__*/(function () {
  "use strict";
  // Linux, and win32 for downstream Windows builds of this patch set, where
  // the page shows the Models panel only (see NAV_ITEMS in the page).
  if (typeof process === "undefined" || (process.platform !== "linux" && process.platform !== "win32")) return;

  var _electron = require("electron");
  var _app = _electron.app;
  var _ipc = _electron.ipcMain;
  var _path = require("path");
  var _fs = require("fs");

  var __cdbEx_pageSrc = "__CDB_EX_PAGE_SRC__";
  var __cdbEx_pageCss = "__CDB_EX_PAGE_CSS__";
  var __cdbEx_marker = "__cdb_extra_settings";

  function __cdbEx_log(m) {
    try { (globalThis.__cdbDiag || console.log)("[ExtraSettings] " + m); } catch (e) {}
  }

  function __cdbEx_paths() {
    // One-time legacy claude-desktop-bin.{json,jsonc} migration; implemented
    // once in the custom-themes patch (globalThis.__cdbCfgMigrate).
    try { (globalThis.__cdbCfgMigrate || function () {})(); } catch (e) {}
    var ud = _app.getPath("userData");
    return {
      json: _path.join(ud, "claude-desktop-extra.json"),
      jsonc: _path.join(ud, "claude-desktop-extra.jsonc"),
      userData: ud
    };
  }

  // JSONC comment + trailing-comma stripping. MUST stay byte-identical in
  // behavior to stripJsonComments() in js/growthbook_overrides.js: if the two
  // disagreed about whether an id is set in the .jsonc, this page would offer a
  // toggle whose value the flag loader then ignores.
  function __cdbEx_strip(s) {
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

  // --- Native dialog with "Allow always" for starting other sessions -----
  // Opt-in (sessionStartAlwaysAllow, off by default, .jsonc wins and locks it
  // like the switches below). patches/community/add_feature_session_start_always_allow.nim
  // asks globalThis.__cdbSessionStartDialogEnabled() on every eligible
  // start_session ask; false leaves upstream's in-chat card alone.
  // Remembered approvals ("Allow always") live under sessionStartGrants in the
  // .json only: { "<project folder or project/destination tuple>": { grantedAt } }, capped. Only the
  // main-process dialog adds one; the remote settings page can read the count,
  // forget them all, or flip the switch (off also forgets them). A stored grant
  // is ignored while the switch is off.
  var __cdbEx_SSA_KEY = "sessionStartAlwaysAllow";
  var __cdbEx_SSA_GRANTS = "sessionStartGrants";
  var __cdbEx_SSA_MAX = 50;
  var __cdbEx_ssaRevision = 0;
  function __cdbEx_ssaPref() {
    var p = __cdbEx_paths();
    var jsonc = __cdbEx_readFileKey(p.jsonc, __cdbEx_SSA_KEY);
    if (typeof jsonc === "boolean") return { value: jsonc, locked: true };
    return { value: __cdbEx_readFileKey(p.json, __cdbEx_SSA_KEY) === true, locked: false };
  }
  function __cdbEx_ssaEnabled() {
    try { return __cdbEx_ssaPref().value === true; } catch (e) { return false; }
  }
  // Existing keys cover only the default destination. Explicit local starts
  // use a JSON [asking project, canonical destination] tuple, never a wildcard.
  function __cdbEx_ssaValidKey(key) {
    function absolute(v) {
      return typeof v === "string" && v.charAt(0) === "/" && v.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(v);
    }
    if (absolute(key)) return true;
    if (typeof key !== "string" || key.length > 16400) return false;
    try {
      var pair = JSON.parse(key);
      return Array.isArray(pair) && pair.length === 2 && pair.every(absolute) && JSON.stringify(pair) === key;
    } catch (e) { return false; }
  }
  function __cdbEx_ssaClean(raw) {
    var out = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    Object.keys(raw).forEach(function (k) {
      var v = raw[k];
      if (__cdbEx_ssaValidKey(k) && v && typeof v === "object" &&
          !Array.isArray(v) && typeof v.grantedAt === "number" && isFinite(v.grantedAt)) {
        out[k] = { grantedAt: v.grantedAt };
      }
    });
    return out;
  }
  function __cdbEx_ssaGrants() {
    try { return __cdbEx_ssaClean(__cdbEx_readFileKey(__cdbEx_paths().json, __cdbEx_SSA_GRANTS)); } catch (e) { return {}; }
  }
  function __cdbEx_ssaForget() {
    var res = __cdbEx_writeCfg(function (cfg) { delete cfg[__cdbEx_SSA_GRANTS]; });
    __cdbEx_ssaRevision++;
    return res;
  }
  if (process.platform === "linux") {
    globalThis.__cdbSessionStartDialogEnabled = __cdbEx_ssaEnabled;
    globalThis.__cdbSessionStartPermission = {
      get revision() { return __cdbEx_ssaRevision; },
      has: function (key) {
        if (typeof key !== "string" || !__cdbEx_ssaEnabled()) return false;
        return Object.prototype.hasOwnProperty.call(__cdbEx_ssaGrants(), key);
      },
      count: function () { return Object.keys(__cdbEx_ssaGrants()).length; },
      grant: function (key) {
        if (!__cdbEx_ssaValidKey(key)) return { ok: false, error: "invalid project/destination key" };
        if (!__cdbEx_ssaEnabled()) return { ok: false, error: __cdbEx_SSA_KEY + " is off" };
        var res = __cdbEx_writeCfg(function (cfg) {
          var grants = __cdbEx_ssaClean(cfg[__cdbEx_SSA_GRANTS]);
          grants[key] = { grantedAt: Date.now() };
          var keys = Object.keys(grants).sort(function (a, b) { return grants[b].grantedAt - grants[a].grantedAt; });
          var kept = {};
          keys.slice(0, __cdbEx_SSA_MAX).forEach(function (k) { kept[k] = grants[k]; });
          if (!Object.prototype.hasOwnProperty.call(kept, key)) kept[key] = grants[key];
          cfg[__cdbEx_SSA_GRANTS] = kept;
        });
        if (res.ok) __cdbEx_ssaRevision++;
        return res;
      },
      forget: __cdbEx_ssaForget
    };
  }

  // --- theme swatches -------------------------------------------------------
  // Five tokens per variant, each with fallbacks, reduced to CSS colors here so
  // the ~90 full token maps never cross into the remote page.
  var __cdbEx_swatch = [
    ["--bg-100", "--bg-000", "--bg-200"],
    ["--text-000", "--text-100", "--text-200"],
    ["--accent-brand", "--accent-100", "--accent-000"],
    ["--accent-pro-100", "--accent-pro-000", "--accent-200"],
    ["--success-100", "--success-000", "--warning-100"]
  ];

  // Only two shapes are accepted: #hex and the "H S% L%" triple the theme schema
  // uses. Anything else is dropped rather than forwarded into a style property.
  function __cdbEx_color(map, chain) {
    for (var i = 0; i < chain.length; i++) {
      var v = map && map[chain[i]];
      if (typeof v !== "string") continue;
      var t = v.trim();
      if (/^#[0-9a-fA-F]{3,8}$/.test(t)) return t;
      if (/^[\d.]+\s+[\d.]+%\s+[\d.]+%(\s*\/\s*[\d.]+)?$/.test(t)) return "hsl(" + t + ")";
    }
    return null;
  }

  function __cdbEx_dots(map) {
    var out = [];
    for (var i = 0; i < __cdbEx_swatch.length; i++) {
      var c = __cdbEx_color(map, __cdbEx_swatch[i]);
      if (c) out.push(c);
    }
    return out;
  }

  // The file a theme apply will ACTUALLY be written to. __cdbThemes.configPath is
  // a fixed .jsonc, but the engine's persist (__cdb_persist in
  // add_feature_custom_themes.nim) walks [.jsonc, .json] and takes the first that
  // EXISTS, because the .jsonc wins the startup merge - so on an install that has
  // only the .json, the theme lands there and a hardcoded .jsonc label is a lie.
  // Mirrored here rather than guessed, and the page derives its file link from
  // whatever comes back.
  function __cdbEx_themeSaveTarget() {
    var p = __cdbEx_paths();
    if (_fs.existsSync(p.jsonc)) return p.jsonc;
    if (_fs.existsSync(p.json)) return p.json;
    return p.jsonc;
  }

  // --- flag catalog / state -------------------------------------------------

  function __cdbEx_gb() {
    return globalThis.__cdbGbFlags || null;
  }

  function __cdbEx_catalog() {
    var gb = __cdbEx_gb();
    if (!gb) return null;
    try { return gb.catalog(); } catch (e) { return null; }
  }

  function __cdbEx_scalar(v) {
    var t = typeof v;
    if (v === null || v === undefined || t === "boolean" || t === "number") return v;
    if (t === "string") return v.length > 200 ? v.slice(0, 200) + "..." : v;
    try {
      var s = JSON.stringify(v);
      return s && s.length > 200 ? s.slice(0, 200) + "..." : s;
    } catch (e) { return "[unserializable]"; }
  }

  function __cdbEx_project(map, ids) {
    var out = {};
    if (!map || typeof map !== "object") return out;
    for (var i = 0; i < ids.length; i++) {
      var e = map[ids[i]];
      if (!e || typeof e !== "object") continue;
      out[ids[i]] = { on: e.on === true, value: __cdbEx_scalar(e.value) };
    }
    return out;
  }

  // --- the single writer of growthbookOverrides in the .json ---------------
  // The .jsonc is a human-owned file with an auto-created template; it already
  // has two writers (template creation + activeTheme persistence) and this page
  // deliberately does not become a third. Writes are atomic (tmp + rename).
  // mutate() receives the whole parsed .json object and may return a value that
  // is handed back to the caller as `extra`. Both writers below funnel through
  // here so there is still exactly one place that rewrites the .json.
  function __cdbEx_writeCfg(mutate) {
    __cdbEx_cuAskCache = null;
    var p = __cdbEx_paths();
    var raw = null;
    try {
      raw = _fs.readFileSync(p.json, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") return { ok: false, error: "cannot read " + p.json + ": " + e.message };
    }
    var cfg = {};
    if (raw !== null) {
      var stripped = __cdbEx_strip(raw);
      try {
        cfg = stripped.trim() ? JSON.parse(stripped) : {};
      } catch (e2) {
        return { ok: false, error: p.json + " is not valid JSON (" + e2.message + ") - fix or remove it first; nothing was written" };
      }
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
        return { ok: false, error: p.json + " must contain a JSON object; nothing was written" };
      }
      if (stripped !== raw) {
        // Rewriting as plain JSON drops comments - keep the original once.
        try {
          _fs.writeFileSync(p.json + ".cdb-bak", raw, { flag: "wx" });
          __cdbEx_log("comments in " + p.json + " cannot survive a rewrite; original kept as " + p.json + ".cdb-bak");
        } catch (e3) {}
      }
    }
    var extra = mutate(cfg);

    var tmp = p.json + ".cdb-tmp";
    try {
      _fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      _fs.renameSync(tmp, p.json);
    } catch (e4) {
      try { _fs.unlinkSync(tmp); } catch (e5) {}
      return { ok: false, error: "cannot write " + p.json + ": " + e4.message };
    }
    return { ok: true, extra: extra, path: p.json };
  }

  function __cdbEx_writeOverrides(mutate) {
    var res = __cdbEx_writeCfg(function (cfg) {
      var o = cfg.growthbookOverrides;
      if (!o || typeof o !== "object" || Array.isArray(o)) o = {};
      mutate(o);
      if (Object.keys(o).length) cfg.growthbookOverrides = o;
      else delete cfg.growthbookOverrides;
      return o;
    });
    if (!res.ok) return res;
    return { ok: true, overridesJson: res.extra, path: res.path };
  }

  function __cdbEx_readFileOverrides(file) {
    var raw;
    try {
      raw = _fs.readFileSync(file, "utf8");
    } catch (e) { return {}; }
    try {
      var cfg = JSON.parse(__cdbEx_strip(raw) || "{}");
      var o = cfg && cfg.growthbookOverrides;
      if (o && typeof o === "object" && !Array.isArray(o)) return o;
    } catch (e2) {}
    return {};
  }

  // One top-level key out of a .json/.jsonc file, or undefined. Used to detect a
  // hand-edited value that would win the startup merge over anything we write.
  function __cdbEx_readFileKey(file, key) {
    var raw;
    try {
      raw = _fs.readFileSync(file, "utf8");
    } catch (e) { return undefined; }
    try {
      var cfg = JSON.parse(__cdbEx_strip(raw) || "{}");
      if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) return cfg[key];
    } catch (e2) {}
    return undefined;
  }

  // Additional PR authors, never a blanket bypass. Exact host/login pairs;
  // only the author check is extended, not ownership, scope or consent.
  var __cdbEx_AUTOFIX_KEY = "autoFixTrustedAuthors";
  function __cdbEx_normalizeAuthors(entries) {
    if (!Array.isArray(entries) || entries.length > 50) throw new Error("Use at most 50 host/login entries");
    var out = [];
    entries.forEach(function (entry) {
      if (typeof entry !== "string" || entry.length > 355) throw new Error("Each author must be a host/login string");
      var parts = entry.trim().toLowerCase().split("/");
      var host = parts[0], login = parts[1];
      if (parts.length !== 2 || !host || host.length > 253 ||
          !host.split(".").every(function (label) { return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label); }) ||
          !login || login.length > 100 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\[bot\])?$/.test(login)) {
        throw new Error("Use exact host/login entries, for example github.com/my-app[bot]; no URLs or wildcards");
      }
      var canonical = host + "/" + login;
      if (out.indexOf(canonical) === -1) out.push(canonical);
    });
    return out;
  }
  function __cdbEx_autoFixAuthorPref() {
    var p = __cdbEx_paths();
    var jsonc;
    try {
      var text = _fs.readFileSync(p.jsonc, "utf8");
      var cfg = JSON.parse(__cdbEx_strip(text) || "{}");
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("expected an object");
      jsonc = cfg[__cdbEx_AUTOFIX_KEY];
    } catch (e) {
      if (e.code !== "ENOENT") return { entries: [], locked: true, warning: "Cannot read claude-desktop-extra.jsonc; additional authors are not trusted" };
    }
    var locked = jsonc !== undefined;
    var raw = locked ? jsonc : __cdbEx_readFileKey(p.json, __cdbEx_AUTOFIX_KEY);
    try { return { entries: __cdbEx_normalizeAuthors(raw === undefined ? [] : raw), locked: locked }; }
    catch (e) { return { entries: [], locked: locked, warning: "Invalid " + __cdbEx_AUTOFIX_KEY + ": " + e.message }; }
  }
  if (process.platform === "linux") {
    globalThis.__cdbAutoFixAuthorAllowed = function (login, host) {
      try {
        if (typeof login !== "string" || typeof host !== "string") return false;
        var pair = __cdbEx_normalizeAuthors([host + "/" + login])[0];
        return __cdbEx_autoFixAuthorPref().entries.indexOf(pair) !== -1;
      } catch (e) { return false; }
    };
  }

  // --- tray glyph: "Always use the white tray icon" (issue #305) -------------
  // patches/linux/fix_tray_icon_theme.nim makes upstream's tray-icon selector
  // ask globalThis.__cdbTrayAlwaysWhite() first: true picks the white glyph on
  // every desktop, anything else leaves upstream's own choice (white on GNOME
  // and in dark mode, black in light mode). This IIFE runs from the stub's
  // "use strict"; prefix, before the stub requires any chunk, so the helper
  // exists before the tray is first built. No cache: the selector only runs at
  // startup, on a theme change and on a menu-bar toggle, and reading the files
  // each time means a hand-edited .jsonc counts from the next of those.
  var __cdbEx_TRAY_KEY = "trayIconAlwaysWhite";
  // {value, locked}. Off is the default and the absence of the key; the .jsonc
  // wins the per-key merge, so a boolean there locks the row.
  function __cdbEx_trayPref() {
    var p = __cdbEx_paths();
    var jsonc = __cdbEx_readFileKey(p.jsonc, __cdbEx_TRAY_KEY);
    if (typeof jsonc === "boolean") return { value: jsonc, locked: true };
    return { value: __cdbEx_readFileKey(p.json, __cdbEx_TRAY_KEY) === true, locked: false };
  }
  if (process.platform === "linux") {
    globalThis.__cdbTrayAlwaysWhite = function () {
      try { return __cdbEx_trayPref().value === true; } catch (e) { return false; }
    };
  }

  // --- Auto-fix notices: ready to merge, comments after merge --------------
  // Same shape as the tray switch above. One switch for two patches: the
  // wrapper patches/community/add_feature_autofix_merge_ready.nim puts around
  // AutoFixEngine.checkSession and the one add_feature_autofix_post_merge.nim
  // puts around AutoFixEngine.sweep both ask
  // globalThis.__cdbAutoFixMergeReadyEnabled() on every sweep (60 s focused,
  // 5 min unfocused); only true runs the readiness check / post-merge reads. Off is the default and the absence of the key.
  // No cache: each call reads the two small settings files, so a flip applies
  // from the next sweep. The same predicate also gates additional batched-turn
  // completion receipts at the healthy emitter; it is read at completion time.
  var __cdbEx_AFMR_KEY = "autoFixMergeReady";
  function __cdbEx_afmrPref() {
    var p = __cdbEx_paths();
    var jsonc = __cdbEx_readFileKey(p.jsonc, __cdbEx_AFMR_KEY);
    if (typeof jsonc === "boolean") return { value: jsonc, locked: true };
    return { value: __cdbEx_readFileKey(p.json, __cdbEx_AFMR_KEY) === true, locked: false };
  }
  if (process.platform === "linux") {
    globalThis.__cdbAutoFixMergeReadyEnabled = function () {
      try { return __cdbEx_afmrPref().value === true; } catch (e) { return false; }
    };
  }

  // --- Computer Use: Escape stops it (community, issue #323) --------------
  // patches/community/add_feature_cu_escape_abort.nim asks
  // globalThis.__cdbCuEscapeAbortEnabled() each time upstream's CU lock is
  // taken (and before re-arming at the next action of a cloud turn): only true
  // arms the Escape watcher of js/cu_esc_watch.js; anything else keeps
  // upstream's own Escape handling. Off is the default and the absence of the
  // key; a boolean in the .jsonc wins and locks the row. No cache: each call
  // reads the two small settings files, so a flip applies from the next lock.
  var __cdbEx_CUESC_KEY = "computerUseEscapeAbort";
  function __cdbEx_cuEscPref() {
    var p = __cdbEx_paths();
    var jsonc = __cdbEx_readFileKey(p.jsonc, __cdbEx_CUESC_KEY);
    if (typeof jsonc === "boolean") return { value: jsonc, locked: true };
    return { value: __cdbEx_readFileKey(p.json, __cdbEx_CUESC_KEY) === true, locked: false };
  }
  if (process.platform === "linux") {
    globalThis.__cdbCuEscapeAbortEnabled = function () {
      try { return __cdbEx_cuEscPref().value === true; } catch (e) { return false; }
    };
  }

  // --- Code: auto-archive delay after a PR merges or closes -----------------
  // patches/community/add_feature_auto_archive_grace.nim asks
  // globalThis.__cdbAutoArchiveMergeDelayMinutes() once per auto-archive sweep
  // (every 5 min plus upstream's kicks). 0 = immediate = upstream, the default
  // and the absence of the key. Same shape as the tray switch above: a valid
  // value in the .jsonc locks the row; an invalid one is reported as a warning
  // and ignored, so the row and claude-desktop-extra.json stay in charge.
  var __cdbEx_AAG_KEY = "autoArchiveMergeDelayMinutes";
  function __cdbEx_aagValid(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10080;
  }
  function __cdbEx_aagPref() {
    var p = __cdbEx_paths();
    var jsonc = __cdbEx_readFileKey(p.jsonc, __cdbEx_AAG_KEY);
    if (__cdbEx_aagValid(jsonc)) return { value: jsonc, locked: true };
    var warning = jsonc === undefined ? null :
      "Ignoring " + __cdbEx_AAG_KEY + " in claude-desktop-extra.jsonc: expected a whole number from 0 to 10080";
    var value = __cdbEx_readFileKey(p.json, __cdbEx_AAG_KEY);
    return { value: __cdbEx_aagValid(value) ? value : 0, locked: false, warning: warning };
  }
  if (process.platform === "linux") {
    globalThis.__cdbAutoArchiveMergeDelayMinutes = function () { return __cdbEx_aagPref().value; };
  }

  // --- Computer Use: read app controls through AT-SPI (issue #306) ---------
  // Same shape as the tray switch above. The Computer Use patch asks
  // globalThis.__cdbCuAxElements?.() on every call that could involve the
  // accessibility tools (tools/list build, cache key, our tool names); true
  // means they may be offered. Off is the default and the absence of the key.
  // No cache: each call reads the small settings files, which is cheap.
  var __cdbEx_CUAX_KEY = "computerUseAxElements";
  function __cdbEx_cuAxPref() {
    var p = __cdbEx_paths();
    var jsonc = __cdbEx_readFileKey(p.jsonc, __cdbEx_CUAX_KEY);
    if (typeof jsonc === "boolean") return { value: jsonc, locked: true };
    return { value: __cdbEx_readFileKey(p.json, __cdbEx_CUAX_KEY) === true, locked: false };
  }
  if (process.platform === "linux") {
    globalThis.__cdbCuAxElements = function () {
      try { return __cdbEx_cuAxPref().value === true; } catch (e) { return false; }
    };
  }

  // --- Computer Use: ask before controlling an app -------------------------
  // js/cu_consent.js asks globalThis.__cdbCuAskBeforeControl() on every tool
  // call of a regular-mode session and on each tools/list build. Anything but
  // false: request_access shows upstream's approval card and every other tool
  // is checked against the apps the user approved. ON by default - only an
  // explicit false turns it off; a boolean in the .jsonc wins and locks the
  // row. A read that fails answers true (ask). The tool side asks on every tool
  // call and description build, so the answer is cached and the two files are
  // re-read only when either one's mtime or size moved (two stat calls per
  // ask, no read or parse); every write of ours drops the cache as well
  // (__cdbEx_writeCfg).
  var __cdbEx_CUASK_KEY = "computerUseAskBeforeControl";
  var __cdbEx_cuAskCache = null;
  function __cdbEx_cuAskSig(p) {
    return [p.json, p.jsonc].map(function (f) {
      try { var st = _fs.statSync(f); return st.mtimeMs + ":" + st.size; } catch (e) { return "-"; }
    }).join("|");
  }
  function __cdbEx_cuAskPref() {
    var p = __cdbEx_paths();
    var jsonc = __cdbEx_readFileKey(p.jsonc, __cdbEx_CUASK_KEY);
    if (typeof jsonc === "boolean") return { value: jsonc, locked: true };
    return { value: __cdbEx_readFileKey(p.json, __cdbEx_CUASK_KEY) !== false, locked: false };
  }
  if (process.platform === "linux") {
    globalThis.__cdbCuAskBeforeControl = function () {
      try {
        var c = __cdbEx_cuAskCache, sig = __cdbEx_cuAskSig(__cdbEx_paths());
        if (c && c.sig === sig) return c.value;
        var v = __cdbEx_cuAskPref().value !== false;
        __cdbEx_cuAskCache = { sig: sig, value: v };
        return v;
      } catch (e) { return true; }
    };
  }

  // An id may only be written if the catalog knows it (or we force it on Linux
  // ourselves) - remote code cannot invent flag ids to persist.
  function __cdbEx_knownId(id) {
    if (typeof id !== "string" || !/^\d{1,20}$/.test(id)) return false;
    var catalog = __cdbEx_catalog();
    if (catalog) {
      for (var i = 0; i < catalog.length; i++) if (catalog[i].id === id) return true;
    }
    var gb = __cdbEx_gb();
    try {
      if (gb && Object.prototype.hasOwnProperty.call(gb.builtins(), id)) return true;
    } catch (e) {}
    return false;
  }

  function __cdbEx_warned(id) {
    var catalog = __cdbEx_catalog();
    if (!catalog) return "";
    for (var i = 0; i < catalog.length; i++) {
      if (catalog[i].id === id) return catalog[i].warn || "";
    }
    return "";
  }

  // --- deployment mode: 1P / 3P -------------------------------------------
  //
  // Upstream decides the mode in the bootstrap (index.pre.js) before any window
  // exists, from the FIRST config source that carries an inference or bootstrap
  // block, and then relocates userData to "<userData>-3p":
  //
  //   1. /etc/claude-desktop/managed-settings.json - refused unless BOTH the file
  //      and /etc/claude-desktop are root-owned and not group/world writable, and
  //      ignored WHOLESALE if it carries one unrecognized key. A valid managed
  //      file disables the local source entirely.
  //   2. the APPLIED entry of the local config library: the id in
  //      <3pDir>/configLibrary/_meta.json ("appliedId") names
  //      <3pDir>/configLibrary/<id>.json, which upstream reads with the SAME flat
  //      key schema as the managed file and only needs to be user-owned.
  //
  // 3P is then chosen unless the persisted "deploymentMode" key in
  // <3pDir>/claude_desktop_config.json is "1p" - the escape hatch upstream's own
  // 3P Setup writes and this page exposes. The policy overrides that switch
  // (v4.16336.0): authentication.deploymentMode (flat: deploymentMode, "any" |
  // "3p" | "1p") pins the mode, and without it
  // authentication.disableClaudeAiSignIn (flat: disableDeploymentModeChooser)
  // pins 3P. "1p" means no 3P at all, even with a provider stored. This page
  // never writes either policy key. Upstream (v4.16336.0):
  //   function Gae(e){let t=e.authentication?.deploymentMode;
  //     return t==="3p"||t==="1p"?t:Hae(e)?"3p":"any"}
  //   function Kae(e){let t=Gae(e);return t==="1p"||!k2(e)?null:
  //     t==="3p"?"chooser-disabled":Wae()==="1p"?null:_6(e)?"hybrid-pointer":"persisted"}
  //
  // So everything here is user-level and userData-relative: no root, no patch to
  // the bootstrap, and the files are the ones upstream already reads. Both live
  // in the "-3p" sibling of the ACTIVE profile's userData, which is where
  // upstream keeps them regardless of the mode that ended up active.

  var __cdbEx_ETC_DIR = "/etc/claude-desktop";
  var __cdbEx_ETC_FILE = __cdbEx_ETC_DIR + "/managed-settings.json";
  var __cdbEx_MODE_KEY = "deploymentMode";

  // The policy's mode: "1p" | "3p" | "any" (upstream's Gae).
  function __cdbEx_policyMode(cfg) {
    var t = cfg && cfg.deploymentMode;
    if (t === "1p" || t === "3p") return t;
    return cfg && cfg.disableDeploymentModeChooser === true ? "3p" : "any";
  }

  // The mode the next start boots (upstream's Kae, non-null = 3P).
  // selects3p: the active source carries a provider or bootstrap URL (k2);
  // persisted: the "deploymentMode" switch in claude_desktop_config.json.
  function __cdbEx_decideMode(selects3p, policyMode, persisted) {
    if (policyMode === "1p" || !selects3p) return "1p";
    if (policyMode === "3p") return "3p";
    return persisted === "1p" ? "1p" : "3p";
  }
  // Pure, read-only: exposed so the harness can check the decision table
  // without a root-owned /etc policy file.
  globalThis.__cdbExDecideMode = __cdbEx_decideMode;
  // Anything the page never gets to see and never has to send back: a secret it
  // echoes unchanged means "keep the stored value".
  var __cdbEx_KEEP = "__cdb_unchanged__";
  // 0600 files / 0700 dirs, matching upstream's own writes - these files hold
  // inference credentials.
  var __cdbEx_FMODE = 384;
  var __cdbEx_DMODE = 448;

  // Faithful port of upstream's 3p-dir resolver: CLAUDE_USER_DATA_DIR pins
  // userData and disables the relocation entirely, otherwise the dir is the
  // "-3p" sibling - already suffixed when we are running IN 3P mode.
  function __cdbEx_3pDir() {
    var ud = _app.getPath("userData");
    if (process.env.CLAUDE_USER_DATA_DIR) return ud;
    return /-3p$/.test(ud) ? ud : ud + "-3p";
  }

  function __cdbEx_deployPaths() {
    var dir = __cdbEx_3pDir();
    var lib = _path.join(dir, "configLibrary");
    return {
      userData: _app.getPath("userData"),
      threePDir: dir,
      modeFile: _path.join(dir, "claude_desktop_config.json"),
      libDir: lib,
      metaFile: _path.join(lib, "_meta.json"),
      etcFile: __cdbEx_ETC_FILE
    };
  }

  // The managed-config key catalog of Claude Desktop v4.16336.0 (203 keys), read out of the
  // bundle's own schema (flat key, zod leaf type, scopes, title). Upstream drives
  // its 3P Setup wizard from that schema; we cannot reach it from here (it is
  // module-scoped in index.pre.js), so this is a PINNED COPY and is therefore
  // version-sensitive: re-extract it on an upstream bump with
  //   grep -ao 'flatKey:[`"][A-Za-z0-9_]*[`"]' .vite/build/index.pre.js | sort -u   (grep -a: rg finds nothing on bundles)
  // (since v1.26832.0 the minifier emits backtick string literals)
  // A key that no longer exists is silently dropped by the local config reader,
  // but it INVALIDATES a whole /etc managed file - which is exactly why the page
  // shows what it wrote and where. (betaFeaturesEnabled, still in older 3P docs,
  // was removed upstream and is deliberately absent here.)
  //
  // kind:  bool | enum | text | secret | int | num | lines | models | json
  //        num is a fractional number (min is exclusive, max inclusive); int is a whole one
  // scope: "3p" (only applies in 3P mode) | "both"
  // only:  render under this provider only
  // lock:  never writable from this page, and why
  var __cdbEx_DEPLOY_KEYS = [
    // --- inference & connection ---------------------------------------------
    { key: "inferenceProvider", kind: "enum", group: "connection", scope: "3p",
      label: "Inference provider",
      options: ["gateway", "vertex", "bedrock", "foundry", "anthropic"],
      note: "The key that turns 3P on. Clearing it leaves a config with no inference block, which boots 1P." },
    { key: "inferenceModels", kind: "models", group: "connection", scope: "3p",
      label: "Model list",
      note: "One model id per line, first is the default. Append [1m] for the 1M-token context window." },
    { key: "modelDiscoveryEnabled", kind: "bool", group: "connection", scope: "3p",
      label: "Model discovery", note: "Pull the model list from the provider instead of the list above." },
    { key: "modelPrefer1mContext", kind: "bool", group: "connection", scope: "3p",
      label: "Default to 1M context", note: "Prefer the 1M-token context window variant when a model offers one (available since v1.28929.0)." },
    { key: "inferenceModelPricingEnabled", kind: "bool", group: "connection", scope: "3p",
      label: "Show estimated cost",
      note: "Puts a USD cost estimate on the Usage page; without it that page reports token counts only, because the app cannot know your negotiated rates (available since v1.37937.0)." },
    { key: "inferenceModelPricingMultiplier", kind: "num", group: "connection", scope: "3p",
      label: "Price multiplier", min: 0, max: 1,
      note: "Scales every estimated cost, e.g. 0.85 for 85% of the rate; greater than 0 and at most 1 (available since v1.37937.0)." },
    { key: "inferenceModelPricing", kind: "json", group: "connection", scope: "3p",
      label: "Per-model rates",
      note: "JSON array of { name, inputPerMtok, outputPerMtok, cacheReadPerMtok, cacheWritePerMtok } rows, each replacing Anthropic list price for one model id in the Usage estimate (available since v1.37937.0)." },
    { key: "defaultModelEffort", kind: "enum", group: "connection", scope: "3p",
      label: "Default model effort", options: ["low", "medium", "high", "xhigh", "max"],
      note: "Starting effort level for every model the picker offers; a level a model does not offer falls to the nearest lower one, and it never exceeds that model's maxEffort. CLAUDE_CODE_EFFORT_LEVEL still wins in Code sessions." },
    { key: "alwaysStartWithDefaultModel", kind: "bool", group: "connection", scope: "3p",
      label: "Always start with the default model",
      note: "New conversations open on the first model in the list and at the default effort, instead of remembering the user's last choice." },
    { key: "modelCatalogEnabled", kind: "bool", group: "connection", scope: "3p",
      label: "Model catalog metadata", dflt: true,
      note: "Fetches display names and capability metadata for the configured models. Off keeps the built-in labels and makes no catalog request." },
    { key: "modelCatalogUrl", kind: "text", group: "connection", scope: "3p",
      label: "Model catalog URL",
      note: "Serves the catalog metadata instead of Anthropic's endpoint. It never changes which models are offered, their order or the default." },
    { key: "inferenceCredentialKind", kind: "enum", group: "connection", scope: "3p",
      label: "Credential kind",
      options: ["static", "helper-script", "interactive", "vendor-profile", "oauth", "workforce", "external-idp"],
      note: "external-idp signs the user in with your own OIDC identity provider (the IdP keys below) and sends that token to the gateway or Bedrock proxy." },
    { key: "inferenceIdpOidc", kind: "json", group: "connection", scope: "3p", secret: true,
      label: "Identity provider (OIDC)",
      note: "Your organization's OpenID Connect IdP for the external-idp credential kind; the user's token is sent as the Bearer credential to the gateway or the Bedrock proxy (available since v2.7032.0)." },
    { key: "inferenceIdpAuthFlow", kind: "enum", group: "connection", scope: "3p",
      label: "Identity provider sign-in flow", options: ["browser", "broker"],
      note: "The system browser (default) or the OS Microsoft Entra broker; the broker is not supported on Linux (available since v2.7032.0)." },
    { key: "inferenceCustomHeaders", kind: "json", group: "connection", scope: "3p", secret: true,
      label: "Custom inference headers", note: "JSON object added to every inference request." },

    { key: "inferenceGatewayBaseUrl", kind: "text", group: "connection", scope: "3p", only: "gateway",
      label: "Gateway base URL" },
    { key: "inferenceGatewayApiKey", kind: "secret", group: "connection", scope: "3p", only: "gateway",
      label: "Gateway API key" },
    { key: "inferenceGatewayAuthScheme", kind: "enum", group: "connection", scope: "3p", only: "gateway",
      label: "Gateway auth scheme", options: ["bearer", "x-api-key", "auto", "sso"] },
    { key: "inferenceGatewayOidc", kind: "json", group: "connection", scope: "3p", only: "gateway", secret: true,
      label: "Gateway SSO IdP (OIDC)" },
    { key: "inferenceGatewayOidcAuthFlow", kind: "enum", group: "connection", scope: "3p", only: "gateway",
      label: "Gateway sign-in flow", options: ["browser", "broker"] },
    { key: "inferenceGatewayManagedClaudeCode", kind: "bool", group: "connection", scope: "3p", only: "gateway",
      label: "Gateway-managed Claude Code",
      note: "Runs Claude Code in its gateway mode (CLAUDE_CODE_USE_GATEWAY) in Cowork, Chat and Code sessions for users signed in through the gateway's own sign-in; off by default." },
    { key: "inferenceGatewayAutoModeServerChecks", kind: "bool", group: "connection", scope: "3p",
      label: "Server-side Auto mode checks" },

    { key: "inferenceVertexProjectId", kind: "text", group: "connection", scope: "3p", only: "vertex",
      label: "GCP project ID" },
    { key: "inferenceVertexRegion", kind: "text", group: "connection", scope: "3p", only: "vertex",
      label: "GCP region", note: "A region such as us-east5, or \"global\" for the global endpoint." },
    { key: "inferenceVertexBaseUrl", kind: "text", group: "connection", scope: "3p", only: "vertex",
      label: "Vertex AI base URL" },
    { key: "inferenceVertexCredentialsFile", kind: "text", group: "connection", scope: "3p", only: "vertex",
      label: "GCP credentials file", note: "Leave empty to use gcloud application-default credentials." },
    { key: "inferenceVertexOAuthClientId", kind: "text", group: "connection", scope: "3p", only: "vertex",
      label: "Vertex OAuth client ID" },
    { key: "inferenceVertexOAuthClientSecret", kind: "secret", group: "connection", scope: "3p", only: "vertex",
      label: "Vertex OAuth client secret" },
    { key: "inferenceVertexOAuthLoginHint", kind: "text", group: "connection", scope: "3p", only: "vertex",
      label: "Vertex OAuth login hint" },
    { key: "inferenceVertexOAuthScopes", kind: "text", group: "connection", scope: "3p", only: "vertex",
      label: "Vertex OAuth scopes" },
    { key: "inferenceVertexWorkforceAudience", kind: "text", group: "connection", scope: "3p", only: "vertex",
      label: "Workforce Identity audience" },
    { key: "inferenceVertexWorkforceOidc", kind: "json", group: "connection", scope: "3p", only: "vertex", secret: true,
      label: "Workforce Identity IdP (OIDC)" },
    { key: "inferenceVertexWorkforceAuthFlow", kind: "enum", group: "connection", scope: "3p", only: "vertex",
      label: "Workforce Identity sign-in flow", options: ["browser", "broker"] },
    { key: "inferenceVertexWorkforceUserProject", kind: "text", group: "connection", scope: "3p", only: "vertex",
      label: "Workforce Identity billing project" },

    { key: "inferenceBedrockRegion", kind: "text", group: "connection", scope: "3p", only: "bedrock",
      label: "AWS region" },
    { key: "inferenceBedrockBaseUrl", kind: "text", group: "connection", scope: "3p", only: "bedrock",
      label: "Bedrock base URL" },
    { key: "inferenceBedrockBearerToken", kind: "secret", group: "connection", scope: "3p", only: "bedrock",
      label: "AWS bearer token" },
    { key: "inferenceBedrockProfile", kind: "text", group: "connection", scope: "3p", only: "bedrock",
      label: "AWS profile name" },
    { key: "inferenceBedrockAwsCliPath", kind: "text", group: "connection", scope: "3p", only: "bedrock",
      label: "AWS CLI path" },
    { key: "inferenceBedrockAwsDir", kind: "text", group: "connection", scope: "3p", only: "bedrock",
      label: "AWS config directory" },
    { key: "inferenceBedrockServiceTier", kind: "enum", group: "connection", scope: "3p", only: "bedrock",
      label: "Bedrock service tier", options: ["flex", "priority"] },
    { key: "inferenceBedrockSsoStartUrl", kind: "text", group: "connection", scope: "3p", only: "bedrock",
      label: "AWS SSO start URL" },
    { key: "inferenceBedrockSsoRegion", kind: "text", group: "connection", scope: "3p", only: "bedrock",
      label: "AWS SSO region" },
    { key: "inferenceBedrockSsoAccountId", kind: "text", group: "connection", scope: "3p", only: "bedrock",
      label: "AWS SSO account ID" },
    { key: "inferenceBedrockSsoRoleName", kind: "text", group: "connection", scope: "3p", only: "bedrock",
      label: "AWS SSO role name" },

    { key: "inferenceFoundryResource", kind: "text", group: "connection", scope: "3p", only: "foundry",
      label: "Azure AI Foundry resource" },
    { key: "inferenceFoundryBaseUrl", kind: "text", group: "connection", scope: "3p", only: "foundry",
      label: "Azure AI Foundry base URL",
      note: "Full endpoint URL, used instead of building one from the resource name." },
    { key: "inferenceFoundryApiKey", kind: "secret", group: "connection", scope: "3p", only: "foundry",
      label: "Azure AI Foundry API key" },
    { key: "inferenceFoundryAuthFlow", kind: "enum", group: "connection", scope: "3p", only: "foundry",
      label: "Entra ID sign-in flow", options: ["device-code", "browser", "broker"] },
    { key: "inferenceFoundryClientId", kind: "text", group: "connection", scope: "3p", only: "foundry",
      label: "Entra ID client ID" },
    { key: "inferenceFoundryTenantId", kind: "text", group: "connection", scope: "3p", only: "foundry",
      label: "Entra ID tenant ID" },

    { key: "inferenceAnthropicApiKey", kind: "secret", group: "connection", scope: "3p", only: "anthropic",
      label: "Claude API key" },

    { key: "inferenceCredentialHelper", kind: "text", group: "connection", scope: "3p",
      label: "Credential helper script", note: "Absolute path; prints fresh credentials on demand." },
    { key: "inferenceCredentialHelperArgs", kind: "lines", group: "connection", scope: "3p",
      label: "Credential helper arguments",
      note: "One argument per line, up to 32, passed to the helper script." },
    { key: "inferenceCredentialHelperWindows", kind: "text", group: "connection", scope: "3p",
      label: "Credential helper script (Windows)",
      note: "Windows devices run this path instead of Helper script, with the same arguments, timeout, TTL and environment. macOS and Linux ignore it." },
    { key: "inferenceCredentialHelperTtlSec", kind: "int", group: "connection", scope: "3p",
      label: "Credential helper TTL (s)" },
    { key: "inferenceCredentialHelperTimeoutSec", kind: "int", group: "connection", scope: "3p",
      label: "Credential helper timeout (s)", max: 600 },
    { key: "inferenceCredentialHelperSilentRefreshEnabled", kind: "bool", group: "connection", scope: "3p",
      label: "Re-run helper for silent refresh" },
    { key: "inferenceSessionLifetimeSec", kind: "int", group: "connection", scope: "3p",
      label: "Sign-in session lifetime (s)" },
    { key: "allowOptionalClientAuth", kind: "bool", group: "connection", scope: "3p",
      label: "Allow optional client-certificate fallback" },
    { key: "userContentRendererUrl", kind: "text", group: "connection", scope: "3p",
      label: "Artifact preview iframe origin" },
    { key: "loginSsoOrgDomain", kind: "text", group: "connection", scope: "1p",
      label: "SSO login domain" },
    { key: "forceLoginOrgUUID", kind: "text", group: "connection", scope: "1p",
      label: "Required organization UUID" },
    { key: "importThirdPartyHistoryIntoOrgUUID", kind: "text", group: "connection", scope: "1p",
      label: "Import earlier third-party sessions into this organization",
      note: "Organization UUID that adopts the sessions a user created while the device ran in 3P mode." },

    { key: "inferenceStreamIdleTimeoutSec", kind: "int", group: "connection", scope: "3p", only: "gateway",
      label: "Stream idle timeout (s)", max: 1800,
      note: "Extra seconds to wait for model output on a streaming response that only sends keep-alive pings, 300 to 1800; default 300. Gateway provider only." },
    { key: "inferenceBedrockWebIdentityRoleArn", kind: "text", group: "connection", scope: "3p", only: "bedrock",
      label: "IAM role for the Microsoft 365 add-in",
      note: "Role the Microsoft 365 add-in assumes with the user's Entra ID token (STS AssumeRoleWithWebIdentity); Claude Desktop itself does not read it (upstream gates this @next)." },
    { key: "egressProxyUrl", kind: "text", group: "connection", scope: "both",
      label: "Proxy server URL",
      note: "Sends the app's and the agent's traffic through this HTTP proxy instead of the operating system's proxy settings; applies at the next app start." },
    { key: "egressProxyPacUrl", kind: "text", group: "connection", scope: "both",
      label: "Proxy auto-config (PAC) URL",
      note: "A PAC file that decides the proxy per request; wins over the proxy server URL when both are set." },
    { key: "dictationEnabled", kind: "bool", group: "connection", scope: "3p",
      label: "Dictation", note: "Normally supplied by the bootstrap server when the gateway offers dictation." },
    { key: "disableMultiAccount", kind: "bool", group: "connection", scope: "1p",
      label: "Single account only",
      note: "Keeps Claude Desktop signed in to one account at a time (available since v1.46388.1)." },
    { key: "entraClientId", kind: "text", group: "connection", scope: "3p",
      label: "Entra application (client) ID",
      note: "Your organization's Entra app registration for the Microsoft 365 add-in; unset uses the add-in's published application (upstream gates this @next)." },
    { key: "entraAzureCloud", kind: "enum", group: "connection", scope: "3p",
      label: "Azure cloud", options: ["global", "us-gov-high", "us-gov-dod", "china"],
      note: "Microsoft cloud the add-in signs in against; anything other than global needs your own client ID (upstream gates this @next)." },
    { key: "entraScope", kind: "text", group: "connection", scope: "3p",
      label: "Entra delegated scope",
      note: "Delegated scopes the add-in requests, space- or comma-separated and all for one resource, e.g. api://.../.default; requires your own client ID (upstream gates this @next)." },

    { key: "coworkVmIpv6Enabled", kind: "bool", group: "connection", scope: "3p",
      label: "Enable IPv6 in the workspace VM" },

    { key: "selfHostedUrl", kind: "text", group: "connection", scope: "3p",
      label: "Self-hosted execution URL",
      note: "Endpoint that runs sessions on your own infrastructure. The rest of this block only applies once it is set." },
    { key: "selfHostedToken", kind: "secret", group: "connection", scope: "3p",
      label: "Self-hosted bearer token",
      note: "Static token sent as Authorization: Bearer. Prefer a helper script or a sign-in." },

    // --- usage limits -------------------------------------------------------
    { key: "inferenceMaxTokensPerWindow", kind: "int", group: "limits", scope: "3p",
      label: "Max tokens per window" },
    { key: "inferenceTokenWindowHours", kind: "int", group: "limits", scope: "3p",
      label: "Token cap window (h)", max: 720 },
    { key: "inferenceTokenWarningPercent", kind: "int", group: "limits", scope: "3p", max: 100, dflt: 75,
      label: "Token limit warning (%)",
      note: "Percentage of the token cap at which the app warns the user, 1 to 100; upstream's default is 75 and it only offers it once Max tokens per window is set (upstream gates this @next, v4.29.0)." },

    { key: "chatSessionRetentionDays", kind: "int", group: "limits", scope: "3p", max: 3650,
      label: "Chat retention period (days)",
      note: "Deletes chats, with their files, after this many days without activity; blank keeps them until the user deletes them. Projects and memory stay." },
    { key: "coworkSessionRetentionDays", kind: "int", group: "limits", scope: "3p", max: 3650,
      label: "Cowork retention period (days)",
      note: "Deletes Cowork tasks, with their uploads and outputs, after this many days without activity. Spaces and memory stay." },
    { key: "codeSessionRetentionDays", kind: "int", group: "limits", scope: "3p", max: 3650,
      label: "Code retention period (days)",
      note: "Deletes Code sessions, conversation included, after this many days without activity. Uncommitted work stays on disk." },
    { key: "sessionRetentionHold", kind: "bool", group: "limits", scope: "3p",
      label: "Suspend session deletion",
      note: "Legal hold: pauses all three retention periods without clearing them." },

    // --- surfaces, sandbox & tools -----------------------------------------
    { key: "chatTabEnabled", kind: "bool", group: "sandbox", scope: "3p", label: "Chat tab" },
    { key: "coworkTabEnabled", kind: "bool", group: "sandbox", scope: "3p", label: "Cowork tab", dflt: true },
    { key: "isClaudeCodeForDesktopEnabled", kind: "bool", group: "sandbox", scope: "both",
      label: "Code tab", dflt: true },
    { key: "desktopHome", kind: "enum", group: "sandbox", scope: "3p",
      label: "Desktop home", options: ["standard", "simple", "no-vm", "off"],
      note: "Which home surface the app opens on. Upstream's own wizard offers only standard and off since v2.31226.0; simple and no-vm are still accepted values." },
    { key: "scheduledTasksEnabled", kind: "bool", group: "sandbox", scope: "3p",
      label: "Allow scheduled tasks" },
    { key: "projectsEnabled", kind: "bool", group: "sandbox", scope: "3p", dflt: true,
      label: "Allow projects",
      note: "Off hides projects; an unreadable value counts as off. Applies to a running app (in the schema since v4.4212.0, which marks it for an upcoming release)." },
    { key: "userFileUploadsEnabled", kind: "bool", group: "sandbox", scope: "3p", dflt: true,
      label: "Allow file attachments",
      note: "Self-hosted sessions only: off makes the host refuse attached files and tells the app to disable attaching (upstream gates this @next, v4.29.0)." },
    { key: "keepAwakeEnabled", kind: "bool", group: "sandbox", scope: "3p", dflt: true,
      label: "Allow keep awake",
      note: "Off means Claude never prevents sleep and hides the keep-awake switches in Settings, the Scheduled page and the Code tab; applies to a running app (available since v2.7032.0)." },
    { key: "developerModeEnabled", kind: "bool", group: "sandbox", scope: "both",
      label: "Allow Developer Mode",
      note: "Applies to a running app (available since v2.37337.1)." },
    { key: "quickEntryDefaultShortcut", kind: "text", group: "sandbox", scope: "3p",
      label: "Default Quick Entry shortcut",
      note: "Replaces the built-in default shortcut with an accelerator such as Ctrl+Alt+K, or off for none; a value upstream does not accept is logged and the built-in default applies. Applies to a running app (available since v3.1623.0)." },
    { key: "quickEntryScreenshotsEnabled", kind: "bool", group: "sandbox", scope: "3p", dflt: true,
      label: "Allow Quick Entry screenshots of the screen and other apps",
      note: "macOS-only upstream (attaches a window or screen-area picture, asks for the Screen Recording permission); no effect on Linux (available since v3.6556.1)." },
    { key: "quickEntryFileSharingEnabled", kind: "bool", group: "sandbox", scope: "3p", dflt: true,
      label: "Allow Quick Entry sharing of files open in other apps",
      note: "macOS-only upstream (finds the file through the Accessibility permission); no effect on Linux (available since v3.6556.1)." },
    { key: "chatAdvancedFileAnalysisEnabled", kind: "bool", group: "sandbox", scope: "3p",
      label: "Advanced file analysis in Chat" },
    { key: "autoModeEnabled", kind: "bool", group: "sandbox", scope: "3p", label: "Cowork Auto mode" },
    { key: "toolSearchEnabled", kind: "bool", group: "sandbox", scope: "3p", label: "Tool search" },
    { key: "allowedWorkspaceFolders", kind: "lines", group: "sandbox", scope: "both",
      label: "Allowed workspace folders", note: "One absolute path per line. Empty means no restriction." },
    { key: "coworkEgressAllowedHosts", kind: "lines", group: "sandbox", scope: "3p",
      label: "Cowork egress allowlist", note: "One host per line; * opens the sandbox network." },
    { key: "disabledBuiltinTools", kind: "lines", group: "sandbox", scope: "both",
      label: "Disabled built-in tools", note: "One tool name per line, e.g. computer-use." },
    { key: "builtinToolPolicy", kind: "json", group: "sandbox", scope: "both",
      label: "Built-in tool policy", note: "JSON object of tool name to allow / ask / deny." },
    { key: "disableBundledSkills", kind: "bool", group: "sandbox", scope: "both",
      label: "Disable bundled skills and workflows" },
    { key: "skillCreationEnabled", kind: "bool", group: "sandbox", scope: "3p",
      label: "Allow user-created skills" },
    { key: "skillScanningEnabled", kind: "bool", group: "sandbox", scope: "3p",
      label: "Scan user-created skills",
      note: "Off unless set to true; an unreadable value counts as on. Only offered while user-created skills are allowed; applies to a running app (available since v3.1623.0)." },
    { key: "userPluginMarketplacesEnabled", kind: "bool", group: "sandbox", scope: "3p", dflt: true,
      label: "Allow user-added plugin marketplaces",
      note: "Off hides the add-marketplace surfaces and refuses adds that still reach the app; marketplaces already registered on the machine and org-provisioned ones are unaffected (available since v1.37937.0)." },
    { key: "userPluginUploadsEnabled", kind: "bool", group: "sandbox", scope: "3p", dflt: true,
      label: "Allow user-added plugins",
      note: "Off hides every in-app way to add a plugin and refuses uploads that still reach the app; already-installed and org-provisioned plugins are unaffected (available since v1.37937.0)." },
    { key: "claudeCodeProcessWrapperEnabled", kind: "bool", group: "sandbox", scope: "3p",
      label: "Use Claude Code's corporate launcher",
      note: "Starts the Code tab's Claude Code through the launcher named in the device's Claude Code managed settings (processWrapper); off by default, macOS and Linux only (available since v2.7032.0)." },
    { key: "codeAllowedRepositories", kind: "json", group: "sandbox", scope: "3p",
      label: "Allowed repositories",
      note: "JSON array of { source: \"github\", repo: \"owner/repo\" } or { source: \"git\", url } entries (optional ref) naming the Git repositories Claude Code may work in; up to 100 (available since v2.16120.0)." },
    { key: "claudeCodeSettings", kind: "json", group: "sandbox", scope: "3p", secret: true,
      label: "Claude Code settings",
      lock: "read only by the Claude Code CLI signed in to the organization by itself, from configuration the hosted control plane serves; Claude Desktop never reads it and ignores it in device-managed or local settings, so this page never writes it" },
    { key: "skipWebFetchPreflight", kind: "bool", group: "sandbox", scope: "3p",
      label: "Skip WebFetch domain check",
      note: "Drops Claude Code's per-domain blocklist lookup against api.anthropic.com before a WebFetch; turn it on where that host is firewalled, since the fetch otherwise fails outright (available since v1.37937.0)." },
    { key: "coworkEDRIntegration", kind: "text", group: "sandbox", scope: "both",
      label: "EDR Integration package path",
      lock: "read from device management only and hidden in upstream's own wizard - deploy it through /etc/claude-desktop/managed-settings.json" },
    { key: "coworkEDRIntegrationVendor", kind: "text", group: "sandbox", scope: "both",
      label: "EDR Integration vendor ID",
      lock: "read from device management only and hidden in upstream's own wizard - deploy it through /etc/claude-desktop/managed-settings.json" },
    { key: "coworkFileReadCheck", kind: "json", group: "sandbox", scope: "3p",
      label: "File read check",
      lock: "undocumented upstream (available since v2.37337.1, public-undocumented) and hidden in its own wizard, which never shows it, so this page never writes it either" },
    { key: "organizationInstructions", kind: "text", group: "sandbox", scope: "3p", maxLen: 3000,
      label: "Organization instructions",
      note: "Free text appended in a delimited block after the app's own system prompt in Chat, Cowork and Code, presented to the model as outranking user preferences; guidance, not an enforced control, and capped at 3000 characters upstream." },
    { key: "disableDeepLinkRegistration", kind: "bool", group: "sandbox", scope: "3p",
      label: "Disable claude:// deep links" },
    { key: "disableWslSessions", kind: "bool", group: "sandbox", scope: "both",
      label: "Block WSL sessions", note: "Windows-only upstream; no effect on Linux." },
    { key: "relocateUncUserData", kind: "bool", group: "sandbox", scope: "1p",
      label: "Move app data off network shares",
      note: "Windows-only upstream (UNC %APPDATA% redirection); no effect on Linux." },
    { key: "requireCoworkFullVmSandbox", kind: "bool", group: "sandbox", scope: "1p",
      label: "Require the full VM sandbox" },
    { key: "secureVmFeaturesEnabled", kind: "bool", group: "sandbox", scope: "1p",
      label: "Secure VM features" },
    { key: "quickWriteEnabled", kind: "bool", group: "sandbox", scope: "1p",
      label: "Allow Quick Write",
      note: "Off on a managed computer until set to true." },
    { key: "blockReadsOutsideWorkingDirectories", kind: "bool", group: "sandbox", scope: "both",
      label: "Block reads outside working directories",
      note: "File tools refuse reads outside a Code session's working directories and sandboxed shell commands lose the home directory (available since v1.46388.1)." },
    { key: "disableBypassPermissionsMode", kind: "bool", group: "sandbox", scope: "3p",
      label: "Disable bypass permissions mode",
      note: "Removes the bypass permissions mode from Code sessions and Cowork tasks, so Claude always follows the permission policy (available since v1.46388.1)." },
    { key: "allowManagedHooksOnly", kind: "bool", group: "sandbox", scope: "3p",
      label: "Allow managed hooks only",
      note: "Locks Claude Code to hooks from managed settings (the host hands the lock to Claude Code on self-hosted sessions); added in v4.23118.0, availableInVersion @next." },
    { key: "disableDesktopLocalSessions", kind: "bool", group: "sandbox", scope: "3p",
      label: "Disable local Code sessions",
      note: "Code sessions run only on SSH hosts, never on this computer; without an SSH host allowlist Code may have nowhere to start a session (available since v2.42304.0)." },
    { key: "sshHostAllowlist", kind: "lines", group: "sandbox", scope: "3p",
      label: "SSH host allowlist",
      note: "One host pattern per line; empty means SSH sessions stay off unless the device's Claude Code managed-settings allowlist applies. * allows any host." },
    { key: "sshConfigs", kind: "json", group: "sandbox", scope: "3p",
      label: "SSH connections",
      note: "JSON array of up to 100 { id, name, sshHost, sshPort, sshIdentityFile } connections offered for SSH sessions; id, name and sshHost are required, sshIdentityFile is a key path on the device. Upstream asks the user to consent before applying it (available since v2.42304.0)." },
    { key: "sshTransport", kind: "enum", group: "sandbox", scope: "3p",
      label: "SSH connection engine", options: ["auto", "system-openssh", "builtin"],
      note: "system-openssh runs the connection through the ssh program on every platform; builtin uses the app's own SSH library." },
    { key: "sshClientPath", kind: "text", group: "sandbox", scope: "3p",
      label: "SSH client program",
      note: "Absolute path to the OpenSSH ssh program used for SSH sessions; unset uses the first ssh on PATH (available since v1.46388.1)." },
    { key: "builtinBrowserEnabled", kind: "bool", group: "sandbox", scope: "3p",
      label: "Allow the built-in browser",
      note: "Offers the built-in browser in Cowork and Code sessions; takes effect after an app restart." },
    { key: "builtinBrowserDefaultDomainPolicy", kind: "enum", group: "sandbox", scope: "3p",
      label: "Default site policy in the built-in browser", options: ["allow", "block"],
      note: "Whether Claude may open sites in the built-in browser by default; the allowed or blocked list is the exception." },
    { key: "builtinBrowserAllowedDomains", kind: "lines", group: "sandbox", scope: "3p",
      label: "Allowed sites in the built-in browser",
      note: "One site per line; the exceptions when the default site policy is block." },
    { key: "builtinBrowserBlockedDomains", kind: "lines", group: "sandbox", scope: "3p",
      label: "Blocked sites in the built-in browser",
      note: "One site per line; the exceptions when the default site policy is allow." },
    { key: "officeDisabledHosts", kind: "lines", group: "sandbox", scope: "3p",
      label: "Disabled Office applications",
      note: "One of sheet, slide, doc, mail per line - Office hosts where the Claude add-in for Microsoft 365 is turned off (upstream gates this @next)." },
    { key: "officeDisabledFeatures", kind: "lines", group: "sandbox", scope: "3p",
      label: "Disabled add-in features",
      note: "One of skills.authoring, thumbs, addin.access, file.upload, web_search per line; addin.access turns the add-in off (upstream gates this @next)." },
    { key: "officeAccessPolicies", kind: "json", group: "sandbox", scope: "3p",
      label: "Document access policies",
      note: "JSON array of { effect, action, resource } statements keyed on the Microsoft Purview sensitivity label of the open or attached file (upstream gates this @next)." },
    { key: "artifactsEnabled", kind: "bool", group: "sandbox", scope: "3p",
      label: "Reserved setting 1 (Claude Docs/Slides/Designs editors: all editors)",
      lock: "upstream titles it \"Reserved setting 1\" with no wizard group and a one-line description (\"Off until set to true.\"), available since v3.1623.0; it belongs to the Docs, Slides, Designs, Dashboards and Motion editors (\"Make Claude Docs, Slides, Designs and more\"), whose 3P switches are not documented yet, so this page never writes it" },
    { key: "artifactsDesignEnabled", kind: "bool", group: "sandbox", scope: "3p",
      label: "Reserved setting 2 (Claude Docs/Slides/Designs editors: Designs)",
      lock: "upstream titles it \"Reserved setting 2\" with no wizard group and a one-line description (\"Off until set to true.\"), available since v3.1623.0; it belongs to the Docs, Slides, Designs, Dashboards and Motion editors (\"Make Claude Docs, Slides, Designs and more\"), whose 3P switches are not documented yet, so this page never writes it" },
    { key: "artifactsSlidesEnabled", kind: "bool", group: "sandbox", scope: "3p",
      label: "Reserved setting 3 (Claude Docs/Slides/Designs editors: Slides)",
      lock: "upstream titles it \"Reserved setting 3\" with no wizard group and a one-line description (\"Off until set to true.\"), available since v3.1623.0; it belongs to the Docs, Slides, Designs, Dashboards and Motion editors (\"Make Claude Docs, Slides, Designs and more\"), whose 3P switches are not documented yet, so this page never writes it" },
    { key: "artifactsDashboardEnabled", kind: "bool", group: "sandbox", scope: "3p",
      label: "Reserved setting 4 (Claude Docs/Slides/Designs editors: Dashboards)",
      lock: "upstream titles it \"Reserved setting 4\" with no wizard group and a one-line description (\"Off until set to true.\"), available since v3.1623.0; it belongs to the Docs, Slides, Designs, Dashboards and Motion editors (\"Make Claude Docs, Slides, Designs and more\"), whose 3P switches are not documented yet, so this page never writes it" },
    { key: "artifactsMotionEnabled", kind: "bool", group: "sandbox", scope: "3p",
      label: "Reserved setting 5 (Claude Docs/Slides/Designs editors: Motion)",
      lock: "upstream titles it \"Reserved setting 5\" with no wizard group and a one-line description (\"Off until set to true.\"), available since v3.1623.0; it belongs to the Docs, Slides, Designs, Dashboards and Motion editors (\"Make Claude Docs, Slides, Designs and more\"), whose 3P switches are not documented yet, so this page never writes it" },
    { key: "disableDeploymentModeChooser", kind: "bool", group: "sandbox", scope: "3p",
      label: "Disable claude.ai sign-in",
      lock: "this is the key that locks a machine into 3P - it overrides the switch above, so this page never writes it" },
    { key: "deploymentMode", kind: "enum", group: "sandbox", scope: "both",
      label: "Deployment mode", options: ["any", "3p", "1p"],
      note: "any = Let people choose, 3p = Third-party only, 1p = Claude.ai only.",
      lock: "this policy key pins the mode (3p locks a machine into 3P, 1p turns 3P off) and overrides the switch above, so this page never writes it" },

    // --- connectors, MCP & extensions --------------------------------------
    { key: "managedMcpServers", kind: "json", group: "connectors", scope: "3p",
      label: "Managed MCP servers",
      lock: "an MCP server entry can start a process, so it is read-only here - deploy it through /etc/claude-desktop/managed-settings.json" },
    { key: "isLocalDevMcpEnabled", kind: "bool", group: "connectors", scope: "both",
      label: "Allow user-added MCP servers", dflt: true },
    { key: "allowedPluginMcpServers", kind: "json", group: "connectors", scope: "3p",
      label: "Allowed plugin MCP servers",
      note: "JSON array of { serverUrl } patterns, with * wildcards, that a plugin's remote MCP server must match. Up to 100 entries; an empty array blocks them all." },
    { key: "deniedPluginMcpServers", kind: "json", group: "connectors", scope: "3p",
      label: "Blocked plugin MCP servers",
      note: "JSON array of { serverUrl } patterns, with * wildcards, that a plugin's remote MCP server may not connect to even when the allowed list admits it; in Code sessions configuration-file servers too. Up to 100 entries; unset or empty blocks none." },
    { key: "mcpPersistentAlwaysAllowEnabled", kind: "bool", group: "connectors", scope: "3p",
      label: "Allow persistent tool approvals", dflt: true },
    { key: "mcpScheduledTaskApprovalLifetimeDays", kind: "int", group: "connectors", scope: "3p", max: 3650,
      label: "Scheduled-task tool approval lifetime (days)",
      note: "How many days a scheduled task may reuse a lasting MCP-tool approval before it asks again; blank changes nothing. Upstream also accepts 0 to remove the lasting option, which this page cannot write (available since v2.7032.0)." },
    { key: "mcpToolTimeoutSec", kind: "int", group: "connectors", scope: "3p", max: 3600,
      label: "MCP tool call timeout (s)",
      note: "Per-call deadline for every MCP tool call, 60 to 3600; Cowork and Chat default to 180, and setting it introduces a timeout in Code sessions too (available since v1.37937.0)." },
    { key: "mcpAppWidgetsEnabled", kind: "bool", group: "connectors", scope: "3p",
      label: "Show widgets from session host connectors",
      note: "For self-hosted sessions only: lets the session host pass connector widgets to the app; no session host reads it yet (in the schema since v4.4212.0, which marks it for an upcoming release)." },
    { key: "claudeInChromeEnabled", kind: "bool", group: "connectors", scope: "3p",
      label: "Enable Claude in Chrome",
      // Linux only: the downstream Windows build carries this file unedited and
      // its upstream bundle may differ.
      note: process.platform === "linux"
        ? "Not available in Anthropic's Linux build yet: with this on, the app reports Claude in Chrome as disabled because it is not supported on this platform (checked on v4.23118.1)."
        : undefined },
    { key: "claudeInChromePasswordManagersEnabled", kind: "bool", group: "connectors", scope: "3p",
      label: "Enable password managers in Claude in Chrome",
      lock: "set by the Anthropic control plane from the organization's Claude in Chrome password-manager setting and hidden in upstream's own wizard, so this page never writes it" },
    { key: "isDesktopExtensionEnabled", kind: "bool", group: "connectors", scope: "both",
      label: "Allow desktop extensions" },
    { key: "isDesktopExtensionSignatureRequired", kind: "bool", group: "connectors", scope: "both",
      label: "Require signed extensions" },
    { key: "isDesktopExtensionDirectoryEnabled", kind: "bool", group: "connectors", scope: "1p",
      label: "Show the extension directory" },
    { key: "microsoftAuthBroker", kind: "enum", group: "connectors", scope: "3p",
      label: "Microsoft 365 sign-in broker", options: ["auto", "disabled"] },
    { key: "microsoftAuthDefaultAccount", kind: "enum", group: "connectors", scope: "3p",
      label: "Microsoft 365 sign-in with the Windows account", options: ["enabled", "disabled"],
      note: "Windows-only upstream (silent sign-in with the account signed in to Windows); no effect on Linux." },
    { key: "hardwareBuddyEnabled", kind: "bool", group: "connectors", scope: "1p",
      label: "Allow Hardware Buddy devices", dflt: true },
    { key: "disableConnectorSignInInApp", kind: "bool", group: "connectors", scope: "1p",
      label: "Keep connector sign-in in the browser",
      note: "A claude.ai connector (remote MCP) OAuth sign-in completes in the system browser instead of the app finishing it from a claude:// link; applies from the next launch." },

    // --- plugins ------------------------------------------------------------
    { key: "allowedPluginMarketplaces", kind: "json", group: "plugins", scope: "3p",
      label: "Allowed plugin marketplaces" },
    { key: "orgPluginSettings", kind: "json", group: "plugins", scope: "3p",
      label: "Organization plugin settings" },
    { key: "sharingEndpoint", kind: "json", group: "plugins", scope: "3p", secret: true,
      label: "Organization sharing endpoint",
      note: "HTTPS endpoint that receives the skills and plugins users publish to the organization; when set, users get a Publish to organization action. Nothing is installed from it." },

    { key: "skillBundles", kind: "json", group: "plugins", scope: "3p",
      label: "Skill bundles",
      note: "JSON array of skills the client downloads and installs for every user; names must be unique and the hosted console stores at most 20 (upstream gates this @next)." },

    // --- telemetry, updates & identity -------------------------------------
    { key: "otlpEndpoint", kind: "text", group: "telemetry", scope: "3p",
      label: "OpenTelemetry collector endpoint" },
    { key: "otlpProtocol", kind: "enum", group: "telemetry", scope: "3p",
      label: "OTLP protocol", options: ["http/protobuf", "http/json", "grpc"] },
    { key: "otlpHeaders", kind: "json", group: "telemetry", scope: "3p", secret: true,
      label: "OTLP exporter headers" },
    { key: "otlpAuthMode", kind: "enum", group: "telemetry", scope: "3p",
      label: "Collector authentication", options: ["none", "inference-credential"] },
    { key: "otlpHeadersHelper", kind: "text", group: "telemetry", scope: "3p",
      label: "OTLP headers helper script",
      note: "Absolute path to an executable that prints a JSON object of collector headers; merged over the static headers." },
    { key: "otlpResourceAttributes", kind: "json", group: "telemetry", scope: "3p",
      label: "OTLP resource attributes" },
    { key: "otlpDesktopLogLevel", kind: "enum", group: "telemetry", scope: "3p",
      label: "Desktop telemetry export level", options: ["off", "error", "warn", "info", "debug"] },
    { key: "otlpContentCapture", kind: "json", group: "telemetry", scope: "both",
      label: "Content capture categories", note: "JSON array, e.g. [\"prompt\", \"completion\"]." },
    { key: "otlpTracesEnabled", kind: "bool", group: "telemetry", scope: "3p", label: "Export traces (beta)" },
    { key: "disableEssentialTelemetry", kind: "bool", group: "telemetry", scope: "3p",
      label: "Block essential telemetry", dflt: true },
    { key: "disableNonessentialTelemetry", kind: "bool", group: "telemetry", scope: "3p",
      label: "Block nonessential telemetry", dflt: true },
    { key: "disableNonessentialServices", kind: "bool", group: "telemetry", scope: "3p",
      label: "Block nonessential services" },
    { key: "disableLocalConfigCache", kind: "bool", group: "telemetry", scope: "3p",
      label: "Keep only the organization ID and restrictions on disk",
      note: "Does not keep the organization's name or any permissive setting on disk between launches (available since v2.7032.0)." },
    { key: "disableAutoUpdates", kind: "bool", group: "telemetry", scope: "both",
      label: "Block auto-updates",
      note: "Packaged builds are updated by your package manager, so this only silences the in-app updater." },
    { key: "autoUpdaterEnforcementHours", kind: "int", group: "telemetry", scope: "both",
      label: "Auto-update enforcement window (h)", max: 72 },
    { key: "installedUpdateEnforcementEnabled", kind: "bool", group: "telemetry", scope: "both",
      label: "Restart to apply installed updates",
      note: "Only while Block auto-updates is on: when a newer version is installed while the app is open and nobody relaunches within the window below, the app restarts itself; on Linux any replacement of the app counts. Set it where Block auto-updates is set. Applies to a running app (available since v3.6556.1)." },
    { key: "installedUpdateEnforcementHours", kind: "int", group: "telemetry", scope: "both", max: 72,
      label: "Installed-update enforcement window (h)",
      note: "Hours of open, awake app time before that restart; blank means 72 and then waits for the computer to be idle, a number restarts once it elapses. No effect unless the restart above is on (available since v3.6556.1)." },
    { key: "deploymentOrganizationUuid", kind: "text", group: "telemetry", scope: "3p",
      label: "Organization UUID" },
    { key: "endUserAttribution", kind: "bool", group: "telemetry", scope: "3p", label: "End-user attribution",
      note: "Renamed upstream in v1.24012 (the all-lowercase enduserAttribution is still read as a legacy key)." },
    { key: "updateViaUpdatesHost", kind: "bool", group: "telemetry", scope: "3p",
      label: "Check for updates on releases.claude.com",
      note: "Available since v1.26832.0." },
    { key: "releaseChannel", kind: "enum", group: "telemetry", scope: "3p",
      label: "Release channel", options: ["stable", "staggered"],
      note: "Staggered devices get newer releases, security fixes included, later than Stable; unset means stable and an unreadable value counts as staggered. Applies to a running app (available since v3.1623.0)." },

    { key: "otlpAttrMaxChars", kind: "int", group: "telemetry", scope: "3p", max: 32000,
      label: "Telemetry attribute length limit",
      note: "Maximum characters per content-bearing span attribute sent to the collector, 256 to 32000; default 4000 (available since v2.31226.0)." },
    { key: "usageMetricsEnabled", kind: "bool", group: "telemetry", scope: "3p",
      label: "Report usage metrics",
      lock: "set by the Anthropic control plane from the organization's Claude Code analytics setting and hidden in upstream's own wizard, so this page never writes it" },
    { key: "relaunchEnforcementHours", kind: "int", group: "telemetry", scope: "3p", max: 336,
      label: "Configuration relaunch window (h)",
      note: "Hours a user may keep working on the old configuration after a managed-configuration change is detected; blank means 24. Upstream also accepts 0 for an immediate restart, which this page cannot write." },
    { key: "dangerousMaxVersion", kind: "text", group: "telemetry", scope: "3p",
      label: "Maximum version",
      note: "Pins auto-update to at most this X.Y.Z version. Upstream marks it dangerous: a device left behind stops getting fixes." },
    { key: "configRecheckIntervalMinutes", kind: "int", group: "telemetry", scope: "3p", max: 30,
      label: "Configuration re-check interval (min)",
      note: "Minutes between the running app's checks for a changed managed configuration, 2 to 30; blank means 10 (available since v1.46388.1)." },

    // --- appearance & branding ---------------------------------------------
    { key: "deploymentDisplayName", kind: "text", group: "appearance", scope: "3p",
      label: "Deployment display name" },
    { key: "deploymentDisplaySubtitle", kind: "text", group: "appearance", scope: "3p",
      label: "Deployment display subtitle" },
    { key: "banner", kind: "json", group: "appearance", scope: "both", label: "Organization banner" },
    { key: "disableFeatureDiscovery", kind: "bool", group: "appearance", scope: "3p",
      label: "Hide feature announcements" },
    { key: "sessionStatusLine", kind: "json", group: "appearance", scope: "3p",
      label: "Status line",
      note: "JSON object { \"command\": \"/opt/example/bin/status-line\" } naming the program that draws the session status line; asks the user for consent first, and on Linux the program and every folder above it must belong to root and not be writable by group or others (in the schema since v4.4212.0, which marks it for an upcoming release)." },

    { key: "disableConfigDeprecationWarnings", kind: "bool", group: "appearance", scope: "both",
      label: "Hide configuration deprecation warnings",
      note: "Hides the in-app warning that this configuration uses a deprecated field; the final reminder in the 24 hours before the cut-off still appears." },

    // --- bootstrap & import -------------------------------------------------
    { key: "bootstrapUrl", kind: "text", group: "source", scope: "3p",
      label: "Bootstrap config URL",
      note: "A remote config endpoint. Counts as an inference block on its own, so it can select 3P without a provider." },
    { key: "bootstrapEnabled", kind: "bool", group: "source", scope: "3p",
      label: "Use the bootstrap config", dflt: true },
    { key: "bootstrapOidc", kind: "json", group: "source", scope: "3p", secret: true,
      label: "Bootstrap OIDC parameters" },
    { key: "bootstrapHeaders", kind: "json", group: "source", scope: "3p", secret: true,
      label: "Bootstrap request headers",
      note: "JSON object of HTTP headers sent on every bootstrap config fetch - use instead of embedding user:pass@ in the URL (available since v1.32885.1)." },
    { key: "bootstrapHeadersHelper", kind: "text", group: "source", scope: "3p",
      label: "Bootstrap headers helper script",
      note: "Absolute path to an executable that prints a JSON object of bootstrap headers; merged over the static headers, the helper wins (available since v1.32885.1)." },
    { key: "trustBootstrapDelivery", kind: "bool", group: "source", scope: "3p",
      label: "Trust bootstrap-delivered settings",
      note: "Skips the per-user consent prompt for bootstrap-delivered sign-in targets." },
    { key: "claudeAiImport", kind: "bool", group: "source", scope: "3p", label: "Allow claude.ai data import" }
  ];

  var __cdbEx_DEPLOY_GROUPS = [
    { key: "connection", label: "Inference & connection" },
    { key: "limits", label: "Usage limits" },
    { key: "sandbox", label: "Surfaces, sandbox & tools" },
    { key: "connectors", label: "Connectors, MCP & extensions" },
    { key: "plugins", label: "Plugins" },
    { key: "telemetry", label: "Telemetry, updates & identity" },
    { key: "appearance", label: "Appearance & branding" },
    { key: "source", label: "Bootstrap & import" }
  ];

  function __cdbEx_deployKey(key) {
    for (var i = 0; i < __cdbEx_DEPLOY_KEYS.length; i++) {
      if (__cdbEx_DEPLOY_KEYS[i].key === key) return __cdbEx_DEPLOY_KEYS[i];
    }
    return null;
  }

  function __cdbEx_readJson(file) {
    var raw;
    try {
      raw = _fs.readFileSync(file, "utf8");
    } catch (e) {
      return { missing: e.code === "ENOENT", error: e.code === "ENOENT" ? "" : e.message };
    }
    try {
      var v = JSON.parse(raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw);
      if (!v || typeof v !== "object" || Array.isArray(v)) {
        return { error: "top level must be a JSON object" };
      }
      return { value: v };
    } catch (e2) {
      return { error: "invalid JSON (" + e2.message + ")" };
    }
  }

  // Atomic, 0600, parent dir 0700 - the same shape upstream writes these files
  // with, because they can hold inference credentials.
  function __cdbEx_writeJson(file, value) {
    var tmp = file + ".cdb-tmp";
    try {
      _fs.mkdirSync(_path.dirname(file), { recursive: true, mode: __cdbEx_DMODE });
    } catch (e) {
      if (e.code !== "EEXIST") return "cannot create " + _path.dirname(file) + ": " + e.message;
    }
    try {
      _fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: __cdbEx_FMODE });
      _fs.renameSync(tmp, file);
    } catch (e2) {
      try { _fs.unlinkSync(tmp); } catch (e3) {}
      return "cannot write " + file + ": " + e2.message;
    }
    return "";
  }

  // The managed file is only reported, never written: it needs root, and when it
  // is valid it disables the local source completely. Its ownership rules are
  // upstream's, mirrored here so the page can say WHY it is being ignored.
  function __cdbEx_managedState() {
    var out = { present: false, usable: false, keys: [], provider: null, locksSignIn: false,
      policyMode: "any", error: "" };
    var st;
    try {
      st = _fs.lstatSync(__cdbEx_ETC_FILE);
    } catch (e) {
      if (e.code !== "ENOENT") out.error = e.message;
      return out;
    }
    out.present = true;
    if (!st.isFile()) { out.error = "not a regular file"; return out; }
    if (st.uid !== 0 || (st.mode & 18) !== 0) {
      out.error = "ignored by Claude Desktop: must be owned by root and not group- or world-writable";
      return out;
    }
    try {
      var dst = _fs.lstatSync(__cdbEx_ETC_DIR);
      if (dst.isSymbolicLink() || !dst.isDirectory() || dst.uid !== 0 || (dst.mode & 18) !== 0) {
        out.error = "ignored by Claude Desktop: " + __cdbEx_ETC_DIR +
          " must be owned by root and not group- or world-writable";
        return out;
      }
    } catch (e2) {
      out.error = e2.message;
      return out;
    }
    var read = __cdbEx_readJson(__cdbEx_ETC_FILE);
    if (!read.value) { out.error = "ignored by Claude Desktop: " + (read.error || "unreadable"); return out; }
    var cfg = read.value;
    out.keys = Object.keys(cfg);
    // One unknown key makes upstream discard the WHOLE managed file, so name it
    // rather than letting the user wonder why their policy does nothing.
    var unknown = out.keys.filter(function (k) { return !__cdbEx_deployKey(k); });
    if (unknown.length) {
      out.error = "carries key(s) this build does not know (" + unknown.slice(0, 4).join(", ") +
        ") - Claude Desktop ignores the whole file";
      return out;
    }
    out.usable = true;
    out.provider = typeof cfg.inferenceProvider === "string" ? cfg.inferenceProvider : null;
    out.policyMode = __cdbEx_policyMode(cfg);
    // "1P cannot be selected": the policy pins 3P (deploymentMode "3p", or
    // disableDeploymentModeChooser without a deploymentMode).
    out.locksSignIn = out.policyMode === "3p";
    return out;
  }

  function __cdbEx_meta(paths) {
    var read = __cdbEx_readJson(paths.metaFile);
    var meta = read.value || {};
    var entries = Array.isArray(meta.entries) ? meta.entries.filter(function (e) {
      return e && typeof e === "object" && typeof e.id === "string" && /^[a-f0-9-]{36}$/.test(e.id);
    }) : [];
    var applied = typeof meta.appliedId === "string" && /^[a-f0-9-]{36}$/.test(meta.appliedId)
      ? meta.appliedId : "";
    return {
      raw: meta,
      error: read.error || "",
      appliedId: applied,
      entries: entries.map(function (e) {
        return { id: e.id, name: typeof e.name === "string" ? e.name : "" };
      })
    };
  }

  function __cdbEx_entryFile(paths, id) {
    return _path.join(paths.libDir, id + ".json");
  }

  // A value the remote page may see. Secrets never cross: it learns THAT one is
  // stored, never what it is, and echoing the placeholder back keeps it.
  function __cdbEx_deployValue(entry, value) {
    if (value === undefined) return undefined;
    if (entry.secret || entry.kind === "secret") return __cdbEx_KEEP;
    return value;
  }

  function __cdbEx_deployProjection(cfg) {
    var out = {};
    var unknown = [];
    Object.keys(cfg || {}).forEach(function (k) {
      var entry = __cdbEx_deployKey(k);
      if (!entry) { unknown.push(k); return; }
      out[k] = __cdbEx_deployValue(entry, cfg[k]);
    });
    return { values: out, unknown: unknown };
  }

  // Does this config select 3P at all? Upstream's own test (k2, v4.16336.0):
  // an inference block (i.e. a provider), an enabled bootstrap URL, or a
  // selfHosted block (flat: selfHostedUrl / selfHostedToken).
  //   function k2(e){return O2??=[...y2.values()].flatMap((e=>e.activatesThirdPartyMode??[])),
  //     O2.some((t=>t(e,!1)))||TZ(e)||HG(e).length>0}   TZ(e): e.selfHosted!==void 0
  function __cdbEx_selects3p(cfg) {
    if (!cfg) return false;
    if (typeof cfg.inferenceProvider === "string" && cfg.inferenceProvider) return true;
    if (cfg.selfHostedUrl !== undefined || cfg.selfHostedToken !== undefined) return true;
    return typeof cfg.bootstrapUrl === "string" && !!cfg.bootstrapUrl && cfg.bootstrapEnabled !== false;
  }

  function __cdbEx_persistedMode(paths) {
    var read = __cdbEx_readJson(paths.modeFile);
    var m = read.value && read.value[__cdbEx_MODE_KEY];
    return m === "1p" || m === "3p" ? m : null;
  }

  // What the app is running RIGHT NOW. The relocated userData is the honest
  // answer whenever the relocation is in play at all; with CLAUDE_USER_DATA_DIR
  // set upstream skips it entirely, and then the config sources are all we have.
  function __cdbEx_runningMode(expected) {
    if (process.env.CLAUDE_USER_DATA_DIR) return expected;
    return /-3p$/.test(_app.getPath("userData")) ? "3p" : "1p";
  }

  function __cdbEx_deployState() {
    var paths = __cdbEx_deployPaths();
    var managed = __cdbEx_managedState();
    var meta = __cdbEx_meta(paths);
    var local = {
      appliedId: meta.appliedId,
      entries: meta.entries,
      present: false,
      file: "",
      values: {},
      unknown: [],
      error: meta.error
    };
    if (meta.appliedId) {
      local.file = __cdbEx_entryFile(paths, meta.appliedId);
      var read = __cdbEx_readJson(local.file);
      if (read.value) {
        local.present = true;
        var proj = __cdbEx_deployProjection(read.value);
        local.values = proj.values;
        local.unknown = proj.unknown;
        local.selects3p = __cdbEx_selects3p(read.value);
      } else if (!read.missing) {
        local.error = read.error;
      }
    }
    var persisted = __cdbEx_persistedMode(paths);
    // Same decision the bootstrap makes, in the same order.
    var source = managed.usable && managed.keys.length ? "managed" : (local.present ? "local" : "none");
    var active = source === "managed"
      ? { provider: managed.provider, selects3p: !!managed.provider, locksSignIn: managed.locksSignIn,
          policyMode: managed.policyMode }
      : { provider: local.values.inferenceProvider || null, selects3p: !!local.selects3p, locksSignIn: false,
          policyMode: "any" };
    var expected = __cdbEx_decideMode(active.selects3p, active.policyMode, persisted);
    return {
      paths: paths,
      managed: managed,
      local: local,
      source: source,
      persisted: persisted,
      expected: expected,
      running: __cdbEx_runningMode(expected),
      editable: source !== "managed",
      locksSignIn: active.locksSignIn,
      policyMode: active.policyMode
    };
  }

  // Coerce one page value into what the schema accepts, or explain why not.
  // null / "" always means "remove the key".
  function __cdbEx_deployCoerce(entry, value) {
    if (value === null || value === undefined) return { del: true };
    if (entry.secret || entry.kind === "secret") {
      if (value === __cdbEx_KEEP) return { keep: true };
    }
    switch (entry.kind) {
      case "bool":
        if (typeof value !== "boolean") return { error: entry.key + " must be true or false" };
        return { value: value };
      case "enum":
        if (typeof value !== "string") return { error: entry.key + " must be a string" };
        if (!value) return { del: true };
        if (entry.options.indexOf(value) < 0) {
          return { error: entry.key + " must be one of " + entry.options.join(", ") };
        }
        return { value: value };
      case "int":
        if (typeof value === "string" && !value.trim()) return { del: true };
        var n = typeof value === "number" ? value : Number(value);
        if (!isFinite(n) || Math.floor(n) !== n || n <= 0) {
          return { error: entry.key + " must be a positive whole number" };
        }
        if (entry.max && n > entry.max) return { error: entry.key + " must be at most " + entry.max };
        return { value: n };
      case "num":
        if (typeof value === "string" && !value.trim()) return { del: true };
        var f = typeof value === "number" ? value : Number(value);
        if (typeof value === "boolean" || !isFinite(f)) {
          return { error: entry.key + " must be a number" };
        }
        // min is exclusive, matching the schema's gt()/lte() pair.
        if (entry.min !== undefined && f <= entry.min) {
          return { error: entry.key + " must be greater than " + entry.min };
        }
        if (entry.max !== undefined && f > entry.max) {
          return { error: entry.key + " must be at most " + entry.max };
        }
        return { value: f };
      case "text":
      case "secret":
        if (typeof value !== "string") return { error: entry.key + " must be a string" };
        if (!value.trim()) return { del: true };
        // entry.maxLen mirrors upstream's own zod .max() where it is tighter than
        // our generic ceiling. Writing a value upstream rejects is worse than a
        // plain UI error: managed-settings.json is validated as ONE object, so a
        // single out-of-range field can invalidate the whole file.
        var __cap = typeof entry.maxLen === "number" ? entry.maxLen : 4096;
        if (value.length > __cap) return { error: entry.key + " is too long (max " + __cap + ")" };
        return { value: value.trim() };
      case "lines":
      case "models":
        var list = Array.isArray(value) ? value : String(value).split("\n");
        list = list.map(function (v) { return typeof v === "string" ? v.trim() : v; })
          .filter(function (v) { return typeof v !== "string" || v.length > 0; });
        if (!list.length) return { del: true };
        if (list.length > 200) return { error: entry.key + " has too many entries" };
        for (var i = 0; i < list.length; i++) {
          // Model entries may also be objects ({ name, labelOverride, supports1m,
          // ... }), which the page shows as one JSON line each. Plain lists stay
          // strings only.
          if (entry.kind === "models" && typeof list[i] === "string" && list[i].charAt(0) === "{") {
            try { list[i] = JSON.parse(list[i]); } catch (e) {
              return { error: entry.key + ": line " + (i + 1) + ": " + e.message };
            }
          }
          if (entry.kind === "models" && list[i] !== null && typeof list[i] === "object" && !Array.isArray(list[i])) {
            if (typeof list[i].name !== "string" || !list[i].name.trim()) {
              return { error: entry.key + ": line " + (i + 1) + " needs a \"name\"" };
            }
            if (list[i].name.length > 300 || JSON.stringify(list[i]).length > 2000) {
              return { error: entry.key + " has an over-long entry" };
            }
            continue;
          }
          if (typeof list[i] !== "string") {
            return { error: entry.key + (entry.kind === "models"
              ? " entries must be model ids or { \"name\": ... } objects"
              : " must be a list of strings") };
          }
          if (list[i].length > 300) return { error: entry.key + " has an over-long entry" };
        }
        return { value: list };
      case "json":
        var parsed = value;
        if (typeof value === "string") {
          if (!value.trim()) return { del: true };
          try { parsed = JSON.parse(value); } catch (e) { return { error: entry.key + ": " + e.message }; }
        }
        if (parsed === null || typeof parsed !== "object") {
          return { error: entry.key + " must be a JSON object or array" };
        }
        if (JSON.stringify(parsed).length > 20000) return { error: entry.key + " is too large" };
        return { value: parsed };
      default:
        return { error: "unsupported kind for " + entry.key };
    }
  }

  // Mutate the APPLIED config entry, creating the library the way upstream does
  // when it has none: one entry named "Default", applied. Editing the applied
  // entry rather than adding our own is what keeps this page and upstream's 3P
  // Setup window looking at the same configuration.
  function __cdbEx_writeEntry(mutate) {
    var paths = __cdbEx_deployPaths();
    var meta = __cdbEx_meta(paths);
    if (meta.error) return { ok: false, error: paths.metaFile + ": " + meta.error };

    var id = meta.appliedId;
    var entries = meta.entries.slice();
    var created = false;
    if (!id) {
      id = entries.length ? entries[0].id : __cdbEx_uuid();
      if (!entries.length) { entries = [{ id: id, name: "Default" }]; created = true; }
    }
    var file = __cdbEx_entryFile(paths, id);
    var read = __cdbEx_readJson(file);
    if (read.error) return { ok: false, error: file + ": " + read.error };
    var cfg = read.value || {};

    var err = mutate(cfg);
    if (err) return { ok: false, error: err };

    var w = __cdbEx_writeJson(file, cfg);
    if (w) return { ok: false, error: w };
    if (meta.appliedId !== id || created || !meta.raw.entries) {
      var next = { appliedId: id, entries: entries.length ? entries : [{ id: id, name: "Default" }] };
      Object.keys(meta.raw).forEach(function (k) {
        if (k !== "appliedId" && k !== "entries") next[k] = meta.raw[k];
      });
      var w2 = __cdbEx_writeJson(paths.metaFile, next);
      if (w2) return { ok: false, error: "config written but not applied: " + w2 };
    }
    return { ok: true, id: id, file: file, created: created, config: cfg };
  }

  // --- opening our own files ------------------------------------------------
  // The page asks for a LOCATION BY NAME and never sends a path: shell.openPath
  // hands a file to the desktop's default handler, so letting remote code choose
  // the target would be a way to launch things. Every name below resolves to one
  // of the files this package writes (plus the read-only managed policy file).
  function __cdbEx_revealTarget(name) {
    var p = __cdbEx_paths();
    var d = __cdbEx_deployPaths();
    switch (name) {
      case "config-json": return p.json;
      case "config-jsonc": return p.jsonc;
      case "user-data": return p.userData;
      case "deploy-config":
        var meta = __cdbEx_meta(d);
        return meta.appliedId ? __cdbEx_entryFile(d, meta.appliedId) : d.libDir;
      case "deploy-mode": return d.modeFile;
      case "deploy-meta": return d.metaFile;
      case "deploy-lib": return d.libDir;
      case "managed": return __cdbEx_ETC_FILE;
      default: return "";
    }
  }

  function __cdbEx_uuid() {
    try {
      var c = require("crypto");
      if (c && typeof c.randomUUID === "function") return c.randomUUID();
    } catch (e) {}
    var hex = "0123456789abcdef";
    var out = "";
    for (var i = 0; i < 36; i++) {
      out += (i === 8 || i === 13 || i === 18 || i === 23) ? "-"
        : hex[Math.floor(Math.random() * 16)];
    }
    return out;
  }

  // --- sender validation ---------------------------------------------------
  // The exact-origin allowlist (claude.ai/claude.com plus app://localhost, the
  // main window in 3P mode), the "null"-origin normalisation and the main-frame
  // check live in ONE place, js/sender_guard.js, which the core patch emits
  // ahead of this IIFE as globalThis.__cdbSenderGuard; every main-side module
  // of ours consults it. The handlers behind this guard write the 3P gateway
  // URL, its API key and the bootstrap URL, and relaunch the app.
  //
  // Looked up at CALL time, never captured at load, and a missing guard is
  // "not ok": the check fails closed whatever the evaluation order.
  function __cdbEx_originAllowed(rawUrl) {
    var g = globalThis.__cdbSenderGuard;
    return !!g && g.originAllowed(rawUrl);
  }
  function __cdbEx_okSender(ev) {
    var g = globalThis.__cdbSenderGuard;
    return !!g && g.okSender(ev);
  }

  // A handler marked by __cdbEx_withSender gets the (already checked) event as
  // its only argument instead of the page's arguments.
  function __cdbEx_withSender(fn) { fn.__cdbExWithSender = true; return fn; }
  function __cdbEx_guard(fn) {
    return function (ev) {
      if (!__cdbEx_okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
      try {
        if (fn.__cdbExWithSender === true) return fn(ev);
        return fn.apply(null, Array.prototype.slice.call(arguments, 1));
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      }
    };
  }

  // --- Computer Use on a background display (issue #300) -------------------
  // The setup half of the switch. The executor (js/cu_linux_executor.js) reads
  // the same key itself at every CU lock; this file only persists it and feeds
  // the setup panel: which displays exist, what the bundled bridge says about
  // each, a downscaled screenshot, the restrictions that apply right now, which
  // helper tools are installed, and a Test (screenshot + pointer-move).
  //
  // NEVER BLOCKS (issues #184/#232): every child is an async execFile with a
  // hard timeout, every file and /proc read below is fs.promises, nothing runs
  // at module load - only when the panel asks. Children run through a small
  // queue so a page that loops cannot fork-bomb the main process; screenshots
  // are coalesced per display and capped in size, the /proc scan is cached.
  // The one sync step is the WRITE in cdb-cubg:set, through __cdbEx_writeCfg,
  // the single writer every row shares.
  //
  // SECURITY: the caller is remote code. kind/display are re-validated here,
  // and Claude's own display ("display 1") is never probed, screenshotted,
  // tested or saved - not even switched off. Identity is decided like the
  // executor decides it (spec ruling "T8 review"): x11 by display NUMBER
  // (no leading zeros, so ":00" cannot alias ":0"), wlroots by the (dev, ino)
  // of the socket after following symlinks. The page cannot write `env`: an
  // env map ends up in the environment of every app Computer Use launches, so
  // only a hand-edited file may carry one. A write from the page keeps it for
  // the same display and drops it when the display changes (it belongs to one).
  var __cdbEx_CUBG_KEY = "computerUseBackgroundDisplay";
  var __cdbEx_CUBG_TIMEOUT_MS = 5000;
  var __cdbEx_CUBG_X11_DIR = "/tmp/.X11-unix";
  var __cdbEx_CUBG_MAX_CHILDREN = 6;
  var __cdbEx_CUBG_MAX_QUEUED = 48;
  var __cdbEx_CUBG_THUMB_W = 480;
  var __cdbEx_CUBG_SHOT_MAX = 64 * 1024 * 1024;
  var __cdbEx_CUBG_PROC_TTL_MS = 5000;
  var __cdbEx_CUBG_SHOT_MIN_MS = 2000;
  var __cdbEx_CUBG_BUSY = "busy - too many checks at once, refresh in a moment";
  // Resolved exactly like js/cu_mode_preamble.js resolves them: the env
  // override first, then the bundled copy in process.resourcesPath.
  var __cdbEx_CUBG_BRIDGES = {
    x11: { name: "x11-bridge", envVar: "X11_BRIDGE_BIN" },
    wlroots: { name: "wlroots-bridge", envVar: "WLROOTS_BRIDGE_BIN" }
  };
  // Tools the recipes and restrictions mention; looked up on PATH, never run.
  var __cdbEx_CUBG_TOOLS = ["Xvfb", "Xephyr", "sway", "labwc", "xfwm4", "openbox", "i3",
    "x11vnc", "wayvnc", "xclip", "xsel", "wl-copy", "wl-paste", "xprop"];
  // /proc/<pid>/status Name (the 15-char comm) -> the app a hint names.
  var __cdbEx_CUBG_SINGLE = {
    "firefox": "Firefox", "firefox-bin": "Firefox", "firefox-esr": "Firefox",
    "chromium": "Chromium", "chromium-browse": "Chromium",
    "chrome": "Google Chrome", "google-chrome": "Google Chrome"
  };
  // Never part of the env map: PATH and CLAUDE_ELECTRON belong to the
  // launcher, LD_* would load code into every child.
  function __cdbEx_cubgEnvKeyBad(k) {
    return k === "PATH" || k === "CLAUDE_ELECTRON" || /^LD_/.test(k);
  }

  var __cdbEx_cubgCpMod = null;
  function __cdbEx_cubgCp() {
    return __cdbEx_cubgCpMod || (__cdbEx_cubgCpMod = require("child_process"));
  }

  function __cdbEx_cubgDisplayOk(kind, display) {
    if (typeof display !== "string") return false;
    if (kind === "x11") return /^:(0|[1-9]\d{0,4})$/.test(display);
    if (kind === "wlroots") {
      if (/^wayland-[A-Za-z0-9._-]{1,64}$/.test(display)) return !/\.lock$/.test(display);
      return display.length <= 255 && display.charAt(0) === "/" && display.indexOf("\0") < 0 &&
        !/(^|\/)\.\.?(\/|$)/.test(display) && !/\.lock$/.test(display);
    }
    return false;
  }

  function __cdbEx_cubgEnvCheck(env) {
    if (env === undefined) return null;
    if (!env || typeof env !== "object" || Array.isArray(env)) return "env must be an object of strings";
    var keys = Object.keys(env);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return "env key \"" + k + "\" is not a variable name";
      if (__cdbEx_cubgEnvKeyBad(k)) return "env may not set " + k;
      if (typeof env[k] !== "string") return "env value of " + k + " must be a string";
    }
    return null;
  }

  // The one validator for the key. {ok, value, error}: value is the normalized
  // contract shape, error the first reason it is not usable. Invalid while
  // enabled means Computer Use refuses to run (fail closed), so the page shows
  // the error rather than guessing.
  function __cdbEx_cubgValidate(v) {
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      return { ok: false, error: __cdbEx_CUBG_KEY + " must be an object" };
    }
    if (typeof v.enabled !== "boolean") return { ok: false, error: "enabled must be true or false" };
    if (v.kind !== "x11" && v.kind !== "wlroots") return { ok: false, error: "kind must be \"x11\" or \"wlroots\"" };
    if (!__cdbEx_cubgDisplayOk(v.kind, v.display)) {
      return { ok: false, error: v.kind === "x11"
        ? "display must look like \":99\" (no leading zeros) for kind x11"
        : "display must be a socket name like \"wayland-1\" or an absolute socket path for kind wlroots" };
    }
    var envErr = __cdbEx_cubgEnvCheck(v.env);
    if (envErr) return { ok: false, error: envErr };
    var out = { enabled: v.enabled, kind: v.kind, display: v.display };
    if (v.env !== undefined) out.env = v.env;
    return { ok: true, value: out };
  }

  // Claude's own session ("display 1"): the NUMBER of its X display (from
  // DISPLAY in any host:N.S form, XWayland included) and its Wayland socket
  // resolved against XDG_RUNTIME_DIR.
  function __cdbEx_cubgOwn() {
    // Anchored at the end only, so "[::1]:0", "::1:0" and "host::0" parse too.
    var m = /:(\d+)(?:\.\d+)?$/.exec(process.env.DISPLAY || "");
    var w = process.env.WAYLAND_DISPLAY || "";
    return {
      x11: m ? Number(m[1]) : null, wayland: w || null,
      waylandPath: __cdbEx_cubgWlPath(w, process.env.XDG_RUNTIME_DIR || "") || null
    };
  }

  function __cdbEx_cubgWlPath(display, rt) {
    if (!display) return "";
    if (display.charAt(0) === "/") return display;
    // Only an absolute runtime dir counts (as in the executor's reader).
    return rt && rt.charAt(0) === "/" ? _path.join(rt, display) : "";
  }

  // Is kind/display Claude's own desktop? Resolves {own, missing, notSocket,
  // error}. x11 compares numbers. wlroots stats the target (fs.promises.stat
  // follows symlinks, so /proc/self/root/... or /var/run/... aliases resolve
  // to the real socket) and compares (dev, ino) with Claude's own socket; a
  // target that does not exist cannot be the desktop and reports `missing`.
  // `rt` is the XDG_RUNTIME_DIR the bridge will resolve a relative name in.
  function __cdbEx_cubgIdentity(kind, display, rt) {
    var own = __cdbEx_cubgOwn();
    // `key` names the display itself, not its spelling: what screenshots are
    // coalesced and rate-limited on.
    if (kind === "x11") return Promise.resolve({ own: own.x11 !== null && Number(display.slice(1)) === own.x11, key: "x11:" + Number(display.slice(1)) });
    var path = __cdbEx_cubgWlPath(display, rt);
    if (!path) return Promise.resolve({ own: false, error: "XDG_RUNTIME_DIR is not set, so " + display + " cannot be found - use an absolute socket path" });
    function st(p) {
      return p ? _fs.promises.stat(p).then(function (x) { return { st: x }; }, function (e) { return { err: e }; })
        : Promise.resolve({ err: { code: "ENOENT" } });
    }
    return Promise.all([st(path), st(own.waylandPath)]).then(function (r) {
      var t = r[0], o = r[1];
      if (t.err) {
        if (t.err.code === "ENOENT" || t.err.code === "ENOTDIR") return { own: false, missing: true, path: path, key: "wl:" + path };
        return { own: false, error: "cannot check " + path + ": " + (t.err.message || t.err.code), path: path };
      }
      if (!t.st.isSocket()) return { own: false, notSocket: true, path: path };
      // Claude has a Wayland socket but it cannot be checked: not provable
      // that the target is a different display, so refused (as the executor does).
      if (own.wayland && !o.st) {
        return { own: false, path: path, unsure: true, error: "cannot tell whether " + display + " is your own desktop (Claude's own Wayland socket " + own.wayland + " cannot be checked)" };
      }
      var mine = !!o.st && o.st.dev === t.st.dev && o.st.ino === t.st.ino;
      return { own: mine, path: path, key: "wl:" + t.st.dev + ":" + t.st.ino };
    });
  }

  // What the running app started with. The Computer Use executor is chosen
  // once at startup (js/cu_mode_preamble.js): with the switch on it forces the
  // regular executor; with it off, KDE Plasma 6.6+ gets the kwin executor
  // (globalThis.__cuKwinMode). So on such a session a flip only takes effect
  // after a restart, and the row behaves as a restart row there. The stored
  // value is read once on "ready" - our listener runs before upstream's ready
  // handler, where the preamble reads the same file - and after upstream has
  // settled userData (3P mode moves it). When the app started with the switch
  // on, the kwin probe was skipped, so a KDE Wayland session counts as kwin
  // capable unless CLAUDE_CU_MODE pins another mode (it may be KDE < 6.6,
  // where the restart is merely unneeded).
  var __cdbEx_cubgStartP = null;
  function __cdbEx_cubgStartedWith() {
    return (__cdbEx_cubgStartP || Promise.resolve(null)).then(function (s) {
      var desk = (process.env.XDG_CURRENT_DESKTOP || "").toLowerCase();
      var kdeWl = desk.indexOf("kde") >= 0 && (process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY);
      var kwin = typeof globalThis.__cuKwinMode === "boolean" ? globalThis.__cuKwinMode : null;
      var enabled = s ? (!!s.broken || !!(s.raw && typeof s.raw === "object" && s.raw.enabled === true)) : null;
      var mode = process.env.CLAUDE_CU_MODE || "";
      return {
        enabled: enabled, kwinMode: kwin, kdeWayland: kdeWl,
        restartOnChange: enabled !== null && (kwin === true || (enabled === true && kdeWl && (mode === "" || mode === "kwin-wayland")))
      };
    });
  }

  function __cdbEx_cubgOwnError(display) {
    return display + " is your desktop - Computer Use on a background display needs a second display";
  }

  // One key out of a .json/.jsonc, async. {value} (undefined when absent);
  // {broken: why} when the file does not parse (or is not an object) AND its
  // raw text names our key - the user meant to set it, so the executor fails
  // closed; {value: undefined, unreadable: code} when the read itself fails
  // (treated as absent, like the other rows, with a note). A broken file that
  // never mentions the key is absent too. Same parse as __cdbEx_readFileKey.
  function __cdbEx_cubgReadKey(file) {
    return _fs.promises.readFile(file, "utf8").then(function (raw) {
      var cfg, why = null;
      try { cfg = JSON.parse(__cdbEx_strip(raw) || "{}"); }
      catch (e) { why = (e && e.message) || String(e); }
      if (!why && (!cfg || typeof cfg !== "object" || Array.isArray(cfg))) why = "it does not hold a JSON object";
      if (why) return raw.indexOf(__cdbEx_CUBG_KEY) >= 0 ? { broken: why } : { value: undefined };
      return { value: cfg[__cdbEx_CUBG_KEY] };
    }, function (e) {
      if (e && e.code === "ENOENT") return { value: undefined };
      return { value: undefined, unreadable: (e && (e.code || e.message)) || String(e) };
    });
  }

  // A valid config can still point at Claude's own desktop: the target itself
  // (a hand-written value), or the env map's variable of the OTHER kind - the
  // target's own variable always wins over the map, so for an x11 target only
  // env.WAYLAND_DISPLAY reaches the apps beside DISPLAY, for a wlroots target
  // only env.DISPLAY. Mirrors __cuTargetIdentity in js/cu_mode_preamble.js
  // exactly (spec rulings "T4 review, MED" and "T12 final review", MEDIUM-2):
  // for env.WAYLAND_DISPLAY only "own" or "cannot tell" count; relative names
  // resolve against the env map's XDG_RUNTIME_DIR, then the host's. Resolves
  // the reason, or null.
  function __cdbEx_cubgConfigIdentity(v) {
    var env = v.env || {};
    var rt = env.XDG_RUNTIME_DIR || process.env.XDG_RUNTIME_DIR || "";
    var own = __cdbEx_cubgOwn();
    if (v.kind === "wlroots" && typeof env.DISPLAY === "string" && env.DISPLAY) {
      var m = /:(\d+)(?:\.\d+)?$/.exec(env.DISPLAY);
      if (m && own.x11 !== null && Number(m[1]) === own.x11) {
        return Promise.resolve("env DISPLAY " + env.DISPLAY + " is your own desktop, not a background display");
      }
    }
    var first = v.kind === "x11" && typeof env.WAYLAND_DISPLAY === "string" && env.WAYLAND_DISPLAY
      ? __cdbEx_cubgIdentity("wlroots", env.WAYLAND_DISPLAY, rt).then(function (id) {
        if (id.own) return "env WAYLAND_DISPLAY " + env.WAYLAND_DISPLAY + " is your own desktop, not a background display";
        return id.unsure ? id.error : null;
      })
      : Promise.resolve(null);
    return first.then(function (why) {
      if (why) return why;
      return __cdbEx_cubgIdentity(v.kind, v.display, rt).then(function (id) {
        if (id.own) return v.display + " is your own desktop, not a background display";
        if (id.notSocket) return id.path + " is not a Wayland socket";
        return id.error || null;
      });
    });
  }

  // The stored value, .jsonc first (it wins per key). A .jsonc that exists but
  // cannot be read or parsed decides too: the executor then refuses to run
  // (fail closed), so it reads as on + invalid and locks the row - it never
  // reads as off and never falls through to the .json. (The other rows treat
  // such a file as absent; for them "off" is harmless, here it is not.)
  function __cdbEx_cubgStored() {
    var p = __cdbEx_paths();
    return Promise.all([__cdbEx_cubgReadKey(p.jsonc), __cdbEx_cubgReadKey(p.json)]).then(function (r) {
      if (r[0].broken) {
        var why = "claude-desktop-extra.jsonc cannot be parsed (" + r[0].broken + ") - Computer Use is refused until it is fixed";
        return { paths: p, raw: undefined, locked: true, source: "jsonc", broken: why, check: { ok: false, error: why } };
      }
      var jsonc = r[0].value, json = r[1].broken ? undefined : r[1].value;
      var raw = jsonc !== undefined ? jsonc : json;
      var check = raw === undefined ? null : __cdbEx_cubgValidate(raw);
      // Anything but an object with enabled:true is OFF, exactly as the
      // executor reads it (null, a string, an array, enabled:false): there is
      // no verdict to show then, beyond a usable config to keep for later.
      var on = !!raw && typeof raw === "object" && raw.enabled === true;
      if (!on && check && !check.ok) check = null;
      return (on && check && check.ok ? __cdbEx_cubgConfigIdentity(check.value) : Promise.resolve(null)).then(function (err) {
        return {
          paths: p, raw: raw, locked: jsonc !== undefined,
          source: jsonc !== undefined ? "jsonc" : (json !== undefined ? "json" : "default"),
          check: err ? { ok: false, error: err } : check,
          note: r[0].unreadable ? "claude-desktop-extra.jsonc could not be read (" + r[0].unreadable + "); this setting is taken from claude-desktop-extra.json" : null
        };
      });
    });
  }

  // The child environment for one display: the target's display variable set,
  // the other one unset (an env map may provide it, e.g. sway's XWayland
  // DISPLAY), toolkit overrides cleared, XDG_SESSION_TYPE matching the target.
  // Host-compositor sockets are dropped too, so a wlroots-bridge talking to
  // display 2 never names the host compositor.
  function __cdbEx_cubgEnv(kind, display, overlay) {
    var e = {};
    Object.keys(process.env).forEach(function (k) { e[k] = process.env[k]; });
    ["DISPLAY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "GDK_BACKEND", "QT_QPA_PLATFORM", "XDG_SESSION_TYPE",
      "SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE", "NIRI_SOCKET"].forEach(function (k) { delete e[k]; });
    if (overlay) Object.keys(overlay).forEach(function (k) { e[k] = overlay[k]; });
    if (kind === "x11") { e.DISPLAY = display; e.XDG_SESSION_TYPE = "x11"; }
    else { e.WAYLAND_DISPLAY = display; e.XDG_SESSION_TYPE = "wayland"; }
    return e;
  }

  var __cdbEx_cubgActive = 0;
  var __cdbEx_cubgQueue = [];
  // Async execFile with a hard timeout, queued behind __cdbEx_CUBG_MAX_CHILDREN.
  // Resolves (never rejects) to {ok, stdout} or {ok:false, error, timedOut}.
  // timeoutMs: optional, for a caller that needs longer than the default (the
  // Computer Use status page's `doctor`, which may take 5 s on a hung a11y bus).
  function __cdbEx_cubgExec(bin, args, env, maxBuffer, timeoutMs) {
    var tmo = timeoutMs || __cdbEx_CUBG_TIMEOUT_MS;
    return new Promise(function (resolve) {
      function run() {
        __cdbEx_cubgActive++;
        var settled = false;
        function fin(r) {
          if (settled) return;
          settled = true;
          __cdbEx_cubgActive--;
          var nextRun = __cdbEx_cubgQueue.shift();
          if (nextRun) nextRun();
          resolve(r);
        }
        try {
          var opts = {
            env: env, timeout: tmo, killSignal: "SIGKILL",
            maxBuffer: maxBuffer || 1024 * 1024, encoding: "utf8", windowsHide: true
          };
          __cdbEx_cubgCp().execFile(bin, args, opts, function (err, stdout, stderr) {
            if (!err) { fin({ ok: true, stdout: String(stdout || "") }); return; }
            if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
              fin({ ok: false, error: "output larger than " + Math.round((maxBuffer || 1048576) / 1048576) + " MB - refused" });
              return;
            }
            var timedOut = !!(err.killed && err.signal === "SIGKILL");
            var line = String(stderr || "").split("\n").map(function (s) { return s.trim(); })
              .filter(Boolean)[0] || "";
            fin({
              ok: false, timedOut: timedOut,
              exitCode: typeof err.code === "number" ? err.code : null,
              error: timedOut ? "no answer within " + (tmo / 1000) + " s"
                : (line || err.message || String(err)).slice(0, 400)
            });
          });
        } catch (e) {
          fin({ ok: false, error: (e && e.message) || String(e) });
        }
      }
      if (__cdbEx_cubgActive < __cdbEx_CUBG_MAX_CHILDREN) run();
      else if (__cdbEx_cubgQueue.length >= __cdbEx_CUBG_MAX_QUEUED) resolve({ ok: false, busy: true, error: __cdbEx_CUBG_BUSY });
      else __cdbEx_cubgQueue.push(run);
    });
  }

  function __cdbEx_cubgJson(r) {
    if (!r.ok) return { ok: false, error: r.error, timedOut: r.timedOut, busy: !!r.busy };
    try { return { ok: true, value: JSON.parse(r.stdout) }; }
    catch (e) { return { ok: false, error: "unreadable bridge output (" + e.message + ")" }; }
  }

  function __cdbEx_cubgExecutable(p) {
    if (!p) return Promise.resolve(false);
    return _fs.promises.access(p, _fs.constants.X_OK).then(function () {
      return _fs.promises.stat(p).then(function (st) { return !st.isDirectory(); });
    }).then(null, function () { return false; });
  }

  function __cdbEx_cubgBridge(kind) {
    var b = __cdbEx_CUBG_BRIDGES[kind];
    if (!b) return Promise.resolve({ path: "", error: "unknown kind" });
    var override = process.env[b.envVar] || "";
    return __cdbEx_cubgExecutable(override).then(function (yes) {
      if (yes) return override;
      var dir = process.resourcesPath;
      if (!dir) return "";
      var p = _path.join(dir, b.name);
      return __cdbEx_cubgExecutable(p).then(function (y) { return y ? p : ""; });
    }).then(function (p) {
      if (!p) return { path: "", error: b.name + " is not part of this install" };
      // The CU preamble probes `--version` at startup and records a bridge that
      // cannot load; say why instead of spawning it again.
      var f = globalThis.__cuBridgeFail && globalThis.__cuBridgeFail[b.name];
      if (f && f.path === p) return { path: "", error: b.name + " cannot run (" + f.cause + ")" + (f.hint ? " - " + f.hint : "") };
      return { path: p, error: null };
    });
  }

  // Tools Computer Use or this page RUN (the clipboard tools, xprop): looked up
  // on the TOOL PATH, like the executor's _toolCmd. Everything else in
  // __cdbEx_CUBG_TOOLS is a program the user starts from the recipes (Xvfb,
  // sway, x11vnc, ...): looked up on the APP PATH, the PATH Claude Desktop was
  // started with - what the user's own shell has.
  var __cdbEx_CUBG_RUN = { "xclip": 1, "xsel": 1, "wl-copy": 1, "wl-paste": 1, "xprop": 1 };
  // The dirs a lookup walks. Since 4.23118 upstream narrows process.env.PATH
  // to fixed system dirs (CLAUDE_DESKTOP_NARROWED_PATH); the shared resolver
  // (globalThis.__cdbToolPath, add_tool_path_resolver.nim) gives the TOOL PATH
  // (narrowed dirs + the root-owned read-only started dirs) and the APP PATH.
  // Without it, or with narrowing off: process.env.PATH, as before.
  function __cdbEx_cubgDirs(name) {
    var t = globalThis.__cdbToolPath, p = null;
    try {
      if (t) p = Object.prototype.hasOwnProperty.call(__cdbEx_CUBG_RUN, name) ? t.toolPath() : t.appPath();
    } catch (e) { p = null; }
    if (typeof p !== "string") p = process.env.PATH || "";
    return p.split(":").filter(function (d) { return d.charAt(0) === "/"; });
  }
  // `which` without a spawn: the first executable regular file on that PATH.
  function __cdbEx_cubgWhich(name) {
    var dirs = __cdbEx_cubgDirs(name);
    var i = 0;
    function next() {
      if (i >= dirs.length) return Promise.resolve(null);
      var c = _path.join(dirs[i++], name);
      return __cdbEx_cubgExecutable(c).then(function (y) { return y ? c : next(); });
    }
    return next();
  }

  function __cdbEx_cubgTools() {
    return Promise.all(__cdbEx_CUBG_TOOLS.map(__cdbEx_cubgWhich)).then(function (found) {
      var tools = {};
      __cdbEx_CUBG_TOOLS.forEach(function (n, i) { tools[n] = found[i]; });
      return tools;
    });
  }

  // Firefox / Chromium / Chrome processes of this user. A hint only: such an
  // app hands a new window to its running instance, wherever that instance
  // shows, so launching it for display 2 opens it on the user's desktop.
  // Cached for __cdbEx_CUBG_PROC_TTL_MS, in-flight scans shared: a panel that
  // probes every candidate at once walks /proc once, 64 reads at a time.
  var __cdbEx_cubgProcCache = null;
  function __cdbEx_cubgSingleInstance() {
    var now = Date.now();
    if (__cdbEx_cubgProcCache && now - __cdbEx_cubgProcCache.at < __cdbEx_CUBG_PROC_TTL_MS) return __cdbEx_cubgProcCache.p;
    __cdbEx_cubgProcCache = { at: now, p: __cdbEx_cubgScanProc() };
    return __cdbEx_cubgProcCache.p;
  }
  function __cdbEx_cubgScanProc() {
    var uid = typeof process.getuid === "function" ? process.getuid() : -1;
    return _fs.promises.readdir("/proc").then(function (names) {
      var pids = names.filter(function (n) { return /^\d+$/.test(n); }).slice(0, 8192);
      var found = {};
      var i = 0;
      function batch() {
        if (i >= pids.length) return Promise.resolve();
        var chunk = pids.slice(i, i + 64);
        i += 64;
        return Promise.all(chunk.map(function (pid) {
          return _fs.promises.readFile("/proc/" + pid + "/status", "utf8").then(function (s) {
            var nm = /^Name:\s*(.*)$/m.exec(s);
            var u = /^Uid:\s*(\d+)/m.exec(s);
            if (!nm || !u || (uid >= 0 && Number(u[1]) !== uid)) return;
            var label = __cdbEx_CUBG_SINGLE[nm[1].trim()];
            if (label) found[label] = true;
          }, function () {});
        })).then(batch);
      }
      return batch().then(function () { return Object.keys(found).sort(); });
    }, function () { return []; });
  }

  // _NET_SUPPORTING_WM_CHECK through xprop, when installed: a window manager
  // is what lets activate-window and focus work on an X display.
  function __cdbEx_cubgX11Wm(env) {
    return __cdbEx_cubgWhich("xprop").then(function (xprop) {
      if (!xprop) return { present: null, name: null, via: null };
      return __cdbEx_cubgExec(xprop, ["-root", "_NET_SUPPORTING_WM_CHECK"], env).then(function (r) {
        if (!r.ok) return { present: null, name: null, via: "xprop", busy: !!r.busy };
        var m = /window id # (0x[0-9a-fA-F]+)/.exec(r.stdout);
        if (!m) return { present: false, name: null, via: "xprop" };
        return __cdbEx_cubgExec(xprop, ["-id", m[1], "_NET_WM_NAME"], env).then(function (r2) {
          var n = r2.ok ? /=\s*"(.*)"/.exec(r2.stdout) : null;
          return { present: true, name: n ? n[1].slice(0, 80) : null, via: "xprop" };
        });
      });
    });
  }

  // Bridge `screens` -> plain monitors. Both bridges answer the same shape.
  function __cdbEx_cubgScreens(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, 16).map(function (s) {
      var g = (s && s.geometry) || {};
      return {
        id: String((s && (s.id || s.name)) || ""), name: String((s && s.name) || ""),
        x: Number(g.x) || 0, y: Number(g.y) || 0, width: Number(g.width) || 0, height: Number(g.height) || 0,
        scale: Number(s && s.scale) || 1, primary: !!(s && s.is_primary)
      };
    });
  }

  // Validated target + its child env, or {error, own}. Async: the identity
  // check stats sockets and the env overlay comes from the stored config.
  function __cdbEx_cubgTarget(kind, display, stored) {
    kind = String(kind || "");
    display = String(display || "");
    if (kind !== "x11" && kind !== "wlroots") return Promise.resolve({ error: "kind must be \"x11\" or \"wlroots\"" });
    if (!__cdbEx_cubgDisplayOk(kind, display)) return Promise.resolve({ error: "not a valid " + kind + " display: " + display.slice(0, 80) });
    return (stored ? Promise.resolve(stored) : __cdbEx_cubgStored()).then(function (s) {
      var v = s.check && s.check.ok ? s.check.value : null;
      var configured = !!v && v.kind === kind && v.display === display;
      // The env map of the stored config, but only for the display it belongs to.
      var env = __cdbEx_cubgEnv(kind, display, configured && v.env ? v.env : null);
      return __cdbEx_cubgIdentity(kind, display, env.XDG_RUNTIME_DIR || "").then(function (id) {
        if (id.own) return { error: __cdbEx_cubgOwnError(display), own: true };
        if (id.notSocket) return { error: id.path + " is not a Wayland socket" };
        if (id.error) return { error: id.error };
        return { kind: kind, display: display, env: env, configured: configured, missing: !!id.missing, path: id.path || "",
          idKey: id.key || kind + ":" + display };
      });
    });
  }

  // The configured target when the page names none (Test, status line).
  function __cdbEx_cubgTargetOrStored(kind, display) {
    if (kind || display) return __cdbEx_cubgTarget(kind, display);
    return __cdbEx_cubgStored().then(function (s) {
      if (!s.check) return { error: "no background display is configured" };
      if (!s.check.ok) return { error: s.check.error };
      return __cdbEx_cubgTarget(s.check.value.kind, s.check.value.display, s);
    });
  }

  function __cdbEx_cubgNoSocket(t) {
    return t.display + " is not running (no Wayland socket at " + t.path + ")";
  }

  function __cdbEx_cubgListSockets(dir, re) {
    if (!dir) return Promise.resolve([]);
    return _fs.promises.readdir(dir).then(function (names) {
      var hits = names.filter(function (n) { return re.test(n) && !/\.lock$/.test(n); }).slice(0, 64);
      return Promise.all(hits.map(function (n) {
        var p = _path.join(dir, n);
        // stat follows symlinks (as the identity check and the executor do), so
        // a stable-name symlink to a compositor socket (wayland-claude-extra ->
        // wayland-1) is listed next to its target.
        return _fs.promises.stat(p).then(function (st) { return st.isSocket() ? { name: n, path: p } : null; },
          function () { return null; });
      })).then(function (r) { return r.filter(Boolean); });
    }, function () { return []; });
  }

  function __cdbEx_cubgCandidates() {
    var own = __cdbEx_cubgOwn();
    var rt = process.env.XDG_RUNTIME_DIR || "";
    return Promise.all([
      __cdbEx_cubgListSockets(__cdbEx_CUBG_X11_DIR, /^X\d{1,5}$/),
      __cdbEx_cubgListSockets(rt, /^wayland-[A-Za-z0-9._-]{1,64}$/)
    ]).then(function (r) {
      // X<n> with a leading zero is not a display name we accept; skip it.
      var x11 = r[0].filter(function (s) { return /^X(0|[1-9]\d{0,4})$/.test(s.name); }).map(function (s) {
        var d = ":" + s.name.slice(1);
        var mine = own.x11 !== null && Number(d.slice(1)) === own.x11;
        return { kind: "x11", display: d, socket: s.path, own: mine, selectable: !mine,
          label: mine ? "your desktop" : "X11 display " + d };
      }).sort(function (a, b) { return Number(a.display.slice(1)) - Number(b.display.slice(1)); });
      return Promise.all(r[1].map(function (s) {
        return __cdbEx_cubgIdentity("wlroots", s.name, rt).then(function (id) {
          return { kind: "wlroots", display: s.name, socket: s.path, own: !!id.own, selectable: !id.own,
            label: id.own ? "your desktop" : "Wayland socket " + s.name };
        });
      })).then(function (wl) {
        wl.sort(function (a, b) { return a.display < b.display ? -1 : a.display > b.display ? 1 : 0; });
        return { ok: true, candidates: x11.concat(wl), own: { display: own.x11 !== null ? ":" + own.x11 : null, wayland: own.wayland } };
      });
    });
  }

  function __cdbEx_cubgProbe(kind, display) {
    var t0 = Date.now();
    return __cdbEx_cubgTarget(kind, display).then(function (t) {
      if (t.error) return { ok: false, own: !!t.own, error: t.error };
      return __cdbEx_cubgProbeTarget(t, t0);
    });
  }

  function __cdbEx_cubgProbeTarget(t, t0) {
    var base = {
      ok: true, kind: t.kind, display: t.display, own: false, configured: t.configured,
      running: null, supported: false, reason: null, screens: [], size: null, windows: null,
      wm: { present: null, name: null, via: null }, compositor: null, missing: [],
      clipboard: { tool: null, needs: t.kind === "x11" ? "xclip or xsel" : "wl-clipboard (wl-copy, wl-paste)" },
      singleInstance: [], restrictions: [], ms: 0
    };
    if (t.missing) {
      base.running = false;
      base.reason = __cdbEx_cubgNoSocket(t);
      base.ms = Date.now() - t0;
      return Promise.resolve(base);
    }
    return __cdbEx_cubgBridge(t.kind).then(function (b) {
      if (!b.path) { base.reason = b.error; return base; }
      return __cdbEx_cubgExec(b.path, ["screens"], t.env).then(function (sr) {
        var sj = __cdbEx_cubgJson(sr);
        if (!sj.ok) {
          // A full queue is not an answer about the display.
          if (sj.busy) { base.busy = true; base.supported = null; base.reason = sj.error; return base; }
          base.running = false;
          base.reason = "not running: " + sj.error;
          return base;
        }
        base.running = true;
        base.screens = __cdbEx_cubgScreens(sj.value);
        if (base.screens.length) base.size = { width: base.screens[0].width, height: base.screens[0].height };
        return Promise.all([
          __cdbEx_cubgExec(b.path, ["doctor"], t.env).then(__cdbEx_cubgJson),
          __cdbEx_cubgExec(b.path, ["windows"], t.env).then(__cdbEx_cubgJson),
          t.kind === "x11" ? __cdbEx_cubgX11Wm(t.env) : Promise.resolve(null),
          __cdbEx_cubgWhich(t.kind === "x11" ? "xclip" : "wl-copy"),
          __cdbEx_cubgWhich(t.kind === "x11" ? "xsel" : "wl-paste"),
          __cdbEx_cubgSingleInstance()
        ]).then(function (r) {
          var doc = r[0].ok ? r[0].value || {} : null;
          if (Array.isArray(r[1].value)) base.windows = r[1].value.length;
          if (t.kind === "x11") {
            base.wm = r[2];
            var ext = doc && doc.extensions;
            if (!doc) base.reason = "doctor failed: " + r[0].error;
            else if (!ext || ext.xtest !== true) base.reason = "the X server has no XTEST extension, so input cannot be sent";
            else if (!base.screens.length) base.reason = "the X server reports no screen";
            else base.supported = true;
            base.clipboard.tool = r[3] ? "xclip" : (r[4] ? "xsel" : null);
          } else {
            var g = (doc && doc.globals) || {};
            base.compositor = doc && doc.compositor && doc.compositor !== "unknown" ? String(doc.compositor) : null;
            base.wm = { present: true, name: base.compositor, via: "compositor" };
            [["virtual_pointer", "zwlr_virtual_pointer_v1"], ["virtual_keyboard", "zwp_virtual_keyboard_v1"],
              ["screencopy", "zwlr_screencopy_manager_v1"]].forEach(function (p) {
              if (!g[p[0]]) base.missing.push(p[1]);
            });
            if (!doc) base.reason = "doctor failed: " + r[0].error;
            else if (base.missing.length) {
              base.reason = "the compositor does not offer " + base.missing.join(", ") +
                " - only wlroots compositors such as sway or labwc are supported (not weston, GNOME or KDE)";
            } else if (!base.screens.length) base.reason = "the compositor reports no output";
            else base.supported = true;
            base.clipboard.tool = r[3] && r[4] ? "wl-copy" : null;
            if (!g.foreign_toplevel_wlr && !g.foreign_toplevel_ext) {
              base.restrictions.push({ id: "no-window-list", text: "The compositor does not list windows, so Claude cannot see or switch between open apps." });
            }
          }
          base.singleInstance = r[5];
          // doctor or windows refused by a full queue: say busy, never "not supported".
          if (r[0].busy || r[1].busy) { base.busy = true; base.supported = null; base.reason = __cdbEx_CUBG_BUSY; }
          if (t.kind === "x11" && base.wm.present === false) {
            base.restrictions.push({ id: "no-wm", text: "No window manager runs on " + t.display + ": windows cannot be activated or focused reliably. Start one, e.g. xfwm4 or openbox." });
          } else if (t.kind === "x11" && base.wm.present === null && !base.wm.busy) {
            base.restrictions.push({ id: "wm-unknown", text: "Could not check for a window manager on " + t.display +
              (base.wm.via === "xprop" ? " (xprop gave no answer)." : " (xprop is not installed).") });
          }
          if (!base.clipboard.tool) {
            base.restrictions.push({ id: "no-clipboard", text: "Clipboard tools are off: install " + base.clipboard.needs + "." });
          }
          if (base.singleInstance.length) {
            base.restrictions.push({ id: "single-instance", text: base.singleInstance.join(", ") +
              " already runs on your desktop: opening it for Claude will open the window there. Close it first, or use another app." });
          }
          base.restrictions.push({ id: "teach", text: "Teach mode is not available on a background display." });
          return base;
        });
      });
    }).then(function (res) { res.ms = Date.now() - t0; return res; });
  }

  // Bridge screenshot -> a JPEG data URL no wider than __cdbEx_CUBG_THUMB_W.
  function __cdbEx_cubgThumbFrom(shot) {
    var b64 = shot && typeof shot.base64 === "string" ? shot.base64 : "";
    if (!b64) return { ok: false, error: "the bridge returned no image" };
    var ni = _electron.nativeImage;
    var src = { width: Number(shot.width) || 0, height: Number(shot.height) || 0 };
    if (!ni || typeof ni.createFromBuffer !== "function") {
      if (b64.length > 4 * 1024 * 1024) return { ok: false, error: "image too large to show without downscaling" };
      return { ok: true, dataUrl: "data:image/jpeg;base64," + b64, width: src.width, height: src.height, sourceWidth: src.width, sourceHeight: src.height };
    }
    var img = ni.createFromBuffer(Buffer.from(b64, "base64"));
    if (!img || (typeof img.isEmpty === "function" && img.isEmpty())) return { ok: false, error: "the screenshot could not be decoded" };
    var sz = img.getSize();
    var small = sz.width > __cdbEx_CUBG_THUMB_W ? img.resize({ width: __cdbEx_CUBG_THUMB_W, quality: "good" }) : img;
    var out = small.getSize();
    return {
      ok: true, dataUrl: "data:image/jpeg;base64," + small.toJPEG(70).toString("base64"),
      width: out.width, height: out.height, sourceWidth: sz.width, sourceHeight: sz.height
    };
  }

  // One screenshot per display at a time, and at most one every
  // __cdbEx_CUBG_SHOT_MIN_MS: keyed on the display itself (number, or socket
  // dev+ino), so other spellings share it. A request inside the interval gets
  // the last result (cached:true). The frame is parsed and downscaled once
  // per capture - on the main thread, so this is its rate limit - and only the
  // thumbnail is kept. Output above __cdbEx_CUBG_SHOT_MAX is refused.
  var __cdbEx_cubgShots = {};
  function __cdbEx_cubgShot(t, b) {
    var key = t.idKey;
    var e = __cdbEx_cubgShots[key];
    if (e && e.p) return e.p;
    if (e && Date.now() - e.at < __cdbEx_CUBG_SHOT_MIN_MS) {
      var c = {};
      Object.keys(e.res).forEach(function (k) { c[k] = e.res[k]; });
      c.cached = true;
      return Promise.resolve(c);
    }
    if (Object.keys(__cdbEx_cubgShots).length > 64) __cdbEx_cubgShots = {};
    var p = __cdbEx_cubgExec(b.path, ["screenshot"], t.env, __cdbEx_CUBG_SHOT_MAX).then(__cdbEx_cubgJson).then(function (r) {
      var res;
      if (!r.ok) res = { ok: false, error: r.error, busy: !!r.busy };
      else {
        var th = __cdbEx_cubgThumbFrom(r.value);
        res = th.ok ? { ok: true, width: Number(r.value.width) || 0, height: Number(r.value.height) || 0, thumb: th }
          : { ok: false, error: th.error };
      }
      if (res.busy) delete __cdbEx_cubgShots[key];
      else __cdbEx_cubgShots[key] = { at: Date.now(), res: res };
      return res;
    }, function (err) {
      delete __cdbEx_cubgShots[key];
      return { ok: false, error: (err && err.message) || String(err) };
    });
    __cdbEx_cubgShots[key] = { p: p };
    return p;
  }


  function __cdbEx_cubgThumbnail(kind, display) {
    return __cdbEx_cubgTarget(kind, display).then(function (t) {
      if (t.error) return { ok: false, own: !!t.own, error: t.error };
      if (t.missing) return { ok: false, error: __cdbEx_cubgNoSocket(t) };
      return __cdbEx_cubgThumbTarget(t);
    });
  }

  function __cdbEx_cubgThumbTarget(t) {
    return __cdbEx_cubgBridge(t.kind).then(function (b) {
      if (!b.path) return { ok: false, error: b.error };
      return __cdbEx_cubgShot(t, b).then(function (r) {
        if (!r.ok) return { ok: false, busy: !!r.busy, error: r.busy ? r.error : "screenshot failed: " + r.error };
        var th = {};
        Object.keys(r.thumb).forEach(function (k) { th[k] = r.thumb[k]; });
        th.kind = t.kind;
        th.display = t.display;
        th.cached = !!r.cached;
        return th;
      });
    });
  }

  // Test = what Computer Use does first: read the screens, take a screenshot,
  // move the pointer to the middle of the first screen. Each step reports.
  function __cdbEx_cubgTest(kind, display) {
    var t0 = Date.now();
    return __cdbEx_cubgTargetOrStored(kind, display).then(function (t) {
      if (t.error) return { ok: false, own: !!t.own, error: t.error };
      if (t.missing) return { ok: false, kind: t.kind, display: t.display, steps: [], error: __cdbEx_cubgNoSocket(t), ms: Date.now() - t0 };
      return __cdbEx_cubgTestTarget(t, t0);
    });
  }

  function __cdbEx_cubgTestTarget(t, t0) {
    var steps = [];
    function step(name, startedAt, r, detail) {
      steps.push({ name: name, ok: !!r.ok, ms: Date.now() - startedAt, detail: r.ok ? detail : r.error });
      return r.ok;
    }
    return __cdbEx_cubgBridge(t.kind).then(function (b) {
      if (!b.path) return { ok: false, kind: t.kind, display: t.display, steps: steps, error: b.error };
      var s0 = Date.now();
      return __cdbEx_cubgExec(b.path, ["screens"], t.env).then(__cdbEx_cubgJson).then(function (sr) {
        var screens = sr.ok ? __cdbEx_cubgScreens(sr.value) : [];
        if (sr.ok && !screens.length) sr = { ok: false, error: "no screen reported" };
        if (!step("screens", s0, sr, screens.length ? screens[0].width + "x" + screens[0].height : "")) {
          return { ok: false, kind: t.kind, display: t.display, steps: steps, error: t.display + " is not running" };
        }
        var s1 = Date.now();
        return __cdbEx_cubgShot(t, b).then(function (shot) {
          var thumb = shot.ok ? shot.thumb : null;
          step("screenshot", s1, shot, shot.ok ? shot.width + "x" + shot.height + (shot.cached ? " (taken under 2 s ago)" : "") : "");
          var sc = screens[0];
          var x = Math.round(sc.x + sc.width / 2), y = Math.round(sc.y + sc.height / 2);
          var s2 = Date.now();
          return __cdbEx_cubgExec(b.path, ["pointer-move", "--x", String(x), "--y", String(y)], t.env).then(function (pm) {
            step("pointer-move", s2, pm, x + "," + y);
            var allOk = steps.every(function (s) { return s.ok; });
            return {
              ok: allOk, kind: t.kind, display: t.display, steps: steps,
              dataUrl: thumb && thumb.ok ? thumb.dataUrl : null,
              error: allOk ? null : steps.filter(function (s) { return !s.ok; }).map(function (s) { return s.name + ": " + s.detail; }).join("; ")
            };
          });
        });
      });
    }).then(function (res) { res.ms = Date.now() - t0; return res; });
  }

  // --- Computer Use status (Settings -> Extra -> Cowork (Linux)) -------------
  // Three rows: this desktop (the app's own startup decision + the bridge's
  // `doctor`), the device key (TPM) and cloud Cowork / Dispatch (this run's
  // remote-device lines in main.log). OK only from a fact observed here; any
  // read that fails is "unknown" with its error, never OK.
  //
  // NEVER BLOCKS: fs.promises only; the one child of a read is `doctor`, through
  // the cubg exec queue with an 8 s timeout, and only for cdb-cu-status:read.
  // Nothing runs at module load.
  //
  // SECURITY: the caller is remote code and no channel takes an argument. The
  // helper path comes from process.resourcesPath (resolved and ownership-checked
  // before pkexec runs it), pkexec from a fixed list of system paths (never
  // PATH), the launcher from CLAUDE_LAUNCHER, the bridge from
  // __cdbCuDecision.bin. The page can only name one of the fixed actions.
  var __cdbEx_TPM_DEV = "/dev/tpmrm0";
  var __cdbEx_TPM_LINK = "/etc/udev/rules.d/70-claude-desktop-extra-tpm.rules";
  var __cdbEx_TPM_RULE = "70-claude-desktop-extra-tpm.rules";
  // Known rule directories, the same list as packaging/udev/cdb-tpm-access
  // known_src(): the deb/rpm/pacman tree, or a Nix store install (non-NixOS).
  // Only a rule there is linked (a link into a build tree or extracted AppImage
  // dangles once it is deleted, and whoever recreates the path writes a root
  // udev rule), and only a link to one of them counts as ours.
  var __cdbEx_TPM_RULE_DIRS = ["/usr/lib/claude-desktop/resources/linux-udev"];
  var __cdbEx_TPM_NIX_DIR_RE = /^\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-[A-Za-z0-9+._?=-]+\/lib\/claude-desktop\/resources\/linux-udev$/;
  // The only sticky group/world-writable ancestor the helper accepts.
  var __cdbEx_CUS_STICKY_DIRS = ["/nix/store"];
  // pkexec is looked up here only, never on PATH (the app's PATH is the user's).
  var __cdbEx_CUS_PKEXEC = ["/usr/bin/pkexec", "/bin/pkexec"];
  // The rule file, byte for byte: packaging/udev/70-claude-desktop-extra-tpm.rules
  // and RULE_TEXT in packaging/udev/cdb-tpm-access hold the same text (the
  // helper links only a file equal to it; test-cu-status-main.mjs pins all three).
  var __cdbEx_TPM_RULE_TEXT = "# claude-desktop-extra: TPM access for the active seat user (see cdb-tpm-access)\n" +
    "# Claude Desktop keeps its device identity key in the TPM. Give the user at the\n" +
    "# active local seat an ACL on the kernel resource manager node only (not tpm0).\n" +
    "SUBSYSTEM==\"tpmrm\", KERNEL==\"tpmrm[0-9]*\", ACTION!=\"remove\", TAG+=\"uaccess\"\n";
  // The rule's one active line (the comments dropped), shown on the page.
  var __cdbEx_TPM_RULE_LINE = __cdbEx_TPM_RULE_TEXT.split("\n").filter(function (l) { return l && l.charAt(0) !== "#"; }).join("\n");
  // What the helper runs after it changed the link, for enable and disable alike
  // (packaging/udev/cdb-tpm-access, "apply now").
  var __cdbEx_TPM_APPLY = "udevadm control --reload\nudevadm trigger --action=change --subsystem-match=tpmrm";
  var __cdbEx_TPM_NIXOS_OPT = "programs.claude-desktop-extra.tpmAccess.enable = true;";
  var __cdbEx_CUS_NIXOS = "/etc/NIXOS";
  // Container markers: the same list, in this order, as CONTAINER_MARKERS in
  // packaging/udev/cdb-tpm-access (systemd's, Docker's, Podman's, Flatpak's).
  var __cdbEx_CUS_CONTAINER = ["/run/systemd/container", "/.dockerenv", "/run/.containerenv", "/.flatpak-info"];
  var __cdbEx_CUS_UDEV_SOCK = "/run/udev/control";
  var __cdbEx_CUS_PASSWD = "/etc/passwd";
  var __cdbEx_CUS_GROUP = "/etc/group";
  // Owners the helper, its directories and pkexec may have. Only root.
  var __cdbEx_CUS_TRUSTED_UIDS = [0];
  var __cdbEx_CUS_DOCTOR_MS = 8000;
  var __cdbEx_CUS_PKEXEC_MS = 120000;
  var __cdbEx_CUS_RESET_MS = 30000;
  // After an Enable that was declined, cancelled or failed, further Enable
  // requests are refused for this long (no polkit prompt loop from page script).
  var __cdbEx_CUS_ENABLE_COOLDOWN_MS = 30000;
  // Main's confirmation dialog before every pkexec enable: short on purpose.
  // The full risk text, the exact command, what it changes and how to undo it
  // are on the page (CUS_RISK and the "What this does" block in
  // js/extra_settings_page.js); the dialog only has to be the consent.
  var __cdbEx_CUS_TPM_CONFIRM = "This adds a udev rule that grants access to the TPM, and asks for an administrator password. It applies to every account that logs in at this computer's screen. Details and the exact command: Settings -> Extra -> Cowork (Linux).";
  // Local Cowork VM: the KVM sibling of the TPM pieces above. Upstream's own
  // probe needs read/write access to both nodes (and a vhost-vsock module):
  // without it the app offers no "run on your computer" (1P keeps cloud
  // Cowork; 3P has no Cowork at all). cdb-kvm-access is cdb-tpm-access's
  // sibling with two links: the udev rule and a modules-load.d entry.
  var __cdbEx_KVM_DEV = "/dev/kvm";
  var __cdbEx_VSOCK_DEV = "/dev/vhost-vsock";
  var __cdbEx_KVM_RULE = "70-claude-desktop-extra-kvm.rules";
  var __cdbEx_KVM_LINK = "/etc/udev/rules.d/70-claude-desktop-extra-kvm.rules";
  var __cdbEx_KVM_MCONF = "claude-desktop-extra-vsock.conf";
  var __cdbEx_KVM_MLINK = "/etc/modules-load.d/claude-desktop-extra-vsock.conf";
  // Byte for byte packaging/udev/70-claude-desktop-extra-kvm.rules and
  // claude-desktop-extra-vsock.conf, and RULE_TEXT / CONF_TEXT in
  // packaging/udev/cdb-kvm-access (test-cu-status-main.mjs pins them).
  var __cdbEx_KVM_RULE_TEXT = "# claude-desktop-extra: KVM access for the active seat user (see cdb-kvm-access)\n" +
    "# Local Cowork runs a QEMU VM that needs /dev/kvm and /dev/vhost-vsock. Give the\n" +
    "# user at the active local seat an ACL on these two nodes only.\n" +
    "SUBSYSTEM==\"misc\", KERNEL==\"kvm\", ACTION!=\"remove\", TAG+=\"uaccess\"\n" +
    "SUBSYSTEM==\"misc\", KERNEL==\"vhost-vsock\", ACTION!=\"remove\", TAG+=\"uaccess\"\n";
  var __cdbEx_KVM_MCONF_TEXT = "# claude-desktop-extra: load vhost_vsock at boot for local Cowork (see cdb-kvm-access)\n" +
    "vhost_vsock\n";
  var __cdbEx_KVM_RULE_LINE = __cdbEx_KVM_RULE_TEXT.split("\n").filter(function (l) { return l && l.charAt(0) !== "#"; }).join("\n");
  var __cdbEx_KVM_MCONF_LINE = __cdbEx_KVM_MCONF_TEXT.split("\n").filter(function (l) { return l && l.charAt(0) !== "#"; }).join("\n");
  // What cdb-kvm-access runs after it changed the links (enable / disable).
  var __cdbEx_KVM_APPLY = "modprobe vhost_vsock\nudevadm control --reload\n" +
    "udevadm trigger --action=change --subsystem-match=misc --sysname-match=kvm --sysname-match=vhost-vsock";
  var __cdbEx_KVM_APPLY_OFF = "udevadm control --reload";
  var __cdbEx_KVM_NIXOS_OPT = "programs.claude-desktop-extra.kvmAccess.enable = true;";
  // Upstream's probe tells "module not loaded" from "kernel without it" by this
  // directory for the running kernel.
  var __cdbEx_KVM_MODULES_DIR = "/lib/modules";
  var __cdbEx_CUS_KVM_CONFIRM = "This adds a udev rule that grants access to /dev/kvm and /dev/vhost-vsock, loads the vhost_vsock module at boot, and asks for an administrator password. It applies to every account that logs in at this computer's screen. Details and the exact command: Settings -> Extra -> Cowork (Linux).";
  // The processes of a running local VM are children of this app: the bundled
  // cowork-linux-helper and the QEMU it starts.
  var __cdbEx_CUS_PROC = "/proc";
  var __cdbEx_CUS_ICON_MS = 2000;
  // Upstream's settings route the deep link opens (fixed here, never the page's).
  var __cdbEx_SETTINGS_ROUTE = "/settings/desktop";

  var __cdbEx_CUS_LOG_TAIL = 512 * 1024;
  var __cdbEx_CUS_LOG_SLACK_MS = 2000;
  var __cdbEx_CUS_FRAME_RE = /connect frame sent: device_id (keyed|keyless|none)(?: \((.*)\))?/;
  var __cdbEx_CUS_DO_RE = /connecting DO bridge with:/;
  var __cdbEx_CUS_TS_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/;
  var __cdbEx_CUS_BRIDGES = ["kwin-portal-bridge", "wlroots-bridge", "gnome-portal-bridge", "x11-bridge"];
  var __cdbEx_CUS_NOTES = {
    desktop: "Claude's Code sessions see and control your screen through this.",
    tpm: "Claude keeps this computer's device identity key in the TPM; cloud tasks trust only a device with that key.",
    cloud: "Cloud tasks reach this screen only through a keyed device that offers computer tools.",
    kvm: "The local Cowork VM runs on KVM. Without access the app offers only cloud Cowork (in 3P mode, no Cowork at all).",
    vsock: "The app talks to the local VM over vhost-vsock.",
    vmTools: "What the app found when it checked for the local VM in this run: QEMU, OVMF firmware and virtiofsd.",
    vm: "Whether the local Cowork VM is running now (it starts when you open Cowork or a scheduled task runs)."
  };

  function __cdbEx_cusRow(status, fact, which) {
    return { status: status, fact: String(fact), note: __cdbEx_CUS_NOTES[which] };
  }
  function __cdbEx_cusErr(e) { return (e && (e.code || e.message)) || String(e); }

  function __cdbEx_cusHelper() {
    return process.resourcesPath ? _path.join(process.resourcesPath, "linux-udev", "cdb-tpm-access") : "";
  }
  function __cdbEx_cusKvmHelper() {
    return process.resourcesPath ? _path.join(process.resourcesPath, "linux-udev", "cdb-kvm-access") : "";
  }
  // __cdbEx_cusKnownRule for any of our files in the same directories.
  function __cdbEx_cusKnownIn(p, name) {
    if (typeof p !== "string" || _path.basename(p) !== name) return false;
    var dir = p.slice(0, -(name.length + 1));
    if (p !== dir + "/" + name) return false;
    return __cdbEx_TPM_RULE_DIRS.indexOf(dir) >= 0 || __cdbEx_TPM_NIX_DIR_RE.test(dir);
  }
  // Is p (a rule path, compared as given) one of the known rule paths?
  function __cdbEx_cusKnownRule(p) {
    if (typeof p !== "string" || _path.basename(p) !== __cdbEx_TPM_RULE) return false;
    var dir = p.slice(0, -(__cdbEx_TPM_RULE.length + 1));
    if (p !== dir + "/" + __cdbEx_TPM_RULE) return false;
    return __cdbEx_TPM_RULE_DIRS.indexOf(dir) >= 0 || __cdbEx_TPM_NIX_DIR_RE.test(dir);
  }

  // The decision js/cu_mode_preamble.js made at startup (frozen, set once).
  function __cdbEx_cusDecision() {
    var d = globalThis.__cdbCuDecision;
    return d && typeof d === "object" && d.v === 1 && typeof d.backend === "string" ? d : null;
  }

  function __cdbEx_cusQuote(s) {
    return /^[A-Za-z0-9_\/.,:=+@-]+$/.test(s) ? s : "'" + String(s).replace(/'/g, "'\\''") + "'";
  }

  function __cdbEx_cusIdNames(file) {
    return _fs.promises.readFile(file, "utf8").then(function (t) {
      var m = {};
      t.split("\n").forEach(function (l) {
        var f = l.split(":");
        if (f.length >= 3 && /^\d+$/.test(f[2]) && m[f[2]] === undefined) m[f[2]] = f[0];
      });
      return m;
    }, function () { return {}; });
  }

  function __cdbEx_cusExists(p) {
    return _fs.promises.access(p, _fs.constants.F_OK).then(function () { return true; }, function () { return false; });
  }

  // A device node: dev: ok | denied | absent | error (owner names added by
  // __cdbEx_cusNamed).
  function __cdbEx_cusDevOf(p) {
    return _fs.promises.stat(p).then(function (st) {
      return _fs.promises.access(p, _fs.constants.R_OK | _fs.constants.W_OK).then(function () {
        return { state: "ok", st: st };
      }, function (e) {
        var c = e && e.code;
        return { state: c === "EACCES" || c === "EPERM" ? "denied" : "error", code: c || __cdbEx_cusErr(e), st: st };
      });
    }, function (e) {
      return e && e.code === "ENOENT" ? { state: "absent" } : { state: "error", code: __cdbEx_cusErr(e) };
    });
  }
  // A link we may own. link: absent | ours | stale | foreign | file | error;
  // `known` says whether a raw link target is one of our installed files.
  function __cdbEx_cusLinkOf(linkPath, known) {
    return _fs.promises.lstat(linkPath).then(function (st) {
      if (st.isSymbolicLink()) {
        return _fs.promises.readlink(linkPath).then(function (raw) {
          if (!known(raw)) return { state: "foreign", target: raw };
          return _fs.promises.stat(linkPath).then(function () { return { state: "ours", target: raw }; },
            function (e) {
              return e && e.code === "ENOENT" ? { state: "stale", target: raw } : { state: "error", code: __cdbEx_cusErr(e) };
            });
        });
      }
      return st.isFile() ? { state: "file" } : { state: "foreign", target: null };
    }).then(null, function (e) {
      return e && e.code === "ENOENT" ? { state: "absent" } : { state: "error", code: __cdbEx_cusErr(e) };
    });
  }
  function __cdbEx_cusNamed(d, users, groups) {
    if (d.st) {
      d.owner = users[String(d.st.uid)] || String(d.st.uid);
      d.group = groups[String(d.st.gid)] || String(d.st.gid);
      d.mode = (d.st.mode & 4095).toString(8);
      d.gid = d.st.gid;
      delete d.st;
    }
    return d;
  }

  // /dev/tpmrm0 and the rule link. dev: ok | denied | absent | error.
  // link: absent | ours | stale | foreign | file | error.
  function __cdbEx_cusTpm() {
    return Promise.all([__cdbEx_cusDevOf(__cdbEx_TPM_DEV), __cdbEx_cusLinkOf(__cdbEx_TPM_LINK, __cdbEx_cusKnownRule),
      __cdbEx_cusIdNames(__cdbEx_CUS_PASSWD), __cdbEx_cusIdNames(__cdbEx_CUS_GROUP)]).then(function (a) {
      return { dev: __cdbEx_cusNamed(a[0], a[2], a[3]), link: a[1] };
    });
  }

  // The helper may be run as root only when it is installed at a known rule
  // directory (the helper refuses anywhere else, exit 5) and nobody but root
  // can have changed it: a regular executable file, and it and every directory
  // above it owned by root and not group/world-writable. The one exception is
  // /nix/store (root-owned, sticky, group nixbld): only the Nix daemon adds
  // entries there.
  function __cdbEx_cusHelperCheck(acc) {
    var p = acc ? acc.helperPath() : __cdbEx_cusHelper();
    if (!p) return Promise.resolve({ path: "", safe: false, why: "no resources path" });
    function trusted(st) { return __cdbEx_CUS_TRUSTED_UIDS.indexOf(st.uid) >= 0; }
    return _fs.promises.realpath(p).then(function (real) {
      return _fs.promises.lstat(real).then(function (st) {
        if (!st.isFile()) return { path: real, safe: false, why: real + " is not a regular file" };
        if (!trusted(st)) return { path: real, safe: false, why: real + " is not owned by root" };
        if (st.mode & 18) return { path: real, safe: false, why: real + " is group- or world-writable" };
        if (!(st.mode & 73)) return { path: real, safe: false, why: real + " is not executable" };
        var dir = _path.dirname(real);
        if (!__cdbEx_cusKnownRule(dir + "/" + __cdbEx_TPM_RULE)) {
          return { path: real, safe: false, why: dir + " is not an installed claude-desktop-extra location" };
        }
        function up() {
          return _fs.promises.lstat(dir).then(function (ds) {
            if (!ds.isDirectory() || !trusted(ds)) return { path: real, safe: false, why: dir + " is not owned by root" };
            if ((ds.mode & 18) && !((ds.mode & 512) && __cdbEx_CUS_STICKY_DIRS.indexOf(dir) >= 0)) {
              return { path: real, safe: false, why: dir + " is group- or world-writable" };
            }
            var parent = _path.dirname(dir);
            if (parent === dir) return { path: real, safe: true, why: null };
            dir = parent;
            return up();
          });
        }
        return up();
      });
    }).then(null, function (e) {
      return { path: p, safe: false, missing: !!(e && e.code === "ENOENT"), why: p + ": " + __cdbEx_cusErr(e) };
    });
  }

  // pkexec from the fixed list only: the first candidate whose real path is a
  // regular root-owned file with the setuid bit. "" = unavailable (the panel
  // then shows the command instead of a button).
  function __cdbEx_cusPkexec() {
    var i = 0;
    function next() {
      if (i >= __cdbEx_CUS_PKEXEC.length) return Promise.resolve("");
      var c = __cdbEx_CUS_PKEXEC[i++];
      return _fs.promises.realpath(c).then(function (real) {
        return _fs.promises.lstat(real).then(function (st) {
          if (!st.isFile() || __cdbEx_CUS_TRUSTED_UIDS.indexOf(st.uid) < 0) return "";
          return (st.mode & 2048) && (st.mode & 73) ? real : "";
        });
      }).then(null, function () { return ""; }).then(function (p) { return p || next(); });
    }
    return next();
  }

  // Where Enable/Disable can run as a button, and what to show instead. `acc`
  // (an __cdbEx_ACCESS entry, TPM when absent) names the helper.
  function __cdbEx_cusGate(acc) {
    return Promise.all([
      __cdbEx_cusExists(__cdbEx_CUS_NIXOS),
      Promise.all(__cdbEx_CUS_CONTAINER.map(__cdbEx_cusExists)),
      _fs.promises.stat(__cdbEx_CUS_UDEV_SOCK).then(function (st) { return st.isSocket(); }, function () { return false; }),
      __cdbEx_cusPkexec(),
      __cdbEx_cusHelperCheck(acc)
    ]).then(function (a) {
      var g = {
        appimage: !!process.env.CLAUDE_APPIMAGE_PATH,
        nixos: a[0],
        container: a[1].some(Boolean),
        udev: a[2],
        pkexec: a[3],
        helper: a[4]
      };
      g.button = !!(g.pkexec && g.helper.safe && g.udev && !g.appimage && !g.nixos && !g.container);
      return g;
    });
  }

  function __cdbEx_cusTee(stale) {
    var link = __cdbEx_cusQuote(__cdbEx_TPM_LINK);
    var lines = __cdbEx_TPM_RULE_TEXT.replace(/\n$/, "").split("\n").map(__cdbEx_cusQuote).join(" ");
    return (stale ? "sudo rm -f " + link + "\n" : "") +
      "printf '%s\\n' " + lines + " | sudo tee " + link + " >/dev/null\n" +
      "sudo udevadm control --reload\n" +
      "sudo udevadm trigger --action=change --subsystem-match=tpmrm";
  }
  function __cdbEx_cusRm() {
    return "sudo rm -f " + __cdbEx_cusQuote(__cdbEx_TPM_LINK) + "\nsudo udevadm control --reload";
  }
  function __cdbEx_cusHelperCmd(g, verb) {
    return "sudo " + __cdbEx_cusQuote(g.helper.path) + " " + verb;
  }

  // The pkexec button as the page shows it: the command, word for word what
  // __cdbEx_cusPkexecRun executes (the same g.pkexec and g.helper.path), and
  // what it changes - before anything runs.
  function __cdbEx_cusPkexecCmd(g, verb) {
    return __cdbEx_cusQuote(g.pkexec) + " " + __cdbEx_cusQuote(g.helper.path) + " " + verb;
  }
  function __cdbEx_cusPkexecAct(g, verb) {
    var act = { kind: "pkexec", command: __cdbEx_cusPkexecCmd(g, verb), link: __cdbEx_TPM_LINK, apply: __cdbEx_TPM_APPLY };
    if (verb === "enable") {
      // The helper links the rule next to itself (readlink -f of its own path).
      act.target = _path.dirname(g.helper.path) + "/" + __cdbEx_TPM_RULE;
      act.rule = __cdbEx_TPM_RULE_LINE;
      act.undo = __cdbEx_cusPkexecCmd(g, "disable");
      act.undoManual = "sudo rm -f " + __cdbEx_cusQuote(__cdbEx_TPM_LINK) + " && sudo udevadm control --reload";
    }
    return act;
  }

  function __cdbEx_cusEnableAct(g, link) {
    var stale = link.state === "stale";
    if (g.nixos) return { kind: "nixos", text: __cdbEx_TPM_NIXOS_OPT };
    if (g.container || !g.udev) return { kind: "command", text: __cdbEx_cusTee(stale), where: "host" };
    if (g.appimage) return { kind: "command", text: __cdbEx_cusTee(stale), where: "here" };
    if (g.button) return __cdbEx_cusPkexecAct(g, "enable");
    if (g.helper.safe) return { kind: "command", text: __cdbEx_cusHelperCmd(g, "enable"), where: "here" };
    return { kind: "command", text: __cdbEx_cusTee(stale), where: "here" };
  }
  function __cdbEx_cusDisableAct(g, link) {
    if (link.state === "ours" || link.state === "stale") {
      if (g.container || !g.udev) return { kind: "command", text: __cdbEx_cusRm(), where: "host" };
      if (g.button) return __cdbEx_cusPkexecAct(g, "disable");
      if (g.helper.safe) return { kind: "command", text: __cdbEx_cusHelperCmd(g, "disable"), where: "here" };
      return { kind: "command", text: __cdbEx_cusRm(), where: "here" };
    }
    // The AppImage's own copy of the rule: a regular file the user wrote.
    if (link.state === "file" && g.appimage) {
      return { kind: "command", text: __cdbEx_cusRm(), where: g.container ? "host" : "here" };
    }
    return null;
  }

  // Is the device's group one of this process's groups (access by membership)?
  function __cdbEx_cusInGroup(d) {
    if (typeof d.gid !== "number") return false;
    var gids = [];
    try { if (typeof process.getgroups === "function") gids = process.getgroups(); } catch (e) { gids = []; }
    try { if (typeof process.getegid === "function") gids = gids.concat([process.getegid()]); } catch (e) { /* none */ }
    return gids.indexOf(d.gid) >= 0;
  }

  // Both actions, whenever a resource manager is present. An action that can do
  // nothing right now still carries its command, plus `disabled` (the reason).
  var __cdbEx_CUS_NOOP_ENABLE = "Already enabled - the rule link is installed";
  var __cdbEx_CUS_NOOP_DISABLE = "Nothing to remove - no rule link from this package is installed";
  function __cdbEx_cusActs(g, link) {
    var en = __cdbEx_cusEnableAct(g, link);
    if (link.state === "ours" || link.state === "file") en.disabled = __cdbEx_CUS_NOOP_ENABLE;
    else if (link.state === "foreign") en.disabled = "Another file is installed at " + __cdbEx_TPM_LINK + " - it is not replaced";
    var live = link.state === "ours" || link.state === "stale" || (link.state === "file" && g.appimage);
    var dis = __cdbEx_cusDisableAct(g, live ? link : { state: "ours" });
    if (!live) dis.disabled = __cdbEx_CUS_NOOP_DISABLE;
    return { enable: en, disable: dis };
  }

  // The TPM row plus what it offers. at = __cdbTpmAtStart (undefined = unknown).
  function __cdbEx_cusTpmRow(t, g) {
    var d = t.dev;
    var link = t.link;
    var at = globalThis.__cdbTpmAtStart;
    var atState = at && typeof at === "object" ? at.state : undefined;
    var out = { row: null, enable: null, disable: null, restart: false, tss: null, state: d.state };
    if (d.state === "absent") {
      out.row = __cdbEx_cusRow("na", "no TPM 2.0 resource manager", "tpm");
      return out;
    }
    if (g) {
      var acts = __cdbEx_cusActs(g, link);
      out.enable = acts.enable;
      out.disable = acts.disable;
    }
    if (d.state === "error") {
      out.row = __cdbEx_cusRow("unknown", __cdbEx_TPM_DEV + ": " + d.code, "tpm");
      return out;
    }
    if (d.state === "ok") {
      var hasRule = link.state === "ours" || link.state === "file";
      var world = (parseInt(d.mode, 8) & 6) === 6;
      if (atState !== undefined && atState !== "ok") {
        out.row = __cdbEx_cusRow("action", "accessible now - restart Claude to use it", "tpm");
        out.restart = true;
        out.state = "restart";
      } else if (hasRule) {
        out.row = __cdbEx_cusRow("ok", __cdbEx_TPM_DEV + " accessible - rule enabled", "tpm");
      } else if (__cdbEx_cusInGroup(d)) {
        out.row = __cdbEx_cusRow("ok", __cdbEx_TPM_DEV + " accessible through the " + d.group + " group", "tpm");
      } else if (world) {
        out.row = __cdbEx_cusRow("ok", __cdbEx_TPM_DEV + " accessible", "tpm");
      } else {
        out.row = __cdbEx_cusRow("action", "accessible for this session - no rule installed, access ends when you log out", "tpm");
      }
      return out;
    }
    // denied
    var who = "(" + d.owner + ":" + d.group + " " + d.mode + ")";
    var grp = /^[a-z_][a-z0-9_-]*$/.test(d.group) ? d.group : "tss";
    if (link.state === "stale") {
      out.row = __cdbEx_cusRow("action", "rule link points at a removed install", "tpm");
    } else if (link.state === "ours" || link.state === "file") {
      out.row = __cdbEx_cusRow("action", "rule enabled, but this session got no access", "tpm");
      out.tss = "sudo usermod -aG " + grp + " \"$USER\"";
    } else if (link.state === "foreign") {
      out.row = __cdbEx_cusRow("action", "present, no access for this user " + who +
        " - another file is installed at " + __cdbEx_TPM_LINK, "tpm");
      out.tss = "sudo usermod -aG " + grp + " \"$USER\"";
    } else {
      out.row = __cdbEx_cusRow("action", "present, no access for this user " + who, "tpm");
    }
    return out;
  }

  function __cdbEx_cusTs(line) {
    var m = __cdbEx_CUS_TS_RE.exec(line);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  }

  // This run's remote-device lines: the last connect frame and the last tool
  // announce at or after this process started (2 s slack, local timestamps).
  function __cdbEx_cusLog() {
    var file = _path.join(_app.getPath("userData"), "logs", "main.log");
    var start = Date.now() - process.uptime() * 1000 - __cdbEx_CUS_LOG_SLACK_MS;
    return _fs.promises.open(file, "r").then(function (fh) {
      return fh.stat().then(function (st) {
        var len = Math.min(st.size, __cdbEx_CUS_LOG_TAIL);
        var off = st.size - len;
        var buf = Buffer.alloc(len);
        return fh.read(buf, 0, len, off).then(function (r) {
          var text = buf.slice(0, r.bytesRead).toString("utf8");
          var lines = text.split("\n");
          if (off > 0) lines.shift();
          var out = { file: file, frame: null, announce: null, rotated: false };
          var firstTs = null;
          for (var i = 0; i < lines.length; i++) {
            var ts = __cdbEx_cusTs(lines[i]);
            if (ts === null) continue;
            if (firstTs === null) firstTs = ts;
            if (ts < start) continue;
            var m = __cdbEx_CUS_FRAME_RE.exec(lines[i]);
            if (m) out.frame = { kind: m[1], reason: m[2] || null };
            else if (__cdbEx_CUS_DO_RE.test(lines[i])) out.announce = { computer: /\bcomputer_screenshot\b/.test(lines[i]) };
          }
          // The whole file starts after this run began: it was rotated mid-run.
          out.rotated = off === 0 && firstTs !== null && firstTs > start + 2 * __cdbEx_CUS_LOG_SLACK_MS;
          return out;
        });
      }).then(function (v) { return fh.close().then(function () { return v; }, function () { return v; }); },
        function (e) { return fh.close().then(function () { throw e; }, function () { throw e; }); });
    }).then(null, function (e) {
      return { file: file, error: e && e.code === "ENOENT" ? "main.log not found" : "main.log: " + __cdbEx_cusErr(e) };
    });
  }

  function __cdbEx_cusCloudRow(log, tpm, d) {
    if (log.error) return __cdbEx_cusRow("unknown", log.error, "cloud");
    var f = log.frame;
    if (!f) {
      return __cdbEx_cusRow("unknown", log.rotated ? "not reported in this run (main.log was rotated since the app started)"
        : "not reported yet in this run (signed out, remote tools off, or log format moved)", "cloud");
    }
    if (f.kind !== "keyed") {
      var why = f.kind === "none" ? "no device id" : (f.reason || "no reason given");
      if (tpm.state === "absent") return __cdbEx_cusRow("na", "device keyless (" + why + ") - this computer has no TPM 2.0", "cloud");
      if (tpm.state === "ok") {
        return __cdbEx_cusRow("action", "device keyless (" + why + ") although the TPM is accessible - run claude-desktop --diagnose", "cloud");
      }
      return __cdbEx_cusRow("action", "device keyless (" + why + ") - TPM not accessible, see above", "cloud");
    }
    if (!log.announce) return __cdbEx_cusRow("unknown", "device keyed, but this run logged no tool announce", "cloud");
    if (log.announce.computer) return __cdbEx_cusRow("ok", "device keyed, computer tools offered", "cloud");
    if (d && d.wayland === true && d.announceWayland !== true) {
      return __cdbEx_cusRow("na", "computer tools not offered: no first-party bridge usable on this Wayland session", "cloud");
    }
    return __cdbEx_cusRow("na", "computer tools withheld by the app (Computer use switch, organization policy or rollout)", "cloud");
  }

  function __cdbEx_cusSession(d) {
    var de = String(process.env.XDG_CURRENT_DESKTOP || "").split(":")[0];
    return (de ? de + " " : "") + (d.wayland ? "Wayland" : "X11");
  }

  function __cdbEx_cusBridgeFail() {
    var f = globalThis.__cuBridgeFail;
    if (!f || typeof f !== "object") return null;
    for (var i = 0; i < __cdbEx_CUS_BRIDGES.length; i++) {
      var e = f[__cdbEx_CUS_BRIDGES[i]];
      if (e && e.cause) return { name: __cdbEx_CUS_BRIDGES[i], cause: e.cause, hint: e.hint || "" };
    }
    return null;
  }

  // The desktop row: the decision, then the bridge's doctor.
  // Answers {row, doctor} - doctor is the parsed contract-1 doctor or null.
  function __cdbEx_cusDesktop() {
    var d = __cdbEx_cusDecision();
    if (!d) return Promise.resolve({ row: __cdbEx_cusRow("unknown", "Computer Use reported no backend decision in this run", "desktop"), doctor: null });
    var t = d.target;
    var isBridge = __cdbEx_CUS_BRIDGES.indexOf(d.backend) >= 0 && typeof d.bin === "string" && d.bin.charAt(0) === "/";
    if (t && typeof t === "object" && typeof t.invalid === "string") {
      return Promise.resolve({ row: __cdbEx_cusRow("action", "background display on but unusable: " + t.invalid, "desktop"), doctor: null });
    }
    if (t && typeof t === "object" && (t.kind === "x11" || t.kind === "wlroots")) {
      return Promise.resolve({ row: isBridge
        ? __cdbEx_cusRow("ok", "background display " + t.kind + " " + t.display + " (details on its Set up page)", "desktop")
        : __cdbEx_cusRow("action", "background display " + t.kind + " " + t.display + ": its bridge cannot run", "desktop"), doctor: null });
    }
    if (!isBridge) {
      var fail = __cdbEx_cusBridgeFail();
      if (fail) {
        return Promise.resolve({ row: __cdbEx_cusRow("action", fail.name + " cannot run: " + fail.cause + (fail.hint ? " - " + fail.hint : ""), "desktop"), doctor: null });
      }
      return Promise.resolve({ row: d.backend === "fallback"
        ? __cdbEx_cusRow("na", "no first-party bridge for this desktop (fallback route): Code sessions only", "desktop")
        : __cdbEx_cusRow("na", "no Computer Use backend for this desktop", "desktop"), doctor: null });
    }
    var ovr = d.override ? " (override " + d.override + ")" : "";
    return __cdbEx_cubgExec(d.bin, ["doctor"], process.env, 1024 * 1024, __cdbEx_CUS_DOCTOR_MS).then(function (r) {
      var pre = d.backend + " doctor gave no status";
      if (!r.ok) {
        if (r.timedOut) return { row: __cdbEx_cusRow("unknown", pre + " (timeout)", "desktop"), doctor: null };
        if (r.exitCode === 2) return { row: __cdbEx_cusRow("unknown", pre + " (contract 0)", "desktop"), doctor: null };
        return { row: __cdbEx_cusRow("unknown", pre + " (" + r.error + ")", "desktop"), doctor: null };
      }
      var doc;
      try { doc = JSON.parse(r.stdout); } catch (e) { doc = undefined; }
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { row: __cdbEx_cusRow("unknown", pre + " (not JSON)", "desktop"), doctor: null };
      if (typeof doc.contract !== "number" || doc.contract < 1) return { row: __cdbEx_cusRow("unknown", pre + " (contract 0)", "desktop"), doctor: null };
      if (doc.backend_reachable !== true) {
        return { row: __cdbEx_cusRow("action", "backend unreachable: " + (doc.backend_error || "no reason given") + ovr, "desktop"), doctor: doc };
      }
      if (doc.session_match !== true) {
        return { row: __cdbEx_cusRow("action", d.backend + " does not serve this session (session_match false)" + ovr, "desktop"), doctor: doc };
      }
      var v = typeof doc.version === "string" && doc.version ? " " + doc.version : "";
      var perm = doc.session_supported === true && doc.restore_token_present === true ? " - screen-sharing permission remembered" : "";
      return { row: __cdbEx_cusRow("ok", __cdbEx_cusSession(d) + " - " + d.backend + v + " ready" + perm + ovr, "desktop"), doctor: doc };
    });
  }

  // What screenshots show on this session, for the status line under "This
  // desktop": the ask switch, and the running executor's own answer - the
  // regular executor's last capture with an allowlist (__lastCapture(): what it
  // actually did), before one its live capabilitiesNow().screenshotFiltering
  // ("mask" = only approved apps), plus what the mask does not cover (gaps,
  // wlroots-bridge); kwin mode's static capabilities (upstream always asks
  // there). "unknown" when no executor runs or it does not say. No I/O beyond
  // the switch's two small files.
  function __cdbEx_cusShots() {
    var d = __cdbEx_cusDecision();
    var out = { ask: true, kwin: false, filtering: "unknown", gaps: [], session: d ? __cdbEx_cusSession(d) : "", backend: d ? d.backend : null };
    try { out.ask = __cdbEx_cuAskPref().value !== false; } catch (e) { out.ask = true; }
    try {
      var ex = globalThis.__linuxExecutor;
      out.kwin = globalThis.__cuKwinMode === true || !!(d && d.mode === "kwin-wayland");
      if (ex && typeof ex === "object") {
        if (out.kwin) {
          var f = ex.capabilities && ex.capabilities.screenshotFiltering;
          out.filtering = f === "native" || f === "mask" ? "filtered" : f === "none" ? "whole" : "unknown";
        } else if (typeof ex.capabilitiesNow === "function") {
          var c = ex.capabilitiesNow();
          var last = typeof ex.__lastCapture === "function" ? ex.__lastCapture() : null;
          var src = last && typeof last.filtering === "string" ? last : c && typeof c.screenshotFiltering === "string" ? { filtering: c.screenshotFiltering, gaps: c.screenshotMaskGaps } : null;
          if (src) {
            out.filtering = src.filtering === "mask" ? "filtered" : "whole";
            if (out.filtering === "filtered" && Array.isArray(src.gaps)) out.gaps = src.gaps.filter(function (g) { return typeof g === "string" && g; });
          }
          if (c && typeof c.backend === "string" && c.backend) out.backend = c.backend;
        }
      }
    } catch (e2) { out.filtering = "unknown"; }
    return out;
  }

  // --- Local Cowork VM (the KVM sibling of the TPM rows) --------------------
  // `now` is a port of upstream's own VM probe (4.23118.0 Jrr()): the same two
  // access(R_OK|W_OK) calls, the same order, the same answers. The paths
  // (qemu, OVMF, virtiofsd) come only from upstream's cached probe, published
  // by the core patch as globalThis.__cdbCoworkVmProbe: no second copy of its
  // candidate lists lives here.
  function __cdbEx_cusRw(p) {
    return _fs.promises.access(p, _fs.constants.R_OK | _fs.constants.W_OK).then(function () { return "ok"; },
      function (e) { return e && e.code === "EACCES" ? "no_permission" : "missing"; });
  }
  function __cdbEx_cusKnownKvmRule(p) { return __cdbEx_cusKnownIn(p, __cdbEx_KVM_RULE); }
  function __cdbEx_cusKnownKvmConf(p) { return __cdbEx_cusKnownIn(p, __cdbEx_KVM_MCONF); }

  function __cdbEx_cusKvm() {
    var rel = "";
    try { rel = String(require("os").release() || ""); } catch (e) { rel = ""; }
    var modules = rel
      ? _fs.promises.access(_path.posix.join(__cdbEx_KVM_MODULES_DIR, rel)).then(function () { return true; }, function () { return false; })
      : Promise.resolve(false);
    return Promise.all([
      __cdbEx_cusDevOf(__cdbEx_KVM_DEV), __cdbEx_cusDevOf(__cdbEx_VSOCK_DEV),
      __cdbEx_cusRw(__cdbEx_KVM_DEV), __cdbEx_cusRw(__cdbEx_VSOCK_DEV), modules,
      __cdbEx_cusLinkOf(__cdbEx_KVM_LINK, __cdbEx_cusKnownKvmRule),
      __cdbEx_cusLinkOf(__cdbEx_KVM_MLINK, __cdbEx_cusKnownKvmConf),
      __cdbEx_cusIdNames(__cdbEx_CUS_PASSWD), __cdbEx_cusIdNames(__cdbEx_CUS_GROUP)
    ]).then(function (a) {
      var kvm = a[2];
      var vs = a[3];
      var now;
      if (kvm === "missing") now = "missing";
      else if (kvm === "no_permission" || vs === "no_permission") now = "no_permission";
      else if (vs === "missing") now = a[4] ? "vsock_module_missing" : "vsock_kernel_unsupported";
      else now = "ok";
      return { kvm: __cdbEx_cusNamed(a[0], a[7], a[8]), vsock: __cdbEx_cusNamed(a[1], a[7], a[8]),
        modules: a[4], now: now, link: a[5], mlink: a[6] };
    });
  }

  // What upstream's probe found when the app first checked (it caches that for
  // the whole run). null: the capture is missing, or nothing checked yet.
  var __cdbEx_cusProbeWarned = false;
  function __cdbEx_cusVmAtStart() {
    var fn = globalThis.__cdbCoworkVmProbe;
    if (typeof fn !== "function") {
      if (!__cdbEx_cusProbeWarned) {
        __cdbEx_cusProbeWarned = true;
        __cdbEx_log("cu-status: the app's VM probe capture is missing (add_feature_extra_settings sub-patch D) - VM tools show unknown");
      }
      return { captured: false, value: null };
    }
    var v;
    try { v = fn(); } catch (e) { v = null; }
    if (!v || typeof v !== "object") return { captured: true, value: null };
    function str(x) { return typeof x === "string" && x ? x : null; }
    return { captured: true, value: { kvm: typeof v.kvm === "string" ? v.kvm : null,
      qemuPath: str(v.qemuPath), firmwarePath: str(v.firmwarePath), virtiofsdPath: str(v.virtiofsdPath) } };
  }
  function __cdbEx_cusVmMissing(at) {
    var out = [];
    if (!at.qemuPath) out.push("QEMU");
    if (!at.firmwarePath) out.push("OVMF firmware");
    if (!at.virtiofsdPath) out.push("virtiofsd");
    return out;
  }

  // Is a local VM running: a qemu-system-* process below this app's own pid.
  // (The bundled cowork-linux-helper runs whenever the app does, VM or not, so
  // it is not counted.) No shell, /proc only, read in batches of
  // __cdbEx_CUS_PROC_BATCH; true | false | null (could not tell). A process
  // that exits during the walk, or whose exe link we may not read, is not a VM.
  var __cdbEx_CUS_PROC_BATCH = 64;
  function __cdbEx_cusBatched(items, fn) {
    var out = [];
    var i = 0;
    function next() {
      if (i >= items.length) return Promise.resolve(out);
      var chunk = items.slice(i, i + __cdbEx_CUS_PROC_BATCH);
      i += chunk.length;
      return Promise.all(chunk.map(fn)).then(function (r) { out = out.concat(r); return next(); });
    }
    return next();
  }
  function __cdbEx_cusVmRunningNow() {
    var self = String(process.pid);
    function gone(e) { return !!e && (e.code === "ENOENT" || e.code === "ESRCH"); }
    return _fs.promises.readdir(__cdbEx_CUS_PROC).then(function (names) {
      return __cdbEx_cusBatched(names.filter(function (n) { return /^\d+$/.test(n); }), function (pid) {
        return _fs.promises.readFile(__cdbEx_CUS_PROC + "/" + pid + "/stat", "utf8").then(function (t) {
          var i = t.lastIndexOf(")");
          var f = i >= 0 ? t.slice(i + 2).split(" ") : [];
          return f.length > 1 && /^\d+$/.test(f[1]) ? [pid, f[1]] : null;
        }, function (e) { if (gone(e)) return null; throw e; });
      });
    }).then(function (pairs) {
      var kids = {};
      pairs.forEach(function (p) { if (p) (kids[p[1]] || (kids[p[1]] = [])).push(p[0]); });
      var desc = [];
      var seen = {};
      var todo = [self];
      while (todo.length) {
        (kids[todo.pop()] || []).forEach(function (k) {
          if (!seen[k]) { seen[k] = 1; desc.push(k); todo.push(k); }
        });
      }
      return __cdbEx_cusBatched(desc, function (pid) {
        return _fs.promises.readlink(__cdbEx_CUS_PROC + "/" + pid + "/exe").then(function (exe) {
          return _path.basename(String(exe).replace(/ \(deleted\)$/, "")).indexOf("qemu-system-") === 0;
        }, function (e) {
          if (gone(e) || (e && (e.code === "EACCES" || e.code === "EPERM"))) return false;
          throw e;
        });
      });
    }).then(function (hits) { return hits.some(Boolean); }, function () { return null; });
  }
  // The read and the header icon share one answer for __cdbEx_CUS_ICON_MS.
  var __cdbEx_cusRunP = null;
  var __cdbEx_cusRunAt = 0;
  var __cdbEx_cusRunV;
  function __cdbEx_cusVmRunning() {
    if (__cdbEx_cusRunAt && Date.now() - __cdbEx_cusRunAt < __cdbEx_CUS_ICON_MS) return Promise.resolve(__cdbEx_cusRunV);
    if (__cdbEx_cusRunP) return __cdbEx_cusRunP;
    var p = __cdbEx_cusVmRunningNow().then(function (v) {
      __cdbEx_cusRunV = v;
      __cdbEx_cusRunAt = Date.now();
      return v;
    });
    __cdbEx_cusRunP = p;
    function done() { if (__cdbEx_cusRunP === p) __cdbEx_cusRunP = null; }
    p.then(done, done);
    return p;
  }

  function __cdbEx_cusDevWho(d) { return "(" + d.owner + ":" + d.group + " " + d.mode + ")"; }
  function __cdbEx_cusKvmRow(k, restart) {
    var d = k.kvm;
    if (d.state === "absent") return __cdbEx_cusRow("na", "missing - enable virtualization (VT-x / AMD-V) in the firmware settings", "kvm");
    if (d.state === "error") return __cdbEx_cusRow("unknown", __cdbEx_KVM_DEV + ": " + d.code, "kvm");
    var hasRule = k.link.state === "ours" || k.link.state === "file";
    if (d.state === "ok") {
      if (restart) return __cdbEx_cusRow("action", "accessible now - restart Claude so local Cowork can use it", "kvm");
      if (hasRule) return __cdbEx_cusRow("ok", __cdbEx_KVM_DEV + " accessible - rule enabled", "kvm");
      if (__cdbEx_cusInGroup(d)) return __cdbEx_cusRow("ok", __cdbEx_KVM_DEV + " accessible through the " + d.group + " group", "kvm");
      return __cdbEx_cusRow("ok", __cdbEx_KVM_DEV + " accessible", "kvm");
    }
    if (k.link.state === "stale") return __cdbEx_cusRow("action", "no permission - the rule link is not in effect (the file it points at is gone)", "kvm");
    if (hasRule) return __cdbEx_cusRow("action", "no permission " + __cdbEx_cusDevWho(d) + " - rule enabled, but this session got no access", "kvm");
    return __cdbEx_cusRow("action", "no permission " + __cdbEx_cusDevWho(d), "kvm");
  }
  function __cdbEx_cusVsockRow(k) {
    var d = k.vsock;
    if (d.state === "ok") return __cdbEx_cusRow("ok", __cdbEx_VSOCK_DEV + " accessible", "vsock");
    if (d.state === "denied") return __cdbEx_cusRow("action", "no permission " + __cdbEx_cusDevWho(d), "vsock");
    if (d.state === "absent") {
      return k.modules ? __cdbEx_cusRow("action", "module not loaded (vhost_vsock)", "vsock")
        : __cdbEx_cusRow("na", "kernel without vhost-vsock", "vsock");
    }
    return __cdbEx_cusRow("unknown", __cdbEx_VSOCK_DEV + ": " + d.code, "vsock");
  }
  function __cdbEx_cusVmToolsRow(at) {
    if (!at.captured) return __cdbEx_cusRow("unknown", "the app's own VM check is not reachable in this build", "vmTools");
    if (!at.value) return __cdbEx_cusRow("unknown", "not checked yet in this run - open Cowork once, then Re-check", "vmTools");
    var miss = __cdbEx_cusVmMissing(at.value);
    if (!miss.length) return __cdbEx_cusRow("ok", "QEMU, OVMF and virtiofsd found", "vmTools");
    return __cdbEx_cusRow("action", miss.join(", ") + " not found - install " + (miss.length > 1 ? "them" : "it") +
      ", then restart Claude (docs/cowork.md lists the packages)", "vmTools");
  }
  function __cdbEx_cusVmRow(running) {
    if (running === true) return __cdbEx_cusRow("ok", "running", "vm");
    if (running === false) return __cdbEx_cusRow("na", "not running", "vm");
    return __cdbEx_cusRow("unknown", "could not read the running processes", "vm");
  }

  // KVM access actions: the same gates and shapes as TPM, two links.
  function __cdbEx_cusKvmTee(k) {
    var link = __cdbEx_cusQuote(__cdbEx_KVM_LINK);
    var mlink = __cdbEx_cusQuote(__cdbEx_KVM_MLINK);
    function lines(t) { return t.replace(/\n$/, "").split("\n").map(__cdbEx_cusQuote).join(" "); }
    return (k.link.state === "stale" ? "sudo rm -f " + link + "\n" : "") +
      "printf '%s\\n' " + lines(__cdbEx_KVM_RULE_TEXT) + " | sudo tee " + link + " >/dev/null\n" +
      (k.mlink.state === "stale" ? "sudo rm -f " + mlink + "\n" : "") +
      "printf '%s\\n' " + lines(__cdbEx_KVM_MCONF_TEXT) + " | sudo tee " + mlink + " >/dev/null\n" +
      "sudo modprobe vhost_vsock\n" +
      "sudo udevadm control --reload\n" +
      "sudo udevadm trigger --action=change --subsystem-match=misc --sysname-match=kvm --sysname-match=vhost-vsock";
  }
  function __cdbEx_cusKvmRm() {
    return "sudo rm -f " + __cdbEx_cusQuote(__cdbEx_KVM_LINK) + " " + __cdbEx_cusQuote(__cdbEx_KVM_MLINK) +
      "\nsudo udevadm control --reload";
  }
  function __cdbEx_cusKvmPkexecAct(g, verb) {
    var enable = verb === "enable";
    var act = { kind: "pkexec", command: __cdbEx_cusPkexecCmd(g, verb), link: __cdbEx_KVM_LINK,
      apply: enable ? __cdbEx_KVM_APPLY : __cdbEx_KVM_APPLY_OFF, mlink: __cdbEx_KVM_MLINK };
    if (enable) {
      act.target = _path.dirname(g.helper.path) + "/" + __cdbEx_KVM_RULE;
      act.rule = __cdbEx_KVM_RULE_LINE;
      act.mtarget = _path.dirname(g.helper.path) + "/" + __cdbEx_KVM_MCONF;
      act.mconf = __cdbEx_KVM_MCONF_LINE;
      act.undo = __cdbEx_cusPkexecCmd(g, "disable");
      act.undoManual = "sudo rm -f " + __cdbEx_cusQuote(__cdbEx_KVM_LINK) + " " + __cdbEx_cusQuote(__cdbEx_KVM_MLINK) +
        " && sudo udevadm control --reload";
    }
    return act;
  }
  function __cdbEx_cusKvmEnableAct(g, k) {
    if (g.nixos) return { kind: "nixos", text: __cdbEx_KVM_NIXOS_OPT };
    if (g.container || !g.udev) return { kind: "command", text: __cdbEx_cusKvmTee(k), where: "host" };
    if (g.appimage) return { kind: "command", text: __cdbEx_cusKvmTee(k), where: "here" };
    if (g.button) return __cdbEx_cusKvmPkexecAct(g, "enable");
    if (g.helper.safe) return { kind: "command", text: __cdbEx_cusHelperCmd(g, "enable"), where: "here" };
    return { kind: "command", text: __cdbEx_cusKvmTee(k), where: "here" };
  }
  function __cdbEx_cusKvmDisableAct(g) {
    if (g.container || !g.udev) return { kind: "command", text: __cdbEx_cusKvmRm(), where: "host" };
    if (g.button) return __cdbEx_cusKvmPkexecAct(g, "disable");
    if (g.helper.safe) return { kind: "command", text: __cdbEx_cusHelperCmd(g, "disable"), where: "here" };
    return { kind: "command", text: __cdbEx_cusKvmRm(), where: "here" };
  }
  var __cdbEx_CUS_KVM_NOOP_ENABLE = "Already enabled - the rule and module links are installed";
  var __cdbEx_CUS_KVM_NOOP_DISABLE = "Nothing to remove - no link from this package is installed";
  // Both actions whenever /dev/kvm exists; one that can do nothing carries
  // `disabled` (the reason) and still its command.
  function __cdbEx_cusKvmActs(g, k) {
    if (k.kvm.state === "absent") return { enable: null, disable: null };
    function inst(l) { return l.state === "ours" || l.state === "file"; }
    function live(l) { return l.state === "ours" || l.state === "stale" || (l.state === "file" && g.appimage); }
    var en = __cdbEx_cusKvmEnableAct(g, k);
    // A dangling link of ours (its target gone: this install's or another's)
    // is "stale": not in effect, Enable re-points it. A link we could not read
    // counts like a foreign one, never as enabled.
    var foreign = k.link.state === "foreign" ? __cdbEx_KVM_LINK : k.mlink.state === "foreign" ? __cdbEx_KVM_MLINK : null;
    var unread = k.link.state === "error" ? __cdbEx_KVM_LINK : k.mlink.state === "error" ? __cdbEx_KVM_MLINK : null;
    if (inst(k.link) && inst(k.mlink)) en.disabled = __cdbEx_CUS_KVM_NOOP_ENABLE;
    else if (foreign) en.disabled = "Another file is installed at " + foreign + " - it is not replaced";
    else if (unread) en.disabled = "Could not read " + unread + " - it is not replaced";
    var dis = __cdbEx_cusKvmDisableAct(g);
    if (!live(k.link) && !live(k.mlink)) dis.disabled = __cdbEx_CUS_KVM_NOOP_DISABLE;
    return { enable: en, disable: dis };
  }

  // The access descriptors the Enable/Disable code runs on: TPM (cloud
  // Cowork's device key) and KVM (the local VM). TPM output is what it was
  // before KVM existed, byte for byte.
  var __cdbEx_ACCESS = {
    tpm: {
      id: "tpm", what: "TPM", helper: "cdb-tpm-access", helperPath: __cdbEx_cusHelper, maxExit: 5,
      changedRe: /^cdb-tpm-access: (?:(?:enabled|re-pointed|disabled)\b|already disabled \(acl cleared)/,
      confirm: __cdbEx_CUS_TPM_CONFIRM,
      question: "Let Claude Desktop use this computer's TPM for its device identity key?",
      lock: { busy: false, holdUntil: 0, disHoldUntil: 0 },
      plan: function () {
        return Promise.all([__cdbEx_cusTpm(), __cdbEx_cusGate()]).then(function (a) {
          var t = a[0];
          var g = a[1];
          var row = __cdbEx_cusTpmRow(t, g);
          return { g: g, enable: row.enable, disable: row.disable, fallback: function (verb) {
            return g.helper.safe ? __cdbEx_cusHelperCmd(g, verb)
              : (verb === "enable" ? __cdbEx_cusTee(t.link.state === "stale") : __cdbEx_cusRm());
          } };
        });
      }
    },
    kvm: {
      id: "kvm", what: "KVM", helper: "cdb-kvm-access", helperPath: __cdbEx_cusKvmHelper, maxExit: 6,
      changedRe: /^cdb-kvm-access: (?:(?:enabled|re-pointed|disabled)\b|already disabled \(acl cleared)/,
      confirm: __cdbEx_CUS_KVM_CONFIRM,
      question: "Let Claude Desktop use this computer's virtualization devices for the local Cowork VM?",
      lock: { busy: false, holdUntil: 0, disHoldUntil: 0 },
      plan: function () {
        return Promise.all([__cdbEx_cusKvm(), __cdbEx_cusGate(__cdbEx_ACCESS.kvm)]).then(function (a) {
          var k = a[0];
          var g = a[1];
          var acts = __cdbEx_cusKvmActs(g, k);
          return { g: g, enable: acts.enable, disable: acts.disable, fallback: function (verb) {
            return g.helper.safe ? __cdbEx_cusHelperCmd(g, verb) : (verb === "enable" ? __cdbEx_cusKvmTee(k) : __cdbEx_cusKvmRm());
          } };
        });
      }
    }
  };

  // 1P or 3P: the sender's own origin is the fact (the 3P main window is
  // app://localhost); without a sender, the relocated userData.
  function __cdbEx_cusMode(sender) {
    try {
      var u = sender && typeof sender.getURL === "function" ? String(sender.getURL() || "") : "";
      if (/^app:\/\/localhost(?:[\/?#]|$)/i.test(u)) return "3p";
      if (/^https:\/\//i.test(u)) return "1p";
    } catch (e) { /* fall through */ }
    return __cdbEx_runningMode("1p");
  }

  function __cdbEx_cusState(mode) {
    return Promise.all([__cdbEx_cusDesktop(), __cdbEx_cusTpm(), __cdbEx_cusLog(), __cdbEx_cusGate(),
      __cdbEx_cusKvm(), __cdbEx_cusGate(__cdbEx_ACCESS.kvm), __cdbEx_cusVmRunning()]).then(function (a) {
      var d = __cdbEx_cusDecision();
      var tpm = __cdbEx_cusTpmRow(a[1], a[3]);
      var cloud = __cdbEx_cusCloudRow(a[2], tpm, d);
      if (mode === "3p") {
        tpm = { row: __cdbEx_cusRow("na", "Not used in 3P mode", "tpm"), enable: null, disable: null, restart: false, tss: null, state: tpm.state };
        cloud = __cdbEx_cusRow("na", "Not used in 3P mode", "cloud");
      }
      var k = a[4];
      var at = __cdbEx_cusVmAtStart();
      var restart = !!at.value && at.value.kvm !== "ok" && k.now === "ok";
      var kacts = __cdbEx_cusKvmActs(a[5], k);
      var vm = { atStart: at.value, now: k.now, running: a[6] };
      return { desktop: a[0], tpm: tpm, cloud: cloud, link: a[1].link, gate: a[3], decision: d,
        kvm: k, kvmActs: kacts, vm: vm, vmRestart: restart, vmAt: at };
    });
  }

  var __cdbEx_cusReadP = null;
  var __cdbEx_cusReadMode = null;
  var __cdbEx_cusResetBusy = false;

  function __cdbEx_cusRead(sender) {
    var mode = __cdbEx_cusMode(sender);
    if (__cdbEx_cusReadP && __cdbEx_cusReadMode === mode) return __cdbEx_cusReadP;
    var p = __cdbEx_cusState(mode).then(function (s) {
      var k = s.kvm;
      var grp = k.kvm.group && /^[a-z_][a-z0-9_-]*$/.test(k.kvm.group) ? k.kvm.group : "kvm";
      var actions = {
        tpmEnable: s.tpm.enable,
        tpmDisable: s.tpm.disable,
        restart: s.tpm.restart,
        resetScreenSharing: !!(s.desktop.doctor && s.desktop.doctor.session_supported === true && process.env.CLAUDE_LAUNCHER),
        tssCommand: s.tpm.tss,
        kvmEnable: s.kvmActs.enable,
        kvmDisable: s.kvmActs.disable,
        vmRestart: s.vmRestart,
        // The manual alternative where the seat rule gives this session nothing
        // (no logind seat): the device's group, then a new login.
        kvmGroupCommand: k.kvm.state === "denied" ? "sudo usermod -aG " + grp + " \"$USER\"" : null,
        vsockCommand: k.vsock.state === "absent" && k.modules ? "sudo modprobe vhost_vsock" : null
      };
      return { ok: true, mode: mode,
        rows: { desktop: s.desktop.row, tpm: s.tpm.row, cloud: s.cloud,
          kvm: __cdbEx_cusKvmRow(k, s.vmRestart), vsock: __cdbEx_cusVsockRow(k), vmTools: __cdbEx_cusVmToolsRow(s.vmAt),
          vm: __cdbEx_cusVmRow(s.vm.running) },
        actions: actions, screenshots: __cdbEx_cusShots(), vm: s.vm };
    });
    __cdbEx_cusReadP = p;
    __cdbEx_cusReadMode = mode;
    function done() { if (__cdbEx_cusReadP === p) __cdbEx_cusReadP = null; }
    p.then(done, done);
    return p;
  }

  // The header icon's facts (js/cowork_device_icon_web_page.js): files only,
  // no doctor, no child process; single flight, answered from a 2 s cache.
  var __cdbEx_cusIconP = null;
  var __cdbEx_cusIconAt = 0;
  var __cdbEx_cusIconV = null;
  var __cdbEx_CUS_VM_LINES = {
    ok: "Local VM ready",
    missing: "Local VM unavailable: /dev/kvm is missing (virtualization off in the firmware?)",
    no_permission: "Local VM unavailable: no access to /dev/kvm or /dev/vhost-vsock",
    vsock_module_missing: "Local VM unavailable: the vhost_vsock module is not loaded",
    vsock_kernel_unsupported: "Local VM unavailable: this kernel has no vhost-vsock"
  };
  function __cdbEx_cusIconFacts() {
    if (__cdbEx_cusIconV && Date.now() - __cdbEx_cusIconAt < __cdbEx_CUS_ICON_MS) return Promise.resolve(__cdbEx_cusIconV);
    if (__cdbEx_cusIconP) return __cdbEx_cusIconP;
    var p = Promise.all([__cdbEx_cusDevOf(__cdbEx_TPM_DEV), __cdbEx_cusKvm(), __cdbEx_cusVmRunning()]).then(function (a) {
      var t = a[0].state;
      var k = a[1];
      var at = __cdbEx_cusVmAtStart().value;
      var miss = at ? __cdbEx_cusVmMissing(at) : null;
      var tools = !at ? "unknown" : miss.length ? "missing" : "ok";
      var line = __cdbEx_CUS_VM_LINES[k.now] || "Local VM: unknown";
      if (k.now === "ok" && tools === "missing") line = "Local VM unavailable: " + miss.join(", ") + " not found";
      if (k.now === "ok" && at && at.kvm !== "ok") line = "Local VM: access fixed - restart Claude to use it";
      else if (k.now === "ok" && tools === "ok" && a[2] === true) line += " - running";
      var v = { tpm: t === "ok" || t === "denied" || t === "absent" ? t : "unknown",
        vm: { now: k.now, tools: tools, running: a[2] }, line: line };
      __cdbEx_cusIconV = v;
      __cdbEx_cusIconAt = Date.now();
      return v;
    });
    __cdbEx_cusIconP = p;
    function done() { if (__cdbEx_cusIconP === p) __cdbEx_cusIconP = null; }
    p.then(done, done);
    return p;
  }
  function __cdbEx_cusIcon(sender) {
    var mode = __cdbEx_cusMode(sender);
    return __cdbEx_cusIconFacts().then(function (v) {
      return { ok: true, mode: mode, tpm: v.tpm, vm: { now: v.vm.now, tools: v.vm.tools, running: v.vm.running }, line: v.line };
    });
  }

  // The deep link into Settings -> Extra -> Cowork (Linux): upstream's own
  // settings navigation, on the sender only, to a fixed route. The page opens
  // the panel once the settings dialog mounts (window.__cdbExtraOpen).
  var __cdbEx_navWarned = false;
  function __cdbEx_openSettings(sender) {
    var nav = globalThis.__cdbNavigation;
    var disp = null;
    try {
      disp = nav && typeof nav.getDispatcher === "function" && sender && !(typeof sender.isDestroyed === "function" && sender.isDestroyed())
        ? nav.getDispatcher(sender) : null;
    } catch (e) { disp = null; }
    if (!disp || typeof disp.dispatchNavigate !== "function") {
      if (!__cdbEx_navWarned) {
        __cdbEx_navWarned = true;
        __cdbEx_log("open-settings: " + (nav ? "no navigation dispatcher for this view" :
          "the app's navigation capture is missing (add_feature_extra_settings sub-patch C)"));
      }
      return { ok: false, error: "settings navigation unavailable" };
    }
    try {
      disp.dispatchNavigate(__cdbEx_SETTINGS_ROUTE);
    } catch (e) {
      return { ok: false, error: "settings navigation failed: " + __cdbEx_cusErr(e) };
    }
    return { ok: true };
  }

  // Main's own consent for Enable: the page (remote code) can ask, only this
  // dialog decides. Disable has none: it only takes access away, and pkexec
  // still asks for the administrator password. Resolves true only for the
  // "Enable <TPM|KVM> access" button; Cancel, Escape, closing it or any error is false.
  function __cdbEx_cusConfirmEnable(sender, acc) {
    acc = acc || __cdbEx_ACCESS.tpm;
    var dlg = _electron.dialog;
    if (!dlg || typeof dlg.showMessageBox !== "function") return Promise.resolve(false);
    var win;
    try {
      var BW = _electron.BrowserWindow;
      win = (BW && sender && typeof BW.fromWebContents === "function" && BW.fromWebContents(sender)) || undefined;
    } catch (e) { win = undefined; }
    var opts = {
      type: "warning",
      title: "Enable " + acc.what + " access",
      message: acc.question,
      detail: acc.confirm,
      buttons: ["Cancel", "Enable " + acc.what + " access"],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    };
    return Promise.resolve().then(function () {
      return win ? dlg.showMessageBox(win, opts) : dlg.showMessageBox(opts);
    }).then(function (r) { return !!(r && r.response === 1); }, function (e) {
      __cdbEx_log("cu-status: confirmation dialog failed: " + __cdbEx_cusErr(e));
      return false;
    });
  }

  // pkexec <helper> enable|disable, only where the read offers that button.
  // Enable runs only after main's confirmation dialog; a declined, cancelled
  // or failed Enable holds further Enable requests of that access for the
  // cooldown. TPM and KVM each have their own busy flag and cooldown.
  // One administrator prompt at a time across TPM and KVM: the access whose
  // change is running (its confirmation dialog or pkexec), or null.
  var __cdbEx_cusPromptOwner = null;
  function __cdbEx_cusAccessAction(acc, verb, sender) {
    var lock = acc.lock;
    if (acc.id === "tpm" && __cdbEx_cusMode(sender) === "3p") {
      return Promise.resolve({ ok: false, code: "not-allowed", error: "the device key is not used in 3P mode", command: null });
    }
    if (__cdbEx_cusPromptOwner) {
      return Promise.resolve({ ok: false, code: "busy", error: __cdbEx_cusPromptOwner === acc
        ? "a " + acc.what + " access change is already running"
        : "a " + __cdbEx_cusPromptOwner.what + " access change is already running - finish its prompt first", command: null });
    }
    var hold = verb === "enable" ? lock.holdUntil : lock.disHoldUntil;
    if (Date.now() < hold) {
      var left = Math.max(1, Math.ceil((hold - Date.now()) / 1000));
      return Promise.resolve({ ok: false, code: "cooldown", error: "the last " + (verb === "enable" ? "Enable was declined or failed" : "Disable was cancelled") +
        " - try again in " + left + " s", command: null });
    }
    __cdbEx_cusPromptOwner = acc;
    lock.busy = true;
    function release(v) {
      lock.busy = false;
      __cdbEx_cusPromptOwner = null;
      if (verb === "enable" && v && v.ok === false && v.code !== "not-allowed" && v.code !== "nothing-to-do") {
        lock.holdUntil = Date.now() + __cdbEx_CUS_ENABLE_COOLDOWN_MS;
      }
      // A Disable whose prompt was dismissed: no prompt loop either.
      if (verb === "disable" && v && (v.code === "cancelled" || v.code === "no-agent")) {
        lock.disHoldUntil = Date.now() + __cdbEx_CUS_ENABLE_COOLDOWN_MS;
      }
      return v;
    }
    return acc.plan().then(function (pl) {
      var g = pl.g;
      var act = verb === "enable" ? pl.enable : pl.disable;
      if (act && act.disabled) {
        return { ok: false, code: "nothing-to-do", error: act.disabled, command: null };
      }
      var fallback = pl.fallback(verb);
      if (!act || act.kind !== "pkexec") {
        return { ok: false, code: "not-allowed", error: acc.what + " access cannot be " + verb + "d from here in this state",
          command: act && act.text ? act.text : null };
      }
      var asked = verb === "enable" ? __cdbEx_cusConfirmEnable(sender, acc) : Promise.resolve(true);
      return asked.then(function (yes) {
        if (!yes) {
          __cdbEx_log("cu-status: " + acc.id + " enable -> declined in the confirmation dialog");
          return { ok: false, code: "declined", error: "Enable was not confirmed", command: null };
        }
        return __cdbEx_cusPkexecRun(g, verb, fallback, acc);
      });
    }).then(release, function (e) {
      return release({ ok: false, code: "error", error: __cdbEx_cusErr(e), command: null });
    });
  }
  function __cdbEx_cusTpmAction(verb, sender) { return __cdbEx_cusAccessAction(__cdbEx_ACCESS.tpm, verb, sender); }
  function __cdbEx_cusKvmAction(verb, sender) { return __cdbEx_cusAccessAction(__cdbEx_ACCESS.kvm, verb, sender); }
  function __cdbEx_cusPkexecRun(g, verb, fallback, acc) {
    acc = acc || __cdbEx_ACCESS.tpm;
    __cdbEx_log("cu-status: pkexec " + g.helper.path + " " + verb);
    return new Promise(function (resolve) {
      try {
        __cdbEx_cubgCp().execFile(g.pkexec, [g.helper.path, verb], {
          timeout: __cdbEx_CUS_PKEXEC_MS, encoding: "utf8", maxBuffer: 64 * 1024, windowsHide: true
        }, function (err, stdout, stderr) {
          var out = String(stdout || "").split("\n").map(function (l) { return l.trim(); }).filter(Boolean)[0] || "";
          var errLine = String(stderr || "").split("\n").map(function (l) { return l.trim(); }).filter(Boolean)[0] || "";
          if (!err) {
            // Disable keeps the access entry when another udev rule still
            // grants it: say so, the change alone does not end the access.
            var kept = /acl kept, another udev rule grants it: ([^;)]+)/.exec(out);
            var res = { ok: true, changed: acc.changedRe.test(out),
              message: out || acc.helper + ": finished without a status line" };
            if (kept) res.note = "Access stays on " + kept[1].trim() + ": another udev rule on this computer grants it.";
            resolve(res);
            return;
          }
          var code;
          if (err.killed) code = "timeout";
          else if (err.code === 126) code = "cancelled";
          else if (err.code === 127) code = "no-agent";
          else if (err.code >= 1 && err.code <= acc.maxExit) code = "helper-" + err.code;
          else code = "error";
          var msg = code === "timeout" ? "no answer within " + (__cdbEx_CUS_PKEXEC_MS / 1000) + " s"
            : code === "cancelled" ? "authentication was cancelled"
            : code === "no-agent" ? (errLine || "no polkit authentication agent answered")
            : (errLine || err.message || String(err));
          resolve({ ok: false, code: code, error: String(msg).slice(0, 400), command: code === "cancelled" ? null : fallback });
        });
      } catch (e) {
        resolve({ ok: false, code: "error", error: __cdbEx_cusErr(e), command: fallback });
      }
    }).then(function (r) {
      __cdbEx_log("cu-status: " + acc.id + " " + verb + " -> " + (r.ok ? r.message : r.code + " (" + r.error + ")"));
      return r;
    });
  }
  function __cdbEx_cusReset() {
    var launcher = String(process.env.CLAUDE_LAUNCHER || "");
    if (!launcher || /[\n\r\0]/.test(launcher)) return Promise.resolve({ ok: false, error: "CLAUDE_LAUNCHER is not set - run claude-desktop --reset-screen-sharing in a terminal" });
    if (__cdbEx_cusResetBusy) return Promise.resolve({ ok: false, error: "a reset is already running" });
    __cdbEx_cusResetBusy = true;
    return new Promise(function (resolve) {
      try {
        __cdbEx_cubgCp().execFile(launcher, ["--reset-screen-sharing"], {
          timeout: __cdbEx_CUS_RESET_MS, encoding: "utf8", maxBuffer: 256 * 1024, windowsHide: true
        }, function (err, stdout, stderr) {
          var lines = (String(stdout || "") + "\n" + String(stderr || "")).split("\n")
            .map(function (l) { return l.replace(/\s+$/, ""); }).filter(Boolean).slice(0, 20);
          if (!err) { resolve({ ok: true, lines: lines.length ? lines : ["claude-desktop --reset-screen-sharing finished"] }); return; }
          var why = err.killed ? "no answer within " + (__cdbEx_CUS_RESET_MS / 1000) + " s" : (typeof err.code === "number" ? "exit " + err.code : err.message);
          resolve({ ok: false, error: "reset screen sharing failed (" + why + ")" + (lines.length ? ": " + lines.join(" / ") : "") });
        });
      } catch (e) {
        resolve({ ok: false, error: __cdbEx_cusErr(e) });
      }
    }).then(function (r) {
      __cdbEx_cusResetBusy = false;
      __cdbEx_log("cu-status: reset screen sharing -> " + (r.ok ? r.lines.join(" / ") : r.error));
      return r;
    });
  }

  // --- handlers ------------------------------------------------------------

  var __cdbEx_diagSeen = {};

  var __cdbEx_handlers = {
    // Reduced projection of the theme registry. cdb-themes:apply / :active stay
    // owned by the theme picker patch; only this list is ours, because the full
    // entries carry every token of every palette.
    "cdb-extra:themes-list": function () {
      var themes = globalThis.__cdbThemes;
      if (!themes) return { ok: false, error: "the custom themes patch did not install globalThis.__cdbThemes in this build" };
      var entries = themes.list().map(function (e) {
        return {
          name: e.name,
          displayName: e.displayName || e.name,
          source: e.source || "",
          // Passed through from the registry so the page can section by category
          // independently of the source tier. "" when the theme has none, and
          // absent entirely in builds whose registry predates the field - the
          // page treats both the same way.
          category: e.category || "",
          light: __cdbEx_dots(e.light),
          dark: __cdbEx_dots(e.dark)
        };
      });
      return {
        ok: true, entries: entries, active: themes.active(),
        configPath: themes.configPath || "",
        // Where a click in the panel will really persist the choice.
        savePath: __cdbEx_themeSaveTarget()
      };
    },

    "cdb-extra:paths": function () {
      return { ok: true, paths: __cdbEx_paths() };
    },

    // Native dialog with "Allow always" for starting other sessions. Pref,
    // grants and the predicate above; the broker hook reads them live.
    "cdb-session-start:read": function () {
      var s = __cdbEx_ssaPref();
      return { ok: true, enabled: s.value, lockedByJsonc: s.locked ? true : null,
        grants: Object.keys(__cdbEx_ssaGrants()).length };
    },
    "cdb-session-start:set": function (enabled) {
      if (typeof enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
      if (__cdbEx_ssaPref().locked) {
        return { ok: false, lockedByJsonc: true,
          error: __cdbEx_SSA_KEY + " is set in claude-desktop-extra.jsonc - edit that file to change it" };
      }
      // Off forgets every remembered approval in the same write.
      var res = __cdbEx_writeCfg(function (cfg) {
        if (enabled) cfg[__cdbEx_SSA_KEY] = true;
        else { delete cfg[__cdbEx_SSA_KEY]; delete cfg[__cdbEx_SSA_GRANTS]; }
      });
      __cdbEx_ssaRevision++;
      if (!res.ok) return res;
      return { ok: true, enabled: enabled, path: res.path, grants: Object.keys(__cdbEx_ssaGrants()).length };
    },
    "cdb-session-start:revoke": function () {
      var res = __cdbEx_ssaForget();
      if (!res.ok) return res;
      var s = __cdbEx_ssaPref();
      return { ok: true, enabled: s.value, lockedByJsonc: s.locked ? true : null, grants: 0 };
    },

    // Theme picker (Ctrl+Shift+T). The window and the hotkey live in
    // patches/community/add_feature_theme_picker.nim, which reads this same key
    // itself on every press - persistence is ours because this file is the
    // single writer of the .json.
    //
    // ON IS THE DEFAULT: the shortcut is how a fresh install finds the themes,
    // so an absent key means enabled and only an explicit false takes it away.
    "cdb-picker:read": function () {
      if (typeof globalThis.__cdbOpenThemePicker !== "function") {
        return { ok: false, error: "the theme picker patch is not installed in this build" };
      }
      var p = __cdbEx_paths();
      var jsonc = __cdbEx_readFileKey(p.jsonc, "themePicker");
      var json = __cdbEx_readFileKey(p.json, "themePicker");
      var value = typeof jsonc === "boolean" ? jsonc : json;
      return {
        ok: true,
        enabled: value !== false,
        // A hand-edited .jsonc wins the per-key merge, so the switch must show
        // itself as locked rather than silently disagree with the file. Reported
        // as true/null, not as the value: the page only tests truthiness, and a
        // locking `false` would read as "not locked".
        lockedByJsonc: typeof jsonc === "boolean" ? true : null
      };
    },

    "cdb-picker:set": function (enabled) {
      if (typeof globalThis.__cdbOpenThemePicker !== "function") {
        return { ok: false, error: "the theme picker patch is not installed in this build" };
      }
      if (typeof enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
      var res = __cdbEx_writeCfg(function (cfg) {
        // On is the default, so only the off case needs a key on disk.
        if (enabled) delete cfg.themePicker;
        else cfg.themePicker = false;
        return enabled;
      });
      if (!res.ok) return res;
      return { ok: true, enabled: enabled, path: res.path };
    },

    // Always use the white tray icon. The pref and its reader are above
    // (__cdbEx_trayPref); globalThis.__cdbTrayRefresh is upstream's
    // crash-contained tray update, published by fix_tray_icon_theme.nim, and
    // its presence is how we know that patch is in this build. Off is the default.
    "cdb-tray:read": function () {
      if (typeof globalThis.__cdbTrayRefresh !== "function") {
        return { ok: false, error: "the tray icon patch is not installed in this build" };
      }
      var s = __cdbEx_trayPref();
      return { ok: true, enabled: s.value, lockedByJsonc: s.locked ? true : null };
    },

    "cdb-tray:set": function (enabled) {
      if (typeof globalThis.__cdbTrayRefresh !== "function") {
        return { ok: false, error: "the tray icon patch is not installed in this build" };
      }
      if (typeof enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
      if (__cdbEx_trayPref().locked) {
        return { ok: false, lockedByJsonc: true,
          error: __cdbEx_TRAY_KEY + " is set in claude-desktop-extra.jsonc - edit that file to change it" };
      }
      var res = __cdbEx_writeCfg(function (cfg) {
        if (enabled) cfg[__cdbEx_TRAY_KEY] = true;
        else delete cfg[__cdbEx_TRAY_KEY];
        return enabled;
      });
      if (!res.ok) return res;
      // Re-run the tray update now: it re-asks the selector and only calls
      // setImage when the chosen file changed. The setting is saved either way.
      var refreshed = false;
      try {
        var refresh = globalThis.__cdbTrayRefresh;
        if (typeof refresh === "function") { refresh(); refreshed = true; }
      } catch (e) {
        __cdbEx_log("tray refresh after " + __cdbEx_TRAY_KEY + "=" + enabled + " failed: " + ((e && e.message) || e));
      }
      return { ok: true, enabled: enabled, path: res.path, refreshed: refreshed };
    },

    // Auto-fix notices (ready to merge, comments after merge). Pref and reader
    // above; both sweep wrappers read it live, so there is nothing to refresh.
    "cdb-autofix-merge-ready:read": function () {
      var s = __cdbEx_afmrPref();
      return { ok: true, enabled: s.value, lockedByJsonc: s.locked ? true : null };
    },

    "cdb-autofix-merge-ready:set": function (enabled) {
      if (typeof enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
      if (__cdbEx_afmrPref().locked) {
        return { ok: false, lockedByJsonc: true,
          error: __cdbEx_AFMR_KEY + " is set in claude-desktop-extra.jsonc - edit that file to change it" };
      }
      var res = __cdbEx_writeCfg(function (cfg) {
        if (enabled) cfg[__cdbEx_AFMR_KEY] = true;
        else delete cfg[__cdbEx_AFMR_KEY];
        return enabled;
      });
      if (!res.ok) return res;
      return { ok: true, enabled: enabled, path: res.path };
    },

    // Escape stops Computer Use (community). Pref and reader above; read at
    // each arm, so there is nothing to refresh.
    "cdb-cu-esc:read": function () {
      var s = __cdbEx_cuEscPref();
      return { ok: true, enabled: s.value, lockedByJsonc: s.locked ? true : null };
    },

    "cdb-cu-esc:set": function (enabled) {
      if (typeof enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
      if (__cdbEx_cuEscPref().locked) {
        return { ok: false, lockedByJsonc: true,
          error: __cdbEx_CUESC_KEY + " is set in claude-desktop-extra.jsonc - edit that file to change it" };
      }
      var res = __cdbEx_writeCfg(function (cfg) {
        if (enabled) cfg[__cdbEx_CUESC_KEY] = true;
        else delete cfg[__cdbEx_CUESC_KEY];
        return enabled;
      });
      if (!res.ok) return res;
      // Setting the switch (either way) is a fresh start for the watcher's
      // breaker: a key the user freed after a refusal is tried again.
      try { var w = globalThis.__cdbCuEscWatch; if (w && typeof w.reset === "function") w.reset(); } catch (e) {}
      return { ok: true, enabled: enabled, path: res.path };
    },

    "cdb-archive-grace:read": function (sessionId) {
      if (sessionId !== undefined) {
        if (typeof sessionId !== "string" || sessionId.length < 1 || sessionId.length > 256)
          return { ok: false, error: "invalid session id" };
        if (__cdbEx_aagPref().value === 0) return { ok: true, active: false };
        return globalThis.__cdbArchiveGraceStatus?.(sessionId) || { ok: true, active: true, ready: false };
      }
      var s = __cdbEx_aagPref();
      return { ok: true, minutes: s.value, lockedByJsonc: s.locked ? true : null, warning: s.warning || null };
    },
    "cdb-archive-grace:set": function (minutes) {
      if (!__cdbEx_aagValid(minutes)) return { ok: false, error: "minutes must be a whole number from 0 to 10080" };
      if (__cdbEx_aagPref().locked) return { ok: false, lockedByJsonc: true,
        error: __cdbEx_AAG_KEY + " is set in claude-desktop-extra.jsonc - edit that file to change it" };
      var res = __cdbEx_writeCfg(function (cfg) {
        if (minutes === 0) delete cfg[__cdbEx_AAG_KEY];
        else cfg[__cdbEx_AAG_KEY] = minutes;
        return minutes;
      });
      if (res.ok) { try { globalThis.__cdbArchiveGraceWebRefresh?.(); } catch (e) {} }
      return res.ok ? { ok: true, minutes: minutes, path: res.path, warning: __cdbEx_aagPref().warning || null } : res;
    },
    // "Keep this session" in the 1P Code page: upstream's per-session
    // "Auto-archive on merge or close" = false, through the engine's own
    // session manager (js/auto_archive_grace.js defines the hook once the
    // archive engine has swept). Never touches another session or the default.
    "cdb-archive-grace:keep": function (sessionId) {
      if (typeof sessionId !== "string" || sessionId.length < 1 || sessionId.length > 256)
        return { ok: false, error: "invalid session id" };
      if (__cdbEx_aagPref().value === 0) return { ok: false, error: "the PR archive delay is off" };
      var keep = globalThis.__cdbArchiveGraceKeep;
      if (typeof keep !== "function") return { ok: false, error: "the archive engine has not swept yet" };
      return Promise.resolve().then(function () { return keep(sessionId); }).then(function (r) {
        return r && r.ok === true ? { ok: true } : { ok: false, error: (r && r.error) || "not kept" };
      }, function (e) { return { ok: false, error: (e && e.message) || String(e) }; });
    },

    // Computer Use: read app controls (accessibility). Pref and reader above.
    "cdb-cu-ax:read": function () {
      var s = __cdbEx_cuAxPref();
      return { ok: true, enabled: s.value, lockedByJsonc: s.locked ? true : null };
    },

    "cdb-cu-ax:set": function (enabled) {
      if (typeof enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
      if (__cdbEx_cuAxPref().locked) {
        return { ok: false, lockedByJsonc: true,
          error: __cdbEx_CUAX_KEY + " is set in claude-desktop-extra.jsonc - edit that file to change it" };
      }
      var res = __cdbEx_writeCfg(function (cfg) {
        if (enabled) cfg[__cdbEx_CUAX_KEY] = true;
        else delete cfg[__cdbEx_CUAX_KEY];
        return enabled;
      });
      if (!res.ok) return res;
      return { ok: true, enabled: enabled, path: res.path };
    },

    // Computer Use: ask before controlling an app. Pref and reader above. On is
    // the absence of the key, off an explicit false.
    "cdb-cu-ask:read": function () {
      var s = __cdbEx_cuAskPref();
      return { ok: true, enabled: s.value !== false, lockedByJsonc: s.locked ? true : null };
    },

    "cdb-cu-ask:set": function (enabled) {
      if (typeof enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
      if (__cdbEx_cuAskPref().locked) {
        return { ok: false, lockedByJsonc: true,
          error: __cdbEx_CUASK_KEY + " is set in claude-desktop-extra.jsonc - edit that file to change it" };
      }
      var res = __cdbEx_writeCfg(function (cfg) {
        if (enabled) delete cfg[__cdbEx_CUASK_KEY];
        else cfg[__cdbEx_CUASK_KEY] = false;
        return enabled;
      });
      if (!res.ok) return res;
      // The per-app access answer upstream's UI shows follows this switch
      // (js/cu_consent.js re-signals the renderer when it changed). Only this
      // setter re-signals: a hand edit of claude-desktop-extra.jsonc / .json
      // takes effect on the next features read (window open, app restart).
      try {
        var cc = globalThis.__cdbCuConsent;
        if (cc && typeof cc.capChanged === "function") cc.capChanged("ask-before-control switch");
      } catch (e) {}
      return { ok: true, enabled: enabled, path: res.path };
    },

    "cdb-autofix-author:read": function () {
      var s = __cdbEx_autoFixAuthorPref();
      return { ok: true, entries: s.entries, warning: s.warning || null, lockedByJsonc: s.locked };
    },

    "cdb-autofix-author:set": function (entries) {
      var normalized;
      try { normalized = __cdbEx_normalizeAuthors(entries); }
      catch (e) { return { ok: false, error: e.message }; }
      if (__cdbEx_autoFixAuthorPref().locked) {
        return { ok: false, error: __cdbEx_AUTOFIX_KEY + " is set in claude-desktop-extra.jsonc - edit that file to change it" };
      }
      var res = __cdbEx_writeCfg(function (cfg) {
        if (normalized.length) cfg[__cdbEx_AUTOFIX_KEY] = normalized;
        else delete cfg[__cdbEx_AUTOFIX_KEY];
        // An earlier local preview used this boolean. Never migrate it into trust.
        delete cfg.autoFixAllowDifferentAuthor;
        return normalized;
      });
      if (!res.ok) return res;
      return { ok: true, entries: normalized, path: res.path };
    },

    "cdb-flags:catalog": function () {
      var catalog = __cdbEx_catalog();
      if (!catalog) {
        return { ok: false, error: "the growthbook overrides patch did not install globalThis.__cdbGbFlags in this build" };
      }
      return { ok: true, count: catalog.length, entries: catalog };
    },

    "cdb-flags:read": function () {
      var gb = __cdbEx_gb();
      var catalog = __cdbEx_catalog();
      if (!gb || !catalog) {
        return { ok: false, error: "the growthbook overrides patch did not install globalThis.__cdbGbFlags in this build" };
      }
      var p = __cdbEx_paths();
      var builtins = {};
      try { builtins = gb.builtins() || {}; } catch (e) {}
      var ids = catalog.map(function (e) { return e.id; }).concat(Object.keys(builtins));
      var server = null, effective = null;
      try { server = gb.server(); } catch (e2) {}
      try { effective = gb.effective(); } catch (e3) {}
      return {
        ok: true,
        storeSeen: !!(server || effective),
        server: __cdbEx_project(server, ids),
        effective: __cdbEx_project(effective, ids),
        overridesJson: __cdbEx_readFileOverrides(p.json),
        overridesJsonc: __cdbEx_readFileOverrides(p.jsonc),
        builtins: builtins,
        paths: p
      };
    },

    "cdb-flags:set": function (id, value) {
      if (!__cdbEx_knownId(id)) return { ok: false, error: "unknown flag id" };
      var t = typeof value;
      if (!(t === "boolean" || t === "number" || (t === "string" && value.length <= 200))) {
        return { ok: false, error: "a flag override must be a boolean, a number or a short string" };
      }
      var warn = __cdbEx_warned(id);
      if (warn && value !== false) {
        return { ok: false, error: "refusing to enable " + id + ": " + warn };
      }
      var jsonc = __cdbEx_readFileOverrides(__cdbEx_paths().jsonc);
      if (Object.prototype.hasOwnProperty.call(jsonc, id)) {
        return { ok: false, error: id + " is set in claude-desktop-extra.jsonc, which wins over this page - edit that file instead" };
      }
      var res = __cdbEx_writeOverrides(function (o) { o[id] = value; });
      if (res.ok) __cdbEx_log("override " + id + "=" + JSON.stringify(value) + " saved to " + res.path);
      return res;
    },

    "cdb-flags:unset": function (id) {
      if (!__cdbEx_knownId(id)) return { ok: false, error: "unknown flag id" };
      var res = __cdbEx_writeOverrides(function (o) { delete o[id]; });
      if (res.ok) __cdbEx_log("override " + id + " removed from " + res.path);
      return res;
    },

    // --- deployment mode ---------------------------------------------------

    "cdb-deploy:read": function () {
      var s = __cdbEx_deployState();
      return {
        ok: true,
        running: s.running,
        persisted: s.persisted,
        expected: s.expected,
        source: s.source,
        editable: s.editable,
        locksSignIn: s.locksSignIn,
        policyMode: s.policyMode,
        paths: s.paths,
        managed: s.managed,
        local: s.local,
        keys: __cdbEx_DEPLOY_KEYS,
        groups: __cdbEx_DEPLOY_GROUPS,
        keepToken: __cdbEx_KEEP
      };
    },

    // The whole point of the panel: persist upstream's own escape hatch. Writing
    // "1p" is what makes a machine with a stored 3P config boot personal again.
    // "clear" removes the key instead - the same value upstream's own
    // setDeploymentMode takes - so the config sources decide again.
    "cdb-deploy:mode": function (mode) {
      if (mode !== "1p" && mode !== "3p" && mode !== "clear") {
        return { ok: false, error: "mode must be \"1p\", \"3p\" or \"clear\"" };
      }
      var s = __cdbEx_deployState();
      if (mode === "clear") {
        var cur = __cdbEx_readJson(s.paths.modeFile);
        if (cur.missing) return { ok: true, mode: null, expected: s.expected, unchanged: true };
        if (cur.error) return { ok: false, error: s.paths.modeFile + ": " + cur.error };
        if (cur.value[__cdbEx_MODE_KEY] === undefined) {
          return { ok: true, mode: null, expected: s.expected, unchanged: true };
        }
        delete cur.value[__cdbEx_MODE_KEY];
        var cw = __cdbEx_writeJson(s.paths.modeFile, cur.value);
        if (cw) return { ok: false, error: cw };
        __cdbEx_log("deploymentMode cleared in " + s.paths.modeFile);
        var cleared = __cdbEx_deployState();
        return { ok: true, mode: null, expected: cleared.expected, path: s.paths.modeFile };
      }
      if (mode === "1p" && s.policyMode === "3p") {
        return { ok: false, error: "the managed policy in " + __cdbEx_ETC_FILE +
          " pins third-party mode (deploymentMode \"3p\" or disableDeploymentModeChooser), which overrides this switch - 1P cannot be selected here" };
      }
      if (mode === "3p" && s.policyMode === "1p") {
        return { ok: false, error: "the managed policy in " + __cdbEx_ETC_FILE +
          " sets deploymentMode \"1p\" (Claude.ai only), which overrides this switch - 3P cannot be selected here" };
      }
      if (mode === "3p" && s.source === "none") {
        return { ok: false, error: "no third-party configuration is stored yet - pick a provider below first, then switch" };
      }
      if (mode === "3p" && s.source === "local" && !s.local.selects3p) {
        return { ok: false, error: "the stored configuration has no inference provider, bootstrap URL or self-hosted server, so it would still boot 1P - set a provider below first" };
      }
      var read = __cdbEx_readJson(s.paths.modeFile);
      if (read.error) return { ok: false, error: s.paths.modeFile + ": " + read.error };
      var cfg = read.value || {};
      cfg[__cdbEx_MODE_KEY] = mode;
      var w = __cdbEx_writeJson(s.paths.modeFile, cfg);
      if (w) return { ok: false, error: w };
      __cdbEx_log("deploymentMode=" + mode + " persisted to " + s.paths.modeFile);
      return { ok: true, mode: mode, path: s.paths.modeFile, expected: mode };
    },

    "cdb-deploy:set": function (key, value) {
      var entry = __cdbEx_deployKey(key);
      if (!entry) return { ok: false, error: "unknown configuration key" };
      if (entry.lock) return { ok: false, error: key + " is read-only here: " + entry.lock };
      var state = __cdbEx_deployState();
      if (!state.editable) {
        return { ok: false, error: "the managed policy in " + __cdbEx_ETC_FILE +
          " is active and replaces the local configuration - edit that file instead" };
      }
      var coerced = __cdbEx_deployCoerce(entry, value);
      if (coerced.error) return { ok: false, error: coerced.error };
      if (coerced.keep) return { ok: true, unchanged: true };
      var res = __cdbEx_writeEntry(function (cfg) {
        if (coerced.del) delete cfg[key];
        else cfg[key] = coerced.value;
        return "";
      });
      if (!res.ok) return res;
      __cdbEx_log((coerced.del ? "removed " : "set ") + key + " in " + res.file);
      var after = __cdbEx_deployState();
      return {
        ok: true, path: res.file, created: res.created,
        value: coerced.del ? null : __cdbEx_deployValue(entry, coerced.value),
        expected: after.expected, persisted: after.persisted, source: after.source
      };
    },

    // Undo a session of edits in one go: every key goes, the entry file and the
    // library metadata stay, so the configuration is still listed and can be
    // filled in again. A config with no keys carries no inference block, so the
    // next start is 1P.
    "cdb-deploy:clear": function () {
      var state = __cdbEx_deployState();
      if (!state.editable) {
        return { ok: false, error: "the managed policy in " + __cdbEx_ETC_FILE +
          " is active and replaces the local configuration - edit that file instead" };
      }
      if (!state.local.present) return { ok: true, cleared: 0, unchanged: true };
      var removed = 0;
      var res = __cdbEx_writeEntry(function (cfg) {
        Object.keys(cfg).forEach(function (k) { delete cfg[k]; removed++; });
        return "";
      });
      if (!res.ok) return res;
      __cdbEx_log("cleared " + removed + " key(s) from " + res.file);
      var after = __cdbEx_deployState();
      return { ok: true, cleared: removed, path: res.file, expected: after.expected, source: after.source };
    },

    // Switch between the configurations stored in the library, or apply none at
    // all - the non-destructive way out of 3P: the entry files stay on disk.
    "cdb-deploy:apply": function (id) {
      var paths = __cdbEx_deployPaths();
      var meta = __cdbEx_meta(paths);
      if (meta.error) return { ok: false, error: paths.metaFile + ": " + meta.error };
      var wanted = typeof id === "string" ? id : "";
      if (wanted && !meta.entries.some(function (e) { return e.id === wanted; })) {
        return { ok: false, error: "unknown configuration id" };
      }
      var next = { appliedId: wanted, entries: meta.entries };
      Object.keys(meta.raw).forEach(function (k) {
        if (k !== "appliedId" && k !== "entries") next[k] = meta.raw[k];
      });
      var w = __cdbEx_writeJson(paths.metaFile, next);
      if (w) return { ok: false, error: w };
      __cdbEx_log("applied config id " + (wanted || "(none)") + " in " + paths.metaFile);
      var after = __cdbEx_deployState();
      return { ok: true, appliedId: wanted, expected: after.expected, path: paths.metaFile };
    },

    // The escape hatch for keys this page renders as JSON, and the honest view of
    // what is actually on disk - with every secret replaced by the placeholder,
    // which is written back unchanged.
    "cdb-deploy:raw": function () {
      var s = __cdbEx_deployState();
      var body = {};
      Object.keys(s.local.values).forEach(function (k) { body[k] = s.local.values[k]; });
      return {
        ok: true,
        text: JSON.stringify(body, null, 2),
        file: s.local.file || _path.join(s.paths.libDir, "<new>.json"),
        unknown: s.local.unknown,
        editable: s.editable
      };
    },

    "cdb-deploy:save-raw": function (text) {
      if (typeof text !== "string" || text.length > 200000) {
        return { ok: false, error: "the configuration must be a JSON object" };
      }
      var state = __cdbEx_deployState();
      if (!state.editable) {
        return { ok: false, error: "the managed policy in " + __cdbEx_ETC_FILE +
          " is active and replaces the local configuration - edit that file instead" };
      }
      var parsed;
      try {
        parsed = JSON.parse(text.trim() || "{}");
      } catch (e) {
        return { ok: false, error: "invalid JSON: " + e.message };
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: "the top level must be a JSON object" };
      }
      var next = {};
      var keys = Object.keys(parsed);
      for (var i = 0; i < keys.length; i++) {
        var entry = __cdbEx_deployKey(keys[i]);
        if (!entry) {
          return { ok: false, error: "\"" + keys[i] + "\" is not a configuration key this build knows" };
        }
        if (entry.lock) {
          return { ok: false, error: keys[i] + " is read-only here: " + entry.lock };
        }
        var coerced = __cdbEx_deployCoerce(entry, parsed[keys[i]]);
        if (coerced.error) return { ok: false, error: coerced.error };
        if (coerced.keep) { next[keys[i]] = __cdbEx_KEEP; continue; }
        if (!coerced.del) next[keys[i]] = coerced.value;
      }
      var res = __cdbEx_writeEntry(function (cfg) {
        // Kept secrets carry the placeholder: take the stored value across, then
        // drop everything the new document no longer mentions.
        Object.keys(next).forEach(function (k) {
          if (next[k] === __cdbEx_KEEP) {
            if (cfg[k] === undefined) delete next[k];
            else next[k] = cfg[k];
          }
        });
        Object.keys(cfg).forEach(function (k) { delete cfg[k]; });
        Object.keys(next).forEach(function (k) { cfg[k] = next[k]; });
        return "";
      });
      if (!res.ok) return res;
      __cdbEx_log("configuration replaced from the raw editor in " + res.file);
      var after = __cdbEx_deployState();
      return { ok: true, path: res.file, expected: after.expected, source: after.source };
    },

    // Computer Use on a background display (issue #300). The executor reads the
    // key itself at every CU lock, so a write applies from the next Computer Use
    // start; these channels only persist it and serve the setup panel. All
    // probing is async (see __cdbEx_cubgExec) and runs only when asked.
    "cdb-cubg:read": function () {
      return Promise.all([__cdbEx_cubgStored(), __cdbEx_cubgStartedWith()]).then(function (both) {
        var s = both[0];
        var raw = s.raw;
        var own = __cdbEx_cubgOwn();
        return {
          ok: true,
          present: raw !== undefined || !!s.broken,
          // On as written, even when the rest is invalid: that combination is
          // the fail-closed case the page has to show, not hide. An unreadable
          // .jsonc is that case too.
          enabled: !!s.broken || !!(raw && typeof raw === "object" && raw.enabled === true),
          config: s.check && s.check.ok
            ? { enabled: s.check.value.enabled, kind: s.check.value.kind, display: s.check.value.display }
            : null,
          valid: s.check ? s.check.ok : true,
          error: s.check && !s.check.ok ? s.check.error : null,
          // Names only: the values are the user's and the page never edits them.
          envKeys: s.check && s.check.ok && s.check.value.env ? Object.keys(s.check.value.env) : [],
          lockedByJsonc: s.locked ? true : null,
          source: s.source,
          path: s.locked ? s.paths.jsonc : s.paths.json,
          own: { display: own.x11 !== null ? ":" + own.x11 : null, wayland: own.wayland },
          // {enabled, kwinMode, kdeWayland, restartOnChange}: see __cdbEx_cubgStartedWith.
          startedWith: both[1],
          note: s.note || null
        };
      }).then(null, function (e) { return { ok: false, error: (e && e.message) || String(e) }; });
    },

    // Takes {enabled, kind, display}; an empty kind/display keeps the stored
    // one, so the Community switch can flip `enabled` alone. Never takes env.
    // Claude's own display is never stored, not even switched off: a stored
    // own display that is switched off is removed instead (absent = off).
    "cdb-cubg:set": function (input) {
      if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "expected {enabled, kind, display}" };
      if (typeof input.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
      return __cdbEx_cubgStored().then(function (s) {
        if (s.locked) {
          return { ok: false, lockedByJsonc: true,
            error: s.broken ? s.broken : __cdbEx_CUBG_KEY + " is set in claude-desktop-extra.jsonc - edit that file to change it" };
        }
        var prev = s.raw && typeof s.raw === "object" && !Array.isArray(s.raw) ? s.raw : null;
        var fromInput = !!((typeof input.kind === "string" && input.kind) || (typeof input.display === "string" && input.display));
        var kind = typeof input.kind === "string" && input.kind ? input.kind : (prev ? prev.kind : undefined);
        var display = typeof input.display === "string" && input.display ? input.display : (prev ? prev.display : undefined);
        var any = kind !== undefined || display !== undefined;
        // Turning it ON must name a usable second display. Turning it OFF must
        // always work, even over a hand-broken value - it is the revert path.
        if (input.enabled) {
          if (kind !== "x11" && kind !== "wlroots") return { ok: false, error: "choose a display first" };
          if (!__cdbEx_cubgDisplayOk(kind, display)) return { ok: false, error: "not a valid " + kind + " display: " + String(display).slice(0, 80) };
        } else if (fromInput) {
          if (!__cdbEx_cubgDisplayOk(kind, display)) return { ok: false, error: "not a valid " + kind + " display: " + String(display).slice(0, 80) };
        }
        // env belongs to one display: kept for the same one, dropped on a change.
        var keepEnv = !!prev && prev.env !== undefined && prev.kind === kind && prev.display === display;
        var envDropped = !!prev && prev.env !== undefined && !keepEnv;
        var keptEnvOk = keepEnv && !__cdbEx_cubgEnvCheck(prev.env);
        var rt = (keptEnvOk && prev.env.XDG_RUNTIME_DIR) || process.env.XDG_RUNTIME_DIR || "";
        var checkable = (kind === "x11" || kind === "wlroots") && __cdbEx_cubgDisplayOk(kind, display);
        return (checkable ? __cdbEx_cubgIdentity(kind, display, rt) : Promise.resolve({ own: false })).then(function (id) {
          if (id.notSocket) return { ok: false, error: id.path + " is not a Wayland socket" };
          if (id.error) return { ok: false, error: id.error };
          var dropOwn = false;
          if (id.own) {
            if (input.enabled || fromInput) return { ok: false, own: true, error: display + " is your desktop - choose a second display" };
            dropOwn = true;
          }
          var res = __cdbEx_writeCfg(function (cfg) {
            if (!any || dropOwn) { delete cfg[__cdbEx_CUBG_KEY]; return null; }
            var out = { enabled: input.enabled, kind: kind, display: display };
            if (keepEnv) out.env = prev.env;
            cfg[__cdbEx_CUBG_KEY] = out;
            return out;
          });
          if (!res.ok) return res;
          var check = res.extra ? __cdbEx_cubgValidate(res.extra) : null;
          return {
            ok: true, path: res.path,
            config: res.extra ? { enabled: res.extra.enabled, kind: res.extra.kind, display: res.extra.display } : null,
            valid: check ? check.ok : true, error: check && !check.ok ? check.error : null,
            // The page says so: the hand-written env map was for the old display.
            envDropped: envDropped && !dropOwn,
            ownRemoved: dropOwn
          };
        });
      }).then(null, function (e) { return { ok: false, error: (e && e.message) || String(e) }; });
    },

    "cdb-cubg:candidates": function () {
      return __cdbEx_cubgCandidates().then(null, function (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      });
    },

    "cdb-cubg:probe": function (kind, display) {
      return __cdbEx_cubgProbe(kind, display).then(null, function (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      });
    },

    "cdb-cubg:thumbnail": function (kind, display) {
      return __cdbEx_cubgThumbnail(kind, display).then(null, function (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      });
    },

    // Empty kind/display = the configured display.
    "cdb-cubg:test": function (kind, display) {
      return __cdbEx_cubgTest(kind, display).then(null, function (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      });
    },

    "cdb-cubg:tools": function () {
      return __cdbEx_cubgTools().then(function (tools) { return { ok: true, tools: tools }; },
        function (e) { return { ok: false, error: (e && e.message) || String(e) }; });
    },

    // Computer Use status. No channel takes an argument (see the section above).
    // Read and icon get the sender only for its origin (1P claude.ai or the 3P
    // app://localhost window). Page arguments are dropped.
    "cdb-cu-status:read": __cdbEx_withSender(function (ev) {
      return __cdbEx_cusRead(ev && ev.sender).then(null, function (e) { return { ok: false, error: (e && e.message) || String(e) }; });
    }),
    // These get the sender (see __cdbEx_withSender): Enable parents its
    // confirmation dialog on the sender's window. Page arguments are dropped.
    "cdb-cu-status:tpm-enable": __cdbEx_withSender(function (ev) { return __cdbEx_cusTpmAction("enable", ev && ev.sender); }),
    "cdb-cu-status:tpm-disable": __cdbEx_withSender(function (ev) { return __cdbEx_cusTpmAction("disable", ev && ev.sender); }),
    "cdb-cu-status:kvm-enable": __cdbEx_withSender(function (ev) { return __cdbEx_cusKvmAction("enable", ev && ev.sender); }),
    "cdb-cu-status:kvm-disable": __cdbEx_withSender(function (ev) { return __cdbEx_cusKvmAction("disable", ev && ev.sender); }),
    "cdb-cu-status:icon": __cdbEx_withSender(function (ev) {
      return __cdbEx_cusIcon(ev && ev.sender).then(null, function (e) { return { ok: false, error: (e && e.message) || String(e) }; });
    }),
    // Settings -> Extra -> Cowork (Linux) from anywhere in the app (the header
    // icon): upstream's settings route on the sender's own view, nothing else.
    "cdb-extra:open-settings": __cdbEx_withSender(function (ev) { return __cdbEx_openSettings(ev && ev.sender); }),
    "cdb-cu-status:reset-screen-sharing": function () {
      return __cdbEx_cusReset().then(null, function (e) { return { ok: false, error: (e && e.message) || String(e) }; });
    },

    // Open one of OUR files in the desktop's default handler, or show it in the
    // file manager. `name` is a fixed location name, never a path (see
    // __cdbEx_revealTarget); "folder" is used automatically for anything that
    // does not exist yet, so the button never just fails silently.
    "cdb-extra:reveal": function (name, how) {
      var target = __cdbEx_revealTarget(String(name || ""));
      if (!target) return { ok: false, error: "unknown location" };
      var shell = _electron.shell;
      if (!shell) return { ok: false, error: "this build exposes no shell integration" };
      var isDir = false;
      var exists = false;
      try {
        var st = _fs.statSync(target);
        exists = true;
        isDir = st.isDirectory();
      } catch (e) {}
      if (exists && !isDir && how === "folder") {
        try { shell.showItemInFolder(target); } catch (e2) {
          return { ok: false, error: e2.message };
        }
        return { ok: true, opened: target, mode: "folder" };
      }
      var open = exists ? target : _path.dirname(target);
      return Promise.resolve(shell.openPath(open)).then(function (msg) {
        // openPath resolves with a NON-EMPTY string when the desktop could not
        // open it - a rejected promise is not the failure mode to watch for.
        if (msg) return { ok: false, error: msg };
        return { ok: true, opened: open, mode: open === target ? (isDir ? "folder" : "file") : "folder" };
      }, function (err) {
        return { ok: false, error: (err && err.message) || String(err) };
      });
    },

    // Prefer upstream's own relaunch primitive, captured onto globalThis by the
    // relaunch-capture sub-patch. It sets the latch that bypasses the before-quit
    // veto interceptor, stashes the relaunch args, and calls app.quit() so the 27
    // registered onQuitCleanup handlers actually run: the Cowork VM is stopped
    // rather than killed, MCP child processes are asked to shut down, and the main
    // window's geometry is persisted. Our own `app.exit(0)` emits neither
    // "before-quit" nor "will-quit", so it skips that whole pass - which is worst
    // here, because the titlebar-mode rows are what ask the user to restart.
    // Fall back to the old path when the capture did not land, so a moved upstream
    // anchor degrades to the previous behaviour instead of a dead button.
    "cdb-app:relaunch": function () {
      __cdbEx_log("relaunch requested from the Extra settings page");
      setTimeout(function () {
        var _relaunch = globalThis.__cdbRelaunchApp;
        if (typeof _relaunch === "function") {
          try {
            _relaunch();
            // The primitive is a no-op when a quit is already under way (it is
            // guarded on quitting-for-update / cleanup-running / ready-for-quit),
            // and the window only disappears once the cleanup pass starts. Say so,
            // otherwise a Restart that legitimately did nothing is indistinguishable
            // from one that silently failed.
            __cdbEx_log("relaunch handed to the app's own primitive; the window closes once quit cleanup starts");
            return;
          } catch (e) {
            __cdbEx_log("upstream relaunchApp failed, falling back: " + e.message);
          }
        } else {
          __cdbEx_log("upstream relaunchApp unavailable, using exit(0) fallback");
        }
        try { _app.relaunch(); _app.exit(0); } catch (e) { __cdbEx_log("relaunch failed: " + e.message); }
      }, 150);
      return { ok: true };
    },

    // Page-side diagnostics, deduped so a hostile or looping page cannot flood
    // the log file.
    "cdb-extra:diag": function (message) {
      var m = String(message || "").slice(0, 300);
      if (__cdbEx_diagSeen[m]) return { ok: true, deduped: true };
      if (Object.keys(__cdbEx_diagSeen).length > 40) return { ok: true, deduped: true };
      __cdbEx_diagSeen[m] = 1;
      __cdbEx_log("page: " + m);
      return { ok: true };
    }
  };

  // The setting the executor starts with, captured on "ready" (see
  // __cdbEx_cubgStartedWith). An async read of one small file, nothing else.
  if (process.platform === "linux") {
    try {
      _app.once("ready", function () {
        __cdbEx_cubgStartP = __cdbEx_cubgStored().then(null, function () { return null; });
      });
    } catch (e) {}
  }

  // The background-display channels are Linux-only: on the downstream Windows
  // build they answer a plain refusal instead of touching /proc or X sockets.
  // The tray switch too: the glyph it picks is a Linux icon.
  // And the Auto-fix ready-to-merge wake and the session-start dialog: their
  // patches only run on Linux.
  if (process.platform !== "linux") {
    Object.keys(__cdbEx_handlers).forEach(function (ch) {
      if (ch.indexOf("cdb-cubg:") === 0) {
        __cdbEx_handlers[ch] = function () { return { ok: false, error: "Computer Use on a background display is Linux only" }; };
      } else if (ch === "cdb-extra:open-settings") {
        // Extra on win32 has only Models: there is no Cowork (Linux) to open.
        __cdbEx_handlers[ch] = function () { return { ok: false, error: "Linux only" }; };
      } else if (ch.indexOf("cdb-cu-status:") === 0) {
        __cdbEx_handlers[ch] = function () { return { ok: false, error: "Computer Use status is Linux only" }; };
      } else if (ch.indexOf("cdb-cu-ask:") === 0) {
        __cdbEx_handlers[ch] = function () { return { ok: false, error: "Computer Use app approval is Linux only" }; };
      } else if (ch.indexOf("cdb-cu-esc:") === 0) {
        __cdbEx_handlers[ch] = function () { return { ok: false, error: "Escape stops Computer Use is Linux only" }; };
      } else if (ch.indexOf("cdb-cu-ax:") === 0) {
        __cdbEx_handlers[ch] = function () { return { ok: false, error: "Computer Use app controls are Linux only" }; };
      } else if (ch.indexOf("cdb-autofix-author:") === 0) {
        __cdbEx_handlers[ch] = function () { return { ok: false, error: "the Auto-fix author option is Linux only" }; };
      } else if (ch.indexOf("cdb-tray:") === 0) {
        __cdbEx_handlers[ch] = function () { return { ok: false, error: "the tray icon switch is Linux only" }; };
      } else if (ch.indexOf("cdb-archive-grace:") === 0) {
        __cdbEx_handlers[ch] = function () { return { ok: false, error: "the PR archive delay is Linux only" }; };
      } else if (ch.indexOf("cdb-autofix-merge-ready:") === 0) {
        __cdbEx_handlers[ch] = function () { return { ok: false, error: "the Auto-fix ready-to-merge wake is Linux only" }; };
      } else if (ch.indexOf("cdb-session-start:") === 0) {
        __cdbEx_handlers[ch] = function () { return { ok: false, error: "the session-start dialog is Linux only" }; };
      }
    });
  }

  // removeHandler first, so re-evaluating this module replaces the handlers
  // instead of throwing.
  try {
    if (_ipc) {
      Object.keys(__cdbEx_handlers).forEach(function (ch) {
        try { _ipc.removeHandler(ch); } catch (e) {}
        _ipc.handle(ch, __cdbEx_guard(__cdbEx_handlers[ch]));
      });
    } else {
      __cdbEx_log("ipcMain unavailable; the Extra settings page cannot be served");
    }
  } catch (e) {
    __cdbEx_log("IPC registration failed: " + e.message);
  }

  // --- page installation ---------------------------------------------------
  // insertCSS is scoped to the document that is live when it runs, so the sheet
  // is re-inserted on every dom-ready: a full navigation (the SSO /login round
  // trip is the usual one) replaces the document and would otherwise leave the
  // Extra panel unstyled for the rest of the process. The key from the previous
  // document is dropped first so sheets cannot stack. The page script is
  // idempotent on its own side and re-runs the same way.
  //
  // webContents -> the insertCSS key we inserted last (null = nothing inserted).
  var __cdbEx_cssKeys = new WeakMap();

  function __cdbEx_styleOne(wc) {
    try {
      if (wc.isDestroyed()) return;
      var old = __cdbEx_cssKeys.get(wc);
      __cdbEx_cssKeys.set(wc, null);
      // removeInsertedCSS is a silent no-op for a key whose document is gone -
      // measured on Electron 44.3.0, it resolves even for a key that was never
      // issued, so a resolve is no evidence anything was removed and the catch
      // below is defensive only. Dropping the key still matters: the key is a
      // per-webContents counter that keeps climbing across documents, so a
      // long-lived webContents would otherwise accumulate entries.
      if (old) {
        var r = wc.removeInsertedCSS(old);
        if (r && r.catch) r.catch(function () {});
      }
      var q = wc.insertCSS(__cdbEx_pageCss);
      if (q && q.then) q.then(function (k) {
        if (!wc.isDestroyed()) __cdbEx_cssKeys.set(wc, k);
      }, function (err) {
        __cdbEx_log("insertCSS rejected: " + ((err && err.message) || String(err)));
      });
    } catch (e) {
      __cdbEx_log("insertCSS error: " + e.message);
    }
  }

  _app.on("web-contents-created", function (_ev, wc) {
    wc.on("dom-ready", function () {
      try {
        var url = wc.getURL() || "";
        // The same exact-origin list as the IPC guard: claude.ai in 1P,
        // app://localhost in 3P. Upstream's 3P setup window lives on
        // app://localhost too but has no settings dialog, so it is skipped.
        if (!__cdbEx_originAllowed(url)) return;
        if (/^app:\/\/localhost\/setup-desktop-3p(?:[\/?#]|$)/i.test(url)) return;
        __cdbEx_styleOne(wc);
        wc.executeJavaScript(__cdbEx_pageSrc).then(function (status) {
          // Deduped: every OAuth popup and helper view reports "skipped", and a
          // line per navigation would be noise.
          var line = String(status || "");
          if (!line || __cdbEx_diagSeen[line]) return;
          __cdbEx_diagSeen[line] = 1;
          __cdbEx_log(line);
        }, function (err) {
          __cdbEx_log("page script failed: " + ((err && err.message) || String(err)));
        });
      } catch (e) {
        __cdbEx_log("dom-ready hook error: " + e.message);
      }
    });
  });

  __cdbEx_log("Extra settings area armed [" + __cdbEx_marker + "]");
})();
