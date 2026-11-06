/*
 * custom_models_main.js - main-process half of the custom models feature.
 *
 * Lists models served by an Anthropic-COMPATIBLE endpoint (DeepSeek's
 * /anthropic API is the reference) in the Code tab's model picker, NEXT TO
 * Anthropic's own models, and routes the CLI's requests for them to that
 * endpoint with the provider's key. The subscription login and every Claude
 * model are untouched: this is additive, unlike the 3p/managed-settings mode,
 * which is exclusive.
 *
 * Two halves, both driven by the `customModels` key of
 * <userData>/claude-desktop-extra.jsonc (hand-owned, wins) / .json (UI):
 *
 *  1. PICKER. The page (remote claude.ai code) builds its model menu from
 *     `model_selector_config` in the /api/bootstrap response and then tells
 *     the app which ids exist (setAvailableCodeModels). Nothing local feeds
 *     that menu - modelPicker in ~/.claude/settings.json only reaches the CLI's
 *     own /model. So we attach the Chrome DevTools Protocol `Fetch` domain to
 *     claude.ai webContents, pause the bootstrap RESPONSE, and append our
 *     entries to the surfaces we are configured for (default: ccd and code,
 *     the two the desktop Code tab reads - see DEFAULT_SURFACES). The entries
 *     copy the shape the live bootstrap carries for that surface (see the
 *     picker-entries section), so the page renders them like any other
 *     model. Anthropic's list stays whatever the server sent - new Claude
 *     models keep appearing.
 *
 *  2. ROUTING. `cliEnv()` is spliced into the environment of every Code-tab
 *     session the app spawns (sub-patch B of the Nim patch): BUN_OPTIONS
 *     loads js/custom_models_preload.js inside the Claude Code binary, and
 *     CDB_CUSTOM_MODELS_JSON carries the resolved providers (endpoint, key,
 *     models). The preload hooks fetch there and forwards only our models.
 *     The app's own validator accepts any id in subscription mode; the CLI's
 *     accepts ^claude-\S+$, hence every custom id is exposed as "claude-<id>".
 *
 *  3. SUB-AGENTS. `agents()` and `appendSystemPrompt()` are routed through
 *     the session's `initialize` request (sub-patch C): one sub-agent type
 *     per model, so Claude can launch it by name (Agent tool, workflow
 *     agentType), and one system-prompt line that tells Claude the ids and
 *     the types exist - for a session spawned with cliEnv() only, the one
 *     kind that has the preload. CLAUDE_CODE_SUBAGENT_MODEL, when the user
 *     picks a default sub-agent model, rides in cliEnv().
 *
 *  4. REMOTE SESSIONS. `remoteSpawn()` (sub-patch D, configureSSHSpawn)
 *     takes cliEnv()'s additions back out of an SSH/WSL session's env: its
 *     CLI runs on another host, without the preload.
 *
 * SECURITY: the provider key never reaches the page - the bootstrap patch
 * carries names and ids only, and the panel's IPC never returns a key. The
 * IPC handlers validate the sender ORIGIN (not a substring of the URL) and
 * every field they take; page-supplied values land only in the .json config
 * and the secrets file, never in a path. The page can drive those handlers,
 * so a stored key never follows its provider to another host (sameOrigin).
 * The key travels to the CLI in its environment, the same channel the app
 * uses for its own credentials in 3p mode, and the preload deletes it from
 * process.env before the CLI's code runs so no child process (Bash tool, MCP
 * servers) inherits it.
 */
