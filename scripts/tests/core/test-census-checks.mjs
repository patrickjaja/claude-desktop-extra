#!/usr/bin/env node
// Fixture tests for the two upstream-gate censuses (issue #323):
//   scripts/check-predicate-consumers.py  (+ baseline/predicate-consumers.json)
//   scripts/check-refusal-strings.py      (+ baseline/refusal-strings.json)
//   scripts/census_lex.py                 (the shared structural lexer)
//
// WHY THIS EXISTS
// ---------------
// #323 shipped because our patch rewrote ONE call site of upstream's
// isBridgeComputerUsePlatform while two more consumers stayed unpatched: one
// through a chunk export alias (`e.EF()`), one through a namespace member
// destructured in a lazy chunk. The censuses are the gate that has to catch
// the next one, so they run here on small synthetic code-split bundles that
// reproduce those alias shapes and every way an independent review found to
// slip past them: other alias forms (destructured require, lazy module
// bindings, import(), __toESM, bracket access), shadowing mistakes (for-let,
// default parameter values, object-pattern keys), derived values and
// wrappers, injections that do not dominate the consumer, an untracked term
// in a "transitively covered" predicate, inline copies of the session test,
// a namespace-looking object that is really a callable value, refusal
// strings split by `+`, wording inside template expressions, a second site of
// a pinned string, a neutralised string whose patch regressed, and lexer
// traps (`x.return/2`, `if(a)/"/.test(b)`, `i++/2`).
//
//   A  predicate census on the #323 shape and its fixes
//   B  alias, shadowing and derivation cases (each must FAIL)
//   C  coverage: definitionShape, coveredSites, transitive, allowlist rules
//   D  raw session tests, module objects, gate hardening
//   E  refusal strings
//   F  lexer stress (through the refusal census)
//   G  the real baselines load and are well formed
//
// Exit: 0 PASS, 3 SKIP (python3 missing), other FAIL.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PRED = join(ROOT, "scripts", "check-predicate-consumers.py");
const REFUSAL = join(ROOT, "scripts", "check-refusal-strings.py");

if (spawnSync("python3", ["--version"]).status !== 0) {
  console.log("SKIP: python3 not found");
  process.exit(3);
}

let pass = 0;
const failures = [];
function check(label, ok, extra) {
  if (ok) { pass++; console.log("  PASS " + label); return; }
  failures.push(label);
  console.log("  FAIL " + label + (extra !== undefined ? "  -> " + String(extra).slice(0, 2500) : ""));
}

const TMP = mkdtempSync(join(tmpdir(), "cdb-census-"));
process.on("exit", () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });
const EMPTY = join(TMP, "empty");
mkdirSync(EMPTY);
let n = 0;

function tree(files, main) {
  const dir = join(TMP, "t" + (n++));
  const build = join(dir, ".vite", "build");
  mkdirSync(build, { recursive: true });
  writeFileSync(join(build, "index.js"), '"use strict";require("./index.chunk-main.js");\n');
  writeFileSync(join(build, "index.chunk-rt.js"), '"use strict";exports.r=o=>o;');
  writeFileSync(join(build, "index.chunk-main.js"), main ?? mainChunk());
  for (const [name, body] of Object.entries(files)) writeFileSync(join(build, name), body);
  return dir;
}
function json(obj) {
  const p = join(TMP, "b" + (n++) + ".json");
  writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}
