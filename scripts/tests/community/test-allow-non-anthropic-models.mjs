#!/usr/bin/env node
/*
 * test-allow-non-anthropic-models.mjs - main-process half of the
 * "Allow non-Anthropic models" community feature
 * (patches/community/add_feature_allow_non_anthropic_models.nim ->
 * js/allow_non_anthropic_models.js).
 *
 * Runs the real module with electron shimmed and a temporary profile dir, the
 * same vm-sandbox the window-transparency harness uses. Checks the pref
 * precedence (the hand-owned .jsonc wins over the Settings-written .json wins
 * over the default), the memoized global the patch consults
 * (globalThis.__cdbAllowNonAnthropicModels()), the cdb-mb:* IPC shape (saved
 * value vs the value the running process started with), and the exact-origin,
 * main-frame-only sender guard. Then it runs the compiled patch on fixtures
 * shaped exactly like upstream's three gateway checks plus the Setup window's
 * --desktop-features argument (v2.26454.0) and evals the spliced code with the
 * switch on and off, then patches the real bundle and evals the spliced
 * expressions taken from it. Part D does the same for the ion-dist half
 * (add_feature_allow_non_anthropic_models_ion.nim): the Setup window SPA's own
 * gateway validator, fed by window.desktopBootFeatures.
 */
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync,
         readdirSync, accessSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import Module from "node:module";
import { openIonDist } from "../lib/ion-dist.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MODULE_PATH = join(ROOT, "js/allow_non_anthropic_models.js");
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };

// The feature module is written by another workstream; until it lands the
// harness stops here and nowhere else. `node --check` proves the harness itself
// parses, so a run that ends at this line is a missing module, not our bug.
if (!existsSync(MODULE_PATH)) {
  console.log("  FAIL js/allow_non_anthropic_models.js is missing - the feature module has not been written yet");
  console.log(`\n${pass} passed, ${fail + 1} failed`);
  process.exit(1);
}

function load(dir, env = {}) {
  const handlers = {}, events = {};
  const electron = {
    app: { getPath: () => dir, on: (e, f) => { events[e] = f; }, whenReady: () => Promise.resolve() },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }
  };
  const sandbox = {
    require: (m) => (m === "electron" ? electron : Module.createRequire(import.meta.url)(m)),
    process: { platform: "linux", env }, console, setTimeout, clearTimeout
  };
  sandbox.globalThis = sandbox;
  { const __c = vm.createContext(sandbox);
    vm.runInContext(readFileSync(new URL("../../../js/sender_guard.js", import.meta.url), "utf8"), __c);
    vm.runInContext(readFileSync(MODULE_PATH, "utf8"), __c); }
  return { handlers, events, sandbox };
}
const sender = { sender: { getURL: () => "https://claude.ai/x", isDestroyed: () => false } };
const from = (u, parent = null) => ({ sender: { getURL: () => u, isDestroyed: () => false }, senderFrame: { parent } });
const jsonPath = (dir) => join(dir, "claude-desktop-extra.json");
const jsoncPath = (dir) => join(dir, "claude-desktop-extra.jsonc");

// --- off by default, and the pref-read shape
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-mb-"));
  const t = load(dir);
  ok(t.sandbox.__cdbAllowNonAnthropicModels() === false, "the global is off by default");
  const r = await t.handlers["cdb-mb:pref-read"](sender);
  ok(r.ok === true && r.enabled === false, "pref-read defaults to off: " + JSON.stringify(r));
  ok(r.source === "default" && r.lockedByJsonc === false, "pref-read source is the default and unlocked");
  ok(r.key === "allowNonAnthropicModels", "pref-read names the pref key");
  ok(r.activeNow === false, "pref-read reports activeNow false by default");
  ok(typeof r.jsonPath === "string" && r.jsonPath.endsWith("claude-desktop-extra.json"), "pref-read reports jsonPath");
  ok(typeof r.jsoncPath === "string" && r.jsoncPath.endsWith("claude-desktop-extra.jsonc"), "pref-read reports jsoncPath");
  rmSync(dir, { recursive: true });
}