;/*__CDB_CUSTOM_MODELS__*/(function () {
  "use strict";
  // Linux, and win32 for downstream Windows builds of this patch set.
  if (typeof process === "undefined" || (process.platform !== "linux" && process.platform !== "win32")) return;
  if (globalThis.__cdbCustomModels) return;

  var _electron = require("electron");
  var _app = _electron.app;
  var _ipc = _electron.ipcMain;
  var _fs = require("fs");
  var _path = require("path");
  var _os = require("os");
  var _URL = require("url").URL;

  var PRELOAD_SRC = "__CDB_CM_PRELOAD_SRC__";
  var PREF_KEY = "customModels";
  var JSONC_NAME = "claude-desktop-extra.jsonc";
  var JSON_NAME = "claude-desktop-extra.json";
  var SUBDIR = "custom-models";
  var PRELOAD_NAME = "preload.js";
  var LOG_NAME = "custom-models.log";
  var SECRETS_NAME = "secrets.json";
  // What the preload routes with, rewritten at every change of the
  // configuration and re-read by the CLI sessions already open (live routing):
  // the resolved providers WITH their keys, 0600 in the 0700 subdir - the same
  // exposure as secrets.json. Empty when the feature is off.
  var ROUTES_NAME = "routes.json";
  // Picker surfaces as the bootstrap names them. The desktop Code tab reads
  // TWO of them: `ccd` is the catalogue the picker menu is drawn from, `code`
  // is the surface the session logic runs on - the model's effort options
  // (the effort menu is hidden for a model `code` does not list), the ids
  // reported to the app as available (setAvailableCodeModels, hence what the
  // set_session_model MCP tool accepts) and the state the page persists
  // (PATCH model_selector_state/code). Both are needed. `ccr` is Claude Code
  // on the web, then chat/cowork/design/... - a Cowork session runs in a VM
  // and cannot reach the preload, so those are not listed by default.
  var DEFAULT_SURFACES = ["ccd", "code"];
  // How a model is exposed to the CLI, which trusts only the id for its
  // context window: anything it does not know is 200k, unless the id ends in
  // "[1m]" (the spelling it uses for Sonnet/Opus 1M) - then 1M. The window
  // drives the context gauge and auto-compaction, so a natively-1M model
  // listed under its bare id is compacted at 200k. The default is 1M for
  // every provider and model; a listing that states a smaller window sets
  // 200k by itself. A model whose real window is smaller (Haiku, many local
  // models) must be set to 200k: past it, the provider refuses the request
  // instead of the session compacting.
  //   "200k": listed as claude-<id>
  //   "1m":   listed as claude-<id>[1m] only, under its plain name
  //   "both": claude-<id> and claude-<id>[1m] ("<name> 1M"), the way Sonnet
  //           and Opus 1M are offered - for a provider that prices the two
  //           windows differently
  var CONTEXT_MODES = ["200k", "1m", "both"];
  var DEFAULT_CONTEXT = "1m";
  var SURFACE_RE = /^[a-z][a-z0-9_]{0,40}$/;
  var ID_PREFIX = "claude-";
  var ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,120}$/;
  var PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/;
  // An Anthropic model id as the bootstrap lists them (claude-opus-5,
  // claude-haiku-4-5-20251001...): what the app-wide web-search choice may
  // name besides one of ours.
  var ANTHROPIC_ID_RE = /^claude-[a-z0-9][a-z0-9.-]{0,60}$/;
  // Anthropic's own model ids: the picker's Claude entries send them, so a
  // custom model listed under one would take every session on that Claude
  // model away from the subscription. Anthropic's families by name, plus any
  // id the last bootstrap listed (a family this does not know yet).
  var ANTHROPIC_FAMILY_RE = /^claude-(?:opus|sonnet|haiku|fable|instant)(?:-|$)|^claude-[1-3](?:[.-]|$)/;
  var serverAnthropicIds = Object.create(null);
  var ANTHROPIC_API_ORIGIN = "https://api.anthropic.com";
  function shadowsAnthropic(alias) {
    var a = String(alias).replace(/\[1m\]$/, "");
    return ANTHROPIC_FAMILY_RE.test(a) || serverAnthropicIds[a] === true;
  }
  // The id a model is listed and routed under: claude-<id>, or the id itself
  // when it starts with claude-. A model carrying one of Anthropic's own ids
  // (Opus on your API credit, next to Opus on the subscription) is listed as
  // claude-<provider>-<id without claude-> instead, so both entries work.
  // readConfig does the same for an id two providers list (sharedAliases).
  function qualifiedAlias(pid, id) {
    return ID_PREFIX + pid + "-" + (id.indexOf(ID_PREFIX) === 0 ? id.slice(ID_PREFIX.length) : id);
  }
  function aliasFor(pid, id) {
    var a = id.indexOf(ID_PREFIX) === 0 ? id : ID_PREFIX + id;
    return shadowsAnthropic(a) ? qualifiedAlias(pid, id) : a;
  }
  // The base aliases (aliasFor) that more than one provider lists. Each copy
  // of such a model is listed under its provider (claude-<provider>-<id>), so
  // the same model on two endpoints gets two entries. Every copy, not only the
  // later ones: the file order then decides nothing, and a name never moves
  // from one provider to another - a session on a name that went away gets a
  // clear error from the preload instead of another provider's answers.
  function sharedAliases(list) {
    var count = Object.create(null), shared = Object.create(null);
    list.forEach(function (p) {
      var mine = Object.create(null);
      p.models.forEach(function (m) {
        var a = aliasFor(p.id, m.id);
        if (mine[a] || shadowsAnthropic(a)) return;
        mine[a] = true;
        count[a] = (count[a] || 0) + 1;
        if (count[a] > 1) shared[a] = true;
      });
    });
    return shared;
  }
  // Sub-agent types (see agentDefs): the name Claude launches a model's
  // sub-agent under - kebab-case, like the CLI's own general-purpose. The
  // reserved ones are the CLI's built-in types; a generated name that would
  // shadow one gets the provider id appended.
  var AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
  var HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
  // A provider's User-Agent: printable ASCII only - fetch refuses a header
  // value with a line break or a character above 0xFF, and every request to
  // the provider would then fail as a network error.
  var USER_AGENT_RE = /^[\x20-\x7e]{1,300}$/;
  var RESERVED_AGENT_NAMES = ["general-purpose", "explore", "plan", "claude", "fork", "statusline-setup", "claude-code-guide"];

  var DEBUG = process.env.CDB_CUSTOM_MODELS_DEBUG === "1";

  function log(m) { (globalThis.__cdbDiag || console.log)("[custom-models] " + m); }

  function userDir() {
    try { return _app.getPath("userData"); } catch (e) { return null; }
  }
  // Same nudge as every other config consumer (js/panel_tabs_main.js explains
  // why: the claude-desktop-bin.* -> claude-desktop-extra.* rename migration
  // may not have run yet when a same-anchor prefix injection gets here).
  function pathFor(name) {
    try { (globalThis.__cdbCfgMigrate || function () {})(); } catch (e) {}
    var d = userDir();
    return d ? _path.join(d, name) : null;
  }

  // Whole quoted strings are matched FIRST and passed through, so a "//"
  // inside a value (a URL - every baseUrl has one) is never taken for a comment.
  function stripComments(s) {
    return String(s)
      .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, function (m, q) { return q ? q : ""; })
      // Trailing commas, strings passed through again (a description may
      // well contain ", }").
      .replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g, function (m, q, close) { return q ? q : close; });
  }
  // Lenient: any problem reads as "nothing set here". Nothing is written back
  // through this path (writePref does its own strict read).
  function readFileJson(p) {
    try {
      if (!p || !_fs.existsSync(p)) return null;
      var stripped = stripComments(_fs.readFileSync(p, "utf8"));
      var v = stripped.trim() ? JSON.parse(stripped) : {};
      return (v && typeof v === "object" && !Array.isArray(v)) ? v : null;
    } catch (e) { return null; }
  }
  function isObj(v) { return !!v && typeof v === "object" && !Array.isArray(v); }

  // ---- config ---------------------------------------------------------------
  // customModels: {
  //   enabled?: boolean,            // the switch; absent = off, like every community feature
  //   surfaces?: ["ccd", "code"],   // which pickers list them (bootstrap surface ids)
  //   webSearch?: "deepseek-flash", // app-wide: the CLI's web-search sub-request goes to
  //                                 // this model instead of Anthropic's small default - a
  //                                 // custom model, or any Anthropic id (claude-opus-5...)
  //   smallFastModel?: "deepseek-flash", // the CLI's ANTHROPIC_SMALL_FAST_MODEL slot:
  //                                 // WebFetch's page synthesis, the mid-turn intent
  //                                 // classifier, and - when webSearch is unset - the
  //                                 // web-search sub-request run on this model. A custom
  //                                 // alias (routed by the preload), or any Anthropic id,
  //                                 // or absent for the CLI's own small default.
  //   subagentModel?: "deepseek-flash[1m]", // the model of sub-agents that name none
  //   providers: [{
  //     id: "deepseek", baseUrl: "https://api.deepseek.com/anthropic",
  //     apiKey | apiKeyEnv | apiKeyFile, headers?, userAgent?, stripBillingHeader?,
  //     effortMap?, context?,
  //     models: [{ id, name?, shortName?, description?, badge?, section?,
  //                context?, vision?, thinking?, webSearch?, effort?, effortDefault? }]
  //   }]
  // }
  // Two sources, merged: the hand-owned .jsonc and the .json the Settings
  // panel writes. `enabled` and `surfaces` come from the .jsonc when set there
  // (the switch then shows itself as locked), else from the .json. Providers
  // come from BOTH lists - a .jsonc provider is locked (the panel shows it,
  // cannot edit it) and wins over a .json provider with the same id.
  //
  // Keys the panel stores go to <userData>/custom-models/secrets.json (0600
  // in a 0700 dir), never into claude-desktop-extra.json - that file is
  // shared with every other extra, rewritten by their writers with default
  // permissions, and read by users who paste it into bug reports. A provider
  // whose key lives there carries apiKeyStored:true in the .json.
  var warned = Object.create(null);
  function warnOnce(key, msg) {
    if (warned[key]) return;
    warned[key] = true;
    log("config: " + msg);
  }

  function expandHome(p) {
    // A leading ~\ too on Windows, where that is how a home-relative path is written.
    var home = typeof p === "string" && (p.indexOf("~/") === 0 || (process.platform === "win32" && p.indexOf("~\\") === 0));
    return home ? _path.join(_os.homedir(), p.slice(2)) : p;
  }
  function secretsPath() {
    var d = pathFor(SUBDIR);
    return d ? _path.join(d, SECRETS_NAME) : null;
  }
  // The subdir holds the keys (secrets.json, routes.json): 0700, and brought
  // back to 0700 if something widened it.
  function ensureDir(dir) {
    _fs.mkdirSync(dir, { recursive: true, mode: 448 });
    try { if (_fs.statSync(dir).mode & 63) _fs.chmodSync(dir, 448); } catch (e) {}
  }
  function readSecrets() {
    var v = readFileJson(secretsPath());
    var out = Object.create(null);
    if (v) Object.keys(v).forEach(function (k) { if (typeof v[k] === "string") out[k] = v[k]; });
    return out;
  }
  // noSync: the caller writes the .json next and syncs routes.json once,
  // when both files agree.
  function writeSecrets(map, noSync) {
    var p = secretsPath();
    if (!p) return { ok: false, error: "no userData path" };
    try {
      ensureDir(_path.dirname(p));
      var tmp = p + ".cdb-tmp";
      _fs.writeFileSync(tmp, JSON.stringify(map, null, 2) + "\n", { encoding: "utf8", mode: 384 });
      _fs.renameSync(tmp, p);
      if (!noSync) syncRoutes();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: "cannot write " + p + ": " + (e && e.message ? e.message : String(e)) };
    }
  }
  // Returns { key, source } - source names where it came from, for the panel
  // and the logs; the value itself only ever reaches the CLI.
  function resolveKey(p, idx, secrets) {
    if (typeof p.apiKey === "string" && p.apiKey.trim()) return { key: p.apiKey.trim(), source: "value" };
    if (typeof p.apiKeyEnv === "string" && p.apiKeyEnv.trim()) {
      var v = process.env[p.apiKeyEnv.trim()];
      if (typeof v === "string" && v.trim()) return { key: v.trim(), source: "env" };
      warnOnce("keyenv" + idx, "provider " + p.id + ": apiKeyEnv " + p.apiKeyEnv + " is not set in the app's environment");
    }
    if (typeof p.apiKeyFile === "string" && p.apiKeyFile.trim()) {
      try { return { key: _fs.readFileSync(expandHome(p.apiKeyFile.trim()), "utf8").trim(), source: "file" }; }
      catch (e) { warnOnce("keyfile" + idx, "provider " + p.id + ": cannot read apiKeyFile (" + e.message + ")"); }
    }
    if (p.apiKeyStored === true && typeof secrets[p.id] === "string" && secrets[p.id]) {
      return { key: secrets[p.id], source: "stored" };
    }
    return { key: "", source: "none" };
  }

  function normaliseModel(raw, pid, idx) {
    if (!isObj(raw) || typeof raw.id !== "string" || !ID_RE.test(raw.id.trim())) {
      warnOnce("model" + pid + idx, "provider " + pid + ": models[" + idx + "] needs a plain string id - skipped");
      return null;
    }
    var id = raw.id.trim();
    var alias = aliasFor(pid, id);
    var renamed = alias !== (id.indexOf(ID_PREFIX) === 0 ? id : ID_PREFIX + id);
    var named = typeof raw.name === "string" && !!raw.name.trim();
    var m = {
      id: id,
      alias: alias,
      named: named,
      name: named ? raw.name.trim() : (renamed ? id + " (" + pid + ")" : id),
      description: typeof raw.description === "string" ? raw.description.trim() : "",
      shortName: typeof raw.shortName === "string" && raw.shortName.trim() ? raw.shortName.trim() : "",
      badge: typeof raw.badge === "string" && raw.badge.trim() ? raw.badge.trim() : "",
      section: raw.section === "overflow" ? "overflow" : "main",
      vision: raw.vision !== false,
      thinking: raw.thinking !== false,
      webSearch: raw.webSearch !== false
    };
    if (Array.isArray(raw.effort)) {
      var lv = raw.effort.filter(function (x) { return EFFORT_ORDER.indexOf(x) !== -1; });
      if (lv.length) m.effort = EFFORT_ORDER.filter(function (x) { return lv.indexOf(x) !== -1; });
    }
    if (typeof raw.effortDefault === "string" && EFFORT_ORDER.indexOf(raw.effortDefault) !== -1) {
      m.effortDefault = raw.effortDefault;
    }
    // Unset here = the provider's (see normaliseProvider). `context1m: true`
    // is the spelling of the first release, kept as "both".
    if (CONTEXT_MODES.indexOf(raw.context) !== -1) m.context = raw.context;
    else if (raw.context1m === true) m.context = "both";
    // Its sub-agent type: on unless `agent: false`; an object customises the
    // name, the description and the prompt (agentDefs fills the rest). The
    // name is resolved in readConfig, where uniqueness can be checked.
    m.agent = raw.agent !== false;
    if (isObj(raw.agent)) {
      if (typeof raw.agent.name === "string" && raw.agent.name.trim()) m.agentWanted = raw.agent.name.trim().toLowerCase();
      if (typeof raw.agent.description === "string" && raw.agent.description.trim()) m.agentDescription = raw.agent.description.trim();
      if (typeof raw.agent.prompt === "string" && raw.agent.prompt.trim()) m.agentPrompt = raw.agent.prompt.trim();
    }
    return m;
  }
  // The ids a model is listed under, per its context mode - what the picker
  // shows, what the page persists, what the CLI receives as --model.
  function listedIds(m) {
    if (m.context === "1m") return [m.alias + "[1m]"];
    if (m.context === "both") return [m.alias, m.alias + "[1m]"];
    return [m.alias];
  }
  // The id a sub-agent (or the sub-agent default) runs the model under: the
  // 1M twin when the model is listed with one - an agent's job is the long one.
  function agentModelId(m) {
    var ids = listedIds(m);
    return ids[ids.length - 1];
  }
  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  }

  function normaliseProvider(raw, idx, locked, secrets) {
    if (!isObj(raw)) { warnOnce("prov" + idx, "providers[" + idx + "] is not an object - skipped"); return null; }
    var id = typeof raw.id === "string" && PROVIDER_ID_RE.test(raw.id.trim()) ? raw.id.trim() : "";
    if (!id) { warnOnce("provid" + idx, "providers[" + idx + "] needs an id (letters, digits, - _), skipped"); return null; }
    // The Messages path is always <base>/v1/messages: a base typed with its
    // /v1 (or the whole path) would post to .../v1/v1/messages, a 404.
    var baseUrl = typeof raw.baseUrl === "string"
      ? raw.baseUrl.trim().replace(/\/+$/, "").replace(/\/v1(?:\/messages)?$/, "") : "";
    if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) {
      warnOnce("url" + idx, "provider " + id + ": baseUrl must be an http(s) URL - skipped");
      return null;
    }
    var k = resolveKey(Object.assign({}, raw, { id: id }), idx, secrets);
    var p = { id: id, baseUrl: baseUrl, apiKey: k.key, keySource: k.source, locked: locked, models: [] };
    // Anthropic's own API (your API credit): the preload forwards the CLI's
    // request as it is - prompt caching, betas, signed thinking - with the
    // key instead of the subscription's login.
    p.native = originOf(baseUrl) === ANTHROPIC_API_ORIGIN;
    if (typeof raw.preset === "string" && presetOf(raw.preset)) p.preset = raw.preset;
    // The effort values the provider's API accepts under the app's names -
    // an API convention, so it lives on the provider; a model may still
    // override it in the file. Absent: the preset's knowledge, else all five.
    var levels = null;
    if (Array.isArray(raw.effort)) {
      levels = EFFORT_ORDER.filter(function (l) { return raw.effort.indexOf(l) !== -1; });
      if (!levels.length) levels = null;
    }
    if (!levels && p.preset && presetOf(p.preset) && presetOf(p.preset).effort) levels = presetOf(p.preset).effort.slice();
    p.effort = levels || EFFORT_ORDER.slice();
    // An explicit list is sent as it is by the preload; without one, the
    // preload's default table (DeepSeek's convention) applies.
    p.effortExplicit = !!levels;
    // The context window its models are exposed with (CONTEXT_MODES): the
    // file's value, else the preset's knowledge, else DEFAULT_CONTEXT.
    if (CONTEXT_MODES.indexOf(raw.context) !== -1) p.context = raw.context;
    else if (p.preset && presetOf(p.preset) && presetOf(p.preset).context) p.context = presetOf(p.preset).context;
    else p.context = DEFAULT_CONTEXT;
    if (typeof raw.modelsUrl === "string" && /^https?:\/\/[^\s]+$/.test(raw.modelsUrl.trim())) p.modelsUrl = raw.modelsUrl.trim();
    if (isObj(raw.headers)) {
      // Only what fetch accepts: a malformed header would make every request
      // to the provider fail as a network error.
      p.headers = {};
      Object.keys(raw.headers).forEach(function (k) {
        var v = raw.headers[k];
        if (typeof v === "string" && HEADER_NAME_RE.test(k) && !/[\r\n\0]/.test(v)) p.headers[k] = v;
        else warnOnce("hdr" + id + k, "provider " + id + ": header " + JSON.stringify(k) + " is not a valid HTTP header - not sent");
      });
    }
    // The User-Agent every request to this endpoint carries - the sessions'
    // and the app's own (fetch models, test, detect). Absent: the runtime's.
    var ua = typeof raw.userAgent === "string" ? raw.userAgent.trim() : "";
    if (USER_AGENT_RE.test(ua)) p.userAgent = ua;
    else if (ua || (raw.userAgent !== undefined && typeof raw.userAgent !== "string")) {
      warnOnce("ua" + id, "provider " + id + ": userAgent must be printable ASCII, at most 300 characters - not sent");
    }
    // The CLI's billing line (cc_entrypoint=claude-desktop, first block of
    // the system prompt) is meaningless to another provider: dropped there on
    // request. Anthropic's API uses it, so never for a native provider.
    if (raw.stripBillingHeader === true && !p.native) p.stripBillingHeader = true;
    if (isObj(raw.effortMap)) p.effortMap = raw.effortMap;
    if (typeof raw.webSearch === "string" && raw.webSearch.trim()) p.webSearch = raw.webSearch.trim();
    (Array.isArray(raw.models) ? raw.models : []).forEach(function (m, i) {
      var n = normaliseModel(m, id, i);
      if (!n) return;
      if (!n.effort) n.effort = p.effort.slice();
      if (!n.context) n.context = p.context;
      p.models.push(n);
    });
    return p;
  }

  function readSources() {
    return {
      jsonc: readFileJson(pathFor(JSONC_NAME)) || {},
      json: readFileJson(pathFor(JSON_NAME)) || {}
    };
  }

  // An Anthropic model id: claude-..., and - once a bootstrap has been seen -
  // one the picker lists. A custom alias whose model is gone has the same
  // spelling and must not pass for one.
  function anthropicKnown(id) {
    if (!ANTHROPIC_ID_RE.test(id)) return false;
    return !lastAnthropicModels.length || lastAnthropicModels.some(function (m) { return m.id === id; });
  }
  function readConfig() {
    var src = readSources();
    var a = isObj(src.jsonc[PREF_KEY]) ? src.jsonc[PREF_KEY] : {};
    var b = isObj(src.json[PREF_KEY]) ? src.json[PREF_KEY] : {};
    var secrets = readSecrets();

    var providers = [];
    var byId = Object.create(null);
    var seenModel = Object.create(null);
    var seenOwner = Object.create(null);
    function take(list, locked) {
      (Array.isArray(list) ? list : []).forEach(function (raw, idx) {
        var p = normaliseProvider(raw, idx, locked, secrets);
        if (!p) return;
        if (byId[p.id]) { warnOnce("dupprov" + p.id, "provider " + p.id + " is in both files - the .jsonc one wins"); return; }
        byId[p.id] = p;
        providers.push(p);
      });
    }
    take(a.providers, true);
    take(b.providers, false);
    var shared = sharedAliases(providers);
    providers.forEach(function (p) {
      p.shadowed = [];
      p.models = p.models.filter(function (m) {
        if (shared[m.alias]) {
          m.alias = qualifiedAlias(p.id, m.id);
          if (!m.named) m.name = m.id + " (" + p.id + ")";
        }
        if (shadowsAnthropic(m.alias)) {
          p.shadowed.push(m.id);
          warnOnce("shadow" + m.alias, "provider " + p.id + ": " + m.id + " would be listed as " + m.alias +
            ", one of Anthropic's own model ids - skipped (it would take that model's sessions away from your " +
            "subscription); give the provider another id");
          return false;
        }
        if (seenModel[m.alias]) {
          warnOnce("dup" + m.alias, seenOwner[m.alias] === p.id
            ? "provider " + p.id + ": model id " + m.id + " listed twice - keeping the first"
            : "provider " + p.id + ": " + m.id + " would be listed as " + m.alias + ", which " + seenOwner[m.alias] +
              " already lists - skipped");
          return false;
        }
        seenModel[m.alias] = m;
        seenOwner[m.alias] = p.id;
        return true;
      });
    });
    // A name two providers share is neither copy's: a reference to it says
    // which names to use instead.
    function sharedNote(name) {
      if (!shared[name]) return "";
      var names = [];
      providers.forEach(function (p) {
        p.models.forEach(function (m) { if (aliasFor(p.id, m.id) === name) names.push(m.alias); });
      });
      return "more than one provider lists - name one of " + names.join(", ");
    }
    var usable = providers.filter(function (p) { return p.models.length > 0; });

    var surfRaw = Array.isArray(a.surfaces) ? a.surfaces : (Array.isArray(b.surfaces) ? b.surfaces : null);
    var surfaces = surfRaw
      ? surfRaw.filter(function (s) { return typeof s === "string" && SURFACE_RE.test(s); })
      : DEFAULT_SURFACES;
    if (!surfaces.length) surfaces = DEFAULT_SURFACES;

    // Off by default, like every community feature: configuring a model does
    // not list it until the switch (or `enabled: true` in the .jsonc) says so.
    var enabled, source;
    if (typeof a.enabled === "boolean") { enabled = a.enabled; source = "jsonc-locked"; }
    else if (typeof b.enabled === "boolean") { enabled = b.enabled; source = "json"; }
    else { enabled = false; source = "default"; }

    // Web search is one app-wide choice (the CLI sends one sub-request per
    // search, whatever the session's model): the .jsonc value, else the
    // .json one, else - for configs written before it was global - the first
    // provider that names one. Resolved to the alias of a configured model.
    var wsRaw = typeof a.webSearch === "string" ? a.webSearch
      : (typeof b.webSearch === "string" ? b.webSearch : "");
    var wsLocked = typeof a.webSearch === "string";
    var wsFrom = null;
    if (!wsRaw) usable.some(function (p) { if (p.webSearch) { wsRaw = p.webSearch; wsFrom = p; return true; } return false; });
    var webSearch = "";
    if (wsRaw.trim()) {
      // The [1m] spelling the picker shows names the same model.
      var want = wsRaw.trim().replace(/\[1m\]$/, "");
      var alias = want.indexOf(ID_PREFIX) === 0 ? want : ID_PREFIX + want;
      // A provider's own webSearch names one of its models, by id or alias.
      if (wsFrom) {
        wsFrom.models.forEach(function (m) {
          if (m.id === want || m.alias === alias || aliasFor(wsFrom.id, m.id) === alias) alias = m.alias;
        });
      }
      if (seenModel[alias]) {
        if (seenModel[alias].webSearch) webSearch = alias;
        else warnOnce("wsno" + want, "webSearch names " + want + ", which is marked without the web search tool - web search stays on Anthropic");
      } else if (anthropicKnown(want)) webSearch = want;
      else warnOnce("ws" + want, "webSearch names " + want + ", which " + (sharedNote(alias) ||
        "is neither a configured model nor an Anthropic model the picker lists") + " - web search stays on Anthropic");
    }

    // The CLI's "small/fast model" slot (ANTHROPIC_SMALL_FAST_MODEL): WebFetch
    // page synthesis, the mid-turn intent classifier, and - when webSearch is
    // not set - the web-search sub-request run on it. A custom alias (the
    // preload routes it), or any Anthropic id, or "" for the CLI's own small
    // default. Resolved like webSearch: .jsonc value, else .json, but - unlike
    // webSearch - no per-provider fallback (there was none to inherit from).
    var sfRaw = typeof a.smallFastModel === "string" ? a.smallFastModel
      : (typeof b.smallFastModel === "string" ? b.smallFastModel : "");
    var sfLocked = typeof a.smallFastModel === "string";
    var smallFastModel = "";
    if (sfRaw.trim()) {
      var sfWant = sfRaw.trim().replace(/\[\w+\]$/, ""); // the [1m] twin is not the small/fast one
      var sfAlias = sfWant.indexOf(ID_PREFIX) === 0 ? sfWant : ID_PREFIX + sfWant;
      if (seenModel[sfAlias]) smallFastModel = sfAlias;
      else if (anthropicKnown(sfWant)) smallFastModel = sfWant;
      else warnOnce("sf" + sfWant, "smallFastModel names " + sfWant + ", which " + (sharedNote(sfAlias) ||
        "is neither a configured model nor an Anthropic model the picker lists") + " - the small/fast model stays on Anthropic");
    }
    // While no web-search model is set, the CLI sends its web-search
    // sub-request to the session's model or to the small/fast one (a server
    // flag decides): a custom model without the web search tool cannot answer
    // it, and the preload refuses it with that reason.
    var searchConflict = "";
    if (!webSearch) {
      var noTool = [];
      usable.forEach(function (p) { p.models.forEach(function (m) { if (m.webSearch === false) noTool.push(m.name); }); });
      if (noTool.length) {
        searchConflict = noTool.join(", ") + (noTool.length === 1 ? " is" : " are") + " marked without the web search tool. " +
          "While no web-search model is set, a web search goes to the session's model or to the small/fast model (Claude Code " +
          "decides) and fails on " + (noTool.length === 1 ? "it" : "those") + ". Pick a web-search model to search from any session.";
        if (smallFastModel && seenModel[smallFastModel] && seenModel[smallFastModel].webSearch === false) {
          warnOnce("sfws" + smallFastModel, "smallFastModel " + smallFastModel + " has no web search tool and webSearch is unset - web searches may be refused");
        }
      }
    }

    // Sub-agent type names, one per model that has one: the configured name
    // when valid, else the display name slugged; never a built-in's, never
    // twice - the provider id, then a counter, break a tie.
    var usedNames = Object.create(null);
    usable.forEach(function (p) {
      p.models.forEach(function (m) {
        if (!m.agent) return;
        var want = m.agentWanted || "";
        if (want && !AGENT_NAME_RE.test(want)) {
          warnOnce("agname" + m.alias, "model " + m.id + ": agent.name \"" + want + "\" is not lowercase letters, digits and - (max 40) - name generated instead");
          want = "";
        }
        if (!want) want = slug(m.name) || slug(m.id) || "custom-model";
        if (RESERVED_AGENT_NAMES.indexOf(want) !== -1) want = slug(want + "-" + p.id);
        var name = want;
        if (usedNames[name]) name = slug(want + "-" + p.id);
        for (var n = 2; usedNames[name]; n++) name = slug(want + "-" + n);
        usedNames[name] = true;
        m.agentName = name;
      });
    });

    // The default sub-agent model (CLAUDE_CODE_SUBAGENT_MODEL): what a
    // sub-agent whose definition names no model runs on - the CLI's own
    // general-purpose and Plan included; not Explore, which the CLI pins to
    // "inherit" (the session's model), and not a type with a model of its own
    // (checked in the CLI 2.1.266: CLAUDE_CODE_SUBAGENT_MODEL_FORCE would
    // override those too, ours included - not offered). "" = the CLI's own
    // default, the session's model. Resolved to the listed id.
    var samRaw = typeof a.subagentModel === "string" ? a.subagentModel
      : (typeof b.subagentModel === "string" ? b.subagentModel : "");
    var samLocked = typeof a.subagentModel === "string";
    var subagentModel = "";
    if (samRaw.trim()) {
      var samWant = samRaw.trim().replace(/\[1m\]$/, "");
      var samAlias = samWant.indexOf(ID_PREFIX) === 0 ? samWant : ID_PREFIX + samWant;
      if (seenModel[samAlias]) subagentModel = agentModelId(seenModel[samAlias]);
      else warnOnce("sam" + samWant, "subagentModel names " + samWant + ", which " + (sharedNote(samAlias) ||
        "is not a configured model") + " - sub-agents keep the CLI's default");
    }
    // Whether every new session's system prompt gets the one line that tells
    // Claude these models and sub-agent types exist (announceText).
    var announce = typeof a.announce === "boolean" ? a.announce
      : (typeof b.announce === "boolean" ? b.announce : true);
    var announceLocked = typeof a.announce === "boolean";

    return { enabled: enabled, source: source, surfaces: surfaces, providers: usable,
      allProviders: providers, configured: usable.length > 0,
      webSearch: webSearch, webSearchLocked: wsLocked,
      smallFastModel: smallFastModel, smallFastModelLocked: sfLocked, searchConflict: searchConflict,
      subagentModel: subagentModel, subagentModelLocked: samLocked,
      announce: announce, announceLocked: announceLocked };
  }
  function activeConfig() {
    var c = readConfig();
    return c.enabled && c.configured ? c : null;
  }

  // Writes ONLY the .json, tmp + rename, every other key survives. A broken
  // existing file refuses instead of being overwritten (see panel_tabs_main.js
  // for the reasoning; same contract here). `mutate(customModels)` edits the
  // key in place and returns nothing.
  function writeJson(mutate) {
    var p = pathFor(JSON_NAME);
    if (!p) return { ok: false, error: "no userData path" };
    var raw = null;
    try { raw = _fs.readFileSync(p, "utf8"); }
    catch (e) {
      if (e.code !== "ENOENT") return { ok: false, error: "cannot read " + p + ": " + ((e && e.message) || String(e)) };
    }
    var cfg = {};
    if (raw !== null) {
      var stripped = stripComments(raw);
      try { cfg = stripped.trim() ? JSON.parse(stripped) : {}; }
      catch (e2) {
        return { ok: false, error: p + " is not valid JSON (" + e2.message + ") - fix or remove it first; nothing was written" };
      }
      if (!isObj(cfg)) return { ok: false, error: p + " must contain a JSON object; nothing was written" };
      if (stripped !== raw) {
        try { _fs.writeFileSync(p + ".cdb-bak", raw, { flag: "wx" }); } catch (e3) {}
      }
    }
    var cur = isObj(cfg[PREF_KEY]) ? cfg[PREF_KEY] : {};
    mutate(cur);
    if (Object.keys(cur).length) cfg[PREF_KEY] = cur; else delete cfg[PREF_KEY];
    var tmp = p + ".cdb-tmp";
    try {
      _fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      _fs.renameSync(tmp, p);
    } catch (e4) {
      try { _fs.unlinkSync(tmp); } catch (e5) {}
      return { ok: false, error: "cannot write " + p + ": " + ((e4 && e4.message) || String(e4)) };
    }
    syncRoutes();
    return { ok: true, path: p };
  }
  function writePref(value) {
    return writeJson(function (cur) { cur.enabled = value; });
  }

  // ---- picker entries -------------------------------------------------------
  // The shape is the one the live bootstrap carries for the desktop Code
  // surface (`ccd`), observed 2026-09-13 - see baseline/CUSTOM_MODELS_ANCHORS.md:
  //   { id, name, short_name, section: "main"|"overflow"|"deprecated",
  //     capabilities: {compass, gsuite_tools, mm_images, mm_pdf, web_search},
  //     thinking: { type: "effort", description, effort_options: [{id, name,
  //       badge?, tooltip?}] } | { type: "effort_and_mode", ..., mode_options }
  //       | { type: "none" },
  //     quick_select?: true, notice?, fast_mode?, min_claude_code_version? }
  // Labels are LOCALISED server-side ("Élevé", "Par défaut"), so instead of
  // shipping English strings the effort menu is copied from the first
  // Anthropic entry of the same surface that has one, filtered to the levels
  // the model offers; the English table below is only the fallback for a
  // surface with no such entry.
  var EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
  var EFFORT_NAMES = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra", max: "Max" };
  var EFFORT_DESC = "Higher effort means more thorough responses, but takes longer and uses your limits faster.";
  var DEFAULT_BADGE = { message: "Default", variant: "neutral" };
  var MODE_OPTIONS = [
    { id: "auto", name: "Thinking", description: "Can think for more complex tasks" },
    { id: "off", name: "Off" }
  ];

  // The surface's own effort menu, to borrow labels from: the first entry
  // whose thinking carries effort_options.
  function effortTemplate(surface) {
    var models = Array.isArray(surface.models) ? surface.models : [];
    for (var i = 0; i < models.length; i++) {
      var t = models[i] && models[i].thinking;
      if (isObj(t) && Array.isArray(t.effort_options) && t.effort_options.length) return t;
    }
    return null;
  }

  // The level the picker preselects: the configured one if it is offered,
  // else xhigh when offered (the app's own default for its top models), else
  // the highest level offered.
  function effortDefaultOf(m) {
    if (!m.thinking) return "";
    var levels = m.effort || EFFORT_ORDER;
    if (m.effortDefault && levels.indexOf(m.effortDefault) !== -1) return m.effortDefault;
    return levels.indexOf("xhigh") !== -1 ? "xhigh" : levels[levels.length - 1];
  }
  function thinkingSpec(m, template) {
    if (!m.thinking) return { type: "none" };
    var levels = m.effort || EFFORT_ORDER;
    var rec = effortDefaultOf(m);
    var byId = Object.create(null);
    var badge = null;
    if (template) {
      template.effort_options.forEach(function (o) {
        if (!isObj(o) || typeof o.id !== "string") return;
        byId[o.id] = o;
        if (isObj(o.badge) && !badge) badge = o.badge;
      });
    }
    var effort = levels.map(function (id) {
      var src = byId[id];
      var o = { id: id, name: src && typeof src.name === "string" ? src.name : EFFORT_NAMES[id] };
      if (src && isObj(src.tooltip)) o.tooltip = JSON.parse(JSON.stringify(src.tooltip));
      if (id === rec) { o.recommended = true; o.badge = JSON.parse(JSON.stringify(badge || DEFAULT_BADGE)); }
      return o;
    });
    var out = { type: "effort", description: template && typeof template.description === "string" ? template.description : EFFORT_DESC,
      effort_options: effort };
    if (template && Array.isArray(template.mode_options) && template.mode_options.length) {
      out.type = "effort_and_mode";
      out.mode_options = JSON.parse(JSON.stringify(template.mode_options));
    } else if (template && template.type === "effort_and_mode") {
      out.type = "effort_and_mode";
      out.mode_options = MODE_OPTIONS.map(function (o) { return Object.assign({}, o); });
    }
    return out;
  }

  function pickerEntries(m, surface) {
    var base = {
      id: m.alias,
      name: m.name,
      short_name: m.shortName || m.name,
      description: m.description,
      section: m.section,
      capabilities: { compass: true, gsuite_tools: true, mm_images: m.vision, mm_pdf: false, web_search: m.webSearch },
      thinking: thinkingSpec(m, effortTemplate(surface))
    };
    if (m.section === "main") base.quick_select = true;
    if (m.badge) base.badge = { message: m.badge, variant: "neutral" };
    // "1m": the [1m] spelling is the only one listed, under the plain name -
    // no supports_1m_context, which is what makes the page append " 1M".
    if (m.context === "1m") return [Object.assign({}, base, { id: m.alias + "[1m]" })];
    if (m.context !== "both") return [base];
    return [base, Object.assign({}, base, { id: m.alias + "[1m]", description: "1M context window", supports_1m_context: true })];
  }

  // Pure: returns the enriched bootstrap, or null when there is nothing to do
  // (no config, no model_selector_config, every entry already present).
  // `choices` (optional) is the selection store: {<state id>: {model, thinking}}.
  function enrichBootstrap(boot, cfg, choices) {
    if (!isObj(boot) || !Array.isArray(boot.model_selector_config)) return null;
    if (!cfg || !cfg.providers.length) return null;
    var changed = false;
    var aliases = listedAliases(cfg);
    boot.model_selector_config.forEach(function (surface) {
      if (!isObj(surface) || cfg.surfaces.indexOf(surface.id) === -1) return;
      if (!Array.isArray(surface.models)) surface.models = [];
      var have = Object.create(null);
      surface.models.forEach(function (e) { if (isObj(e) && typeof e.id === "string") have[e.id] = true; });
      cfg.providers.forEach(function (p) {
        p.models.forEach(function (m) {
          pickerEntries(m, surface).forEach(function (e) {
            if (have[e.id]) return;
            surface.models.push(e);
            have[e.id] = true;
            changed = true;
          });
        });
      });
    });
    // The remembered choice: what the server would carry for an Anthropic
    // model, applied to the state of the surfaces the page writes to.
    if (choices && Array.isArray(boot.model_selector_state)) {
      boot.model_selector_state.forEach(function (st) {
        if (!isObj(st) || typeof st.id !== "string") return;
        var c = choices[st.id];
        if (!c || !aliases[c.model]) return;
        if (st.model !== c.model) { st.model = c.model; changed = true; }
        var th = isObj(c.thinking) ? c.thinking : defaultThinkingState(aliases[c.model]);
        if (th) {
          st.thinking = JSON.parse(JSON.stringify(th));
          if (!Array.isArray(st.thinking_by_model)) st.thinking_by_model = [];
          var found = false;
          st.thinking_by_model.forEach(function (e) {
            if (isObj(e) && e.id === c.model) { e.thinking = JSON.parse(JSON.stringify(th)); found = true; }
          });
          if (!found) st.thinking_by_model.push({ id: c.model, thinking: JSON.parse(JSON.stringify(th)) });
          changed = true;
        }
      });
    }
    return changed ? boot : null;
  }
  function defaultThinkingState(m) {
    if (!m || !m.thinking) return null;
    return { type: "effort", effort: effortDefaultOf(m) };
  }

  // ---- remembered selection --------------------------------------------------
  // The page persists the picked model server-side: PATCH /api/organizations/
  // <org>/model_selector_state/<surface> with {model, thinking...}, answered
  // with the surface's state ({id, model, thinking_by_model:[...]}) and
  // returned in every bootstrap. claude.ai refuses an id it does not know
  // (400 model_not_selectable), so a custom model would be forgotten the
  // moment the session ends. The store below is that server state, kept in
  // the profile for our models only: a refused PATCH for one of ours is
  // answered locally in the server's own shape and remembered, and the next
  // bootstrap carries the choice back exactly as it would for Opus. A PATCH
  // the server accepts (an Anthropic model was picked) drops the memory for
  // that surface, so the server's state wins again.
  var STATE_NAME = "selection.json";
  function statePath() {
    var d = pathFor(SUBDIR);
    return d ? _path.join(d, STATE_NAME) : null;
  }
  function readChoices() {
    var v = readFileJson(statePath());
    var out = Object.create(null);
    if (v) Object.keys(v).forEach(function (k) {
      if (isObj(v[k]) && typeof v[k].model === "string") out[k] = v[k];
    });
    return out;
  }
  function writeChoices(map) {
    var p = statePath();
    if (!p) return;
    try {
      ensureDir(_path.dirname(p));
      var tmp = p + ".cdb-tmp";
      _fs.writeFileSync(tmp, JSON.stringify(map, null, 2) + "\n", { encoding: "utf8", mode: 384 });
      _fs.renameSync(tmp, p);
    } catch (e) { log("cannot write " + p + ": " + (e && e.message ? e.message : String(e))); }
  }
  // The last state the server sent for each surface, to answer a refused
  // PATCH with a complete object (thinking_by_model for every other model).
  var lastServerState = Object.create(null);
  // The Anthropic models the bootstrap listed for the first configured
  // surface, so the panel can offer them as web-search targets by name.
  var lastAnthropicModels = [];
  // Returns true when a configured model turned out to carry the id of an
  // Anthropic one this bootstrap lists: the caller reads the config again.
  function rememberServerState(boot, cfg) {
    if (!isObj(boot)) return false;
    if (Array.isArray(boot.model_selector_state)) {
      boot.model_selector_state.forEach(function (st) {
        if (isObj(st) && typeof st.id === "string") lastServerState[st.id] = JSON.parse(JSON.stringify(st));
      });
    }
    var collided = false;
    if (Array.isArray(boot.model_selector_config)) {
      // This is the server's own list (read before enrichBootstrap), so every
      // claude- id in it is Anthropic's.
      boot.model_selector_config.forEach(function (sf) {
        if (!isObj(sf) || !Array.isArray(sf.models)) return;
        sf.models.forEach(function (m) {
          if (isObj(m) && typeof m.id === "string" && ANTHROPIC_ID_RE.test(m.id.replace(/\[1m\]$/, ""))) {
            serverAnthropicIds[m.id.replace(/\[1m\]$/, "")] = true;
          }
        });
      });
      collided = !!cfg && cfg.providers.some(function (p) {
        return p.models.some(function (m) { return shadowsAnthropic(m.alias); });
      });
      var want = cfg && cfg.surfaces ? cfg.surfaces[0] : DEFAULT_SURFACES[0];
      boot.model_selector_config.forEach(function (sf) {
        if (!isObj(sf) || sf.id !== want || !Array.isArray(sf.models)) return;
        var ours = Object.create(null);
        (cfg ? cfg.providers : []).forEach(function (p) {
          p.models.forEach(function (m) {
            if (shadowsAnthropic(m.alias)) return;
            ours[m.alias] = true; ours[m.alias + "[1m]"] = true;
          });
        });
        lastAnthropicModels = sf.models.filter(function (m) {
          return isObj(m) && typeof m.id === "string" && ANTHROPIC_ID_RE.test(m.id) && !ours[m.id] &&
            !(isObj(m.capabilities) && m.capabilities.web_search === false) && m.section !== "deprecated";
        }).map(function (m) { return { id: m.id, name: typeof m.name === "string" ? m.name : m.id }; });
      });
    }
    return collided;
  }
  function surfaceOf(url) {
    var m = /\/model_selector_state\/([a-z0-9_]+)(?:[?#]|$)/.exec(String(url));
    return m ? m[1] : null;
  }
  // Pure: given the surface, the page's request body, the response status
  // and the configured aliases, decide what to store and what to answer.
  // Returns { choices: <new store or null when unchanged>, reply: <body or null> }.
  function selectionOutcome(surface, method, reqBody, status, cfg, choices) {
    if (method !== "PATCH" || !surface) return { choices: null, reply: null };
    var aliases = listedAliases(cfg);
    var req = null;
    try { req = JSON.parse(reqBody || ""); } catch (e) {}
    if (!isObj(req)) return { choices: null, reply: null };
    var carriesModel = typeof req.model === "string";
    var ours = carriesModel && !!aliases[req.model];
    var next = Object.assign(Object.create(null), choices);
    var remembered = next[surface] && aliases[next[surface].model] ? next[surface] : null;
    if (status >= 200 && status < 300) {
      // The server took it. A model it knows (an Anthropic one was picked):
      // its state is authoritative again. A write without a model - the
      // page adjusting the thinking or fast mode of the CURRENT model - is
      // applied by the server to the model it holds (Opus), not to ours:
      // the memory stays, updated with the thinking the page asked for, and
      // the page gets our state back instead of the server's.
      if (carriesModel) {
        if (remembered) { delete next[surface]; return { choices: next, reply: null }; }
        return { choices: null, reply: null };
      }
      if (!remembered) return { choices: null, reply: null };
      if (isObj(req.thinking)) remembered.thinking = req.thinking;
      return { choices: next, reply: stateReply(surface, remembered.model, remembered.thinking) };
    }
    if (!ours || status < 400) return { choices: null, reply: null };
    var thinking = isObj(req.thinking) ? req.thinking : defaultThinkingState(aliases[req.model]);
    next[surface] = { model: req.model, thinking: thinking };
    return { choices: next, reply: stateReply(surface, req.model, thinking) };
  }
  // Every id a configured model is listed under -> the model.
  function listedAliases(cfg) {
    var aliases = Object.create(null);
    cfg.providers.forEach(function (p) { p.models.forEach(function (m) {
      listedIds(m).forEach(function (id) { aliases[id] = m; });
    }); });
    return aliases;
  }
  // The server's own answer shape for a surface, built on the last state it
  // sent (thinking_by_model for every other model) with our model on top.
  function stateReply(surface, model, thinking) {
    var base = lastServerState[surface] ? JSON.parse(JSON.stringify(lastServerState[surface])) : { id: surface };
    var reply = { id: surface, model: model, thinking_by_model: Array.isArray(base.thinking_by_model) ? base.thinking_by_model : [] };
    if (thinking) {
      reply.thinking = JSON.parse(JSON.stringify(thinking));
      var found = false;
      reply.thinking_by_model.forEach(function (e) { if (isObj(e) && e.id === model) { e.thinking = thinking; found = true; } });
      if (!found) reply.thinking_by_model.push({ id: model, thinking: thinking });
    }
    return reply;
  }
  function onSelectionPaused(wc, params) {
    var dbg = wc.debugger;
    var id = params.requestId;
    function release() { dbg.sendCommand("Fetch.continueRequest", { requestId: id }).catch(function () {}); }
    var cfg = activeConfig();
    if (!cfg) { release(); return; }
    var surface = surfaceOf(params.request.url);
    var out = selectionOutcome(surface, params.request.method, params.request.postData, params.responseStatusCode, cfg, readChoices());
    if (out.choices) writeChoices(out.choices);
    if (!out.reply) { release(); return; }
    var body = Buffer.from(JSON.stringify(out.reply), "utf8").toString("base64");
    dbg.sendCommand("Fetch.fulfillRequest", {
      requestId: id, responseCode: 200,
      responseHeaders: [{ name: "content-type", value: "application/json" }],
      body: body
    }).then(function () {
      log("selection: " + out.reply.model + " kept locally for surface " + surface + (params.responseStatusCode >= 400
        ? " (claude.ai does not know that id, HTTP " + params.responseStatusCode + " - expected)" : " (thinking updated)"));
    }, function (e) {
      log("selection: " + (e && e.message ? e.message : String(e)));
      release();
    });
  }

  // ---- bootstrap interception (CDP Fetch domain) ----------------------------
  // The page's own scripts run before dom-ready, so an executeJavaScript
  // fetch hook would arrive after the bootstrap request has left. The Fetch
  // domain pauses the RESPONSE in the network stack instead, whatever the
  // timing, and only for the URL patterns below - every other request is
  // untouched. DevTools can be open at the same time (Chromium multiplexes
  // clients). Every paused request MUST be released (fulfill or continue) or
  // the page hangs on it, hence the fail-open shape of onPaused.
  // The page fetches /edge-api/bootstrap/<org>/app_start (observed) or the
  // /api/ spelling of the same endpoint (the app's own 3p stub list names
  // both), and re-fetches it on its own schedule; each response is enriched.
  var PATTERNS = [];
  ["claude.ai", "*.claude.ai", "claude.com", "*.claude.com"].forEach(function (h) {
    ["/api/bootstrap", "/edge-api/bootstrap"].forEach(function (base) {
      // The bare endpoint (with or without a query) and the per-org app_start;
      // the other /bootstrap/<org>/* sub-resources are not paused at all.
      PATTERNS.push("*://" + h + base, "*://" + h + base + "?*", "*://" + h + base + "/*/app_start*");
    });
    PATTERNS.push("*://" + h + "/api/organizations/*/model_selector_state/*");
  });
  function hostOk(rawUrl) {
    var host;
    try { host = new _URL(String(rawUrl)).hostname; } catch (e) { return false; }
    return host === "claude.ai" || host.endsWith(".claude.ai") ||
      host === "claude.com" || host.endsWith(".claude.com");
  }
  function dropHopHeaders(headers) {
    return (Array.isArray(headers) ? headers : []).filter(function (h) {
      var n = String(h && h.name || "").toLowerCase();
      return n !== "content-length" && n !== "content-encoding" && n !== "transfer-encoding";
    });
  }

  function onPaused(wc, params) {
    var dbg = wc.debugger;
    var id = params.requestId;
    function release() { dbg.sendCommand("Fetch.continueRequest", { requestId: id }).catch(function () {}); }
    if (params.responseErrorReason || typeof params.responseStatusCode !== "number") { release(); return; }
    if (/\/model_selector_state\//.test(params.request.url)) { onSelectionPaused(wc, params); return; }
    if (params.responseStatusCode !== 200) { release(); return; }
    var cfg = activeConfig();
    if (!cfg) { release(); return; }
    dbg.sendCommand("Fetch.getResponseBody", { requestId: id }).then(function (res) {
      var text = res.base64Encoded ? Buffer.from(res.body, "base64").toString("utf8") : res.body;
      var boot;
      try { boot = JSON.parse(text); }
      catch (e) { log("bootstrap: not JSON (" + e.message + ") - passing the response through"); release(); return; }
      if (DEBUG) {
        try {
          log("debug: bootstrap surfaces " + (boot.model_selector_config || []).map(function (sf) {
            return sf.id + "[" + (sf.models || []).map(function (m) { return m.id; }).join("|") + "]";
          }).join(" "));
        } catch (e) {}
      }
      if (rememberServerState(boot, cfg)) {
        syncRoutes();
        cfg = activeConfig();
        if (!cfg) { release(); return; }
      }
      var out = enrichBootstrap(boot, cfg, readChoices());
      if (!out) { release(); return; }
      var body = Buffer.from(JSON.stringify(out), "utf8").toString("base64");
      return dbg.sendCommand("Fetch.fulfillRequest", {
        requestId: id,
        responseCode: params.responseStatusCode,
        responseHeaders: dropHopHeaders(params.responseHeaders),
        body: body
      }).then(function () {
        var n = 0;
        cfg.providers.forEach(function (p) { n += p.models.length; });
        log("bootstrap enriched: " + n + " custom model(s) on " + cfg.surfaces.join(",") + " (" + params.request.url + ")");
      });
    }).catch(function (e) {
      log("bootstrap: " + (e && e.message ? e.message : String(e)) + " - passing the response through");
      release();
    });
  }

  function safeUrl(wc) {
    try { return wc.getURL() || "(no url yet)"; } catch (e) { return "(no url)"; }
  }
  // The webContents we attached to, so turning the feature off can detach
  // from them at once instead of pausing (and releasing) the page's requests
  // until the next restart.
  var attachedTo = new Set();
  function attach(wc) {
    if (wc.__cdbCmAttached) return;
    var dbg = wc.debugger;
    if (!dbg) return;
    try { dbg.attach("1.3"); }
    catch (e) { log("debugger attach failed: " + (e && e.message ? e.message : String(e))); return; }
    wc.__cdbCmAttached = true;
    attachedTo.add(wc);
    // Listeners once per webContents: a re-attach after a detach must not
    // handle every paused request twice.
    if (!wc.__cdbCmListening) {
      wc.__cdbCmListening = true;
      dbg.on("message", function (_ev, method, params) {
        if (method === "Fetch.requestPaused") {
          try { onPaused(wc, params); }
          catch (e) { dbg.sendCommand("Fetch.continueRequest", { requestId: params.requestId }).catch(function () {}); }
        } else if (DEBUG && method === "Network.requestWillBeSent") {
          // CDB_CUSTOM_MODELS_DEBUG=1: every API request the page makes, path
          // only, so a moved bootstrap endpoint can be found again from the log.
          try {
            var u = new _URL(params.request.url);
            if (/^\/(edge-)?api\//.test(u.pathname)) log("debug: page " + params.request.method + " " + u.pathname);
          } catch (e) {}
        }
      });
      dbg.on("detach", function (_ev, reason) {
        wc.__cdbCmAttached = false;
        attachedTo.delete(wc);
        log("debugger detached (" + reason + ")" + (activeConfig() ? " - re-attaching on the next navigation" : ""));
      });
    }
    if (DEBUG) dbg.sendCommand("Network.enable").catch(function () {});
    dbg.sendCommand("Fetch.enable", {
      patterns: PATTERNS.map(function (u) { return { urlPattern: u, requestStage: "Response" }; })
    }).then(function () {
      log("watching /api/bootstrap responses on " + safeUrl(wc));
    }, function (e) {
      log("Fetch.enable failed: " + (e && e.message ? e.message : String(e)));
    });
  }

  _app.on("web-contents-created", function (_ev, wc) {
    // Only claude.ai/claude.com main frames; attach BEFORE the navigation
    // commits so the first bootstrap fetch is already covered.
    wc.on("did-start-navigation", function (details, url, isInPlace, isMainFrame) {
      try {
        var d = details && typeof details === "object" && "url" in details ? details : null;
        var u = d ? d.url : url;
        var main = d ? d.isMainFrame !== false : isMainFrame !== false;
        if (!main || !hostOk(u)) return;
        // Off (or nothing configured): no debugger at all - the page's
        // requests are not even paused.
        if (!activeConfig()) return;
        attach(wc);
      } catch (e) {}
    });
  });
  // Turned off: let go of every page now. Turned on: the next navigation
  // (the panel's Reload button) attaches.
  function detachAll() {
    attachedTo.forEach(function (wc) {
      try { if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach(); } catch (e) {}
      wc.__cdbCmAttached = false;
    });
    attachedTo.clear();
  }

  // ---- CLI environment ------------------------------------------------------
  // Called at every local Code session spawn (sub-patch B). Writes the preload
  // under userData (profile-isolated) when its content changed, and returns
  // the env to splice in, or {} when the feature is off - in which case the
  // session is exactly upstream's.
  function ensurePreload() {
    var dir = pathFor(SUBDIR);
    if (!dir) return null;
    var p = _path.join(dir, PRELOAD_NAME);
    try {
      ensureDir(dir);
      var cur = null;
      try { cur = _fs.readFileSync(p, "utf8"); } catch (e) {}
      if (cur !== PRELOAD_SRC) {
        var tmp = p + ".cdb-tmp";
        _fs.writeFileSync(tmp, PRELOAD_SRC, { encoding: "utf8", mode: 420 });
        _fs.renameSync(tmp, p);
      }
      return p;
    } catch (e) {
      log("cannot write " + p + ": " + (e && e.message ? e.message : String(e)));
      return null;
    }
  }
  // Windows only: the preload path with its profile directory in 8.3 short
  // form (C:\Users\JOHNSM~1\...\Claude), so it carries no space. Only the
  // profile directory is shortened: the custom-models\preload.js tail stays
  // spelled out, which remoteSpawn() recognises. null when the volume does not
  // generate short names or the path holds a character cmd would expand.
  var shortPathCache = Object.create(null);
  function shortPreloadPath(p) {
    if (process.platform !== "win32") return null;
    var profileDir = _path.dirname(_path.dirname(p));
    var tail = p.slice(profileDir.length);
    if (/\s/.test(tail) || /["%^!&|<>]/.test(profileDir)) return null;
    if (!(profileDir in shortPathCache)) {
      var short = null;
      try {
        // windowsVerbatimArguments: Node's own quoting (\") means nothing to
        // cmd. The path is checked above for every character cmd treats
        // specially inside quotes.
        var out = require("child_process").execFileSync(process.env.ComSpec || "cmd.exe",
          ["/d", "/c", "for %I in (\"" + profileDir + "\") do @echo %~sI"],
          { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true, timeout: 5000 });
        var line = String(out).split(/\r?\n/)[0].trim();
        if (line && !/\s/.test(line) && _path.isAbsolute(line)) short = line;
      } catch (e) { log("short path lookup failed: " + (e && e.message ? e.message : String(e))); }
      shortPathCache[profileDir] = short;
      if (short) log("profile path has a space; the preload is loaded through its short form " + short);
    }
    return shortPathCache[profileDir] ? shortPathCache[profileDir] + tail : null;
  }

  // The routing payload the preload works from: providers with their keys,
  // models with what the sanitiser needs, the app-wide web-search target.
  function routesPayload(cfg) {
    if (!cfg) return { providers: [] };
    var payload = { providers: cfg.providers.map(function (p) {
      var o = { id: p.id, baseUrl: p.baseUrl, apiKey: p.apiKey,
        models: p.models.map(function (m) {
          return { id: m.id, alias: m.alias, vision: m.vision, thinking: m.thinking, webSearch: m.webSearch };
        }) };
      if (p.native) o.native = true;
      if (p.headers) o.headers = p.headers;
      if (p.userAgent) o.userAgent = p.userAgent;
      if (p.stripBillingHeader) o.stripBillingHeader = true;
      if (p.effortExplicit) o.effort = p.effort.slice();
      if (p.effortMap) o.effortMap = p.effortMap;
      return o;
    }) };
    if (cfg.webSearch) payload.webSearch = cfg.webSearch;
    return payload;
  }
  function routesPath() {
    var d = pathFor(SUBDIR);
    return d ? _path.join(d, ROUTES_NAME) : null;
  }
  // Rewrites routes.json from the current configuration - the sessions
  // already open re-read it on their next request, so a key fixed, a model
  // added or a provider removed takes effect without a restart. Off (or
  // nothing configured) writes an empty list, which stops the routing in
  // those sessions the same way. Only written when the content changed.
  var lastRoutesText = null;
  function syncRoutes() {
    var p = routesPath();
    if (!p) return;
    var active = activeConfig();
    if (!active) detachAll();
    try {
      var text = JSON.stringify(routesPayload(active), null, 2) + "\n";
      // Unchanged and still there: nothing to write. Deleted behind our back:
      // written again, or new sessions would start without their keys.
      if (text === lastRoutesText && _fs.existsSync(p)) return;
      ensureDir(_path.dirname(p));
      var tmp = p + ".cdb-tmp";
      _fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 384 });
      _fs.renameSync(tmp, p);
      lastRoutesText = text;
      watchForRoutes();
    } catch (e) { log("cannot write " + p + ": " + (e && e.message ? e.message : String(e))); }
  }
  // `base` is the env upstream is about to hand the session (sub-patch B
  // passes it): what we add builds on it - the user's own Code-tab variables
  // included - rather than on the app's process.env.
  function cliEnv(base) {
    try {
      var cfg = activeConfig();
      if (DEBUG) log("debug: cliEnv() called, active=" + !!cfg);
      if (!cfg) return {};
      var preload = ensurePreload();
      if (!preload) return {};
      // BUN_OPTIONS is split on whitespace: a preload path with a space in it
      // would load nothing, or break the CLI's start. On Windows, where the
      // user folder often has one (C:\Users\John Smith), try its 8.3 short
      // form first; otherwise leave the session alone.
      if (/\s/.test(preload)) preload = shortPreloadPath(preload) || preload;
      if (/\s/.test(preload)) {
        warnOnce("preloadpath", "the profile path " + JSON.stringify(preload) + " contains whitespace, which BUN_OPTIONS cannot carry" + (process.platform === "win32" ? " (and the volume gave no space-free 8.3 short name)" : "") + " - sessions are not routed");
        return {};
      }
      syncRoutes();
      var from = isObj(base) ? base : process.env;
      var logDir = pathFor("logs");
      var prior = typeof from.BUN_OPTIONS === "string" ? from.BUN_OPTIONS.trim() : "";
      var opt = "--preload=" + preload;
      // The routes travel in the environment WITHOUT their keys - enough for
      // the preload to know them should routes.json be unreadable, and for
      // sub-patches C and D to recognise the session. The keys stay in
      // routes.json (0600), which the preload reads at start.
      var env = {
        BUN_OPTIONS: prior && prior.indexOf(opt) === -1 ? prior + " " + opt : (prior || opt)
      };
      var rp = routesPath();
      if (rp) env.CDB_CUSTOM_MODELS_ROUTES = rp;
      if (logDir) env.CDB_CUSTOM_MODELS_LOG = _path.join(logDir, LOG_NAME);
      if (DEBUG) env.CDB_CUSTOM_MODELS_DEBUG = "1"; // the preload then logs the passthroughs too
      var owned = [];
      // The CLI's own switch for the model of every sub-agent that names none
      // - honoured with our ids the same way (checked 2026-09-14, CLI 2.1.266).
      if (cfg.subagentModel) { env.CLAUDE_CODE_SUBAGENT_MODEL = cfg.subagentModel; owned.push("CLAUDE_CODE_SUBAGENT_MODEL"); }
      // The CLI's "small/fast model" slot (getSmallFastModel()): WebFetch page
      // synthesis and the mid-turn intent classifier run on it - read by the
      // CLI at the same time (checked 2026-09-15, CLI 2.1.266: ANTHROPIC_SMALL_FAST_MODEL
      // is returned verbatim, no validation). A custom alias the preload routes;
      // an Anthropic id the CLI sends as-is.
      if (cfg.smallFastModel) { env.ANTHROPIC_SMALL_FAST_MODEL = cfg.smallFastModel; owned.push("ANTHROPIC_SMALL_FAST_MODEL"); }
      // Which of the CLI's own variables we set, and what they held before,
      // so remoteSpawn() can give an SSH session back exactly upstream's.
      var payload = routesPayload(cfg);
      payload.providers.forEach(function (p) { delete p.apiKey; });
      if (owned.length) {
        payload.envKeys = owned;
        payload.envPrior = {};
        owned.forEach(function (k) { if (typeof from[k] === "string") payload.envPrior[k] = from[k]; });
      }
      env.CDB_CUSTOM_MODELS_JSON = JSON.stringify(payload);
      return env;
    } catch (e) {
      log("cliEnv: " + (e && e.message ? e.message : String(e)) + " - session left untouched");
      return {};
    }
  }

  // Sub-patch D, at the start of configureSSHSpawn(options, ...): an SSH (or
  // WSL) session runs its CLI on another host, where the preload is not. The
  // Code session env it starts from is the one cliEnv() fed, and the remote
  // spawner forwards CLAUDE_*/ANTHROPIC_* variables (since v4.29.0 through an
  // allowlist that still includes the model slots, e.g. ANTHROPIC_MODEL and
  // CLAUDE_CODE_SUBAGENT_MODEL) - so the model
  // slots we set would name ids nothing routes there. Take back what
  // cliEnv() added: the remote session is exactly upstream's, and without
  // CDB_CUSTOM_MODELS_JSON sub-patch C hands it no sub-agent type either.
  var PRELOAD_TOKEN_RE = /^--preload=.*custom-models[\\/]preload\.js$/;
  var CLI_ENV_KEYS = ["CDB_CUSTOM_MODELS_JSON", "CDB_CUSTOM_MODELS_ROUTES", "CDB_CUSTOM_MODELS_LOG", "CDB_CUSTOM_MODELS_DEBUG"];
  function remoteSpawn(opts) {
    try {
      var env = opts && opts.env;
      if (!isObj(env) || typeof env.CDB_CUSTOM_MODELS_JSON !== "string") return;
      var sent = {};
      try { sent = JSON.parse(env.CDB_CUSTOM_MODELS_JSON) || {}; } catch (e) {}
      var prior = isObj(sent.envPrior) ? sent.envPrior : {};
      (Array.isArray(sent.envKeys) ? sent.envKeys : []).forEach(function (k) {
        if (typeof k !== "string") return;
        if (typeof prior[k] === "string") env[k] = prior[k]; else delete env[k];
      });
      CLI_ENV_KEYS.forEach(function (k) { delete env[k]; });
      if (typeof env.BUN_OPTIONS === "string") {
        var kept = env.BUN_OPTIONS.split(/\s+/).filter(function (t) { return t && !PRELOAD_TOKEN_RE.test(t); }).join(" ");
        if (kept) env.BUN_OPTIONS = kept; else delete env.BUN_OPTIONS;
      }
      log("remote session: custom models left out (its CLI runs on another host, without the preload)");
    } catch (e) {
      log("remoteSpawn: " + (e && e.message ? e.message : String(e)));
    }
  }

  // Sub-patch C passes the SDK query's transport: its options.env is the
  // environment the CLI was started with. Only a session spawned with
  // cliEnv() - a local Code session, which has the preload - carries
  // CDB_CUSTOM_MODELS_JSON there. Cowork, Dispatch and every other Agent SDK
  // query come from other env builders, and an SSH session lost it in
  // remoteSpawn(): none of them can reach a custom model, so none gets the
  // sub-agent types or the line that names them.
  var warnedTransport = false;
  function sessionRouted(transport) {
    try {
      var env = transport && transport.options && transport.options.env;
      if (isObj(env)) return typeof env.CDB_CUSTOM_MODELS_JSON === "string";
      if (!warnedTransport && activeConfig()) {
        warnedTransport = true;
        log("the SDK query's transport has no options.env - upstream moved it; sub-agent types and the system-prompt line " +
          "are not handed to sessions (re-audit sub-patch C)");
      }
    } catch (e) {}
    return false;
  }

  // ---- sub-agent types and the system-prompt line ---------------------------
  // The app hands the CLI, in the `initialize` request that opens every
  // session, the same two fields the Agent SDK exposes: `agents` (programmatic
  // sub-agent definitions - what a ~/.claude/agents/<name>.md file declares,
  // without the file) and `appendSystemPrompt`. Sub-patch C of the Nim patch
  // routes both through here. A definition's `model` takes any id the CLI
  // accepts on --model, so one type per custom model gives
  // `Agent(subagent_type: <name>)` and a workflow's `agentType` on that model;
  // the Agent tool's own `model` parameter stays an enum of Anthropic tiers -
  // it cannot name ours, which is why the line below says so. Both are read
  // when the session starts: a model added later reaches the next session.
  function agentDescription(p, m) {
    return "Sub-agent running on " + m.name + " via " + p.id + ", a custom model outside Anthropic's. Use it when " +
      "a task should run on that model: give it a self-contained brief and the output format you expect.";
  }
  function agentPrompt(p, m) {
    return "You are a sub-agent running on " + m.name + ", a custom model served by " + p.id + ". Work only from " +
      "what your prompt provides; when something is missing, say so instead of guessing. Your final message is " +
      "returned to the orchestrator as data: follow the requested output format exactly, with nothing outside it.";
  }
  function agentDefs(cfg) {
    var out = {};
    cfg.providers.forEach(function (p) {
      p.models.forEach(function (m) {
        if (!m.agent || !m.agentName) return;
        out[m.agentName] = {
          description: m.agentDescription || agentDescription(p, m),
          prompt: m.agentPrompt || agentPrompt(p, m),
          model: agentModelId(m)
        };
      });
    });
    return out;
  }
  // `theirs` is whatever the app put in initConfig.agents (nothing, as of
  // 2026-09-14). The app's own definitions win a name clash; a shape we do
  // not expect is left alone.
  function agents(theirs, transport) {
    try {
      if (!sessionRouted(transport)) return theirs;
      var cfg = activeConfig();
      if (!cfg) return theirs;
      var ours = agentDefs(cfg);
      if (!Object.keys(ours).length) return theirs;
      if (theirs === undefined || theirs === null) return ours;
      if (!isObj(theirs)) return theirs;
      return Object.assign({}, ours, theirs);
    } catch (e) {
      log("agents: " + (e && e.message ? e.message : String(e)) + " - session left untouched");
      return theirs;
    }
  }
  function announceText(cfg) {
    var entries = [], types = [];
    cfg.providers.forEach(function (p) {
      p.models.forEach(function (m) {
        entries.push(listedIds(m).join(" and ") + " (" + m.name + ", " + p.id +
          (m.agent && m.agentName ? "; sub-agent type " + m.agentName : "") + ")");
        if (m.agent && m.agentName) types.push(m.agentName);
      });
    });
    var text = "Custom models available in this app (claude-desktop-extra), served by the user's own providers: " +
      entries.join("; ") + ". To run work on one of them" +
      (types.length ? ", launch its sub-agent type with the Agent tool (subagent_type), or in a workflow script " +
        "use agent(prompt, {agentType: \"<type>\"}) or agent(prompt, {model: \"<id>\"})"
        : ", in a workflow script use agent(prompt, {model: \"<id>\"})") +
      ". These ids are not valid values for the Agent tool's `model` parameter, which only accepts Anthropic tiers.";
    if (cfg.subagentModel) text += " Sub-agents launched without a model of their own run on " + cfg.subagentModel + ".";
    return text;
  }
  function appendSystemPrompt(theirs, transport) {
    try {
      if (!sessionRouted(transport)) return theirs;
      var cfg = activeConfig();
      if (!cfg || !cfg.announce) return theirs;
      var text = announceText(cfg);
      if (typeof theirs === "string") return theirs.trim() ? theirs + "\n\n" + text : text;
      if (Array.isArray(theirs)) return theirs.concat([text]);
      return text;
    } catch (e) {
      log("appendSystemPrompt: " + (e && e.message ? e.message : String(e)) + " - session left untouched");
      return theirs;
    }
  }

  // ---- IPC (Settings -> Extra) ----------------------------------------------
  // The IPC sender validator is shared: js/sender_guard.js (issue #318). Looked up
  // at call time; a missing guard fails closed.
  function okSender(ev) { var g = globalThis.__cdbSenderGuard; return !!g && g.okSender(ev); }
  function summary(cfg) {
    var models = 0;
    var providers = cfg.providers.map(function (p) {
      models += p.models.length;
      return { id: p.id, models: p.models.length, keyOk: p.apiKey.length > 8 };
    });
    return { ok: true, enabled: cfg.enabled === true && cfg.configured, configured: cfg.configured,
      lockedByJsonc: cfg.source === "jsonc-locked", source: cfg.source,
      surfaces: cfg.surfaces, models: models, providers: providers };
  }
  // The panel's view of the configuration: every provider (usable or not),
  // never a key value - only where the key comes from and whether it is there.
  function detail(cfg) {
    var out = summary(cfg);
    out.providers = cfg.allProviders.map(function (p) {
      return {
        id: p.id, baseUrl: p.baseUrl, locked: p.locked, preset: p.preset || "", modelsUrl: p.modelsUrl || "",
        keyOk: p.apiKey.length > 8, keySource: p.keySource, effort: p.effort.slice(), context: p.context,
        shadowed: p.shadowed.slice(), native: p.native === true,
        userAgent: p.userAgent || "", stripBillingHeader: p.stripBillingHeader === true,
        models: p.models.map(function (m) {
          return { id: m.id, alias: m.alias, listedAs: listedIds(m), name: m.name, description: m.description,
            vision: m.vision, thinking: m.thinking, webSearch: m.webSearch, context: m.context || p.context,
            effort: m.effort || EFFORT_ORDER.slice(), effortDefault: effortDefaultOf(m), badge: m.badge,
            // Its sub-agent type as it will be handed to the CLI, and what
            // the form shows as placeholders when nothing is customised.
            agent: m.agent, agentName: m.agent ? m.agentName || "" : "",
            agentDescription: m.agentDescription || "", agentPrompt: m.agentPrompt || "",
            // The generated name - not the resolved one, which may be the
            // user's: the form pre-fills its field only with a name that
            // differs from this, and a save sends what the field holds.
            agentDefaults: { name: m.agentWanted ? (slug(m.name) || slug(m.id)) : (m.agentName || slug(m.name) || slug(m.id)),
              description: agentDescription(p, m), prompt: agentPrompt(p, m) } };
        })
      };
    });
    out.webSearch = cfg.webSearch;
    out.webSearchLocked = cfg.webSearchLocked;
    out.smallFastModel = cfg.smallFastModel;
    out.smallFastModelLocked = cfg.smallFastModelLocked;
    out.searchConflict = cfg.searchConflict;
    out.subagentModel = cfg.subagentModel;
    out.subagentModelLocked = cfg.subagentModelLocked;
    out.announce = cfg.announce;
    out.announceLocked = cfg.announceLocked;
    out.announceText = cfg.enabled && cfg.configured && cfg.announce ? announceText(cfg) : "";
    out.anthropicModels = lastAnthropicModels.slice();
    out.paths = { json: pathFor(JSON_NAME), jsonc: pathFor(JSONC_NAME), secrets: secretsPath(), routes: routesPath() };
    out.presets = PRESETS;
    return out;
  }

  // What the "Add a provider" form offers to prefill - the endpoints known to
  // speak the Anthropic Messages API. A preset is a suggestion, every field
  // stays editable.
  var PRESETS = [
    // Static knowledge only: where the Anthropic-compatible endpoint is,
    // where the provider lists its models (OpenAI-shaped GET /v1/models,
    // Authorization: Bearer), the effort values it is known to accept and,
    // when every model it serves has it, the context window (CONTEXT_MODES).
    // Model ids are NOT listed here - they age in months; "fetch models" on
    // the card asks the provider. Endpoints as documented for Claude Code
    // (ANTHROPIC_BASE_URL) by the vendors, 2026-09; DeepSeek's verified.
    // Anthropic's own API, on your API credit: the Claude models listed next
    // to the subscription's under claude-anthropic-<model>, the CLI's
    // requests forwarded as they are (prompt caching kept).
    { id: "anthropic", label: "Anthropic API (your API credit)", baseUrl: "https://api.anthropic.com",
      modelsUrl: "https://api.anthropic.com/v1/models", keyHint: "sk-ant-api... from platform.claude.com" },
    // DeepSeek: 1M context on every model, one price whatever the length.
    { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/anthropic",
      modelsUrl: "https://api.deepseek.com/v1/models", keyHint: "sk-... from platform.deepseek.com",
      effort: ["low", "high", "max"], context: "1m" },
    { id: "glm", label: "GLM (Z.ai, international)", baseUrl: "https://api.z.ai/api/anthropic",
      keyHint: "from z.ai" },
    { id: "glm-cn", label: "GLM (Zhipu, China)", baseUrl: "https://open.bigmodel.cn/api/anthropic",
      keyHint: "from open.bigmodel.cn" },
    { id: "kimi", label: "Kimi (Moonshot, international)", baseUrl: "https://api.moonshot.ai/anthropic",
      modelsUrl: "https://api.moonshot.ai/v1/models", keyHint: "sk-... from platform.moonshot.ai" },
    { id: "minimax", label: "MiniMax (international)", baseUrl: "https://api.minimax.io/anthropic",
      keyHint: "from platform.minimax.io" },
    // OpenRouter: one key, hundreds of models (Qwen, GLM, DeepSeek, Kimi, the
    // Claude models...), Anthropic-compatible /v1/messages, public /v1/models
    // that carries each model's context length.
    { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api",
      modelsUrl: "https://openrouter.ai/api/v1/models", keyHint: "sk-or-... from openrouter.ai/keys" },
    // Opper: one gateway (backend in Stockholm) in front of hundreds of
    // models, addressed as provider/model - the provider prefix decides where
    // inference runs (EU or US routes). eu.gw.opper.ai is the EU-resident
    // host (TLS ends in Stockholm); gw.opper.ai is the global edge to the
    // same backend, same key and models. Its public /v1/models answers
    // {models: [{id, name, context_window}]}. Context and effort vary per
    // route, so neither is set here. Verified 2026-10.
    { id: "opper", label: "Opper (EU)", baseUrl: "https://eu.gw.opper.ai",
      modelsUrl: "https://eu.gw.opper.ai/v1/models", keyHint: "from platform.opper.ai/settings/api-keys" },
    { id: "qwen", label: "Qwen (DashScope)", baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
      modelsUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/models", keyHint: "sk-... from DashScope" },
    // The catch-all stays last, after the named providers (alphabetical).
    { id: "gateway", label: "Anthropic-compatible gateway (LiteLLM...)", baseUrl: "",
      keyHint: "the gateway's key" }
  ];
  function presetOf(id) {
    var out = null;
    PRESETS.forEach(function (pr) { if (pr.id === id) out = pr; });
    return out;
  }

  function cleanString(v, max) {
    return typeof v === "string" ? v.trim().slice(0, max || 200) : "";
  }
  function originOf(u) {
    try { return new _URL(String(u)).origin; } catch (e) { return null; }
  }
  // SECURITY: a key is only ever sent to the origin of the base URL it was
  // stored for. The page (remote claude.ai code) can call the IPC below, so
  // anything it may write - the base URL, the models URL - must not be able
  // to steer a stored key to another host.
  function sameOrigin(a, b) {
    var oa = originOf(a);
    return !!oa && oa === originOf(b);
  }
  // The provider fields the panel may write. The key is handled apart (it goes
  // to the secrets file); everything else lands in the .json entry.
  function providerPatch(input) {
    if (!isObj(input)) return { error: "provider must be an object" };
    var id = cleanString(input.id, 40);
    if (!PROVIDER_ID_RE.test(id)) return { error: "provider id: letters, digits, - and _ only" };
    var baseUrl = cleanString(input.baseUrl, 300).replace(/\/+$/, "");
    if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) return { error: "base URL must start with http:// or https://" };
    var out = { id: id, baseUrl: baseUrl };
    var preset = cleanString(input.preset, 40);
    if (preset && presetOf(preset)) out.preset = preset;
    var modelsUrl = cleanString(input.modelsUrl, 300);
    if (modelsUrl) {
      if (!/^https?:\/\/[^\s]+$/.test(modelsUrl)) return { error: "models URL must start with http:// or https://" };
      if (!sameOrigin(modelsUrl, baseUrl)) return { error: "models URL must be on the same host as the base URL - the key is only sent there" };
      out.modelsUrl = modelsUrl;
    }
    if (Array.isArray(input.effort)) {
      var picked = EFFORT_ORDER.filter(function (l) { return input.effort.indexOf(l) !== -1; });
      if (!picked.length) return { error: "offer at least one effort level" };
      out.effort = picked;
    }
    // Both optional: a patch that does not name them leaves them as they are;
    // an empty User-Agent or false clears them.
    if (typeof input.userAgent === "string") {
      var ua = input.userAgent.trim();
      if (ua && !USER_AGENT_RE.test(ua)) return { error: "User-Agent: printable ASCII only, at most 300 characters" };
      out.userAgent = ua;
    }
    if (typeof input.stripBillingHeader === "boolean") {
      out.stripBillingHeader = input.stripBillingHeader && originOf(baseUrl) !== ANTHROPIC_API_ORIGIN;
    }
    return { value: out };
  }
  // `levelsOf` / `contextOf`: the provider's, which the model inherits - only
  // a different value is written.
  function modelPatch(input, levelsOf, contextOf) {
    if (!isObj(input)) return { error: "model must be an object" };
    var id = cleanString(input.id, 120);
    if (!ID_RE.test(id)) return { error: "model id: letters, digits, . _ : / and - only" };
    var out = { id: id };
    var name = cleanString(input.name, 60);
    if (name && name !== id) out.name = name;
    var description = cleanString(input.description, 120);
    if (description) out.description = description;
    var badge = cleanString(input.badge, 24);
    if (badge) out.badge = badge;
    if (input.vision === false) out.vision = false;
    if (input.thinking === false) out.thinking = false;
    if (input.webSearch === false) out.webSearch = false;
    var inherited = CONTEXT_MODES.indexOf(contextOf) !== -1 ? contextOf : DEFAULT_CONTEXT;
    var context = CONTEXT_MODES.indexOf(input.context) !== -1 ? input.context : (input.context1m === true ? "both" : "");
    if (context && context !== inherited) out.context = context;
    // The levels come from the provider (levelsOf); the default is written
    // only when it differs from what the picker would preselect anyway.
    var levels = Array.isArray(levelsOf) && levelsOf.length ? levelsOf : EFFORT_ORDER.slice();
    var auto = levels.indexOf("xhigh") !== -1 ? "xhigh" : levels[levels.length - 1];
    if (typeof input.effortDefault === "string" && levels.indexOf(input.effortDefault) !== -1 &&
        input.effortDefault !== auto) out.effortDefault = input.effortDefault;
    // The sub-agent type: off is written as `agent: false`; on writes only
    // what differs from the generated name, description and prompt.
    if (input.agent === false) out.agent = false;
    else {
      var ag = {};
      var agName = cleanString(input.agentName, 40).toLowerCase();
      if (agName) {
        if (!AGENT_NAME_RE.test(agName)) return { error: "sub-agent name: lowercase letters, digits and - only (40 max)" };
        if (RESERVED_AGENT_NAMES.indexOf(agName) !== -1) return { error: "sub-agent name " + agName + " is one of Claude Code's built-in types" };
        ag.name = agName;
      }
      var agDesc = cleanString(input.agentDescription, 600);
      if (agDesc) ag.description = agDesc;
      var agPrompt = cleanString(input.agentPrompt, 6000);
      if (agPrompt) ag.prompt = agPrompt;
      if (Object.keys(ag).length) out.agent = ag;
    }
    return { value: out };
  }
  // Model fields the panel does not edit: a hand edit of the .json may set
  // them, and saving the model in the panel keeps them.
  var FILE_ONLY_MODEL_KEYS = ["effort", "shortName", "section"];
  function findJsonProvider(cur, id) {
    if (!Array.isArray(cur.providers)) cur.providers = [];
    for (var i = 0; i < cur.providers.length; i++) {
      if (isObj(cur.providers[i]) && cur.providers[i].id === id) return i;
    }
    return -1;
  }
  // The app-wide choices that name a model by alias. Removing that model (or
  // its provider) removes the choice too - left behind, a custom alias would
  // later read as an Anthropic id (both are claude-...).
  var MODEL_REF_KEYS = ["webSearch", "smallFastModel", "subagentModel"];
  function aliasOf(id) { return id.indexOf(ID_PREFIX) === 0 ? id : ID_PREFIX + id; }
  function dropModelRefs(cur, aliases) {
    MODEL_REF_KEYS.forEach(function (k) {
      if (typeof cur[k] !== "string") return;
      var v = cur[k].trim().replace(/\[\w+\]$/, "");
      if (aliases.indexOf(aliasOf(v)) !== -1) { delete cur[k]; log(k + " named " + v + ", which was removed - back to the default"); }
    });
  }
  // The aliases a provider's models are listed under in cfg (an id two
  // providers share is not aliasFor's), `ids` narrowing it to those models.
  function aliasesIn(cfg, pid, ids) {
    var out = [];
    cfg.allProviders.forEach(function (p) {
      if (p.id !== pid) return;
      p.models.forEach(function (m) { if (!ids || ids.indexOf(m.id) !== -1) out.push(m.alias); });
    });
    return out;
  }
  // Adding or removing a copy of a shared id renames the other copies
  // (sharedAliases). The app-wide choices that named one by its old alias
  // follow it to the new one, on the same provider. Returns the config to
  // answer with.
  function followRenames(before) {
    var after = readConfig();
    var key = function (p, m) { return p.id + "\u0000" + m.id; };
    var was = Object.create(null), renames = Object.create(null), any = false;
    before.allProviders.forEach(function (p) { p.models.forEach(function (m) { was[key(p, m)] = m.alias; }); });
    after.allProviders.forEach(function (p) {
      p.models.forEach(function (m) {
        var old = was[key(p, m)];
        if (old && old !== m.alias) { renames[old] = m.alias; any = true; }
      });
    });
    if (!any) return after;
    var moved = false;
    var w = writeJson(function (cur) {
      MODEL_REF_KEYS.forEach(function (k) {
        if (typeof cur[k] !== "string") return;
        var v = cur[k].trim();
        var base = v.replace(/\[\w+\]$/, "");
        var to = renames[aliasOf(base)];
        if (!to) return;
        cur[k] = to + v.slice(base.length);
        moved = true;
        log(k + " named " + base + ", now listed as " + to + " - it follows");
      });
    });
    return w.ok && moved ? readConfig() : after;
  }
  function lockedProvider(cfg, id) {
    return cfg.allProviders.some(function (p) { return p.id === id && p.locked; });
  }

  _ipc.handle("cdb-cm:pref-read", function (ev) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    return summary(readConfig());
  });

  _ipc.handle("cdb-cm:pref-set", function (ev, enabled) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    if (typeof enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
    var cfg = readConfig();
    if (cfg.source === "jsonc-locked") {
      return { ok: false, error: PREF_KEY + ".enabled is set in " + JSONC_NAME + " - edit that file to change it" };
    }
    if (enabled && !cfg.configured) {
      return { ok: false, error: "no custom model is configured - add a provider and a model in Settings > Extra > Models first" };
    }
    var w = writePref(enabled);
    if (!w.ok) return w;
    return Object.assign(summary(readConfig()), { path: w.path });
  });

  _ipc.handle("cdb-cm:config-read", function (ev) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    return detail(readConfig());
  });

  // Upsert a provider (id, baseUrl) in the .json; a non-empty apiKey goes to
  // the secrets file and the entry is marked apiKeyStored.
  _ipc.handle("cdb-cm:provider-set", function (ev, input) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    var pp = providerPatch(input);
    if (pp.error) return { ok: false, error: pp.error };
    var cfg = readConfig();
    if (lockedProvider(cfg, pp.value.id)) {
      return { ok: false, error: "provider " + pp.value.id + " is set in " + JSONC_NAME + " - edit that file to change it" };
    }
    var key = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (key && (key.length < 8 || key.length > 512 || /\s/.test(key))) return { ok: false, error: "that does not look like an API key" };
    // SECURITY: the key stays with the endpoint it was stored for. A new
    // provider, or one whose base URL moves to another origin, keeps no key
    // it was not given in this very call - neither the stored one nor a key
    // source a hand edit left in the .json. Otherwise a page could point a
    // provider at its own server and have test / fetch models / the next
    // session send it the key.
    // The new key is written first, without syncing routes.json: the .json
    // write below syncs once, when both files agree - a new key never pairs
    // with the previous host. If that write fails, the previous secrets are
    // put back.
    var before = readSecrets();
    if (key) {
      var secrets = Object.assign(Object.create(null), before);
      secrets[pp.value.id] = key;
      var ws = writeSecrets(secrets, true);
      if (!ws.ok) return ws;
    }
    var fresh = false, keyCleared = false, headersCleared = false;
    var w = writeJson(function (cur) {
      var i = findJsonProvider(cur, pp.value.id);
      var prev = i === -1 ? {} : cur.providers[i];
      var next = Object.assign({}, prev, pp.value);
      if (i === -1 || !sameOrigin(prev.baseUrl, pp.value.baseUrl)) {
        fresh = true;
        // Custom headers are credential material too (a gateway's auth
        // header): they stay with the host they were written for.
        keyCleared = i !== -1 && !key && !!(prev.apiKeyStored || prev.apiKey || prev.apiKeyEnv || prev.apiKeyFile);
        headersCleared = i !== -1 && isObj(prev.headers) && Object.keys(prev.headers).length > 0;
        delete next.apiKeyStored; delete next.apiKey; delete next.apiKeyEnv; delete next.apiKeyFile; delete next.headers;
      }
      // The preset is endpoint knowledge attached at creation: an edit that
      // does not name one keeps it - unless the base URL left the preset's
      // host, where its levels, context and models URL no longer apply.
      var pr = next.preset ? presetOf(next.preset) : null;
      if (pr && pr.baseUrl && !sameOrigin(pr.baseUrl, next.baseUrl)) { delete next.preset; pr = null; }
      // The models URL is a plain field: empty clears it.
      if (!pp.value.modelsUrl) delete next.modelsUrl;
      // Not credentials: they stay when the base URL changes host.
      if (pp.value.userAgent === "") delete next.userAgent;
      if (pp.value.stripBillingHeader === false) delete next.stripBillingHeader;
      if (pp.value.effort && pp.value.effort.length === EFFORT_ORDER.length && !(pr && pr.effort)) delete next.effort;
      if (key) next.apiKeyStored = true;
      if (!Array.isArray(next.models)) next.models = [];
      if (i === -1) cur.providers.push(next); else cur.providers[i] = next;
    });
    if (!w.ok) {
      if (key) writeSecrets(before, true);
      return w;
    }
    if (fresh && !key) {
      var stale = readSecrets();
      if (stale[pp.value.id] !== undefined) { delete stale[pp.value.id]; writeSecrets(stale); }
    }
    if (keyCleared || headersCleared) {
      log("provider " + pp.value.id + ": base URL moved to " + originOf(pp.value.baseUrl) + " - its " +
        (keyCleared && headersCleared ? "key and custom headers were" : keyCleared ? "key was" : "custom headers were") + " cleared");
    }
    var out = detail(readConfig());
    if (keyCleared) out.keyCleared = true;
    if (headersCleared) out.headersCleared = true;
    return out;
  });

  _ipc.handle("cdb-cm:provider-delete", function (ev, id) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    id = cleanString(id, 40);
    if (!PROVIDER_ID_RE.test(id)) return { ok: false, error: "bad provider id" };
    var cfg = readConfig();
    if (lockedProvider(cfg, id)) return { ok: false, error: "provider " + id + " is set in " + JSONC_NAME + " - edit that file to remove it" };
    var w = writeJson(function (cur) {
      var i = findJsonProvider(cur, id);
      if (i !== -1) {
        cur.providers.splice(i, 1);
        dropModelRefs(cur, aliasesIn(cfg, id));
      }
      if (!cur.providers.length) delete cur.providers;
    });
    if (!w.ok) return w;
    var secrets = readSecrets();
    if (secrets[id] !== undefined) { delete secrets[id]; writeSecrets(secrets); }
    return detail(followRenames(cfg));
  });

  _ipc.handle("cdb-cm:model-set", function (ev, providerId, input) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    providerId = cleanString(providerId, 40);
    var cfg = readConfig();
    var owner = null;
    cfg.allProviders.forEach(function (p) { if (p.id === providerId) owner = p; });
    var mp = modelPatch(input, owner ? owner.effort : null, owner ? owner.context : null);
    if (mp.error) return { ok: false, error: mp.error };
    if (lockedProvider(cfg, providerId)) return { ok: false, error: "provider " + providerId + " is set in " + JSONC_NAME + " - edit that file to change it" };
    // Another provider listing the same model: both are listed under their
    // provider (sharedAliases).
    var base = aliasFor(providerId, mp.value.id);
    var shared = cfg.allProviders.some(function (p) {
      return p.id !== providerId && p.models.some(function (m) { return aliasFor(p.id, m.id) === base; });
    });
    var alias = shared ? qualifiedAlias(providerId, mp.value.id) : base;
    if (shadowsAnthropic(alias)) {
      return { ok: false, error: mp.value.id + " would be listed as " + alias + ", one of Anthropic's own model ids - give the provider another id" };
    }
    var clash = null;
    cfg.allProviders.forEach(function (p) {
      if (p.id !== providerId && p.models.some(function (m) { return m.alias === alias; })) clash = p.id;
    });
    if (clash) return { ok: false, error: mp.value.id + " would be listed as " + alias + ", which " + clash + " already lists" };
    var known = cfg.allProviders.some(function (p) { return p.id === providerId && !p.locked; });
    if (!known) return { ok: false, error: "provider " + providerId + " is not in " + JSON_NAME + " - add it first" };
    // A typed sub-agent name must be free: a generated one steps aside on
    // its own, a typed one would silently lose to the other model's.
    if (mp.value.agent && mp.value.agent.name) {
      var taken = null;
      cfg.providers.forEach(function (p) {
        p.models.forEach(function (m) {
          if (m.agent && m.agentName === mp.value.agent.name && !(p.id === providerId && m.id === mp.value.id)) taken = p.id + " / " + m.id;
        });
      });
      if (taken) return { ok: false, error: "sub-agent name " + mp.value.agent.name + " is already used by " + taken };
    }
    var w = writeJson(function (cur) {
      var i = findJsonProvider(cur, providerId);
      if (i === -1) return;
      var prov = cur.providers[i];
      if (!Array.isArray(prov.models)) prov.models = [];
      var j = -1;
      prov.models.forEach(function (m, k) { if (isObj(m) && m.id === mp.value.id) j = k; });
      if (j === -1) { prov.models.push(mp.value); return; }
      // The panel owns every field it writes (a default it leaves out means
      // "inherited"); the file-only ones a hand edit added are kept.
      var kept = {};
      FILE_ONLY_MODEL_KEYS.forEach(function (k) { if (prov.models[j][k] !== undefined) kept[k] = prov.models[j][k]; });
      prov.models[j] = Object.assign(kept, mp.value);
    });
    if (!w.ok) return w;
    return detail(followRenames(cfg));
  });

  _ipc.handle("cdb-cm:model-delete", function (ev, providerId, modelId) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    providerId = cleanString(providerId, 40);
    modelId = cleanString(modelId, 120);
    var cfg = readConfig();
    if (lockedProvider(cfg, providerId)) return { ok: false, error: "provider " + providerId + " is set in " + JSONC_NAME + " - edit that file to change it" };
    var w = writeJson(function (cur) {
      var i = findJsonProvider(cur, providerId);
      if (i === -1) return;
      var prov = cur.providers[i];
      if (!Array.isArray(prov.models)) return;
      prov.models = prov.models.filter(function (m) { return !(isObj(m) && m.id === modelId); });
      dropModelRefs(cur, aliasesIn(cfg, providerId, [modelId]));
    });
    if (!w.ok) return w;
    return detail(followRenames(cfg));
  });

  // The app-wide web-search choice: "" for Anthropic's default, else the id
  // (or alias) of a configured custom model.
  _ipc.handle("cdb-cm:websearch-set", function (ev, value) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    value = cleanString(value, 130);
    var cfg = readConfig();
    if (cfg.webSearchLocked) return { ok: false, error: "webSearch is set in " + JSONC_NAME + " - edit that file to change it" };
    if (value) {
      var alias = value.indexOf(ID_PREFIX) === 0 ? value : ID_PREFIX + value;
      var mine = null;
      cfg.providers.forEach(function (p) { p.models.forEach(function (m) { if (m.alias === alias) mine = m; }); });
      if (mine) {
        if (!mine.webSearch) return { ok: false, error: mine.id + " is marked without the web search tool" };
        value = alias;
      } else if (ANTHROPIC_ID_RE.test(value)) {
        // an Anthropic model: kept as typed, checked against the last bootstrap when we have one
        if (lastAnthropicModels.length && !lastAnthropicModels.some(function (m) { return m.id === value; })) {
          return { ok: false, error: value + " is not one of the Anthropic models the picker lists" };
        }
      } else return { ok: false, error: value + " is neither a configured model nor an Anthropic model id" };
    }
    var w = writeJson(function (cur) {
      if (value) cur.webSearch = value; else delete cur.webSearch;
    });
    if (!w.ok) return w;
    return detail(readConfig());
  });

  // The CLI's "small/fast model" slot (ANTHROPIC_SMALL_FAST_MODEL): WebFetch
  // synthesis, the mid-turn classifier and - when webSearch is unset - the
  // web-search sub-request. "" for the CLI's own small default, else the id
  // (or alias) of a configured custom model. Any configured model qualifies -
  // unlike webSearch, no tool restriction.
  _ipc.handle("cdb-cm:smallfast-set", function (ev, value) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    value = cleanString(value, 130);
    var cfg = readConfig();
    if (cfg.smallFastModelLocked) return { ok: false, error: "smallFastModel is set in " + JSONC_NAME + " - edit that file to change it" };
    if (value) {
      var want = value.replace(/\[\w+\]$/, ""); // the [1m] twin is not the small/fast one
      var alias = want.indexOf(ID_PREFIX) === 0 ? want : ID_PREFIX + want;
      var mine = null;
      cfg.providers.forEach(function (p) { p.models.forEach(function (m) { if (m.alias === alias) mine = m; }); });
      if (mine) value = alias;
      else if (ANTHROPIC_ID_RE.test(value)) {
        if (lastAnthropicModels.length && !lastAnthropicModels.some(function (m) { return m.id === value; })) {
          return { ok: false, error: value + " is not one of the Anthropic models the picker lists" };
        }
      } else return { ok: false, error: value + " is neither a configured model nor an Anthropic model id" };
    }
    var w = writeJson(function (cur) {
      if (value) cur.smallFastModel = value; else delete cur.smallFastModel;
    });
    if (!w.ok) return w;
    return detail(readConfig());
  });

  // The default sub-agent model: "" for the CLI's own default (the session's
  // model), else the id (or alias) of a configured custom model.
  _ipc.handle("cdb-cm:subagent-set", function (ev, value) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    value = cleanString(value, 130);
    var cfg = readConfig();
    if (cfg.subagentModelLocked) return { ok: false, error: "subagentModel is set in " + JSONC_NAME + " - edit that file to change it" };
    if (value) {
      var want = value.replace(/\[1m\]$/, "");
      var alias = want.indexOf(ID_PREFIX) === 0 ? want : ID_PREFIX + want;
      var mine = null;
      cfg.providers.forEach(function (p) { p.models.forEach(function (m) { if (m.alias === alias) mine = m; }); });
      if (!mine) return { ok: false, error: value + " is not a configured custom model" };
      value = alias;
    }
    var w = writeJson(function (cur) {
      if (value) cur.subagentModel = value; else delete cur.subagentModel;
    });
    if (!w.ok) return w;
    return detail(readConfig());
  });

  // Whether new sessions get the system-prompt line (announceText).
  _ipc.handle("cdb-cm:announce-set", function (ev, value) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    if (typeof value !== "boolean") return { ok: false, error: "announce must be a boolean" };
    var cfg = readConfig();
    if (cfg.announceLocked) return { ok: false, error: "announce is set in " + JSONC_NAME + " - edit that file to change it" };
    var w = writeJson(function (cur) {
      if (value) delete cur.announce; else cur.announce = false;
    });
    if (!w.ok) return w;
    return detail(readConfig());
  });

  // The provider's custom headers onto a request of the app's own, then its
  // User-Agent - over any spelling of one in those headers, so exactly one
  // goes, the same the sessions send.
  function withProviderHeaders(p, headers) {
    if (p.headers) Object.keys(p.headers).forEach(function (k) { if (typeof p.headers[k] === "string") headers[k] = p.headers[k]; });
    if (p.userAgent) {
      Object.keys(headers).forEach(function (k) { if (k.toLowerCase() === "user-agent") delete headers[k]; });
      headers["user-agent"] = p.userAgent;
    }
    return headers;
  }
  // Every request that carries a provider's key: a redirect is followed while
  // it stays on the same origin (3 hops at most) and refused when it leaves -
  // fetch would otherwise carry x-api-key and the custom headers along.
  function fetchSameOrigin(url, init, hops) {
    return fetch(url, Object.assign({}, init, { redirect: "manual" })).then(function (res) {
      var loc = res.status >= 300 && res.status < 400 && res.headers ? res.headers.get("location") : null;
      if (!loc) return res;
      var from = new _URL(url), next;
      try { next = new _URL(loc, from); } catch (e) { return res; }
      if (next.origin !== from.origin) throw new Error("the provider redirected to " + next.origin + " - the key is only sent to " + from.origin);
      return (hops || 0) >= 3 ? res : fetchSameOrigin(next.href, init, (hops || 0) + 1);
    });
  }

  // The provider's own model list. Tried in order: the provider's modelsUrl
  // (preset or typed), then the Anthropic shape at <baseUrl>/v1/models, then
  // the OpenAI shape at <origin>/v1/models and <origin>/models. Both shapes
  // answer {data:[{id, display_name?}]}; the key goes as x-api-key AND
  // Authorization: Bearer, whichever the endpoint reads.
  // Returns { models, nextAfter } - nextAfter is the cursor of the Anthropic
  // Models API shape ({data, has_more, last_id}, 20 per page, ?after_id=),
  // null when the answer is complete.
  function parseModelList(text) {
    var j;
    try { j = JSON.parse(text); } catch (e) { return null; }
    var arr = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : (j && Array.isArray(j.models) ? j.models : null));
    if (!arr) return null;
    var nextAfter = j && !Array.isArray(j) && j.has_more === true && typeof j.last_id === "string" && j.last_id ? j.last_id : null;
    var out = [];
    arr.forEach(function (m) {
      var id = isObj(m) ? (typeof m.id === "string" ? m.id : (typeof m.name === "string" ? m.name : "")) : (typeof m === "string" ? m : "");
      if (!id || !ID_RE.test(id)) return;
      // display_name (Anthropic shape) or name (OpenRouter: "Qwen: Qwen3.8 Max")
      var name = id;
      if (isObj(m)) {
        if (typeof m.display_name === "string" && m.display_name.trim()) name = m.display_name.trim();
        else if (typeof m.name === "string" && m.name.trim() && m.name !== id) name = m.name.trim();
      }
      var e = { id: id, name: name };
      // A listing that states the context length (OpenRouter's does) settles
      // the model's context mode: 1M when it serves at least that.
      var cl = isObj(m) ? (typeof m.context_length === "number" ? m.context_length : (typeof m.context_window === "number" ? m.context_window : null)) : null;
      if (cl !== null) e.context = cl >= 1000000 ? "1m" : "200k";
      out.push(e);
    });
    return { models: out, nextAfter: nextAfter };
  }
  // A LiteLLM proxy (and a gateway built on one, such as TensorX) lists bare
  // OpenAI rows at /v1/models - {id, object, created, owned_by} - and states
  // what each model is at GET /v1/model/info: {data:[{model_name, model_info:
  // {mode, max_input_tokens, supports_vision, supports_reasoning}}]}. Several
  // rows can share a model_name (one per deployment): the first value stated
  // for a field wins. Returns name -> {mode, maxInput, vision, reasoning}, or
  // null when the answer is not that shape.
  function parseModelInfo(text) {
    var j;
    try { j = JSON.parse(text); } catch (e) { return null; }
    if (!j || !Array.isArray(j.data)) return null;
    var out = Object.create(null), any = false;
    j.data.forEach(function (row) {
      if (!isObj(row) || typeof row.model_name !== "string" || !isObj(row.model_info)) return;
      var mi = row.model_info;
      var e = out[row.model_name] || (out[row.model_name] = {});
      if (e.mode === undefined && typeof mi.mode === "string" && mi.mode) e.mode = mi.mode;
      if (e.maxInput === undefined && typeof mi.max_input_tokens === "number" && mi.max_input_tokens > 0) e.maxInput = mi.max_input_tokens;
      if (e.vision === undefined && typeof mi.supports_vision === "boolean") e.vision = mi.supports_vision;
      if (e.reasoning === undefined && typeof mi.supports_reasoning === "boolean") e.reasoning = mi.supports_reasoning;
      any = true;
    });
    return any ? out : null;
  }
  // The modes a Code session can run on. Anything else the gateway states
  // (embedding, audio_transcription, audio_speech, image_generation, rerank,
  // moderation...) would fail on the first turn, so it is not offered.
  var SESSION_MODES = { chat: true, responses: true };
  _ipc.handle("cdb-cm:models-list", function (ev, providerId) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    providerId = cleanString(providerId, 40);
    var cfg = readConfig();
    var p = null;
    cfg.allProviders.forEach(function (x) { if (x.id === providerId) p = x; });
    if (!p) return { ok: false, error: "unknown provider " + providerId };
    if (!p.apiKey) return { ok: false, error: "no API key for provider " + providerId };
    var origin = originOf(p.baseUrl);
    var candidates = [];
    var pr = p.preset ? presetOf(p.preset) : null;
    if (p.modelsUrl) candidates.push(p.modelsUrl);
    if (pr && pr.modelsUrl) candidates.push(pr.modelsUrl);
    candidates.push(p.baseUrl + "/v1/models");
    if (origin) candidates.push(origin + "/v1/models", origin + "/models");
    var seen = Object.create(null);
    // The key goes to the base URL's host only (see sameOrigin) - a models
    // URL elsewhere is honoured for a provider of the hand-owned .jsonc, which
    // the page cannot write, and skipped for one the panel wrote.
    candidates = candidates.filter(function (u) {
      if (seen[u]) return false;
      seen[u] = true;
      return sameOrigin(u, p.baseUrl) || (p.locked && u === p.modelsUrl);
    });
    // Two header sets, in this order: the OpenAI/OpenRouter shape (Bearer,
    // the whole catalogue with context lengths) and, only when that is
    // refused, the Anthropic Models API (anthropic-version - OpenRouter then
    // answers in that shape: 20 per page, ids prefixed, no context length).
    // Anthropic's own endpoint and gateways proxying it need the second.
    var base = { "accept": "application/json", "x-api-key": p.apiKey, "authorization": "Bearer " + p.apiKey };
    withProviderHeaders(p, base);
    var headerSets = [base, Object.assign({}, base, { "anthropic-version": "2023-06-01" })];
    var failures = [];
    var MAX_PAGES = 40;
    function getJson(url, headers) {
      var ctl = new AbortController();
      var timer = setTimeout(function () { ctl.abort(); }, 15000);
      return fetchSameOrigin(url, { method: "GET", headers: headers, signal: ctl.signal }).then(function (res) {
        return res.text().then(function (text) { clearTimeout(timer); return { status: res.status, ok: res.ok, text: text }; });
      }, function (e) {
        clearTimeout(timer);
        return { status: 0, ok: false, text: "", error: e && e.name === "AbortError" ? "no answer within 15 s" : (e && e.message ? e.message : String(e)) };
      });
    }
    // Follows has_more/last_id with ?after_id= until the list is complete.
    function pages(url, headers, acc, after, n) {
      var u = after ? url + (url.indexOf("?") === -1 ? "?" : "&") + "after_id=" + encodeURIComponent(after) : url;
      return getJson(u, headers).then(function (r) {
        if (!r.ok) return { fail: u + " -> " + (r.error || "HTTP " + r.status), models: acc };
        var page = parseModelList(r.text);
        if (!page) return { fail: u + " -> no model list in the answer", models: acc };
        var all = acc.concat(page.models);
        if (page.nextAfter && n < MAX_PAGES) return pages(url, headers, all, page.nextAfter, n + 1);
        return { models: all };
      });
    }
    function tryNext(i, h) {
      if (i >= candidates.length) {
        return { ok: false, error: "no model list found - tried " + candidates.join(", ") +
          (failures.length ? " (" + failures.join("; ") + ")" : "") + ". Add the models by hand." };
      }
      var url = candidates[i];
      return pages(url, headerSets[h], [], null, 0).then(function (r) {
        if (r.fail && !r.models.length) {
          failures.push(r.fail);
          return h + 1 < headerSets.length ? tryNext(i, h + 1) : tryNext(i + 1, 0);
        }
        if (!r.models.length) { failures.push(url + " -> empty list"); return h + 1 < headerSets.length ? tryNext(i, h + 1) : tryNext(i + 1, 0); }
        // Duplicates across pages (a gateway's alias rows) are dropped.
        var seenId = Object.create(null);
        var models = r.models.filter(function (m) { if (seenId[m.id]) return false; seenId[m.id] = true; return true; });
        return withModelInfo(models).then(function (x) {
          var out = { ok: true, source: url, models: x.models, partial: r.fail || null };
          if (x.source) { out.infoSource = x.source; out.hidden = x.hidden; }
          return out;
        });
      });
    }
    // What the listing did not say, the gateway's /v1/model/info may: one GET
    // on the same host, after the list. It only fills in - a context the
    // listing stated is kept - and it only turns vision or thinking off when
    // the gateway says false; an absent field keeps the app's default. Any
    // failure leaves the list as it was. Asked only of the gateway preset and
    // of a provider with no preset: the named presets are vendors' own APIs,
    // which serve no such endpoint. Skipped too when the listing already
    // stated every model's context (OpenRouter).
    function withModelInfo(models) {
      var asIs = { models: models };
      if (p.native || (p.preset && p.preset !== "gateway") || !origin ||
          models.every(function (m) { return !!m.context; })) return Promise.resolve(asIs);
      var infoUrl = origin + "/v1/model/info";
      return getJson(infoUrl, base).then(function (r) {
        var info = r.ok ? parseModelInfo(r.text) : null;
        if (!info) return asIs;
        var hidden = [];
        var kept = models.filter(function (m) {
          var e = info[m.id];
          if (e && e.mode && !SESSION_MODES[e.mode]) { hidden.push({ id: m.id, mode: e.mode }); return false; }
          return true;
        }).map(function (m) {
          var e = info[m.id];
          if (!e) return m;
          var c = Object.assign({}, m);
          if (!c.context && e.maxInput !== undefined) c.context = e.maxInput >= 1000000 ? "1m" : "200k";
          if (e.vision === false) c.vision = false;
          if (e.reasoning === false) c.thinking = false;
          return c;
        });
        return { models: kept, source: infoUrl, hidden: hidden };
      }).catch(function () { return asIs; }); // e.g. the body cut off by the 15 s abort
    }
    return tryNext(0, 0);
  });

  // Which of the app's five effort levels a provider accepts for a model:
  // one request with each value, in parallel. What we cannot know from here,
  // the provider's own answer settles. Effort travels with thinking, and a
  // thinking budget is at least 1024 tokens and below max_tokens (strict
  // endpoints refuse anything else), so each is the smallest valid request:
  // max_tokens 1025 - at most about a thousand output tokens per level.
  _ipc.handle("cdb-cm:effort-probe", function (ev, providerId, modelId) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    providerId = cleanString(providerId, 40);
    modelId = cleanString(modelId, 120);
    var cfg = readConfig();
    var p = null;
    cfg.allProviders.forEach(function (x) { if (x.id === providerId) p = x; });
    if (!p) return { ok: false, error: "unknown provider " + providerId };
    if (!p.apiKey) return { ok: false, error: "no API key for provider " + providerId };
    if (!modelId && p.models.length) modelId = p.models[0].id;
    if (!ID_RE.test(modelId)) return { ok: false, error: "add a model first - the probe sends it one minimal request with each level" };
    var headers = { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": p.apiKey };
    withProviderHeaders(p, headers);
    return Promise.all(EFFORT_ORDER.map(function (level) {
      var body = { model: modelId, max_tokens: 1025, messages: [{ role: "user", content: "Reply with OK." }],
        thinking: { type: "enabled", budget_tokens: 1024 }, output_config: { effort: level } };
      var ctl = new AbortController();
      var timer = setTimeout(function () { ctl.abort(); }, 20000);
      return fetchSameOrigin(p.baseUrl + "/v1/messages", { method: "POST", headers: headers, body: JSON.stringify(body), signal: ctl.signal })
        .then(function (res) {
          return res.text().then(function (text) {
            clearTimeout(timer);
            if (res.ok) return { level: level, ok: true };
            var msg = text.slice(0, 200);
            try { var j = JSON.parse(text); if (j && j.error && j.error.message) msg = j.error.message; } catch (e) {}
            return { level: level, ok: false, status: res.status, error: msg };
          });
        }, function (e) {
          clearTimeout(timer);
          return { level: level, ok: false, error: e && e.name === "AbortError" ? "no answer within 20 s" : (e && e.message ? e.message : String(e)) };
        });
    })).then(function (results) {
      var accepted = results.filter(function (r) { return r.ok; }).map(function (r) { return r.level; });
      var rejected = {};
      results.forEach(function (r) { if (!r.ok) rejected[r.level] = (r.status ? "HTTP " + r.status + ": " : "") + r.error; });
      // Every level refused for the same reason is not an effort problem
      // (bad key, wrong URL, unknown model): say so instead of "none".
      if (!accepted.length) {
        var msgs = Object.keys(rejected).map(function (k) { return rejected[k]; });
        var same = msgs.every(function (m) { return m === msgs[0]; });
        return { ok: false, error: same ? msgs[0] : "every level was refused: " + JSON.stringify(rejected) };
      }
      return { ok: true, accepted: accepted, rejected: rejected };
    });
  });

  // A minimal round trip to the provider with the stored key, so a typo in
  // the URL or the key shows here and not as a failed session. Costs the
  // provider's minimum billable request. max_tokens 16, not 1: some upstreams
  // refuse fewer than 16 output tokens (OpenRouter's meta/muse-spark answers
  // 400 "`max_output_tokens` The number must be `>= 16`") - the floor the
  // preload applies to the sessions' requests too.
  _ipc.handle("cdb-cm:provider-test", function (ev, providerId) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    providerId = cleanString(providerId, 40);
    var cfg = readConfig();
    var p = null;
    cfg.allProviders.forEach(function (x) { if (x.id === providerId) p = x; });
    if (!p) return { ok: false, error: "unknown provider " + providerId };
    if (!p.apiKey) return { ok: false, error: "no API key for provider " + providerId };
    if (!p.models.length) return { ok: false, error: "add a model first - the test sends a minimal request to it" };
    var model = p.models[0];
    var body = { model: model.id, max_tokens: 16, messages: [{ role: "user", content: "ping" }] };
    var headers = { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": p.apiKey };
    withProviderHeaders(p, headers);
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 20000);
    return fetchSameOrigin(p.baseUrl + "/v1/messages", { method: "POST", headers: headers, body: JSON.stringify(body), signal: ctl.signal })
      .then(function (res) {
        return res.text().then(function (text) {
          clearTimeout(timer);
          if (res.ok) return { ok: true, status: res.status, model: model.id };
          var msg = text.slice(0, 300);
          try { var j = JSON.parse(text); if (j && j.error && j.error.message) msg = j.error.message; } catch (e) {}
          return { ok: false, status: res.status, error: "HTTP " + res.status + ": " + msg };
        });
      }, function (e) {
        clearTimeout(timer);
        return { ok: false, error: e && e.name === "AbortError" ? "no answer within 20 s" : (e && e.message ? e.message : String(e)) };
      });
  });

  globalThis.__cdbCustomModels = { cliEnv: cliEnv, enrichBootstrap: enrichBootstrap, readConfig: readConfig,
    selectionOutcome: selectionOutcome, rememberServerState: rememberServerState, listedIds: listedIds, syncRoutes: syncRoutes,
    agents: agents, appendSystemPrompt: appendSystemPrompt, remoteSpawn: remoteSpawn };

  // The files edited by hand (the .jsonc, a key file's secrets.json) are not
  // written through the panel: watch them so routes.json follows those
  // edits too. One directory watch each, debounced; a watch that cannot be
  // set (unusual filesystem) only costs the live update for hand edits.
  // Started with the first routes.json - a profile that never used the
  // feature gets no directory and no watcher.
  var watching = false;
  function watchForRoutes() {
    if (watching) return;
    watching = true;
    var dirs = [pathFor(""), pathFor(SUBDIR)];
    var names = { "claude-desktop-extra.jsonc": true, "claude-desktop-extra.json": true, "secrets.json": true, "routes.json": true };
    var timer = null;
    dirs.forEach(function (d) {
      if (!d || !_fs.existsSync(d)) return;
      try {
        var w = _fs.watch(d, { persistent: false }, function (_ev, name) {
          if (!name || !names[String(name)]) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(function () { timer = null; syncRoutes(); }, 300);
        });
        w.on("error", function () {});
      } catch (e) { log("cannot watch " + d + " for hand edits (" + (e && e.message ? e.message : String(e)) + ")"); }
    });
  }

  setTimeout(function () {
    var c = readConfig();
    var n = 0, types = [];
    c.providers.forEach(function (p) { n += p.models.length; p.models.forEach(function (m) { if (m.agent && m.agentName) types.push(m.agentName); }); });
    // A profile that never used the feature: nothing written, nothing watched.
    if (c.configured || _fs.existsSync(routesPath() || "")) {
      syncRoutes();
      watchForRoutes();
    }
    log("installed (main); " + (c.configured ? n + " model(s) from " + c.providers.length + " provider(s), " +
      (c.enabled ? "on" : "off") + " (source: " + c.source + "), surfaces " + c.surfaces.join(",") +
      (types.length ? ", sub-agent types " + types.join(",") : ", no sub-agent type") +
      (c.subagentModel ? ", sub-agent default " + c.subagentModel : "") + (c.announce ? "" : ", system-prompt line off")
      : "no customModels.providers configured - feature idle"));
  }, 0);
})();
