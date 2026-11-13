;/*__CDB_JIRA_STORE__*/(function () {
  "use strict";
  if (typeof process === "undefined" || process.platform !== "linux") return;
  var PREF_KEY = "jiraTracker";
  var JSON_NAME = "claude-desktop-extra.json", JSONC_NAME = "claude-desktop-extra.jsonc";
  var CREDS_FILE = "cdb-jira-credentials.json", STATE_FILE = "cdb-jira-state.json";
  var HOST_RE = /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var TOKEN_RE = /^[\x21-\x7e]{8,512}$/;
  var PROJECT_RE = /^[A-Z][A-Z0-9_]+$/;
  var CONTROL_RE = /[\u0000-\u001f\u007f]/;
  var PRESETS = ["assigned", "reported"];
  var SORTS = ["updated", "priority", "created", "key"];
  var MAX_QUERIES = 50, MAX_FOLDERS = 200, MAX_TEMPLATE = 10000, MAX_JQL = 2000, MAX_NAME = 80;

  function str(v) { return typeof v === "string" ? v : ""; }
  function isObj(v) { return !!v && typeof v === "object" && !Array.isArray(v); }

  function normaliseSite(input) {
    var s = str(input).trim().toLowerCase();
    if (!s) return "";
    if (!/^[a-z][a-z0-9+.-]*:/.test(s)) s = "https://" + s;
    var u;
    try { u = new URL(s); } catch (e) { return null; }
    if (u.protocol !== "https:" || u.username || u.password || u.port || !HOST_RE.test(u.hostname)) return null;
    return "https://" + u.hostname;
  }

  function create(deps) {
    var fs = deps.fs, path = deps.path, safeStorage = deps.safeStorage;
    var log = deps.log || function () {};
    var decryptWarned = false, cache = { enc: "", token: "" };

    function file(name) { return path.join(deps.userData(), name); }
    function strip(s) {
      return String(s).replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, function (m, q) { return q ? q : ""; })
        .replace(/,(\s*[}\]])/g, "$1");
    }
    function readJson(p) {
      try {
        var t = strip(fs.readFileSync(p, "utf8"));
        var v = t.trim() ? JSON.parse(t) : {};
        return isObj(v) ? v : null;
      } catch (e) { return null; }
    }
    function writeAtomic(p, value) {
      var tmp = p + ".cdb-tmp";
      try {
        fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 384 });
        fs.renameSync(tmp, p);
        try { fs.chmodSync(p, 384); } catch (e) {}
        return { ok: true };
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) {}
        return { ok: false, error: "cannot write " + p + ": " + ((e && e.message) || String(e)) };
      }
    }

    function prefRead() {
      var jsonc = readJson(file(JSONC_NAME));
      if (jsonc && typeof jsonc[PREF_KEY] === "boolean") return { enabled: jsonc[PREF_KEY], locked: true };
      var json = readJson(file(JSON_NAME));
      return { enabled: !!json && json[PREF_KEY] === true, locked: false };
    }
    function prefWrite(on) {
      if (prefRead().locked) return { ok: false, error: PREF_KEY + " is set in " + JSONC_NAME + " - edit that file to change it" };
      var p = file(JSON_NAME), raw = null, cfg = {};
      try { raw = fs.readFileSync(p, "utf8"); } catch (e) {
        if (e.code !== "ENOENT") return { ok: false, error: "cannot read " + p + ": " + e.message };
      }
      if (raw !== null) {
        var stripped = strip(raw);
        try { cfg = stripped.trim() ? JSON.parse(stripped) : {}; } catch (e) {
          return { ok: false, error: p + " is not valid JSON (" + e.message + ") - fix or remove it first; nothing was written" };
        }
        if (!isObj(cfg)) return { ok: false, error: p + " must contain a JSON object; nothing was written" };
      }
      if (on) cfg[PREF_KEY] = true; else delete cfg[PREF_KEY];
      var tmp = p + ".cdb-tmp";
      try {
        fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
        fs.renameSync(tmp, p);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) {}
        return { ok: false, error: "cannot write " + p + ": " + e.message };
      }
      return { ok: true };
    }

    function keyring() {
      var backend = "", ok = false;
      try { backend = safeStorage && typeof safeStorage.getSelectedStorageBackend === "function" ? String(safeStorage.getSelectedStorageBackend()) : ""; } catch (e) {}
      try { ok = !!safeStorage && safeStorage.isEncryptionAvailable() === true && backend !== "basic_text"; } catch (e) {}
      return { ok: ok, backend: backend || "unknown" };
    }
    function credsRaw() {
      var v = readJson(file(CREDS_FILE)) || {};
      return { site: normaliseSite(v.site) || "", email: str(v.email), route: v.route === "site" || v.route === "gateway" ? v.route : "",
        cloudId: str(v.cloudId), tokenEnc: str(v.tokenEnc) };
    }
    function credsView() {
      var c = credsRaw(), k = keyring();
      return { site: c.site, email: c.email, tokenSet: !!c.tokenEnc, keyringOk: k.ok, keyringBackend: k.backend };
    }
    function credsSave(fields) {
      if (!isObj(fields)) return { ok: false, error: "expected an object" };
      var cur = credsRaw(), next = Object.assign({}, cur);
      if (fields.site !== undefined) {
        var site = normaliseSite(fields.site);
        if (site === null) return { ok: false, error: "Enter your Jira Cloud site, for example https://your-team.atlassian.net" };
        next.site = site;
      }
      if (fields.email !== undefined) {
        var mail = str(fields.email).trim();
        if (typeof fields.email !== "string" || (mail && (mail.length > 254 || !EMAIL_RE.test(mail)))) return { ok: false, error: "Enter the email address of your Atlassian account" };
        next.email = mail;
      }
      if (fields.token === null) next.tokenEnc = "";
      else if (fields.token !== undefined) {
        var token = str(fields.token).trim();
        if (typeof fields.token !== "string" || !TOKEN_RE.test(token)) return { ok: false, error: "The API token must be 8 to 512 printable characters without spaces" };
        var k = keyring();
        if (!k.ok) return { ok: false, error: "The system keyring is not available (" + k.backend + "), so the token cannot be stored encrypted. Start GNOME Keyring or KWallet and restart Claude." };
        try { next.tokenEnc = safeStorage.encryptString(token).toString("base64"); }
        catch (e) { return { ok: false, error: "The system keyring refused to encrypt the token" }; }
      }
      // A token is only ever sent to the site it was saved for: a new site needs the token again.
      if (next.site !== cur.site && fields.token === undefined) next.tokenEnc = "";
      if (next.site !== cur.site || next.email !== cur.email || next.tokenEnc !== cur.tokenEnc) { next.route = ""; next.cloudId = ""; }
      return writeAtomic(file(CREDS_FILE), next);
    }
    function creds() {
      var c = credsRaw();
      if (!c.site || !c.email || !c.tokenEnc || !keyring().ok) return null;
      if (cache.enc !== c.tokenEnc) {
        cache = { enc: "", token: "" };
        try {
          var token = safeStorage.decryptString(Buffer.from(c.tokenEnc, "base64"));
          if (typeof token === "string" && token) cache = { enc: c.tokenEnc, token: token };
        } catch (e) {
          if (!decryptWarned) { decryptWarned = true; log("store: the saved token could not be decrypted; save it again"); }
          return null;
        }
      }
      return cache.token ? { site: c.site, email: c.email, token: cache.token, route: c.route, cloudId: c.cloudId } : null;
    }
    function saveRoute(route, cloudId) {
      var c = credsRaw();
      if (route !== "site" && route !== "gateway") return { ok: false, error: "bad route" };
      c.route = route;
      c.cloudId = route === "gateway" ? str(cloudId) : "";
      return writeAtomic(file(CREDS_FILE), c);
    }

    function cleanQueries(list) {
      var out = [], seen = {};
      (Array.isArray(list) ? list : []).forEach(function (q) {
        if (!isObj(q)) return;
        var name = str(q.name).trim(), jql = str(q.jql).trim();
        if (!name || name.length > MAX_NAME || CONTROL_RE.test(name) || !jql || jql.length > MAX_JQL || seen[name]) return;
        seen[name] = true;
        out.push({ name: name, jql: jql });
      });
      return out.slice(0, MAX_QUERIES);
    }
    function cleanFolders(map) {
      var out = {};
      if (!isObj(map)) return out;
      Object.keys(map).slice(-MAX_FOLDERS).forEach(function (k) {
        var v = map[k];
        if (PROJECT_RE.test(k) && typeof v === "string" && v.charAt(0) === "/" && v.length <= 4096 && !CONTROL_RE.test(v)) out[k] = v;
      });
      return out;
    }
    function cleanBoards(map) {
      var out = {};
      if (!isObj(map)) return out;
      Object.keys(map).slice(-MAX_FOLDERS).forEach(function (k) {
        var id = map[k];
        if (PROJECT_RE.test(k) && typeof id === "number" && isFinite(id) && id > 0 && Math.floor(id) === id) out[k] = id;
      });
      return out;
    }
    function state() {
      var v = readJson(file(STATE_FILE)) || {};
      return {
        queries: cleanQueries(v.queries),
        lastPreset: PRESETS.indexOf(v.lastPreset) >= 0 ? v.lastPreset : "assigned",
        project: PROJECT_RE.test(str(v.project)) ? v.project : "",
        sort: SORTS.indexOf(v.sort) >= 0 ? v.sort : "updated",
        detailsOpen: typeof v.detailsOpen === "boolean" ? v.detailsOpen : true,
        boards: cleanBoards(v.boards),
        folders: cleanFolders(v.folders),
        template: typeof v.template === "string" && v.template.length <= MAX_TEMPLATE ? v.template : ""
      };
    }
    function stateWrite(patch) {
      if (!isObj(patch)) return { ok: false, error: "expected an object" };
      var s = state();
      if (patch.lastPreset !== undefined) {
        if (PRESETS.indexOf(patch.lastPreset) < 0) return { ok: false, error: "unknown preset" };
        s.lastPreset = patch.lastPreset;
      }
      if (patch.sort !== undefined) {
        if (SORTS.indexOf(patch.sort) < 0) return { ok: false, error: "unknown sort" };
        s.sort = patch.sort;
      }
      if (patch.detailsOpen !== undefined) {
        if (typeof patch.detailsOpen !== "boolean") return { ok: false, error: "detailsOpen must be true or false" };
        s.detailsOpen = patch.detailsOpen;
      }
      if (patch.board !== undefined) {
        var b = patch.board;
        if (!isObj(b) || !PROJECT_RE.test(str(b.project))) return { ok: false, error: "bad board choice" };
        if (b.id === null) delete s.boards[b.project];
        else if (typeof b.id === "number" && isFinite(b.id) && b.id > 0 && Math.floor(b.id) === b.id) { delete s.boards[b.project]; s.boards[b.project] = b.id; s.boards = cleanBoards(s.boards); }
        else return { ok: false, error: "bad board choice" };
      }
      if (patch.project !== undefined) {
        if (patch.project !== "" && !PROJECT_RE.test(str(patch.project))) return { ok: false, error: "bad project key" };
        s.project = patch.project;
      }
      if (patch.template !== undefined) {
        if (patch.template !== null && (typeof patch.template !== "string" || patch.template.length > MAX_TEMPLATE)) return { ok: false, error: "The template must be text of at most " + MAX_TEMPLATE + " characters" };
        s.template = patch.template === null ? "" : patch.template;
      }
      if (patch.folder !== undefined) {
        var f = patch.folder;
        if (!isObj(f) || !PROJECT_RE.test(str(f.project)) || typeof f.path !== "string" || f.path.charAt(0) !== "/" || f.path.length > 4096 || CONTROL_RE.test(f.path)) return { ok: false, error: "bad folder" };
        delete s.folders[f.project];
        s.folders[f.project] = f.path;
        s.folders = cleanFolders(s.folders);
      }
      if (patch.saveQuery !== undefined) {
        var q = cleanQueries([patch.saveQuery]);
        if (!q.length) return { ok: false, error: "A saved query needs a name of at most " + MAX_NAME + " characters and a JQL text of at most " + MAX_JQL + " characters" };
        s.queries = cleanQueries([q[0]].concat(s.queries.filter(function (x) { return x.name !== q[0].name; })));
      }
      if (patch.deleteQuery !== undefined) s.queries = s.queries.filter(function (x) { return x.name !== str(patch.deleteQuery); });
      var w = writeAtomic(file(STATE_FILE), s);
      return w.ok ? { ok: true, state: s } : w;
    }

    return {
      constants: { PREF_KEY: PREF_KEY, CREDS_FILE: CREDS_FILE, STATE_FILE: STATE_FILE, MAX_JQL: MAX_JQL, MAX_TEMPLATE: MAX_TEMPLATE, PRESETS: PRESETS },
      normaliseSite: normaliseSite, prefRead: prefRead, prefWrite: prefWrite, keyring: keyring,
      credsView: credsView, credsSave: credsSave, creds: creds, saveRoute: saveRoute, state: state, stateWrite: stateWrite
    };
  }

  globalThis.__cdbJiraStoreFactory = create;
})();
