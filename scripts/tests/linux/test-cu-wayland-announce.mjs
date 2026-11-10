#!/usr/bin/env node
// Computer Use in cloud Cowork / Dispatch on a Wayland session (sub-patch 4g).
//
// WHY THIS EXISTS
// ---------------
// A cloud Cowork task or Dispatch reaches this desktop through the remote-tools
// device. Upstream decides "device-bridge Computer Use works here" with one
// predicate (4.23118.1: `U2r`, namespace key isBridgeComputerUsePlatform,
// export alias `EF`):
//   function U2r(){return!WO()}      WO = the XDG_SESSION_TYPE Wayland check
// and three consumers: the announce gate (`E4r`: `return Nb()||!U2r()||
// !X("4293378213")?!1:...`), the device-bridge call guard in a lazy chunk
// (`if(!e.EF())return R("Computer use over the device bridge is not supported
// on this platform (on Linux it needs an Xorg session; ...")`, issue #323) and
// getAppIconForBundleId (`{isBridgeComputerUsePlatform:i}=...;if(!i()||...)`).
// So on every Wayland session the computer_* tools were left out, every call
// was refused and the approval card had no icons. Sub-patch 4g of
// fix_computer_use_linux.nim rewrites the DEFINITION to
//   function U2r(){return!WO()||process.platform==="linux"&&globalThis.__cdbCuWaylandAnnounce===!0}
// and js/cu_mode_preamble.js sets that global once per process from one pure
// decision (globalThis.__cdbCuDecide -> frozen globalThis.__cdbCuDecision): true
// only when a first-party bridge is usable on this Wayland session (kwin,
// wlroots, GNOME, or a background display whose bridge runs).
//
// This harness pins:
//   [1] the pristine anchors in the staged bundle: the gate once, its Wayland
//       term's function defined once as `return!M()`, M the XDG_SESSION_TYPE
//       check defined once, reached by exactly 3 consumers (direct call, export
//       alias call, namespace-key destructure); nothing of ours yet.
//   [2] the compiled patch applies with the full counter, reports 4g, is
//       idempotent (byte-identical second run); the changed chunk passes
//       node --check.
//   [3] Rule 6: a bundle with everything but 4g's rewrite is refused as
//       half-patched (missing 4g); a pristine bundle whose gate moved, whose
//       term is no longer the Wayland check, or whose device-bridge guard moved
//       onto another predicate fails.
//   [4] the gate evaluated in a vm sandbox with the PATCHED predicate (spec A6):
//       Linux + Wayland + global true behaves as X11; false / undefined / a
//       truthy non-true value -> false; sx() true -> false; 4293378213 off ->
//       false; X11 and non-Linux unchanged.
//   [4b] upstream's real device-bridge guard text from the patched lazy chunk,
//       its alias resolved to the patched definition, run in vm: Wayland +
//       announce passes, Wayland without it refuses with upstream's message,
//       X11 passes; the app-icon consumer resolves to the same function.
//   [5] the REAL preamble over the decision table (kwin / wlroots / GNOME /
//       background x11 / background wlroots / invalid background / exotic
//       Wayland / X11 / bridge cannot run / override that did not resolve /
//       preamble throws), with the log lines, the frozen object and its
//       set-once rule.
//   [6] __cdbTpmAtStart: undefined until the access(2) check settles, then
//       ok / denied (EACCES) / absent (ENOENT) / error, one log line each.
//   [7] __cdbCuDecide as a pure table.
// Sections [1]-[4] SKIP when the binary or the extract is missing.
// CDB_CU_PATCH_BIN points at another compiled binary; CDB_BUNDLE_DIR at an
// extract (default tmp/app.asar.contents).
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdtempSync,
  rmSync,
  accessSync,
  constants,
} from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..", "..");
const SKIP_EXIT = 3;
const PATCH_SRC = path.join(repo, "patches", "linux", "fix_computer_use_linux.nim");
const PATCH_BIN =
  process.env.CDB_CU_PATCH_BIN || path.join(repo, "patches", "linux", "fix_computer_use_linux");
const BUILD_DIR = path.join(
  process.env.CDB_BUNDLE_DIR || path.join(repo, "tmp", "app.asar.contents"),
  ".vite",
  "build"
);
const PREAMBLE = readFileSync(
  process.env.CU_PREAMBLE || path.join(repo, "js", "cu_mode_preamble.js"),
  "utf8"
);
const EXPECTED_PATCHES = Number(
  /const EXPECTED_PATCHES = (\d+)/.exec(readFileSync(PATCH_SRC, "utf8"))[1]
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

let pass = 0;
const failures = [];
function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS ${label} -> ${actual}`);
    pass++;
  } else {
    console.log(`  FAIL ${label} -> got ${actual}, expected ${expected}`);
    failures.push(label);
  }
}
const count = (hay, needle) => hay.split(needle).length - 1;
const countRe = (hay, re) => (hay.match(new RegExp(re.source, "g")) || []).length;
const esc = (x) => x.replace(/[$]/g, "\\$");

const GATE_RE =
  /(function ([\w$]+)\(\)\{return [\w$]+\(\)\|\|)!([\w$]+)\(\)(\|\|![\w$]+\((["'`])4293378213\5\)\?!1:)/;
// The predicate's patched definition: `function N(){return!M()||<ours>}`.
const PATCHED_DEF_RE =
  /function ([\w$]+)\(\)\{return!([\w$]+)\(\)\|\|process\.platform==="linux"&&globalThis\.__cdbCuWaylandAnnounce===!0\}/;
