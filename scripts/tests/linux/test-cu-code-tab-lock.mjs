#!/usr/bin/env node
// The Code tab and local Cowork take upstream's Computer Use lock.
//
// WHY THIS EXISTS
// ---------------
// On X11, wlroots and GNOME the Code tab and local Cowork reach Computer Use
// through our Linux block at the top of upstream's handleToolCall
// (js/cu_handler_injection.js, sub-patch 6). It answers every tool from our
// executor and returns before upstream's dispatcher, which is where upstream
// checks and takes the exclusive Computer Use lock. So those sessions never
// took the lock: no lock change, so no Escape stop key (upstream's X11 grab or
// our watcher), no glow, no side panel, no GNOME portal session per lock, no
// Stop sharing abort, and a Code-tab turn could drive the desktop while a cloud
// session held the lock. A harness that only fired our own lock hook missed it.
//
// This harness drives the REAL patched handleToolCall (the injected block in
// upstream's tool object, cut from the bundle the compiled patches produced)
// against upstream's REAL lock object (with sub-patches 4b / 4b.2), upstream's
// REAL Code-tab and local-Cowork lock functions, upstream's REAL turn-end
// release, upstream's REAL Escape register / unregister / abort functions
// (with the community patch's 17a / 17b), upstream's REAL Escape stop handler
// and our real js/cu_share_stop.js, and pins:
//   [B] the upstream shapes the block mirrors: the dispatcher's lock branch,
//       its exempt / app-scoped / read-only-batch predicates (evaluated from the
//       bundle and compared with the block's behaviour over every tool name),
//       both refusal texts, the session pass-through, the Code-tab and Cowork
//       lock functions, the turn-end releases, the Escape stop handler.
//   [1] an action tool with no holder acquires once; cuLockChanged carries the
//       local_ id; __setLockHeld(true, id) runs; the executor's lock hook has
//       settled before the action; switch ON: __cdbCuEscWatch.arm gets the
//       holder; switch OFF: upstream's globalShortcut.register("Escape") runs.
//   [2] exempt tools and a read-only batch never acquire.
//   [3] a foreign holder gets upstream's cu_lock_held text; the executor is
//       not called.
//   [4] upstream's turn-end release emits the unlock; __setLockHeld(false);
//       the watcher disarms / the grab is dropped; nothing stays armed.
//   [5] a session with no Computer Use call never acquires.
//   [6] a batch acquires once; a stopped turn ends the batch.
//   [7] kwin mode: the block is skipped, upstream's dispatcher runs.
//   [8] a context without lock functions behaves as before.
//   [9] Escape for a local_ holder reaches the Code-tab manager's stopSession.
//  [10] GNOME Stop sharing (__cdbCuShareStop.fire) stops a local_ holder.
//
// CDB_BUNDLE_DIR points at another extract; CDB_CU_PATCH_BIN / CDB_ESC_PATCH_BIN
// at other compiled patches; CU_HANDLER_JS at another injection source (the
// texts it pins). Needs the extract and both binaries, else SKIP (exit 3).
// No child process is left behind (only the two patch binaries run, with
// spawnSync); the temp dir is removed on exit and on signals.
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, rmSync, accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const nodeRequire = createRequire(import.meta.url);
const SKIP_EXIT = 3;
const CU_BIN = process.env.CDB_CU_PATCH_BIN || join(repo, "patches", "linux", "fix_computer_use_linux");
const ESC_BIN = process.env.CDB_ESC_PATCH_BIN || join(repo, "patches", "community", "add_feature_cu_escape_abort");
const HANDLER_JS = process.env.CU_HANDLER_JS || join(repo, "js", "cu_handler_injection.js");
const SHARE_JS = join(repo, "js", "cu_share_stop.js");
const BUILD_DIR = join(process.env.CDB_BUNDLE_DIR || join(repo, "tmp", "app.asar.contents"), ".vite", "build");

let pass = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  PASS " + label + (extra !== undefined ? "  -> " + extra : "")); }
  else { failures.push(label); console.log("  FAIL " + label + (extra !== undefined ? "  -> " + extra : "")); }
}
const J = JSON.stringify;
const esc = (s) => s.replace(/[$]/g, "\\$");
const countRe = (hay, re) => (hay.match(new RegExp(re.source, "g")) || []).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let scratch = null;
function cleanup() { if (scratch) { try { rmSync(scratch, { recursive: true, force: true }); } catch {} scratch = null; } }
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { cleanup(); process.exit(130); });

function finish() {
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED:\n  - " + failures.join("\n  - ")); process.exit(1); }
  process.exit(0);
}

// ── prerequisites ──────────────────────────────────────────────────────────
for (const [bin, what] of [[CU_BIN, "fix_computer_use_linux"], [ESC_BIN, "add_feature_cu_escape_abort"]]) {
  try { accessSync(bin, constants.X_OK); } catch { console.log(`SKIP: ${what} is not compiled (cd patches && make)`); process.exit(SKIP_EXIT); }
}
if (!existsSync(join(BUILD_DIR, "index.js"))) { console.log("SKIP: no extract under tmp/app.asar.contents/ (set CDB_BUNDLE_DIR)"); process.exit(SKIP_EXIT); }

// ── the bundle, staged and patched like the orchestrator does ──────────────
const SPLIT_RE = /\n\/\*__CDB_SPLIT__([^*\n]+?)__\*\/\n/;
function splitParts(blob) {
  const pieces = blob.split(SPLIT_RE);
  const names = ["index.js"], bodies = [pieces[0]];
  for (let i = 1; i < pieces.length; i += 2) { names.push(pieces[i]); bodies.push(pieces[i + 1]); }
  return { names, bodies };
}
const chunks = readdirSync(BUILD_DIR).filter((d) => /^index.*\.chunk-.*\.js$/.test(d)).sort();
let pristine = readFileSync(join(BUILD_DIR, "index.js"), "utf8");
for (const c of chunks) pristine += "\n/*__CDB_SPLIT__" + c + "__*/\n" + readFileSync(join(BUILD_DIR, c), "utf8");
scratch = mkdtempSync(join(tmpdir(), "cdb-cu-code-tab-lock-"));
const staged = join(scratch, "staged_index.js");
writeFileSync(staged, pristine);
console.log("\n[P] both patches on the staged bundle (community first, basename order)");
const r0 = spawnSync(ESC_BIN, [staged], { encoding: "utf8", maxBuffer: 64 << 20 });
ok(r0.status === 0 && /\[PASS\]/.test(r0.stdout || ""), "add_feature_cu_escape_abort applies", r0.status);
const r1 = spawnSync(CU_BIN, [staged], { encoding: "utf8", maxBuffer: 64 << 20 });
ok(r1.status === 0 && /\[PASS\] \d+\/\d+ sub-patches applied/.test(r1.stdout || ""), "fix_computer_use_linux applies", r1.status + " " + String(r1.stdout || "").split("\n").filter((l) => /FAIL/.test(l)).slice(0, 2).join(" | "));
if (r0.status !== 0 || r1.status !== 0) finish();
const patched = readFileSync(staged, "utf8");
const P = splitParts(pristine), Q = splitParts(patched);
const partOf = (parts, pred) => { const i = parts.bodies.findIndex(pred); return i < 0 ? null : { name: parts.names[i], body: parts.bodies[i] }; };

// Brace-balanced slice from the `{` at `open` (strings / templates / regex
// literals in the code cut here hold balanced braces).
function braceEnd(src, open) {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const ch = src[j];
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return j + 1;
  }
  return -1;
}
function fnSrc(body, name) {
  const m = new RegExp("(?<![\\w$.])function " + esc(name) + "\\(").exec(body);
  if (!m) return null;
  const end = braceEnd(body, body.indexOf("{", m.index));
  return end < 0 ? null : body.slice(m.index, end);
}
function strConst(body, name) {
  const m = new RegExp("(?<![\\w$.])" + esc(name) + "=(\"(?:[^\"\\\\]|\\\\.)*\")").exec(body);
  return m ? JSON.parse(m[1]) : undefined;
}

