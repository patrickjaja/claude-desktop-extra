#!/usr/bin/env node
// Escape stops Computer Use (community switch, issue #323) and Stop sharing
// stops the running turn (always on, fix_computer_use_linux 17c).
//
// WHY THIS EXISTS
// ---------------
// Upstream stops Computer Use on Escape through a globalShortcut it registers
// while its CU lock is held (an X11 grab, skipped on Wayland), and hands its
// "user stopped sharing" abort to a native portal binding our bridges never
// drive. patches/community/add_feature_cu_escape_abort.nim (17d embed, 17a
// register, 17b unregister) sends the register / unregister pair to
// js/cu_esc_watch.js - a `<bridge> abort-watch` process while the model works -
// when Settings -> Extra -> Community Features -> "Escape stops Computer Use"
// is on, and leaves upstream untouched when it is off (the default).
// fix_computer_use_linux.nim exposes the stop-sharing abort (17c); the
// executors call it the moment a portal bridge writes its stopped-by-user
// marker (js/cu_share_stop.js), and wrap every model input that can carry an
// Escape in the watcher's optional suspendAround.
//
//   [a] the real extract, staged like the orchestrator does, patched by both
//       compiled binaries in basename order (community first): pristine
//       anchors, every marker once, both counters, an idempotent second run,
//       node --check per changed chunk.
//   [b] upstream's REAL patched lock-change / register / unregister / handler /
//       abort functions in a vm sandbox, driven by a fake lock firing
//       cuLockChanged, with the switch OFF (upstream's grab on X11, nothing on
//       Wayland, no watcher) and ON (our watcher, no grab; a grab upstream
//       registered before the switch was turned on is dropped); darwin / win32
//       untouched; [e1] the share-ended global reaches upstream's abort.
//   [c] the real js/cu_esc_watch.js against fake watcher processes: ready /
//       abort, exit 2, exit 1 + one re-spawn, disarm (stdin EOF, SIGTERM,
//       SIGKILL + cleanup run), app quit, disarm during a pending spawn,
//       CLAUDE_CU_PARENT_PID, suspendAround, the startup heal, turn-scoped
//       arming (cloud turn end parks, the next action re-arms), fail towards
//       "no watcher" (unknown output / mechanism, no ready, 3 failures), and
//       the switch OFF (nothing spawned, no heal, disarm silent).
//   [d] host session -> watcher selection, hasEscape.
//   [e] both executors: the stopped-by-user marker aborts the turn once per
//       lock hold (real fs.watch on a scratch XDG_RUNTIME_DIR); action entry
//       and task boundary reach toolCall / taskEnded.
//   [f] Escape-bearing executor inputs are wrapped, others are not.
//   [g] the switch: predicate, channels, .jsonc lock, win32 refusal, bridge,
//       page row and the jsonc template entry.
//
// Exit codes: 0 = PASS, 3 = SKIP (no binaries / extract for [a]/[b]), else FAIL.

import {
  readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, rmSync,
  accessSync, constants, mkdirSync, chmodSync, unlinkSync, copyFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import vm from "node:vm";
import util from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const require = createRequire(import.meta.url);
const SKIP_EXIT = 3;
const CU_SRC = join(repo, "patches", "linux", "fix_computer_use_linux.nim");
const CU_BIN = join(repo, "patches", "linux", "fix_computer_use_linux");
const ESC_BIN = join(repo, "patches", "community", "add_feature_cu_escape_abort");
const BUILD_DIR = join(process.env.CDB_BUNDLE_DIR || join(repo, "tmp", "app.asar.contents"), ".vite", "build");
const ESC_JS = process.env.CDB_ESC_JS || join(repo, "js", "cu_esc_watch.js");  // CDB_ESC_JS: run against another copy (mutation checks)
const SHARE_JS = join(repo, "js", "cu_share_stop.js");
const REGULAR_JS = join(repo, "js", "cu_linux_executor.js");
const KWIN_JS = join(repo, "js", "executor_linux.js");
const CU_EXPECTED = Number(/const EXPECTED_PATCHES = (\d+)/.exec(readFileSync(CU_SRC, "utf8"))[1]);

let pass = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  PASS " + label + (extra !== undefined ? "  -> " + extra : "")); }
  else { failures.push(label); console.log("  FAIL " + label + (extra !== undefined ? "  -> " + extra : "")); }
}
const countRe = (hay, re) => (hay.match(new RegExp(re.source, "g")) || []).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, ms = 3000) { const t = Date.now() + ms; while (Date.now() < t) { if (f()) return true; await sleep(10); } return !!f(); }
const esc = (s) => s.replace(/[$]/g, "\\$");
process.setMaxListeners(100);
console.debug = () => {};

