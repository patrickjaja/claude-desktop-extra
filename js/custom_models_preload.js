/*
 * custom_models_preload.js - the Claude Code CLI half of the custom models
 * feature. NOT Electron code: this file runs INSIDE the Claude Code binary
 * (a compiled Bun program) as a Bun preload, before the CLI's own code.
 *
 * How it gets there: js/custom_models_main.js writes this file under
 * <userData>/custom-models/preload.js and adds BUN_OPTIONS=--preload=<that
 * path>, CDB_CUSTOM_MODELS_ROUTES=<routes.json> and CDB_CUSTOM_MODELS_JSON=
 * <the routes, WITHOUT keys> to the environment of every local Code session
 * it spawns (patches/community/add_feature_custom_models.nim sub-patch B).
 * Bun honours BUN_OPTIONS for compiled binaries; NODE_OPTIONS and bunfig.toml
 * are not read by them.
 *
 * What it does: replaces globalThis.fetch in the CLI process, and the fetch
 * of every Bun.FetchSession the CLI creates (2.1.284+ sends its API requests
 * through one). A POST to
 * /v1/messages whose `model` is one of the configured ids (exposed to the CLI
 * as "claude-<id>", because the CLI's set_model validator only accepts ids
 * matching ^claude-\S+$) is rewritten to the provider's Anthropic-compatible
 * endpoint with the provider's own key. Everything else - Claude models, OAuth,
 * telemetry, count_tokens for Claude models - passes through untouched, with
 * two exceptions: a foreign diagnostics.previous_message_id is sent as null,
 * and the web-search sub-request takes the web-search model when it is an
 * Anthropic one.
 *
 * Fail-open: any error in the hook falls back to the original fetch and logs
 * one line to CDB_CUSTOM_MODELS_LOG. The keys never travel in the environment:
 * they are read from routes.json (0600, 0700 directory). Our variables are
 * deleted from process.env as soon as they are read, so what the CLI spawns
 * with an env built from process.env (the Bash tool's shells, MCP servers)
 * does not get them; a Bun.spawn without an env option still inherits the
 * process's original environment, which carries no key.
 */
