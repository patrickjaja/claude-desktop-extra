#!/usr/bin/env node
/*
 * test-custom-models-preload.mjs - the Claude Code CLI half of the custom
 * models feature. js/custom_models_preload.js runs inside the Claude Code
 * binary (Bun); here it runs under Node with CDB_CUSTOM_MODELS_SELFTEST=1,
 * which skips the Bun/execPath gates and exports its internals. Every check
 * is about what leaves the process: which URL, which headers, which body.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import Module from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok   " + n); }
  else { fail++; console.log("  FAIL " + n); } };

const CONFIG = {
  webSearch: "claude-deepseek-flash",
  providers: [{
    id: "deepseek", baseUrl: "https://api.deepseek.com/anthropic", apiKey: "sk-test-1234567890",
    models: [{ id: "deepseek-flash", vision: true, thinking: true }, { id: "deepseek-pro", vision: false, thinking: false }]
  }, {
    id: "nokey", baseUrl: "https://gw.example/anthropic", apiKey: "",
    models: [{ id: "gw-model", vision: true, thinking: true }]
  }]
};

// Loads the preload with a recording fetch; returns its exported internals,
// the recorded calls and the sandbox env (to check the scrub).
function load(cfg, opts) {
  const calls = [];
  const responses = (opts && opts.responses) || [];
  const rawFetch = function (input, init) {
    calls.push({ url: typeof input === "string" ? input : input.href, init });
    const r = responses.shift();
    return Promise.resolve(r || new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  };
  rawFetch.preconnect = function () {};
  const env = Object.assign({
    CDB_CUSTOM_MODELS_SELFTEST: "1",
    CDB_CUSTOM_MODELS_JSON: cfg === null ? undefined : JSON.stringify(cfg),
    BUN_OPTIONS: "--smol --preload=/home/u/.config/Claude/custom-models/preload.js",
    PATH: "/usr/bin"
  }, (opts && opts.env) || {});
  Object.keys(env).forEach((k) => { if (env[k] === undefined) delete env[k]; });
  const sandbox = {
    require: (m) => Module.createRequire(import.meta.url)(m),
    process: { env, pid: 4242, execPath: "/usr/bin/node" },
    fetch: rawFetch, Response, Headers, URL, Buffer, console, TextDecoder, TextEncoder, ReadableStream
  };
  if (opts && opts.Bun) sandbox.Bun = opts.Bun;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(readFileSync(join(ROOT, "js/custom_models_preload.js"), "utf8"), vm.createContext(sandbox));
  return { api: sandbox.__cdbCustomModelsPreload, hooked: sandbox.fetch, rawFetch, calls, env };
}

function messagesInit(body, extra) {
  return Object.assign({
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "anthropic-beta": "context-1m-2025-08-07",
      "authorization": "Bearer sk-ant-oauth-secret", "x-api-key": "should-not-leak" },
    body: JSON.stringify(body)
  }, extra || {});
}
const ANTHROPIC = "https://api.anthropic.com/v1/messages";

// --- environment scrub --------------------------------------------------------
{
  const { api, env } = load(CONFIG);
  ok(!!api, "exports its internals under selftest");
  ok(!("CDB_CUSTOM_MODELS_JSON" in env), "the provider config (with the key) is deleted from process.env");
  ok(!("CDB_CUSTOM_MODELS_LOG" in env), "the log path is deleted from process.env");
  ok(env.BUN_OPTIONS === "--smol", "only our --preload token is stripped from BUN_OPTIONS: " + env.BUN_OPTIONS);
  ok(env.PATH === "/usr/bin", "other variables are untouched");
  const { env: env2 } = load(CONFIG, { env: { BUN_OPTIONS: "--preload=/home/u/.config/Claude/custom-models/preload.js" } });
  ok(!("BUN_OPTIONS" in env2), "BUN_OPTIONS is removed entirely when ours was its only content");
}

// --- no config / no match -> passthrough ---------------------------------------
{
  const { api, hooked, rawFetch } = load(null);
  ok(api === undefined && hooked === rawFetch, "no config: fetch is not hooked at all");
}
{
  const { api, hooked, rawFetch, calls } = load(CONFIG);
  ok(hooked !== rawFetch && typeof hooked.preconnect === "function", "fetch is replaced and keeps its static members");
  ok(api.routes.size === 3 && api.routes.has("claude-deepseek-flash") && api.routes.has("claude-gw-model"),
     "routes are keyed by the claude- alias");
  await hooked(ANTHROPIC, messagesInit({ model: "claude-opus-5", messages: [{ role: "user", content: "hi" }] }));
  ok(calls.length === 1 && calls[0].url === ANTHROPIC, "a Claude model goes to Anthropic untouched");
  ok(calls[0].init.headers.authorization === "Bearer sk-ant-oauth-secret", "its headers are the original object");
  await hooked("https://api.anthropic.com/v1/oauth/token", { method: "POST", body: "{}" });
  ok(calls.length === 2 && calls[1].url.endsWith("/oauth/token"), "non-messages endpoints pass through");
  await hooked("https://api.anthropic.com/v1/messages", { method: "GET" });
  ok(calls.length === 3, "a request without a string body passes through");
}

// --- a routed request: URL, headers, body --------------------------------------
{
  const { hooked, calls } = load(CONFIG);
  const body = {
    model: "claude-deepseek-flash[1m]", max_tokens: 32000, stream: true, temperature: 1,
    system: [{ type: "text", text: "You are Claude.", cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "sig" }, { type: "text", text: "hi" },
        { type: "tool_use", id: "t1", name: "Read", input: { path: "x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "file" }], cache_control: { type: "ephemeral" } }] },
      { role: "system", content: "effort changed" },
      { role: "user", content: "and now?" }
    ],
    tools: [{ name: "Read", description: "reads", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
      { type: "web_search_20250305", name: "web_search" }, { type: "mcp_toolset", name: "x" }],
    tool_choice: { type: "auto" },
    thinking: { type: "enabled", budget_tokens: 31999 },
    output_config: { effort: "xhigh" },
    metadata: { user_id: "u" }, context_management: { edits: [] }, top_k: 5
  };
  const res = await hooked(ANTHROPIC, messagesInit(body));
  ok(calls.length === 1 && calls[0].url === "https://api.deepseek.com/anthropic/v1/messages",
     "a custom model is sent to the provider's /v1/messages: " + (calls[0] && calls[0].url));
  const h = calls[0].init.headers;
  ok(h instanceof Headers && h.get("x-api-key") === "sk-test-1234567890", "x-api-key is the provider key");
  ok(!h.has("authorization") && !h.has("anthropic-beta"), "the OAuth Authorization and beta headers do not leave");
  ok(h.get("anthropic-version") === "2023-06-01" && h.get("content-type") === "application/json", "version and content-type are kept");
  const out = JSON.parse(calls[0].init.body);
  ok(out.model === "deepseek-flash", "the [1m] suffix and the claude- prefix are removed for the provider");
  ok(out.max_tokens === 32000 && out.stream === true && out.temperature === 1, "plain parameters are forwarded");
  ok(!("metadata" in out) && !("context_management" in out) && !("top_k" in out), "Anthropic-only fields are dropped");
  ok(Array.isArray(out.system) && out.system.length === 1 && !("cache_control" in out.system[0]), "system blocks lose cache_control");
  ok(out.messages.length === 3, "user, assistant, then tool_result + folded system + user text merge into one user turn (" + out.messages.length + ")");
  ok(out.messages[0].content[1].type === "image", "images pass for a vision model");
  ok(out.messages[1].content[0].type === "thinking", "thinking blocks are kept on the first attempt");
  ok(out.messages[2].content.length === 3 && out.messages[2].content[1].text === "[system] effort changed" &&
     out.messages[2].content[2].text === "and now?", "a mid-conversation system message is folded as [system] user text");
  ok(!("cache_control" in out.messages[2].content[0]), "tool_result loses cache_control");
  ok(out.tools.length === 2 && out.tools[0].name === "Read" && !("cache_control" in out.tools[0]) &&
     out.tools[1].type === "web_search_20250305", "tools keep the schema ones and the web_search one, drop the rest");
  ok(out.tool_choice && out.tool_choice.type === "auto", "tool_choice is forwarded");
  ok(out.thinking.type === "enabled" && out.thinking.budget_tokens === 16000, "thinking budget is clamped to 16000");
  ok(out.output_config && out.output_config.effort === "max", "xhigh maps to max by default");
  ok(res && res.status === 200, "the provider's response is returned as is");
}

// --- thinking off, no-vision model, effort map, headers -------------------------
{
  const cfg = JSON.parse(JSON.stringify(CONFIG));
  cfg.providers[0].effortMap = { xhigh: "high" };
  cfg.providers[0].headers = { "x-extra": "1" };
  const { hooked, calls } = load(cfg);
  await hooked(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 100,
    messages: [{ role: "user", content: "x" }], thinking: { type: "disabled" }, output_config: { effort: "xhigh" } }));
  let out = JSON.parse(calls[0].init.body);
  ok(out.thinking.type === "disabled" && !("output_config" in out), "mode Off: thinking disabled and no effort travels with it");
  ok(calls[0].init.headers.get("x-extra") === "1", "provider headers are added");
  await hooked(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 4000,
    messages: [{ role: "user", content: "x" }], thinking: { type: "enabled", budget_tokens: 2000 }, output_config: { effort: "xhigh" } }));
  out = JSON.parse(calls[1].init.body);
  ok(out.output_config.effort === "high", "effortMap overrides the default mapping");
  await hooked(ANTHROPIC, messagesInit({ model: "claude-deepseek-pro", max_tokens: 100,
    messages: [{ role: "user", content: [{ type: "image", source: {} }, { type: "text", text: "see" }] }],
    thinking: { type: "enabled", budget_tokens: 10 }, output_config: { effort: "max" } }));
  out = JSON.parse(calls[2].init.body);
  ok(out.thinking.type === "disabled" && !("output_config" in out), "thinking:false forces thinking off even when requested");
  ok(out.messages[0].content[0].type === "text" && /image omitted/.test(out.messages[0].content[0].text),
     "a no-vision model gets a placeholder instead of the image");
}

// --- thinking follows the request; the budget is always valid ---------------------
{
  const { hooked, calls } = load(CONFIG);
  const send = (extra) => hooked(ANTHROPIC, messagesInit(Object.assign({ model: "claude-deepseek-flash",
    messages: [{ role: "user", content: "x" }] }, extra)));
  await send({ max_tokens: 512, output_config: { effort: "max" } });
  let out = JSON.parse(calls[0].init.body);
  ok(!("thinking" in out) && !("output_config" in out),
     "a request without thinking (WebFetch synthesis, the classifier) stays without thinking or effort");
  await send({ max_tokens: 512, thinking: { type: "enabled", budget_tokens: 400 } });
  out = JSON.parse(calls[1].init.body);
  ok(!("thinking" in out), "max_tokens too small for the 1024 minimum: no thinking rather than budget >= max_tokens");
  await send({ max_tokens: 3000, thinking: { type: "enabled", budget_tokens: 8000 } });
  out = JSON.parse(calls[2].init.body);
  ok(out.thinking.type === "enabled" && out.thinking.budget_tokens === 2999, "the budget stays below max_tokens");
  await send({ max_tokens: 3000, thinking: { type: "enabled", budget_tokens: 1500 } });
  out = JSON.parse(calls[3].init.body);
  ok(out.thinking.budget_tokens === 1500, "a budget the request chose within the limits is kept");
  await send({ max_tokens: 64000, thinking: { type: "adaptive" }, output_config: { effort: "high" } });
  out = JSON.parse(calls[4].init.body);
  ok(out.thinking.type === "enabled" && out.thinking.budget_tokens === 16000 && out.output_config.effort === "high",
     "adaptive thinking becomes enabled with the clamped budget, effort travels with it");
}

// --- adaptive-only Claude models behind a relay: never budget_tokens or disabled -------
{
  const cfg = { providers: [{ id: "relay", baseUrl: "https://relay.example", apiKey: "sk-test-relay",
    models: [{ id: "claude-fable-5-2", alias: "claude-relay-fable-5-2", vision: true, thinking: true },
      { id: "claude-opus-5-5", alias: "claude-relay-opus-5-5", vision: true, thinking: true }] }] };
  const { hooked, calls } = load(cfg);
  const send = (model, extra) => hooked(ANTHROPIC, messagesInit(Object.assign({ model,
    max_tokens: 32000, messages: [{ role: "user", content: "x" }] }, extra)));
  await send("claude-relay-fable-5-2", { thinking: { type: "enabled", budget_tokens: 31999 }, output_config: { effort: "xhigh" } });
  let out = JSON.parse(calls[0].init.body);
  ok(out.thinking && out.thinking.type === "adaptive" && !("budget_tokens" in out.thinking),
     "Fable 5.x: requested thinking is sent as adaptive, without budget_tokens");
  ok(out.output_config && out.output_config.effort === "xhigh", "Fable 5.x: effort is forwarded unmapped");
  await send("claude-relay-fable-5-2", { thinking: { type: "disabled" }, output_config: { effort: "low" } });
  out = JSON.parse(calls[1].init.body);
  ok(!("thinking" in out) && out.output_config.effort === "low",
     "Fable 5.x: mode Off omits thinking (disabled is a 400) and keeps effort");
  await send("claude-relay-opus-5-5", { thinking: { type: "adaptive" }, output_config: { effort: "medium" } });
  out = JSON.parse(calls[2].init.body);
  ok(out.thinking.type === "adaptive" && out.output_config.effort === "medium", "Opus 5.5: adaptive thinking and effort pass as is");
  await send("claude-relay-opus-5-5", {});
  out = JSON.parse(calls[3].init.body);
  ok(!("thinking" in out) && !("output_config" in out), "Opus 5.5: a request without thinking stays without it");
}

// --- max_tokens has a floor of 16: the CLI's model check sends 1 ---------------------
{
  const { hooked, calls } = load(CONFIG);
  const send = (extra) => hooked(ANTHROPIC, messagesInit(Object.assign({ model: "claude-deepseek-flash",
    messages: [{ role: "user", content: "." }] }, extra)));
  await send({ max_tokens: 1 });
  ok(JSON.parse(calls[0].init.body).max_tokens === 16, "max_tokens 1 (the model check on a switch) is sent as 16");
  await send({ max_tokens: 15 });
  ok(JSON.parse(calls[1].init.body).max_tokens === 16, "any max_tokens below 16 is sent as 16");
  await send({ max_tokens: 16 });
  ok(JSON.parse(calls[2].init.body).max_tokens === 16, "16 is kept");
  await send({});
  ok(!("max_tokens" in JSON.parse(calls[3].init.body)), "an absent max_tokens stays absent");
  await send({ max_tokens: 1, thinking: { type: "enabled", budget_tokens: 2048 } });
  ok(!("thinking" in JSON.parse(calls[4].init.body)), "the raised max_tokens is still too small for thinking: none is sent");
  // Anthropic's own API takes max_tokens 1: the native body is the CLI's.
  const native = { providers: [{ id: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-api-1234567890", native: true,
    models: [{ id: "claude-opus-5-5", alias: "claude-anthropic-opus-5-5" }] }] };
  const { hooked: hn, calls: cn } = load(native);
  await hn("https://api.anthropic.com/v1/messages?beta=true", messagesInit({ model: "claude-anthropic-opus-5-5", max_tokens: 1,
    messages: [{ role: "user", content: "." }] }));
  ok(JSON.parse(cn[0].init.body).max_tokens === 1, "a native provider gets the CLI's max_tokens 1 as it is");
}

// --- effort: an explicit list is sent as it is, effortMap overlays -----------------
{
  const cfg = JSON.parse(JSON.stringify(CONFIG));
  const THINK = { max_tokens: 4000, thinking: { type: "enabled", budget_tokens: 2000 } };
  const effortOf = async (c, level) => {
    const { hooked, calls } = load(c);
    await hooked(ANTHROPIC, messagesInit(Object.assign({ model: "claude-deepseek-flash", messages: [{ role: "user", content: "x" }],
      output_config: { effort: level } }, THINK)));
    const o = JSON.parse(calls[0].init.body);
    return o.output_config ? o.output_config.effort : undefined;
  };
  cfg.providers[0].effortMap = { xhigh: "high" };
  ok(await effortOf(cfg, "low") === "low" && await effortOf(cfg, "max") === "max" && await effortOf(cfg, "medium") === "high",
     "a partial effortMap overlays the default table instead of replacing it");
  delete cfg.providers[0].effortMap;
  cfg.providers[0].effort = ["low", "medium", "high", "xhigh", "max"];
  ok(await effortOf(cfg, "medium") === "medium" && await effortOf(cfg, "xhigh") === "xhigh",
     "a provider given an explicit list gets the app's levels unchanged");
  cfg.providers[0].effort = ["low", "high", "max"];
  ok(await effortOf(cfg, "medium") === "high" && await effortOf(cfg, "xhigh") === "max" && await effortOf(cfg, "low") === "low",
     "a level the list lacks (the CLI's /effort can name any) goes to the nearest listed one above");
  cfg.providers[0].effort = ["low", "medium"];
  ok(await effortOf(cfg, "max") === "medium", "and to the highest listed one when none is above");
}

// --- web search sent to a model without the tool: refused with the reason --------
{
  const cfg = JSON.parse(JSON.stringify(CONFIG));
  delete cfg.webSearch;
  cfg.providers[0].models.push({ id: "no-search", vision: true, thinking: true, webSearch: false });
  const { hooked, calls } = load(cfg);
  const res = await hooked(ANTHROPIC, messagesInit({ model: "claude-no-search", max_tokens: 100,
    messages: [{ role: "user", content: "search x" }], tools: [{ type: "web_search_20250305", name: "web_search" }] }));
  const j = await res.json();
  ok(calls.length === 0 && res.status === 400 && /without the web search tool/.test(j.error.message),
     "the web-search sub-request routed to a model without the tool is refused, not stripped to a search-less answer");
  await hooked(ANTHROPIC, messagesInit({ model: "claude-no-search", max_tokens: 100, messages: [{ role: "user", content: "x" }],
    tools: [{ name: "Read", input_schema: { type: "object" } }, { type: "web_search_20250305", name: "web_search" }] }));
  ok(calls.length === 1 && JSON.parse(calls[0].init.body).tools.length === 1, "a conversation listing web_search among its tools still has it stripped");
}

// --- open sessions: the spawn-time slots keep their route, gone ids are explained ----
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-pin-"));
  const routesPath = join(dir, "routes.json");
  const cfg = JSON.parse(JSON.stringify(CONFIG));
  cfg.providers[0].models.push({ id: "claude-gw-sonnet", vision: true, thinking: true });
  writeFileSync(routesPath, JSON.stringify(cfg));
  const { hooked, calls } = load(cfg, { env: { CDB_CUSTOM_MODELS_ROUTES: routesPath, ANTHROPIC_SMALL_FAST_MODEL: "claude-deepseek-pro" } });
  // The feature is turned off: routes.json empties.
  writeFileSync(routesPath, JSON.stringify({ providers: [] }));
  utimesSync(routesPath, new Date(), new Date(Date.now() + 5000));
  await hooked(ANTHROPIC, messagesInit({ model: "claude-deepseek-pro", max_tokens: 100, messages: [{ role: "user", content: "x" }] }));
  ok(calls.length === 1 && calls[0].url === "https://api.deepseek.com/anthropic/v1/messages",
     "the small/fast model named at spawn keeps its route for the session's life");
  const res = await hooked(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash[1m]", max_tokens: 100, messages: [{ role: "user", content: "x" }] }));
  const j = await res.json();
  ok(calls.length === 1 && res.status === 400 && /no longer configured/.test(j.error.message),
     "a custom model whose route is gone is refused with the reason instead of reaching Anthropic");
  await hooked(ANTHROPIC, messagesInit({ model: "claude-gw-sonnet", max_tokens: 100, messages: [{ role: "user", content: "x" }] }));
  ok(calls.length === 2 && calls[1].url === ANTHROPIC, "a gateway's own claude-* id with no route left goes back to Anthropic");
  rmSync(dir, { recursive: true, force: true });
}

// --- the CLI's threads: refused with the code it resends whole on ---------------
{
  const { hooked, calls } = load(CONFIG);
  for (const type of ["create", "continue"]) {
    const res = await hooked(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 100,
      thread: { type, previous_message_id: "msg_1" }, messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] }] }));
    const j = await res.json();
    ok(res.status === 400 && j.error && j.error.details && j.error.details.error_code === "thread_unsupported_request",
       "a thread " + type + " request for a custom model is refused with thread_unsupported_request (the CLI then resends it whole)");
  }
  ok(calls.length === 0, "nothing truncated reaches the provider");
  await hooked(ANTHROPIC, messagesInit({ model: "claude-opus-5", max_tokens: 10, thread: { type: "continue", previous_message_id: "msg_1" },
    messages: [{ role: "user", content: "hi" }] }));
  ok(calls.length === 1 && calls[0].url === ANTHROPIC && JSON.parse(calls[0].init.body).thread.type === "continue",
     "a Claude request keeps its thread");
}

// --- retries add up: one turn can need both ----------------------------------------
{
  const e400 = (msg) => new Response(JSON.stringify({ error: { message: msg } }), { status: 400 });
  const { hooked, calls } = load(CONFIG, { responses: [e400("unknown reasoning_effort value: xhigh"), e400("invalid thinking signature"), new Response("{}", { status: 200 })] });
  const res = await hooked(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 4000,
    thinking: { type: "enabled", budget_tokens: 2000 }, output_config: { effort: "xhigh" },
    messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }, { type: "text", text: "a" }] }, { role: "user", content: "b" }] }));
  const last = JSON.parse(calls[2].init.body);
  ok(calls.length === 3 && res.status === 200 && !("output_config" in last) && last.messages[0].content.length === 1,
     "an effort refusal then a signature refusal: the second retry drops both, the turn goes through");
  const { hooked: h2, calls: c2 } = load(CONFIG, { responses: [e400("invalid thinking signature"), e400("invalid thinking signature again")] });
  const r2 = await h2(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 100, messages: [{ role: "user", content: "b" }] }));
  ok(c2.length === 2 && r2.status === 400, "a cause already dropped is not retried again (bounded)");
}

// --- web_search keeps its options; headers; redirects ----------------------------------
{
  const cfg = JSON.parse(JSON.stringify(CONFIG));
  cfg.providers[0].headers = { "x-ok": "1", "bad header": "x" };
  const same = new Response(null, { status: 307, headers: { location: "https://api.deepseek.com/anthropic/v2/messages" } });
  const { hooked, calls } = load(cfg, { responses: [same, new Response("{}", { status: 200 })] });
  const res = await hooked(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 100, messages: [{ role: "user", content: "s" }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3, allowed_domains: ["example.com"], cache_control: { type: "ephemeral" } }] }));
  const t = JSON.parse(calls[0].init.body).tools[0];
  ok(t.max_uses === 3 && JSON.stringify(t.allowed_domains) === '["example.com"]' && !("cache_control" in t),
     "the web_search tool keeps max_uses and the domain filters, not cache_control");
  ok(calls[0].init.headers.get("x-ok") === "1" && [...calls[0].init.headers.keys()].every((k) => k !== "bad header"), "a malformed provider header is skipped, the request still goes");
  ok(calls[0].init.redirect === "manual" && calls.length === 2 && calls[1].url === "https://api.deepseek.com/anthropic/v2/messages" &&
     calls[1].init.headers.get("x-api-key") === "sk-test-1234567890" && res.status === 200, "a redirect on the provider's host is followed with the key");
  const away = new Response(null, { status: 302, headers: { location: "https://evil.example/collect" } });
  const { hooked: h2, calls: c2 } = load(CONFIG, { responses: [away] });
  const r2 = await h2(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 100, messages: [{ role: "user", content: "s" }] }));
  const j2 = await r2.json();
  ok(c2.length === 1 && r2.status === 400 && /redirected to another host/.test(j2.error.message), "a redirect to another host is not followed: the key stays home");
}

// --- per-provider User-Agent; the billing line, dropped on request -------------------
{
  const BILLING = "x-anthropic-billing-header: cc_version=2.1.295.f0b; cc_entrypoint=claude-desktop; cch=31d55;";
  const sys = [{ type: "text", text: BILLING }, { type: "text", text: "You are a Claude agent." }];
  const cfg = JSON.parse(JSON.stringify(CONFIG));
  cfg.providers[0].userAgent = "MyAgent/1.0";
  cfg.providers[0].headers = { "User-Agent": "from-headers/0", "x-extra": "1" };
  cfg.providers[0].stripBillingHeader = true;
  const { hooked, calls } = load(cfg);
  await hooked(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 100, system: sys, messages: [{ role: "user", content: "x" }] }));
  const hd = calls[0].init.headers, out = JSON.parse(calls[0].init.body);
  ok(hd.get("user-agent") === "MyAgent/1.0", "userAgent is the request's User-Agent, over one in headers: " + hd.get("user-agent"));
  ok(hd.get("x-extra") === "1", "the provider's other headers still go");
  ok(out.system.length === 1 && out.system[0].text === "You are a Claude agent.",
     "stripBillingHeader drops the billing line and keeps the rest of the system prompt: " + JSON.stringify(out.system));
  const { hooked: h2, calls: c2 } = load(CONFIG);
  await h2(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 100, system: sys, messages: [{ role: "user", content: "x" }] }));
  ok(!c2[0].init.headers.has("user-agent"), "without userAgent none is set: the runtime's own goes, as before");
  ok(JSON.parse(c2[0].init.body).system[0].text === BILLING, "without stripBillingHeader the billing line is sent, as before");
  // Anthropic's API: the User-Agent replaces the CLI's; the billing line stays (rewritten to cli) whatever the routes say.
  const native = { providers: [{ id: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-api-1234567890", native: true,
    userAgent: "MyAgent/1.0", stripBillingHeader: true, models: [{ id: "claude-opus-5-5", alias: "claude-anthropic-opus-5-5" }] }] };
  const { hooked: hn, calls: cn } = load(native);
  await hn("https://api.anthropic.com/v1/messages?beta=true", messagesInit({ model: "claude-anthropic-opus-5-5", max_tokens: 100, system: sys,
    messages: [{ role: "user", content: "x" }] }, { headers: { "content-type": "application/json", "user-agent": "claude-cli/2.1.295 (external, claude-desktop)" } }));
  ok(new Headers(cn[0].init.headers).get("user-agent") === "MyAgent/1.0", "a native provider's userAgent replaces the CLI's");
  ok(/cc_entrypoint=cli;/.test(JSON.parse(cn[0].init.body).system[0].text), "a native request keeps its billing line: Anthropic uses it");
}

// --- the keys live in routes.json, not in the environment ------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-keys-"));
  const rp = join(dir, "routes.json");
  const noKeys = JSON.parse(JSON.stringify(CONFIG));
  noKeys.providers.forEach((p) => { delete p.apiKey; });
  // routes.json absent at start: the environment's routes stay (no key: a clear refusal, not "no longer configured").
  const { api, hooked } = load(noKeys, { env: { CDB_CUSTOM_MODELS_ROUTES: rp } });
  ok(api.routes.size === 3, "routes.json absent at start: the environment's routes are kept");
  const res = await hooked(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
  ok(res.status === 400 && /no API key/.test((await res.json()).error.message), "and without the file's keys the request is refused with that reason");
  // The spawn-time slot is pinned WITH the key the file had at start.
  writeFileSync(rp, JSON.stringify(CONFIG));
  const { hooked: h2, calls: c2 } = load(noKeys, { env: { CDB_CUSTOM_MODELS_ROUTES: rp, ANTHROPIC_SMALL_FAST_MODEL: "claude-deepseek-pro" } });
  writeFileSync(rp, JSON.stringify({ providers: [] }));
  utimesSync(rp, new Date(), new Date(Date.now() + 5000));
  await h2(ANTHROPIC, messagesInit({ model: "claude-deepseek-pro", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
  ok(c2.length === 1 && c2[0].init.headers.get("x-api-key") === "sk-test-1234567890", "a pinned slot keeps the key the routes file gave it at start");
  // An 8-character key is a key, as in the panel.
  const eight = JSON.parse(JSON.stringify(CONFIG)); eight.providers[0].apiKey = "sk-12345";
  const { hooked: h3, calls: c3 } = load(eight);
  await h3(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
  ok(c3.length === 1, "an 8-character key is accepted, like the panel does");
  rmSync(dir, { recursive: true, force: true });
}

// --- count_tokens, missing key, unknown provider --------------------------------
{
  const { hooked, calls } = load(CONFIG);
  const c = await hooked("https://api.anthropic.com/v1/messages/count_tokens",
    messagesInit({ model: "claude-deepseek-flash", messages: [{ role: "user", content: "hello world" }] }));
  const cj = await c.json();
  ok(calls.length === 0 && typeof cj.input_tokens === "number" && cj.input_tokens > 0, "count_tokens is estimated locally, nothing leaves");
  const r = await hooked(ANTHROPIC, messagesInit({ model: "claude-gw-model", messages: [{ role: "user", content: "x" }] }));
  const rj = await r.json();
  ok(calls.length === 0 && r.status === 400 && rj.type === "error" && /no API key/.test(rj.error.message),
     "a provider without a key answers 400 (never 401 - the CLI would loop on OAuth refresh)");
}

// --- web search reroute ----------------------------------------------------------
{
  const { hooked, calls } = load(CONFIG);
  await hooked(ANTHROPIC, messagesInit({ model: "claude-haiku-4-5", max_tokens: 100, messages: [{ role: "user", content: "search" }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }] }));
  ok(calls[0].url.startsWith("https://api.deepseek.com/") && JSON.parse(calls[0].init.body).model === "deepseek-flash",
     "the single-tool web_search sub-request is rerouted to the webSearch model");
  await hooked(ANTHROPIC, messagesInit({ model: "claude-haiku-4-5", max_tokens: 100, messages: [{ role: "user", content: "search" }],
    tools: [{ type: "web_search_20250305", name: "web_search" }, { name: "Read", input_schema: {} }] }));
  ok(calls[1].url === ANTHROPIC, "a Claude conversation that merely lists web_search among other tools is not touched");
  // Legacy per-provider key still works when no app-wide value is given;
  // no route at all leaves web search on Anthropic.
  const legacy = JSON.parse(JSON.stringify(CONFIG)); delete legacy.webSearch; legacy.providers[0].webSearch = "deepseek-pro";
  const { hooked: h2, calls: c2 } = load(legacy);
  await h2(ANTHROPIC, messagesInit({ model: "claude-haiku-4-5", max_tokens: 100, messages: [{ role: "user", content: "s" }],
    tools: [{ type: "web_search_20250305", name: "web_search" }] }));
  ok(JSON.parse(c2[0].init.body).model === "deepseek-pro", "the per-provider webSearch is the fallback");
  // The target may be spelled with the [1m] suffix (a model listed as 1M).
  const oneM = JSON.parse(JSON.stringify(CONFIG)); oneM.webSearch = "claude-deepseek-flash[1m]";
  const { hooked: h1m, calls: c1m } = load(oneM);
  await h1m(ANTHROPIC, messagesInit({ model: "claude-haiku-4-5", max_tokens: 100, messages: [{ role: "user", content: "s" }],
    tools: [{ type: "web_search_20250305", name: "web_search" }] }));
  ok(c1m[0].url.startsWith("https://api.deepseek.com/") && JSON.parse(c1m[0].init.body).model === "deepseek-flash",
     "a webSearch target spelled with [1m] finds its route");
  const none = JSON.parse(JSON.stringify(CONFIG)); delete none.webSearch;
  const { hooked: h3, calls: c3 } = load(none);
  await h3(ANTHROPIC, messagesInit({ model: "claude-haiku-4-5", max_tokens: 100, messages: [{ role: "user", content: "s" }],
    tools: [{ type: "web_search_20250305", name: "web_search" }] }));
  ok(c3[0].url === ANTHROPIC && JSON.parse(c3[0].init.body).model === "claude-haiku-4-5", "no web-search route: the sub-request stays as it is");
  // An Anthropic model as the target: same request to Anthropic, other model name.
  const opus = JSON.parse(JSON.stringify(CONFIG)); opus.webSearch = "claude-opus-5";
  const { hooked: h4, calls: c4 } = load(opus);
  await h4(ANTHROPIC, messagesInit({ model: "claude-haiku-4-5", max_tokens: 100, messages: [{ role: "user", content: "s" }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }] }));
  const b4 = JSON.parse(c4[0].init.body);
  ok(c4[0].url === ANTHROPIC && b4.model === "claude-opus-5" && b4.tools[0].max_uses === 3 && c4[0].init.headers.authorization === "Bearer sk-ant-oauth-secret",
     "web search on Opus: only the model name changes, credentials and body untouched");
  await h4(ANTHROPIC, messagesInit({ model: "claude-opus-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }));
  ok(JSON.parse(c4[1].init.body).model === "claude-opus-5" && c4[1].init.body === messagesInit({ model: "claude-opus-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }).body,
     "a normal Opus request is not rewritten");
  // The small/fast model is one of ours (the sub-request names it): the
  // web-search choice still wins, custom or Anthropic.
  const { hooked: h5, calls: c5 } = load(CONFIG);
  await h5(ANTHROPIC, messagesInit({ model: "claude-deepseek-pro", max_tokens: 100, messages: [{ role: "user", content: "s" }],
    tools: [{ type: "web_search_20250305", name: "web_search" }] }));
  ok(c5[0].url.startsWith("https://api.deepseek.com/") && JSON.parse(c5[0].init.body).model === "deepseek-flash",
     "a sub-request on a custom small/fast model goes to the web-search model, not to the small/fast one");
  await h4(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 100, messages: [{ role: "user", content: "s" }],
    tools: [{ type: "web_search_20250305", name: "web_search" }] }));
  ok(c4[2].url === ANTHROPIC && JSON.parse(c4[2].init.body).model === "claude-opus-5",
     "and with an Anthropic web-search model it goes to Anthropic on that model");
}

// --- a Claude request that merely mentions one of our ids -------------------------
{
  const { hooked, calls } = load(CONFIG);
  await hooked(ANTHROPIC, messagesInit({ model: "claude-opus-5", max_tokens: 10, diagnostics: { previous_message_id: "gen-1234567890" },
    messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Workflow", input: { model: "claude-deepseek-flash" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }] }));
  const b = JSON.parse(calls[0].init.body);
  ok(calls[0].url === ANTHROPIC && b.model === "claude-opus-5" && b.diagnostics.previous_message_id === null,
     "it stays on Anthropic and still gets the foreign previous_message_id fix");
}

// --- live routes: the routes file wins over the environment and is re-read -------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-routes-"));
  const rp = join(dir, "routes.json");
  const write = (cfg, mtimeSec) => { writeFileSync(rp, JSON.stringify(cfg, null, 2) + "\n"); utimesSync(rp, mtimeSec, mtimeSec); };
  const gwOnly = { providers: [{ id: "gw", baseUrl: "https://gw.example/anthropic", apiKey: "sk-gw-1234567890", models: [{ id: "gw-model" }] }] };
  write(gwOnly, 1700000000);
  const { api, hooked, calls, env } = load(CONFIG, { env: { CDB_CUSTOM_MODELS_ROUTES: rp } });
  ok(!("CDB_CUSTOM_MODELS_ROUTES" in env), "the routes path is deleted from process.env too");
  ok(api.routes.size === 1 && api.routes.has("claude-gw-model") && !api.routes.has("claude-deepseek-flash"),
     "at start the routes file (newer) wins over the environment's config");
  const msg = (model) => messagesInit({ model, max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
  let res = await hooked(ANTHROPIC, msg("claude-deepseek-flash"));
  ok(calls.length === 0 && res.status === 400,
     "a custom model the newer file dropped is refused with the reason, not sent to Anthropic");
  // The app rewrites the file (a provider added): the next request sees it.
  write(CONFIG, 1700000010);
  await hooked(ANTHROPIC, msg("claude-deepseek-flash"));
  ok(calls[0].url === "https://api.deepseek.com/anthropic/v1/messages" && JSON.parse(calls[0].init.body).model === "deepseek-flash",
     "a rewritten routes file is picked up on the next request - no restart");
  ok(api.routes.size === 3, "every model of the new file is routed");
  // A key replaced (same size, new mtime) is picked up as well.
  const fixed = JSON.parse(JSON.stringify(CONFIG)); fixed.providers[0].apiKey = "sk-test-0987654321";
  write(fixed, 1700000020);
  await hooked(ANTHROPIC, msg("claude-deepseek-flash"));
  ok(calls[1].init.headers.get("x-api-key") === "sk-test-0987654321", "a replaced key is used at once");
  // Same content, same mtime: nothing re-read (the stamp is mtime+size).
  await hooked(ANTHROPIC, msg("claude-deepseek-flash"));
  ok(calls[2].init.headers.get("x-api-key") === "sk-test-0987654321", "an unchanged file changes nothing");
  // The feature switched off: an empty list stops the routing here too.
  write({ providers: [] }, 1700000030);
  res = await hooked(ANTHROPIC, msg("claude-deepseek-flash"));
  ok(calls.length === 3 && res.status === 400 && api.routes.size === 0, "an emptied routes file stops the routing in this session");
  write(CONFIG, 1700000040);
  await hooked(ANTHROPIC, msg("claude-deepseek-flash"));
  ok(calls[3].url.startsWith("https://api.deepseek.com/"), "and back when it is written again");
  rmSync(rp);
  res = await hooked(ANTHROPIC, msg("claude-deepseek-flash"));
  ok(calls.length === 4 && res.status === 400 && api.routes.size === 0, "a removed routes file stops the routing");
  // No config in the environment at all, only the file: the hook is installed.
  write(CONFIG, 1700000050);
  const { api: api2, hooked: h2, rawFetch: raw2, calls: c2 } = load(null, { env: { CDB_CUSTOM_MODELS_ROUTES: rp } });
  ok(!!api2 && h2 !== raw2 && api2.routes.size === 3, "with only the routes path in the environment, fetch is hooked and the file read");
  await h2(ANTHROPIC, msg("claude-deepseek-flash"));
  ok(c2[0].url.startsWith("https://api.deepseek.com/"), "and routes");
  // An unreadable file keeps the current routes.
  writeFileSync(rp, "{not json"); utimesSync(rp, 1700000060, 1700000060);
  await h2(ANTHROPIC, msg("claude-deepseek-flash"));
  ok(c2[1].url.startsWith("https://api.deepseek.com/"), "a broken routes file keeps the routes in use");
  rmSync(dir, { recursive: true, force: true });
}

// --- a foreign previous_message_id on the way to Anthropic ------------------------
{
  const { hooked, calls } = load(CONFIG);
  const mk = (id) => ({ model: "claude-opus-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }],
    diagnostics: { previous_message_id: id }, metadata: { user_id: "u" } });
  await hooked(ANTHROPIC, messagesInit(mk("gen-1234567890abcdef")));
  let b = JSON.parse(calls[0].init.body);
  ok(calls[0].url === ANTHROPIC && b.diagnostics.previous_message_id === null && b.metadata.user_id === "u" && b.model === "claude-opus-5",
     "an id Anthropic did not mint (OpenRouter's gen-...) is sent as null, the rest untouched");
  await hooked(ANTHROPIC, messagesInit(mk("msg_01ABCDEF")));
  ok(calls[1].init.body === messagesInit(mk("msg_01ABCDEF")).body, "an Anthropic id passes through byte for byte");
  await hooked(ANTHROPIC, messagesInit({ model: "claude-opus-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }], diagnostics: { previous_message_id: null } }));
  ok(calls[2].init.body.indexOf('"previous_message_id":null') !== -1 && calls[2].init.headers.authorization === "Bearer sk-ant-oauth-secret",
     "null stays null and the original init (credentials) is kept");
}

// --- a provider 401: rewritten so the CLI does not chase its own OAuth token ---
{
  const responses = [new Response(JSON.stringify({ error: { message: "Authentication Fails, Your api key is invalid" } }),
    { status: 401, headers: { "content-type": "application/json" } })];
  const { hooked, calls } = load(CONFIG, { responses });
  const res = await hooked(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
  const body = await res.json();
  ok(calls.length === 1 && res.status === 400 && body.error.type === "invalid_request_error" &&
     /refused the API key \(HTTP 401\)/.test(body.error.message) && /api key is invalid/.test(body.error.message),
     "a provider 401 comes back as a plain 400 carrying the provider's message (not authentication_error: the app would re-authorise and restart the session)");
}

// --- a model without the web search tool ------------------------------------------
{
  const cfg = JSON.parse(JSON.stringify(CONFIG));
  cfg.providers[0].models[0].webSearch = false;
  const { hooked, calls } = load(cfg);
  await hooked(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 100, messages: [{ role: "user", content: "x" }],
    tools: [{ name: "Read", input_schema: {} }, { type: "web_search_20250305", name: "web_search" }] }));
  const t = JSON.parse(calls[0].init.body).tools;
  ok(t.length === 1 && t[0].name === "Read", "webSearch:false strips the web_search tool from the model's requests");
}

// --- 400 on signed thinking -> retry without thinking blocks ----------------------
{
  const bad = new Response(JSON.stringify({ error: { message: "invalid thinking signature" } }), { status: 400 });
  const good = new Response("{}", { status: 200 });
  const { hooked, calls } = load(CONFIG, { responses: [bad, good] });
  const res = await hooked(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 100,
    messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }, { type: "text", text: "a" }] },
      { role: "user", content: "b" }] }));
  ok(calls.length === 2, "a 400 mentioning thinking/signature triggers exactly one retry");
  ok(JSON.parse(calls[0].init.body).messages[0].content.length === 2 &&
     JSON.parse(calls[1].init.body).messages[0].content.length === 1, "the retry drops the thinking blocks");
  ok(res.status === 200, "the retry's response is what the CLI gets");
  const other = new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
  const { hooked: h2, calls: c2 } = load(CONFIG, { responses: [other] });
  const r2 = await h2(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 100, messages: [{ role: "user", content: "b" }] }));
  ok(c2.length === 1 && r2.status === 429, "other errors are returned without a retry");
}

// --- an effort level the provider does not know --------------------------------------
{
  const bad = new Response(JSON.stringify({ error: { message: "invalid reasoning_effort: xhigh" } }), { status: 400 });
  const good = new Response("{}", { status: 200 });
  const { hooked, calls } = load(CONFIG, { responses: [bad, good] });
  const res = await hooked(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 4000,
    messages: [{ role: "user", content: "b" }], thinking: { type: "enabled", budget_tokens: 2000 }, output_config: { effort: "xhigh" } }));
  ok(calls.length === 2 && "output_config" in JSON.parse(calls[0].init.body) && !("output_config" in JSON.parse(calls[1].init.body)),
     "a 400 naming the effort is retried once without output_config");
  ok(JSON.parse(calls[1].init.body).thinking.type === "enabled", "thinking stays on for that retry");
  ok(res.status === 200, "and the retry's answer is what the CLI gets");
  const eff = new Response(JSON.stringify({ error: { message: "thinking options type cannot be disabled when reasoning_effort is set" } }), { status: 400 });
  const { hooked: h2, calls: c2 } = load(CONFIG, { responses: [eff] });
  await h2(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 100, messages: [{ role: "user", content: "b" }] }));
  ok(c2.length === 1, "the thinking-disabled effort complaint is not mistaken for an unknown level");
}

// --- log file ----------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-preload-"));
  const logPath = join(dir, "custom-models.log");
  const { hooked } = load(CONFIG, { env: { CDB_CUSTOM_MODELS_LOG: logPath } });
  await hooked(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 100, messages: [{ role: "user", content: "b" }] }));
  ok(existsSync(logPath), "a log file is written at CDB_CUSTOM_MODELS_LOG");
  const text = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  ok(/active: claude-deepseek-flash -> deepseek\/deepseek-flash/.test(text), "the activation line lists the routes");
  ok(/-> deepseek\/deepseek-flash stream=false messages=1 tools=0/.test(text), "each routed request logs one line");
  ok(!/sk-test-1234567890/.test(text), "the key never appears in the log");
  ok(!/passthrough/.test(text), "without the debug switch the requests left alone are not logged");
  rmSync(dir, { recursive: true, force: true });
}

// --- debug switch: the passthroughs are traced too ------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-preload-"));
  const logPath = join(dir, "custom-models.log");
  const { hooked, env, api } = load(CONFIG, { env: { CDB_CUSTOM_MODELS_LOG: logPath, CDB_CUSTOM_MODELS_DEBUG: "1" } });
  ok(!("CDB_CUSTOM_MODELS_DEBUG" in env), "the debug switch is scrubbed from process.env like the others");
  await hooked(ANTHROPIC, messagesInit({ model: "claude-opus-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
  await hooked(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
  await hooked("https://api.anthropic.com/v1/messages/count_tokens", messagesInit({ model: "claude-opus-5", messages: [{ role: "user", content: "hi" }] }));
  await hooked("https://api.anthropic.com/api/oauth/token", { method: "POST", body: "{}" });
  const text = readFileSync(logPath, "utf8");
  ok(/passthrough https:\/\/api\.anthropic\.com\/v1\/messages model=claude-opus-5 \(not a custom model; routes: claude-deepseek-flash -> deepseek\/deepseek-flash/.test(text),
     "a Claude request logs where it went, its model and the routes in force");
  ok(/-> deepseek\/deepseek-flash stream=false/.test(text), "the routed request logs as before");
  ok(/passthrough https:\/\/api\.anthropic\.com\/v1\/messages\/count_tokens model=claude-opus-5/.test(text), "count_tokens for a Claude model is traced too");
  ok(!/oauth/.test(text), "requests off the Messages API stay out of the log");
  // Routes gone (provider removed while the session runs): the trace says so.
  const routesDir = mkdtempSync(join(tmpdir(), "cdb-cm-routes-"));
  const routesPath = join(routesDir, "routes.json");
  writeFileSync(routesPath, JSON.stringify({ providers: [] }));
  const logPath2 = join(dir, "custom-models-2.log");
  const { hooked: hooked2 } = load(CONFIG, { env: { CDB_CUSTOM_MODELS_LOG: logPath2, CDB_CUSTOM_MODELS_DEBUG: "1", CDB_CUSTOM_MODELS_ROUTES: routesPath } });
  await hooked2(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash[1m]", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
  const text2 = readFileSync(logPath2, "utf8");
  ok(/refused: claude-deepseek-flash is no longer configured; routes: no custom model/.test(text2),
     "a custom id with no route left is traced as refused, with the routes in force");
  rmSync(dir, { recursive: true, force: true });
  rmSync(routesDir, { recursive: true, force: true });
}

// --- tool schemas: regex spellings a stricter provider engine refuses --------------
// DeepSeek compiles every `pattern` with a Rust regex and refuses the whole
// request over \0 ('"^[^\\0]*$" is not a "regex"' - the Artifact tool).
{
  const { hooked, calls, api } = load(CONFIG);
  const schema = {
    type: "object",
    properties: {
      file_paths: { type: "array", items: { type: "string", pattern: "^[^\\0]*$" } },
      pattern: { type: "string", description: "Grep's own parameter named pattern", default: "a\\0b" },
      esc: { type: "string", pattern: "^\\\\0$" },
      octal: { type: "string", pattern: "\\012" },
      cls: { type: "string", pattern: "[\\b\\0]\\b[^]" },
      e: { enum: ["\\0"] }
    },
    patternProperties: { "^x\\0": { type: "string", pattern: "\\0" } },
    ["__proto__"]: { type: "string" }
  };
  const tools = [{ name: "Artifact", description: "d", input_schema: JSON.parse(JSON.stringify(schema)) }];
  const before = JSON.stringify(tools);
  await hooked(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 10, tools, messages: [{ role: "user", content: "hi" }] }));
  const sent = JSON.parse(calls[0].init.body).tools[0].input_schema;
  ok(sent.properties.file_paths.items.pattern === "^[^\\x00]*$", "\\0 is sent as \\x00: " + sent.properties.file_paths.items.pattern);
  ok(sent.properties.pattern.type === "string" && sent.properties.pattern.default === "a\\0b",
     "a property named pattern is a schema, not a regex; default values are data and stay");
  ok(sent.properties.esc.pattern === "^\\\\0$", "an escaped backslash followed by 0 stays");
  ok(sent.properties.octal.pattern === "\\012", "\\0 followed by a digit (octal) stays");
  ok(sent.properties.cls.pattern === "[\\x08\\x00]\\b[\\s\\S]", "[\\b] -> [\\x08], \\b outside a class stays, [^] -> [\\s\\S]: " + sent.properties.cls.pattern);
  ok(sent.properties.e.enum[0] === "\\0", "enum values stay");
  ok(sent.patternProperties["^x\\x00"] && sent.patternProperties["^x\\x00"].pattern === "\\x00", "patternProperties keys and their schemas too");
  ok(Object.prototype.hasOwnProperty.call(sent, "__proto__") && sent.__proto__.type === "string", "a property named __proto__ survives the copy");
  ok(JSON.stringify(tools) === before, "the CLI's own tool list is not modified");
  await hooked(ANTHROPIC, messagesInit({ model: "claude-opus-5", max_tokens: 10, tools, messages: [{ role: "user", content: "hi" }] }));
  ok(JSON.parse(calls[1].init.body).tools[0].input_schema.properties.file_paths.items.pattern === "^[^\\0]*$",
     "a Claude request keeps the schema exactly as the CLI wrote it");
}

// --- Anthropic's own ids are never routed ----------------------------------------
// Even if a routes file lists them (the app refuses them as custom models):
// they belong to the subscription.
{
  const cfg = { providers: [{ id: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-api-1234567890",
    models: [{ id: "claude-opus-5-5" }, { id: "sonnet-5-5" }, { id: "claude-3-5-haiku" }, { id: "deepseek-flash" }] }] };
  const { api, hooked, calls } = load(cfg);
  ok([...api.routes.keys()].join(",") === "claude-deepseek-flash", "only the non-Anthropic id gets a route: " + [...api.routes.keys()].join(","));
  await hooked(ANTHROPIC, messagesInit({ model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
  ok(calls.length === 1 && calls[0].url === ANTHROPIC && calls[0].init.headers.authorization === "Bearer sk-ant-oauth-secret",
     "a request for claude-opus-5-5 goes to Anthropic untouched");
}

// --- native: Anthropic's own API on the user's API credit ----------------------------
// The CLI's request goes as it is (prompt caching, betas, signed thinking),
// with the key instead of the subscription's login and the provider's model id.
{
  const cfg = { providers: [{ id: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-api-1234567890", native: true,
    models: [{ id: "claude-opus-5-5", alias: "claude-anthropic-opus-5-5" }] }] };
  const bad = new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Invalid signature in thinking block" } }),
    { status: 400, headers: { "content-type": "application/json" } });
  const { api, hooked, calls } = load(cfg, { responses: [undefined, undefined, undefined, bad] });
  ok([...api.routes.keys()].join(",") === "claude-anthropic-opus-5-5", "the alias comes from the routes, not from the id");
  const body = { model: "claude-anthropic-opus-5-5", max_tokens: 100, stream: true, metadata: { user_id: "u" },
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.293.6b5; cc_entrypoint=claude-desktop; cch=a1b2c;" }],
    context_management: { edits: [] }, diagnostics: { previous_message_id: "gen-123" },
    messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "sig" }, { type: "text", text: "a" }] },
      { role: "user", content: [{ type: "text", text: "go", cache_control: { type: "ephemeral" } }] }] };
  const init = messagesInit(body, { headers: { "content-type": "application/json", "anthropic-version": "2023-06-01",
    "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,context-management-2025-06-27,extended-cache-ttl-2025-04-11",
    "authorization": "Bearer sk-ant-oauth-secret", "x-app": "cli" } });
  await hooked("https://api.anthropic.com/v1/messages?beta=true", init);
  const c = calls[0], hd = new Headers(c.init.headers), sent = JSON.parse(c.init.body);
  ok(c.url === "https://api.anthropic.com/v1/messages?beta=true", "same path and query: " + c.url);
  ok(!hd.has("authorization") && hd.get("x-api-key") === "sk-ant-api-1234567890", "the API key replaces the subscription's login");
  ok(hd.get("anthropic-beta") === "claude-code-20250219,context-management-2025-06-27,extended-cache-ttl-2025-04-11" && hd.get("x-app") === "cli",
     "the CLI's headers stay, minus the oauth beta: " + hd.get("anthropic-beta"));
  ok(sent.model === "claude-opus-5-5", "the provider's model id");
  ok(sent.system[0].cache_control.ttl === "1h" && sent.messages[2].content[0].cache_control && sent.context_management && sent.metadata.user_id === "u" &&
     sent.messages[1].content[0].signature === "sig", "prompt caching, context management, metadata and signed thinking are kept");
  ok(sent.diagnostics.previous_message_id === null, "a previous_message_id another provider minted is nulled");
  ok(sent.system[1].text === "x-anthropic-billing-header: cc_version=2.1.293.6b5; cc_entrypoint=cli; cch=a1b2c;" && sent.system[0].text === "sys",
     "the attribution says cli, the rest of the system prompt is untouched: " + sent.system[1].text);
  await hooked("https://api.anthropic.com/v1/messages/count_tokens?beta=true", messagesInit({ model: "claude-anthropic-opus-5-5", messages: [{ role: "user", content: "hi" }] }));
  ok(calls[1].url === "https://api.anthropic.com/v1/messages/count_tokens?beta=true" && new Headers(calls[1].init.headers).get("x-api-key") === "sk-ant-api-1234567890",
     "count_tokens is answered by the API itself");
  await hooked(ANTHROPIC, messagesInit({ model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
  ok(calls[2].url === ANTHROPIC && calls[2].init.headers.authorization === "Bearer sk-ant-oauth-secret",
     "the subscription's claude-opus-5-5 still goes to Anthropic on the login");
  await hooked("https://api.anthropic.com/v1/messages?beta=true", messagesInit(body));
  ok(calls.length === 5 && !JSON.stringify(JSON.parse(calls[4].init.body).messages).includes("thinking") &&
     JSON.parse(calls[4].init.body).system[0].cache_control,
     "a 400 naming a signature: retried without thinking blocks, the rest unchanged");
}
{
  // The alias is ours alone: once removed, the session is told so instead of
  // sending claude-anthropic-opus-5-5 to Anthropic, which does not know it.
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-native-"));
  const routesPath = join(dir, "routes.json");
  writeFileSync(routesPath, JSON.stringify({ providers: [{ id: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-api-1234567890", native: true,
    models: [{ id: "claude-opus-5-5", alias: "claude-anthropic-opus-5-5" }] }] }));
  const { hooked, calls } = load(null, { env: { CDB_CUSTOM_MODELS_ROUTES: routesPath } });
  await hooked(ANTHROPIC, messagesInit({ model: "claude-anthropic-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
  ok(calls.length === 1 && calls[0].url.startsWith("https://api.anthropic.com/"), "routed while configured");
  writeFileSync(routesPath, JSON.stringify({ providers: [] }));
  const st = statSync(routesPath); utimesSync(routesPath, st.atime, new Date(st.mtimeMs + 5000));
  const res = await hooked(ANTHROPIC, messagesInit({ model: "claude-anthropic-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
  ok(calls.length === 1 && res.status === 400 && /no longer configured/.test(await res.text()), "refused once its route is gone");
  rmSync(dir, { recursive: true, force: true });
}

// --- usage line: what the provider counted, prompt cache included -------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-usage-"));
  const logPath = join(dir, "custom-models.log");
  const usage = { input_tokens: 12, cache_read_input_tokens: 180000, cache_creation_input_tokens: 900,
    cache_creation: { ephemeral_1h_input_tokens: 900, ephemeral_5m_input_tokens: 0 }, output_tokens: 1 };
  const sse = "event: message_start\ndata: " + JSON.stringify({ type: "message_start", message: { id: "msg_1", usage } }) + "\n\n" +
    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n" +
    "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
  const streamed = new Response(new ReadableStream({ start(c) { const b = new TextEncoder().encode(sse);
    c.enqueue(b.slice(0, 40)); c.enqueue(b.slice(40)); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const plain = new Response(JSON.stringify({ id: "msg_2", usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
    { status: 200, headers: { "content-type": "application/json" } });
  const cfg = { providers: [{ id: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-api-1234567890", native: true,
    models: [{ id: "claude-opus-5-5", alias: "claude-anthropic-opus-5-5" }] }] };
  const { hooked } = load(cfg, { env: { CDB_CUSTOM_MODELS_LOG: logPath }, responses: [streamed, plain] });
  const res = await hooked("https://api.anthropic.com/v1/messages?beta=true",
    messagesInit({ model: "claude-anthropic-opus-5-5", max_tokens: 10, stream: true, messages: [{ role: "user", content: "hi" }] }));
  ok(await res.text() === sse, "the CLI still reads the whole stream, byte for byte");
  await hooked("https://api.anthropic.com/v1/messages?beta=true",
    messagesInit({ model: "claude-anthropic-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
  await new Promise((r) => setTimeout(r, 30));
  const text = readFileSync(logPath, "utf8");
  ok(/<- anthropic\/claude-opus-5-5 usage: input=12 cache_read=180000 cache_write=900 \(1h 900, 5m 0\)/.test(text),
     "a streamed answer logs its usage from message_start, cache read and write included");
  ok(/<- anthropic\/claude-opus-5-5 usage: input=5 cache_read=0 cache_write=0\n/.test(text), "so does a JSON answer");
  rmSync(dir, { recursive: true, force: true });
}

// --- a stream that mixes thinking into a text block -------------------------------
// A LiteLLM-based gateway (GLM 5.3 on TensorX) streams reasoning as
// thinking_delta inside a block opened as text; Claude Code refuses it and
// resends the turn without streaming. The preload re-blocks it.
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-reblock-"));
  const logPath = join(dir, "custom-models.log");
  const E = (o) => "event: " + o.type + "\ndata: " + JSON.stringify(o) + "\n\n";
  const zero = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const start = E({ type: "message_start", message: { id: "msg_x", type: "message", role: "assistant", content: [], usage: zero } });
  const tail = E({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 10364, output_tokens: 104 } }) + E({ type: "message_stop" });
  const blk = (i, b) => E({ type: "content_block_start", index: i, content_block: b });
  const dl = (i, d) => E({ type: "content_block_delta", index: i, delta: d });
  const stp = (i) => E({ type: "content_block_stop", index: i });
  const tool = (i) => blk(i, { type: "tool_use", id: "t1", name: "Edit", input: {} }) + dl(i, { type: "input_json_delta", partial_json: "{\"a\":1}" }) + stp(i);
  const streamOf = (s, cut) => new Response(new ReadableStream({ start(c) { const b = new TextEncoder().encode(s);
    for (let i = 0; i < b.length; i += cut) c.enqueue(b.slice(i, i + cut)); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const shape = (text) => text.split("\n\n").filter(Boolean).map((e) => JSON.parse(e.split("\n").find((l) => l.startsWith("data:")).slice(5)))
    .map((o) => o.type === "content_block_start" ? "start" + o.index + ":" + o.content_block.type
      : o.type === "content_block_delta" ? o.delta.type.replace("_delta", "") + o.index
      : o.type === "content_block_stop" ? "stop" + o.index : o.type).join(" ");
  // thinking only, inside the text block (the commonest shape)
  const mixed = start + blk(0, { type: "text", text: "" }) + dl(0, { type: "thinking_delta", thinking: "Fix" }) +
    dl(0, { type: "thinking_delta", thinking: " mod1.py." }) + stp(0) + tool(1) + tail;
  const clean = start + blk(0, { type: "text", text: "" }) + dl(0, { type: "text_delta", text: "" }) + stp(0) + tool(1) + tail;
  // text, then thinking, then text again, all in block 0
  const sandwich = start + blk(0, { type: "text", text: "" }) + dl(0, { type: "text_delta", text: "Let me look." }) +
    dl(0, { type: "thinking_delta", thinking: "Read it." }) + dl(0, { type: "text_delta", text: " Now the edit." }) + stp(0) + tool(1) + tail;
  const { hooked } = load(CONFIG, { env: { CDB_CUSTOM_MODELS_LOG: logPath },
    responses: [streamOf(mixed, 7), streamOf(clean, 13), streamOf(sandwich, 50), streamOf(mixed, 4096)] });
  const req = () => hooked(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 10, stream: true, messages: [{ role: "user", content: "hi" }] }));
  let out = await (await req()).text();
  ok(shape(out) === "message_start start0:text stop0 start1:thinking thinking1 thinking1 stop1 start2:tool_use input_json2 stop2 message_delta message_stop",
     "thinking deltas in a text block get a thinking block of their own, later blocks move up: " + shape(out));
  ok(JSON.parse(out.split("\n\n").find((e) => e.includes("\"index\":1") && e.includes("content_block_start")).split("data: ")[1]).content_block.thinking === "" &&
     out.includes("\"thinking\":\"Fix\"") && out.includes("\"partial_json\":\"{\\\"a\\\":1}\""), "with the reasoning and the tool input intact");
  out = await (await req()).text();
  ok(out === clean, "a stream without the mix reaches the CLI byte for byte");
  out = await (await req()).text();
  ok(shape(out) === "message_start start0:text text0 stop0 start1:thinking thinking1 stop1 start2:text text2 stop2 start3:tool_use input_json3 stop3 message_delta message_stop",
     "text, thinking, text in one block become three blocks in that order: " + shape(out));
  out = await (await req()).text();
  ok(shape(out).startsWith("message_start start0:text stop0 start1:thinking"), "the same when the stream arrives in one chunk");
  await new Promise((r) => setTimeout(r, 30));
  const text = readFileSync(logPath, "utf8");
  ok((text.match(/stream: thinking and text mixed in one block, re-blocked/g) || []).length === 3,
     "each re-blocked answer is logged once, the clean one not: " + text);
  ok(/usage: input=10364 output=104 \(end of stream, no cache figures sent\)/.test(text) && !/cache_read=0 cache_write=0\n[^\n]*re-blocked/.test(text) &&
     !/usage: input=0 cache_read=0/.test(text),
     "message_start counting nothing: the usage line comes from message_delta, and says it has no cache figures");
  rmSync(dir, { recursive: true, force: true });
}

// --- re-blocking: edge cases, headers, cancel, usage labels --------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-reblock2-"));
  const logPath = join(dir, "custom-models.log");
  const E = (o) => "event: " + o.type + "\ndata: " + JSON.stringify(o) + "\n\n";
  const zero = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const startOf = (u) => E({ type: "message_start", message: { id: "msg_x", type: "message", role: "assistant", content: [], usage: u } });
  const tail = E({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }) + E({ type: "message_stop" });
  const blk = (i, b) => E({ type: "content_block_start", index: i, content_block: b });
  const dl = (i, d) => E({ type: "content_block_delta", index: i, delta: d });
  const stp = (i) => E({ type: "content_block_stop", index: i });
  const sseRes = (s, cuts, headers) => new Response(new ReadableStream({ start(c) { const b = new TextEncoder().encode(s);
    let at = 0; for (const n of cuts.concat([b.length])) { if (n > at) c.enqueue(b.slice(at, n)); at = Math.max(at, n); } c.close(); } }),
    { status: 200, statusText: "OK", headers: Object.assign({ "content-type": "text/event-stream" }, headers || {}) });
  const events = (text) => text.replace(/\r\n/g, "\n").split("\n\n").filter(Boolean).map((e) =>
    JSON.parse(e.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("\n")));
  const shape = (text) => events(text).map((o) => o.type === "content_block_start" ? "start" + o.index + ":" + o.content_block.type
    : o.type === "content_block_delta" ? o.delta.type.replace("_delta", "") + o.index
    : o.type === "content_block_stop" ? "stop" + o.index : o.type).join(" ");
  const counted = { input_tokens: 50, output_tokens: 1 };
  // A thinking block that turns to text, with a ping, an error event, CRLF line
  // ends cut between \r and \n, a multi-line data field and no blank line at EOF.
  const thinkThenText = (startOf(counted) + blk(0, { type: "thinking", thinking: "" }) +
    dl(0, { type: "thinking_delta", thinking: "Plan." }) + dl(0, { type: "signature_delta", signature: "s" }) + E({ type: "ping" }) +
    dl(0, { type: "text_delta", text: "Done." }) + stp(0) +
    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\n" + "data: \"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t\",\"name\":\"X\",\"input\":{}}}\n\n" +
    dl(1, { type: "input_json_delta", partial_json: "{}" }) + stp(1) +
    E({ type: "error", error: { type: "overloaded_error", message: "busy" } }) + tail).replace(/\n/g, "\r\n").replace(/\r\n\r\n$/, "");
  const crCut = [];
  for (let i = 0; i < thinkThenText.length; i++) if (thinkThenText[i] === "\r" && crCut.length < 40) crCut.push(i + 1);
  // A mixed stream that announces a length: it no longer holds once re-blocked.
  const mixed = startOf(zero) + blk(0, { type: "text", text: "" }) + dl(0, { type: "thinking_delta", thinking: "Hmm" }) + stp(0) + tail;
  const json = new Response(JSON.stringify({ id: "m", usage: { input_tokens: 9, output_tokens: 3 } }), { status: 200, headers: { "content-type": "application/json" } });
  const { hooked } = load(CONFIG, { env: { CDB_CUSTOM_MODELS_LOG: logPath },
    responses: [sseRes(thinkThenText, crCut), sseRes(mixed, [], { "content-length": String(mixed.length) }), json] });
  const req = (stream) => hooked(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 10, stream, messages: [{ role: "user", content: "hi" }] }));
  let out = await (await req(true)).text();
  ok(shape(out) === "message_start start0:thinking thinking0 signature0 ping stop0 start1:text text1 stop1 start2:tool_use input_json2 stop2 error message_delta message_stop",
     "a thinking block that turns to text (CRLF, cut between \\r and \\n, ping, error, no blank line at EOF): " + shape(out));
  const res2 = await req(true);
  ok(res2.headers.get("content-length") === null && res2.headers.get("content-type") === "text/event-stream" && res2.status === 200,
     "a re-blocked stream drops the provider's content-length, keeps status and content-type");
  out = await res2.text();
  ok(shape(out) === "message_start start0:text stop0 start1:thinking thinking1 stop1 message_delta message_stop", "and is re-blocked: " + shape(out));
  await req(false);
  await new Promise((r) => setTimeout(r, 30));
  const text = readFileSync(logPath, "utf8");
  ok(/usage: input=50 cache_read=0 cache_write=0\n/.test(text) && /usage: input=9 cache_read=0 cache_write=0\n/.test(text) &&
     (text.match(/end of stream/g) || []).length === 1 && /usage: input=0 output=7 \(end of stream, no cache figures sent\)/.test(text),
     "only a line taken from message_delta says end of stream, not message_start or a JSON answer without cache fields: " + text);

  // The CLI cancelling the body (no abort signal) reaches the provider, also
  // while the usage reader waits for message_delta.
  let cancelled = false;
  const endless = new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(startOf(zero) + blk(0, { type: "text", text: "" }) + dl(0, { type: "text_delta", text: "a" }))); },
    pull() { return new Promise(() => {}); },
    cancel() { cancelled = true; }
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const { hooked: h2 } = load(CONFIG, { responses: [endless] });
  const r3 = await h2(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 10, stream: true, messages: [{ role: "user", content: "hi" }] }));
  const rd = r3.body.getReader();
  await rd.read();
  await Promise.race([rd.cancel(), new Promise((r) => setTimeout(r, 200))]);
  ok(cancelled, "the CLI cancelling a re-blockable stream cancels the provider's body");
  rmSync(dir, { recursive: true, force: true });
}

// --- Bun.FetchSession (CLI 2.1.284+) --------------------------------------------
// A standalone CLI sends its API requests through a session's fetch while
// globalThis.fetch is the one it captured at start (our hook): the sessions
// it creates must route too.
{
  const sessionCalls = [];
  class NativeSession {
    constructor(opts) { this.opts = opts; this.closed = false; }
    get fetch() {
      const self = this;
      return function (input, init) {
        if (!(this === self || this === undefined)) throw new TypeError("FetchSession.fetch called on another object");
        sessionCalls.push({ url: typeof input === "string" ? input : input.href, init, opts: self.opts });
        return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
      };
    }
    close() { this.closed = true; }
  }
  const Bun = { FetchSession: NativeSession };
  const { calls } = load(CONFIG, { Bun });
  ok(Bun.FetchSession !== NativeSession, "Bun.FetchSession is replaced");
  const s = new Bun.FetchSession({ tls: { ca: "x" } });
  ok(s instanceof NativeSession && s.opts.tls.ca === "x", "a session is still a native one, built with the CLI's options");
  await s.fetch(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
  ok(sessionCalls.length === 1 && sessionCalls[0].url === "https://api.deepseek.com/anthropic/v1/messages",
     "a custom model sent through a session reaches the provider: " + (sessionCalls[0] && sessionCalls[0].url));
  const h0 = new Headers(sessionCalls[0] ? sessionCalls[0].init.headers : {});
  ok(h0.get("x-api-key") === "sk-test-1234567890" && !h0.has("authorization"),
     "with the provider's key, never the Anthropic credential");
  ok(!!sessionCalls[0] && JSON.parse(sessionCalls[0].init.body).model === "deepseek-flash", "and the provider's model id");
  await s.fetch(ANTHROPIC, messagesInit({ model: "claude-opus-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }, { compress: "gzip" }));
  ok(sessionCalls.length === 2 && sessionCalls[1].url === ANTHROPIC && sessionCalls[1].init.headers.authorization === "Bearer sk-ant-oauth-secret" &&
     sessionCalls[1].init.compress === "gzip",
     "a Claude model goes through the session untouched");
  ok(calls.length === 0, "nothing went through globalThis.fetch");
  s.close();
  ok(s.closed, "close() still reaches the native session");
  const { api } = load(CONFIG, { Bun: {} });
  ok(!!api, "no FetchSession (older Bun): the preload loads as before");
}

// --- which binary it hooks ---------------------------------------------------
// Outside selftest the preload hooks fetch only inside the Claude Code binary:
// claude on Linux, claude.exe in the Windows app (binaryName for win32). Any
// other Bun program that inherits BUN_OPTIONS is left alone.
{
  const hooks = (execPath) => {
    const rawFetch = () => Promise.resolve(new Response("{}"));
    const sandbox = {
      require: (m) => Module.createRequire(import.meta.url)(m),
      process: { env: { CDB_CUSTOM_MODELS_JSON: JSON.stringify(CONFIG) }, pid: 4242, execPath },
      Bun: {}, fetch: rawFetch, Response, Headers, URL, Buffer, console, TextDecoder, TextEncoder, ReadableStream
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(readFileSync(join(ROOT, "js/custom_models_preload.js"), "utf8"), vm.createContext(sandbox));
    return sandbox.fetch !== rawFetch;
  };
  ok(hooks("/home/u/.config/Claude/claude-code/2.1.300/claude"), "hooks fetch in claude (Linux)");
  ok(hooks("/opt/Claude/claude-code/2.1.300/claude.exe"), "hooks fetch in claude.exe (the Windows app's binary name)");
  ok(!hooks("/usr/bin/bun"), "leaves another Bun program alone");
  ok(!hooks("/opt/x/bun.exe"), "leaves another Bun program alone (.exe)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