function pred(dir, base, extra = []) {
  const r = spawnSync("python3", ["-I", PRED, "--fixture", "--js-dir", "", "--patches-dir", "", "--baseline", base, ...extra, dir],
    { encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
function refusal(dir, base, extra = []) {
  const r = spawnSync("python3", ["-I", REFUSAL, "--fixture", "--js-dir", EMPTY, "--baseline", base, ...extra, dir],
    { encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
const failLines = (out) => out.split("\n").filter((l) => l.startsWith("[FAIL]"));
const failsIn = (out, chunk) => failLines(out).some((l) => l.includes(chunk));

// ------------------------------------------------------------------ fixtures
const getter = (k, v) => `Object.defineProperty(exports,"${k}",{enumerable:!0,get:function(){return ${v}}});`;
const WAY = 'var W=()=>{let e=process.env.XDG_SESSION_TYPE;return e?e==="wayland":!!process.env.WAYLAND_DISPLAY};';
const U_PLAIN = "function U(){return!W()}";
const U_PATCHED = 'function U(){return!W()||process.platform==="linux"&&globalThis.__cdbAnnounce===!0}';
function mainChunk({ u = U_PLAIN, extra = "" } = {}) {
  return '"use strict";const e=require("./index.chunk-rt.js");' + WAY + u + extra +
    "var NS=e.r({isBridgeComputerUsePlatform:()=>U,somethingElse:()=>Q});function Q(){return 1}" +
    getter("EF", "U") + getter("wF", "NS") + getter("X0", "W") + getter("Qx", "Q");
}
const H = '"use strict";const b=require("./index.chunk-main.js");';
const guardChunk = (body) => '"use strict";const e=require("./index.chunk-main.js");' + `var R=t=>t,Ue=(t,n)=>{${body};return n};`;
const GUARD = 'if(!e.EF())return R("Computer use over the device bridge is not supported on this platform (on Linux it needs an Xorg session)")';
const lazyChunk = '"use strict";async function icon(x){let{isBridgeComputerUsePlatform:i}=await Promise.resolve()' +
  '.then((()=>require("./index.chunk-main.js"))).then((e=>e.wF));if(!i())return null;return x}exports.icon=icon;';
const otherChunk = '"use strict";' + getter("EF", "Z") + "function Z(){return 0}";
const collideChunk = '"use strict";const n=require("./index.chunk-other.js"),e=require("./index.chunk-main.js");' +
  "function f(){return n.EF()}function h(e){return e.EF()}function g(){return e.Qx()}exports.f=f;";

const PREDICATES = [
  {
    id: "isWaylandSession",
    find: {
      prefilter: "XDG_SESSION_TYPE",
      bodyRegex: "(?<![\\w$.])(?P<name>[\\w$]+)=\\(\\)=>\\{let (?P<v>[\\w$]+)=process\\.env\\.XDG_SESSION_TYPE;return (?P=v)\\?(?P=v)===\"wayland\":!!process\\.env\\.WAYLAND_DISPLAY\\}",
    },
  },
  {
    id: "isBridgeComputerUsePlatform",
    find: { namespaceKey: "isBridgeComputerUsePlatform" },
    definitionShape: ['^\\{return![\\w$]+\\(\\)\\|\\|process\\.platform==="linux"&&globalThis\\.__cdbAnnounce===!0\\}$'],
  },
];
function base({ allowlist = [], coveredSites = [], envSites = [], predicates = PREDICATES } = {}) {
  return json({ predicates, allowlist, coveredSites, envSites });
}
function fullBundle({ u = U_PLAIN, guard = GUARD, extra = {} } = {}) {
  return tree({
    "index.chunk-guard.js": guardChunk(guard),
    "index.chunk-lazy.js": lazyChunk,
    "index.chunk-other.js": otherChunk,
    "index.chunk-collide.js": collideChunk,
    ...extra,
  }, mainChunk({ u }));
}
const consumersOf = (out, id) => {
  const m = out.match(new RegExp("=== " + id + ": .*consumers: (\\d+)"));
  return m ? Number(m[1]) : -1;
};

// ------------------------------------------------------------------ A
console.log("A  predicate census on the #323 shape");
{
  const r = pred(fullBundle(), base());
  check("A1 #323 state fails", r.code === 1, r.out);
  check("A1 export-alias consumer e.EF() named", failLines(r.out).some((l) => l.includes("index.chunk-guard.js") && l.includes("(export alias)")), r.out);
  check("A1 lazy destructured namespace member named", failLines(r.out).some((l) => l.includes("index.chunk-lazy.js") && l.includes("destructured alias i")), r.out);
  check("A1 exactly 2 consumers (collision + shadowed param not counted)", consumersOf(r.out, "isBridgeComputerUsePlatform") === 2, r.out);
  check("A1 nothing reported from the unrelated chunks", !/index\.chunk-(other|collide)\.js@/.test(r.out), r.out);
  check("A1 the Wayland test inside the bridge predicate is a dependency", /inside:isBridgeComputerUsePlatform/.test(r.out), r.out);
  const ok = pred(fullBundle({ u: U_PATCHED }), base());
  check("A2 our definition shape covers every alias: exit 0", ok.code === 0, ok.out);
  check("A2 reported direct", /isBridgeComputerUsePlatform: U .*definition covered: direct/.test(ok.out), ok.out);
  const loose = pred(fullBundle({ u: 'function U(){globalThis.__cdbLog?.(process.platform==="linux");return!W()}' }), base());
  check("A3 both markers somewhere in the body are NOT coverage (O5)", loose.code === 1 && failsIn(loose.out, "index.chunk-guard.js"), loose.out);
}

// ------------------------------------------------------------------ B
console.log("B  alias forms, shadowing, derivation (each must FAIL)");
const CASES = {
  optional_call: H + 'function f(){if(!b.EF?.())return"refuse"}',
  bracket_string: H + 'function f(){if(!b["EF"]())return"refuse"}',
  destructured_require: '"use strict";const{EF:z}=require("./index.chunk-main.js");function f(){if(!z())return"refuse"}',
  var_alias_then_call: H + 'var z=b.EF;function f(){if(!z())return"refuse"}',
  pass_as_value: H + 'var g={check:b.EF};function f(){if(!g.check())return"refuse"}',
  then_value: H + "function f(p){return p.then(b.EF)}",
  for_let_shadow: H + 'function f(a){for(let b of a){}if(!b.EF())return"refuse"}',
  param_default_ref: H + 'function f(t=b.other){if(!b.EF())return"refuse"}',
  param_key_named_b: H + 'function f({b:t}){if(!b.EF())return"refuse"}',
  nested_block_let_other_branch: H + 'function f(a){if(a){let b=1;return b}if(!b.EF())return"refuse"}',
  lazy_paren_param: '"use strict";async function f(){let m=await Promise.resolve().then((()=>require("./index.chunk-main.js"))).then(((e)=>e.EF));if(!m())return"refuse"}',
  lazy_fn_param: '"use strict";async function f(){let m=await Promise.resolve().then((()=>require("./index.chunk-main.js"))).then((function(e){return e.EF}));if(!m())return"refuse"}',
  lazy_module_binding: '"use strict";async function f(){let m=await Promise.resolve().then((()=>require("./index.chunk-main.js")));if(!m.EF())return"refuse"}',
  lazy_single_paren_member: '"use strict";async function f(){let a=await Promise.resolve().then(()=>require("./index.chunk-main.js")).then(t=>t.EF());return a}',
  dynamic_import: 'async function f(){let m=await import("./index.chunk-main.js");if(!m.EF())return"refuse"}',
  toESM_wrap: '"use strict";const b=e.__toESM(require("./index.chunk-main.js"));function f(){if(!b.EF())return"refuse"}',
  promise_all_destructure: '"use strict";async function f(){let[{EF:z},y]=await Promise.all([Promise.resolve().then((()=>require("./index.chunk-main.js"))),Promise.resolve().then((()=>require("./index.chunk-rt.js")))]);if(!z())return"refuse"}',
  ns_bracket_member: H + 'async function f(){let n=b.wF;if(!n["isBridgeComputerUsePlatform"]())return"refuse"}',
  ns_spread: H + 'var n={...b.wF};function f(){if(!n.isBridgeComputerUsePlatform())return"refuse"}',
  ns_destructured_rename_chain: H + 'function f(){let{isBridgeComputerUsePlatform:i}=b.wF,j=i;if(!j())return"refuse"}',
  reexport_chain_used: H + getter("Zz", "Y") + "var Y=b.EF;",
  wrapper_fn_new_caller: H + 'function V(){return b.EF()}function f(){if(!V())return"refuse"}',
  derived_value_new_reader: H + 'var Z=!b.EF();function f(){if(!Z)throw Error("Teach mode is off in this session")}',
  ternary_other_branch: H + 'function f(){return b.EF()?globalThis.__cdbLog?.("x"):"refuse"}',
  and_sibling_diag: H + 'function f(){return!b.EF()&&(globalThis.__cdbDiag("refusing"),"refuse")}',
  head_guard_cond_return: H + 'function f(){if(process.platform==="linux"&&globalThis.__cdbX===42)return 1;if(!b.EF())return"refuse"}',
  head_guard_log_only: H + 'function f(){if(process.platform==="linux"){globalThis.__cdbDiag("x");if(Math.random()>2)return 1}if(!b.EF())return"refuse"}',
};
for (const [name, body] of Object.entries(CASES)) {
  const files = { "index.chunk-x.js": body };
  if (name === "reexport_chain_used") files["index.chunk-y.js"] = '"use strict";const q=require("./index.chunk-x.js");function g(){if(!q.Zz())return"refuse"}';
  const r = pred(tree(files), base());
  check(`B ${name}`, r.code === 1 && /index\.chunk-[xy]\.js/.test(failLines(r.out).join("\n")), r.out);
}
{
  // R2: an object of callbacks is not a namespace re-export
  const dyn = pred(tree({}, mainChunk({ extra: 'var G={allowed:()=>W()};function f(k){if(!G[k]())return"refuse"}' })), base());
  check("B callback object calling the predicate is a consumer (R2)", dyn.code === 1 && /uncovered consumer in index\.chunk-main\.js/.test(dyn.out), dyn.out);
  const val = pred(tree({}, mainChunk({ extra: "var G={allowed:()=>W};" })), base());
  check("B plain object holding the predicate is a consumer, not a namespace", val.code === 1, val.out);
}
{
  const r = pred(tree({ "index.chunk-x.js": H + 'function f(){if(!b.EF())return"refuse"}' }), base());
  check("B the export-alias baseline case still fails", r.code === 1 && failsIn(r.out, "index.chunk-x.js"), r.out);
}

// ------------------------------------------------------------------ C
console.log("C  coverage rules");
{
  const site = 'if(!(e.EF()||process.platform==="linux"&&globalThis.__cdbOk))return R(1)';
  const noEntry = pred(fullBundle({ guard: site }), base());
  check("C1 an injection next to the consumer is not coverage without a coveredSites entry", failsIn(noEntry.out, "index.chunk-guard.js"), noEntry.out);
  const shape = { predicate: "isBridgeComputerUsePlatform", shape: 'if\\(!\\(@@\\(\\)\\|\\|process\\.platform==="linux"&&globalThis\\.__cdbOk\\)\\)', consumers: 1, reason: "fixture: our term is the || operand that decides" };
  const withEntry = pred(fullBundle({ guard: site }), base({ coveredSites: [shape] }));
  check("C1 the exact injected shape around the consumer covers it", /covered-site\s+\[site#0\]\s+index\.chunk-guard\.js/.test(withEntry.out) && !failsIn(withEntry.out, "index.chunk-guard.js"), withEntry.out);
  const other = pred(fullBundle({ guard: 'if(!(e.EF()&&globalThis.__cdbOk))return R(1)' }), base({ coveredSites: [shape] }));
  check("C1 a shape that does not surround the consumer fails as stale", /coveredSites entry .* pins 1 consumer\(s\) but covers 0/.test(other.out), other.out);
}
{
  const M = '"use strict";const e=require("./index.chunk-rt.js");' +
    'function H(){if(process.platform==="linux")return!0;return!1}function D(){return process.platform==="darwin"&&!0}' +
    'function T(){return H()&&!D()&&process.env.XDG_SESSION_TYPE!=="wayland"}function T2(){return H()&&!D()}' +
    "var NS=e.r({hasComputerUseExecutor:()=>H,isCuSupportedPlatform:()=>T,other:()=>T2});" +
    'function f(){if(!T())return"Computer use needs X"}function g(){if(!T2())return"Computer use needs X"}';
  const preds = [
    { id: "h", find: { namespaceKey: "hasComputerUseExecutor" }, definitionShape: ['^\\{if\\(process\\.platform==="linux"\\)return!0;'] },
    { id: "t", find: { namespaceKey: "isCuSupportedPlatform" }, transitiveIgnore: [{ calleeBody: '^\\{return process\\.platform==="darwin"', reason: "fixture: darwin-only term" }] },
  ];
  const r = pred(tree({}, M), base({ predicates: preds }));
  check("C2 an untracked term blocks transitive coverage (R5)", r.code === 1 && /=== t: .*definition covered: no/.test(r.out), r.out);
  const M2 = M.replace('&&process.env.XDG_SESSION_TYPE!=="wayland"', "");
  const r2 = pred(tree({}, M2), base({ predicates: preds }));
  check("C2 covered + transitiveIgnore callees only: transitive", r2.code === 0 && /=== t: .*transitive via h/.test(r2.out), r2.out);
}
{
  const allow = [
    { predicate: "isBridgeComputerUsePlatform", anchor: "on Linux it needs an Xorg session", consumers: 1, verdict: "upstream-ok", reason: "fixture reason text" },
    { predicate: "isBridgeComputerUsePlatform", anchor: "return null;return x", consumers: 1, verdict: "intentional", reason: "fixture reason text" },
  ];
  const ok = pred(fullBundle(), base({ allowlist: allow }));
  check("C3 allowlisted consumers pass", ok.code === 0, ok.out);
  const stale = pred(fullBundle(), base({ allowlist: [...allow, { predicate: "isBridgeComputerUsePlatform", anchor: "text upstream removed", consumers: 1, verdict: "intentional", reason: "fixture reason text" }] }));
  check("C3 stale anchor fails", stale.code === 1 && /stale allowlist entry .*text upstream removed/.test(stale.out), stale.out);
  const count = pred(fullBundle(), base({ allowlist: [{ ...allow[0], consumers: 2 }, allow[1]] }));
  check("C3 a different consumer count fails", count.code === 1 && /pins 2 consumer\(s\) but matches 1/.test(count.out), count.out);
  const open = pred(fullBundle(), base({ allowlist: [{ ...allow[0], verdict: "open" }, allow[1]] }));
  check("C3 verdict open without an issue fails (R7)", open.code === 1 && /verdict 'open' without an 'issue'/.test(open.out), open.out);
  const tracked = pred(fullBundle(), base({ allowlist: [{ ...allow[0], verdict: "open", issue: "#999" }, allow[1]] }));
  check("C3 verdict open with an issue passes", tracked.code === 0, tracked.out);
  const derived = pred(tree({ "index.chunk-x.js": H + 'var Z=!b.EF();function f(){if(!Z)throw Error("Teach mode is off")}' }),
    base({ allowlist: [{ predicate: "isBridgeComputerUsePlatform", anchor: "Teach mode is off", consumers: 1, verdict: "intentional", reason: "fixture reason text" }] }));
  check("C3 an entry without via does not list a derived value's consumer", derived.code === 1, derived.out);
  const via = pred(tree({ "index.chunk-x.js": H + 'var Z=!b.EF();function f(){if(!Z)throw Error("Teach mode is off")}' }),
    base({ allowlist: [{ predicate: "isBridgeComputerUsePlatform", anchor: "Teach mode is off", via: "derived", consumers: 1, verdict: "intentional", reason: "fixture reason text" }] }));
  check("C3 via: derived lists it", via.code === 0 && /derived:isBridgeComputerUsePlatform>Z/.test(via.out), via.out);
}

// ------------------------------------------------------------------ D
console.log("D  raw session tests, module objects, hardening");
{
  const inl = pred(tree({ "index.chunk-x.js": '"use strict";function f(){if(process.env.XDG_SESSION_TYPE==="wayland")return"Computer use needs an Xorg session"}' }), base({ predicates: PREDICATES }));
  check("D1 an inline copy of the session test fails (O3)", inl.code === 1 && /raw session test XDG_SESSION_TYPE outside every tracked predicate in index\.chunk-x\.js/.test(inl.out), inl.out);
  const pinned = pred(tree({ "index.chunk-x.js": '"use strict";var k=["DISPLAY","XDG_SESSION_TYPE","XDG_SESSION_DESKTOP"];' }),
    base({ envSites: [{ token: "XDG_SESSION_TYPE", anchor: "XDG_SESSION_DESKTOP", count: 1, reason: "fixture env list" }], predicates: PREDICATES }));
  check("D1 a pinned env-name list passes", !/raw session test \w+ outside/.test(pinned.out) && !/envSites entry/.test(pinned.out), pinned.out);
  const jsDir = join(TMP, "js");
  mkdirSync(jsDir, { recursive: true });
  writeFileSync(join(jsDir, "ours.js"), 'globalThis.__cdbIsX11=()=>process.env.XDG_SESSION_TYPE==="x11"||!process.env.WAYLAND_DISPLAY;');
  const ours = pred(tree({ "index.chunk-x.js": '"use strict";globalThis.__cdbIsX11=()=>process.env.XDG_SESSION_TYPE==="x11"||!process.env.WAYLAND_DISPLAY;' }), base(), ["--js-dir", jsDir]);
  writeFileSync(join(jsDir, "ozone.js"), 'const a=u.app.commandLine.getSwitchValue("ozone-platform")||"";globalThis.__cdbOz=a;');
  const oz = pred(tree({ "index.chunk-x.js": '"use strict";function N(){let e=u.app.commandLine.getSwitchValue("ozone-platform");return e==="wayland"?"Teach mode needs an X server":null}' }), base(), ["--js-dir", jsDir]);
  check("D1 an upstream inline ozone test is reported even though our js shares one side of its text", /raw session test ozone-platform outside every tracked predicate in index\.chunk-x\.js/.test(oz.out), oz.out);
  check("D1 our own injected copy is recognised", !/raw session test \w+ outside/.test(ours.out) && /2 ours/.test(ours.out), ours.out);
}
{
  const r = pred(tree({ "index.chunk-x.js": '"use strict";function f(g){return g(require("./index.chunk-main.js"))}' }), base());
  check("D2 a module object handed to unknown code fails", r.code === 1 && /module object of index\.chunk-main\.js reaches code the census does not follow/.test(r.out), r.out);
}
{
  const r = spawnSync("python3", ["-I", PRED, "--baseline", base(), fullBundle({ u: U_PATCHED })], { encoding: "utf8" });
  check("D3 a baseline without the required predicate set is refused (O4)", r.status === 2 && /lacks required predicate/.test(r.stderr), r.stderr);
  const help = spawnSync("python3", ["-I", PRED, "--help"], { encoding: "utf8" });
  check("D3 --help states what the census cannot see (O6)", help.status === 0 && /PATCHED/.test(help.stdout), help.stdout);
  const src = readFileSync(PRED, "utf8");
  check("D3 docstring names its blind spots", /WHAT IT CANNOT SEE/.test(src) && /ion-dist/.test(src));
}

// ------------------------------------------------------------------ E
console.log("E  refusal strings");
const key = (t) => createHash("sha1").update(t, "utf8").digest("hex").slice(0, 12);
const T323 = "Computer use over the device bridge is not supported on this platform (on Linux it needs an Xorg session)";
const TPL_SRC = "`Computer use over ${a?`the ${b} bridge`:\"x\"} is not supported on this platform (on Linux it needs an ${c} session)`";
const TPL_NORM = "Computer use over ${} is not supported on this platform (on Linux it needs an ${} session)";
const POP = "Pop-out overlay is not available under Wayland";
const NOISE = "`a ${`nested ${\"}\"} template`} with a brace` + \"" + POP + "\"";
const GUARD_PATCH = 'function U(){return!W()||process.platform==="linux"&&globalThis.__cdbAnnounce===!0}';
function refTree(extra = "", patched = true) {
  return tree({
    "index.chunk-x.js": `"use strict";var R=e=>e;${patched ? GUARD_PATCH : ""}function g(){return R("${T323}")}var o=${NOISE};function t(a,b,c){return ${TPL_SRC}}${extra}`,
  });
}
const pin = (text, status = "accepted", sites = 1, extra = {}) => ({ id: key(text), text, status, sites, reason: "fixture reason text", ...extra });
const VERIFY = { regex: '\\|\\|process\\.platform==="linux"&&globalThis\\.__cdbAnnounce===!0\\}', count: 1 };
const BASE_PINS = [pin(T323, "neutralised", 1, { verify: VERIFY }), pin(TPL_NORM), pin("a ${} with a brace" + POP)];
{
  const l = refusal(refTree(), json({ strings: [] }), ["--list"]);
  const ok = refusal(refTree(), json({ strings: BASE_PINS }));
  check("E1 pinned set passes", ok.code === 0, ok.out + l.out);
  check("E1 template literal read whole and normalised (nested `${`...`}`)", l.out.includes(key(TPL_NORM)), l.out);
  check("E1 a `+` chain is one text (template + string)", l.out.includes(key("a ${} with a brace" + POP)), l.out);
}
{
  const NEW = "Teach mode is not supported on this platform under Wayland";
  const r = refusal(refTree(`var z="${NEW}";`), json({ strings: BASE_PINS }));
  check("E2 a new refusal string fails with its key", r.code === 1 && r.out.includes("[FAIL] new refusal string " + key(NEW)), r.out);
  const missing = refusal(refTree(), json({ strings: BASE_PINS.slice(1) }));
  check("E2 the #323 string unpinned fails", missing.code === 1 && missing.out.includes(key(T323)), missing.out);
  const stale = refusal(refTree(), json({ strings: [...BASE_PINS, pin("Computer use is not available on this platform")] }));
  check("E2 a stale pin is a warning: exit 0 with [WARN] and the /update hint", stale.code === 0 && /\[WARN\] stale pin/.test(stale.out) &&
    /refresh these pins .* next \/update/.test(stale.out) && /0 failure\(s\), 1 warning\(s\)/.test(stale.out), stale.out);
  const strictStale = refusal(refTree(), json({ strings: [...BASE_PINS, pin("Computer use is not available on this platform")] }), ["--strict"]);
  check("E2 --strict turns the stale-pin warning into a failure", strictStale.code === 1 && /\[FAIL\] stale pin/.test(strictStale.out), strictStale.out);
  const WEAK = "Cleanup is not available on this device";
  const weak = refusal(refTree(`var w="${WEAK}";`), json({ strings: BASE_PINS }));
  check("E2 a new weak-topic string is a warning (exit 0)", weak.code === 0 && weak.out.includes("[WARN] new refusal string " + key(WEAK) + " (weak topic"), weak.out);
  const weakStrict = refusal(refTree(`var w="${WEAK}";`), json({ strings: BASE_PINS }), ["--strict"]);
  check("E2 --strict fails on it", weakStrict.code === 1 && weakStrict.out.includes("[FAIL] new refusal string " + key(WEAK)), weakStrict.out);
  check("E2 a new strong-topic string is a failure, marked strong", r.out.includes("(strong topic"), r.out);
}
{
  const second = refusal(refTree(`function h(){return R("${T323}")}`), json({ strings: BASE_PINS }));
  check("E3 a second site printing a pinned text fails (site count)", second.code === 1 && /now printed at 2 site\(s\), pinned 1/.test(second.out), second.out);
  const acc = refusal(refTree(`function h(a,b,c){return ${TPL_SRC}}`), json({ strings: BASE_PINS }));
  check("E3 a second site of an ACCEPTED pin is a warning", acc.code === 0 && /\[WARN\] pinned string .* \(accepted\) now printed at 2 site/.test(acc.out), acc.out);
  const regressed = refusal(refTree("", false), json({ strings: BASE_PINS }));
  check("E3 a neutralised pin whose patch regressed fails (#323 pre-fix state)", regressed.code === 1 && /no longer backed by its injection/.test(regressed.out), regressed.out);
  const noVerify = refusal(refTree(), json({ strings: [pin(T323, "neutralised"), ...BASE_PINS.slice(1)] }));
  check("E3 a neutralised pin without verify is refused", noVerify.code === 2, noVerify.out);
}
{
  const CONCAT = 'var m="Computer use "+e.name+" is not supported on Wayland";';
  const l = refusal(refTree(CONCAT), json({ strings: [] }), ["--list"]);
  check("E4 a `\"a\"+x+\"b\"` chain is one text", l.out.includes(key("Computer use ${} is not supported on Wayland")), l.out);
  const EXPR = "var m=`Computer use on Wayland ${x?\"is not available\":\"works\"}`;";
  const l2 = refusal(refTree(EXPR), json({ strings: [] }), ["--list"]);
  check("E4 refusal wording inside a template expression counts", l2.out.includes(key("Computer use on Wayland ${}")), l2.out);
  const WIDE = 'var w1="Computer use over the device bridge is disabled on this device.",w2="Screen sharing over the bridge is unavailable on Linux";';
  const l3 = refusal(refTree(WIDE), json({ strings: [] }), ["--list"]);
  check("E4 the wider net catches device / Linux phrasings (R8)",
    l3.out.includes(key("Computer use over the device bridge is disabled on this device.")) && l3.out.includes(key("Screen sharing over the bridge is unavailable on Linux")), l3.out);
}
{
  const OURS = "x11-bridge unavailable on this Wayland session, falling back";
  const jsDir = join(TMP, "js2");
  mkdirSync(jsDir);
  writeFileSync(join(jsDir, "ours.js"), `globalThis.__cdbOurs=()=>log("${OURS}");`);
  const r = spawnSync("python3", ["-I", REFUSAL, "--fixture", "--js-dir", jsDir, "--baseline", json({ strings: BASE_PINS }),
    refTree(`globalThis.__cdbOurs=()=>log("${OURS}");`)], { encoding: "utf8" });
  check("E5 our own js/ strings are subtracted", r.status === 0, r.stdout + r.stderr);
  const bad = refusal(refTree(), json({ strings: [{ ...pin(T323), id: "000000000000" }] }));
  check("E5 an id that does not match its text is refused", bad.code === 2 && /does not match its text/.test(bad.out), bad.out);
  const empty = spawnSync("python3", ["-I", REFUSAL, "--baseline", json({ strings: [] }), refTree()], { encoding: "utf8" });
  check("E5 an emptied pin list is refused (O4)", empty.status === 2 && /an emptied list is not a pass/.test(empty.stderr), empty.stderr);
}

// ------------------------------------------------------------------ F
console.log("F  lexer stress (R9)");
const S = "Computer use is not supported on Wayland";
const STRESS = {
  regex_after_if_quote: `if(a)/["']/.test(b);var s="${S}";`,
  regex_after_if_backtick: "if(a)/`/.test(b);var s=\"" + S + "\";var t=`x`;",
  regex_after_if_quote_pair: `if(a)/"/.test(b);var s="${S}";if(c)/"/.test(d);`,
  keyword_property_division: `var a=x.return/2,s="${S}",z=y/3;`,
  postfix_increment_division: `var i=0,a=i++/2,s="${S}";var t="x/";`,
  regex_after_while: `while(a)/'/.test(b)&&a--;var s="${S}";`,
  call_paren_division: `var a=f(b)/2,s="${S}",c=g(d)/3;`,
};
for (const [name, body] of Object.entries(STRESS)) {
  const dir = join(TMP, "s" + (n++));
  const build = join(dir, ".vite", "build");
  mkdirSync(build, { recursive: true });
  writeFileSync(join(build, "index.js"), '"use strict";');
  writeFileSync(join(build, "index.chunk-s.js"), body);
  const r = refusal(dir, json({ strings: [] }), ["--list"]);
  check(`F ${name}: the string after the trap is read exactly`, r.code === 1 && r.out.includes(key(S) + "  NEW         " + S), r.out);
}

// ------------------------------------------------------------------ H
console.log("H  determinism (hash seed independence)");
{
  const strip = (o) => o.replace(/\(\d+\.\d+s\)/g, "");
  const runSeed = (script, args, seed) => strip(spawnSync("python3", ["-I", script, ...args],
    { encoding: "utf8", env: { ...process.env, PYTHONHASHSEED: String(seed) } }).stdout || "");
  const dir = tree({ "index.chunk-x.js": H + 'var Z=!b.EF();function f(){if(!Z)throw Error("Teach mode is off on Wayland")}',
    "index.chunk-guard.js": guardChunk(GUARD), "index.chunk-lazy.js": lazyChunk, "index.chunk-collide.js": collideChunk,
    "index.chunk-other.js": otherChunk });
  const pargs = ["--fixture", "--js-dir", "", "--patches-dir", "", "--baseline", base(), dir];
  const outs = [0, 1, 2, 3].map((seed) => runSeed(PRED, pargs, seed));
  check("H1 predicate census output identical under 4 hash seeds (fixture)", outs.every((o) => o === outs[0]) && outs[0].length > 100, outs[0]);
  const rargs = ["--fixture", "--js-dir", EMPTY, "--list", "--baseline", json({ strings: [] }), refTree()];
  const routs = [0, 1, 2].map((seed) => runSeed(REFUSAL, rargs, seed));
  check("H1 refusal census output identical under 3 hash seeds (fixture)", routs.every((o) => o === routs[0]) && routs[0].length > 50, routs[0]);
  // CENSUS_TREE=<patched app.asar.contents> also checks the real bundle (slow: ~4 s per run)
  if (process.env.CENSUS_TREE) {
    const real = [0, 1, 2].map((seed) => runSeed(PRED, [process.env.CENSUS_TREE], seed));
    check("H2 predicate census output identical under 3 hash seeds (real tree)", real.every((o) => o === real[0]), real[0].slice(0, 400));
    const rreal = [0, 1].map((seed) => runSeed(REFUSAL, ["--list", process.env.CENSUS_TREE], seed));
    check("H2 refusal census output identical under 2 hash seeds (real tree)", rreal.every((o) => o === rreal[0]));
  }
}

// ------------------------------------------------------------------ G
console.log("G  real baselines");
{
  const pc = JSON.parse(readFileSync(join(ROOT, "baseline", "predicate-consumers.json"), "utf8"));
  const ids = new Set(pc.predicates.map((p) => p.id));
  check("G1 the required predicate set is present",
    ["isWaylandSession", "isOzoneWayland", "desktopEnvironment", "isBridgeComputerUsePlatform", "hasComputerUseExecutor", "isCuSupportedPlatform", "isComputerUseEnabled"].every((k) => ids.has(k)));
  check("G1 every allowlist entry is well formed (open entries name an issue)",
    pc.allowlist.every((e) => ids.has(e.predicate) && ("anchor" in e) !== ("anchorRegex" in e) &&
      Number.isInteger(e.consumers) && e.consumers > 0 && ["intentional", "upstream-ok", "open"].includes(e.verdict) &&
      typeof e.reason === "string" && e.reason.length > 10 && (e.verdict !== "open" || e.issue)));
  check("G1 every coveredSites entry pins one @@ and a reason",
    (pc.coveredSites || []).every((e) => ids.has(e.predicate) && e.shape.split("@@").length === 2 && e.reason.length > 10));
  check("G1 consumers fixed in our code are not allowlisted (device bridge, app icons, suffix, per-app access, Escape, teach getter)",
    !pc.allowlist.some((e) => /device bridge|On this system \(a Linux Wayland|A Wayland session shares the whole screen|\[cu-esc\]|getAppIcon|teachModeEnabled|getChicagoTeachModeEnabled/.test((e.anchor || e.anchorRegex) + (e.via || ""))));
  const rs = JSON.parse(readFileSync(join(ROOT, "baseline", "refusal-strings.json"), "utf8"));
  check("G2 every refusal pin: id matches text, known status, site count, reason",
    rs.strings.every((e) => key(e.text) === e.id && ["neutralised", "unreachable", "accepted"].includes(e.status) &&
      Number.isInteger(e.sites) && e.sites > 0 && e.reason.length > 10));
  check("G2 every neutralised pin names its verifying injection",
    rs.strings.filter((e) => e.status === "neutralised").every((e) => e.verify && e.verify.regex && Number.isInteger(e.verify.count)));
  check("G2 the #323 string is pinned neutralised with a verify",
    rs.strings.some((e) => e.text.startsWith("Computer use over the device bridge is not supported on this platform") && e.status === "neutralised" && e.verify));
}

console.log("");
console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
process.exit(0);