// --- pref-set(true) persists, and the next process reads it back ON
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-mb-"));
  const t = load(dir);
  const s = await t.handlers["cdb-mb:pref-set"](sender, true);
  ok(s.ok === true && s.enabled === true && typeof s.path === "string", "pref-set(true) saves: " + JSON.stringify(s));
  ok(s.pendingRestart === true, "pref-set(true) on a process started off owes a restart");
  const pr = await t.handlers["cdb-mb:pref-read"](sender);
  ok(pr.enabled === true && pr.activeNow === false, "pref-read: saved on, running off: " + JSON.stringify(pr));
  ok(JSON.parse(readFileSync(jsonPath(dir), "utf8")).allowNonAnthropicModels === true, "the .json carries the key");
  const n = load(dir);
  ok(n.sandbox.__cdbAllowNonAnthropicModels() === true, "a reload reads it back ON");
  const r = await n.handlers["cdb-mb:pref-read"](sender);
  ok(r.ok === true && r.enabled === true && r.source === "json" && r.lockedByJsonc === false,
     "pref-read reports enabled from the .json: " + JSON.stringify(r));
  rmSync(dir, { recursive: true });
}

// --- saved vs running: turning it OFF while the process runs with it ON
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-mb-"));
  writeFileSync(jsonPath(dir), '{"allowNonAnthropicModels": true}');
  const t = load(dir);
  ok(t.sandbox.__cdbAllowNonAnthropicModels() === true, "memo: the process starts with the bypass active");
  const s = await t.handlers["cdb-mb:pref-set"](sender, false);
  ok(s.ok === true && s.enabled === false && s.pendingRestart === true, "pref-set(false) saves and owes a restart: " + JSON.stringify(s));
  const r = await t.handlers["cdb-mb:pref-read"](sender);
  ok(r.ok === true && r.enabled === false && r.activeNow === true,
     "pref-read: enabled is the saved false, activeNow the running true: " + JSON.stringify(r));
  ok(t.sandbox.__cdbAllowNonAnthropicModels() === true, "the running process keeps its startup value until a restart");
  const s2 = await t.handlers["cdb-mb:pref-set"](sender, true);
  ok(s2.ok === true && s2.pendingRestart === false, "pref-set back to the running value owes no restart: " + JSON.stringify(s2));
  const r2 = await t.handlers["cdb-mb:pref-read"](sender);
  ok(r2.enabled === true && r2.activeNow === true, "pref-read agrees again after switching back");
  rmSync(dir, { recursive: true });
}

// --- the hand-owned .jsonc wins over the Settings-written .json
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-mb-"));
  writeFileSync(jsonPath(dir), '{"allowNonAnthropicModels": false}');
  writeFileSync(jsoncPath(dir), '{\n  // mine\n  "allowNonAnthropicModels": true\n}');
  const t = load(dir);
  ok(t.sandbox.__cdbAllowNonAnthropicModels() === true, "the .jsonc true wins over the .json false");
  const r = await t.handlers["cdb-mb:pref-read"](sender);
  ok(r.ok === true && r.enabled === true && r.source === "jsonc-locked" && r.lockedByJsonc === true,
     "pref-read reports the .jsonc lock: " + JSON.stringify(r));
  const s = await t.handlers["cdb-mb:pref-set"](sender, false);
  ok(s.ok === false, "pref-set refuses while the .jsonc locks it");
  ok(JSON.parse(readFileSync(jsonPath(dir), "utf8")).allowNonAnthropicModels === false, "the refused set left the .json alone");
  rmSync(dir, { recursive: true });
}