// Free names: a `with` scope over a map, every other unknown name a callable
// stub (returns undefined; any property is another stub). Real globals resolve
// normally.
function stub() {
  const f = function () { return undefined; };
  return new Proxy(f, { get(t, k) { if (typeof k === "symbol" || k === "then") return undefined; return stub(); }, apply() { return undefined; } });
}
function scope(map) {
  return new Proxy(map, {
    has(t, k) { if (typeof k === "symbol") return false; return k in t || !(k in globalThis); },
    get(t, k) { if (typeof k === "symbol") return undefined; return k in t ? t[k] : stub(); },
    set(t, k, v) { t[k] = v; return true; },
  });
}
// An object whose other properties are stubs.
function partial(obj) { return new Proxy(obj, { get(t, k) { if (typeof k === "symbol") return t[k]; return k in t ? t[k] : stub(); } }); }
function evalIn(map, code) { return new Function("__s", "with(__s){return(" + code + ")}")(scope(map)); }
function runIn(map, code) { return new Function("__s", "with(__s){" + code + "}")(scope(map)); }

// ── the block's pinned texts ────────────────────────────────────────────────
const handlerSrc = readFileSync(HANDLER_JS, "utf8");
const OUR_HELD = (/var __LK_HELD=("(?:[^"\\]|\\.)*")/.exec(handlerSrc) || [])[1];
const OUR_LOST = (/var __LK_LOST=("(?:[^"\\]|\\.)*")/.exec(handlerSrc) || [])[1];

