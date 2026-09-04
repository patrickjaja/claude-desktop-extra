/*
 * extra_settings_main.js - main-process half of the "Extra" settings area.
 * Injected into .vite/build/index.js by patches/add_feature_extra_settings.nim.
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
 * sender (main frame of an http(s) webContents), flag ids must exist in the
 * catalog, and values are restricted to JSON scalars.
 *
 * The two placeholder string literals below are replaced at build time by the
 * Nim patch with the contents of js/extra_settings_page.js and
 * js/extra_settings_page.css. They stay plain strings here so this file passes
 * node --check on its own.
 */
;/*__CDB_EXTRA_SETTINGS__*/(function () {
  "use strict";
  if (typeof process === "undefined" || process.platform !== "linux") return;

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
  // 3P Setup writes and this page exposes. A managed config with
  // authentication.disableClaudeAiSignIn (flat: disableDeploymentModeChooser)
  // overrides even that, which is why this page never writes that key.
  //
  // So everything here is user-level and userData-relative: no root, no patch to
  // the bootstrap, and the files are the ones upstream already reads. Both live
  // in the "-3p" sibling of the ACTIVE profile's userData, which is where
  // upstream keeps them regardless of the mode that ended up active.

  var __cdbEx_ETC_DIR = "/etc/claude-desktop";
  var __cdbEx_ETC_FILE = __cdbEx_ETC_DIR + "/managed-settings.json";
  var __cdbEx_MODE_KEY = "deploymentMode";
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

  // The managed-config key catalog of Claude Desktop v1.46388.2 (143 keys), read out of the
  // bundle's own schema (flat key, zod leaf type, scopes, title). Upstream drives
  // its 3P Setup wizard from that schema; we cannot reach it from here (it is
  // module-scoped in index.pre.js), so this is a PINNED COPY and is therefore
  // version-sensitive: re-extract it on an upstream bump with
  //   rg -ao 'flatKey:[`"][A-Za-z0-9_]+[`"]' .vite/build/index.pre.js
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
      label: "Default to 1M context", note: "Prefer the 1M-token context window variant when a model offers one (upstream gates this @next)." },
    { key: "inferenceModelPricingEnabled", kind: "bool", group: "connection", scope: "3p",
      label: "Show estimated cost",
      note: "Puts a USD cost estimate on the Usage page; without it that page reports token counts only, because the app cannot know your negotiated rates (upstream gates this @next)." },
    { key: "inferenceModelPricingMultiplier", kind: "num", group: "connection", scope: "3p",
      label: "Price multiplier", min: 0, max: 1,
      note: "Scales every estimated cost, e.g. 0.85 for 85% of the rate; greater than 0 and at most 1 (upstream gates this @next)." },
    { key: "inferenceModelPricing", kind: "json", group: "connection", scope: "3p",
      label: "Per-model rates",
      note: "JSON array of { name, inputPerMtok, outputPerMtok, cacheReadPerMtok, cacheWritePerMtok } rows, each replacing Anthropic list price for one model id in the Usage estimate (upstream gates this @next)." },
    { key: "inferenceCredentialKind", kind: "enum", group: "connection", scope: "3p",
      label: "Credential kind",
      options: ["static", "helper-script", "interactive", "vendor-profile", "oauth", "workforce"] },
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
      note: "Keeps Claude Desktop signed in to one account at a time (upstream gates this @next)." },
    { key: "entraClientId", kind: "text", group: "connection", scope: "3p",
      label: "Entra application (client) ID",
      note: "Your organization's Entra app registration for the Microsoft 365 add-in; unset uses the add-in's published application (upstream gates this @next)." },
    { key: "entraAzureCloud", kind: "enum", group: "connection", scope: "3p",
      label: "Azure cloud", options: ["global", "us-gov-high", "us-gov-dod", "china"],
      note: "Microsoft cloud the add-in signs in against; anything other than global needs your own client ID (upstream gates this @next)." },
    { key: "entraScope", kind: "text", group: "connection", scope: "3p",
      label: "Entra delegated scope",
      note: "Delegated scopes the add-in requests, space- or comma-separated and all for one resource, e.g. api://.../.default; requires your own client ID (upstream gates this @next)." },

    // --- usage limits -------------------------------------------------------
    { key: "inferenceMaxTokensPerWindow", kind: "int", group: "limits", scope: "3p",
      label: "Max tokens per window" },
    { key: "inferenceTokenWindowHours", kind: "int", group: "limits", scope: "3p",
      label: "Token cap window (h)", max: 720 },

    // --- surfaces, sandbox & tools -----------------------------------------
    { key: "chatTabEnabled", kind: "bool", group: "sandbox", scope: "3p", label: "Chat tab" },
    { key: "coworkTabEnabled", kind: "bool", group: "sandbox", scope: "3p", label: "Cowork tab", dflt: true },
    { key: "isClaudeCodeForDesktopEnabled", kind: "bool", group: "sandbox", scope: "both",
      label: "Code tab", dflt: true },
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
    { key: "userPluginMarketplacesEnabled", kind: "bool", group: "sandbox", scope: "3p", dflt: true,
      label: "Allow user-added plugin marketplaces",
      note: "Off hides the add-marketplace surfaces and refuses adds that still reach the app; marketplaces already registered on the machine and org-provisioned ones are unaffected (upstream gates this @next)." },
    { key: "userPluginUploadsEnabled", kind: "bool", group: "sandbox", scope: "3p", dflt: true,
      label: "Allow user-added plugins",
      note: "Off hides every in-app way to add a plugin and refuses uploads that still reach the app; already-installed and org-provisioned plugins are unaffected (upstream gates this @next)." },
    { key: "skipWebFetchPreflight", kind: "bool", group: "sandbox", scope: "3p",
      label: "Skip WebFetch domain check",
      note: "Drops Claude Code's per-domain blocklist lookup against api.anthropic.com before a WebFetch; turn it on where that host is firewalled, since the fetch otherwise fails outright (upstream gates this @next)." },
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
    { key: "blockReadsOutsideWorkingDirectories", kind: "bool", group: "sandbox", scope: "both",
      label: "Block reads outside working directories",
      note: "File tools refuse reads outside a Code session's working directories and sandboxed shell commands lose the home directory (upstream gates this @next)." },
    { key: "disableBypassPermissionsMode", kind: "bool", group: "sandbox", scope: "3p",
      label: "Disable bypass permissions mode",
      note: "Removes the bypass permissions mode from Code sessions and Cowork tasks, so Claude always follows the permission policy (upstream gates this @next)." },
    { key: "sshHostAllowlist", kind: "lines", group: "sandbox", scope: "3p",
      label: "SSH host allowlist",
      note: "One host pattern per line; empty means SSH sessions stay off unless the device's Claude Code managed-settings allowlist applies. * allows any host." },
    { key: "sshClientPath", kind: "text", group: "sandbox", scope: "3p",
      label: "SSH client program",
      note: "Absolute path to the OpenSSH ssh program used for SSH sessions; unset uses the first ssh on PATH (upstream gates this @next)." },
    { key: "builtinBrowserEnabled", kind: "bool", group: "sandbox", scope: "3p",
      label: "Allow the built-in browser",
      note: "Offers the built-in browser in Cowork and Code sessions; takes effect after an app restart (upstream gates this @next)." },
    { key: "builtinBrowserDefaultDomainPolicy", kind: "enum", group: "sandbox", scope: "3p",
      label: "Default site policy in the built-in browser", options: ["allow", "block"],
      note: "Whether Claude may open sites in the built-in browser by default; the allowed or blocked list is the exception (upstream gates this @next)." },
    { key: "builtinBrowserAllowedDomains", kind: "lines", group: "sandbox", scope: "3p",
      label: "Allowed sites in the built-in browser",
      note: "One site per line; the exceptions when the default site policy is block (upstream gates this @next)." },
    { key: "builtinBrowserBlockedDomains", kind: "lines", group: "sandbox", scope: "3p",
      label: "Blocked sites in the built-in browser",
      note: "One site per line; the exceptions when the default site policy is allow (upstream gates this @next)." },
    { key: "officeDisabledHosts", kind: "lines", group: "sandbox", scope: "3p",
      label: "Disabled Office applications",
      note: "One of sheet, slide, doc, mail per line - Office hosts where the Claude add-in for Microsoft 365 is turned off (upstream gates this @next)." },
    { key: "officeDisabledFeatures", kind: "lines", group: "sandbox", scope: "3p",
      label: "Disabled add-in features",
      note: "One of skills.authoring, thumbs, addin.access, file.upload, web_search per line; addin.access turns the add-in off (upstream gates this @next)." },
    { key: "officeAccessPolicies", kind: "json", group: "sandbox", scope: "3p",
      label: "Document access policies",
      note: "JSON array of { effect, action, resource } statements keyed on the Microsoft Purview sensitivity label of the open or attached file (upstream gates this @next)." },
    { key: "disableDeploymentModeChooser", kind: "bool", group: "sandbox", scope: "3p",
      label: "Disable claude.ai sign-in",
      lock: "this is the key that locks a machine into 3P - it overrides the switch above, so this page never writes it" },

    // --- connectors, MCP & extensions --------------------------------------
    { key: "managedMcpServers", kind: "json", group: "connectors", scope: "3p",
      label: "Managed MCP servers",
      lock: "an MCP server entry can start a process, so it is read-only here - deploy it through /etc/claude-desktop/managed-settings.json" },
    { key: "isLocalDevMcpEnabled", kind: "bool", group: "connectors", scope: "both",
      label: "Allow user-added MCP servers", dflt: true },
    { key: "mcpPersistentAlwaysAllowEnabled", kind: "bool", group: "connectors", scope: "3p",
      label: "Allow persistent tool approvals", dflt: true },
    { key: "mcpToolTimeoutSec", kind: "int", group: "connectors", scope: "3p", max: 3600,
      label: "MCP tool call timeout (s)",
      note: "Per-call deadline for every MCP tool call, 60 to 3600; Cowork and Chat default to 180, and setting it introduces a timeout in Code sessions too (upstream gates this @next)." },
    { key: "claudeInChromeEnabled", kind: "bool", group: "connectors", scope: "3p",
      label: "Enable Claude in Chrome" },
    { key: "isDesktopExtensionEnabled", kind: "bool", group: "connectors", scope: "both",
      label: "Allow desktop extensions" },
    { key: "isDesktopExtensionSignatureRequired", kind: "bool", group: "connectors", scope: "both",
      label: "Require signed extensions" },
    { key: "isDesktopExtensionDirectoryEnabled", kind: "bool", group: "connectors", scope: "1p",
      label: "Show the extension directory" },
    { key: "microsoftAuthBroker", kind: "enum", group: "connectors", scope: "3p",
      label: "Microsoft 365 sign-in broker", options: ["auto", "disabled"] },
    { key: "hardwareBuddyEnabled", kind: "bool", group: "connectors", scope: "1p",
      label: "Allow Hardware Buddy devices", dflt: true },

    // --- plugins ------------------------------------------------------------
    { key: "organizationPluginsUrl", kind: "text", group: "plugins", scope: "3p",
      label: "Organization plugins endpoint" },
    { key: "allowedPluginMarketplaces", kind: "json", group: "plugins", scope: "3p",
      label: "Allowed plugin marketplaces" },
    { key: "orgPluginSettings", kind: "json", group: "plugins", scope: "3p",
      label: "Organization plugin settings" },

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
    { key: "disableAutoUpdates", kind: "bool", group: "telemetry", scope: "both",
      label: "Block auto-updates",
      note: "Packaged builds are updated by your package manager, so this only silences the in-app updater." },
    { key: "autoUpdaterEnforcementHours", kind: "int", group: "telemetry", scope: "both",
      label: "Auto-update enforcement window (h)", max: 72 },
    { key: "deploymentOrganizationUuid", kind: "text", group: "telemetry", scope: "3p",
      label: "Organization UUID" },
    { key: "endUserAttribution", kind: "bool", group: "telemetry", scope: "3p", label: "End-user attribution",
      note: "Renamed upstream in v1.24012 (the all-lowercase enduserAttribution is still read as a legacy key)." },
    { key: "updateViaUpdatesHost", kind: "bool", group: "telemetry", scope: "3p",
      label: "Check for updates on releases.claude.ai",
      note: "Upstream marks this @next - present in the schema but not active in this version yet." },

    { key: "otlpAttrMaxChars", kind: "int", group: "telemetry", scope: "3p", max: 32000,
      label: "Telemetry attribute length limit",
      note: "Maximum characters per content-bearing span attribute sent to the collector, 256 to 32000; default 4000 (upstream gates this @next)." },
    { key: "usageMetricsEnabled", kind: "bool", group: "telemetry", scope: "3p",
      label: "Report usage metrics",
      lock: "set by the Anthropic control plane from the organization's Claude Code analytics setting and hidden in upstream's own wizard, so this page never writes it" },
    { key: "relaunchEnforcementHours", kind: "int", group: "telemetry", scope: "3p", max: 336,
      label: "Configuration relaunch window (h)",
      note: "Hours a user may keep working on the old configuration after a managed-configuration change is detected; blank means 24. Upstream also accepts 0 for an immediate restart, which this page cannot write." },
    { key: "configRecheckIntervalMinutes", kind: "int", group: "telemetry", scope: "3p", max: 30,
      label: "Configuration re-check interval (min)",
      note: "Minutes between the running app's checks for a changed managed configuration, 2 to 30; blank means 10 (upstream gates this @next)." },

    // --- appearance & branding ---------------------------------------------
    { key: "deploymentDisplayName", kind: "text", group: "appearance", scope: "3p",
      label: "Deployment display name" },
    { key: "deploymentDisplaySubtitle", kind: "text", group: "appearance", scope: "3p",
      label: "Deployment display subtitle" },
    { key: "banner", kind: "json", group: "appearance", scope: "both", label: "Organization banner" },
    { key: "disableFeatureDiscovery", kind: "bool", group: "appearance", scope: "3p",
      label: "Hide feature announcements" },

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
      note: "JSON object of HTTP headers sent on every bootstrap config fetch - use instead of embedding user:pass@ in the URL (upstream gates this @next)." },
    { key: "bootstrapHeadersHelper", kind: "text", group: "source", scope: "3p",
      label: "Bootstrap headers helper script",
      note: "Absolute path to an executable that prints a JSON object of bootstrap headers; merged over the static headers, the helper wins (upstream gates this @next)." },
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
    var out = { present: false, usable: false, keys: [], provider: null, locksSignIn: false, error: "" };
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
    out.locksSignIn = cfg.disableDeploymentModeChooser === true;
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

  // Does this config select 3P at all? Upstream's own test: an inference block
  // (i.e. a provider) or an enabled bootstrap URL.
  function __cdbEx_selects3p(cfg) {
    if (!cfg) return false;
    if (typeof cfg.inferenceProvider === "string" && cfg.inferenceProvider) return true;
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
      ? { provider: managed.provider, selects3p: !!managed.provider, locksSignIn: managed.locksSignIn }
      : { provider: local.values.inferenceProvider || null, selects3p: !!local.selects3p, locksSignIn: false };
    var expected = active.selects3p && (active.locksSignIn || persisted !== "1p") ? "3p" : "1p";
    return {
      paths: paths,
      managed: managed,
      local: local,
      source: source,
      persisted: persisted,
      expected: expected,
      running: __cdbEx_runningMode(expected),
      editable: source !== "managed",
      locksSignIn: active.locksSignIn
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
          if (typeof list[i] !== "string") return { error: entry.key + " must be a list of strings" };
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
  // Only the main frame of an http(s) webContents, i.e. the mainView that our
  // preload bridge lives in. Subframes never get the preload, but reject them
  // explicitly rather than relying on that.
  function __cdbEx_okSender(ev) {
    try {
      var wc = ev && ev.sender;
      if (!wc || wc.isDestroyed()) return false;
      if (!/^https?:\/\//i.test(wc.getURL() || "")) return false;
      var frame = ev.senderFrame;
      if (frame && frame.parent) return false;
      return true;
    } catch (e) { return false; }
  }

  function __cdbEx_guard(fn) {
    return function (ev) {
      if (!__cdbEx_okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
      try {
        return fn.apply(null, Array.prototype.slice.call(arguments, 1));
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      }
    };
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

    // Cowork glow. The live half lives in patches/add_feature_cowork_glow.nim
    // (globalThis.__cdbCoworkGlow); persistence is ours because this file is the
    // single writer of the .json.
    "cdb-glow:read": function () {
      var g = globalThis.__cdbCoworkGlow;
      if (!g) return { ok: false, error: "the Cowork glow patch is not installed in this build" };
      var s = g.read();
      var jsonc = __cdbEx_readFileKey(__cdbEx_paths().jsonc, "coworkGlow");
      return {
        ok: true,
        mode: s.mode,
        opacity: s.opacity,
        defaultOpacity: s.defaultOpacity,
        // A hand-edited .jsonc wins the per-key merge at startup, so the switch
        // must show itself as locked rather than silently disagree with the file.
        lockedByJsonc: jsonc === "pulse" || jsonc === "calm" ? jsonc : null
      };
    },

    "cdb-glow:set": function (mode) {
      var g = globalThis.__cdbCoworkGlow;
      if (!g) return { ok: false, error: "the Cowork glow patch is not installed in this build" };
      if (mode !== "pulse" && mode !== "calm") return { ok: false, error: "mode must be \"pulse\" or \"calm\"" };
      var live = g.set(mode);
      if (!live || live.ok !== true) return live || { ok: false, error: "could not apply the glow mode" };
      var res = __cdbEx_writeCfg(function (cfg) {
        if (mode === "calm") cfg.coworkGlow = "calm";
        else delete cfg.coworkGlow;
        return mode;
      });
      if (!res.ok) return { ok: false, error: "applied to " + live.windows + " window(s) but could not save: " + res.error };
      return { ok: true, mode: mode, windows: live.windows, path: res.path };
    },

    // Theme picker (Ctrl+Shift+T). The window and the hotkey live in
    // patches/community/add_feature_theme_picker.nim, which reads this same key
    // itself on every press - persistence is ours because this file is the
    // single writer of the .json, the same cross-patch split as the glow above.
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
      if (mode === "1p" && s.locksSignIn) {
        return { ok: false, error: "the managed policy in " + __cdbEx_ETC_FILE +
          " sets disableDeploymentModeChooser, which overrides the deploymentMode key - 1P cannot be selected here" };
      }
      if (mode === "3p" && s.source === "none") {
        return { ok: false, error: "no third-party configuration is stored yet - pick a provider below first, then switch" };
      }
      if (mode === "3p" && s.source === "local" && !s.local.selects3p) {
        return { ok: false, error: "the stored configuration has no inference provider and no bootstrap URL, so it would still boot 1P - set a provider below first" };
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

    "cdb-app:relaunch": function () {
      __cdbEx_log("relaunch requested from the Extra settings page");
      setTimeout(function () {
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
  // insertCSS survives navigations within a webContents, so it is inserted once
  // per webContents; the page script is idempotent on its own side and re-runs
  // after a real reload.
  var __cdbEx_styled = new WeakSet();

  _app.on("web-contents-created", function (_ev, wc) {
    wc.on("dom-ready", function () {
      try {
        var url = wc.getURL() || "";
        if (!/^https?:\/\//i.test(url)) return;
        if (/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(url)) return;
        if (!__cdbEx_styled.has(wc)) {
          __cdbEx_styled.add(wc);
          wc.insertCSS(__cdbEx_pageCss).catch(function () {});
        }
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
