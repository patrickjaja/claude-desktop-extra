;/*__CDB_JIRA_TRACKER__*/(function () {
  "use strict";
  if (typeof process === "undefined" || process.platform !== "linux") return;
  if (globalThis.__cdbJiraTrackerMain) return;
  globalThis.__cdbJiraTrackerMain = true;

  var _e = require("electron");
  var _fs = require("fs"), _path = require("path"), _crypto = require("crypto"), _cp = require("child_process");
  var SOURCES = { html: "__CDB_JIRA_PAGE_HTML__", page: "__CDB_JIRA_PAGE_JS__", adf: "__CDB_JIRA_ADF_SRC__", preload: "__CDB_JIRA_PRELOAD__" };
  var WEB_SRC = "__CDB_JIRA_WEB_SRC__";
  var SHORTCUT_KEY = "j";
  var KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/, PROJECT_RE = /^[A-Z][A-Z0-9_]+$/, ID_RE = /^\d{1,12}$/, PAGE_TOKEN_RE = /^[\x21-\x7e]{1,4096}$/;
  var PRESETS = {
    assigned: { label: "Assigned to me, not done", jql: "assignee = currentUser() AND statusCategory != Done" },
    reported: { label: "Reported by me, not done", jql: "reporter = currentUser() AND statusCategory != Done" }
  };
  var MAX_JQL = 2000, PREF_TTL_MS = 1000;
  var SETUP_3P = /^app:\/\/localhost\/setup-desktop-3p(?:[\/?#]|$)/i;
  var INJECT_TRIES = 10;

  var logQueue = [];
  function emit(line) { try { (globalThis.__cdbDiag || function () {})(line); } catch (e) {} }
  function log(m) {
    var line = "[cdb-jira] " + m;
    if (logQueue && typeof globalThis.__cdbDiag !== "function") { logQueue.push(line); return; }
    if (logQueue) { var q = logQueue; logQueue = null; q.forEach(emit); }
    emit(line);
  }
  function noop() {}
  function isObj(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
  function bad(what) { return { ok: false, error: "bad " + what }; }

  var adf = globalThis.__cdbJiraAdf, prompt = globalThis.__cdbJiraPrompt;
  var userData = function () { return _e.app.getPath("userData"); };
  var store = globalThis.__cdbJiraStoreFactory({ fs: _fs, path: _path, safeStorage: _e.safeStorage, userData: userData, log: log });
  var client = globalThis.__cdbJiraClientFactory({ fetch: function (u, i) { return globalThis.fetch(u, i); }, log: function (m) { log("http " + m); },
    saveRoute: function (r, id) { store.saveRoute(r, id); } });
  var pref = { at: 0, on: false };
  function enabled() {
    var now = Date.now();
    if (now - pref.at > PREF_TTL_MS) { try { pref.on = store.prefRead().enabled === true; } catch (e) { pref.on = false; } pref.at = now; }
    return pref.on;
  }
  var THEME_JS = "(function(){var d=document.documentElement,c=getComputedStyle(d),b=document.body?getComputedStyle(document.body):c,v={},n=0;" +
    "for(var i=0;i<c.length&&n<4000;i++){var k=c[i];if(k.indexOf('--cds-')===0){v[k]=c.getPropertyValue(k).trim();n++;}}" +
    "return{vars:v,scheme:c.colorScheme||'',font:b.fontFamily||'',bg:b.backgroundColor||'',fg:b.color||''};})()";
  var THEME_BAD = /url\(|expression\(|[;{}\\<>]/i, THEME_NAME = /^--cds-[A-Za-z0-9_-]{1,120}$/, THEME_MAX_NAMES = 2000, THEME_MAX_BYTES = 131072;
  var themePushed = { id: -1, hash: "" }, themeCapLogged = false;
  function themeValue(v) { return typeof v === "string" && v.length <= 200 && !THEME_BAD.test(v) ? v : null; }
  function themeClean(raw) {
    if (!isObj(raw)) return null;
    var vars = isObj(raw.vars) ? raw.vars : {}, out = { vars: {} }, size = 0, n = 0, capped = false;
    Object.keys(vars).forEach(function (k) {
      var v = THEME_NAME.test(k) ? themeValue(vars[k]) : null;
      if (v === null) return;
      if (n >= THEME_MAX_NAMES || size + k.length + v.length + 6 > THEME_MAX_BYTES) { capped = true; return; }
      out.vars[k] = v; n++; size += k.length + v.length + 6;
    });
    ["scheme", "font", "bg", "fg"].forEach(function (k) { var v = themeValue(raw[k]); out[k] = v === null ? "" : v; });
    if (capped && !themeCapLogged) { themeCapLogged = true; log("theme: capped at " + n + " values"); }
    return out;
  }
  function readTheme() {
    var wc = view.claudeContents();
    if (!wc) return Promise.resolve(null);
    return webCall(wc, THEME_JS).then(themeClean, function () { return null; });
  }
  function themeHash(theme) { return _crypto.createHash("sha256").update(JSON.stringify(theme)).digest("hex"); }
  function pushTheme() {
    if (!enabled()) return;
    readTheme().then(function (theme) {
      var t = view.trackerContents();
      if (!theme || !t) return;
      var h = themeHash(theme);
      if (themePushed.id === t.id && themePushed.hash === h) return;
      themePushed = { id: t.id, hash: h };
      try { t.send("cdb-jira:theme", theme); } catch (e) {}
    });
  }
  var THEME_POLL_MS = 1000, themeWatch = 0;
  // Custom themes and claude.ai's own appearance switch send no event, so the open page re-reads the theme.
  function watchTheme() {
    if (themeWatch) return;
    themeWatch = setTimeout(function () {
      themeWatch = 0;
      if (!view.isOpen() || !enabled()) return;
      pushTheme();
      watchTheme();
    }, THEME_POLL_MS);
  }
  var view = globalThis.__cdbJiraViewFactory({ electron: _e, fs: _fs, path: _path, crypto: _crypto, userData: userData, sources: SOURCES, log: log,
    onFocus: pushTheme, onKey: onKey, remeasure: function (wc) { return webCall(wc, "window.__cdbJiraWeb?window.__cdbJiraWeb.rect():null"); }, onHidden: function () { webCall(view.claudeContents(), "window.__cdbJiraWeb&&window.__cdbJiraWeb.setActive(false)"); } });
  var sender = globalThis.__cdbJiraSendFactory({ store: store, client: client, adf: adf, prompt: prompt, fs: _fs, dialog: _e.dialog, log: log,
    window: function () { return view.hostWindow(); }, enabled: enabled,
    gitWorkTree: function (folder) { return globalThis.__cdbJiraIsGitWorkTree(_cp.execFile, folder); },
    getManager: function () {
      var get = globalThis.__cdbJiraSessions;
      return typeof get === "function" ? Promise.resolve().then(get).catch(function () { return null; }) : Promise.resolve(null);
    },
    closeTracker: function () { view.close("sent"); }, navigate: navigate, notify: notify });

  var openedPath = "";
  function pathOf(url) {
    try { var u = new URL(String(url)); return u.protocol + "//" + u.host + u.pathname; } catch (e) { return ""; }
  }
  var lastRoute = "";
  function routeOf(url) { try { var u = new URL(String(url)); return u.pathname + u.search + u.hash; } catch (e) { return ""; } }
  function inSettings(url) { try { return /^\/settings(\/|$)/.test(new URL(String(url)).pathname); } catch (e) { return false; } }
  function noteRoute(wc, url) { if (!inSettings(url) && routeOf(url) && mainView(wc)) lastRoute = routeOf(url); }
  function leaveSettings(wc) {
    var nav = globalThis.__cdbNavigation, d = null;
    try { d = nav && typeof nav.getDispatcher === "function" ? nav.getDispatcher(wc) : null; } catch (e) { d = null; }
    if (!d || typeof d.dispatchNavigate !== "function") { log("navigate: no dispatcher"); return Promise.resolve(); }
    try { d.dispatchNavigate(lastRoute || "/epitaxy"); } catch (e) { return Promise.resolve(); }
    return new Promise(function (resolve) {
      var tries = 0;
      (function wait() {
        if (wc.isDestroyed() || !inSettings(wc.getURL()) || ++tries > 30) { resolve(); return; }
        setTimeout(wait, 100);
      })();
    });
  }
  function openFor(wc, rect) {
    if (!wc.isDestroyed() && inSettings(wc.getURL())) return leaveSettings(wc).then(function () { return openNow(wc, rect); });
    return openNow(wc, rect);
  }
  function openNow(wc, rect) {
    var r = view.open(wc, rect);
    if (r.ok) { openedPath = pathOf(wc.getURL()); pushTheme(); watchTheme(); }
    return r;
  }
  function webCall(wc, code) {
    try { if (wc && !wc.isDestroyed()) return wc.executeJavaScript(code).catch(function () { return null; }); } catch (e) {}
    return Promise.resolve(null);
  }
  function mainView(wc) {
    var g = globalThis.__cdbSenderGuard;
    try { return !!wc && !wc.isDestroyed() && !!g && g.originAllowed(wc.getURL() || "") && !SETUP_3P.test(wc.getURL() || "") && !!view.hostOf(wc); }
    catch (e) { return false; }
  }
  function originOk(wc) {
    var g = globalThis.__cdbSenderGuard;
    try { return !!g && g.originAllowed(wc.getURL() || ""); } catch (e) { return false; }
  }
  function okClaude(ev) { var g = globalThis.__cdbSenderGuard; return !!g && g.okSender(ev) && mainView(ev.sender); }
  function okPref(ev) { var g = globalThis.__cdbSenderGuard; return !!g && g.okSender(ev); }
  function okTracker(ev) { return !!ev && view.isTracker(ev.sender) && !(ev.senderFrame && ev.senderFrame.parent); }
  function navigate(route) {
    var nav = globalThis.__cdbNavigation, wc = view.claudeContents(), d = null;
    try { d = nav && wc && typeof nav.getDispatcher === "function" ? nav.getDispatcher(wc) : null; } catch (e) { d = null; }
    if (!d || typeof d.dispatchNavigate !== "function") { log("navigate: no dispatcher"); return false; }
    try { d.dispatchNavigate(route); return true; } catch (e) { return false; }
  }
  function notify(text) {
    try { if (_e.Notification && _e.Notification.isSupported()) new _e.Notification({ title: "Jira", body: text }).show(); } catch (e) {}
  }
  var ROW_CSS = '[data-testid="sidebar"] .cdb-jira-row-active{background:var(--cds-fill-ghost-hover,rgba(127,127,127,.14));color:var(--cds-text-primary,currentColor)}';
  var rowCss = new WeakMap();
  function dropRowCss(wc) {
    var old = rowCss.get(wc);
    rowCss.delete(wc);
    if (old) old.then(function (key) { if (key && !wc.isDestroyed()) return wc.removeInsertedCSS(key); }).catch(function () {});
  }
  function injectRow(wc) {
    dropRowCss(wc);
    try { var p = Promise.resolve(wc.insertCSS(ROW_CSS)); p.catch(function () {}); rowCss.set(wc, p); } catch (e) {}
    webCall(wc, WEB_SRC);
  }
  function injectWhenAttached(wc, tries) {
    if (wc.isDestroyed() || !enabled()) return;
    if (mainView(wc)) { injectRow(wc); return; }
    if (tries > 0 && originOk(wc)) setTimeout(function () { injectWhenAttached(wc, tries - 1); }, 500);
  }
  function eachMainView(fn) {
    try { _e.webContents.getAllWebContents().forEach(function (wc) { if (mainView(wc)) fn(wc); }); } catch (e) {}
  }
  function applySwitch(on) {
    pref.at = 0;
    if (on) { eachMainView(injectRow); return; }
    view.destroy();
    eachMainView(function (wc) { dropRowCss(wc); webCall(wc, "window.__cdbJiraWeb&&window.__cdbJiraWeb.remove()"); });
  }
  function onKey(wc, ev, input) {
    if (!input || input.type !== "keyDown" || !input.control || !input.shift || input.alt || input.meta) return;
    if (String(input.key || "").toLowerCase() !== SHORTCUT_KEY || !enabled()) return;
    if (view.isTracker(wc)) { ev.preventDefault(); view.close("shortcut"); return; }
    if (!mainView(wc)) return;
    ev.preventDefault();
    if (view.isOpen()) { view.close("shortcut"); return; }
    webCall(wc, "window.__cdbJiraWeb?window.__cdbJiraWeb.open():false").then(function (handled) {
      if (handled !== true) openFor(wc, view.fullRect(wc));
    });
  }
  function jqlFor(q) {
    if (!isObj(q)) return null;
    var withSort = globalThis.__cdbJiraClientFactory.withSort, sorts = globalThis.__cdbJiraClientFactory.SORTS;
    if (q.sort !== undefined && sorts.indexOf(q.sort) < 0) return null;
    if (typeof q.jql === "string") { var j = q.jql.trim(); return j && j.length <= MAX_JQL ? (q.sort ? withSort(j, q.sort) : j) : null; }
    var preset = PRESETS[q.preset];
    if (!preset) return null;
    var project = q.project === undefined ? "" : q.project;
    if (project !== "" && !PROJECT_RE.test(project)) return null;
    return withSort((project ? "project = " + project + " AND " : "") + preset.jql, q.sort || "updated");
  }
  var sprintWarned = false, agileWarned = false, AGILE_TTL_MS = 600000, boardCache = {}, sprintCache = {}, backlogRefused = {}, configCache = {}, configWarned = false, statusCache = {};
  var CATEGORY_RANK = { todo: 0, inprogress: 1, done: 2 };
  function statusColumns(c, res) {
    var projects = [];
    res.records.forEach(function (r) { if (PROJECT_RE.test(r.project) && projects.indexOf(r.project) < 0) projects.push(r.project); });
    res.statusColumns = {};
    return Promise.all(projects.map(function (p) {
      return cached(statusCache, p, function () { return client.projectStatuses(c, p); }).then(function (s) {
        if (!s.ok) return;
        var types = res.records.filter(function (r) { return r.project === p; }).map(function (r) { return r.type; });
        var pick = s.types.filter(function (t) { return types.indexOf(t.type) >= 0; });
        var seen = {}, cols = [];
        (pick.length ? pick : s.types).forEach(function (t) { t.statuses.forEach(function (x) { if (!seen[x.id]) { seen[x.id] = true; cols.push(x); } }); });
        cols.sort(function (a, b) { return (CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category]) || a.name.localeCompare(b.name); });
        if (cols.length) res.statusColumns[p] = cols.map(function (x) { return { name: x.name, statusIds: [x.id] }; });
      });
    }));
  }
  function cached(map, key, make) {
    var hit = map[key];
    if (hit && Date.now() - hit.at < AGILE_TTL_MS) return hit.p;
    var p = make().then(function (r) {
      if (!r.ok && (r.kind === "unavailable" || r.kind === "busy")) delete map[key];
      return r;
    });
    map[key] = { at: Date.now(), p: p };
    return p;
  }
  function boardsFor(c, project) { return cached(boardCache, project, function () { return client.boards(c, project); }); }
  function sprintFor(c, board) { return cached(sprintCache, String(board), function () { return client.activeSprint(c, board); }).then(function (r) { return r.ok ? r.id : 0; }); }
  function refusal(r) { return String(r.status || r.kind) + (r.detail ? " " + r.detail : ""); }
  function backlogFor(c, board, keys) {
    var hit = backlogRefused[board];
    if (hit && Date.now() - hit.at < AGILE_TTL_MS) return Promise.resolve(hit.r);
    return client.backlogKeys(c, board, keys).then(function (r) {
      if (!r.ok && r.kind !== "unavailable" && r.kind !== "busy") backlogRefused[board] = { at: Date.now(), r: r };
      return r;
    });
  }
  function configFor(c, board) {
    return cached(configCache, String(board), function () { return client.boardConfig(c, board); }).then(function (r) {
      if (!r.ok && !configWarned) { configWarned = true; log("board: configuration unavailable " + refusal(r)); }
      return r.ok ? r.columns : null;
    });
  }
  function chosenBoard(project, boards) {
    var id = store.state().boards[project];
    return boards.filter(function (b) { return b.id === id; })[0] || boards[0];
  }
  function grouped(c, res) {
    return statusColumns(c, res).then(function () { return agileGrouped(c, res); });
  }
  function agileGrouped(c, res) {
    var projects = [];
    res.records.forEach(function (r) { if (PROJECT_RE.test(r.project) && projects.indexOf(r.project) < 0) projects.push(r.project); });
    if (res.records.some(function (r) { return !PROJECT_RE.test(r.project); })) projects.push("");
    return Promise.all(projects.map(function (p) {
      if (!p) return { fail: "no project" };
      return boardsFor(c, p).then(function (b) {
        if (!b.ok || !b.boards.length) return { fail: b.ok ? "no board" : refusal(b) };
        var board = chosenBoard(p, b.boards);
        var keys = res.records.filter(function (r) { return r.project === p; }).map(function (r) { return r.key; });
        return Promise.all([backlogFor(c, board.id, keys), board.type === "scrum" ? sprintFor(c, board.id) : 0, configFor(c, board.id)]).then(function (x) {
          if (!x[0].ok) return { fail: refusal(x[0]) };
          res.records.forEach(function (r) { if (r.project === p) { r.place = x[0].keys.indexOf(r.key) >= 0 ? "backlog" : "board"; r.boardId = board.id; } });
          var info = { current: board, all: b.boards, noSprint: board.type === "scrum" && !x[1] };
          if (x[2]) info.columns = x[2];
          return { project: p, info: info };
        });
      });
    })).then(function (outs) {
      res.boards = {};
      var failed = [];
      outs.forEach(function (o) { if (o.fail) failed.push(o.fail); else res.boards[o.project] = o.info; });
      if (!failed.length) { res.groups = "agile"; return res; }
      if (!agileWarned) { agileWarned = true; log("groups: agile unavailable " + failed.filter(function (f, i, a) { return a.indexOf(f) === i; }).join(",")); }
      res.agileNotice = true;
      return sprintGrouped(c, res);
    });
  }
  function moveIssue(c, a) {
    return boardsFor(c, a.key.slice(0, a.key.lastIndexOf("-"))).then(function (b) {
      var board = b.ok ? b.boards.filter(function (x) { return x.id === a.boardId; })[0] : null;
      if (!board) return b.ok ? { ok: false, error: "That board is not one of the project's boards." } : b;
      var go = a.to === "backlog" ? client.moveToBacklog(c, board, a.key)
        : board.type === "scrum" ? sprintFor(c, board.id).then(function (sid) { return client.moveToBoard(c, board, a.key, sid); })
        : client.moveToBoard(c, board, a.key);
      return go.then(function (r) { return r.ok ? verifyPlace(c, board.id, a.key, a.to, 0) : r; });
    });
  }
  var MOVE_RETRY_MS = [400, 800, 1600, 3200];
  function verifyPlace(c, boardId, key, want, attempt) {
    return client.backlogKeys(c, boardId, [key]).then(function (bl) {
      if (!bl.ok) return bl;
      var place = bl.keys.indexOf(key) >= 0 ? "backlog" : "board";
      if (place === want) return { ok: true, place: place };
      // Jira's backlog read can lag a move by a few hundred ms.
      if (attempt < MOVE_RETRY_MS.length) return new Promise(function (res) { setTimeout(res, MOVE_RETRY_MS[attempt]); }).then(function () { return verifyPlace(c, boardId, key, want, attempt + 1); });
      return { ok: false, place: place, message: "Jira accepted the move but the ticket did not move." };
    });
  }
  function sprintGrouped(c, res) {
    return client.sprintKeys(c, res.records.map(function (r) { return r.key; })).then(function (s) {
      if (!s || !s.ok) {
        if (!sprintWarned) { sprintWarned = true; log("groups: sprint unavailable"); }
        res.groups = "category";
        return res;
      }
      res.groups = "sprint";
      res.records.forEach(function (r) { r.sprint = s.keys.indexOf(r.key) >= 0; });
      return res;
    });
  }
  var MB = 1048576, IMAGE_MAX = 10 * MB, VIDEO_MAX = 50 * MB, DOWNLOAD_MAX = 200 * MB, CACHE_MAX = 50 * MB, ATTACHMENT_RE = /^\d{1,20}$/;
  var INLINE = { "image/png": "image", "image/jpeg": "image", "image/gif": "image", "image/webp": "image", "video/mp4": "video", "video/webm": "video" };
  var openFiles = { key: "", byId: {} }, mediaCache = new Map(), mediaBytes = 0, mediaWarned = false;
  function rememberFiles(key, res) {
    var byId = {};
    if (res && res.ok && res.record && Array.isArray(res.record.attachments)) res.record.attachments.forEach(function (a) { byId[a.id] = a; });
    openFiles = { key: key, byId: byId };
    return res;
  }
  function ownedFile(a) {
    if (!isObj(a) || !KEY_RE.test(String(a.key)) || !ATTACHMENT_RE.test(String(a.id))) return { bad: true };
    var meta = openFiles.key === a.key ? openFiles.byId[a.id] : null;
    return meta ? { meta: meta } : { error: { ok: false, error: "That file is not an attachment of the open ticket." } };
  }
  function cacheGet(k) { var v = mediaCache.get(k); if (v) { mediaCache.delete(k); mediaCache.set(k, v); } return v; }
  function cachePut(k, v) {
    if (v.bytes.length > CACHE_MAX) return;
    mediaCache.set(k, v);
    mediaBytes += v.bytes.length;
    mediaCache.forEach(function (x, key) { if (mediaBytes > CACHE_MAX && key !== k) { mediaCache.delete(key); mediaBytes -= x.bytes.length; } });
  }
  function mediaFailed(r) {
    if (r && r.kind === "redirect" && !mediaWarned) { mediaWarned = true; log("media: redirect refused"); }
    return r;
  }
  function safeName(name) {
    var base = String(name || "").split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f<>:"|?*]/g, "_").replace(/^[\s.]+|[\s.]+$/g, "");
    if (base.length > 150) { var dot = base.lastIndexOf("."), ext = dot > 0 && base.length - dot <= 16 ? base.slice(dot) : ""; base = base.slice(0, 150 - ext.length) + ext; }
    return base || "attachment";
  }
  function saveUnique(dir, name, bytes) {
    var dot = name.lastIndexOf("."), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
    for (var i = 0; i < 1000; i++) {
      var file = i ? stem + " (" + i + ")" + ext : name, full = _path.join(dir, file);
      try { _fs.writeFileSync(full, bytes, { flag: "wx", mode: 420 }); return { name: file, path: full }; }
      catch (e) { if (!e || e.code !== "EEXIST") return null; }
    }
    return null;
  }
  function creds() { return store.creds(); }
  function notSetUp() { return { ok: false, kind: "config", message: "Jira is not set up. Add the site, email and API token in Settings." }; }
  function prefView() {
    var p = store.prefRead(), c = store.credsView();
    return { ok: true, enabled: p.enabled, locked: p.locked, site: c.site, email: c.email, tokenSet: c.tokenSet, keyringOk: c.keyringOk,
      keyringBackend: c.keyringBackend, template: store.state().template, defaultTemplate: prompt.DEFAULT_TEMPLATE };
  }

  var CLAUDE = {
    "cdb-jira:open": function (ev, rect) { return openFor(ev.sender, rect); },
    "cdb-jira:close": function () { return view.close("web"); },
    "cdb-jira:bounds": function (ev, rect) { return view.bounds(ev.sender, rect); }
  };
  var PREF = {
    "cdb-jira-pref:read": function () { return prefView(); },
    "cdb-jira-pref:set": function (ev, fields) {
      if (!isObj(fields)) return bad("settings");
      if (fields.enabled !== undefined) {
        if (typeof fields.enabled !== "boolean") return bad("switch value");
        var w = store.prefWrite(fields.enabled);
        if (!w.ok) return w;
        applySwitch(fields.enabled);
      }
      var c = {};
      ["site", "email", "token"].forEach(function (k) { if (fields[k] !== undefined) c[k] = fields[k]; });
      if (Object.keys(c).length) { var r = store.credsSave(c); if (!r.ok) return r; }
      if (fields.template !== undefined) { var t = store.stateWrite({ template: fields.template }); if (!t.ok) return t; }
      return prefView();
    },
    "cdb-jira-pref:test": function () {
      if (!enabled()) return { ok: false, error: "Switch the Jira tracker on first." };
      var c = creds();
      if (!c) return { ok: false, error: "Save the site, email and API token first." };
      return client.myself(c).then(function (r) { return r.ok ? { ok: true, displayName: r.displayName } : { ok: false, error: r.message }; });
    }
  };
  var TRACKER = {
    "cdb-jira:state": function () {
      var s = store.state(), c = store.credsView();
      return { ok: true, configured: !!creds(), site: c.site, lastPreset: s.lastPreset, project: s.project, sort: s.sort, detailsOpen: s.detailsOpen, queries: s.queries,
        presets: Object.keys(PRESETS).map(function (k) { return { id: k, label: PRESETS[k].label }; }) };
    },
    "cdb-jira:projects": function () { var c = creds(); return c ? client.projects(c) : notSetUp(); },
    "cdb-jira:search": function (ev, q, page) {
      var jql = jqlFor(q);
      if (!jql) return bad("query");
      if (page !== undefined && page !== "" && !(typeof page === "string" && PAGE_TOKEN_RE.test(page))) return bad("page token");
      var c = creds();
      if (!c) return notSetUp();
      if (q.preset) store.stateWrite({ lastPreset: q.preset, project: q.project || "" });
      if (q.sort) store.stateWrite({ sort: q.sort });
      return client.search(c, jql, page || "").then(function (res) { return res && res.ok ? grouped(c, res) : res; });
    },
    "cdb-jira:children": function (ev, a) {
      if (!isObj(a) || !Array.isArray(a.keys) || !a.keys.length || a.keys.length > 50 || !a.keys.every(function (k) { return typeof k === "string" && KEY_RE.test(k); })) return bad("subtask keys");
      var c = creds();
      return c ? client.children(c, a.keys) : notSetUp();
    },
    "cdb-jira:drop": function (ev, a) {
      if (!isObj(a) || !KEY_RE.test(String(a.key)) || !Array.isArray(a.statusIds) || !a.statusIds.length || a.statusIds.length > 50 || !a.statusIds.every(function (x) { return typeof x === "string" && ID_RE.test(x); })) return bad("drop");
      if (a.transitionId !== "" && !(typeof a.transitionId === "string" && ID_RE.test(a.transitionId))) return bad("drop");
      var c = creds();
      return c ? client.drop(c, a.key, a.statusIds, a.transitionId) : notSetUp();
    },
    "cdb-jira:move": function (ev, a) {
      if (!isObj(a) || !KEY_RE.test(String(a.key)) || (a.to !== "board" && a.to !== "backlog") || typeof a.boardId !== "number" || !(a.boardId > 0) || Math.floor(a.boardId) !== a.boardId) return bad("move");
      var c = creds();
      return c ? moveIssue(c, a) : notSetUp();
    },
    "cdb-jira:board": function (ev, a) {
      if (!isObj(a) || !PROJECT_RE.test(String(a.project)) || typeof a.boardId !== "number") return bad("board choice");
      var r = store.stateWrite({ board: { project: a.project, id: a.boardId } });
      return r.ok ? { ok: true } : bad("board choice");
    },
    "cdb-jira:cover": function () { return { ok: true, full: view.isFullCover() }; },
    "cdb-jira:details": function (ev, a) {
      if (!isObj(a) || typeof a.open !== "boolean") return bad("details state");
      var r = store.stateWrite({ detailsOpen: a.open });
      return r.ok ? { ok: true } : r;
    },
    "cdb-jira:issue": function (ev, a) {
      if (!isObj(a) || !KEY_RE.test(String(a.key))) return bad("issue key");
      var c = creds();
      if (!c) return notSetUp();
      openFiles = { key: "", byId: {} };
      return client.issue(c, a.key).then(function (res) { return rememberFiles(a.key, res); });
    },
    "cdb-jira:attachment": function (ev, a) {
      var o = ownedFile(a);
      if (o.bad || (a.thumb !== undefined && typeof a.thumb !== "boolean")) return bad("attachment");
      if (o.error) return o.error;
      var thumb = a.thumb === true, kind = INLINE[String(o.meta.mimeType).toLowerCase()];
      if (thumb ? !o.meta.thumbnail : !kind) return { ok: false, error: "This file is not shown inline." };
      var cap = !thumb && kind === "video" ? VIDEO_MAX : IMAGE_MAX;
      if (!thumb && o.meta.size > cap) return { ok: false, kind: "tooBig", error: "This file is too large to show here." };
      var ck = a.id + (thumb ? ":thumb" : ""), hit = cacheGet(ck);
      if (hit) return { ok: true, mime: hit.mime, bytes: hit.bytes };
      var c = creds();
      if (!c) return notSetUp();
      return client.attachmentBytes(c, a.id, thumb, cap).then(function (r) {
        if (!r.ok) return mediaFailed(r);
        var mime = thumb ? String(r.type || "").split(";")[0].trim().toLowerCase() : String(o.meta.mimeType).toLowerCase();
        if (INLINE[mime] !== (thumb ? "image" : kind)) return { ok: false, error: "This file is not shown inline." };
        var bytes = new Uint8Array(r.bytes.buffer, r.bytes.byteOffset, r.bytes.length);
        cachePut(ck, { mime: mime, bytes: bytes });
        return { ok: true, mime: mime, bytes: bytes };
      });
    },
    "cdb-jira:download": function (ev, a) {
      var o = ownedFile(a);
      if (o.bad) return bad("attachment");
      if (o.error) return o.error;
      if (o.meta.size > DOWNLOAD_MAX) return { ok: false, kind: "tooBig", error: "This file is larger than 200 MB. Open it in Jira." };
      var c = creds();
      if (!c) return notSetUp();
      return client.attachmentBytes(c, a.id, false, DOWNLOAD_MAX).then(function (r) {
        if (!r.ok) return mediaFailed(r);
        var saved = saveUnique(_e.app.getPath("downloads"), safeName(o.meta.filename), r.bytes);
        if (!saved) { log("download: could not write the file"); return { ok: false, error: "Could not save the file to Downloads." }; }
        log("download: saved");
        try { _e.shell.showItemInFolder(saved.path); } catch (e) {}
        return { ok: true, name: saved.name };
      });
    },
    "cdb-jira:transitions": function (ev, a) {
      if (!isObj(a) || !KEY_RE.test(String(a.key))) return bad("issue key");
      var c = creds();
      return c ? client.transitions(c, a.key) : notSetUp();
    },
    "cdb-jira:transition": function (ev, a) {
      if (!isObj(a) || !KEY_RE.test(String(a.key)) || !ID_RE.test(String(a.id))) return bad("transition");
      var c = creds();
      return c ? client.transition(c, a.key, a.id) : notSetUp();
    },
    "cdb-jira:send": function (ev, a) {
      if (!isObj(a) || !KEY_RE.test(String(a.key)) || a.action !== "implement") return bad("send request");
      return sender.send({ key: a.key, action: a.action });
    },
    "cdb-jira:open-external": function (ev, a) {
      if (!isObj(a)) return bad("link");
      var url = "";
      if (a.key !== undefined) {
        var site = store.credsView().site;
        if (!KEY_RE.test(String(a.key)) || !site) return bad("issue key");
        url = site + "/browse/" + a.key;
      } else url = adf.safeHref(a.url);
      if (!url) return bad("link");
      return Promise.resolve(_e.shell.openExternal(url)).then(function () { return { ok: true }; }, function () { return { ok: false, error: "could not open the link" }; });
    },
    "cdb-jira:hide": function () { return view.close("page"); },
    "cdb-jira:theme": function (ev) {
      return readTheme().then(function (theme) {
        if (!theme) return { ok: false, error: "no theme" };
        var t = ev && ev.sender;
        if (t) themePushed = { id: t.id, hash: themeHash(theme) };
        return { ok: true, theme: theme };
      });
    },
    "cdb-jira:open-settings": function () {
      var wc = view.claudeContents();
      view.close("settings");
      webCall(wc, "window.__cdbExtraOpen&&window.__cdbExtraOpen(\"features\")");
      return { ok: true };
    },
    "cdb-jira:query-save": function (ev, a) {
      if (!isObj(a)) return bad("query");
      var r = store.stateWrite({ saveQuery: { name: a.name, jql: a.jql } });
      return r.ok ? { ok: true, queries: r.state.queries } : r;
    },
    "cdb-jira:query-delete": function (ev, a) {
      if (!isObj(a) || typeof a.name !== "string") return bad("query");
      var r = store.stateWrite({ deleteQuery: a.name });
      return r.ok ? { ok: true, queries: r.state.queries } : r;
    }
  };

  function register(map, check, needsOn) {
    Object.keys(map).forEach(function (ch) {
      try { _e.ipcMain.removeHandler(ch); } catch (e) {}
      _e.ipcMain.handle(ch, function (ev) {
        if (!check(ev)) return { ok: false, error: "rejected: unrecognized sender" };
        if (needsOn && !enabled()) return { ok: false, error: "The Jira tracker is switched off." };
        try {
          return Promise.resolve(map[ch].apply(null, arguments)).catch(function (e) { log(ch + " failed (" + ((e && e.name) || "Error") + ")"); return { ok: false, error: "internal error" }; });
        } catch (e) { log(ch + " failed (" + ((e && e.name) || "Error") + ")"); return { ok: false, error: "internal error" }; }
      });
    });
  }
  try { if (_e.nativeTheme && typeof _e.nativeTheme.on === "function") _e.nativeTheme.on("updated", function () { if (view.isOpen()) setTimeout(pushTheme, 100); }); } catch (e) {}
  register(CLAUDE, okClaude, true);
  register(PREF, okPref, false);
  register(TRACKER, okTracker, true);

  _e.app.on("web-contents-created", function (_ev, wc) {
    wc.on("dom-ready", function () { if (enabled()) injectWhenAttached(wc, INJECT_TRIES); });
    wc.on("did-navigate", function (_e2, url) { noteRoute(wc, url); if (view.claudeContents() === wc) view.close("navigate"); });
    wc.on("did-navigate-in-page", function (_e2, url, isMainFrame) {
      if (isMainFrame !== false) noteRoute(wc, url);
      if (isMainFrame !== false && view.claudeContents() === wc && pathOf(url) !== openedPath) view.close("navigate");
    });
    wc.on("before-input-event", function (ev, input) { if (!view.isTracker(wc)) onKey(wc, ev, input); });
  });
  _e.app.whenReady().then(function () {
    setTimeout(function () {
      var hook = globalThis.__cdbJiraOnNativeViewAttached;
      if (typeof hook === "function") hook(function (win) { if (view.isOpen() && view.hostWindow() === win) view.close("upstream-view"); });
      else log("hook:native-view missing");
      if (typeof globalThis.__cdbJiraSessions !== "function") log("hook:session-manager missing");
      log("installed; switch " + (enabled() ? "on" : "off"));
    }, 0);
  }, noop);
})();