// ── [B] upstream's shapes ──────────────────────────────────────────────────
console.log("\n[B] upstream's dispatcher, session context and lock users (pristine bundle)");
const LOCK_BRANCH_RE = /else if\(([\w$]+)\.checkCuLock\)\{let ([\w$]+)=await\(\1\.checkExclusiveLock\?\.\(\)\?\?\1\.checkCuLock\(\)\);if\(\2\.holder!==void 0&&!\2\.isSelf\)return\{content:\[\{type:"text",text:\1\.formatLockHeldMessage\?\.\(\2\.holder\)\?\?([\w$]+)\}\],isError:!0,telemetry:\{error_kind:"cu_lock_held"\}\}/;
const APP_BRANCH_RE = /if\(([\w$]+)\(([\w$]+)\)&&([\w$]+)\.checkCuLock\)\{let ([\w$]+)=await\(\3\.checkExclusiveLock\?\.\(\)\?\?\3\.checkCuLock\(\)\);if\(\2!=="app_release"&&\4\.holder!==void 0&&!\4\.isSelf\)return\{content:\[\{type:"text",text:\3\.formatLockHeldMessage\?\.\(\4\.holder\)\?\?([\w$]+)\}\],isError:!0,telemetry:\{error_kind:"cu_lock_held"\}\}/;
const EXEMPT_RE = /let ([\w$]+)=([\w$]+)\(([\w$]+),([\w$]+)\),([\w$]+)=([\w$]+)\(\3\)\|\|\3==="wait"\|\|\3==="switch_display"\|\|\1,/;
const ACQUIRE_RE = /if\(([\w$]+)\)\{await\(([\w$]+)\.acquireCuLock\?\.\(\)\);let ([\w$]+)=await \2\.checkCuLock\(\);if\(!\3\.isSelf\)return [\w$]+\(\{content:\[\{type:"text",text:\(\3\.holder===void 0\?void 0:\2\.formatLockHeldMessage\?\.\(\3\.holder\)\)\?\?([\w$]+)\}\],isError:!0,telemetry:\{error_kind:"cu_lock_held"\}\},[\w$]+,"lock_lost"\)/;
const disp = partOf(P, (b) => LOCK_BRANCH_RE.test(b));
ok(!!disp && countRe(disp.body, LOCK_BRANCH_RE) === 1, "the dispatcher's lock branch, once: checkExclusiveLock ?? checkCuLock, foreign holder -> cu_lock_held", disp && disp.name);
const up = { free: null, app: null, roBatch: null, lost: undefined };
if (disp) {
  const lb = LOCK_BRANCH_RE.exec(disp.body), ab = APP_BRANCH_RE.exec(disp.body), ex = EXEMPT_RE.exec(disp.body), aq = ACQUIRE_RE.exec(disp.body);
  ok(!!ab && countRe(disp.body, APP_BRANCH_RE) === 1, "its app-scoped branch, once: no acquire, foreign holder -> cu_lock_held (app_release excepted)", ab && ab[1]);
  ok(!!ex, "its exempt set: Di(tool) || wait || switch_display || read-only batch", ex && ex[6] + " / " + ex[2]);
  ok(!!aq, "it acquires through acquireCuLock, then checkCuLock().isSelf, else lock_lost");
  ok(!!ex && new RegExp("let ([\\w$]+)=" + esc(lb[2]) + "\\.holder===void 0&&!" + esc(ex[5]) + ";").test(disp.body), "it acquires only with no holder and a tool that is not exempt");
  up.lost = strConst(disp.body, lb[3]);
  ok(aq && aq[4] === lb[3], "the lock_lost fallback is the same text as the branch's", aq && aq[4]);
  if (ex) {
    const diSrc = fnSrc(disp.body, ex[6]), riSrc = fnSrc(disp.body, ex[2]);
    const li = riSrc && /\.every\(\(?\(?([\w$]+)\)?=>([\w$]+)\(\1\.action\)\)?\)/.exec(riSrc);
    const oo = riSrc && /&&([\w$]+)\([\w$]+\)===void 0&&/.exec(riSrc);
    const ooSrc = oo && fnSrc(disp.body, oo[1]);
    const roName = ooSrc && /if\(!([\w$]+)\.has\([\w$]+\)\)return/.exec(ooSrc);
    const roDecl = roName && new RegExp("(?<![\\w$.])" + esc(roName[1]) + "=new Set\\(\\[[^\\]]*\\]\\)").exec(disp.body);
    const mk = (src, name) => evalIn({}, "(function(){" + src + ";return " + name + "})()");
    try {
      up.free = mk(diSrc, ex[6]);
      // The validator's error helper (its minified name changes between releases).
      const errFn = (/return ([\w$]+)\("actions must be a non-empty array"/.exec(ooSrc) || [])[1];
      ok(!!errFn, "the batch validator's error helper found", errFn);
      const errDecl = "var " + errFn + "=function(t){return{content:[{type:'text',text:t}],isError:!0}};";
      up.roBatch = evalIn({}, "(function(){var " + (roDecl ? roDecl[0] : "") + ";" + errDecl + fnSrc(disp.body, li[2]) + ooSrc + riSrc + ";return " + ex[2] + "})()");
      up.batchValid = evalIn({}, "(function(){var " + (roDecl ? roDecl[0] : "") + ";" + errDecl + ooSrc + ";return function(a){return " + oo[1] + "(a)===void 0}})()");
    } catch (e) { ok(false, "upstream's exempt / read-only-batch predicates evaluate", e.message); }
    ok(typeof up.free === "function" && typeof up.roBatch === "function", "upstream's exempt and read-only-batch predicates evaluated from the bundle", ex[6] + " / " + ex[2]);
  }
  if (ab) {
    const uiSrc = fnSrc(disp.body, ab[1]);
    const xn = uiSrc && /Object\.hasOwn\(([\w$]+),[\w$]+\)/.exec(uiSrc);
    const xnDecl = xn && new RegExp("(?<![\\w$.])" + esc(xn[1]) + "=\\{[^{}]*\\}").exec(disp.body);
    try { up.app = evalIn({}, "(function(){var " + xnDecl[0] + ";" + uiSrc + ";return " + ab[1] + "})()"); up.appKeys = Object.keys(evalIn({}, "(function(){var " + xnDecl[0] + ";return " + xn[1] + "})()")); } catch (e) { ok(false, "upstream's app-scoped predicate evaluates", e.message); }
    ok(typeof up.app === "function", "upstream's app-scoped predicate evaluated from the bundle", up.appKeys && up.appKeys.length + " app_* tools");
  }
}
ok(up.lost !== undefined && up.lost === (OUR_LOST && JSON.parse(OUR_LOST)), "the block's lock_lost text is upstream's dispatcher fallback, byte for byte", up.lost && up.lost.slice(0, 60));
// The tool object's own session context (the chunk holding handleToolCall).
// The tool object as sub-patch 6 anchors it.
const HTC_RE = /(([\w$]+)=\{[^{}]{0,80}isEnabled:[\w$]+=>(?:[\w$]+\.sessionType===["`]ccd["`]\?[\w$]+(?:\.[\w$]+)?\((?:\{[\w$]+:![01]\})?\)(?:&&![\w$]+\.[\w$]+)?:[\w$]+(?:\.[\w$]+)?\((?:\{[\w$]+:![01]\})?\)|[\w$]+\(\)),handleToolCall:async\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)\)=>\{)/;
const tool = partOf(P, (b) => HTC_RE.test(b) && b.includes("formatLockHeldMessage:"));
let upHeld;
if (tool) {
  const fm = /formatLockHeldMessage:\(\)=>([\w$]+)[,}]/.exec(tool.body);
  ok(countRe(tool.body, /formatLockHeldMessage:\(\)=>[\w$]+[,}]/) === 1, "the tool object's session context formats the lock refusal with one constant", fm && fm[1]);
  upHeld = fm && strConst(tool.body, fm[1]);
  ok(/checkCuLock:([\w$]+)\.checkCuLock\?async\(\)=>\1\.checkCuLock\(\):void 0,checkExclusiveLock:\1\.checkCuExclusiveLock\?async\(\)=>\1\.checkCuExclusiveLock\(\):void 0,acquireCuLock:\1\.acquireCuLock\?async\(\)=>\{[\w$]+\.[\w$]+\("cu_lock",\1\.sessionId\)\|\|\1\.acquireCuLock\(\)\}:void 0/.test(tool.body),
    "that context maps the session's checkCuLock / checkCuExclusiveLock / acquireCuLock (absent -> no lock; acquire refused only under the HIPAA gate, which the block refuses earlier)");
  ok(countRe(tool.body, /checkCuLock:([\w$]+)\.checkCuLock,checkCuExclusiveLock:\1\.checkCuExclusiveLock,acquireCuLock:\1\.acquireCuLock,/) === 1, "the internal MCP session hands the host session's lock functions through");
  ok(/isAborted:([\w$]+)\.isAborted,/.test(tool.body), "and its isAborted");
} else ok(false, "the chunk holding handleToolCall and its session context");
ok(upHeld !== undefined && upHeld === (OUR_HELD && JSON.parse(OUR_HELD)), "the block's cu_lock_held text is the one upstream gives these sessions, byte for byte", upHeld && upHeld.slice(0, 60));
// The Code tab (local_ ids) and local Cowork lock functions, and their releases.
const CODE_LOCK_RE = /checkCuLock:\(\)=>([\w$]+)\.([\w$]+)\.check\(([\w$]+)\),checkCuExclusiveLock:\(\)=>\(\{holder:\1\.\2\.currentHolder,isSelf:\1\.\2\.currentHolder===\3\}\),acquireCuLock:\(\)=>\1\.\2\.acquire\(\3\),/;
const COWORK_LOCK_RE = /checkCuLock:\(\)=>([\w$]+)\.([\w$]+)\.check\(([\w$]+)\),checkCuExclusiveLock:\(\)=>\(\{holder:\1\.\2\.currentHolder,isSelf:\1\.\2\.currentHolder===\3\}\),acquireCuLock:\(\)=>\{if\(!\1\.\2\.acquire\(\3\)\)return;let ([\w$]+)=([\w$]+)\.getActiveSession\(\3\);\4&&\(\4\.cuLockAcquiredAt=Date\.now\(\)\),\1\.([\w$]+)\("cu_lock_acquired",\{session_id:\3,session_type:"cowork"\}\)\},/;
const codePart = partOf(P, (b) => /releaseTurnScopedState\([\w$]+\)\{/.test(b) && CODE_LOCK_RE.test(b));
const coworkPart = partOf(P, (b) => COWORK_LOCK_RE.test(b));
ok(!!codePart, "the Code tab's session: checkCuLock / checkCuExclusiveLock / acquireCuLock on upstream's lock", codePart && codePart.name);
ok(!!coworkPart, "local Cowork's session: the same, acquire records cu_lock_acquired", coworkPart && coworkPart.name);
const RTS_RE = /releaseTurnScopedState\(([\w$]+)\)\{this\.markTrackerStaleIfNoAdvance\(\1\),([\w$]+)\.([\w$]+)\.release\(\1\.sessionId\),/;
ok(!!codePart && RTS_RE.test(codePart.body), "Code tab: releaseTurnScopedState releases the lock first");
ok(!!codePart && /markNotRunning\(([\w$]+)\)\{let [\w$]+=\1\.isRunning;\1\.isRunning=!1,[^}]*this\.releaseTurnScopedState\(\1\)/.test(codePart.body), "Code tab: markNotRunning (every turn end: result, interrupt, process end, stop) calls it");
ok(!!codePart && /async stopSession\(([\w$]+),[\w$]+="user",[\w$]+\)\{[\s\S]{0,300}?this\.teardownSession\(\1,/.test(codePart.body), "Code tab: stopSession tears the session down");
ok(!!coworkPart && /\.[\w$]+\.release\(([\w$]+)\.sessionId\),this\.permissionRouter\.denyPendingPermissionsForSession\(\1\.sessionId,"Turn ended","turn_completed"\)/.test(coworkPart.body), "local Cowork: turn completion releases the lock");
// The Escape stop handler upstream passes to its Escape and Stop sharing aborts.
const STOP_RE = /let ([\w$]+)=([\w$]+)=>\{([\w$]+)\(\)\?\.stopSession\(\2\),([\w$]+)\(\)\?\.stopSession\(\2\),([\w$]+)\(\2,"esc"\);/;
const stopPart = partOf(Q, (b) => STOP_RE.test(b));
const sm = stopPart && STOP_RE.exec(stopPart.body);
ok(!!sm && countRe(stopPart.body, STOP_RE) === 1, "the Escape stop handler stops the id in both session managers", sm && sm[3] + "() / " + sm[4] + "()");
const codeMgrName = stopPart && /peekClaudeCodeSessionManager:\(\)=>([\w$]+)[,}]/.exec(stopPart.body);
ok(!!sm && !!codeMgrName && (codeMgrName[1] === sm[4] || codeMgrName[1] === sm[3]), "one of them is the Code-tab session manager accessor", codeMgrName && codeMgrName[1]);

// ── the patched pieces, loaded ─────────────────────────────────────────────
// Upstream's lock instance (with 4b / 4b.2), from the patched bundle.
const lockPart = partOf(Q, (b) => b.includes("get currentHolder(){return this.exclusiveHolder}") && b.includes("__setLockHeld?.(!0,"));
let LockClass = null;
if (lockPart) {
  const at = lockPart.body.indexOf("get currentHolder(){return this.exclusiveHolder}");
  const start = lockPart.body.lastIndexOf("=new class extends ", at);
  const open = lockPart.body.indexOf("{", start);
  const end = braceEnd(lockPart.body, open);
  const head = /=new class extends ([\w$]+)\.EventEmitter\{/.exec(lockPart.body.slice(start, open + 1));
  const cls = lockPart.body.slice(start + "=new ".length, end);
  const rnd = /\(0,([\w$]+)\.randomInt\)/.exec(cls);
  const map = {};
  if (head) map[head[1]] = nodeRequire("node:events");
  if (rnd) map[rnd[1]] = nodeRequire("node:crypto");
  try { LockClass = evalIn(map, cls); } catch (e) { ok(false, "upstream's lock class evaluates", e.message); }
}
ok(typeof LockClass === "function", "upstream's lock class (patched with 4b / 4b.2) loaded");

// Upstream's Escape functions (patched with 17a / 17b / 17c), as the escape harness cuts them.
const M_ARM = /function ([\w$]+)\(\)\{if\(process\.platform==="linux"&&globalThis\.__cdbCuEscapeAbortEnabled\?\.\(\)===true&&globalThis\.__cdbCuEscWatch\?\.arm\(([\w$]+),([\w$]+)\.currentHolder,\1\)===true\)\{if\(([\w$]+)\)\{([\w$]+)\.globalShortcut\.unregister\("Escape"\);\4=!1;([\w$]+)=0\}return\}process\.platform==="linux"&&globalThis\.__cdbCuEscapeAbortEnabled\?\.\(\)!==true&&globalThis\.__cdbCuEscWatch\?\.disarm\("switch off"\);if\(!\(\4\|\|([\w$]+)\(\)\)\)\{\6=0;/;
const M_DISARM = /function ([\w$]+)\(\)\{process\.platform==="linux"&&globalThis\.__cdbCuEscWatch\?\.disarm\(\);[\w$]+&&\([\w$]+\.globalShortcut\.unregister\(/;
const M_SHARE = /\}process\.platform==="linux"&&\(globalThis\.__cdbCuShareEnded=([\w$]+)\);/;
function escapeRig(lock, opts) {
  const a = M_ARM.exec(patched), d = M_DISARM.exec(patched), s = M_SHARE.exec(patched);
  if (!a || !d || !s) return null;
  const [, regName, handler, lockName, pJ, u, mJ, WO] = a;
  const unreg = d[1];
  const lcm = new RegExp("function ([\\w$]+)\\(\\)\\{" + esc(lockName) + "\\.currentHolder&&([\\w$]+)===0\\?" + esc(regName) + "\\(\\):" + esc(unreg) + "\\(\\)\\}").exec(patched);
  const [, lc, yi] = lcm;
  const im = new RegExp("function ([\\w$]+)\\(([\\w$]+)\\)\\{([\\w$]+)=\\2," + esc(lockName) + "\\.on\\([\"'`]cuLockChanged[\"'`]," + esc(lc) + "\\)").exec(patched);
  const [, init, , fJ] = im;
  const share = s[1];
  const shareDecl = new RegExp("function " + esc(share) + "\\(\\)\\{[^{}]*\\}process\\.platform===\"linux\"&&\\(globalThis\\.__cdbCuShareEnded=" + esc(share) + "\\);").exec(patched)[0];
  const abiName = new RegExp("function " + esc(share) + "\\(\\)\\{" + esc(fJ) + "&&([\\w$]+)\\(").exec(patched)[1];
  const hSrc = fnSrc(patched, handler);
  const ibiName = /return\}([\w$]+)\(\)\}$/.exec(hSrc)[1];
  const logName = /([\w$]+)\.debug\(/.exec(hSrc)[1];
  const calls = [], logs = [];
  const map = {};
  map[u] = { globalShortcut: { register: (k, f) => { calls.push(["register", k, f]); return opts.regOk ? opts.regOk() : true; }, unregister: (k) => calls.push(["unregister", k]) } };
  map[WO] = () => !!opts.wayland;
  map[lockName] = lock;
  const rec = (lvl) => (...m) => logs.push(lvl + " " + m.join(" "));
  map[logName] = { debug: rec("debug"), info: rec("info"), warn: rec("warn"), error: rec("error") };
  // 17h: the statement right after the lock-change function (absent before 17h).
  const lcSrc = fnSrc(patched, lc), lcAt = patched.indexOf(lcSrc) + lcSrc.length;
  const grabDecl = (/^process\.platform==="linux"&&\(globalThis\.__cdbCuEscGrab=\{[\s\S]*?\}\}\);/.exec(patched.slice(lcAt, lcAt + 3000)) || [""])[0];
  const src = `var ${fJ},${pJ}=!1,${yi}=0,${mJ}=0;` + hSrc + fnSrc(patched, ibiName) + fnSrc(patched, abiName) + shareDecl +
    fnSrc(patched, regName) + fnSrc(patched, unreg) + fnSrc(patched, lc) + grabDecl + fnSrc(patched, init) +
    `;return{handler:${handler},init:${init},share:${share},registered:function(){return ${pJ}}};`;
  const t = runIn(map, src);
  return { t, calls, logs, names: { regName, unreg, handler } };
}

// Upstream's Escape stop handler, with recording session managers.
function stopHandler(mgrs) {
  const m = STOP_RE.exec(stopPart.body);
  const at = m.index + m[0].indexOf(m[2] + "=>{");
  const end = braceEnd(stopPart.body, stopPart.body.indexOf("{", at));
  const src = stopPart.body.slice(at, end);
  const map = {};
  map[m[3]] = () => (m[3] === codeMgrName[1] ? mgrs.code : mgrs.cowork);
  map[m[4]] = () => (m[4] === codeMgrName[1] ? mgrs.code : mgrs.cowork);
  return evalIn(map, src);
}

// The patched tool object (handleToolCall with our block).
const toolQ = partOf(Q, (b) => HTC_RE.test(b) && b.includes("__cdbLx:{"));
let toolSrc = null, toolName = null, dispName = null;
if (toolQ) {
  const hm = HTC_RE.exec(toolQ.body);
  const start = hm.index + hm[1].indexOf("=") + 1;
  const end = braceEnd(toolQ.body, start);
  toolSrc = toolQ.body.slice(start, end);
  toolName = hm[2];
  const dm = /([\w$]+)\.dispatch\?\?=([\w$]+)\(/.exec(toolSrc);
  dispName = dm && dm[2];
}
ok(!!toolSrc && toolSrc.includes("__cdbLx:{") && !!dispName, "the patched handleToolCall (our block at its top) cut from the bundle", toolQ && toolQ.name);

// Upstream's turn-end release (Code tab).
let rtsSrc = null, rtsNs = null, rtsLock = null;
if (codePart) {
  const m = RTS_RE.exec(codePart.body);
  const at = codePart.body.indexOf("releaseTurnScopedState(" + m[1] + "){");
  rtsSrc = "function(" + m[1] + ")" + codePart.body.slice(at + ("releaseTurnScopedState(" + m[1] + ")").length, braceEnd(codePart.body, codePart.body.indexOf("{", at)));
  rtsNs = m[2]; rtsLock = m[3];
}

if (!LockClass || !toolSrc || !rtsSrc || !stopPart || !M_ARM.test(patched)) { ok(false, "every piece loaded (lock, tool object, turn-end release, Escape functions, stop handler)"); finish(); }

// ── a world: one lock, upstream's Escape rig, a fake executor, sessions ────
const CU_KEYS = ["__linuxExecutor", "__cdbDiag", "__cdbCuConsent", "__cdbCuEscapeAbortEnabled", "__cdbCuEscWatch", "__cuKwinMode", "__cdbCuShareEnded", "__cdbCuShareStop", "__cdbCuHipaa", "__cdbAxHandles", "__cuActiveOrigin", "__cuLastShot", "__cuPinnedDisplay", "__cuMouseHeld", "__cdbCuBatchSubs"];
function world(opts = {}) {
  for (const k of CU_KEYS) delete globalThis[k];
  const lock = new LockClass();
  const events = [];
  lock.on("cuLockChanged", ({ holder }) => events.push(holder));
  const diag = [];
  globalThis.__cdbDiag = (m) => diag.push(String(m));
  const sw = { on: !!opts.switchOn };
  globalThis.__cdbCuEscapeAbortEnabled = () => sw.on;
  const watch = [];
  globalThis.__cdbCuEscWatch = { arm: (h, holder, reg) => { watch.push(["arm", holder]); return true; }, disarm: (w) => watch.push(["disarm", w]) };
  const exec = [], hook = [];
  let settled = true;
  const ex = {
    __setLockHeld(held, holder) { hook.push([held, holder]); settled = false; return new Promise((r) => setTimeout(() => { settled = true; r(); }, 20)); },
    __lockSettled() { return new Promise((r) => { const t = () => (settled ? r() : setTimeout(t, 2)); t(); }); },
    __targetActive: () => true,
    listDisplays: async () => [{ displayId: 0, isPrimary: true, width: 100, height: 80, originX: 0, originY: 0, label: "d0" }],
    screenshot: async () => { exec.push(["screenshot", settled]); return { base64: "AA==", imgW: 100, imgH: 80, displayWidth: 100, displayHeight: 80, originX: 0, originY: 0 }; },
    zoom: async () => { exec.push(["zoom", settled]); return { base64: "AA==" }; },
    click: async (x, y, b, n) => { exec.push(["click", settled]); },
    key: async () => { exec.push(["key", settled]); },
    type: async () => { exec.push(["type", settled]); },
    getCursorPosition: async () => { exec.push(["cursor", settled]); return { x: 1, y: 1 }; },
    moveMouse: async () => { exec.push(["move", settled]); },
    scroll: async () => { exec.push(["scroll", settled]); },
    mouseDown: async () => { exec.push(["down", settled]); },
    mouseUp: async () => { exec.push(["up", settled]); },
    openApp: async () => { exec.push(["open", settled]); return { action: "opened" }; },
    readClipboard: async () => { exec.push(["readcb", settled]); return "x"; },
    writeClipboard: async () => { exec.push(["writecb", settled]); },
  };
  globalThis.__linuxExecutor = ex;
  if (opts.kwin) globalThis.__cuKwinMode = true;
  const rig = escapeRig(lock, { wayland: !!opts.wayland, regOk: opts.regOk });
  const stops = [];
  const mgr = (kind) => ({ stopSession: (id) => { stops.push([kind, id]); if (kind === "code" && codeSessions.has(id)) turnEnd(codeSessions.get(id)); } });
  const codeSessions = new Map();
  rig.t.init(stopHandler({ code: mgr("code"), cowork: mgr("cowork") }));
  // Upstream's tool object; its dispatcher factory records what reaches it.
  const upCalls = [];
  const tmap = { require: (id) => (id === "electron" ? { BrowserWindow: { getAllWindows: () => opts.windows || [] } } : nodeRequire(id)) };
  tmap[dispName] = () => async (name, input) => { upCalls.push(name); return { content: [{ type: "text", text: "upstream:" + name }] }; };
  const toolObj = evalIn(tmap, toolSrc);
  tmap[toolName] = toolObj; // the batch re-enters it by its own name
  const state = () => ({ altToolModeCalls: { run: async (a, b) => ({ result: await b(), answeredByAltToolMode: false }) } });
  // Upstream's own Code-tab / Cowork session lock functions.
  const cm = CODE_LOCK_RE.exec(codePart.body), wm = COWORK_LOCK_RE.exec(coworkPart.body);
  const codeLockSrc = "({" + cm[0].slice(0, -1) + "})";
  const coworkLockSrc = "({" + wm[0].slice(0, -1) + "})";
  const telem = [];
  function codeSession(id, extra = {}) {
    const m = {}; m[cm[1]] = partial({ [cm[2]]: lock }); m[cm[3]] = id;
    const s = Object.assign({ sessionId: id, sessionType: "ccd", isAborted: () => !!s.aborted }, evalIn(m, codeLockSrc), extra);
    codeSessions.set(id, s);
    return s;
  }
  function coworkSession(id) {
    const rec = {};
    const m = {}; m[wm[1]] = partial({ [wm[2]]: lock, [wm[6]]: (n, d) => telem.push([n, d]) }); m[wm[3]] = id; m[wm[5]] = { getActiveSession: () => rec };
    return Object.assign({ sessionId: id, sessionType: "cowork", record: rec, isAborted: () => false }, evalIn(m, coworkLockSrc));
  }
  // Upstream's Code-tab turn end on that session.
  const rmap = {}; rmap[rtsNs] = partial({ [rtsLock]: lock });
  const rts = evalIn(rmap, rtsSrc);
  function turnEnd(s) { rts.call({ markTrackerStaleIfNoAdvance() {} }, s); }
  const call = (s, name, input = {}) => toolObj.handleToolCall(state(), name, input, s);
  return { lock, events, diag, sw, watch, exec, hook, rig, stops, upCalls, call, codeSession, coworkSession, turnEnd, telem, ex };
}
const isHeldText = (r) => r && r.isError === true && r.content && r.content[0] && r.content[0].text === (upHeld || "\u0000");

// ── [1] an action tool takes the lock ──────────────────────────────────────
console.log("\n[1] Code tab: the first action takes upstream's lock");
for (const on of [false, true]) {
  const w = world({ switchOn: on });
  const s = w.codeSession("local_aaa");
  const r = await w.call(s, "left_click", { coordinate: [5, 5] });
  ok(!r.isError && w.exec.some((e) => e[0] === "click"), `switch ${on ? "ON" : "OFF"}: left_click runs`, J(r.content && r.content[0]));
  ok(w.events.length === 1 && w.events[0] === "local_aaa", "  cuLockChanged once, holder local_aaa", J(w.events));
  ok(w.lock.currentHolder === "local_aaa", "  upstream's lock holder is the session");
  ok(w.hook.length === 1 && w.hook[0][0] === true && w.hook[0][1] === "local_aaa", "  4b: __setLockHeld(true, \"local_aaa\")", J(w.hook));
  ok(w.exec.find((e) => e[0] === "click")?.[1] === true, "  the executor's lock hook had settled before the click ran");
  if (on) { const arms = w.watch.filter((c) => c[0] === "arm"); ok(arms.length === 1 && arms[0][1] === "local_aaa" && w.watch[w.watch.length - 1][0] === "arm" && !w.rig.calls.some((c) => c[0] === "register"), "  switch ON: __cdbCuEscWatch.arm(…, \"local_aaa\", …), no X11 grab", J(w.watch)); }
  else ok(w.rig.calls.some((c) => c[0] === "register" && c[1] === "Escape" && c[2] === w.rig.t.handler) && w.rig.t.registered() === true && !w.watch.some((c) => c[0] === "arm"), "  switch OFF: upstream's globalShortcut.register(\"Escape\", its handler) ran", J(w.rig.calls.map((c) => c[0])));
  const r2 = await w.call(s, "key", { text: "a" });
  ok(!r2.isError && w.events.length === 1 && w.hook.length === 1, "  the next action under its own lock takes nothing again", J(w.events));
  // [4] the turn end
  if (!on) console.log("\n[4] upstream's turn end releases it");
  w.turnEnd(s);
  ok(w.events.length === 2 && w.events[1] === undefined && w.lock.currentHolder === undefined, `  switch ${on ? "ON" : "OFF"}: releaseTurnScopedState emits the unlock`, J(w.events));
  ok(w.hook.length === 2 && w.hook[1][0] === false, "  4b.2: __setLockHeld(false)", J(w.hook));
  if (on) ok(w.watch[w.watch.length - 1][0] === "disarm", "  the watcher is disarmed", J(w.watch));
  else ok(w.rig.calls.some((c) => c[0] === "unregister" && c[1] === "Escape") && w.rig.t.registered() === false, "  upstream's Escape grab is dropped", J(w.rig.calls.map((c) => c[0])));
  const r3 = await w.call(s, "screenshot", {});
  ok(!r3.isError && w.events.length === 3 && w.events[2] === "local_aaa", "  the next turn's first action takes it again", J(w.events));
  w.turnEnd(s);
  ok(w.lock.currentHolder === undefined && (on ? w.watch[w.watch.length - 1][0] === "disarm" : w.rig.t.registered() === false), "  and its turn end leaves nothing armed");
}
{
  const w = world({ wayland: true });
  const s = w.codeSession("local_wl");
  await w.call(s, "screenshot", {});
  ok(w.lock.currentHolder === "local_wl" && !w.rig.calls.some((c) => c[0] === "register"), "Wayland, switch OFF: the lock is taken, upstream registers no Escape (as everywhere on Wayland)");
}
{
  console.log("\n  local Cowork");
  const w = world();
  const s = w.coworkSession("local_cw1");
  const r = await w.call(s, "screenshot", {});
  ok(!r.isError && w.lock.currentHolder === "local_cw1" && w.events.join() === "local_cw1", "local Cowork: screenshot takes the lock through Cowork's own acquire", J(w.events));
  ok(w.telem.some((t) => t[0] === "cu_lock_acquired" && t[1].session_id === "local_cw1") && typeof s.record.cuLockAcquiredAt === "number", "  with upstream's cu_lock_acquired record and acquire time");
}

// ── [2] exempt tools and a read-only batch ─────────────────────────────────
console.log("\n[2] tools upstream exempts never take it (the block against upstream's predicates)");
const NAMES = ["screenshot", "zoom", "left_click", "right_click", "double_click", "triple_click", "middle_click", "left_click_drag", "mouse_move", "scroll", "key", "type", "hold_key", "left_mouse_down", "left_mouse_up", "cursor_position", "wait", "switch_display", "open_application", "read_clipboard", "write_clipboard", "request_access", "list_granted_applications", "list_apps", "computer_batch"];
{
  const bad = [];
  for (const n of NAMES) {
    const w = world();
    const s = w.codeSession("local_ex");
    const input = n === "wait" ? { duration: 0.01 } : n === "computer_batch" ? { actions: [{ action: "key", text: "a" }] } : n === "switch_display" ? { display: "auto" } : n === "zoom" ? { region: [0, 0, 10, 10] } : n === "left_click_drag" ? { coordinate: [3, 3] } : {};
    await w.call(s, n, input);
    const took = w.lock.currentHolder === "local_ex";
    const want = up.free ? !(up.free(n) || n === "wait" || n === "switch_display" || (n === "computer_batch" && up.roBatch && up.roBatch(n, input))) : null;
    if (took !== want) bad.push(n + ":" + took + "/" + want);
  }
  ok(up.free && bad.length === 0, "every Computer Use tool name: the block takes the lock exactly when upstream's dispatcher would", bad.join(" ") || NAMES.length + " names");
}
{
  const bad = [];
  for (const n of up.appKeys || []) {
    const w = world();
    const s = w.codeSession("local_app");
    await w.call(s, n, {});
    if (w.lock.currentHolder !== undefined || !up.app(n)) bad.push(n);
  }
  ok((up.appKeys || []).length > 0 && bad.length === 0, "upstream's app-scoped tools (our accessibility tools among them) never take it", bad.join(" ") || (up.appKeys || []).length + " names");
}
{
  // Batches upstream accepts (its batch validator passes them).
  const batches = [
    [{ action: "wait", duration: 0.01 }],
    [{ action: "wait", duration: 0.01 }, { action: "wait", duration: 0.01 }],
    [{ action: "wait", duration: 0.01 }, { action: "screenshot" }],
    [{ action: "key", text: "a" }],
  ];
  ok(up.batchValid && batches.every((b) => up.batchValid(b)), "  (upstream's batch validator accepts each sample)");
  const bad = [];
  for (const actions of batches) {
    const w = world();
    const s = w.codeSession("local_ro");
    await w.call(s, "computer_batch", { actions });
    const took = w.lock.currentHolder !== undefined;
    const want = !up.roBatch("computer_batch", { actions });
    if (took !== want) bad.push(J(actions.map((a) => a.action)) + ":" + took);
  }
  ok(up.roBatch && bad.length === 0, "computer_batch: a wait-only batch never takes it, anything else does (upstream's read-only-batch predicate)", bad.join(" ") || batches.length + " batches");
  // Our batch also runs switch_display (upstream's validator refuses it in a
  // batch, before the lock); it is exempt on its own, so a batch of only wait
  // and switch_display takes nothing either.
  const w = world();
  const s = w.codeSession("local_ro2");
  await w.call(s, "computer_batch", { actions: [{ action: "wait", duration: 0.01 }, { action: "switch_display", display: "auto" }] });
  ok(w.lock.currentHolder === undefined && up.batchValid && !up.batchValid([{ action: "switch_display" }]), "computer_batch of wait + switch_display: nothing taken (upstream refuses switch_display in a batch before the lock)");
}

// ── [3] a foreign holder ───────────────────────────────────────────────────
console.log("\n[3] another session holds the lock");
{
  const w = world();
  w.lock.acquire("cse_cloud1");
  w.hook.length = 0; w.events.length = 0;
  const s = w.codeSession("local_bbb");
  for (const [n, input] of [["left_click", { coordinate: [1, 1] }], ["screenshot", {}], ["computer_batch", { actions: [{ action: "key", text: "a" }] }], ["request_access", { apps: ["x"] }], ["wait", { duration: 0.01 }], ["app_click", {}]]) {
    const r = await w.call(s, n, input);
    ok(isHeldText(r), `${n}: upstream's cu_lock_held text`, J(r?.content?.[0]?.text?.slice(0, 50)));
  }
  ok(w.exec.length === 0, "  the executor was not called", J(w.exec));
  ok(w.lock.currentHolder === "cse_cloud1" && w.events.length === 0 && w.hook.length === 0, "  the cloud session keeps the lock, no lock change");
  ok(w.diag.some((l) => l.includes("tool call refused (left_click): the Computer Use lock is held by another session")), "  one log line per refusal");
  const r = await w.call(s, "app_release", {});
  ok(!isHeldText(r), "app_release is not refused (as upstream)");
}
{
  const w = world();
  const a = w.codeSession("local_one"), b = w.coworkSession("local_two");
  await w.call(a, "screenshot", {});
  const r = await w.call(b, "screenshot", {});
  ok(isHeldText(r) && w.lock.currentHolder === "local_one", "Code tab vs local Cowork: the second session is refused while the first holds it");
  w.turnEnd(a);
  const r2 = await w.call(b, "screenshot", {});
  ok(!r2.isError && w.lock.currentHolder === "local_two", "after the first session's turn end the second takes it");
}
{
  // Lost race: acquire refused (an app-mode holder of another session).
  const w = world();
  w.lock.acquireApp("cse_app", "org.example.App", 1);
  const s = w.codeSession("local_lost");
  const r = await w.call(s, "left_click", { coordinate: [1, 1] });
  ok(isHeldText(r) && w.exec.length === 0, "an app-mode holder of another session: refused with the held text, executor not called", J(r?.content?.[0]?.text?.slice(0, 40)));
  const s2 = Object.assign({}, w.codeSession("local_lost2"), { acquireCuLock: undefined, checkCuExclusiveLock: () => ({ holder: undefined, isSelf: false }), checkCuLock: () => ({ holder: undefined, isSelf: false }) });
  const r2 = await w.call(s2, "left_click", { coordinate: [1, 1] });
  ok(r2?.isError && r2?.content?.[0]?.text === up.lost && w.exec.length === 0, "no holder after the acquire: upstream's lock_lost text", J(r2?.content?.[0]?.text?.slice(0, 40)));
}

// ── [5] no Computer Use call ───────────────────────────────────────────────
console.log("\n[5] a turn without Computer Use");
{
  const w = world();
  const s = w.codeSession("local_none");
  w.turnEnd(s);
  ok(w.events.length === 0 && w.hook.length === 0 && w.lock.currentHolder === undefined, "no acquire, no lock change, no hook");
  await w.call(s, "request_access", { apps: ["gedit"] });
  await w.call(s, "list_granted_applications", {});
  w.turnEnd(s);
  ok(w.events.length === 0 && w.hook.length === 0, "request_access / list_granted_applications only: nothing taken");
}

// ── [6] batch ──────────────────────────────────────────────────────────────
console.log("\n[6] computer_batch");
{
  const w = world();
  const s = w.codeSession("local_batch");
  const r = await w.call(s, "computer_batch", { actions: [{ action: "left_click", coordinate: [1, 1] }, { action: "key", text: "a" }, { action: "screenshot" }, { action: "type", text: "x" }] });
  ok(!r.isError && w.exec.filter((e) => ["click", "key", "screenshot", "type"].includes(e[0])).length === 4, "all four actions ran", J(w.exec.map((e) => e[0])) + " " + J(r));
  ok(w.events.length === 1 && w.hook.length === 1, "the lock was taken once", J(w.events));
  ok(w.exec.every((e) => e[1] === true), "  after the lock hook settled");
  w.turnEnd(s);
  ok(w.lock.currentHolder === undefined, "the turn end releases it");
}
{
  const w = world();
  const s = w.codeSession("local_stop");
  let n = 0;
  s.isAborted = () => n >= 2;
  const orig = w.ex.key; w.ex.key = async (...a) => { n++; return orig(...a); };
  const r = await w.call(s, "computer_batch", { actions: [{ action: "key", text: "a" }, { action: "key", text: "b" }, { action: "key", text: "c" }] });
  ok(r?.isError && r?.content?.[0]?.text === "Batch aborted after 2 of 3 actions (user interrupt)." && n === 2, "a turn stopped mid-batch ends the batch with upstream's text", J(r?.content?.[0]?.text));
}

// ── [7] kwin mode ──────────────────────────────────────────────────────────
console.log("\n[7] kwin mode: the block is skipped");
{
  const w = world({ kwin: true });
  const s = w.codeSession("local_kwin");
  const r = await w.call(s, "left_click", { coordinate: [1, 1] });
  ok(w.upCalls.join() === "left_click" && r?.content?.[0]?.text === "upstream:left_click", "upstream's dispatcher answers", J(w.upCalls));
  ok(w.exec.length === 0 && w.events.length === 0, "our block took nothing and called no executor (upstream's dispatcher owns the lock there)");
}

// ── [8] a context without lock functions ───────────────────────────────────
console.log("\n[8] a session without lock functions");
{
  const w = world();
  w.lock.acquire("cse_other");
  w.events.length = 0; w.hook.length = 0;
  const s = { sessionId: "local_nolock", sessionType: "ccd", isAborted: () => false };
  const r = await w.call(s, "left_click", { coordinate: [1, 1] });
  ok(!r.isError && w.exec.some((e) => e[0] === "click") && w.events.length === 0 && w.lock.currentHolder === "cse_other", "behaves as before: the action runs, the lock is neither checked nor taken");
}

// ── [11] a turn that already ended never takes the lock ───────────────────
console.log("\n[11] a turn that ended before the acquire, or while the lock hook ran");
for (const on of [false, true]) {
  // Stop lands while the block awaits before the acquire (here: the background
  // display check): upstream's turn end runs, the session is aborted.
  const w = world({ switchOn: on });
  const s = w.codeSession("local_race");
  w.ex.__targetCheck = async () => { await sleep(5); s.aborted = true; w.turnEnd(s); return null; };
  const r = await w.call(s, "left_click", { coordinate: [1, 1] });
  ok(r?.isError && r?.content?.[0]?.text === "left_click aborted (user interrupt)." && w.exec.length === 0, `switch ${on ? "ON" : "OFF"}: Stop during the pre-acquire await: refused with upstream's abort wording, nothing run`, J(r?.content?.[0]?.text));
  ok(w.lock.currentHolder === undefined && w.events.length === 0 && w.hook.length === 0, "  the lock was never taken", J(w.events));
  ok(on ? !w.watch.some((c) => c[0] === "arm") : w.rig.t.registered() === false, on ? "  no watcher armed" : "  upstream's Escape shortcut is not registered");
}
{
  // A call that arrives after the turn's result (e.g. a background subagent).
  const w = world();
  const s = w.codeSession("local_after");
  s.aborted = true;
  const r = await w.call(s, "screenshot", {});
  ok(r?.isError && r?.content?.[0]?.text === "screenshot aborted (user interrupt)." && w.lock.currentHolder === undefined && w.exec.length === 0, "a tool call after the turn ended: refused, the lock stays free", J(r?.content?.[0]?.text));
  const r2 = await w.call(s, "wait", { duration: 0.01 });
  ok(!r2?.isError && w.lock.currentHolder === undefined, "  an exempt tool still answers (no lock involved)");
  w.lock.acquire("cse_x"); w.lock.release("cse_x");
  s.aborted = false;
  const r3 = await w.call(s, "screenshot", {});
  ok(!r3?.isError && w.lock.currentHolder === "local_after", "  the next running turn takes it as usual");
}
for (const on of [false, true]) {
  // The turn ends while the executor's lock hook is still settling (a GNOME
  // consent dialog): the action does not run, upstream's turn end releases.
  const w = world({ switchOn: on });
  const s = w.codeSession("local_settle");
  w.ex.__lockSettled = async () => { await sleep(5); s.aborted = true; w.turnEnd(s); };
  const r = await w.call(s, "left_click", { coordinate: [1, 1] });
  ok(r?.isError && r?.content?.[0]?.text === "left_click aborted (user interrupt)." && !w.exec.some((e) => e[0] === "click"), `switch ${on ? "ON" : "OFF"}: turn ended during the lock hook: the click does not run`, J(r?.content?.[0]?.text));
  ok(w.lock.currentHolder === undefined && J(w.events) === J(["local_settle", undefined]) && w.hook.map((h) => h[0]).join() === "true,false", "  taken once, released by upstream's turn end, hook true then false", J(w.events));
  ok(on ? w.watch[w.watch.length - 1][0] === "disarm" : w.rig.t.registered() === false, on ? "  the watcher is disarmed" : "  upstream's Escape shortcut is dropped");
}

// ── [12] Claude's own Escape passes upstream's X11 grab (17h) ─────────────
console.log("\n[12] X11, switch OFF: Claude's own Escape reaches the app, the grab comes back");
const EXEC_SRC = readFileSync(join(repo, "js", "cu_linux_executor.js"), "utf8");
const escAroundSrc = fnSrc(EXEC_SRC, "_escAround");
ok(!!escAroundSrc && /__cdbCuEscGrab/.test(escAroundSrc), "the executor's Escape wrapper uses the 17h grab");
for (const [fn, re] of [["key", /async key\([^)]*\)\{[\s\S]*?return _escAround\(_escKeys\(combo\)/], ["holdKey", /async holdKey\([^)]*\)\{[\s\S]*?return _escAround\(_escKeys\(keyName\)/], ["type", /return _escAround\(_escText\(text\),function\(\)\{_x11Bridge\(\["type"/], ["click (held modifiers)", /return _escAround\(_escKeys\(holdKeys\)/]])
  ok(re.test(EXEC_SRC), `  ${fn} injects through it (a batch's sub-actions use the same methods)`);
{
  delete globalThis.__cdbCuEscWatch;
  new Function("require", "process", readFileSync(join(repo, "js", "cu_esc_watch.js"), "utf8"))(nodeRequire, process);
  const hasEsc = globalThis.__cdbCuEscWatch && globalThis.__cdbCuEscWatch.hasEscape;
  ok(typeof hasEsc === "function" && hasEsc("Escape") && hasEsc("ctrl+Escape") && hasEsc(["shift", "esc"]) && !hasEsc("ctrl+a"), "  Escape is found alone and inside chords (the watcher's hasEscape)");
}
function escAround(wayland) { return evalIn({ _wayland: wayland }, "(function(){" + escAroundSrc + ";return _escAround})()"); }
for (const regFails of [0, 1, 2]) {
  let n = 0;
  const w = world({ regOk: () => { n++; return !(regFails && n > 1 && n <= 1 + regFails); } });
  globalThis.__cdbCuEscWatch = { arm: () => false, disarm() {}, suspendAround: (f) => f(), hasEscape: () => true };
  const s = w.codeSession("local_esc12");
  await w.call(s, "screenshot", {});
  ok(w.rig.t.registered() === true, `${regFails ? "(" + regFails + " failing re-register) " : ""}upstream's grab registered for the turn`);
  let during = null;
  const r = await escAround(false)(true, () => { during = w.rig.t.registered(); return "sent"; });
  const regs = w.rig.calls.filter((c) => c[0] === "register").length;
  ok(r === "sent" && during === false, "  the grab is off while Claude's Escape is injected", J({ during }));
  if (!regFails) ok(w.rig.t.registered() === true && regs === 2, "  and registered again right after (upstream's own lock-change function)", regs);
  else if (regFails === 1) ok(w.rig.t.registered() === true && regs === 3, "  a failed re-register is retried once and then holds", regs);
  else ok(w.rig.t.registered() === false && regs === 3 && w.diag.some((l) => l.includes("esc-grab: Anthropic's Escape stop key could not be registered again")), "  two failures: logged, Escape is no stop key until the next turn", regs);
  if (regFails === 2) {
    w.turnEnd(s); s.aborted = false; await w.call(s, "screenshot", {});
    ok(w.rig.t.registered() === true, "  the next turn registers it again");
  }
}
{
  const w = world();
  const s = w.codeSession("local_esc13");
  await w.call(s, "screenshot", {});
  let during = null;
  await escAround(false)(false, () => { during = w.rig.t.registered(); });
  ok(during === true, "an injection without Escape leaves the grab alone");
  const r2 = escAround(true)(true, () => "wl");
  ok(r2 === "wl" && w.rig.t.registered() === true, "Wayland: nothing suspended (upstream registers no grab there)");
  w.turnEnd(s);
  let d2 = null;
  await escAround(false)(true, () => { d2 = w.rig.t.registered(); });
  ok(d2 === false && w.rig.t.registered() === false, "no lock held: nothing to suspend, nothing registered afterwards");
}
{
  const w = world({ switchOn: true });
  const s = w.codeSession("local_esc14");
  await w.call(s, "screenshot", {});
  ok(w.rig.t.registered() === false, "switch ON (watcher armed): upstream's grab is not registered");
  let used = 0;
  globalThis.__cdbCuEscWatch.suspendAround = (f) => { used++; return f(); };
  await escAround(false)(true, () => {});
  ok(used === 1 && w.rig.t.registered() === false, "  the watcher's own suspend runs, no grab is registered");
}

// ── [13] Claude's windows stay clickable on X11 (hit test refuses instead) ─
console.log("\n[13] Claude's own windows: clickable for the user, refused for the model");
{
  const mkWin = (focusable) => { const w = { calls: [], isDestroyed: () => false, isFocusable: () => focusable, setIgnoreMouseEvents: (v) => w.calls.push(v) }; return w; };
  const saved = { st: process.env.XDG_SESSION_TYPE, wd: process.env.WAYLAND_DISPLAY };
  const setSession = (st) => { process.env.XDG_SESSION_TYPE = st; if (st === "x11") delete process.env.WAYLAND_DISPLAY; };
  const HOST = "com.anthropic.Claude", UPSTREAM_SELF = "Could not verify the click target \u2014 the Claude overlay intercepted the hit test. Retry.";
  const dispPart = partOf(P, (b) => b.includes("Could not verify the click target \\u2014 the Claude overlay intercepted"));
  ok(!!dispPart && countRe(dispPart.body, /bundleId===([\w$]+)\)return [\w$]+\("Could not verify the click target \\u2014 the Claude overlay intercepted the hit test\. Retry\.","hit_test_self_intercept"\)/) === 1, "upstream's click gate refuses a target that is Claude's own window with this text (bundle)");
  for (const [st, hit] of [["x11", true], ["x11", false], ["wayland", false]]) {
    setSession(st);
    const main = mkWin(true), overlay = mkWin(false);
    const w = world({ windows: [main, overlay] });
    w.ex.__targetActive = () => false;
    w.ex.capabilities = { hitTest: hit ? undefined : "none", hostBundleId: HOST };
    w.ex.appUnderPoint = async (x, y) => (x > 500 ? { bundleId: HOST, displayName: "Claude" } : { bundleId: "org.xfce.mousepad", displayName: "Mousepad" });
    const s = w.codeSession("local_hit");
    const onApp = await w.call(s, "left_click", { coordinate: [100, 100] });
    const onClaude = await w.call(s, "left_click", { coordinate: [800, 100] });
    const drag = await w.call(s, "left_click_drag", { start_coordinate: [100, 100], coordinate: [800, 100] });
    const tag = st + (hit ? " with a hit test" : " without a hit test");
    if (st === "x11" && hit) {
      ok(!onApp.isError && onClaude?.content?.[0]?.text === UPSTREAM_SELF && drag?.content?.[0]?.text === UPSTREAM_SELF, tag + ": a click / drag end on Claude's window is refused with upstream's text, a click on the app runs", J(onClaude?.content?.[0]?.text));
      ok(w.exec.filter((e) => e[0] === "click").length === 1, "  only the click on the app reached the executor");
      ok(main.calls.length === 0 && overlay.calls.length === 0, "  no window is made click-through (Stop in the docked panel stays clickable)", J(main.calls));
    } else {
      ok(!onClaude.isError && main.calls.join() === "true,false,true,false,true,false" && overlay.calls.length === 0, tag + ": as before, Claude's windows are click-through around each action; its overlays are left alone", J({ main: main.calls, overlay: overlay.calls }));
    }
  }
  if (saved.st === undefined) delete process.env.XDG_SESSION_TYPE; else process.env.XDG_SESSION_TYPE = saved.st;
  if (saved.wd !== undefined) process.env.WAYLAND_DISPLAY = saved.wd;
}

// ── [9] Escape for a local_ holder ─────────────────────────────────────────
console.log("\n[9] Escape stops a Code-tab turn");
for (const on of [false, true]) {
  const w = world({ switchOn: on });
  const s = w.codeSession("local_esc");
  await w.call(s, "screenshot", {});
  // Switch OFF: the function upstream registered for Escape; ON: the handler 17a handed to arm.
  const fire = on ? (w.watch.some((c) => c[0] === "arm") ? w.rig.t.handler : null) : w.rig.calls.find((c) => c[0] === "register")?.[2];
  if (fire) fire();
  ok(w.stops.some((x) => x[0] === "code" && x[1] === "local_esc"), `switch ${on ? "ON" : "OFF"}: Escape reaches the Code-tab manager's stopSession("local_esc")`, J(w.stops));
  ok(w.rig.logs.some((l) => l.includes("[cu-esc] escape pressed, stopping local_esc")), "  with upstream's `[cu-esc] escape pressed` line");
  ok(w.lock.currentHolder === undefined && (on ? w.watch[w.watch.length - 1][0] === "disarm" : w.rig.t.registered() === false), "  the stopped turn's end releases the lock and the stop key");
}

// ── [10] GNOME Stop sharing ────────────────────────────────────────────────
console.log("\n[10] Stop sharing stops a Code-tab turn");
{
  const w = world({ wayland: true });
  delete globalThis.__cdbCuShareStop;
  new Function("require", "process", readFileSync(SHARE_JS, "utf8"))(nodeRequire, process);
  const s = w.codeSession("local_share");
  await w.call(s, "screenshot", {});
  const fired = globalThis.__cdbCuShareStop.fire("gnome-portal-bridge", "stopped-by-user marker appeared");
  ok(fired === true && globalThis.__cdbCuShareEnded === w.rig.t.share, "__cdbCuShareStop.fire runs upstream's share-ended abort (17c)");
  ok(w.stops.some((x) => x[0] === "code" && x[1] === "local_share"), "  it reaches the Code-tab manager's stopSession(\"local_share\")", J(w.stops));
  ok(w.rig.logs.some((l) => l.includes("[cu-wayland] user stopped sharing, stopping local_share")), "  with upstream's `[cu-wayland] user stopped sharing` line");
}

for (const k of CU_KEYS) delete globalThis[k];
finish();