"use strict";
(function () {
  var SELFTEST = process.env.CDB_CUSTOM_MODELS_SELFTEST === "1";
  var path = require("node:path");
  var fs = require("node:fs");

  // Read-and-scrub.
  var rawJson = process.env.CDB_CUSTOM_MODELS_JSON;
  var logPath = process.env.CDB_CUSTOM_MODELS_LOG || "";
  // Live routing: the app rewrites this file (0600) at every change of the
  // configuration; it is re-read here when its mtime moves, so a key fixed,
  // a model added or a provider removed reaches this session without a
  // restart. Absent or empty = no route.
  var routesPath = process.env.CDB_CUSTOM_MODELS_ROUTES || "";
  // CDB_CUSTOM_MODELS_DEBUG=1 (the app's own debug switch, passed along):
  // every Messages request that is NOT routed gets a line too, with the
  // reason - the way to tell "went to Anthropic" from "never reached the hook".
  var DEBUG = process.env.CDB_CUSTOM_MODELS_DEBUG === "1";
  var bunOptions = process.env.BUN_OPTIONS;
  delete process.env.CDB_CUSTOM_MODELS_JSON;
  delete process.env.CDB_CUSTOM_MODELS_LOG;
  delete process.env.CDB_CUSTOM_MODELS_ROUTES;
  delete process.env.CDB_CUSTOM_MODELS_DEBUG;
  if (typeof bunOptions === "string") {
    // Strip only our own --preload token; a user's other BUN_OPTIONS survive.
    var kept = bunOptions.split(/\s+/).filter(function (t) {
      return t && !/^--preload=.*custom-models[\\/]preload\.js$/.test(t);
    }).join(" ");
    if (kept) process.env.BUN_OPTIONS = kept; else delete process.env.BUN_OPTIONS;
  }

  function log(msg) {
    if (!logPath) return;
    try {
      var st = fs.statSync(logPath, { throwIfNoEntry: false });
      if (st && st.size > 1000000) fs.truncateSync(logPath, 0);
      fs.appendFileSync(logPath, new Date().toISOString() + " [" + process.pid + "] " + msg + "\n");
    } catch (e) {}
  }

  if (!SELFTEST) {
    if (typeof Bun === "undefined") return;
    // claude on Linux, claude.exe on Windows (the app's binaryName for win32).
    if (path.basename(process.execPath).replace(/\.exe$/i, "") !== "claude") return;
  }
  if (!rawJson && !routesPath) return;

  // The CLI validator's pass: anything ^claude-\S+$ is accepted by set_model.
  var PREFIX = "claude-";
  function exposedId(id) { return id.indexOf(PREFIX) === 0 ? id : PREFIX + id; }
  // Anthropic's own model ids are never routed, whatever the routes say: they
  // belong to the subscription (the app refuses them as custom models too).
  var ANTHROPIC_FAMILY_RE = /^claude-(?:opus|sonnet|haiku|fable|mythos|instant)(?:-|$)|^claude-[1-3](?:[.-]|$)/;

  // The routing state, rebuilt from a config object: alias (what the CLI
  // sends) -> { provider, model }, plus the web-search target.
  var cfg = { providers: [] };
  var routes = new Map();
  var webSearchRoute = null;
  var webSearchAnthropic = "";
  // Every custom alias this session was ever routed to -> the provider's
  // model id: a request for one whose route is gone gets a clear error
  // instead of reaching Anthropic, which does not know it.
  var known = new Map();
  function applyConfig(next) {
    cfg = next && typeof next === "object" ? next : { providers: [] };
    routes = new Map();
    var providers = Array.isArray(cfg.providers) ? cfg.providers : [];
    providers.forEach(function (p) {
      if (!p || typeof p !== "object" || !Array.isArray(p.models)) return;
      p.models.forEach(function (m) {
        if (!m || typeof m.id !== "string" || !m.id.trim()) return;
        // The app names the alias (a Claude model on your API credit is
        // claude-<provider>-<model>); older routes files did not.
        var alias = typeof m.alias === "string" && m.alias.indexOf(PREFIX) === 0 ? m.alias : exposedId(m.id.trim());
        if (ANTHROPIC_FAMILY_RE.test(alias)) return;
        if (!routes.has(alias)) routes.set(alias, { provider: p, model: m });
        known.set(alias, m.id.trim());
      });
    });
    // The CLI's web-search sub-request (one server tool, normally answered by a
    // small Claude model) can be handed to one of the custom models instead.
    // App-wide: cfg.webSearch = "<model id or alias>"; a per-provider
    // webSearch (configs written before it was global) is the fallback.
    // A custom target is a route; an Anthropic target (claude-opus-5...) is a
    // model name substituted into the sub-request, which then goes to Anthropic
    // as usual with the session's own credentials.
    webSearchRoute = null;
    webSearchAnthropic = "";
    if (typeof cfg.webSearch === "string" && cfg.webSearch.trim()) {
      var wsWant = cfg.webSearch.trim().replace(/\[\w+\]$/, ""); // routes are keyed without [1m]
      webSearchRoute = routes.get(exposedId(wsWant)) || null;
      if (!webSearchRoute && /^claude-[a-z0-9][a-z0-9.-]{0,60}$/.test(wsWant)) webSearchAnthropic = wsWant;
    }
    if (!webSearchRoute && !webSearchAnthropic) providers.some(function (p) {
      if (!p || typeof p.webSearch !== "string") return false;
      var r = routes.get(exposedId(p.webSearch.trim()));
      if (r && r.provider === p) { webSearchRoute = r; return true; }
      return false;
    });
  }
  function describeRoutes() {
    var names = [];
    routes.forEach(function (r, alias) { names.push(alias + " -> " + r.provider.id + "/" + r.model.id); });
    return (names.length ? names.join(", ") : "no custom model") + (webSearchRoute ? "; web search -> " + webSearchRoute.model.id
      : (webSearchAnthropic ? "; web search -> " + webSearchAnthropic + " (Anthropic)" : ""));
  }

  // The routes file: read at start (it wins over the environment, being the
  // newer of the two), then again whenever its mtime or size moved - one
  // stat per API request, nothing between requests.
  var routesStamp = "";
  function readRoutesFile() {
    var st = fs.statSync(routesPath, { throwIfNoEntry: false });
    var stamp = st ? st.mtimeMs + ":" + st.size : "absent";
    if (stamp === routesStamp) return false;
    var first = routesStamp === "";
    routesStamp = stamp;
    // Absent at start (the app could not write it): keep what the
    // environment carried. Removed later: the routes are gone.
    if (!st) {
      if (first) return false;
      applyConfig(null);
      return true;
    }
    applyConfig(JSON.parse(fs.readFileSync(routesPath, "utf8")));
    return true;
  }
  function refreshRoutes() {
    if (!routesPath) return;
    try {
      if (readRoutesFile()) log("routes reloaded: " + describeRoutes());
    } catch (e) { log("routes file unreadable (" + (e && e.message) + ") - keeping the current routes"); }
  }

  var initial = null;
  if (rawJson) {
    try { initial = JSON.parse(rawJson); }
    catch (e) { log("config unreadable (" + e.message + ") - routing off until the routes file says otherwise"); }
  }
  applyConfig(initial);
  if (routesPath) {
    try { readRoutesFile(); }
    catch (e) { log("routes file unreadable (" + (e && e.message) + ") - using the environment's (no keys)"); }
  }
  // The CLI's two model slots were set in this session's environment at spawn
  // (ANTHROPIC_SMALL_FAST_MODEL, CLAUDE_CODE_SUBAGENT_MODEL) and the CLI keeps
  // them for its whole life: the routes they named then are kept with them,
  // so turning the feature off or removing that model does not break an open
  // session's WebFetch, classifier or sub-agents - it keeps what it got.
  // Taken after the routes file: the keys are there, not in the environment.
  var pinned = new Map();
  [process.env.ANTHROPIC_SMALL_FAST_MODEL, process.env.CLAUDE_CODE_SUBAGENT_MODEL].forEach(function (v) {
    if (typeof v !== "string") return;
    var a = v.trim().replace(/\[\w+\]$/, "");
    if (routes.has(a)) pinned.set(a, routes.get(a));
  });

  function providerBase(p) {
    return String(p.baseUrl || "").replace(/\/+$/, "");
  }
  // The panel's rule: at least 8 characters.
  function providerKeyOk(p) {
    var k = typeof p.apiKey === "string" ? p.apiKey.trim() : "";
    return k.length >= 8;
  }
  function isWebSearchSubRequest(body) {
    return Array.isArray(body.tools) && body.tools.length === 1 && body.tools[0] &&
      /^web_search/.test(body.tools[0].type || "");
  }

  // ---- request sanitising -------------------------------------------------
  // The target is an Anthropic-COMPATIBLE endpoint, not Anthropic: only the
  // documented subset of the Messages API is forwarded. Anything the CLI adds
  // for Anthropic proper (beta headers, cache_control, context_management,
  // metadata, mcp_servers, redacted/signed thinking) is dropped or normalised.
  function textBlock(text) { return { type: "text", text: text }; }

  function cleanBlock(b, m, stripThinking) {
    if (typeof b === "string") return [textBlock(b)];
    if (!b || typeof b !== "object") return [];
    switch (b.type) {
      case "text":
        return typeof b.text === "string" && b.text.length ? [textBlock(b.text)] : [];
      case "image":
        if (m.vision !== false) return [{ type: "image", source: b.source }];
        return [textBlock("[image omitted: " + m.id + " has no vision]")];
      case "tool_use":
        return [{ type: "tool_use", id: b.id, name: b.name, input: b.input == null ? {} : b.input }];
      case "tool_result": {
        var out = { type: "tool_result", tool_use_id: b.tool_use_id };
        if (b.is_error) out.is_error = true;
        if (typeof b.content === "string") out.content = b.content;
        else if (Array.isArray(b.content)) {
          var c = [];
          b.content.forEach(function (x) { c.push.apply(c, cleanBlock(x, m, stripThinking)); });
          out.content = c.length ? c : "";
        }
        return [out];
      }
      case "thinking":
        return stripThinking ? [] : [b];
      case "redacted_thinking":
        return [];
      case "document": {
        var src = b.source || {};
        if (src.type === "text" && typeof src.data === "string") return [textBlock(src.data)];
        return [textBlock("[document omitted: " + (b.title || src.media_type || "unsupported") + "]")];
      }
      case "server_tool_use":
      case "web_search_tool_result":
        return [b]; // native web search, same block shapes as Anthropic
      default:
        return []; // search_result, code_execution_*, mcp_*, ...
    }
  }

  function cleanMessages(messages, m, stripThinking) {
    if (!Array.isArray(messages)) return [];
    var out = [];
    messages.forEach(function (msg) {
      if (!msg || typeof msg !== "object") return;
      var content = msg.content;
      if (typeof content === "string") content = [textBlock(content)];
      else if (Array.isArray(content)) {
        var flat = [];
        content.forEach(function (b) { flat.push.apply(flat, cleanBlock(b, m, stripThinking)); });
        content = flat;
      } else content = [];
      // Mid-conversation system messages (the CLI's mid-conversation-system
      // beta: /effort changes and friends) are folded into user text -
      // compatible endpoints only take user/assistant.
      var role = msg.role === "assistant" ? "assistant" : "user";
      if (msg.role === "system") {
        content = content.map(function (b) { return b.type === "text" ? textBlock("[system] " + b.text) : b; });
      }
      if (!content.length) content = [textBlock("(untransferable content omitted)")];
      var prev = out[out.length - 1];
      if (prev && prev.role === role) prev.content.push.apply(prev.content, content); // strict alternation
      else out.push({ role: role, content: content });
    });
    return out;
  }

  // App effort (low..max) -> provider effort. A provider that was given an
  // explicit list of levels (p.effort: the panel, the file or its preset)
  // gets the app's level unchanged when it lists it, else the nearest listed
  // one above (else the highest): the picker only offers listed levels, but
  // the CLI's /effort can name any. A provider without a list gets the
  // default table - DeepSeek's convention, which knows low/high/max and ran
  // its benchmarks at max, so xhigh (the app's default) lands on max.
  // effortMap (per provider) overlays either, for an API that spells a level
  // differently.
  var EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
  var EFFORT_DEFAULT = { low: "low", medium: "high", high: "high", xhigh: "max", max: "max" };
  function effortTable(p, fallback) {
    var base = fallback || EFFORT_DEFAULT;
    var listed = Array.isArray(p.effort) ? EFFORT_ORDER.filter(function (l) { return p.effort.indexOf(l) !== -1; }) : [];
    if (listed.length) {
      base = {};
      EFFORT_ORDER.forEach(function (l, i) {
        var up = listed.filter(function (x) { return EFFORT_ORDER.indexOf(x) >= i; });
        base[l] = up.length ? up[0] : listed[listed.length - 1];
      });
    }
    return p.effortMap && typeof p.effortMap === "object" ? Object.assign({}, base, p.effortMap) : base;
  }
  // Anthropic's rule, which strict compatible endpoints enforce too: a
  // thinking budget is at least 1024 tokens and below max_tokens.
  var MIN_THINKING_BUDGET = 1024;
  var MAX_THINKING_BUDGET = 16000;
  // The CLI checks the model a session switches to with max_tokens: 1
  // (querySource "model_validation"), and some upstreams refuse fewer than 16
  // output tokens - OpenRouter's meta/muse-spark answers 400 "`max_output_tokens`
  // The number must be `>= 16`", which cancels the switch. 16 costs nothing.
  var MIN_MAX_TOKENS = 16;

  // An effort value the provider does not know (a level ticked that its
  // API does not have): it answers 400 naming the effort - the request is
  // retried once without output_config so the turn survives.
  function effortRefused(text) {
    return /effort/i.test(text) && !/thinking options type cannot be disabled/i.test(text);
  }

  var WEB_SEARCH_KEYS = ["max_uses", "allowed_domains", "blocked_domains", "user_location"];

  // A tool schema's `pattern` is an ECMAScript regex, and a provider may
  // compile it with a stricter engine: DeepSeek refuses the whole request
  // ('"^[^\\0]*$" is not a "regex"' - the Artifact tool's file_paths) over
  // spellings a Rust regex does not take. Three have an exact equivalent it
  // does: \0 (NUL) -> \x00, [\b] (backspace) -> [\x08], [^] (any char) ->
  // [\s\S]. Anything else is copied as is.
  function portableRegex(src) {
    var out = "", inClass = false;
    for (var i = 0; i < src.length; i++) {
      var c = src[i];
      if (c === "\\" && i + 1 < src.length) {
        var n = src[i + 1];
        if (n === "0" && !/[0-9]/.test(src[i + 2] || "")) out += "\\x00";
        else if (n === "b" && inClass) out += "\\x08";
        else out += c + n;
        i++;
        continue;
      }
      if (!inClass && c === "[") {
        if (src.slice(i, i + 3) === "[^]") { out += "[\\s\\S]"; i += 2; continue; }
        inClass = true;
      } else if (inClass && c === "]") inClass = false;
      out += c;
    }
    return out;
  }
  // A copy of the schema with every `pattern` (and patternProperties key)
  // made portable. Values that are data, not schema, are left alone.
  var SCHEMA_DATA_KEYS = { "default": 1, "const": 1, "enum": 1, "examples": 1 };
  function portableSchema(v) {
    if (Array.isArray(v)) return v.map(portableSchema);
    if (!v || typeof v !== "object") return v;
    var o = Object.create(null); // a property named __proto__ stays a property
    Object.keys(v).forEach(function (k) {
      var x = v[k];
      if (SCHEMA_DATA_KEYS[k] === 1) o[k] = x;
      else if (k === "pattern" && typeof x === "string") o[k] = portableRegex(x);
      else if (k === "patternProperties" && x && typeof x === "object" && !Array.isArray(x)) {
        o[k] = Object.create(null);
        Object.keys(x).forEach(function (re) { o[k][portableRegex(re)] = portableSchema(x[re]); });
      } else o[k] = portableSchema(x);
    });
    return o;
  }

  // Claude models whose Messages API takes adaptive thinking + effort instead
  // of budget_tokens (CLI 2.1.325 bakedCatalog): Opus/Sonnet 4.6+, Haiku 5+,
  // Fable 5+ and Mythos (preview + 5+), under bare or gateway-prefixed/dotted/
  // tagged ids (anthropic/claude-fable-5-2, anthropic/claude-opus-5.5,
  // anthropic/claude-opus-4.6:thinking, us.anthropic.claude-fable-5-2-v1:0).
  //   rejectsDisabled: always-thinking models that 400 on {type: "disabled"}
  //                    (Fable, Mythos 5+, Haiku 5+, Opus/Sonnet > 5.0)
  //   xhigh:           models whose effort enum includes "xhigh" (all except
  //                    Opus 4.6, Sonnet 4.6 and Mythos preview)
  function adaptiveClaude(rawId) {
    var s = String(rawId || "").toLowerCase().trim().replace(/\[[12]m\]$/, "");
    var slash = s.lastIndexOf("/");
    if (slash !== -1) s = s.slice(slash + 1);
    var br = /^(?:[a-z0-9-]+\.)?anthropic\.(claude-.*?)(?::\d+)?$/.exec(s);
    if (br) s = br[1];
    s = s.replace(/(claude-[a-z]+-\d{1,2})\.(?=\d)/, "$1-");
    if (/^claude-mythos-preview(?:$|[-@:])/.test(s)) return { rejectsDisabled: false, xhigh: false };
    var m = /^claude-(haiku|sonnet|opus|fable|mythos)-(\d{1,2})(?!\d)(?:-(\d{1,2})(?!\d))?(?:$|[-@:])/.exec(s);
    if (!m) return null;
    var fam = m[1], maj = parseInt(m[2], 10), min = m[3] ? parseInt(m[3], 10) : 0;
    if (maj < 4) return null;
    if ((fam === "opus" || fam === "sonnet") && maj === 4 && min <= 5) return null;
    if ((fam === "haiku" || fam === "fable" || fam === "mythos") && maj < 5) return null;
    return {
      rejectsDisabled: fam === "fable" || fam === "mythos" || fam === "haiku" || maj > 5 || (maj === 5 && min > 0),
      xhigh: !((fam === "opus" || fam === "sonnet") && maj === 4 && min === 6)
    };
  }

  function sanitize(body, route, opts) {
    var m = route.model, p = route.provider;
    var out = { model: m.id };
    ["max_tokens", "stream", "temperature", "top_p", "stop_sequences"].forEach(function (k) {
      if (body[k] !== undefined) out[k] = body[k];
    });
    if (typeof out.max_tokens === "number" && out.max_tokens < MIN_MAX_TOKENS) out.max_tokens = MIN_MAX_TOKENS;
    if (typeof body.system === "string") out.system = body.system;
    else if (Array.isArray(body.system)) {
      // stripBillingHeader: the CLI's billing line (its own block, first,
      // naming cc_entrypoint=claude-desktop) is Anthropic's metadata - another
      // provider has no use for it.
      var sys = body.system.filter(function (b) {
        return b && b.type === "text" && typeof b.text === "string" &&
          !(p.stripBillingHeader === true && b.text.indexOf("x-anthropic-billing-header:") === 0);
      }).map(function (b) { return textBlock(b.text); });
      if (sys.length) out.system = sys;
    }
    out.messages = cleanMessages(body.messages, m, opts.stripThinking);
    if (Array.isArray(body.tools)) {
      var tools = body.tools.filter(function (t) {
        return t && typeof t.name === "string" &&
          ((t.input_schema && typeof t.input_schema === "object") ||
            (/^web_search/.test(t.type || "") && m.webSearch !== false));
      }).map(function (t) {
        if (!/^web_search/.test(t.type || "")) {
          return { name: t.name, description: typeof t.description === "string" ? t.description : "", input_schema: portableSchema(t.input_schema) };
        }
        // Anthropic's server-side tool, with the options it documents - the
        // CLI's domain filters and use cap included.
        var ws = { type: t.type, name: t.name };
        WEB_SEARCH_KEYS.forEach(function (k) { if (t[k] !== undefined) ws[k] = t[k]; });
        return ws;
      });
      if (tools.length) {
        out.tools = tools;
        var tc = body.tool_choice;
        if (tc && typeof tc === "object" && typeof tc.type === "string") {
          out.tool_choice = tc.type === "tool" && tc.name ? { type: "tool", name: tc.name } : { type: tc.type };
        }
      }
    }
    // Thinking follows the request: the CLI asks for it on a session's turns
    // ({type: "enabled", budget_tokens} or "adaptive") and leaves it out of
    // its light work (WebFetch synthesis, the classifier), which must stay
    // cheap - absent stays absent. The model may forbid it (thinking:false);
    // mode "off" arrives as {type: "disabled"} and is forwarded. The budget is
    // clamped to 16000 and kept below max_tokens; a max_tokens too small for
    // the 1024 minimum sends no thinking rather than an invalid request.
    var asked = body.thinking && typeof body.thinking === "object" ? body.thinking : null;
    var think = false;
    // Adaptive Claude models (4.6+, Haiku 5+, Fable 5+, Mythos) behind a
    // compatible endpoint reject budget_tokens; newer ones (Fable, Mythos 5+,
    // Haiku 5+, Opus/Sonnet > 5.0) also reject {type: "disabled"}.
    var cc = adaptiveClaude(m.id);
    if (cc) {
      if (m.thinking === false) {
        if (!cc.rejectsDisabled && asked) out.thinking = { type: "disabled" };
        return out;
      }
      if (!asked) return out;
      if (asked.type === "disabled") {
        if (!cc.rejectsDisabled) { out.thinking = { type: "disabled" }; return out; }
      } else {
        out.thinking = { type: "adaptive" };
      }
      var rawEff = body.output_config && typeof body.output_config.effort === "string"
        ? body.output_config.effort : undefined;
      var tbl = effortTable(p, { low: "low", medium: "medium", high: "high", xhigh: cc.xhigh ? "xhigh" : "max", max: "max" });
      var eff = rawEff && Object.prototype.hasOwnProperty.call(tbl, rawEff) ? tbl[rawEff] : undefined;
      if (typeof eff === "string" && eff && !opts.dropEffort) out.output_config = { effort: eff };
      return out;
    }
    if (asked && asked.type === "disabled") out.thinking = { type: "disabled" };
    else if (asked && m.thinking === false) out.thinking = { type: "disabled" };
    else if (asked) {
      var max = typeof out.max_tokens === "number" ? out.max_tokens : 32000;
      var want = typeof asked.budget_tokens === "number" ? asked.budget_tokens : MAX_THINKING_BUDGET;
      var budget = Math.min(MAX_THINKING_BUDGET, Math.max(MIN_THINKING_BUDGET, want), max - 1);
      if (budget >= MIN_THINKING_BUDGET) {
        out.thinking = { type: "enabled", budget_tokens: budget };
        think = true;
      }
    }
    // Effort only ever travels with thinking on - DeepSeek answers 400 to
    // "reasoning_effort with thinking disabled".
    var effort = body.output_config && typeof body.output_config.effort === "string"
      ? effortTable(p)[body.output_config.effort] : undefined;
    if (think && typeof effort === "string" && effort && !opts.dropEffort) out.output_config = { effort: effort };
    return out;
  }

  function outHeaders(init, p) {
    var src = new Headers(init.headers || {});
    var h = new Headers();
    ["content-type", "accept", "anthropic-version"].forEach(function (k) {
      var v = src.get(k);
      if (v) h.set(k, v);
    });
    if (!h.has("content-type")) h.set("content-type", "application/json");
    h.set("x-api-key", String(p.apiKey).trim()); // never the Anthropic OAuth Authorization
    if (p.headers && typeof p.headers === "object") {
      Object.keys(p.headers).forEach(function (k) {
        if (typeof p.headers[k] !== "string") return;
        // A malformed name or value would make fetch reject, which the CLI
        // takes for a network error and retries: skip it, say so once.
        try { h.set(k, p.headers[k]); }
        catch (e) { warnHeader(p.id, k); }
      });
    }
    return withUserAgent(h, p);
  }
  // The provider's User-Agent, over the runtime's (Bun/x.y.z here), the CLI's
  // (claude-cli/... (external, claude-desktop...) on the native path) and any
  // user-agent in its headers. Absent: whatever was there goes, as before.
  function withUserAgent(h, p) {
    if (typeof p.userAgent === "string" && p.userAgent) {
      try { h.set("user-agent", p.userAgent); }
      catch (e) { warnHeader(p.id, "user-agent"); }
    }
    return h;
  }

  // Anthropic's own API on the user's API key: the CLI's body as it is, with
  // the provider's model id. Two things another model in the session can
  // leave behind are fixed: a previous_message_id Anthropic did not mint
  // (nulled, as for the subscription), and - on the retry after a 400 naming
  // them - thinking blocks signed elsewhere. The attribution block says
  // cc_entrypoint=cli, what the CLI sends when it runs interactively on an
  // API key: the API answers claude-desktop on a key with "credit balance too
  // low".
  function nativeBody(body, m, stripThinking) {
    var out = Object.assign({}, body, { model: m.id });
    if (Array.isArray(out.system)) {
      out.system = out.system.map(function (b) {
        if (!b || b.type !== "text" || typeof b.text !== "string" || b.text.indexOf("x-anthropic-billing-header:") !== 0) return b;
        return Object.assign({}, b, { text: b.text.replace(/ cc_entrypoint=[^;]*;/, " cc_entrypoint=cli;") });
      });
    }
    var d = out.diagnostics;
    if (d && typeof d === "object" && typeof d.previous_message_id === "string" && !/^msg_/.test(d.previous_message_id)) {
      out.diagnostics = Object.assign({}, d, { previous_message_id: null });
    }
    if (stripThinking && Array.isArray(out.messages)) {
      out.messages = out.messages.map(function (msg) {
        if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return msg;
        var kept = msg.content.filter(function (b) { return !b || (b.type !== "thinking" && b.type !== "redacted_thinking"); });
        return Object.assign({}, msg, { content: kept.length ? kept : [{ type: "text", text: "(thinking omitted)" }] });
      });
    }
    return out;
  }

  // Anthropic's own API on the user's API key: the CLI's headers as they are,
  // minus the subscription's login (its OAuth token and the oauth beta).
  function nativeHeaders(init, p) {
    var h = new Headers(init.headers || {});
    h.delete("authorization");
    h.delete("content-length");
    h.delete("content-encoding");
    h.set("x-api-key", String(p.apiKey).trim());
    var betas = (h.get("anthropic-beta") || "").split(",").map(function (t) { return t.trim(); })
      .filter(function (t) { return t && !/^oauth-/.test(t); });
    if (betas.length) h.set("anthropic-beta", betas.join(",")); else h.delete("anthropic-beta");
    if (p.headers && typeof p.headers === "object") {
      Object.keys(p.headers).forEach(function (k) {
        if (typeof p.headers[k] !== "string") return;
        try { h.set(k, p.headers[k]); }
        catch (e) { warnHeader(p.id, k); }
      });
    }
    return withUserAgent(h, p);
  }

  var warnedHeaders = Object.create(null);
  function warnHeader(pid, name) {
    if (warnedHeaders[pid + "/" + name]) return;
    warnedHeaders[pid + "/" + name] = true;
    log("provider " + pid + ": header " + JSON.stringify(name) + " is not a valid HTTP header - not sent");
  }

  // One line per answered request with what the provider counted: input,
  // prompt-cache read and write (with the 1h/5m split when it gives one) -
  // the cache at work, without waiting for a dashboard. Read from a clone,
  // so what the CLI reads is untouched; a stream up to message_start, or to
  // message_delta when message_start counts nothing (a LiteLLM-based gateway
  // sends zeros there and its totals at the end, without the cache split).
  // Returns a function that stops reading the clone: the CLI cancelling its
  // body reaches the provider only once both halves of the clone are let go.
  function logUsage(p, m, res) {
    function line(u, end) {
      if (!u || typeof u !== "object") return;
      // The end of a stream that states no cache figures: say so, rather
      // than print a cache_read=0 nobody measured.
      if (end && u.cache_read_input_tokens === undefined && u.cache_creation_input_tokens === undefined) {
        log("<- " + p.id + "/" + m.id + " usage: input=" + (u.input_tokens || 0) + " output=" + (u.output_tokens || 0) +
          " (end of stream, no cache figures sent)");
        return;
      }
      var cc = u.cache_creation && typeof u.cache_creation === "object" ? u.cache_creation : null;
      log("<- " + p.id + "/" + m.id + " usage: input=" + (u.input_tokens || 0) + " cache_read=" + (u.cache_read_input_tokens || 0) +
        " cache_write=" + (u.cache_creation_input_tokens || 0) +
        (cc ? " (1h " + (cc.ephemeral_1h_input_tokens || 0) + ", 5m " + (cc.ephemeral_5m_input_tokens || 0) + ")" : ""));
    }
    try {
      var copy = res.clone();
      var type = (res.headers && res.headers.get("content-type")) || "";
      if (type.indexOf("text/event-stream") === -1) {
        copy.json().then(function (j) { line(j && j.usage); }, function () {});
        return function () {};
      }
      if (!copy.body || typeof copy.body.getReader !== "function") return function () {};
      var reader = copy.body.getReader(), dec = new TextDecoder(), buf = "", atStart = null;
      var stop = function () { reader.cancel().catch(function () {}); };
      var counted = function (u) {
        return !!u && typeof u === "object" &&
          !!(u.input_tokens || u.cache_read_input_tokens || u.cache_creation_input_tokens);
      };
      var pump = function () {
        reader.read().then(function (r) {
          if (r.done) { if (atStart) line(atStart); return; }
          buf += dec.decode(r.value, { stream: true });
          var i;
          while ((i = buf.indexOf("\n")) !== -1) {
            var l = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (l.indexOf("data:") !== 0) continue;
            var ev = null;
            try { ev = JSON.parse(l.slice(5)); } catch (e) {}
            if (ev && ev.type === "message_start") {
              var su = ev.message && ev.message.usage;
              if (counted(su) || !su) { line(su); stop(); return; }
              atStart = su;
            } else if (ev && ev.type === "message_delta" && atStart) {
              // Whatever the end counts beats the zeros of the start.
              if (ev.usage && typeof ev.usage === "object") line(ev.usage, true); else line(atStart);
              atStart = null; stop(); return;
            }
          }
          if (buf.length > 1000000) { stop(); return; }
          pump();
        }, function () {});
      };
      pump();
      return stop;
    } catch (e) { return function () {}; }
  }

  // A LiteLLM-based gateway serving a reasoning model (GLM 5.3 on TensorX,
  // October 2026) streams the model's reasoning as thinking_delta events
  // inside a block it opened as text, and sometimes text again after it, in
  // the same block. Claude Code refuses that stream ("Stream event
  // unreadable") and resends the whole turn without streaming: the turn is
  // paid for twice and takes as long as the full answer. The JSON answer to
  // that resend carries a proper thinking block, so this only re-blocks the
  // stream: each run of thinking or text deltas gets its own block of that
  // kind, and the blocks after it move up by the ones inserted. A stream
  // without such a mix reaches the CLI as the provider sent it.
  var DELTA_KIND = { thinking_delta: "thinking", signature_delta: "thinking", text_delta: "text" };
  function reblockStream(p, m, res, stopUsage) {
    if (!res.body || typeof res.body.getReader !== "function" || typeof ReadableStream !== "function" ||
        typeof TextEncoder !== "function") return res;
    var type = (res.headers && res.headers.get("content-type")) || "";
    if (type.indexOf("text/event-stream") === -1) return res;
    var reader = res.body.getReader(), dec = new TextDecoder(), enc = new TextEncoder(), buf = "";
    var shift = 0, cur = null, split = 0;
    function sse(obj) { return "event: " + obj.type + "\ndata: " + JSON.stringify(obj) + "\n\n"; }
    function emptyBlock(kind) { return kind === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" }; }
    // One SSE event (raw, with its blank line) in, what the CLI gets out.
    function fix(raw) {
      var data = raw.split("\n").filter(function (l) { return l.indexOf("data:") === 0; })
        .map(function (l) { return l.slice(5).trim(); }).join("\n");
      var ev = null;
      try { ev = data ? JSON.parse(data) : null; } catch (e) {}
      if (!ev || typeof ev.index !== "number") return raw;
      if (ev.type === "content_block_start") {
        cur = { up: ev.index, out: ev.index + shift, kind: ev.content_block && ev.content_block.type };
        if (!shift) return raw;
        ev.index = cur.out;
        return sse(ev);
      }
      var mine = cur && cur.up === ev.index;
      if (ev.type === "content_block_delta") {
        var want = ev.delta && DELTA_KIND[ev.delta.type];
        var out = "";
        if (mine && want && (cur.kind === "text" || cur.kind === "thinking") && want !== cur.kind) {
          out += sse({ type: "content_block_stop", index: cur.out });
          shift++; split++;
          cur.out = ev.index + shift; cur.kind = want;
          out += sse({ type: "content_block_start", index: cur.out, content_block: emptyBlock(want) });
        }
        var idx = mine ? cur.out : ev.index + shift;
        if (!out && idx === ev.index) return raw;
        ev.index = idx;
        return out + sse(ev);
      }
      if (ev.type === "content_block_stop") {
        var at = mine ? cur.out : ev.index + shift;
        if (mine) cur = null;
        if (at === ev.index) return raw;
        ev.index = at;
        return sse(ev);
      }
      return raw;
    }
    var body = new ReadableStream({
      // Reads on until a whole event is out: a pull that enqueues nothing is
      // not called again, and the CLI would wait forever.
      pull: function (ctl) {
        function step() {
          return reader.read().then(function (r) {
            if (r.done) {
              buf += dec.decode();
              if (buf) ctl.enqueue(enc.encode(fix(buf)));
              if (split) log("<- " + p.id + "/" + m.id + " stream: thinking and text mixed in one block, re-blocked " + split + " time(s)");
              ctl.close();
              return;
            }
            buf = (buf + dec.decode(r.value, { stream: true })).replace(/\r\n/g, "\n");
            var i, outText = "";
            while ((i = buf.indexOf("\n\n")) !== -1) {
              outText += fix(buf.slice(0, i + 2));
              buf = buf.slice(i + 2);
            }
            if (!outText) return step();
            ctl.enqueue(enc.encode(outText));
          });
        }
        return step();
      },
      cancel: function (reason) {
        if (stopUsage) stopUsage();
        return reader.cancel(reason);
      }
    });
    // The provider's length no longer holds once a block is split.
    var headers = new Headers(res.headers);
    headers.delete("content-length");
    return new Response(body, { status: res.status, statusText: res.statusText, headers: headers });
  }

  function jsonResponse(status, obj) {
    return new Response(JSON.stringify(obj), { status: status, headers: { "content-type": "application/json" } });
  }
  function errorResponse(status, type, message) {
    return jsonResponse(status, { type: "error", error: { type: type, message: message } });
  }

  // ---- routing --------------------------------------------------------------
  function quickMatch(bodyText) {
    var hit = false;
    known.forEach(function (_id, alias) { if (!hit && bodyText.indexOf('"' + alias) !== -1) hit = true; });
    return hit;
  }

  function requestedModel(bodyText) {
    var m = /"model"\s*:\s*"([^"]{0,120})"/.exec(bodyText);
    return m ? m[1] : "?";
  }
  function passthrough(url, bodyText, why) {
    if (DEBUG) log("passthrough " + url.replace(/\?.*$/, "") + " model=" + requestedModel(bodyText) + " (" + why + ")");
    return null;
  }

  function route(rawFetch, input, init) {
    var url = typeof input === "string" ? input : input instanceof URL ? input.href : null;
    if (!url || !init || typeof init.body !== "string") {
      if (DEBUG && input && typeof input === "object" && typeof input.url === "string" && /\/v1\/messages/.test(input.url)) {
        log("passthrough " + input.url + " (Request object - not inspected)");
      }
      return null;
    }
    var pathname = new URL(url).pathname;
    var isMessages = /\/v1\/messages$/.test(pathname);
    var isCount = /\/v1\/messages\/count_tokens$/.test(pathname);
    if (!isMessages && !isCount) return null;
    refreshRoutes();
    var maybeWebSearch = (!!webSearchRoute || !!webSearchAnthropic) && isMessages && init.body.indexOf('"web_search') !== -1;
    var ours = quickMatch(init.body);
    if (!ours && !maybeWebSearch) {
      passthrough(url, init.body, "not a custom model; routes: " + describeRoutes());
      return isMessages ? foreignPreviousId(rawFetch, input, init) : null;
    }

    var body = JSON.parse(init.body);
    var requested = String(body.model || "").replace(/\[\w+\]$/, "").trim();
    var r = null, viaPin = false, viaWebSearch = false;
    // The exact shape of the CLI's web-search sub-request: a single tool, the
    // server-side web_search one. A conversation listing web_search among other
    // tools is not touched. The web-search choice wins over the model the
    // sub-request names - the CLI's small/fast model, which may be one of ours.
    if (maybeWebSearch && isWebSearchSubRequest(body)) {
      if (webSearchRoute) {
        r = webSearchRoute;
        viaWebSearch = true;
      } else if (webSearchAnthropic && requested !== webSearchAnthropic) {
        // An Anthropic model for the search: the request goes to Anthropic
        // with the session's own credentials, only the model name changes.
        body.model = webSearchAnthropic;
        log("web search -> " + webSearchAnthropic + " (instead of " + requested + ", Anthropic)");
        return rawFetch(input, Object.assign({}, init, { body: JSON.stringify(body) }));
      }
    }
    if (!r) r = routes.get(requested) || null;
    if (!r && pinned.has(requested)) { r = pinned.get(requested); viaPin = true; }
    if (!r) {
      // A custom model this session was routed to and no longer is (removed,
      // or the feature turned off): Anthropic would answer with a puzzling
      // "model not found". A gateway's own claude-* id goes back to Anthropic,
      // which does know it.
      var gone = known.get(requested);
      if (isCount && gone && gone !== requested) {
        return Promise.resolve(jsonResponse(200, { input_tokens: Math.ceil(init.body.length / 4) }));
      }
      if (isMessages && gone && gone !== requested) {
        log("refused: " + requested + " is no longer configured; routes: " + describeRoutes());
        return Promise.resolve(errorResponse(400, "invalid_request_error",
          "claude-desktop-extra custom models: " + requested + " is no longer configured (removed, or custom models " +
          "turned off in Settings > Extra) - pick another model"));
      }
      passthrough(url, init.body, "no route for " + requested + "; routes: " + describeRoutes());
      // A Claude request whose body merely mentions one of our ids (a tool
      // input naming a model...) still gets the previous_message_id fix.
      return isMessages ? foreignPreviousId(rawFetch, input, init) : null;
    }
    var p = r.provider, m = r.model;

    // The CLI's server-side threads (its "tether", switched on per account):
    // a "continue" request carries only the turns after an anchor, the rest
    // being kept by Anthropic - a provider never saw it and would answer
    // from a truncated conversation, without tools. The CLI's own answer to
    // this error code is to resend the turn whole and keep the thread off
    // for this model for the rest of the session.
    if (isMessages && body.thread && typeof body.thread === "object") {
      log("thread request (" + String(body.thread.type) + ") for " + p.id + "/" + m.id + " -> refused, the CLI resends it whole");
      return Promise.resolve(jsonResponse(400, { type: "error", error: { type: "invalid_request_error",
        message: "claude-desktop-extra custom models: " + p.id + " does not keep threads",
        details: { error_code: "thread_unsupported_request" } } }));
    }
    // The CLI's web-search sub-request (on the session's model or the
    // small/fast one, the CLI decides) routed to a model whose provider does
    // not run the web_search tool, while no web-search model is set:
    // stripping its only tool would answer without searching. Say so instead.
    if (isMessages && m.webSearch === false && isWebSearchSubRequest(body)) {
      log("refused: web search sub-request for " + m.id + ", which has no web search tool");
      return Promise.resolve(errorResponse(400, "invalid_request_error",
        "claude-desktop-extra custom models: web search went to " + m.id + ", which is marked without the web " +
        "search tool - pick a Web search model in Settings > Extra > Models"));
    }

    var native = p.native === true;
    if (isCount && !native) {
      return Promise.resolve(jsonResponse(200, { input_tokens: Math.ceil(init.body.length / 4) }));
    }
    if (!providerBase(p)) {
      return Promise.resolve(errorResponse(400, "invalid_request_error",
        "claude-desktop-extra custom models: provider \"" + p.id + "\" has no baseUrl"));
    }
    if (!providerKeyOk(p)) {
      log("refused: no API key for provider " + p.id + " (model " + m.id + ")");
      // 400, not 401: on 401 the CLI refreshes its OAuth token and retries forever.
      return Promise.resolve(errorResponse(400, "invalid_request_error",
        "claude-desktop-extra custom models: no API key configured for provider \"" + p.id +
        "\" (customModels.providers[].apiKey in claude-desktop-extra.jsonc)"));
    }

    // Anthropic's own API keeps the CLI's path and query (?beta=true), and
    // answers count_tokens itself.
    var target = native ? providerBase(p) + pathname + new URL(url).search : providerBase(p) + "/v1/messages";
    // The key goes to the provider's host only: a redirect is followed while
    // it stays there (method and body kept, 3 hops at most) and refused when
    // it leaves - fetch would otherwise carry x-api-key and the provider's
    // headers along.
    function post(url, opts, hops) {
      return rawFetch(url, Object.assign({}, opts, { redirect: "manual" })).then(function (res) {
        var loc = res.status >= 300 && res.status < 400 && res.headers ? res.headers.get("location") : null;
        if (!loc) return res;
        var from = new URL(url), next;
        try { next = new URL(loc, from); } catch (e) { return res; }
        if (next.origin !== from.origin) {
          log("refused: " + p.id + " redirected to " + next.origin + " - the key is only sent to " + from.origin);
          return errorResponse(400, "invalid_request_error",
            "claude-desktop-extra custom models: provider \"" + p.id + "\" redirected to another host (" + next.origin +
            ") - the key is not sent there; check its base URL in Settings > Extra > Models");
        }
        return hops >= 3 ? res : post(next.href, opts, hops + 1);
      });
    }
    function send(stripThinking, dropEffort) {
      return post(target, {
        method: init.method || "POST",
        headers: native ? nativeHeaders(init, p) : outHeaders(init, p),
        // Native: the request as the CLI wrote it (cache_control, betas,
        // signed thinking...), only the model id is the provider's.
        body: native ? JSON.stringify(nativeBody(body, m, stripThinking))
          : JSON.stringify(sanitize(body, r, { stripThinking: stripThinking, dropEffort: dropEffort })),
        signal: init.signal
      }, 0);
    }
    var n = Array.isArray(body.messages) ? body.messages.length : 0;
    log("-> " + p.id + "/" + m.id + (native ? " (native" + (isCount ? ", count_tokens)" : ")") : "") +
      (viaWebSearch ? " (web search, instead of " + body.model + ")" : "") +
      (viaPin ? " (kept for this session: named by its environment at spawn)" : "") +
      " stream=" + !!body.stream + " messages=" + n + " tools=" + (Array.isArray(body.tools) ? body.tools.length : 0));

    return (async function () {
      var strip = false, drop = false;
      var res = await send(strip, drop);
      // At most two retries, each dropping what the provider's 400 names;
      // they add up, since one turn can need both.
      for (var tries = 0; tries < 2 && res.status === 400; tries++) {
        var text = "";
        try { text = await res.clone().text(); } catch (e) {}
        if (!native && !drop && effortRefused(text)) {
          // A level the provider does not know: drop the effort, keep the turn.
          drop = true;
          var sentEffort = body.output_config && body.output_config.effort;
          log("400 effort " + JSON.stringify(sentEffort) + " refused by " + p.id + " -> retry without effort (untick that level in Settings > Extra > Models): " + text.slice(0, 200));
        } else if (!strip && /thinking|signature/i.test(text) && !/thinking options type cannot be disabled/i.test(text)) {
          // History carrying thinking blocks signed by Claude (model switched
          // mid-session): the provider may refuse them - retry without.
          strip = true;
          log("400 thinking/signature -> retry without thinking blocks: " + text.slice(0, 200));
        } else break;
        res = await send(strip, drop);
      }
      if (!res.ok) {
        var t2 = "";
        try { t2 = await res.clone().text(); } catch (e) {}
        log("<- " + p.id + "/" + m.id + " HTTP " + res.status + " " + t2.slice(0, 300));
        // The provider's 401/403 (wrong or revoked key) must not reach the
        // CLI as such: it would take it for its own OAuth token expiring and
        // refresh-and-retry without end. Nor as an "authentication_error"
        // type: the desktop app reads that as its own login being gone and
        // re-authorises, restarting the session's CLI. A plain 400 with the
        // provider's words shows in the session and stops there.
        if (res.status === 401 || res.status === 403) {
          return errorResponse(400, "invalid_request_error",
            "claude-desktop-extra custom models: provider \"" + p.id + "\" refused the API key (HTTP " + res.status +
            ") - check it in Settings > Extra > Models. Provider said: " + t2.slice(0, 300));
        }
      } else if (!isCount) {
        var stopUsage = logUsage(p, m, res);
        // Anthropic's own API streams well-formed blocks: left as it is.
        if (!native && body.stream === true) res = reblockStream(p, m, res, stopUsage);
      }
      return res;
    })();
  }

  // A request to Anthropic that follows a turn answered by a custom model:
  // the CLI names the previous assistant message in
  // diagnostics.previous_message_id, and Anthropic refuses an id it did not
  // mint ("must be the id from a prior /v1/messages response, starts with
  // msg_") - OpenRouter's are gen-..., DeepSeek's happen to pass. The field
  // is diagnostic; null is what the CLI sends when it has none.
  function foreignPreviousId(rawFetch, input, init) {
    if (init.body.indexOf('"previous_message_id"') === -1) return null;
    var body;
    try { body = JSON.parse(init.body); } catch (e) { return null; }
    var d = body && body.diagnostics;
    if (!d || typeof d !== "object" || typeof d.previous_message_id !== "string" || /^msg_/.test(d.previous_message_id)) return null;
    log("previous_message_id " + d.previous_message_id.slice(0, 24) + " is not Anthropic's -> sent as null (model " + body.model + ")");
    d.previous_message_id = null;
    return rawFetch(input, Object.assign({}, init, { body: JSON.stringify(body) }));
  }

  function hook(base) {
    return function fetch(input, init) {
      try {
        var r = route(base, input, init);
        if (r) return r;
      } catch (e) {
        log("fetch hook: " + (e && e.message) + " -> passthrough");
      }
      return base.call(this, input, init);
    };
  }
  var rawFetch = globalThis.fetch;
  var hooked = hook(rawFetch);
  Object.keys(rawFetch).forEach(function (k) { hooked[k] = rawFetch[k]; }); // Bun: fetch.preconnect...
  globalThis.fetch = hooked;

  // CLI 2.1.284+: a standalone build sends its API requests through a
  // Bun.FetchSession (connection reuse) unless globalThis.fetch differs from
  // the one it captured at start - which, captured after this preload ran,
  // is our hook. So the sessions it creates route too. Their `fetch` is a
  // non-configurable prototype getter, hence the subclass and an own property.
  var NativeSession = typeof Bun !== "undefined" ? Bun.FetchSession : undefined;
  if (typeof NativeSession === "function") {
    try {
      Bun.FetchSession = class FetchSession extends NativeSession {
        constructor(opts) {
          super(opts);
          var self = this, own = this.fetch;
          var sessionFetch = function (input, init) { return own.call(self, input, init); };
          Object.defineProperty(this, "fetch", { value: hook(sessionFetch), writable: true, configurable: true });
        }
      };
    } catch (e) {
      log("Bun.FetchSession not hooked (" + (e && e.message) + ") - requests the CLI sends through it are not routed");
    }
  }

  log("active: " + describeRoutes() + (routesPath ? " (live from " + routesPath + ")" : ""));

  if (SELFTEST) {
    globalThis.__cdbCustomModelsPreload = { sanitize: sanitize, route: route, rawFetch: rawFetch,
      get routes() { return routes; }, refreshRoutes: refreshRoutes };
  }
})();