// --- the sender guard: exact origin, main frame only
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-mb-"));
  const t = load(dir);
  for (const u of ["https://claude.ai/x", "https://preview.claude.ai/x", "https://claude.com/",
                   "https://preview.claude.com/x", "app://localhost/", "app://localhost/new?x=1"]) {
    ok((await t.handlers["cdb-mb:pref-read"](from(u))).ok === true, "sender " + u + " accepted");
  }
  for (const u of ["https://evil.example/", "app://localhost.evil/", "app://localhost:1234/", "app://other/",
                   "file:///home/u/x.html", "http://localhost:3000/", "http://claude.ai/", "not a url"]) {
    ok((await t.handlers["cdb-mb:pref-read"](from(u))).ok === false, "sender " + u + " rejected");
  }
  ok((await t.handlers["cdb-mb:pref-read"](from("app://localhost/", {}))).ok === false,
     "an app://localhost subframe is rejected");
  ok((await t.handlers["cdb-mb:pref-set"]({ sender: { getURL: () => "https://evil.example", isDestroyed: () => false } }, true)).ok === false,
     "pref-set: a foreign origin is rejected");
  rmSync(dir, { recursive: true });
}

// --- Part B: the compiled patch on fixtures shaped like upstream ------------
// The three gateway checks copied from v2.26454.0 (index.chunk-*.js) with their
// helpers trimmed to a small denylist, patched by the real binary, then
// evaluated with the switch on and off. OFF must match the unpatched fixture.
const BIN = join(ROOT, "patches/community/add_feature_allow_non_anthropic_models");
const GUARD = "(globalThis.__cdbAllowNonAnthropicModels&&globalThis.__cdbAllowNonAnthropicModels())";
const MARKER = "__CDB_ALLOW_NONANTHROPIC__";
const MARKS = ["/*cdb-mb:validator*/", "/*cdb-mb:discovery*/", "/*cdb-mb:tier-pin*/", "/*cdb-mb:setup-window*/"];
const MARK_E = MARKS[3];
const ION_FLAG = 'cdbAllowNonAnthropicModels:{status:"supported"}';
const count = (hay, needle) => hay.split(needle).length - 1;
let binRunnable = false;
try { accessSync(BIN, constants.X_OK); binRunnable = true; } catch {}

const FIXTURE = [
  '"use strict";',
  'var NCe=/deepseek|glm|qwen|kimi|moonshot|gpt/;var Yo=/^(sonnet|opus|haiku|fable|mythos)(-[\\d.]+)?$/;var MCe=["claude","sonnet","opus","haiku"];',
  'function PCe(e){return NCe.test(e.toLowerCase())}function FCe(e){let t=e.toLowerCase();return MCe.some((e=>t.includes(e)))}function Xo(e){let t=e.toLowerCase();return NCe.test(t)?!1:Yo.test(t)||MCe.some((e=>t.includes(e)))}',
  // B: the gateway/mantle validator
  'function HCe(e){return Xo(e)?{ok:!0}:{ok:!1,reason:"expected a gateway model route referencing an Anthropic model (e.g. claude-sonnet-4-5, anthropic/claude-*). Name routes to match the underlying model."}}',
  // C: gateway /v1/models discovery (the row filter, trimmed around it)
  'function a0t(e){return typeof e=="string"?{id:e,label:e}:void 0}function s0t(e){if(typeof e!="string")return;let t=e.toLowerCase();return["opus","sonnet","haiku"].includes(t)?t:void 0}',
  'function _0t(a){if(!Array.isArray(a?.data))return{ok:!1,kind:"error",message:"Gateway /v1/models returned an unexpected body.",httpStatus:200,requestUrl:"x"};let o=(e,t)=>typeof e=="boolean"?e:typeof t=="number"&&t>=1e6,s=a.data.flatMap((e=>{let t=e?a0t(e.id):void 0;if(!e||!t)return[];let n=s0t(e.anthropic_family_tier);return!Xo(t.id)&&!n?[]:[{id:t.id,name:t.label,supports1m:o(e.supports_1m,e.max_input_tokens),...n&&e.is_family_default===!0&&{isFamilyDefault:!0}}]}));return{ok:!0,models:s}}',
  // D: the [custom-3p] tier-pin sanitizer, gateway branch (`n` false)
  'var warned=[];var P={warn:e=>warned.push(e)};',
  'function san(n,t,r){if(!n){if(PCe(r)&&!FCe(r)){P.warn(`[custom-3p] ${t}: value matches a known non-Anthropic model fragment; ignoring.`);return}return r}return"1p:"+r}',
  // E: the Setup window's BrowserWindow options (trimmed), additionalArguments
  'function DH(){return{launch:{status:"supported"}}}var X=()=>({formatMessage:e=>e.defaultMessage});var n={default:{join:(...e)=>e.join("/")}};var a={app:{getAppPath:()=>"/app"}};',
  'function setupOpts(){return{title:X().formatMessage({defaultMessage:"Configure Third-Party Inference\\u2026",id:"9GRz7bC+rr"}),webPreferences:{preload:n.default.join(a.app.getAppPath(),".vite/build/mainView.js"),additionalArguments:[`--desktop-features=${JSON.stringify(DH())}`]}}}',
  'globalThis.__fx={HCe:HCe,disc:_0t,san:san,warned:warned,setupOpts:setupOpts};'
].join("\n");