const NS_KEY_RE = /isBridgeComputerUsePlatform:\(\)=>([\w$]+)[,}]/;
// Upstream's device-bridge refusal guard (lazy chunk).
const GUARD_RE =
  /if\(!([\w$]+)\.([\w$]+)\(\)\)return ([\w$]+)\((["'`])(Computer use over the device bridge is not supported on this platform[^"'`]*)\4,!0\);/;
// getAppIconForBundleId's destructure of the namespace object.
const ICON_RE =
  /\{isBridgeComputerUsePlatform:([\w$]+)\}=await Promise\.resolve\(\)\.then\(\(\(\)=>require\("\.\/([^"]+)"\)\)\)\.then\(\(([\w$]+)=>\3\.([\w$]+)\)\);if\(!\1\(\)/;
const SPLIT_RE = /\n\/\*__CDB_SPLIT__([^*\n]+?)__\*\/\n/;
function splitParts(blob) {
  const pieces = blob.split(SPLIT_RE);
  const names = ["index.js"];
  const bodies = [pieces[0]];
  for (let i = 1; i < pieces.length; i += 2) {
    names.push(pieces[i]);
    bodies.push(pieces[i + 1]);
  }
  return { names, bodies };
}
// The local an `exports.<alias>` getter of a part returns, or null.
function exportTarget(body, alias) {
  const m = new RegExp(
    "Object\\.defineProperty\\(exports,([\"`])" + esc(alias) + "\\1,\\{enumerable:!0,get:function\\(\\)\\{return ([\\w$]+)\\}\\}\\)",
    "g"
  );
  const all = [...body.matchAll(m)];
  return all.length === 1 ? all[0][2] : null;
}
// The chunk file `ns=require("./<file>")` names in a part, or null.
function requiredChunk(body, ns) {
  const all = [...body.matchAll(new RegExp("(?<![\\w$.])" + esc(ns) + "=require\\(\"\\./([^\"]+)\"\\)", "g"))];
  return all.length === 1 ? all[0][1] : null;
}
// Consumers of predicate `name` defined in part `defName` (alias aware): direct
// calls in its own part, `<ns>.<alias>()` calls in every part that binds the
// defining chunk, and destructures of the un-minified namespace key.
function predicateConsumers(parts, defName, name) {
  const di = parts.names.indexOf(defName);
  const out = [];
  const body = parts.bodies[di];
  for (const m of body.matchAll(new RegExp("(?<![\\w$.])" + esc(name) + "\\(", "g"))) {
    if (body.slice(Math.max(0, m.index - 9), m.index) !== "function ") out.push(defName + ": " + name + "()");
  }
  const aliases = [...body.matchAll(new RegExp("Object\\.defineProperty\\(exports,\"([\\w$]+)\",\\{enumerable:!0,get:function\\(\\)\\{return " + esc(name) + "\\}\\}\\)", "g"))].map((m) => m[1]);
  parts.bodies.forEach((b, i) => {
    if (i === di) return;
    for (const r of b.matchAll(new RegExp("(?<![\\w$.])([\\w$]+)=require\\(\"\\./" + defName.replace(/[.$-]/g, "\\$&") + "\"\\)", "g"))) {
      for (const a of aliases) out.push(...[...b.matchAll(new RegExp("(?<![\\w$.])" + esc(r[1]) + "\\." + esc(a) + "\\(", "g"))].map(() => parts.names[i] + ": " + r[1] + "." + a + "()"));
    }
  });
  parts.bodies.forEach((b, i) => {
    for (const m of b.matchAll(/\{[^{}]*isBridgeComputerUsePlatform:[\w$]+[^{}]*\}=/g)) out.push(parts.names[i] + ": " + m[0]);
  });
  return out;
}
// The body of `function NAME(){...}` by brace matching (no strings with braces
// in the gate, checked by node --check of the whole chunk elsewhere).
function functionSource(blob, name) {
  const start = blob.indexOf("function " + name + "(){");
  if (start < 0) return null;
  let depth = 0;
  for (let i = blob.indexOf("{", start); i < blob.length; i++) {
    if (blob[i] === "{") depth++;
    else if (blob[i] === "}" && --depth === 0) return blob.slice(start, i + 1);
  }
  return null;
}

// The real js/cu_linux_executor.js (regular mode) on a stubbed session: target
// = the background display setting at load, setTarget() changes it, the latch
// moves on the next lock (as at run time). Bridges always answer "{}".
async function loadRealExecutor(hostEnv, target, announce) {
  const saved = { env: { ...process.env }, keys: new Set(Object.keys(globalThis)) };
  for (const k of ["SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE", "NIRI_SOCKET", "COWORK_SCREENSHOT_CMD", "X11_BRIDGE_BIN", "WLROOTS_BRIDGE_BIN", "GNOME_PORTAL_BRIDGE_BIN", "KWIN_PORTAL_BRIDGE_BIN", "YDOTOOL_SOCKET", "WAYLAND_DISPLAY", "DISPLAY", "CHROME_DESKTOP", "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE"]) delete process.env[k];
  Object.assign(process.env, hostEnv, { PATH: "/usr/bin:/bin" });
  const rig = { diag: [], target };
  const cp = {
    execFileSync(bin) { const b = path.basename(String(bin)); if (b === "systemd-detect-virt") return "none\n"; if (!/-bridge$/.test(b)) throw new Error("not found: " + b); return "{}"; },
    execSync() { throw new Error("nope"); },
    spawnSync() { return { status: 1 }; },
    execFile(bin, args, opts, cb) { setTimeout(() => cb(null, "{}", ""), 0); },
    spawn() { return { on() {}, unref() {} }; },
  };
  const R = { x: 0, y: 0, width: 1920, height: 1080 };
  const d = { id: 1, label: "Screen", bounds: R, size: { width: 1920, height: 1080 }, workArea: R, scaleFactor: 1, nativeOrigin: { x: 0, y: 0 } };
  const electron = { app: { commandLine: { getSwitchValue: () => "" }, getPath: () => "/ud" }, screen: { getAllDisplays: () => [d], getPrimaryDisplay: () => d, getCursorScreenPoint: () => ({ x: 0, y: 0 }) }, desktopCapturer: { getSources: async () => [] }, clipboard: { readText: () => "", writeText: () => {} }, nativeImage: {} };
  const fsStub = { constants: { X_OK: 1 }, readFileSync: () => Buffer.alloc(0), writeFileSync() {}, unlinkSync() {}, existsSync: () => false, renameSync() {}, accessSync() { throw new Error("ENOENT"); }, readdirSync: () => [], statSync: () => ({ isDirectory: () => false }), readlinkSync() { throw new Error("no"); }, realpathSync: (p) => p, promises: { stat: async () => { throw new Error("ENOENT"); } } };
  const req = (id) => { const m = { child_process: cp, electron, path, os: { tmpdir, homedir: () => "/home/u" }, fs: fsStub }[id]; if (!m) throw new Error("unexpected require " + id); return m; };
  globalThis.__cdbDiag = (m) => rig.diag.push(String(m));
  globalThis.__cuKwinMode = false;
  globalThis.__cuX11BridgeBin = "/res/x11-bridge";
  if (hostEnv.SWAYSOCK) globalThis.__cuWlrootsBridgeBin = "/res/wlroots-bridge";
  globalThis.__cdbCuWaylandAnnounce = announce;
  globalThis.__cuTargetRead = () => (rig.target ? { ...rig.target } : null);
  let sig = 0;
  globalThis.__cuTargetSig = () => Promise.resolve("sig" + sig);
  rig.setTarget = (t) => { rig.target = t; sig++; };
  new Function("process", readFileSync(path.join(repo, "js", "cu_display_target.js"), "utf8"))(process);
  new Function("require", "process", readFileSync(path.join(repo, "js", "cu_linux_executor.js"), "utf8"))(req, process);
  rig.ex = globalThis.__linuxExecutor;
  rig.restore = () => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved.env);
    for (const k of Object.keys(globalThis)) if (!saved.keys.has(k)) delete globalThis[k];
  };
  return rig;
}

// --- [1]-[4] real bundle --------------------------------------------------------
let skipped = false;
let patchMissing = false;
try {
  accessSync(PATCH_BIN, constants.X_OK);
} catch {
  patchMissing = true;
}
const stub = path.join(BUILD_DIR, "index.js");
if (patchMissing || !existsSync(stub)) {
  skipped = true;
  console.log(
    "\n  SKIP real-bundle sections: " +
      (patchMissing
        ? `${PATCH_BIN} is not compiled (run: make -C patches linux/fix_computer_use_linux)`
        : "no extract under tmp/app.asar.contents/ (set CDB_BUNDLE_DIR to point at one)")
  );
} else {
  const scratch = mkdtempSync(path.join(tmpdir(), "cdb-cu-wayland-announce-"));
  try {
    const chunks = readdirSync(BUILD_DIR)
      .filter((d) => /^index.*\.chunk-.*\.js$/.test(d))
      .sort();
    let blob = readFileSync(stub, "utf8");
    for (const c of chunks) blob += "\n/*__CDB_SPLIT__" + c + "__*/\n" + readFileSync(path.join(BUILD_DIR, c), "utf8");
    const staged = path.join(scratch, "staged_index.js");
    writeFileSync(staged, blob);

    console.log("\n[1] pristine anchors in the staged bundle");
    check("remote announce gate present once", countRe(blob, GATE_RE), 1);
    const g = GATE_RE.exec(blob) || [];
    const [, , gateFn, termFn] = g;
    const termDefRe = new RegExp("function " + esc(termFn || "\u0000") + "\\(\\)\\{return!([\\w$]+)\\(\\)\\}", "g");
    const termDefs = [...blob.matchAll(termDefRe)];
    check(`${termFn}() defined once as return!M()`, termDefs.length, 1);
    const mo = termDefs[0]?.[1] || "\u0000";
    const moDefRe = new RegExp(
      "(?:(?<![\\w$.])" + esc(mo) + "=\\(\\)=>|function " + esc(mo) + "\\(\\))\\{let ([\\w$]+)=(?:[\\w$]+\\(\\)|process\\.env)\\.XDG_SESSION_TYPE;return \\1\\?\\1===([\"'`])wayland\\2:!!(?:[\\w$]+\\(\\)|process\\.env)\\.WAYLAND_DISPLAY\\}",
      "g"
    );
    check(`${mo} is the XDG_SESSION_TYPE Wayland check, defined once`, [...blob.matchAll(moDefRe)].length, 1);
    check("isBridgeComputerUsePlatform namespace key once", countRe(blob, NS_KEY_RE), 1);
    check("the namespace key names the gate's term", (NS_KEY_RE.exec(blob) || [])[1], termFn);
    check("no __cdbCuWaylandAnnounce yet", count(blob, "__cdbCuWaylandAnnounce"), 0);
    const pristine = splitParts(blob);
    const gIdx = pristine.bodies.findIndex((b) => GATE_RE.test(b));
    const defName = pristine.names[pristine.bodies.findIndex((b) => b.includes("function " + termFn + "(){return!" + mo + "()}"))];
    const consumers = predicateConsumers(pristine, defName, termFn || "\u0000");
    console.log("  consumers: " + JSON.stringify(consumers));
    check(`${termFn}() consumers (alias aware: call, export alias, namespace key)`, consumers.length, 3);
    check("one consumer is the device-bridge guard's alias call", consumers.filter((c) => /: [\w$]+\.[\w$]+\(\)$/.test(c)).length, 1);
    check("one consumer destructures the namespace key", consumers.filter((c) => c.includes("{isBridgeComputerUsePlatform:")).length, 1);
    check("device-bridge guard present once", countRe(blob, GUARD_RE), 1);
    console.log(`  (gate ${gateFn} in ${pristine.names[gIdx]}, term ${termFn} = !${mo} in ${defName})`);

    console.log("\n[2] the compiled patch applies with the full counter, then is idempotent");
    const run = (f) => {
      const r = spawnSync(PATCH_BIN, [f], { encoding: "utf8" });
      return { status: r.status, out: String(r.stdout || "") + String(r.stderr || "") };
    };
    const r1 = run(staged);
    check("first run exits 0", r1.status, 0);
    check("no [FAIL] line", /\[FAIL\]/.test(r1.out), false);
    check(
      `[PASS] ${EXPECTED_PATCHES}/${EXPECTED_PATCHES} reported`,
      r1.out.includes(`[PASS] ${EXPECTED_PATCHES}/${EXPECTED_PATCHES} sub-patches applied`),
      true
    );
    check(
      "4g reported [OK] with the predicate and the session check",
      new RegExp(
        "\\[OK\\] 4g bridge platform predicate: " + esc(termFn || "\u0000") + "\\(\\) = !" + esc(mo) +
          "\\(\\) or a usable Linux bridge \\(announce gate \\+ device-bridge guard \\+ app icons, 1 definition\\)"
      ).test(r1.out),
      true
    );
    if (r1.status !== 0) console.log(r1.out);
    const patched = readFileSync(staged, "utf8");
    const r2 = run(staged);
    check("second run exits 0", r2.status, 0);
    check(
      "second run reports every end-state marker present",
      /\[OK\] all \d+ end-state markers already present \(idempotent, no change\)/.test(r2.out),
      true
    );
    check("second run leaves the file byte-identical", readFileSync(staged, "utf8") === patched, true);
    check("patched definition present once", countRe(patched, PATCHED_DEF_RE), 1);
    const pd = PATCHED_DEF_RE.exec(patched) || [];
    check("patched definition is upstream's predicate", pd[1], termFn);
    check("upstream's own Wayland check kept inside ours", pd[2], mo);
    check("pristine `return!M()` definition gone", count(patched, "function " + termFn + "(){return!" + mo + "()}"), 0);
    check("announce gate itself left as upstream wrote it", countRe(patched, GATE_RE), 1);
    check("__cdbCuWaylandAnnounce===!0 read once (the definition)", count(patched, "globalThis.__cdbCuWaylandAnnounce===!0"), 1);
    const after = splitParts(patched);
    const pIdx = after.bodies.findIndex((b) => PATCHED_DEF_RE.test(b));
    check("rewrite lands in the predicate's own chunk", after.names[pIdx], defName);
    if (pIdx >= 0) {
      const f = path.join(scratch, after.names[pIdx]);
      writeFileSync(f, after.bodies[pIdx]);
      let ok = true;
      try {
        execFileSync("node", ["--check", f], { stdio: "pipe" });
      } catch {
        ok = false;
      }
      check(`node --check ${after.names[pIdx]}`, ok, true);
    }

    console.log("\n[3] Rule 6: no false success");
    const m3 = PATCHED_DEF_RE.exec(patched);
    const half = path.join(scratch, "missing_4g.js");
    writeFileSync(half, m3 ? patched.replace(m3[0], "function " + m3[1] + "(){return!" + m3[2] + "()}") : patched);
    const r3 = run(half);
    check("bundle without 4g's rewrite: exits non-zero", r3.status !== 0, true);
    check(
      "bundle without 4g's rewrite: refused as half-patched, missing 4g",
      /half-patched input: .*missing: 4g bridge platform predicate/.test(r3.out),
      true
    );
    // The old 4g end state (call-site rewrite in the gate) is not ours any more.
    const oldShape = path.join(scratch, "old_4g_shape.js");
    writeFileSync(
      oldShape,
      blob.replace(GATE_RE, (s0, head, _g, term, tail) => head + "!(" + term + "()||process.platform===\"linux\"&&globalThis.__cdbCuWaylandAnnounce===!0)" + tail)
    );
    const r3b = run(oldShape);
    check("bundle with only the old call-site rewrite: exits non-zero", r3b.status !== 0, true);
    check("old call-site rewrite: never reported [PASS]", /\[PASS\]/.test(r3b.out), false);
    // Pristine bundle whose gate lost the 4293378213 term (a re-shaped gate).
    const moved = path.join(scratch, "gate_moved.js");
    writeFileSync(moved, blob.replace(GATE_RE, (s) => s.replace("4293378213", "4293378214")));
    const r4 = run(moved);
    check("pristine bundle with a moved gate: exits non-zero", r4.status !== 0, true);
    check("moved gate: [FAIL] 4g names the announce gate", /\[FAIL\] 4g announce gate no longer calls [\w$]+\(\) \(0 matches/.test(r4.out), true);
    check("moved gate: never reported [PASS]", /\[PASS\]/.test(r4.out), false);
    // The term's function no longer the Wayland check.
    const notWl = path.join(scratch, "term_not_wayland.js");
    writeFileSync(notWl, blob.replace("function " + termFn + "(){return!" + mo + "()}", "function " + termFn + "(){return!0}"));
    const r5 = run(notWl);
    check("term no longer `return!M()`: exits non-zero", r5.status !== 0, true);
    check("term no longer `return!M()`: [FAIL] 4g names it", /\[FAIL\] 4g bridge platform predicate: [\w$]+ defined as `return!M\(\)` 0 times/.test(r5.out), true);
    // The device-bridge guard moved onto another export (a split predicate).
    const gm = GUARD_RE.exec(blob) || [];
    const split = path.join(scratch, "guard_split.js");
    writeFileSync(split, gm[0] ? blob.replace(gm[0], gm[0].replace("!" + gm[1] + "." + gm[2] + "()", "!" + gm[1] + ".X0()")) : blob);
    const r6 = run(split);
    check("guard on another predicate: exits non-zero", r6.status !== 0, true);
    check("guard on another predicate: [FAIL] 4g names the guard", /\[FAIL\] 4g device-bridge guard does not resolve to [\w$]+/.test(r6.out), true);
    check("guard on another predicate: never reported [PASS]", /\[PASS\]/.test(r6.out), false);

    console.log("\n[4] the gate with the patched predicate in a vm sandbox (A6)");
    const src = functionSource(patched, gateFn || "\u0000");
    const pristineSrc = functionSource(blob, gateFn || "\u0000");
    const termSrc = functionSource(after.bodies[pIdx] || "", termFn || "\u0000");
    const termPristine = functionSource(blob, termFn || "\u0000");
    check("gate source extracted", !!src, true);
    check("patched predicate source extracted", !!termSrc && termSrc.includes("__cdbCuWaylandAnnounce"), true);
    if (src && pristineSrc && termSrc && termPristine) {
      // Every function the gate calls becomes a stub driven by `s`; the term is
      // upstream's predicate itself (patched or pristine) over a stubbed M.
      const callees = new Set([...src.matchAll(/(?<![\w$.])([\w$]+)\(/g)].map((m) => m[1]));
      callees.delete(gateFn);
      callees.delete(termFn);
      callees.delete("function");
      const evalGate = (body, term, s) => {
        const ctx = { process: { platform: s.platform } };
        ctx.globalThis = ctx;
        for (const c of callees) ctx[c] = () => false;
        ctx[g[0].match(/return ([\w$]+)\(\)/)[1]] = () => !!s.hipaa; // sx()
        ctx[mo] = () => !!s.wayland;
        const jxName = /!([\w$]+)\((["'`])4293378213\2\)/.exec(body)[1];
        ctx[jxName] = (id) => (id === "4293378213" ? s.cuFlag !== false : !!s.otherFlags);
        const qk = /\?!1:([\w$]+)\([^()]*\)\?!0:/.exec(body)[1]; // 4.23118.0: the term takes an options object
        ctx[qk] = () => s.qk !== false;
        if ("announce" in s) ctx.__cdbCuWaylandAnnounce = s.announce;
        vm.createContext(ctx);
        vm.runInContext(term, ctx);
        return vm.runInContext("(" + body + ")()", ctx);
      };
      const both = (label, s, want, wantPristine) => {
        check(`${label}: patched`, evalGate(src, termSrc, s), want);
        if (wantPristine !== undefined) check(`${label}: pristine`, evalGate(pristineSrc, termPristine, s), wantPristine);
      };
      const L = "linux";
      both("linux X11", { platform: L, wayland: false }, true, true);
      both("linux Wayland, announce true -> as X11", { platform: L, wayland: true, announce: true }, true, false);
      both("linux Wayland, announce false", { platform: L, wayland: true, announce: false }, false);
      both("linux Wayland, announce unset", { platform: L, wayland: true }, false);
      both('linux Wayland, announce "true" (not === true)', { platform: L, wayland: true, announce: "true" }, false);
      both("linux Wayland, announce 1 (not === true)", { platform: L, wayland: true, announce: 1 }, false);
      both("linux Wayland + HIPAA (sx) -> false", { platform: L, wayland: true, announce: true, hipaa: true }, false);
      both("linux X11 + HIPAA -> false", { platform: L, wayland: false, hipaa: true }, false, false);
      both("linux Wayland, 4293378213 off -> false", { platform: L, wayland: true, announce: true, cuFlag: false }, false);
      both("linux X11, 4293378213 off -> false", { platform: L, wayland: false, cuFlag: false }, false, false);
      both("linux Wayland, announce true, QK false -> upstream tail", { platform: L, wayland: true, announce: true, qk: false }, false);
      both("darwin, announce true -> unchanged", { platform: "darwin", wayland: false, announce: true }, true, true);
      both("win32 Wayland-ish env, announce true -> unchanged (false)", { platform: "win32", wayland: true, announce: true }, false, false);
    }

    console.log("\n[4b] upstream's device-bridge guard and app-icon consumer, patched chunks");
    const gIdx2 = after.bodies.findIndex((b) => GUARD_RE.test(b));
    check("guard present once after patching", countRe(patched, GUARD_RE), 1);
    if (gIdx2 >= 0) {
      const gb = after.bodies[gIdx2];
      const gmm = GUARD_RE.exec(gb);
      const [guardText, ns, alias, refuse, , message] = gmm;
      const file = requiredChunk(gb, ns);
      check(`guard's ${ns}=require(...) names the predicate's chunk`, file, defName);
      const defBody = after.bodies[after.names.indexOf(file)] || "";
      const local = exportTarget(defBody, alias);
      check(`guard's ${ns}.${alias} resolves to the patched predicate`, local, termFn);
      const pred = functionSource(defBody, local || "\u0000");
      check("resolved predicate carries our term", !!pred && PATCHED_DEF_RE.test(pred), true);
      // Upstream's Wayland check itself, over a stubbed environment accessor.
      const moSrc = new RegExp("(?<![\\w$.])" + esc(mo) + "=\\(\\)=>\\{let ([\\w$]+)=([\\w$]+)\\(\\)\\.XDG_SESSION_TYPE;[^}]*\\}").exec(defBody);
      check(`${mo} source found in the predicate's chunk`, !!moSrc, true);
      const runGuard = (env, platform, ann) => {
        const ctx = { process: { platform } };
        ctx.globalThis = ctx;
        if (ann !== undefined) ctx.__cdbCuWaylandAnnounce = ann;
        ctx[moSrc[2]] = () => env;
        vm.createContext(ctx);
        vm.runInContext("var " + moSrc[0] + ";" + pred + ";var " + ns + "={" + JSON.stringify(alias) + ":" + local + "};var " + refuse + "=(m,x)=>({refused:m,x});", ctx);
        const r = vm.runInContext("(()=>{" + guardText + "return 'passes'})()", ctx);
        return typeof r === "string" ? r : r.refused;
      };
      const W = { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" };
      check("guard: Linux Wayland, usable bridge (announce true) -> passes", runGuard(W, "linux", true), "passes");
      check("guard: Linux Wayland, announce false -> upstream's refusal", runGuard(W, "linux", false), message);
      check("guard: Linux Wayland, announce unset -> upstream's refusal", runGuard(W, "linux"), message);
      check("guard: Linux X11 -> passes", runGuard({ XDG_SESSION_TYPE: "x11" }, "linux", false), "passes");
      check("guard: Linux, no XDG_SESSION_TYPE, WAYLAND_DISPLAY, announce true -> passes", runGuard({ WAYLAND_DISPLAY: "w" }, "linux", true), "passes");
      check("guard: win32 Wayland-ish env, announce true -> refusal unchanged", runGuard(W, "win32", true), message);
      check("refusal text still names Xorg (upstream's message kept)", /needs an Xorg session/.test(message), true);

      console.log("\n[4c] the announce latch follows the REAL executor's background display (one-way to false)");
      const HOSTS4 = {
        kde: { XDG_CURRENT_DESKTOP: "KDE", XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":1" },
        sway: { XDG_CURRENT_DESKTOP: "sway", XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":0", SWAYSOCK: "/run/user/1000/sway.sock" },
      };
      const W4 = { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" };
      const LATCH = [
        // label, host, announce at start, target at start, target later, want announce after, want a withdraw line
        ["KDE regular, background x11 turned off -> withdrawn (XWayland/ydotool left)", "kde", true, { kind: "x11", display: ":99" }, null, false, true],
        ["KDE regular, background x11 moved to :98 -> kept", "kde", true, { kind: "x11", display: ":99" }, { kind: "x11", display: ":98" }, true, false],
        ["KDE regular, background setting turned invalid -> withdrawn", "kde", true, { kind: "x11", display: ":99" }, { invalid: "bad kind", display: "" }, false, true],
        ["sway + wlroots-bridge, background x11 turned off -> kept (wlroots-bridge drives the desktop)", "sway", true, { kind: "x11", display: ":99" }, null, true, false],
        ["KDE regular, announce false at start, background x11 turned on -> stays false", "kde", false, null, { kind: "x11", display: ":99" }, false, false],
      ];
      for (const [label, host, ann0, t0, t1, wantAnn, wantLine] of LATCH) {
        const rig = await loadRealExecutor(HOSTS4[host], t0, ann0);
        try {
          check(`${label}: announce at start`, globalThis.__cdbCuWaylandAnnounce, ann0);
          rig.setTarget(t1);
          await rig.ex.__setLockHeld(true);
          check(`${label}: announce after the switch`, globalThis.__cdbCuWaylandAnnounce, wantAnn);
          const lines = rig.diag.filter((l) => l.startsWith("[claude-cu] remote device: computer tools withdrawn"));
          check(`${label}: withdraw log line`, lines.length, wantLine ? 1 : 0);
          check(`${label}: upstream's guard`, runGuard(W4, "linux", globalThis.__cdbCuWaylandAnnounce), wantAnn ? "passes" : message);
          rig.setTarget(t0);
          await rig.ex.__setLockHeld(true);
          check(`${label}: one-way (setting back does not re-announce)`, globalThis.__cdbCuWaylandAnnounce, wantAnn);
        } finally {
          rig.restore();
        }
      }
    }
    const iIdx = after.bodies.findIndex((b) => ICON_RE.test(b));
    check("app-icon consumer present once", countRe(patched, ICON_RE), 1);
    if (iIdx >= 0) {
      const im = ICON_RE.exec(after.bodies[iIdx]);
      const nsBody = after.bodies[after.names.indexOf(im[2])] || "";
      const nsLocal = exportTarget(nsBody, im[4]);
      const keyM = nsLocal && new RegExp("(?<![\\w$.])" + esc(nsLocal) + "=[\\w$]+\\.r\\(\\{[^}]*isBridgeComputerUsePlatform:\\(\\)=>([\\w$]+)[,}]").exec(nsBody);
      check(`app-icon consumer's namespace (${im[2]} .${im[4]}) resolves to the patched predicate`, keyM && keyM[1], termFn);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// --- [5] the real preamble over the decision table -----------------------------
const GLOBALS = [
  "__cuKwinMode", "__cuKwinBridgeBin", "__cuX11BridgeBin", "__cuWlrootsBridgeBin", "__cuGnomeBridgeBin",
  "__cuBridgeFail", "__cuBridgeProbeCache", "__cuTargetRead", "__cuTargetIdentity", "__cuTargetSig",
  "__cuTargetSigSync", "__cuTgtJsoncDiag", "__cdbCuDecision", "__cdbCuWaylandAnnounce", "__cdbTpmAtStart",
  "__cdbCuDecide", "__cdbDiag",
];
const BASE_ENV = { HOME: "/home/u", PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: "/run/user/1000" };
const HOSTS = {
  kde: { XDG_CURRENT_DESKTOP: "KDE", XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":1" },
  sway: { XDG_CURRENT_DESKTOP: "sway", XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":0", SWAYSOCK: "/run/user/1000/sway-ipc.sock" },
  gnome: { XDG_CURRENT_DESKTOP: "ubuntu:GNOME", XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
  exotic: { XDG_CURRENT_DESKTOP: "Weston", XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
  x11: { XDG_CURRENT_DESKTOP: "XFCE", XDG_SESSION_TYPE: "x11", DISPLAY: ":0" },
};
const ALL_GOOD = ["kwin-portal-bridge", "x11-bridge", "wlroots-bridge", "gnome-portal-bridge"];

// opts: host, env, bad (bridge names whose --version fails), missing (bridge
// names not on disk), cfg (claude-desktop-extra.json object), tpm (errno or
// "ok"), throwOn (require id that throws), keep (do not reset globals).
async function runPreamble(opts) {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, BASE_ENV, HOSTS[opts.host], opts.env || {});
  const savedRes = process.resourcesPath;
  process.resourcesPath = "/res";
  if (!opts.keep) for (const k of GLOBALS) delete globalThis[k];
  const diag = [];
  globalThis.__cdbDiag = (m) => diag.push(String(m));
  const spawned = [];
  const bad = new Set(opts.bad || []);
  const missing = new Set(opts.missing || []);
  const present = (p) => {
    const s = String(p);
    if (s.startsWith("/res/")) return ALL_GOOD.includes(path.basename(s)) && !missing.has(path.basename(s));
    return (opts.extraBins || []).includes(s);
  };
  const child = (code, stderr) => ({
    stderr: { on(ev, cb) { if (ev === "data" && stderr) setTimeout(() => cb(stderr), 0); } },
    on(ev, cb) { if (ev === "close") setTimeout(() => cb(code, null), 1); },
    kill() {},
  });
  const cp = {
    spawn: (b, a) => {
      spawned.push(path.basename(String(b)) + " " + a.join(" "));
      return bad.has(path.basename(String(b)))
        ? child(127, "error while loading shared libraries: libpipewire-0.3.so.0: cannot open shared object file\n")
        : child(0, "");
    },
    execFile: (b, a, o, cb) => {
      spawned.push(b + " " + a.join(" "));
      setTimeout(() => cb(null, "kwin 6.6.1\n"), 0);
    },
  };
  let tpmSettle;
  const tpmP = new Promise((r) => (tpmSettle = r));
  const files = opts.cfg ? { "claude-desktop-extra.json": JSON.stringify({ computerUseBackgroundDisplay: opts.cfg }) } : {};
  const fsP = {
    constants: { X_OK: 1, R_OK: 4, W_OK: 2 },
    accessSync: (p) => {
      if (!present(p)) {
        const e = new Error("ENOENT");
        e.code = "ENOENT";
        throw e;
      }
    },
    existsSync: (p) => path.basename(String(p)) in files,
    readFileSync: (p) => {
      const n = path.basename(String(p));
      if (n in files) return files[n];
      const e = new Error("ENOENT");
      e.code = "ENOENT";
      throw e;
    },
    statSync: (p) => {
      const s = String(p);
      return { isSocket: () => true, dev: 1, ino: [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 1000000007, 7) };
    },
    promises: {
      access: (p, mode) => {
        fsP.tpmAccess = [p, mode];
        return tpmP.then(() => {
          if (opts.tpm === "ok") return undefined;
          const e = new Error(opts.tpm);
          e.code = opts.tpm;
          throw e;
        });
      },
      stat: () => Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    },
  };
  const req = (id) => {
    if (opts.throwOn === id) throw new Error("boom: " + id);
    const m = { fs: fsP, path, child_process: cp, electron: { app: { getPath: () => "/ud" } } }[id];
    if (!m) throw new Error("unexpected require " + id);
    return m;
  };
  let error = null;
  try {
    await new AsyncFunction("require", "process", PREAMBLE)(req, process);
  } catch (e) {
    error = e;
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
    process.resourcesPath = savedRes;
  }
  return {
    error,
    diag,
    spawned,
    d: globalThis.__cdbCuDecision,
    ann: globalThis.__cdbCuWaylandAnnounce,
    tpmAccess: () => fsP.tpmAccess,
    settleTpm: async () => {
      tpmSettle();
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    },
  };
}

const remoteLines = (r) => r.diag.filter((l) => l.startsWith("[claude-cu] remote device:"));
const ANN = (b) => `[claude-cu] remote device: computer tools announced on Wayland (${b})`;
const NOT_ANN = "[claude-cu] remote device: computer tools not announced on Wayland (no first-party bridge usable on this session)";

console.log("\n[5] the real preamble: decision table");
const TABLE = [
  // label, opts, want {mode, wayland, backend, bin, override, target, announce}
  ["KDE Wayland 6.6 + kwin-portal-bridge", { host: "kde" },
    { mode: "kwin-wayland", wayland: true, backend: "kwin-portal-bridge", bin: "/res/kwin-portal-bridge", override: null, target: null, announce: true }],
  ["sway + wlroots-bridge", { host: "sway" },
    { mode: "regular", wayland: true, backend: "wlroots-bridge", bin: "/res/wlroots-bridge", override: null, target: null, announce: true }],
  ["GNOME Wayland + gnome-portal-bridge", { host: "gnome" },
    { mode: "regular", wayland: true, backend: "gnome-portal-bridge", bin: "/res/gnome-portal-bridge", override: null, target: null, announce: true }],
  ["background x11 :99 on sway", { host: "sway", cfg: { enabled: true, kind: "x11", display: ":99" } },
    { mode: "regular", wayland: true, backend: "x11-bridge", bin: "/res/x11-bridge", override: null, target: '{"kind":"x11","display":":99"}', announce: true }],
  ["background wlroots on GNOME (not a wlroots session)", { host: "gnome", cfg: { enabled: true, kind: "wlroots", display: "wayland-9" } },
    { mode: "regular", wayland: true, backend: "wlroots-bridge", bin: "/res/wlroots-bridge", override: null, target: '{"kind":"wlroots","display":"wayland-9"}', announce: true }],
  ["background x11 on KDE: forces regular, x11-bridge", { host: "kde", cfg: { enabled: true, kind: "x11", display: ":99" } },
    { mode: "regular", wayland: true, backend: "x11-bridge", bin: "/res/x11-bridge", override: null, target: '{"kind":"x11","display":":99"}', announce: true }],
  ["background display invalid", { host: "sway", cfg: { enabled: true, kind: "nope", display: ":99" } },
    { mode: "regular", wayland: true, backend: "none", bin: null, override: null, target: "invalid", announce: false }],
  ["background x11, x11-bridge cannot run", { host: "sway", cfg: { enabled: true, kind: "x11", display: ":99" }, bad: ["x11-bridge"] },
    { mode: "regular", wayland: true, backend: "none", bin: null, override: null, target: '{"kind":"x11","display":":99"}', announce: false }],
  ["exotic Wayland (XWayland x11-bridge only)", { host: "exotic" },
    { mode: "regular", wayland: true, backend: "fallback", bin: null, override: null, target: null, announce: false }],
  ["X11 session + x11-bridge", { host: "x11" },
    { mode: "regular", wayland: false, backend: "x11-bridge", bin: "/res/x11-bridge", override: null, target: null, announce: false }],
  ["X11 session, no x11-bridge", { host: "x11", missing: ["x11-bridge"] },
    { mode: "regular", wayland: false, backend: "none", bin: null, override: null, target: null, announce: false }],
  ["sway, wlroots-bridge cannot run (XWayland left)", { host: "sway", bad: ["wlroots-bridge"] },
    { mode: "regular", wayland: true, backend: "fallback", bin: null, override: null, target: null, announce: false }],
  ["sway, wlroots-bridge and x11-bridge cannot run", { host: "sway", bad: ["wlroots-bridge", "x11-bridge"] },
    { mode: "regular", wayland: true, backend: "none", bin: null, override: null, target: null, announce: false }],
  ["GNOME, gnome-portal-bridge cannot run", { host: "gnome", bad: ["gnome-portal-bridge"] },
    { mode: "regular", wayland: true, backend: "fallback", bin: null, override: null, target: null, announce: false }],
  ["KDE, kwin-portal-bridge cannot run (spectacle tier)", { host: "kde", bad: ["kwin-portal-bridge"] },
    { mode: "regular", wayland: true, backend: "fallback", bin: null, override: null, target: null, announce: false }],
  ["KDE with CLAUDE_CU_MODE=regular", { host: "kde", env: { CLAUDE_CU_MODE: "regular" } },
    { mode: "regular", wayland: true, backend: "fallback", bin: null, override: null, target: null, announce: false }],
  ["sway, WLROOTS_BRIDGE_BIN override that runs", { host: "sway", env: { WLROOTS_BRIDGE_BIN: "/opt/wl/wlroots-bridge" }, extraBins: ["/opt/wl/wlroots-bridge"] },
    { mode: "regular", wayland: true, backend: "wlroots-bridge", bin: "/opt/wl/wlroots-bridge", override: "WLROOTS_BRIDGE_BIN", target: null, announce: true }],
  ["sway, WLROOTS_BRIDGE_BIN=/nonexistent (the executor would use it)", { host: "sway", env: { WLROOTS_BRIDGE_BIN: "/nonexistent" } },
    { mode: "regular", wayland: true, backend: "fallback", bin: null, override: null, target: null, announce: false }],
  ["XDG_SESSION_TYPE=x11 with WAYLAND_DISPLAY set (upstream: not Wayland)", { host: "x11", env: { WAYLAND_DISPLAY: "wayland-0" } },
    { mode: "regular", wayland: false, backend: "x11-bridge", bin: "/res/x11-bridge", override: null, target: null, announce: false }],
];
for (const [label, opts, w] of TABLE) {
  const r = await runPreamble({ tpm: "ENOENT", ...opts });
  const d = r.d || {};
  check(`${label}: no error`, r.error === null, true);
  check(`${label}: v`, d.v, 1);
  check(`${label}: mode`, d.mode, w.mode);
  check(`${label}: wayland`, d.wayland, w.wayland);
  check(`${label}: backend`, d.backend, w.backend);
  check(`${label}: bin`, d.bin, w.bin);
  check(`${label}: override`, d.override, w.override);
  const tgt = d.target && d.target.invalid !== undefined ? (typeof d.target.invalid === "string" && d.target.invalid ? "invalid" : "invalid-empty") : JSON.stringify(d.target);
  check(`${label}: target`, tgt, w.target === null ? "null" : w.target);
  check(`${label}: announceWayland`, d.announceWayland, w.announce);
  check(`${label}: __cdbCuWaylandAnnounce === announceWayland`, r.ann, w.announce);
  check(`${label}: frozen (and its target)`, Object.isFrozen(d) && (d.target === null || Object.isFrozen(d.target)), true);
  const lines = remoteLines(r);
  const wantLines = !w.wayland ? [] : [w.announce ? ANN(w.backend) : NOT_ANN];
  check(`${label}: remote-device log line`, JSON.stringify(lines), JSON.stringify(wantLines));
  if (label.startsWith("background wlroots on GNOME")) {
    check(`${label}: the target's wlroots-bridge was probed`, r.spawned.includes("wlroots-bridge --version"), true);
    check(`${label}: wlroots global not set off a wlroots session`, globalThis.__cuWlrootsBridgeBin, undefined);
  }
  if (label.startsWith("KDE Wayland 6.6")) check(`${label}: decision follows the [claude-cu] mode= line`, r.diag.findIndex((l) => l.startsWith("[claude-cu] mode=")) < r.diag.indexOf(lines[0]), true);
  await r.settleTpm();
}

console.log("\n[5b] set once per process, never re-assigned");
{
  const r1 = await runPreamble({ host: "sway", tpm: "ENOENT" });
  const first = r1.d;
  await r1.settleTpm();
  const r2 = await runPreamble({ host: "exotic", tpm: "ENOENT", keep: true });
  check("second evaluation keeps the first decision object", r2.d === first, true);
  check("second evaluation keeps announce true", r2.ann, true);
  check("second evaluation logs no second remote-device line", remoteLines(r2).length, 0);
  try {
    first.announceWayland = false; // strict-mode module: throws on a frozen object
  } catch {}
  check("frozen: a write does not change announceWayland", first.announceWayland, true);
  await r2.settleTpm();
}

console.log("\n[5c] a preamble that throws");
for (const [label, host, wantLine] of [
  ["Wayland", "sway", [NOT_ANN]],
  ["X11", "x11", []],
]) {
  const r = await runPreamble({ host, tpm: "ENOENT", throwOn: "child_process" });
  check(`${label}: the error still reaches the caller`, r.error && /boom: child_process/.test(r.error.message), true);
  check(`${label}: decision set, backend none`, r.d && r.d.backend, "none");
  check(`${label}: announceWayland false`, r.d && r.d.announceWayland, false);
  check(`${label}: __cdbCuWaylandAnnounce === false`, r.ann, false);
  check(`${label}: bin / override / target null`, r.d && r.d.bin === null && r.d.override === null && r.d.target === null, true);
  check(`${label}: frozen`, Object.isFrozen(r.d), true);
  check(`${label}: wayland per upstream's rule`, r.d && r.d.wayland, host === "sway");
  check(`${label}: log line`, JSON.stringify(remoteLines(r)), JSON.stringify(wantLine));
  await r.settleTpm();
}

console.log("\n[6] __cdbTpmAtStart");
for (const [code, state, wantCode, line] of [
  ["ok", "ok", null, "[claude-cu] device key: /dev/tpmrm0 ok"],
  ["EACCES", "denied", "EACCES", "[claude-cu] device key: /dev/tpmrm0 not accessible (EACCES)"],
  ["EPERM", "denied", "EPERM", "[claude-cu] device key: /dev/tpmrm0 not accessible (EPERM)"],
  ["ENOENT", "absent", null, "[claude-cu] device key: /dev/tpmrm0 absent"],
  ["EIO", "error", "EIO", "[claude-cu] device key: /dev/tpmrm0 not accessible (EIO)"],
]) {
  const r = await runPreamble({ host: "x11", tpm: code });
  check(`${code}: preamble did not wait for the TPM check`, globalThis.__cdbTpmAtStart, undefined);
  check(`${code}: access(/dev/tpmrm0, R_OK|W_OK)`, JSON.stringify(r.tpmAccess()), JSON.stringify(["/dev/tpmrm0", 6]));
  await r.settleTpm();
  const t = globalThis.__cdbTpmAtStart || {};
  check(`${code}: state`, t.state, state);
  check(`${code}: code`, t.code, wantCode);
  check(`${code}: frozen`, Object.isFrozen(globalThis.__cdbTpmAtStart), true);
  const tl = r.diag.filter((l) => l.startsWith("[claude-cu] device key:"));
  check(`${code}: one log line`, JSON.stringify(tl), JSON.stringify([line]));
}

console.log("\n[7] __cdbCuDecide as a pure table");
{
  await runPreamble({ host: "x11", tpm: "ENOENT" });
  const D = globalThis.__cdbCuDecide;
  check("__cdbCuDecide exported", typeof D, "function");
  const W = { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" };
  const cases = [
    ["kwin mode forced, no kwin bin -> none", { env: W, mode: "kwin-wayland", bins: {} }, "none", false],
    ["kwin mode with bin", { env: W, mode: "kwin-wayland", bins: { kwin: "/k" } }, "kwin-portal-bridge", true],
    ["no XDG_SESSION_TYPE, WAYLAND_DISPLAY set -> Wayland", { env: { WAYLAND_DISPLAY: "w" }, mode: "regular", bins: { wlroots: "/w" }, wlrootsSession: true }, "wlroots-bridge", true],
    ["XDG_SESSION_TYPE=tty + WAYLAND_DISPLAY -> upstream not Wayland, executor Wayland", { env: { XDG_SESSION_TYPE: "tty", WAYLAND_DISPLAY: "w" }, mode: "regular", bins: { x11: "/x" } }, "fallback", false],
    ["x11 bin on Wayland without target -> fallback", { env: W, mode: "regular", bins: { x11: "/x" } }, "fallback", false],
    ["GNOME override GNOME_PORTAL_BRIDGE_BIN used", { env: { ...W, GNOME_PORTAL_BRIDGE_BIN: "/g" }, mode: "regular", bins: { gnome: "/g" }, gnomeSession: true }, "gnome-portal-bridge", true],
    ["target wins over kwin mode input", { env: W, mode: "regular", target: { kind: "wlroots", display: "/run/x/w" }, bins: { wlroots: "/w", kwin: "/k" } }, "wlroots-bridge", true],
    ["empty input", undefined, "none", false],
  ];
  for (const [label, input, backend, ann] of cases) {
    const d = D(input);
    check(`${label}: backend`, d.backend, backend);
    check(`${label}: announceWayland`, d.announceWayland, ann);
  }
  const o = D({ env: { ...W, GNOME_PORTAL_BRIDGE_BIN: "/g" }, mode: "regular", bins: { gnome: "/g" }, gnomeSession: true });
  check("override named when the env value won", o.override, "GNOME_PORTAL_BRIDGE_BIN");
  check(
    "keys exactly the contract's",
    JSON.stringify(Object.keys(o)),
    JSON.stringify(["v", "mode", "wayland", "backend", "bin", "override", "target", "announceWayland"])
  );
  const env = { ...W };
  D({ env, mode: "regular", bins: {} });
  check("pure: input env untouched", JSON.stringify(env), JSON.stringify(W));
}
for (const k of GLOBALS) delete globalThis[k];

console.log("");
if (failures.length) {
  console.log(`${failures.length} CHECK(S) FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
if (skipped) {
  console.log(`${pass} checks passed; real-bundle sections SKIPPED`);
  process.exit(SKIP_EXIT);
}
console.log("ALL " + pass + " CHECKS PASSED");