// End states (the .nim markers) and pristine anchors.
const M_EMBED = /globalThis\.__cdbCuEscWatch=Object\.freeze\(/;
const M_ARM = /function ([\w$]+)\(\)\{if\(process\.platform==="linux"&&globalThis\.__cdbCuEscapeAbortEnabled\?\.\(\)===true&&globalThis\.__cdbCuEscWatch\?\.arm\(([\w$]+),([\w$]+)\.currentHolder,\1\)===true\)\{if\(([\w$]+)\)\{([\w$]+)\.globalShortcut\.unregister\("Escape"\);\4=!1;([\w$]+)=0\}return\}process\.platform==="linux"&&globalThis\.__cdbCuEscapeAbortEnabled\?\.\(\)!==true&&globalThis\.__cdbCuEscWatch\?\.disarm\("switch off"\);if\(!\(\4\|\|([\w$]+)\(\)\)\)\{\6=0;/;
const M_DISARM = /function ([\w$]+)\(\)\{process\.platform==="linux"&&globalThis\.__cdbCuEscWatch\?\.disarm\(\);[\w$]+&&\([\w$]+\.globalShortcut\.unregister\(/;
const M_SHARE = /\}process\.platform==="linux"&&\(globalThis\.__cdbCuShareEnded=([\w$]+)\);/;
const M_EXPECT = /function ([\w$]+)\(\)\{([\w$]+)\+\+,setTimeout\(\(?\(\)=>\{\2>0&&\2--\}\)?,100\)\}process\.platform==="linux"&&\(globalThis\.__cdbCuExpectEscape=\1\);/;
const M_SHARE_EMBED = /globalThis\.__cdbCuShareStop=Object\.freeze\(/;
const P_REG = /function ([\w$]+)\(\)\{if\(!\([\w$]+\|\|[\w$]+\(\)\)\)\{[\w$]+=0;try\{if\(![\w$]+\.globalShortcut\.register\((["'`])Escape\2,([\w$]+)\)\)/;
const P_SITE = /\.cuWaylandOnShareEnded\?\.\(([\w$]+)\)/;
const SPLIT_RE = /\n\/\*__CDB_SPLIT__([^*\n]+?)__\*\/\n/;

function splitParts(blob) {
  const pieces = blob.split(SPLIT_RE);
  const names = ["index.js"], bodies = [pieces[0]];
  for (let i = 1; i < pieces.length; i += 2) { names.push(pieces[i]); bodies.push(pieces[i + 1]); }
  return { names, bodies };
}
// One whole `function NAME(...){...}` declaration (brace-balanced; template
// literals in these functions only hold balanced `${}`).
function fnSrc(body, name) {
  const m = new RegExp("(?<![\\w$.])function " + esc(name) + "\\(").exec(body);
  if (!m) return null;
  let depth = 0;
  for (let j = body.indexOf("{", m.index); j < body.length; j++) {
    const ch = body[j];
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return body.slice(m.index, j + 1);
  }
  return null;
}

// ─── [a] real bundle ─────────────────────────────────────────────────────────
let skipped = false;
let patchedBlob = null;
let missing = "";
try { accessSync(CU_BIN, constants.X_OK); } catch { missing = `${CU_BIN} is not compiled`; }
if (!missing && !existsSync(join(BUILD_DIR, "index.js"))) missing = "no extract under tmp/app.asar.contents/";
let escBinOk = true; try { accessSync(ESC_BIN, constants.X_OK); } catch { escBinOk = false; }
if (!missing && !escBinOk) {
  ok(false, "patches/community/add_feature_cu_escape_abort is compiled (run make in patches/)");
  missing = "the community patch binary is missing";
} else if (missing) {
  skipped = true;
  console.log("\n  SKIP real-bundle sections [a] [b]: " + missing);
} else {
  const scratch = mkdtempSync(join(tmpdir(), "cdb-cu-escape-abort-"));
  try {
    const chunks = readdirSync(BUILD_DIR).filter((d) => /^index.*\.chunk-.*\.js$/.test(d)).sort();
    let blob = readFileSync(join(BUILD_DIR, "index.js"), "utf8");
    for (const c of chunks) blob += "\n/*__CDB_SPLIT__" + c + "__*/\n" + readFileSync(join(BUILD_DIR, c), "utf8");
    const staged = join(scratch, "staged_index.js");
    writeFileSync(staged, blob);

    console.log("\n[a1] pristine anchors");
    const reg = P_REG.exec(blob);
    ok(countRe(blob, P_REG) === 1, "upstream's Escape register function exactly once", countRe(blob, P_REG));
    ok(reg && new RegExp("function " + esc(reg[3]) + "\\(\\)\\{if\\([\\w$]+>0\\)\\{[\\w$]+--,[\\w$]+\\.debug\\([\"'`]\\[cu-esc\\] escape absorbed").test(blob),
      "its handler is the function with the `[cu-esc] escape absorbed` branch", reg && reg[3]);
    ok(countRe(blob, P_SITE) === 1, "`.cuWaylandOnShareEnded?.(F)` once");
    for (const [n, re] of [["17d embed", M_EMBED], ["17a arm", M_ARM], ["17b disarm", M_DISARM], ["17c share", M_SHARE], ["17e expected-Escape", M_EXPECT], ["stop-sharing embed", M_SHARE_EMBED]])
      ok(countRe(blob, re) === 0, `no ${n} marker yet`);

    console.log("\n[a2] both patches apply in basename order (community first), then are idempotent");
    const r0 = spawnSync(ESC_BIN, [staged], { encoding: "utf8", maxBuffer: 64 << 20 });
    const out0 = (r0.stdout || "") + (r0.stderr || "");
    ok(r0.status === 0 && out0.includes("[PASS] 3/3 sub-patches applied"), "add_feature_cu_escape_abort: 3/3", r0.status + " " + out0.split("\n").filter((l) => /FAIL/.test(l)).join(" | "));
    for (const k of ["17d", "17a", "17b"]) ok(new RegExp("\\[OK\\] " + k + " ").test(out0), `  reports [OK] ${k}`);
    const r1 = spawnSync(CU_BIN, [staged], { encoding: "utf8", maxBuffer: 64 << 20 });
    const out1 = (r1.stdout || "") + (r1.stderr || "");
    ok(r1.status === 0 && out1.includes(`[PASS] ${CU_EXPECTED}/${CU_EXPECTED} sub-patches applied`), `fix_computer_use_linux after it: ${CU_EXPECTED}/${CU_EXPECTED}`, r1.status + " " + out1.split("\n").filter((l) => /FAIL/.test(l)).slice(0, 3).join(" | "));
    ok(/\[OK\] 17c /.test(out1) && /\[OK\] 17e /.test(out1), "  reports [OK] 17c and [OK] 17e");
    patchedBlob = readFileSync(staged, "utf8");
    for (const [n, re] of [["17d embed", M_EMBED], ["17a arm", M_ARM], ["17b disarm", M_DISARM], ["17c share", M_SHARE], ["17e expected-Escape", M_EXPECT], ["stop-sharing embed", M_SHARE_EMBED]])
      ok(countRe(patchedBlob, re) === 1, `${n} marker exactly once`, countRe(patchedBlob, re));
    const sm = M_SHARE.exec(patchedBlob), site = P_SITE.exec(patchedBlob);
    ok(sm && site && sm[1] === site[1], "the exposed function is the one handed to cuWaylandOnShareEnded", sm && site && sm[1] + " / " + site[1]);
    const r2 = spawnSync(ESC_BIN, [staged], { encoding: "utf8", maxBuffer: 64 << 20 });
    const r3 = spawnSync(CU_BIN, [staged], { encoding: "utf8", maxBuffer: 64 << 20 });
    ok(r2.status === 0 && /already present \(idempotent/.test(r2.stdout || "") && r3.status === 0 && /already present \(idempotent/.test(r3.stdout || ""),
      "second run of both is a positive no-op", r2.status + "/" + r3.status);
    ok(readFileSync(staged, "utf8") === patchedBlob, "  and leaves the bundle byte-identical");
    const half = patchedBlob.replace(M_DISARM, (m) => m.replace('process.platform==="linux"&&globalThis.__cdbCuEscWatch?.disarm();', ""));
    writeFileSync(staged, half);
    ok(spawnSync(ESC_BIN, [staged], { encoding: "utf8", maxBuffer: 64 << 20 }).status !== 0, "a bundle missing only 17b is refused as half-patched");
    const before = splitParts(blob), after = splitParts(patchedBlob);
    let checked = 0; const bad = [];
    for (let i = 0; i < after.names.length; i++) {
      if (after.bodies[i] === before.bodies[before.names.indexOf(after.names[i])]) continue;
      const f = join(scratch, "part-" + i + ".js");
      writeFileSync(f, after.bodies[i]);
      checked++;
      if (spawnSync(process.execPath, ["--check", f], { encoding: "utf8" }).status !== 0) bad.push(after.names[i]);
    }
    ok(checked >= 1 && bad.length === 0, "every changed part passes node --check", checked + " checked" + (bad.length ? ", bad: " + bad.join(",") : ""));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ─── [b] upstream's real functions in a sandbox ─────────────────────────────
function upstreamRig(platform, opts = {}) {
  const a = M_ARM.exec(patchedBlob);
  const [, regName, handler, , pJ, u, mJ, WO] = a;
  const unreg = M_DISARM.exec(patchedBlob)[1];
  const lcm = new RegExp("function ([\\w$]+)\\(\\)\\{([\\w$]+)\\.currentHolder&&([\\w$]+)===0\\?" + esc(regName) + "\\(\\):" + esc(unreg) + "\\(\\)\\}").exec(patchedBlob);
  const [, lc, lockName, yi] = lcm;
  const im = new RegExp("function ([\\w$]+)\\(([\\w$]+)\\)\\{([\\w$]+)=\\2," + esc(lockName) + "\\.on\\([\"'`]cuLockChanged[\"'`]," + esc(lc) + "\\)").exec(patchedBlob);
  const [, init, , fJ] = im;
  const share = M_SHARE.exec(patchedBlob)[1];
  const shareDecl = new RegExp("function " + esc(share) + "\\(\\)\\{[^{}]*\\}process\\.platform===\"linux\"&&\\(globalThis\\.__cdbCuShareEnded=" + esc(share) + "\\);").exec(patchedBlob)[0];
  const abiName = new RegExp("function " + esc(share) + "\\(\\)\\{" + esc(fJ) + "&&([\\w$]+)\\(").exec(patchedBlob)[1];
  const hSrc = fnSrc(patchedBlob, handler);
  const ibiName = /return\}([\w$]+)\(\)\}$/.exec(hSrc)[1];
  const logName = /([\w$]+)\.debug\(/.exec(hSrc)[1];
  const src = `var ${fJ},${pJ}=!1,${yi}=0,${mJ}=0;` + hSrc + fnSrc(patchedBlob, ibiName) + fnSrc(patchedBlob, abiName) +
    shareDecl + (M_EXPECT.exec(patchedBlob) || [""])[0] + fnSrc(patchedBlob, regName) + fnSrc(patchedBlob, unreg) + fnSrc(patchedBlob, lc) + fnSrc(patchedBlob, init) +
    `;globalThis.__t={handler:${handler},init:${init},share:${share},reg:${regName},registered:()=>${pJ},synth:()=>${mJ},setSynth:(v)=>{${mJ}=v}};`;
  const calls = [], logs = [], aborted = [];
  const listeners = [];
  const lock = { currentHolder: undefined, currentAppHolders: [], on(ev, f) { listeners.push([ev, f]); },
    emit(holder) { this.currentHolder = holder; for (const [ev, f] of listeners) if (ev === "cuLockChanged") f({ holder }); } };
  const sw = { on: !!opts.on };
  const ctx = { process: { platform }, setTimeout, clearTimeout };
  ctx[u] = { globalShortcut: { register: (k, f) => { calls.push(["register", k, f]); return true; }, unregister: (k) => calls.push(["unregister", k]) } };
  ctx[WO] = () => !!opts.wayland;
  ctx[lockName] = lock;
  const rec = (lvl) => (...m) => logs.push(lvl + " " + m.join(" "));
  ctx[logName] = { debug: rec("debug"), info: rec("info"), warn: rec("warn"), error: rec("error") };
  ctx.__cdbCuEscapeAbortEnabled = () => sw.on;
  const armResult = { v: opts.armResult === undefined ? true : opts.armResult };
  if (opts.watch !== false) ctx.__cdbCuEscWatch = { arm: (h, holder, reg) => { calls.push(["arm", h, holder, reg]); return armResult.v; }, disarm: (w) => calls.push(["disarm", w]) };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const t = ctx.__t;
  t.init((holder) => aborted.push(holder));
  return { ctx, t, lock, calls, logs, aborted, sw, armResult, names: { regName, unreg, lc, init, handler, share } };
}
const kinds = (r) => r.calls.map((c) => c[0] + (c[0] === "disarm" ? "" : "")).join(",");
const rigOk = !!patchedBlob && M_ARM.test(patchedBlob) && M_DISARM.test(patchedBlob) && M_SHARE.test(patchedBlob);
if (patchedBlob && !rigOk) ok(false, "[b] the patched register / unregister / share-ended functions exist");
if (rigOk) {
  console.log("\n[b1] switch OFF (default): upstream's own Escape handling, untouched");
  {
    const r = upstreamRig("linux");
    console.log(`  (register ${r.names.regName}, unregister ${r.names.unreg}, lock listener ${r.names.lc}, handler ${r.names.handler})`);
    r.calls.length = 0;
    r.lock.emit("session_A");
    ok(r.calls.some((c) => c[0] === "register" && c[1] === "Escape" && c[2] === r.t.handler) && !r.calls.some((c) => c[0] === "arm"),
      "linux X11: lock acquired -> upstream's globalShortcut.register(\"Escape\", handler), no arm", kinds(r));
    r.calls.length = 0;
    r.lock.emit(undefined);
    ok(r.calls.some((c) => c[0] === "unregister") && !r.calls.some((c) => c[0] === "arm"), "linux X11: lock released -> upstream's unregister", kinds(r));
  }
  {
    const r = upstreamRig("linux", { wayland: true });
    r.calls.length = 0;
    r.lock.emit("session_A");
    ok(!r.calls.some((c) => c[0] === "register" || c[0] === "arm"), "linux Wayland: lock acquired -> nothing registered, nothing armed (upstream skips)", kinds(r));
  }
  console.log("\n[b2] switch ON: our watcher instead of the grab");
  {
    const r = upstreamRig("linux", { on: true });
    r.calls.length = 0;
    r.lock.emit("session_A");
    ok(r.calls.length === 1 && r.calls[0][0] === "arm" && r.calls[0][1] === r.t.handler && r.calls[0][2] === "session_A" && r.calls[0][3] === r.t.reg,
      "linux: lock acquired -> arm(upstream's Escape handler, the exclusive holder, upstream's register function)", kinds(r));
    ok(!r.calls.some((c) => c[0] === "register"), "linux: globalShortcut.register is NOT called");
    r.calls[0][1]();
    ok(r.aborted.length === 1 && r.aborted[0] === "session_A", "the armed handler reaches upstream's abort for the exclusive holder", JSON.stringify(r.aborted));
    ok(r.logs.some((l) => l.includes("[cu-esc] escape pressed, stopping session_A")), "  with upstream's `[cu-esc] escape pressed` reason");
    r.lock.currentAppHolders = [{ sessionId: "app_B" }];
    r.calls[0][1]();
    ok(r.aborted.join(",") === "session_A,session_A,app_B", "app-mode holders are stopped too", r.aborted.join(","));
    r.calls.length = 0;
    r.lock.emit(undefined);
    ok(r.calls.length === 1 && r.calls[0][0] === "disarm" && !r.calls.some((c) => c[0] === "unregister"), "lock released -> disarm, no unregister (nothing registered)", kinds(r));
    console.log("\n[e1] the captured share-ended global is upstream's function (always on)");
    ok(r.ctx.__cdbCuShareEnded === r.t.share, "globalThis.__cdbCuShareEnded === upstream's share-ended abort");
    r.lock.currentAppHolders = [];
    r.lock.currentHolder = "cse_C";
    r.aborted.length = 0;
    r.ctx.__cdbCuShareEnded();
    ok(r.aborted.join(",") === "cse_C", "calling it reaches the abort callback for the holder", r.aborted.join(","));
    ok(r.logs.some((l) => l.includes("[cu-wayland] user stopped sharing, stopping cse_C")), "with the `[cu-wayland] user stopped sharing` reason");
  }
  {
    // Turned on while upstream's grab is registered: the next lock change drops it.
    const r = upstreamRig("linux");
    r.lock.emit("s1");
    ok(r.t.registered() === true, "switch off, X11: upstream's grab registered");
    r.t.setSynth(2);
    r.sw.on = true;
    r.calls.length = 0;
    r.lock.emit("s2");
    ok(r.calls.map((c) => c[0]).join(",") === "arm,unregister" && r.t.registered() === false, "switched on while held: armed, upstream's grab dropped", kinds(r));
    ok(r.t.synth() === 0, "  and upstream's expected-Escape counter reset, as its unregister does", r.t.synth());
    // Turned off while ours is armed: the next acquire disarms ours, then upstream registers.
    r.sw.on = false;
    r.calls.length = 0;
    r.lock.emit("s3");
    ok(r.calls.map((c) => c[0] + (c[0] === "disarm" ? "(" + c[1] + ")" : "")).join(",") === "disarm(switch off),register", "switched off: ours disarmed, upstream's grab back", kinds(r));
  }
  console.log("\n[b4] O7: upstream's X11 grab absorbs a model Escape marked through __cdbCuExpectEscape");
  {
    const r = upstreamRig("linux");
    r.lock.emit("s1");
    const reg = r.calls.find((c) => c[0] === "register");
    const grab = reg && reg[2];
    ok(typeof r.ctx.__cdbCuExpectEscape === "function", "globalThis.__cdbCuExpectEscape is upstream's marker (17e)");
    r.ctx.__cdbCuExpectEscape();
    grab();
    ok(r.aborted.length === 0 && r.logs.some((l) => l.includes("[cu-esc] escape absorbed (model-synthesized)")), "a marked model Escape is absorbed by upstream's real handler (no abort)", JSON.stringify(r.aborted));
    grab();
    ok(r.aborted.join(",") === "s1", "an unmarked (user) Escape aborts", JSON.stringify(r.aborted));
    r.ctx.__cdbCuExpectEscape();
    await sleep(150);
    grab();
    ok(r.aborted.join(",") === "s1,s1", "a mark lapses after 100 ms, as upstream's own", JSON.stringify(r.aborted));
  }
  {
    const r = upstreamRig("darwin");
    ok(r.ctx.__cdbCuExpectEscape === undefined, "darwin: no marker global");
  }

  console.log("\n[b3] switch ON, but no watcher can run: upstream's own body (O3)");
  {
    const r = upstreamRig("linux", { on: true, armResult: false });
    r.calls.length = 0;
    r.lock.emit("s1");
    ok(r.calls.map((c) => c[0]).join(",") === "arm,register" && r.t.registered() === true, "X11, arm answers false: upstream's grab registered", kinds(r));
    r.calls.length = 0;
    r.lock.emit(undefined);
    ok(r.calls.map((c) => c[0]).join(",") === "disarm,unregister" && r.t.registered() === false, "  released: our (no-op) disarm, then upstream's unregister (pJ consistent)", kinds(r));
  }
  {
    const r = upstreamRig("linux", { on: true, armResult: false, wayland: true });
    r.calls.length = 0;
    r.lock.emit("s1");
    ok(r.calls.map((c) => c[0]).join(",") === "arm" && r.t.registered() === false, "Wayland, arm answers false: upstream's body skips, nothing registered", kinds(r));
  }
  {
    // A watcher that fails later on X11 hands the hold back by calling
    // upstream's register function again (arm answers false this time).
    const r = upstreamRig("linux", { on: true });
    r.lock.emit("s1");
    const regFn = r.calls[r.calls.length - 1][3];
    r.armResult.v = false;
    r.calls.length = 0;
    regFn();
    ok(r.calls.map((c) => c[0]).join(",") === "arm,register" && r.t.registered() === true, "async failure on X11: upstream's register function runs its own body", kinds(r));
    r.calls.length = 0;
    r.lock.emit(undefined);
    ok(r.calls.map((c) => c[0]).join(",") === "disarm,unregister", "  and the release drops that grab", kinds(r));
  }
  for (const platform of ["darwin", "win32"]) {
    for (const on of [false, true]) {
      const r = upstreamRig(platform, { on });
      r.calls.length = 0;
      r.lock.emit("s1");
      r.lock.emit(undefined);
      ok(r.calls.map((c) => c[0]).join(",") === "register,unregister", `${platform} (switch ${on ? "on" : "off"}): upstream's register / unregister only`, kinds(r));
      ok(r.ctx.__cdbCuShareEnded === undefined, `  no share-ended global on ${platform}`);
    }
  }
}

// ─── [c] the real js/cu_esc_watch.js against fake watchers ──────────────────
const FAKE = String.raw`#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const dir = process.env.FAKE_DIR;
const log = (s) => fs.appendFileSync(path.join(dir, "log"), s + "\n");
if (process.argv[2] === "--version") {
  setTimeout(() => { process.stdout.write("fake 1\n"); process.exit(0); }, Number(process.env.FAKE_VERSION_DELAY || 0));
} else if (process.argv[2] === "abort-watch") {
  let m = process.env.FAKE_MODE || "safe";
  if (m === "ignore" && fs.existsSync(path.join(dir, "ignored"))) m = "cleanup";
  if (m === "ignore") fs.writeFileSync(path.join(dir, "ignored"), "1");
  log("start " + m + " args=" + process.argv.slice(2).join(" ") + " pid=" + process.pid + " parent=" + process.env.CLAUDE_CU_PARENT_PID + " profile=" + (process.env.CLAUDE_PROFILE || "") + " config=" + (process.env.CLAUDE_CONFIG_DIR || ""));
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  if (m === "armfail") { out({ event: "error", message: "Escape is already bound in sway's default mode (/home/u/.config/sway/config:12)" }); process.exit(2); }
  if (m === "armfail-silent") process.exit(2);
  const unsafe = m.startsWith("unsafe");
  if (m === "garbage") process.stdout.write("this is not json\n");
  else if (m === "oddmech") out({ event: "ready", mechanism: "evdev", syntheticSafe: true });
  else if (m === "oddevent") { out({ event: "ready", mechanism: "xi2", syntheticSafe: true }); out({ event: "hello" }); }
  else if (m === "slowstop" && fs.readdirSync(dir).some((f) => f.startsWith("alive-"))) { out({ event: "error", message: "the holder lock is busy" }); process.exit(2); }
  else if (m === "unsafe-slowready") setTimeout(() => { log("ready-sent"); out({ event: "ready", mechanism: "kglobalaccel", syntheticSafe: false }); }, 400);
  else if (m !== "cleanup" && m !== "noready") out({ event: "ready", mechanism: unsafe ? "kglobalaccel" : "xi2", syntheticSafe: !unsafe });
  // A model Escape that lands on a fresh, unsuspended grab.
  if (fs.existsSync(path.join(dir, "escape-now"))) { log("abort-sent (model Escape on a fresh grab)"); out({ event: "abort" }); }
  const alive = path.join(dir, "alive-" + process.pid);
  if (m === "slowstop") fs.writeFileSync(alive, "1");
  process.on("SIGUSR1", () => { log("abort-sent"); out({ event: "abort" }); });
  process.on("SIGTERM", () => { log("SIGTERM"); if (m !== "ignore") process.exit(0); });
  if (m === "runtime") setTimeout(() => { out({ event: "error", message: "sway IPC socket closed" }); process.exit(1); }, 150);
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); cmd(l); } });
  process.stdin.on("end", () => {
    log("EOF");
    if (m === "slowstop") { setTimeout(() => { try { fs.unlinkSync(alive); } catch {} log("stopped " + process.pid); process.exit(0); }, 800); return; }
    if (m !== "ignore") process.exit(0);
  });
  function cmd(l) {
    log("cmd " + l);
    if (l === "suspend") {
      out({ event: "ack", cmd: "suspend" });
      if (m === "unsafe-abort-suspended") out({ event: "abort" });
      // The KDE watcher's own limit: suspended too long -> exit 1.
      if (m === "unsafe-exit-suspended") setTimeout(() => { log("exit while suspended"); process.exit(1); }, 300);
    }
    else if (l === "resume") {
      if (m === "unsafe-resume-fail") { out({ event: "error", message: "resume failed: kglobalaccel gone" }); process.exit(1); }
      if (m === "unsafe-abort-before-ack") out({ event: "abort" });
      setTimeout(() => out({ event: "ack", cmd: "resume" }), 20);
    }
  }
  if (m === "ignore") setInterval(() => {}, 1000);
}
`;
const cRoot = mkdtempSync(join(tmpdir(), "cdb-esc-watch-fake-"));
// Every fake this harness started is killed, and every temp dir removed, on
// exit and on SIGINT / SIGTERM (a fake that ignores stdin EOF and SIGTERM
// would otherwise outlive the run).
const tempDirs = [cRoot];
function cleanupAll() {
  let dirs = []; try { dirs = readdirSync(cRoot, { withFileTypes: true }); } catch {}
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let L = ""; try { L = readFileSync(join(cRoot, d.name, "log"), "utf8"); } catch {}
    for (const m of L.matchAll(/ pid=(\d+) /g)) { try { process.kill(Number(m[1]), "SIGKILL"); } catch {} }
  }
  for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
}
process.on("exit", cleanupAll);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanupAll(); process.exit(130); });
let cN = 0;
// One fresh module instance per case. timers maps a module delay (ms) to the
// one used here (the 4 s heal is dropped unless the case asks for it).
function escRig(mode, opts = {}) {
  const dir = join(cRoot, "c" + (++cN));
  mkdirSync(dir);
  for (const b of ["x11-bridge", "wlroots-bridge", "kwin-portal-bridge"]) { writeFileSync(join(dir, b), FAKE); chmodSync(join(dir, b), 0o755); }
  const diag = [];
  const quit = {};
  const sw = { on: opts.off ? false : true };
  const env = { PATH: process.env.PATH, FAKE_DIR: dir, FAKE_MODE: mode, XDG_SESSION_TYPE: "x11", DISPLAY: ":0", CLAUDE_PROFILE: "work", CLAUDE_CONFIG_DIR: "/home/u/.claude-work", ...(opts.env || {}) };
  const timers = { 4000: opts.heal ? 50 : null, ...(opts.timers || {}) };
  const fakeProcess = { platform: "linux", pid: process.pid, env, resourcesPath: dir, once: (ev) => { listeners.push("process " + ev); } };
  const listeners = [];
  const fakeRequire = (id) => id === "electron" ? { app: { isReady: () => true, once: (ev) => { listeners.push("once " + ev); }, on: (ev, f) => { listeners.push("on " + ev); quit[ev] = f; } } } : require(id);
  const timerLog = [];
  const ctx = {
    require: fakeRequire, process: fakeProcess, console,
    setTimeout: (f, ms, ...a) => {
      timerLog.push(ms);
      if (Object.prototype.hasOwnProperty.call(timers, ms)) { if (timers[ms] === null) return { unref() {} }; return setTimeout(f, timers[ms], ...a); }
      return setTimeout(f, ms, ...a);
    },
    clearTimeout,
    __cdbDiag: (m) => diag.push(String(m)),
    __cdbCuEscapeAbortEnabled: () => sw.on,
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(ESC_JS, "utf8"), ctx, { filename: "cu_esc_watch.js" });
  const W = ctx.__cdbCuEscWatch;
  const log = () => { try { return readFileSync(join(dir, "log"), "utf8").split("\n").filter(Boolean); } catch { return []; } };
  const starts = () => log().filter((l) => l.startsWith("start"));
  return { W, ctx, diag, log, starts, dir, quit, env, sw, listeners, timerLog };
}
const escLoaded = existsSync(ESC_JS);
if (!escLoaded) {
  ok(false, "js/cu_esc_watch.js exists");
} else {
  console.log("\n[c0] switch OFF: no process, no heal, disarm is a silent no-op");
  {
    const r = escRig("safe", { off: true, heal: true });
    ok(r.listeners.length === 0 && r.timerLog.length === 0, "module load (app ready) adds no listener and no timer", JSON.stringify([r.listeners, r.timerLog]));
    r.W.disarm();
    await sleep(500);
    ok(r.starts().length === 0 && r.diag.length === 0, "nothing spawned and nothing logged (module load, heal, disarm)", r.diag.join(" || "));
    const r2 = escRig("safe");
    ok(r2.listeners.length === 0, "switch on: still no listener before the first arm");
    r2.W.arm(() => {});
    ok(r2.listeners.join(",") === "on will-quit,process exit", "the first arm installs will-quit (not before-quit) and the exit hook", r2.listeners.join(","));
    r2.W.disarm();
  }

  console.log("\n[c1] ready + abort -> upstream's handler; spawn env");
  {
    const r = escRig("safe");
    const hits = [];
    r.W.arm(() => hits.push("abort"));
    await until(() => r.W.state().mechanism === "xi2");
    const st = r.W.state();
    ok(st.armed && st.running && st.syntheticSafe === true && st.bridge === "x11-bridge", "X11 session: x11-bridge abort-watch armed, ready (xi2, syntheticSafe)", JSON.stringify(st));
    const start = r.starts()[0];
    ok(start && / args=abort-watch /.test(start), "spawned as `x11-bridge abort-watch`, no extra argument", start);
    ok(start && start.includes("parent=" + process.pid), "CLAUDE_CU_PARENT_PID = the app's pid");
    ok(start && start.includes("profile=work") && start.includes("config=/home/u/.claude-work"), "CLAUDE_PROFILE / CLAUDE_CONFIG_DIR inherited (harmless: nothing profile-specific)");
    process.kill(st.pid, "SIGUSR1");
    await until(() => hits.length === 1);
    ok(hits.length === 1, "an `abort` line calls upstream's handler once");
    r.W.arm(() => hits.push("abort2"));
    ok(r.W.state().pid === st.pid && r.W.state().spawns === 1, "arm while armed: no second process, handler refreshed");
    process.kill(st.pid, "SIGUSR1");
    await until(() => hits.length === 2);
    ok(hits[1] === "abort2", "  the refreshed handler is the one called");
    ok(r.diag.filter((d) => d.startsWith("[claude-cu] esc-watch: arm")).length === 2 && r.diag.some((d) => d.includes("esc-watch: abort:")), "arm / abort log one esc-watch line each");
    let sync = 0;
    const res = r.W.suspendAround(() => { sync++; return 7; });
    ok(res === 7 && sync === 1 && !r.log().some((l) => l.includes("cmd suspend")), "syntheticSafe: suspendAround runs fn directly, no suspend traffic");
    r.W.disarm();
    await until(() => !r.W.state().running);
    ok(r.log().includes("EOF") && r.W.state().lastExit && r.W.state().lastExit.code === 0, "disarm closes stdin; the watcher exits 0", JSON.stringify(r.W.state().lastExit));
    ok(!r.log().includes("SIGTERM"), "  no SIGTERM needed");
    const nd = r.diag.length;
    r.W.disarm();
    ok(r.W.state().spawns === 1 && r.diag.length === nd, "a second disarm is a silent no-op");
  }

  console.log("\n[c2] arming failure (exit 2): no retry, the reason verbatim in one line");
  {
    const r = escRig("armfail");
    r.W.arm(() => {});
    await until(() => r.diag.some((d) => d.includes("arming failed")));
    await sleep(1300);
    const lines = r.diag.filter((d) => d.includes("Escape is already bound in sway's default mode (/home/u/.config/sway/config:12)"));
    ok(lines.length === 1 && lines[0].includes("arming failed"), "one diag line carries the error message verbatim", lines.join(" || "));
    ok(r.starts().length === 1, "not re-spawned");
  }

  console.log("\n[c3] runtime failure (exit 1): one re-spawn per arm cycle; 3 failures end it for the app run");
  {
    const r = escRig("runtime");
    r.W.arm(() => {});
    await until(() => r.diag.some((d) => d.includes("giving up")), 5000);
    ok(r.starts().length === 2, "exactly one re-spawn", r.starts().length);
    ok(r.diag.filter((d) => d.includes("restarting it once")).length === 1, "one line for the restart");
    r.W.disarm();
    r.W.arm(() => {});
    await until(() => r.W.state().dead, 5000);
    await sleep(300);
    ok(r.W.state().dead && r.W.state().failures === 3 && r.starts().length === 3, "the third failure (across arms) ends the watcher for this app run", JSON.stringify({ f: r.W.state().failures, s: r.starts().length }));
    ok(r.diag.filter((d) => d.includes("giving up on the Escape watcher for this app run")).length === 1, "  one line says so");
    r.W.disarm();
    r.W.arm(() => {});
    await sleep(300);
    const later = r.W.arm(() => {}, "another holder");
    ok(later === false && r.starts().length === 3 && r.diag.some((d) => d.includes("no Escape watcher (the watcher failed 3 times")), "later arms spawn nothing and answer false (upstream's body runs)");
    r.W.disarm();
  }

  console.log("\n[c3b] fail towards no watcher: unreadable output, unknown mechanism, unknown event, no ready");
  for (const [mode, text, opts] of [
    ["garbage", "unreadable output"], ["oddmech", "unknown mechanism (evdev)"], ["oddevent", "unknown event (hello)"],
    ["noready", "no ready line within 5000 ms", { timers: { 5000: 300 } }],
  ]) {
    const r = escRig(mode, opts);
    const hits = [];
    r.W.arm(() => hits.push(1));
    await until(() => r.W.state().failures === 1 && !r.W.state().running, 3000);
    await sleep(200);
    ok(r.W.state().failures === 1 && !r.W.state().running && r.starts().length === 1 && hits.length === 0,
      `${mode}: watcher stopped, one failure counted, not re-spawned`, JSON.stringify({ f: r.W.state().failures, run: r.W.state().running, s: r.starts().length }));
    ok(r.diag.filter((d) => d.includes(text)).length === 1, `  one line: ${text}`, r.diag.filter((d) => d.includes("esc-watch: watcher")).join(" || "));
    r.W.disarm();
  }

  console.log("\n[c4] disarm escalation: stdin EOF, SIGTERM, SIGKILL; then a cleanup run (grace periods scaled)");
  {
    const r = escRig("ignore", { timers: { 5000: 250, 30000: 600 } });
    r.W.arm(() => {});
    await until(() => r.W.state().running && r.W.state().mechanism);
    r.W.disarm();
    await until(() => r.W.state().cleanups === 1 && r.log().some((l) => l.startsWith("start cleanup")) && r.log().filter((l) => l === "EOF").length >= 2, 5000);
    const L = r.log();
    ok(L.includes("EOF") && L.includes("SIGTERM"), "stdin closed first, then SIGTERM", L.join(" | "));
    ok(r.W.state().lastExit && r.W.state().lastExit.signal === "SIGKILL", "SIGKILL only after both grace periods", JSON.stringify(r.W.state().lastExit));
    ok(r.diag.some((d) => d.includes("SIGTERM")) && r.diag.some((d) => d.includes("SIGKILL")), "each step logged");
    ok(r.W.state().cleanups === 1 && L.some((l) => l.startsWith("start cleanup")), "the killed watcher's binding is cleaned up at once (abort-watch with stdin closed)", r.W.state().cleanups);
  }

  console.log("\n[c5] app quit: stdin EOF + SIGTERM, never SIGKILL");
  {
    const r = escRig("ignore", { timers: { 5000: 100, 30000: 300 } });
    r.W.arm(() => {});
    await until(() => r.W.state().mechanism);
    const pid = r.W.state().pid;
    ok(typeof r.quit["will-quit"] === "function" && r.quit["before-quit"] === undefined, "will-quit handler only (a cancelled quit leaves the watcher armed)");
    r.quit["will-quit"]();
    await sleep(1000);
    let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
    ok(alive && r.log().includes("SIGTERM") && !r.diag.some((d) => d.includes("SIGKILL")), "SIGTERM sent, no SIGKILL scheduled", r.log().join(" | "));
    try { process.kill(pid, "SIGKILL"); } catch {}
  }

  console.log("\n[c6] disarm during a pending spawn wins (no orphan)");
  {
    const r = escRig("safe", { env: { FAKE_VERSION_DELAY: "300" } });
    r.W.arm(() => {});
    r.W.disarm();
    await sleep(700);
    ok(r.starts().length === 0 && !r.W.state().running, "no abort-watch process was started", r.log().join("|"));
  }

  console.log("\n[c7] suspendAround on a watcher that is not syntheticSafe");
  {
    const r = escRig("unsafe");
    r.W.arm(() => {});
    await until(() => r.W.state().mechanism === "kglobalaccel");
    ok(r.W.state().syntheticSafe === false, "ready: kglobalaccel, syntheticSafe false");
    const seen = [];
    const fn = (tag) => async () => {
      seen.push(tag + ":" + r.log().filter((l) => l.startsWith("cmd")).join(","));
      await sleep(40);
      return tag;
    };
    const [a, b] = await Promise.all([r.W.suspendAround(fn("A")), r.W.suspendAround(fn("B"))]);
    const cmds = r.log().filter((l) => l.startsWith("cmd")).map((l) => l.slice(4));
    ok(a === "A" && b === "B", "fn results come back");
    ok(seen[0] === "A:cmd suspend", "suspend acked before fn runs", seen[0]);
    ok(cmds.join(",") === "suspend,resume,suspend,resume", "windows serialized: suspend, resume, suspend, resume", cmds.join(","));
    ok(seen[1] === "B:cmd suspend,cmd resume,cmd suspend", "second window starts after the first resume", seen[1]);
    let threw = null;
    try { await r.W.suspendAround(() => { throw new Error("bridge failed"); }); } catch (e) { threw = e.message; }
    ok(threw === "bridge failed" && r.log().filter((l) => l === "cmd resume").length === 3, "fn throwing: the error propagates and resume is still sent");
    ok(r.diag.filter((d) => d.includes("esc-watch: suspend:")).length === 3, "one esc-watch line per suspend window");
    let injected = false;
    await r.W.suspendAround(() => { injected = true; return 1; }, 6000);
    ok(injected && r.diag.some((d) => d.includes("long model Escape (about 6 s, over the watcher's 5 s suspend limit)")), "a window expected to outlast the 5 s suspend limit still injects, with one line saying why");
    r.W.disarm();
  }
  {
    const r = escRig("unsafe-abort-suspended");
    const hits = [];
    r.W.arm(() => hits.push(1));
    await until(() => r.W.state().mechanism);
    await r.W.suspendAround(async () => { await sleep(30); });
    ok(hits.length === 0 && r.diag.some((d) => d.includes("abort ignored inside a suspend window")), "an abort between ack suspend and the resume write is not acted on");
    process.kill(r.W.state().pid, "SIGUSR1");
    await until(() => hits.length === 1);
    ok(hits.length === 1, "  after resume a real press is honoured again");
    r.W.disarm();
  }
  {
    const r = escRig("unsafe-abort-before-ack");
    const hits = [];
    r.W.arm(() => hits.push(1));
    await until(() => r.W.state().mechanism);
    await r.W.suspendAround(() => 1);
    ok(hits.length === 1, "an abort that arrives before `ack resume` is honoured");
    r.W.disarm();
  }
  {
    const r = escRig("unsafe-resume-fail");
    r.W.arm(() => {});
    await until(() => r.W.state().mechanism);
    const t0 = Date.now();
    const v = await r.W.suspendAround(() => "done");
    ok(v === "done" && Date.now() - t0 < 1500, "a failed resume (error + exit 1, no ack) ends the wait at once", Date.now() - t0 + " ms");
    await until(() => r.starts().length === 2, 3000);
    ok(r.starts().length === 2, "  and the watcher is re-spawned once");
    r.W.disarm();
  }
  {
    const r = escRig("unsafe", { env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "GNOME" } });
    r.W.arm(() => {});
    await sleep(200);
    ok(!r.W.state().running && r.diag.some((d) => d.includes("Escape in Claude's own windows, Stop sharing and Stop remain")), "GNOME Wayland: no watcher, one line naming what remains");
    ok(r.W.suspendAround(() => 5) === 5, "  suspendAround just runs fn");
    r.W.disarm();
  }
  {
    const r = escRig("safe", { env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "KDE" } });
    const alt = join(r.dir, "kwin-override");
    copyFileSync(join(r.dir, "kwin-portal-bridge"), alt); chmodSync(alt, 0o755);
    r.env.KWIN_PORTAL_BRIDGE_BIN = alt;
    r.W.arm(() => {});
    await until(() => r.W.state().mechanism);
    ok(r.W.state().bridge === "kwin-portal-bridge", "KDE Wayland: kwin-portal-bridge (kwin mode not required)");
    let cmdline = ""; try { cmdline = readFileSync("/proc/" + r.W.state().pid + "/cmdline", "utf8"); } catch {}
    ok(cmdline.includes("kwin-override") && cmdline.includes("abort-watch"), "KWIN_PORTAL_BRIDGE_BIN wins over the bundled bridge", cmdline.replace(/\0/g, " "));
    r.W.disarm();
  }

  console.log("\n[c10] R1: the KDE watcher's own 5 s suspend limit inside a long model Escape");
  {
    // Exits 1 while suspended; a fresh watcher started during the injection
    // would take the model's Escape (escape-now) and stop the turn.
    const r = escRig("unsafe-exit-suspended");
    const hits = [];
    r.W.arm(() => hits.push(1), "session_K");
    await until(() => r.W.state().mechanism === "kglobalaccel");
    const v = await r.W.suspendAround(async () => {
      writeFileSync(join(r.dir, "escape-now"), "1");
      await sleep(1700);   // past the exit (300 ms) and the old 1 s re-spawn
      unlinkSync(join(r.dir, "escape-now"));
      return "typed";
    }, 2000);
    await until(() => r.W.state().running && r.W.state().mechanism, 3000);
    ok(v === "typed" && hits.length === 0, "zero aborts acted on (no watcher started during the injection)", JSON.stringify({ hits: hits.length, log: r.log().filter((l) => /abort|start|exit/.test(l)) }));
    ok(r.W.state().failures === 0, "failure counter unchanged", r.W.state().failures);
    ok(r.starts().length === 2 && r.W.state().running && r.W.state().armed, "armed again after the window", r.starts().length);
    ok(r.diag.some((d) => d.includes("watcher ended inside a suspend window")), "  one line says the exit was expected");
    r.W.disarm();
  }
  {
    const r = escRig("unsafe");
    const hits = [];
    r.W.arm(() => hits.push(1), "session_K");
    await until(() => r.W.state().mechanism === "kglobalaccel");
    let during = null;
    await r.W.suspendAround(async () => { during = { log: r.log().slice(), running: r.W.state().running }; await sleep(50); }, 6000);
    await until(() => r.W.state().running && r.W.state().mechanism, 3000);
    ok(during && during.log.includes("EOF") && !during.running && !during.log.some((l) => l === "cmd suspend"), "a window expected over the limit stops the watcher (orderly) before the injection, no suspend", JSON.stringify(during));
    ok(r.starts().length === 2 && r.W.state().running && r.W.state().failures === 0 && hits.length === 0, "  and arms it again after, nothing counted", r.starts().length);
    r.W.disarm();
  }

  console.log("\n[c11] O1: a cuLockChanged that keeps the exclusive holder keeps the parked state");
  {
    const r = escRig("safe");
    r.W.arm(() => {}, "session_A");
    await until(() => r.W.state().mechanism);
    r.W.taskEnded("cse_A", "renderer", "session_A");
    await until(() => !r.W.state().running);
    ok(r.W.arm(() => {}, "session_A") === true && r.W.state().parked, "same holder (an app-mode holder changed): stays parked, answers true", JSON.stringify(r.W.state()));
    await sleep(300);
    ok(r.starts().length === 1, "  nothing spawned");
    r.W.arm(() => {}, "session_B");
    await until(() => r.W.state().running && r.W.state().mechanism);
    ok(!r.W.state().parked && r.starts().length === 2, "a new exclusive holder arms again");
    r.W.disarm();
  }

  console.log("\n[c12] O2: a fast next turn waits for the previous watcher's orderly stop");
  {
    const r = escRig("slowstop");
    r.W.arm(() => {}, "session_A");
    await until(() => r.W.state().mechanism);
    r.W.taskEnded("cse_A", "renderer", "session_A");
    const t0 = Date.now();
    r.W.toolCall();
    ok(Date.now() - t0 < 20, "the action itself does not wait", Date.now() - t0 + " ms");
    await until(() => r.starts().length === 2 && r.W.state().mechanism, 4000);
    const L = r.log();
    const stoppedAt = L.findIndex((l) => l.startsWith("stopped ")), secondAt = L.findIndex((l, i) => l.startsWith("start") && i > L.indexOf("EOF"));
    ok(stoppedAt >= 0 && secondAt > stoppedAt && r.W.state().failures === 0, "the new watcher starts only after the old one exited; nothing counted", L.join(" | "));
    r.W.disarm();
  }
  {
    // The bounded wait ran out (4.5 s -> 50 ms here): the busy arm (exit 2) is not counted.
    const r = escRig("slowstop", { timers: { 4500: 50 } });
    r.W.arm(() => {}, "session_A");
    await until(() => r.W.state().mechanism);
    r.W.taskEnded("cse_A", "renderer", "session_A");
    r.W.toolCall();
    await until(() => r.diag.some((d) => d.includes("previous watcher was still stopping")), 3000);
    ok(r.W.state().failures === 0 && r.W.state().parked, "exit 2 next to our own stopping watcher: not counted, parked for the next action", JSON.stringify(r.W.state()));
    await sleep(1000);
    r.W.toolCall();
    await until(() => r.W.state().running && r.W.state().mechanism, 3000);
    ok(r.W.state().running && r.W.state().failures === 0, "  the next action arms it");
    r.W.disarm();
  }

  console.log("\n[c14] O2: an explained refusal (exit 2 + error line) never trips the breaker; the switch resets it");
  {
    const env = { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", SWAYSOCK: "/run/user/1000/sway.sock", XDG_CURRENT_DESKTOP: "sway" };
    const r = escRig("armfail", { env });
    for (let i = 0; i < 4; i++) {
      r.W.arm(() => {}, "hold" + i);
      await until(() => r.starts().length === i + 1 && !r.W.state().running && !r.W.state().armed, 3000);
      r.W.disarm();
    }
    ok(r.starts().length === 4 && r.W.state().failures === 0 && !r.W.state().dead, "4 lock holds with Escape bound in sway: tried each time, nothing counted", JSON.stringify({ s: r.starts().length, f: r.W.state().failures }));
    ok(r.diag.filter((d) => d.includes("Escape is already bound in sway's default mode")).length === 1, "  the reason is logged once");
  }
  {
    const env = { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", SWAYSOCK: "/run/user/1000/sway.sock", XDG_CURRENT_DESKTOP: "sway" };
    const r = escRig("armfail-silent", { env });
    for (let i = 0; i < 3; i++) {
      r.W.arm(() => {}, "hold" + i);
      await until(() => r.starts().length === i + 1 && !r.W.state().armed, 3000);
      r.W.disarm();
    }
    ok(r.W.state().failures === 3 && r.W.state().dead, "an unexplained exit 2 still counts (3 -> given up)", JSON.stringify({ f: r.W.state().failures, d: r.W.state().dead }));
    r.W.reset();
    ok(r.W.state().failures === 0 && !r.W.state().dead, "reset() (setting the switch) starts the count over");
    r.env.FAKE_MODE = "safe";
    r.W.arm(() => {}, "hold-next");
    await until(() => r.W.state().running && r.W.state().mechanism, 3000);
    ok(r.W.state().running, "  and the next arm spawns again");
    r.W.disarm();
  }

  console.log("\n[c15] O3: a model Escape while the watcher is still arming waits for its ready line");
  {
    const r = escRig("unsafe-slowready");
    r.W.arm(() => {}, "session_K");
    await until(() => r.starts().length === 1, 2000);
    let seen = null;
    await r.W.suspendAround(() => { seen = r.log().slice(); return 1; });
    ok(seen && seen.includes("ready-sent") && seen.includes("cmd suspend"), "waited for ready, then suspended before the injection", JSON.stringify(seen));
    r.W.disarm();
  }
  {
    const r = escRig("noready", { env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "KDE" } });
    r.W.arm(() => {}, "session_K");
    await until(() => r.starts().length === 1, 2000);
    const t0 = Date.now();
    let ran = false;
    await r.W.suspendAround(() => { ran = true; return 1; });
    const dt = Date.now() - t0;
    ok(ran && dt >= 1300 && dt < 3000 && r.diag.some((d) => d.includes("waited 1500 ms for the arming watcher's ready line")), "no ready within 1.5 s: injects anyway, one line", dt + " ms");
    r.W.disarm();
  }

  console.log("\n[c13] O3: switch on, no watcher possible on X11 -> upstream's own grab");
  {
    const r = escRig("safe");
    rmSync(join(r.dir, "x11-bridge"));
    ok(r.W.arm(() => {}, "s1", () => {}) === false && r.starts().length === 0, "X11 bridge missing: arm answers false at once (upstream's body runs)");
    ok(r.diag.some((d) => d.includes("upstream's own Escape grab is used")), "  one line");
    ok(r.W.state().lockHeld === false, "  nothing of ours holds the lock");
  }
  {
    const r = escRig("armfail");
    let reg = 0;
    const regFn = () => { reg++; r.W.arm(() => {}, "s1", regFn); };
    ok(r.W.arm(() => {}, "s1", regFn) === true, "X11: arm answers true while the spawn runs");
    await until(() => reg === 1, 3000);
    ok(reg === 1 && r.W.state().fallen && r.W.arm(() => {}, "s1", regFn) === false, "exit 2 later: upstream's register function called once, and arm answers false for that hold", JSON.stringify({ reg, st: r.W.state().fallen }));
    r.W.taskEnded(null, "renderer", null); r.W.toolCall();
    await sleep(300);
    ok(r.starts().length === 1, "  turn end / next action do not start ours over upstream's grab");
    r.W.disarm();
    ok(r.W.state().fallen === false, "  the release ends the fallback");
  }
  {
    const r = escRig("armfail", { env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "KDE" } });
    let reg = 0;
    r.W.arm(() => {}, "s1", () => { reg++; });
    await until(() => r.diag.some((d) => d.includes("arming failed")), 3000);
    await sleep(100);
    ok(reg === 0 && !r.W.state().fallen, "Wayland: no fallback (upstream skips there)");
    r.W.disarm();
  }

  console.log("\n[c8] app start: one heal run of the host session's bridge (switch on)");
  {
    const r = escRig("safe", { heal: true });
    await until(() => r.diag.some((d) => d.includes("cleanup done")), 4000);
    ok(r.starts().length === 1 && r.log().includes("EOF"), "x11-bridge abort-watch spawned once with stdin closed", r.log().join(" | "));
    ok(r.diag.some((d) => d.includes("cleanup: running x11-bridge abort-watch once with stdin closed (app start")) && r.diag.some((d) => d.includes("cleanup done (exit 0)")), "logged with its exit code");
  }
  {
    const r = escRig("safe", { heal: true, env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "GNOME" } });
    await sleep(500);
    ok(!r.log().length && !r.diag.some((d) => d.includes("cleanup")), "no heal where no watcher applies (GNOME Wayland)");
  }
  {
    const r = escRig("safe", { heal: true });
    r.W.arm(() => {});
    await until(() => r.W.state().mechanism);
    await sleep(300);
    ok(r.starts().length === 1 && !r.diag.some((d) => d.includes("cleanup")), "skipped when a lock armed a watcher first");
    r.W.disarm();
  }

  console.log("\n[c9] turn-scoped arming: a cloud turn end parks, the next action re-arms (lock still held)");
  {
    const r = escRig("safe");
    r.W.arm(() => {});
    await until(() => r.W.state().mechanism);
    r.W.toolCall();
    ok(r.W.state().spawns === 1, "an action while armed changes nothing");
    r.W.taskEnded("cse_other", "renderer", "session_mine");
    ok(r.W.state().armed && !r.W.state().parked, "a turn end naming another session is ignored");
    r.W.taskEnded("cse_ABC", "renderer", "session_abc");
    await until(() => !r.W.state().running);
    ok(r.W.state().parked && !r.W.state().running && r.W.state().lockHeld && r.log().includes("EOF"), "turn end (session_X / cse_X of one session): watcher stopped, lock still held", JSON.stringify(r.W.state()));
    ok(r.diag.some((d) => d.includes("turn ended (renderer)")), "  one line");
    const t0 = Date.now();
    r.W.toolCall();
    ok(Date.now() - t0 < 20, "the next action returns at once (re-arm is async)", Date.now() - t0 + " ms");
    await until(() => r.W.state().mechanism && r.W.state().running);
    ok(r.starts().length === 2 && !r.W.state().parked, "  and the watcher is armed again", r.starts().length);
    r.W.toolCall(); r.W.toolCall();
    await sleep(200);
    ok(r.starts().length === 2, "repeated actions: idempotent");
    r.W.taskEnded(null, "session-check", null);
    await until(() => !r.W.state().running);
    r.sw.on = false;
    r.W.toolCall();
    await sleep(300);
    ok(r.starts().length === 2 && r.diag.some((d) => d.includes("the switch is off now")), "switched off between turns: the next action does not re-arm");
    r.W.disarm();
    ok(!r.W.state().lockHeld && !r.W.state().parked, "lock release clears the parked state");
    r.W.toolCall();
    await sleep(200);
    ok(r.starts().length === 2, "an action without the lock arms nothing (Code tab: lock-scoped)");
  }

  // ─── [d] selection table ────────────────────────────────────────────────
  console.log("\n[d] host session -> watcher (switch on; background display does not change it)");
  {
    const r = escRig("safe");
    const S = (env) => r.W.select(env).bridge;
    const W = { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-1" };
    const rows = [
      ["X11 (i3)", { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }, "x11-bridge"],
      ["KDE on X11", { XDG_SESSION_TYPE: "x11", DISPLAY: ":0", XDG_CURRENT_DESKTOP: "KDE" }, "x11-bridge"],
      ["GNOME on X11", { XDG_SESSION_TYPE: "x11", DISPLAY: ":0", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" }, "x11-bridge"],
      ["KDE Wayland", { ...W, DISPLAY: ":1", XDG_CURRENT_DESKTOP: "KDE" }, "kwin-portal-bridge"],
      ["sway", { ...W, DISPLAY: ":1", SWAYSOCK: "/run/user/1000/sway-ipc.sock", XDG_CURRENT_DESKTOP: "sway" }, "wlroots-bridge"],
      ["Hyprland", { ...W, HYPRLAND_INSTANCE_SIGNATURE: "abc", XDG_CURRENT_DESKTOP: "Hyprland" }, "wlroots-bridge"],
      ["GNOME Wayland", { ...W, DISPLAY: ":1", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" }, null],
      ["niri", { ...W, NIRI_SOCKET: "/run/user/1000/niri.sock", XDG_CURRENT_DESKTOP: "niri" }, null],
      ["COSMIC", { ...W, XDG_CURRENT_DESKTOP: "COSMIC" }, null],
      ["no session type, WAYLAND_DISPLAY + KDE", { WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "KDE" }, "kwin-portal-bridge"],
      ["no display at all", {}, null],
    ];
    for (const [name, env, want] of rows) ok(S(env) === want, `${name} -> ${want || "none"}`, S(env));
    const H = r.W.hasEscape;
    const hrows = [["escape", true], ["Escape", true], ["esc", true], ["ctrl+Escape", true], ["shift+esc", true], ["ctrl+a escape", true],
      [["ctrl", "Escape"], true], ["\x1b", true], ["a", false], ["ctrl+e", false], ["escapes", false], ["", false], [null, false], [["shift"], false]];
    for (const [v, want] of hrows) ok(H(v) === want, `hasEscape(${JSON.stringify(v)}) = ${want}`);
  }
}

// ─── [e] + [f] executors ──────────────────────────────────────────────────────
const runtime = mkdtempSync(join(tmpdir(), "cdb-esc-rt-"));
tempDirs.push(runtime);
process.env.XDG_RUNTIME_DIR = runtime;
// The bridges create their runtime dir with the session (session-start).
for (const b of ["kwin-portal-bridge", "gnome-portal-bridge"]) mkdirSync(join(runtime, b), { recursive: true });
let shareCalls = 0;
let upstreamShare = null;
if (rigOk) { const u = upstreamRig("linux"); u.lock.currentHolder = "s1"; upstreamShare = u; }
globalThis.__cdbCuShareEnded = () => { shareCalls++; if (upstreamShare) upstreamShare.ctx.__cdbCuShareEnded(); };
const realDiag = [];
globalThis.__cdbDiag = (m) => realDiag.push(String(m));
if (existsSync(SHARE_JS)) new Function("require", "process", readFileSync(SHARE_JS, "utf8"))(require, process);
else ok(false, "js/cu_share_stop.js exists");
let realW = null;
if (escLoaded) {
  const ctx = { require: (id) => id === "electron" ? { app: { isReady: () => false, once() {}, on() {} } } : require(id), process, setTimeout, clearTimeout, console, __cdbDiag: () => {} };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(ESC_JS, "utf8"), ctx);
  realW = ctx.__cdbCuEscWatch;
}
const wrapped = [], hooks = [];
function spyWatch() {
  globalThis.__cdbCuEscWatch = {
    hasEscape: (v) => (realW ? realW.hasEscape(v) : false),
    suspendAround: (fn) => { wrapped.push("open"); const r = fn(); wrapped.push("close"); return r; },
    toolCall: () => hooks.push("toolCall"),
    taskEnded: (...a) => hooks.push("taskEnded " + a.join(",")),
  };
}
async function marker(bridge) {
  const f = join(runtime, bridge, "stopped-by-user");
  try { unlinkSync(f); } catch {}
  writeFileSync(f, "1\n");
}
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

function loadKwin() {
  const kw = [];
  const state = { stopped: false };
  const STOPPED = "screen sharing was stopped (the portal session was closed by the user or the desktop)";
  const cpStub = {
    execFile(bin, args, opts, cb) {
      if (typeof opts === "function") cb = opts;
      const sub = (args || [])[0];
      kw.push((args || []).join(" "));
      setImmediate(() => {
        if (sub === "session-end") { state.stopped = false; cb(null, { stdout: "", stderr: "" }); return; }
        if (sub === "screens") { cb(null, { stdout: JSON.stringify([{ id: "DP-1", name: "DP-1", geometry: { x: 0, y: 0, width: 100, height: 100 }, scale: 1, is_primary: true }]), stderr: "" }); return; }
        if (state.stopped && sub !== "session-start") { cb(Object.assign(new Error("Command failed"), { stderr: STOPPED, code: 5 }), "", ""); return; }
        cb(null, { stdout: sub === "restore-prepare-state" ? '{"hidden":[],"activated":null}' : "{}", stderr: "" });
      });
    },
    spawnSync() { return { status: 0 }; },
  };
  const src = readFileSync(KWIN_JS, "utf8")
    .replace("import { execFile as execFileCb, spawnSync } from 'node:child_process'", "const { execFile: execFileCb, spawnSync } = __cp")
    .replace("import { screen as electronScreen } from 'electron'", "const electronScreen = { getAllDisplays: () => [], getPrimaryDisplay: () => ({}), getDisplayNearestPoint: () => null }")
    .replace("import { promisify } from 'node:util'", "const { promisify } = __util")
    .replace(/^export /gm, "");
  globalThis.__cuKwinBridgeBin = "/res/kwin-portal-bridge";
  const mod = new Function("__cp", "__util", src + "\nreturn { createLinuxExecutor };")(cpStub, util);
  return { ex: mod.createLinuxExecutor({ hostBundleId: "com.anthropic.claude" }), kw, state };
}
function loadRegular(envOver) {
  const log = [];
  const rig = { stopped: false };
  const cp = {
    execFileSync(bin, args) {
      const base = String(bin).split("/").pop();
      if (base === "which" || base === "systemd-detect-virt" || base === "pgrep") throw new Error("not found");
      log.push("SYNC " + (args || []).join(" "));
      if (rig.stopped) { const e = new Error("stopped"); e.status = 5; throw e; }
      return "{}";
    },
    execSync() { throw new Error("nope"); },
    spawnSync() { return { status: 1 }; },
    execFile(bin, args, opts, cb) { log.push("CALL " + (args || []).join(" ")); setImmediate(() => cb(null, "{}", "")); },
    spawn() { return { on() {}, unref() {} }; },
  };
  const disp = { id: 1, bounds: { x: 0, y: 0, width: 100, height: 100 }, workArea: { x: 0, y: 0, width: 100, height: 100 }, size: { width: 100, height: 100 }, scaleFactor: 1, label: "e" };
  const electron = {
    screen: { getAllDisplays: () => [disp], getPrimaryDisplay: () => disp, getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    desktopCapturer: { getSources: async () => [] }, clipboard: { readText: () => "", writeText: () => {} }, nativeImage: {},
  };
  const fs = require("fs"), path = require("path"), os = require("os");
  const fsStub = { ...fs,
    existsSync: (p) => String(p).endsWith("/gnome-portal-bridge/session.sock") ? true
      : String(p).endsWith("/gnome-portal-bridge/session.pid") ? false
      : String(p).endsWith("/gnome-portal-bridge/stopped-by-user") ? rig.stopped : false,
    accessSync() { throw new Error("no"); } };
  const req = (id) => id === "child_process" ? cp : id === "electron" ? electron : id === "fs" ? fsStub : id === "path" ? path : id === "os" ? os : require(id);
  for (const k of ["SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE", "NIRI_SOCKET", "GNOME_PORTAL_BRIDGE_BIN", "X11_BRIDGE_BIN", "WLROOTS_BRIDGE_BIN", "WAYLAND_DISPLAY"]) delete process.env[k];
  Object.assign(process.env, envOver);
  globalThis.__cuKwinMode = false;
  new Function("require", "process", "setTimeout", "clearTimeout", readFileSync(REGULAR_JS, "utf8"))(req, process, setTimeout, clearTimeout);
  return { ex: globalThis.__linuxExecutor, log, rig };
}

console.log("\n[e0] the stopped-by-user watch only trusts a private runtime dir");
{
  const SS = globalThis.__cdbCuShareStop;
  const okW = SS && SS.watch("kwin-portal-bridge", () => {});
  ok(!!okW, "a 0755 dir owned by this user is watched");
  if (okW) okW.close();
  const open = join(runtime, "gnome-portal-bridge");
  chmodSync(open, 0o777);
  const n0 = realDiag.length;
  const w2 = SS && SS.watch("gnome-portal-bridge", () => {});
  ok(w2 === null && realDiag.slice(n0).some((d) => d.includes("not watching") && d.includes("writable by group or others")), "a group/other-writable dir is not watched (one line)", realDiag.slice(n0).join(" | "));
  chmodSync(open, 0o755);
  const saved = process.env.XDG_RUNTIME_DIR;
  delete process.env.XDG_RUNTIME_DIR;
  const w3 = SS && SS.watch("cdb-no-such-bridge-" + process.pid, () => {});
  ok(w3 === null, "XDG_RUNTIME_DIR unset: /tmp/<bridge> as the bridges use it, and nothing when it does not exist");
  process.env.XDG_RUNTIME_DIR = saved;
}

console.log("\n[e2] KWin executor: the stopped-by-user marker aborts the turn at once, once per lock hold");
{
  delete globalThis.__cdbCuEscWatch;
  const k = loadKwin();
  shareCalls = 0;
  await k.ex.__setLockHeld(true, "s1");
  await settle();
  await k.ex.key("a");
  k.state.stopped = true;
  await marker("kwin-portal-bridge");
  await until(() => shareCalls >= 1, 2000);
  ok(shareCalls === 1, "marker written -> upstream's share-ended abort called without any further action", shareCalls);
  if (upstreamShare) ok(upstreamShare.aborted.includes("s1"), "  and it stops the lock holder", JSON.stringify(upstreamShare.aborted));
  ok(realDiag.some((d) => d.includes("stop-sharing: kwin-portal-bridge: screen sharing was stopped")), "  one stop-sharing line");
  let err = ""; try { await k.ex.key("b"); } catch (e) { err = e.message; }
  ok(/Screen sharing was stopped/.test(err), "the existing latch still refuses the next action", err.slice(0, 60));
  await marker("kwin-portal-bridge");
  await sleep(300);
  ok(shareCalls === 1, "a second signal in the same lock hold does not abort again", shareCalls);
  await k.ex.__setLockHeld(false);
  await settle();
  k.state.stopped = false;
  await k.ex.__setLockHeld(true, "s2");
  await settle();
  await k.ex.key("a");
  k.state.stopped = true;
  await marker("kwin-portal-bridge");
  await until(() => shareCalls >= 2, 2000);
  ok(shareCalls === 2, "the next lock hold aborts again", shareCalls);
  ok(true, "without the community patch (no __cdbCuEscWatch) every input ran unwrapped");
  await k.ex.__setLockHeld(false);
  await settle();
}

console.log("\n[e3] regular executor (GNOME portal): the marker aborts the turn at once, once per lock hold");
{
  delete globalThis.__cdbCuEscWatch;
  globalThis.__cuGnomeBridgeBin = "/res/gnome-portal-bridge";
  const g = loadRegular({ XDG_CURRENT_DESKTOP: "ubuntu:GNOME", XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" });
  shareCalls = 0;
  await g.ex.__setLockHeld(true, "s1");
  await settle();
  ok(g.log.some((l) => l === "CALL session-start"), "lock taken: portal session started");
  g.rig.stopped = true;
  await marker("gnome-portal-bridge");
  await until(() => shareCalls >= 1, 2000);
  ok(shareCalls === 1, "marker written -> upstream's share-ended abort called without any further action", shareCalls);
  ok(realDiag.some((d) => d.includes("stop-sharing: gnome-portal-bridge: screen sharing was stopped")), "  one stop-sharing line");
  let err = ""; try { await g.ex.key("a"); } catch (e) { err = e.message; }
  ok(/Screen sharing was stopped/.test(err), "the existing latch still refuses the next action", err.slice(0, 60));
  await marker("gnome-portal-bridge");
  await sleep(300);
  ok(shareCalls === 1, "a second signal in the same lock hold does not abort again", shareCalls);
  await g.ex.__setLockHeld(false);
  await settle();
  g.rig.stopped = false;
  await g.ex.__setLockHeld(true, "s2");
  await settle();
  g.rig.stopped = true;
  await marker("gnome-portal-bridge");
  await until(() => shareCalls >= 2, 2000);
  ok(shareCalls === 2, "the next lock hold aborts again", shareCalls);
  await g.ex.__setLockHeld(false);
  await settle();
  delete globalThis.__linuxExecutor;
}

console.log("\n[e4] both executors hand actions and turn ends to the watcher");
{
  spyWatch();
  const k = loadKwin();
  await k.ex.__setLockHeld(true, "session_1");
  await settle();
  hooks.length = 0;
  await k.ex.key("a");
  ok(hooks.includes("toolCall"), "kwin: an action calls toolCall", hooks.join(" | "));
  hooks.length = 0;
  try { await k.ex.listInstalledApps(); } catch {}
  try { await k.ex.getAppIcon("/usr/share/applications/x.desktop"); } catch {}
  try { await k.ex.listDisplays(); } catch {}
  ok(!hooks.includes("toolCall"), "kwin: the app list, icons and displays (also run between turns) do not", hooks.join(" | "));
  hooks.length = 0;
  await k.ex.__cuTaskBoundary("cse_1", "renderer", "session_1");
  ok(hooks[0] === "taskEnded cse_1,renderer,session_1", "kwin: the task boundary calls taskEnded(id, source, holder) first", hooks.join(" | "));
  await k.ex.__setLockHeld(false);
  await settle();
  globalThis.__cuX11BridgeBin = "/res/x11-bridge";
  const r = loadRegular({ XDG_CURRENT_DESKTOP: "i3", XDG_SESSION_TYPE: "x11", DISPLAY: ":0" });
  hooks.length = 0;
  await r.ex.key("a");
  ok(hooks.includes("toolCall"), "regular: an action calls toolCall", hooks.join(" | "));
  hooks.length = 0;
  try { await r.ex.listDisplays(); } catch {}
  try { await r.ex.getDisplaySize(); } catch {}
  try { await r.ex.listInstalledApps(); } catch {}
  ok(!hooks.includes("toolCall"), "regular: displays and the app list (also run between turns) do not", hooks.join(" | "));
  hooks.length = 0;
  try { await r.ex.screenshot({}); } catch {}  // the stub has no capture tier; the entry is what counts
  ok(hooks.includes("toolCall"), "regular: a screenshot calls toolCall (the usual first action of a turn)", hooks.join(" | "));
  hooks.length = 0;
  await r.ex.__cuTaskBoundary("cse_1", "renderer", "session_1");
  ok(hooks[0] === "taskEnded cse_1,renderer,session_1", "regular: the task boundary calls taskEnded(id, source, holder)", hooks.join(" | "));
  delete globalThis.__linuxExecutor;
  // R2: an accessibility action (app_ax_find / app_click / app_type) is an action too.
  const axCtx = { process: { platform: "linux", env: {}, pid: process.pid, once() {}, on() {} }, console, setTimeout, clearTimeout, Promise, Buffer, URL, AbortController,
    __cdbDiag: () => {}, __cdbCuEscWatch: globalThis.__cdbCuEscWatch };
  axCtx.require = (id) => id === "electron" ? { app: { getPath: () => tmpdir() }, screen: {} } : require(id);
  vm.createContext(axCtx);
  vm.runInContext(readFileSync(join(repo, "js", "cu_ax_tools.js"), "utf8"), axCtx);
  hooks.length = 0;
  try { await axCtx.__cdbAxCall("app_click", {}, {}); } catch {}
  ok(hooks.includes("toolCall"), "AX: __cdbAxCall calls toolCall first", hooks.join(" | "));
}

console.log("\n[f0] O7: both executors mark a lone model Escape as expected (once per press)");
{
  let marks = 0;
  globalThis.__cdbCuExpectEscape = () => { marks++; };
  delete globalThis.__cdbCuEscWatch;
  const k = loadKwin();
  await k.ex.__setLockHeld(true, "s1");
  await settle();
  const kc = [["key escape", () => k.ex.key("escape"), 1], ["key Escape x3", () => k.ex.key("Escape", 3), 3], ["key ctrl+escape", () => k.ex.key("ctrl+escape"), 0],
    ["holdKey [Esc]", () => k.ex.holdKey(["Esc"], 10), 1], ["holdKey [shift, escape]", () => k.ex.holdKey(["shift", "escape"], 10), 0], ["type \\x1b", () => k.ex.type("\x1b"), 0], ["key a", () => k.ex.key("a"), 0]];
  for (const [name, f, want] of kc) { marks = 0; await f(); ok(marks === want, `kwin ${name}: ${want} mark(s)`, marks); }
  await k.ex.__setLockHeld(false);
  await settle();
  globalThis.__cuX11BridgeBin = "/res/x11-bridge";
  const r = loadRegular({ XDG_CURRENT_DESKTOP: "i3", XDG_SESSION_TYPE: "x11", DISPLAY: ":0" });
  const rc = [["key Escape", () => r.ex.key("Escape"), 1], ["key esc x2", () => r.ex.key("esc", 2), 2], ["key alt+escape", () => r.ex.key("alt+escape"), 0],
    ["holdKey escape", () => r.ex.holdKey("escape", 0.01), 1], ["type \\x1b", () => r.ex.type("\x1b"), 0]];
  for (const [name, f, want] of rc) { marks = 0; try { await f(); } catch {} ok(marks === want, `regular ${name}: ${want} mark(s)`, marks); }
  delete globalThis.__linuxExecutor;
  delete globalThis.__cdbCuExpectEscape;
}

console.log("\n[f] Escape-bearing executor inputs are wrapped, others are not");
{
  spyWatch();
  const k = loadKwin();
  await k.ex.__setLockHeld(true, "s1");
  await settle();
  const cases = [
    ["key escape", () => k.ex.key("escape"), 1], ["key ctrl+Escape", () => k.ex.key("ctrl+Escape"), 1], ["key ctrl+a", () => k.ex.key("ctrl+a"), 0],
    ["holdKey [Esc]", () => k.ex.holdKey(["Esc"], 10), 1], ["holdKey [shift]", () => k.ex.holdKey(["shift"], 10), 0],
    ["type a\\x1bb", () => k.ex.type("a\x1bb"), 1], ["type 'press esc'", () => k.ex.type("press esc"), 0],
    ["typePaced \\x1b", () => k.ex.typePaced("\x1b", 5), 1],
    ["click +escape", () => k.ex.click(1, 1, "left", 1, ["escape"]), 1], ["click +ctrl", () => k.ex.click(1, 1, "left", 1, ["ctrl"]), 0],
  ];
  for (const [name, f, want] of cases) {
    wrapped.length = 0;
    const before = k.kw.length;
    await f();
    const n = wrapped.filter((w) => w === "open").length;
    ok(n === want, `kwin ${name}: ${want ? "wrapped" : "not wrapped"}`, n + " window(s), bridge: " + k.kw.slice(before).filter((a) => !/^(screens|session-start)/.test(a)).join(" ; "));
  }
  await k.ex.__setLockHeld(false);
  await settle();
}
{
  spyWatch();
  globalThis.__cuX11BridgeBin = "/res/x11-bridge";
  const r = loadRegular({ XDG_CURRENT_DESKTOP: "i3", XDG_SESSION_TYPE: "x11", DISPLAY: ":0" });
  const cases = [
    ["key escape", () => r.ex.key("escape"), 1], ["key alt+tab", () => r.ex.key("alt+tab"), 0],
    ["holdKey esc", () => r.ex.holdKey("esc", 0.01), 1], ["holdKey a", () => r.ex.holdKey("a", 0.01), 0],
    ["type \\x1b:wq", () => r.ex.type("\x1b:wq"), 1], ["type 'esc'", () => r.ex.type("esc"), 0],
    ["click +Escape", () => r.ex.click(1, 1, "left", 1, ["Escape"]), 1], ["click", () => r.ex.click(1, 1, "left", 1), 0],
  ];
  for (const [name, f, want] of cases) {
    wrapped.length = 0;
    const before = r.log.length;
    try { await f(); } catch (e) { r.log.push("ERR " + e.message); }
    const n = wrapped.filter((w) => w === "open").length;
    const inj = r.log.slice(before);
    ok(n === want && !inj.some((l) => l.startsWith("ERR")), `regular (x11-bridge) ${name}: ${want ? "wrapped" : "not wrapped"}`, n + " window(s), bridge: " + inj.join(" ; "));
  }
  delete globalThis.__linuxExecutor;
  delete globalThis.__cdbCuEscWatch;
}

// ─── [g] the switch ───────────────────────────────────────────────────────────
console.log("\n[g] the community switch: predicate, channels, lock, win32, bridge, page row, template");
{
  const EXTRA_BIN = join(repo, "patches/core/add_feature_extra_settings");
  let haveExtra = true; try { accessSync(EXTRA_BIN, constants.X_OK); } catch { haveExtra = false; }
  if (!haveExtra) ok(false, "patches/core/add_feature_extra_settings is compiled");
  const Module = require("module");
  const run = async (platform, body) => {
    const dir = mkdtempSync(join(tmpdir(), "cdb-cuesc-extra-"));
    const mod = join(dir, "extra.cjs");
    writeFileSync(mod, '"use strict";\nfunction FHa(e=[]){let t=G().type==="3p"&&ou()==="1p"?[...e,j$t]:e;a.app.isPackaged?Mj(!0,t):fj(t)}\n' +
      'var Hrr,Urr;function Yrr(){return Urr??=(async()=>{let t,n,r,s;return Hrr={qemuPath:t,firmwarePath:n,virtiofsdPath:r,virtiofsdAptInstallable:!0,kvm:s},Hrr})(),Urr}function Xrr(){return Hrr}\n' +
      'function nav0(){let Uy=go(Hy,"Navigation",Xy,{events:[["navigate",[["path",I]]]]});return Uy}\n');
    spawnSync(EXTRA_BIN, [mod], { stdio: "ignore" });
    const userData = join(dir, "Claude"); mkdirSync(userData, { recursive: true });
    const handlers = {};
    const fakeElectron = {
      app: { getPath: () => userData, on: () => {}, once: () => {}, relaunch: () => {}, exit: () => {} },
      ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, removeHandler: () => {} },
      shell: { openPath: () => Promise.resolve(""), showItemInFolder: () => {} },
    };
    const orig = Module._load;
    const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Module._load = function (req, ...rest) { return req === "electron" ? fakeElectron : orig.call(this, req, ...rest); };
    Object.defineProperty(process, "platform", { value: platform });
    globalThis.__cdbDiag = () => {};
    delete globalThis.__cdbCuEscapeAbortEnabled;
    try { require(mod); } finally { Module._load = orig; Object.defineProperty(process, "platform", realPlatform); }
    const ev = { sender: { isDestroyed: () => false, getURL: () => "https://claude.ai/settings" }, senderFrame: { parent: null } };
    try {
      await body({ call: async (ch, ...a) => (typeof handlers[ch] === "function" ? handlers[ch](ev, ...a) : { ok: false, error: "no handler " + ch }), handlers, json: join(userData, "claude-desktop-extra.json"), jsonc: join(userData, "claude-desktop-extra.jsonc") });
    } finally { rmSync(dir, { recursive: true, force: true }); delete globalThis.__cdbCuEscapeAbortEnabled; }
  };
  if (haveExtra) {
    await run("linux", async ({ call, handlers, json, jsonc }) => {
      ok(typeof globalThis.__cdbCuEscapeAbortEnabled === "function" && globalThis.__cdbCuEscapeAbortEnabled() === false, "linux: predicate defined, off by default");
      ok(!!handlers["cdb-cu-esc:read"] && !!handlers["cdb-cu-esc:set"], "both cdb-cu-esc channels registered");
      let r = await call("cdb-cu-esc:read");
      ok(r.ok && r.enabled === false && r.lockedByJsonc === null, "read: off, not locked");
      r = await call("cdb-cu-esc:set", true);
      ok(r.ok && JSON.parse(readFileSync(json, "utf8")).computerUseEscapeAbort === true && globalThis.__cdbCuEscapeAbortEnabled?.() === true, "set true writes the key; read live (no restart)");
      r = await call("cdb-cu-esc:set", "yes");
      ok(r.ok === false, "non-boolean refused");
      r = await call("cdb-cu-esc:set", false);
      ok(r.ok && !("computerUseEscapeAbort" in JSON.parse(readFileSync(json, "utf8"))) && globalThis.__cdbCuEscapeAbortEnabled?.() === false, "set false removes the key");
      writeFileSync(jsonc, '{\n  // hand-edited\n  "computerUseEscapeAbort": true,\n}\n');
      r = await call("cdb-cu-esc:read");
      ok(globalThis.__cdbCuEscapeAbortEnabled?.() === true && r.enabled === true && r.lockedByJsonc === true, ".jsonc wins and locks the row");
      r = await call("cdb-cu-esc:set", false);
      ok(r.ok === false && r.lockedByJsonc === true, "a locked row refuses writes");
      writeFileSync(jsonc, "{}\n");
      let resets = 0;
      globalThis.__cdbCuEscWatch = { reset: () => { resets++; } };
      r = await call("cdb-cu-esc:set", true);
      ok(r.ok && resets === 1, "setting the switch resets the watcher's breaker (O2)", resets);
      delete globalThis.__cdbCuEscWatch;
    });
    await run("win32", async ({ call }) => {
      ok(globalThis.__cdbCuEscapeAbortEnabled === undefined, "win32: no predicate");
      let refused = true;
      for (const ch of ["cdb-cu-esc:read", "cdb-cu-esc:set"]) { const r = await call(ch, true); refused = refused && r.ok === false && /Linux only/.test(r.error); }
      ok(refused, "win32: both channels answer Linux only");
    });
  }
  const calls = []; let api = null;
  vm.runInNewContext(readFileSync(join(repo, "js/extra_settings_bridge.js"), "utf8"), vm.createContext({
    require: () => ({ contextBridge: { exposeInMainWorld: (_n, a) => { api = a; } }, ipcRenderer: { invoke: (...a) => { calls.push(a); return Promise.resolve({ ok: true }); } } }),
  }));
  if (typeof api.cuEscRead === "function") { api.cuEscRead(); api.cuEscSet("yes"); api.cuEscSet(true); }
  ok(JSON.stringify(calls) === '[["cdb-cu-esc:read"],["cdb-cu-esc:set",false],["cdb-cu-esc:set",true]]', "bridge: fixed channels, boolean only", JSON.stringify(calls));
  const page = readFileSync(join(repo, "js/extra_settings_page.js"), "utf8");
  const row = /function renderCuEscapeAbortRow\(panel, cuPage\) \{[\s\S]*?\n {2}\}\n/.exec(page);
  ok(/var CU_ROWS = \[\s*renderCuAskRow,\s*renderCuEscapeAbortCuRow,/.test(page) && /function renderCuEscapeAbortCuRow\(panel\) \{ return renderCuEscapeAbortRow\(panel, true\); \}/.test(page),
    "the same row is also on the Computer Use page (CU_ROWS, after the ask switch)");
  ok(!!row && /title: "Escape stops Computer Use"/.test(row[0]) && /read: "cuEscRead",\s*write: "cuEscSet"/.test(row[0]), "page row: title and channels");
  const note = row ? row[0].replace(/" \+\s*"/g, "") : "";
  ok(/X11, and Hyprland 0\.55 and newer: Escape still reaches your apps/.test(note) &&
     /KDE Plasma \(Wayland\): while Claude is working Escape only stops Computer Use - it does not close Overview, menus or the launcher, cancel a window move or reach the app \(Alt\+Tab and the lock screen work as usual\); if another global shortcut already uses Escape, the stop key is not enabled/.test(note) &&
     /sway: Escape is taken while Claude is working; an Escape binding in sway's default mode keeps the stop key off/.test(note) &&
     /GNOME and other desktops: not available - use Stop sharing or Stop/.test(note) && !/older Hyprland/.test(note),
     "help text: per desktop, whether Escape still reaches apps (Hyprland 0.55+ verified; no claim about older Hyprland)");
  ok(!!row && !row[0].includes(String.fromCharCode(0x2014)), "no em-dashes");
  ok(/var FEATURE_GROUPS = [\s\S]*?renderCuEscapeAbortRow[\s\S]*?\n {2}\];/.test(page), "listed in FEATURE_GROUPS (Community Features)");
  const tpl = readFileSync(join(repo, "js/growthbook_overrides.js"), "utf8");
  ok(/computerUseEscapeAbort: press Escape anywhere/.test(tpl) && tpl.includes('\\"computerUseEscapeAbort\\": true,'), "the .jsonc template documents the key");
}

rmSync(cRoot, { recursive: true, force: true });
rmSync(runtime, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed${skipped ? " (real-bundle sections skipped)" : ""}`);
if (failures.length) { console.log("FAILED: " + failures.join("; ")); process.exit(1); }
process.exit(skipped ? SKIP_EXIT : 0);