const IDS = ["melious/deepseek-v4.1-flash", "inceptron/zai-org/GLM-5.3", "evroc/gpt-oss-120b",
             "anthropic/claude-sonnet-4-5", "sonnet", "acme/llama-4"];
function runFixture(src, flag) {
  // A predefined global makes the injected module return early, so the guards
  // read exactly this switch.
  const sb = { process: { platform: "linux", env: {} }, console,
               __cdbAllowNonAnthropicModels: () => flag };
  sb.globalThis = sb;
  vm.runInNewContext(src, vm.createContext(sb));
  const fx = sb.__fx;
  const body = { data: IDS.map((id) => ({ id })).concat([{ id: "acme/qwen-x", anthropic_family_tier: "opus" }]) };
  return {
    hce: IDS.map((id) => fx.HCe(id).ok),
    disc: fx.disc(body).models.map((m) => m.id),
    san: IDS.map((id) => { const v = fx.san(false, "opusModel", id); return v === undefined ? null : v; }),
    san1p: fx.san(true, "opusModel", "melious/deepseek-v4.1-flash"),
    warned: fx.warned.length,
    setupArgs: fx.setupOpts().webPreferences.additionalArguments
  };
}

if (!binRunnable) {
  console.log("  skip fixture + real bundle (patch binary not compiled - cd patches && make)");
} else {
  const dir = mkdtempSync(join(tmpdir(), "cdb-mb-fx-"));
  const f = join(dir, "staged_index.js");
  writeFileSync(f, FIXTURE);
  const out = execFileSync(BIN, [f], { encoding: "utf8" });
  ok(/\[PASS\]/.test(out) && !/\[FAIL\]/.test(out), "fixture: the binary applies all 5 parts");
  const patched = readFileSync(f, "utf8");
  ok(patched.startsWith('"use strict";') && count(patched, MARKER) === 1, "fixture: module injected after \"use strict\"");
  ok(count(patched, GUARD) === 4 && MARKS.every((m) => count(patched, m + (m === MARK_E ? "(" : "") + GUARD) === 1), "fixture: one guard per site");

  const stock = runFixture(FIXTURE, false);
  const off = runFixture(patched, false);
  const on = runFixture(patched, true);
  ok(JSON.stringify(off) === JSON.stringify(stock), "switch OFF behaves exactly as the unpatched code: " + JSON.stringify(off));
  ok(JSON.stringify(stock.hce) === JSON.stringify([false, false, false, true, true, false]), "stock validator rejects the denylisted and non-Anthropic-shaped routes");
  ok(on.hce.every((v) => v === true), "B ON: the gateway validator accepts every route");
  ok(!stock.disc.includes("melious/deepseek-v4.1-flash") && stock.disc.includes("acme/qwen-x"),
     "stock discovery drops untiered non-Anthropic rows, keeps tiered ones");
  ok(IDS.every((id) => on.disc.includes(id)) && on.disc.includes("acme/qwen-x"), "C ON: discovery keeps every row: " + JSON.stringify(on.disc));
  ok(stock.san[0] === null && stock.warned === 3, "stock tier-pin sanitizer ignores denylisted values and warns");
  ok(on.san.every((v, i) => v === IDS[i]) && on.warned === 0, "D ON: the tier-pin sanitizer returns every value, no warning");
  ok(on.san1p === "1p:melious/deepseek-v4.1-flash" && off.san1p === on.san1p, "D: the non-gateway branch is untouched");
  const feats = (r) => JSON.parse(r.setupArgs[0].slice("--desktop-features=".length));
  ok(off.setupArgs.length === 1 && JSON.stringify(feats(off)) === JSON.stringify(feats(stock)) && !("cdbAllowNonAnthropicModels" in feats(off)),
     "E OFF: the Setup window's --desktop-features is the stock JSON: " + off.setupArgs[0]);
  ok(on.setupArgs.length === 1 && feats(on).cdbAllowNonAnthropicModels?.status === "supported" && feats(on).launch?.status === "supported",
     "E ON: --desktop-features keeps upstream's keys and adds the switch: " + on.setupArgs[0]);

  const again = readFileSync(f, "utf8");
  execFileSync(BIN, [f], { encoding: "utf8" });
  ok(readFileSync(f, "utf8") === again, "fixture: a second run is a no-op");

  // Half-patched: drop one site's guard and the binary must refuse.
  const half = join(dir, "half.js");
  writeFileSync(half, again.replace(MARKS[1] + GUARD + "||", ""));
  let refused = false;
  try { execFileSync(BIN, [half], { encoding: "utf8" }); } catch (e) { refused = /half-patched/.test(String(e.stdout)); }
  ok(refused, "a half-patched bundle (one site missing) fails loud");
  rmSync(dir, { recursive: true, force: true });
}

// --- Part C: the REAL code-split bundle, patched by the compiled Nim binary ----
// Stages the extract as the orchestrator does, applies the patch, checks each
// site's end-state, evals the spliced expressions taken from the real bundle
// with the switch on and off, checks every changed chunk parses, and re-runs.
// Skipped when the binary is not compiled or no extract exists - the build job
// is the authoritative gate.
{
  const MARKER_RE = /\n\/\*__CDB_SPLIT__([^*\n]+?)__\*\/\n/;
  const buildDir = join(ROOT, "tmp/app.asar.contents/.vite/build");
  const stub = join(buildDir, "index.js");
  if (!binRunnable || !existsSync(stub)) {
    console.log("  skip real bundle (" + (binRunnable ? "no extract under tmp/app.asar.contents/" : "patch binary not compiled (cd patches && make)") + ")");
  } else {
    // Stage exactly as the orchestrator does: stub + every index*.chunk-* sibling
    // as ONE file, each sibling preceded by its boundary marker.
    const parts = [stub];
    const chunks = [];
    for (const d of readdirSync(buildDir)) {
      if (/^index.*\.chunk-.*\.js$/.test(d)) chunks.push(join(buildDir, d));
    }
    chunks.sort();
    parts.push(...chunks);
    const original = parts.map((p) => readFileSync(p, "utf8"));
    const blob = parts.slice(1).reduce(
      (acc, p, i) => acc + "\n/*__CDB_SPLIT__" + p.split("/").pop() + "__*/\n" + original[i + 1],
      original[0]
    );
    const dir = mkdtempSync(join(tmpdir(), "cdb-mb-"));
    const copy = join(dir, "staged_index.js");
    writeFileSync(copy, blob);

    const out = execFileSync(BIN, [copy], { encoding: "utf8" });
    ok(/\[PASS\]/.test(out) && !/\[FAIL\]/.test(out), "patch binary applies cleanly to the pristine staged bundle: " + out.trim().split("\n").pop());

    const patched = readFileSync(copy, "utf8");
    ok(count(patched, MARKER) === 1, "the injected module marker lands exactly once");
    ok(count(patched, GUARD) === 4, "the guard text lands exactly four times");
    for (const m of MARKS) ok(count(patched, m + (m === MARK_E ? "(" : "") + GUARD) === 1, "site " + m + " guarded exactly once");

    const evalWith = (src, flag, stubs) => {
      const sb = Object.assign({ __cdbAllowNonAnthropicModels: () => flag }, stubs);
      sb.globalThis = sb;
      return vm.runInNewContext(src, vm.createContext(sb));
    };
    const isAnthropic = (id) => /claude|sonnet|opus|haiku/.test(String(id).toLowerCase()) && !/deepseek|glm|qwen|gpt/.test(String(id).toLowerCase());

    // B: the whole patched gateway validator function.
    const b = /function ([\w$]+)\(([\w$]+)\)\{return ?\/\*cdb-mb:validator\*\/\(globalThis[^?]*\|\|([\w$]+)\(\2\)\?\{ok:!0\}:\{ok:!1,reason:"[^"]*"\}\}/.exec(patched);
    ok(!!b, "B: the real patched validator is extractable: " + (b ? b[0].slice(0, 140) : "no match"));
    if (b) {
      const fn = (flag) => evalWith("(" + b[0] + ")", flag, { [b[3]]: isAnthropic });
      ok(fn(true)("melious/deepseek-v4.1-flash").ok === true, "B real: ON accepts a non-Anthropic route");
      ok(fn(false)("melious/deepseek-v4.1-flash").ok === false, "B real: OFF rejects it as stock");
      ok(fn(false)("anthropic/claude-sonnet-4-5").ok === true, "B real: OFF still accepts an Anthropic route");
    }

    // C: the spliced row-filter expression, `return!(G||X(t.id))&&!n?[]:[`.
    const c = /return(!\(\/\*cdb-mb:discovery\*\/\(globalThis[^)]*\(\)\)\|\|([\w$]+)\(([\w$]+)\.id\)\)&&!([\w$]+)\?\[\]:\[)/.exec(patched);
    ok(!!c, "C: the real patched discovery filter is extractable: " + (c ? c[0] : "no match"));
    if (c) {
      const src = "(function(" + c[3] + "," + c[4] + "){return" + c[1] + "1]})";
      const keep = (flag, id, tier) => evalWith(src, flag, { [c[2]]: isAnthropic })({ id }, tier).length === 1;
      ok(keep(true, "melious/deepseek-v4.1-flash", undefined), "C real: ON keeps an untiered non-Anthropic row");
      ok(!keep(false, "melious/deepseek-v4.1-flash", undefined), "C real: OFF drops it as stock");
      ok(keep(false, "acme/qwen-x", "opus"), "C real: OFF still keeps a tiered row");
      ok(keep(false, "anthropic/claude-opus-4", undefined), "C real: OFF still keeps an Anthropic row");
    }

    // D: the spliced gateway branch of the sanitizer, `if(!n){if(!G&&PCe(r)&&!FCe(r)){...;return}return r}`.
    const d = /if\(!([\w$]+)\)\{if\(!\/\*cdb-mb:tier-pin\*\/\(globalThis[^)]*\(\)\)&&([\w$]+)\(([\w$]+)\)&&!([\w$]+)\(\3\)\)\{([\w$]+)\.warn\(`\[custom-3p\] \$\{([\w$]+)\}[^`]*`\);return\}return \3\}/.exec(patched);
    ok(!!d, "D: the real patched tier-pin branch is extractable: " + (d ? d[0].slice(0, 160) : "no match"));
    if (d) {
      const src = "(function(" + d[1] + "," + d[6] + "," + d[3] + "){" + d[0] + "return 'non-gateway'})";
      const stubs = { [d[2]]: (r) => /deepseek|glm|qwen|gpt/.test(r.toLowerCase()), [d[4]]: (r) => /claude/.test(r.toLowerCase()), [d[5]]: { warn() {} } };
      const san = (flag, id) => evalWith(src, flag, stubs)(false, "opusModel", id);
      ok(san(true, "melious/deepseek-v4.1-flash") === "melious/deepseek-v4.1-flash", "D real: ON returns a non-Anthropic pin");
      ok(san(false, "melious/deepseek-v4.1-flash") === undefined, "D real: OFF ignores it as stock");
      ok(san(false, "anthropic/claude-opus-4") === "anthropic/claude-opus-4", "D real: OFF still returns an Anthropic pin");
    }

    // E: the spliced --desktop-features template of the Setup window.
    const e = /Configure Third-Party Inference\\u2026[^`]{0,200}?additionalArguments:\[(`--desktop-features=\$\{JSON\.stringify\(\/\*cdb-mb:setup-window\*\/\(\(globalThis[^?]*\?\{\.\.\.([\w$]+)\(\),cdbAllowNonAnthropicModels:\{status:"supported"\}\}:\2\(\)\)\)\}`)\]/.exec(patched);
    ok(!!e, "E: the real patched Setup-window argument is extractable: " + (e ? e[1] : "no match"));
    if (e) {
      const arg = (flag) => JSON.parse(evalWith(e[1], flag, { JSON, [e[2]]: () => ({ launch: { status: "supported" } }) }).slice("--desktop-features=".length));
      ok(arg(true).cdbAllowNonAnthropicModels?.status === "supported" && arg(true).launch?.status === "supported", "E real: ON adds the switch to upstream's features");
      ok(!("cdbAllowNonAnthropicModels" in arg(false)) && arg(false).launch?.status === "supported", "E real: OFF is upstream's features unchanged");
    }

    // Each part that the patch changed must still parse on its own - the
    // per-chunk gate, exactly as the orchestrator splits it back.
    const pieces = patched.split(MARKER_RE);
    const bodies = pieces.filter((_, i) => i % 2 === 0);
    for (let i = 0; i < parts.length; i++) {
      if (bodies[i] === original[i]) continue; // unchanged part
      const cf = join(dir, parts[i].split("/").pop());
      writeFileSync(cf, bodies[i]);
      execFileSync("node", ["--check", cf]);
      ok(true, "changed chunk parses: " + parts[i].split("/").pop());
    }

    const before = readFileSync(copy, "utf8");
    execFileSync(BIN, [copy], { encoding: "utf8" });
    ok(readFileSync(copy, "utf8") === before, "a second run is a no-op (positive-end-state idempotency)");
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Part D: the ion-dist half (Setup window SPA), patched by its own binary --
// Copies the pristine ion-dist SPA's assets/v1/*.js (from resources/ion-dist.asar
// since v4.29.0, or a pre-4.29.0 resources/ion-dist/ dir), applies add_feature_allow_non_anthropic_models_ion,
// checks the single splice, evals the real patched validator with
// desktopBootFeatures carrying / lacking the switch, node --checks the file,
// re-runs for idempotency, and checks a fixture without the site fails loud.
{
  const ION_BIN = join(ROOT, "patches/community/add_feature_allow_non_anthropic_models_ion");
  const ION_SRC = openIonDist(join(ROOT, "tmp/extract/usr/lib/claude-desktop"));
  const ION_MARK = "/*cdb-mb:ion-validator*/";
  const ION_GUARD = '(globalThis.desktopBootFeatures?.cdbAllowNonAnthropicModels?.status==="supported")';
  let ionRunnable = false;
  try { accessSync(ION_BIN, constants.X_OK); ionRunnable = true; } catch {}
  if (!ionRunnable) {
    console.log("  skip ion-dist (patch binary not compiled - cd patches && make)");
  } else {
    // Fixture: the site missing -> FAIL, never a silent success.
    const fdir = mkdtempSync(join(tmpdir(), "cdb-mb-ionfx-"));
    execFileSync("mkdir", ["-p", join(fdir, "assets/v1")]);
    writeFileSync(join(fdir, "assets/v1/x.js"), "function Sr(e){return!0}");
    let refused = false;
    try { execFileSync(ION_BIN, [fdir], { encoding: "utf8" }); } catch (e) { refused = /\[FAIL\]/.test(String(e.stdout)); }
    ok(refused, "ion: an SPA without the gateway validator fails loud");
    rmSync(fdir, { recursive: true, force: true });

    if (!ION_SRC) {
      console.log("  skip real ion-dist (no extract under tmp/extract/)");
    } else {
      const dir = mkdtempSync(join(tmpdir(), "cdb-mb-ion-"));
      const v1 = join(dir, "assets/v1");
      execFileSync("mkdir", ["-p", v1]);
      const jsFiles = ION_SRC.list("assets/v1").filter((f) => f.endsWith(".js"));
      for (const f of jsFiles) writeFileSync(join(v1, f), ION_SRC.read("assets/v1/" + f));
      const before = Object.fromEntries(jsFiles.map((f) => [f, readFileSync(join(v1, f), "utf8")]));
      const out = execFileSync(ION_BIN, [dir], { encoding: "utf8" });
      ok(/\[PASS\]/.test(out) && !/\[FAIL\]/.test(out), "ion: binary applies cleanly to the pristine SPA: " + out.trim().split("\n").pop());
      const changed = jsFiles.filter((f) => readFileSync(join(v1, f), "utf8") !== before[f]);
      ok(changed.length === 1, "ion: exactly one SPA file changed: " + changed.join(","));
      if (changed.length === 1) {
        const cf = join(v1, changed[0]);
        const txt = readFileSync(cf, "utf8");
        ok(count(txt, ION_MARK + ION_GUARD + "||") === 1, "ion: the marked guard lands exactly once");
        // The splice must be the ONLY difference.
        ok(txt.replace(ION_MARK + ION_GUARD + "||", "") === before[changed[0]], "ion: nothing else in the file changed");
        const mjs = join(dir, "check.mjs");
        writeFileSync(mjs, txt);
        execFileSync("node", ["--check", mjs]);
        ok(true, "ion: patched file parses (node --check, as an ES module)");
        const m = /function ([\w$]+)\(([\w$]+)\)\{return \/\*cdb-mb:ion-validator\*\/\(globalThis[^)]*\)\|\|([\w$]+)\(\2\)\?\{ok:!0\}:\{ok:!1,reason:"[^"]*"\}\}/.exec(txt);
        ok(!!m, "ion: the real patched validator is extractable: " + (m ? m[0].slice(0, 120) : "no match"));
        if (m) {
          const isAnthropic = (id) => /claude|sonnet|opus|haiku/.test(String(id).toLowerCase()) && !/deepseek|glm|qwen|gpt/.test(String(id).toLowerCase());
          const fn = (feats) => {
            const sb = { [m[3]]: isAnthropic };
            if (feats !== undefined) sb.desktopBootFeatures = feats;
            sb.globalThis = sb;
            return vm.runInNewContext("(" + m[0] + ")", vm.createContext(sb));
          };
          const on = fn({ launch: { status: "supported" }, cdbAllowNonAnthropicModels: { status: "supported" } });
          ok(on("melious/deepseek-v4.1-flash").ok === true && on("zai-org/glm-5.3").ok === true, "ion real: switch ON accepts non-Anthropic gateway routes");
          ok(fn({ launch: { status: "supported" } })("melious/deepseek-v4.1-flash").ok === false, "ion real: key absent rejects as stock");
          ok(fn(undefined)("melious/deepseek-v4.1-flash").ok === false, "ion real: no desktopBootFeatures (browser / other window) rejects as stock");
          ok(fn(undefined)("anthropic/claude-sonnet-4-5").ok === true, "ion real: OFF still accepts an Anthropic route");
        }
        const snap = readFileSync(cf, "utf8");
        const out2 = execFileSync(ION_BIN, [dir], { encoding: "utf8" });
        ok(readFileSync(cf, "utf8") === snap && /already present/.test(out2), "ion: a second run is a no-op and says so");
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
