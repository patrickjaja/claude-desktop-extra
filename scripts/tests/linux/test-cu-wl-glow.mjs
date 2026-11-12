#!/usr/bin/env node
// Computer Use glow + drawn cursor on Wayland rows (sub-patches 10e-10h of
// fix_computer_use_linux.nim, js/cu_wl_glow.js, the executor's overlay row
// and drawn-pointer wiring in js/cu_linux_executor.js, the glow switch).
//
// WHY THIS EXISTS
// ---------------
// Upstream never creates its glow window on a Wayland session
// (CLICK_THROUGH_WINDOWS = !isWayland()). 10e-10g hand upstream's glow show /
// hide / display setter to js/cu_wl_glow.js first, which draws the glow (and,
// with flag 1916550538, the rim and the drawn arrow) through `<bridge>
// overlay`, a long-lived child speaking the cu-overlay protocol v1. 10h
// exposes upstream's glide planner so the arrow moves like upstream's.
//
// This harness pins:
//   [1] the patch: 10e-10h apply with the full counter, are idempotent, each
//       one missing is refused as half-patched, the changed chunks pass
//       node --check, the module is embedded once.
//   [2] the REAL patched upstream glow functions (lock handler, show, hide,
//       display setter, glow switch, getter, resolver) and the REAL glide
//       planner in vm, driven like upstream drives them, with the REAL
//       executor and the REAL module and a FAKE overlay child (a node script
//       speaking the protocol, knobs: delay ready, never ready, die on glide,
//       fatal error):
//       glow by default on a wlroots row with the capability; flag off ->
//       look "glow", no arrow, live() false, showPointerTravel false at once;
//       flag on -> look "rim" and the exact command sequence for move, click,
//       mouseDown/mouseUp, drag, scroll on a second output with an offset and
//       a fractional scale; glideTo's remaining time decreasing and matching
//       the planner's frames; display switch -> move; lock release -> hide,
//       stdin closed, child gone; a direct spawn (no shell, no wrapper: the
//       child's parent is this process) with CLAUDE_CU_PARENT_PID; child
//       death mid-glide never delays or fails input, one respawn then off with
//       one diag line; fatal error -> off without respawn; delayed / missing
//       ready; no child at all without the capability, on X11, with the regular
//       executor in kwin mode,
//       on a background display, with the glow switch off.
//   [4] KDE Plasma Wayland (kwin mode): the REAL js/executor_linux.js with a
//       bridge that announces capabilities.overlay + session_overlay_opt_out
//       (doctor before session-start, KWIN_PORTAL_BRIDGE_SESSION_OVERLAY=0 on
//       every session-start of the lock, the overlay spawned once the decision
//       lands, the drawn pointer fed like the wlroots rows, no capture round
//       trip), with older bridges (no variable, no child, upstream's show kept
//       off through __cdbCuGlowOff even where it could draw) and with the glow
//       switch off (no glow of either kind where the bridge can opt out).
//   [3] X11: with the switch on, upstream's glow show / hide / display setter
//       behave exactly as the pristine functions (call traces compared); with
//       the switch off upstream's Electron glow is not shown.
// Sections need the compiled patch binary and the extract (else SKIP, exit 3).
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, rmSync, accessSync, constants, chmodSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import * as realCp from "node:child_process";
import path from "node:path";
import os from "node:os";
import util from "node:util";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..", "..");
const EXECUTOR = path.join(repo, "js", "cu_linux_executor.js");
const MODULE = path.join(repo, "js", "cu_wl_glow.js");
const PATCH_SRC = path.join(repo, "patches", "linux", "fix_computer_use_linux.nim");
const PATCH_BIN = process.env.CDB_CU_PATCH_BIN || path.join(repo, "patches", "linux", "fix_computer_use_linux");
const BUILD_DIR = path.join(process.env.CDB_BUNDLE_DIR || path.join(repo, "tmp", "app.asar.contents"), ".vite", "build");
const EXPECTED_PATCHES = Number(/const EXPECTED_PATCHES = (\d+)/.exec(readFileSync(PATCH_SRC, "utf8"))[1]);

let pass = 0;
const failures = [];
function check(label, actual, expected) {
  if (actual === expected) { console.log(`  PASS ${label} -> ${actual}`); pass++; }
  else { console.log(`  FAIL ${label} -> got ${actual}, expected ${expected}`); failures.push(label); }
}
const J = (x) => JSON.stringify(x);
const esc = (x) => x.replace(/[$]/g, "\\$");
const countRe = (hay, re) => (hay.match(new RegExp(re.source, "g")) || []).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(10); } return !!fn(); }

let haveBin = true;
try { accessSync(PATCH_BIN, constants.X_OK); } catch { haveBin = false; }
if (!haveBin || !existsSync(path.join(BUILD_DIR, "index.js"))) {
  console.log("\n  SKIP: " + (haveBin ? "no extract under tmp/app.asar.contents/" : `${PATCH_BIN} is not compiled`));
  process.exit(3);
}

const scratch = mkdtempSync(path.join(os.tmpdir(), "cdb-cu-wl-glow-"));
const SPLIT_RE = /\n\/\*__CDB_SPLIT__([^*\n]+?)__\*\/\n/;
function splitParts(blob) {
  const pieces = blob.split(SPLIT_RE);
  const names = ["index.js"], bodies = [pieces[0]];
  for (let i = 1; i < pieces.length; i += 2) { names.push(pieces[i]); bodies.push(pieces[i + 1]); }
  return { names, bodies };
}
// Source of `function NAME(` with balanced braces; skips '...' / "..." / `...` strings.
function fnSource(s, name) {
  const start = s.indexOf("function " + name + "(");
  if (start < 0) return null;
  let depth = 0, q = null;
  for (let i = s.indexOf("{", start); i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === "\\") { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

// ── The fake overlay child ────────────────────────────────────────────────
// Logs every stdin line (and its own start: argv, parent pid, env) as JSON
// lines to $FAKE_OVL_LOG; answers like the cu-overlay crate. Knobs (env, read
// at spawn): FAKE_OVL_MODE = normal | delay | silent | die-on-glide | fatal,
// FAKE_OVL_DELAY (ms, for delay), FAKE_OVL_OUTPUTS (JSON).
const FAKE = path.join(scratch, "fake-bridge");
writeFileSync(FAKE, `#!${process.execPath}
const fs = require("fs");
const log = (o) => fs.appendFileSync(process.env.FAKE_OVL_LOG, JSON.stringify(o) + "\\n");
const mode = process.env.FAKE_OVL_MODE || "normal";
const outputs = JSON.parse(process.env.FAKE_OVL_OUTPUTS || "[]");
log({ start: true, argv: process.argv.slice(2), ppid: process.ppid, parentEnv: process.env.CLAUDE_CU_PARENT_PID || null, mode, pid: process.pid });
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (process.argv[2] !== "overlay") { process.stderr.write("usage\\n"); process.exit(2); }
const scopes = JSON.parse(process.env.FAKE_OVL_SCOPES || '["all","cursor"]');
const ready = () => out({ event: "ready", protocol: 1, backend: "layer-shell", alphaModifier: true, fractionalScale: true, badge: process.env.FAKE_OVL_BADGE === "true", captureScopes: scopes, outputs });
if (mode === "fatal") { out({ event: "error", message: "no wlr-layer-shell on this compositor", fatal: true }); process.exit(2); }
if (mode === "delay") setTimeout(ready, +process.env.FAKE_OVL_DELAY || 300);
else if (mode !== "silent") ready();
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    log({ pid: process.pid, cmd: m, t: Date.now() });
    if (m.cmd === "capture" && process.env.FAKE_OVL_NOACK !== "1") out({ event: "ack", id: m.id });
    if (m.cmd === "show" || m.cmd === "move") { const ev = { event: "shown", output: m.output, scale: 1 }; if (process.env.FAKE_OVL_SHOWN_DELAY) setTimeout(() => out(ev), +process.env.FAKE_OVL_SHOWN_DELAY); else out(ev); }
    if (m.cmd === "hide") out({ event: "hidden" });
    if (m.cmd === "glide" && mode === "die-on-glide") { log({ pid: process.pid, died: true }); process.exit(1); }
  }
});
process.stdin.on("end", () => { log({ pid: process.pid, eof: true }); process.exit(0); });
`);
chmodSync(FAKE, 0o755);
const LOG = path.join(scratch, "overlay.log");
process.env.FAKE_OVL_LOG = LOG;
const readLog = () => { try { return readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const cmds = () => readLog().filter((x) => x.cmd).map((x) => x.cmd);
const starts = () => readLog().filter((x) => x.start);
const resetLog = () => writeFileSync(LOG, "");

// ── Displays: two outputs, the second at x=1920 with a fractional scale ───
const R = (x, y, width, height) => ({ x, y, width, height });
const disp = (id, label, b, sf = 1) => ({ id, label, bounds: b, size: { width: b.width, height: b.height }, workArea: b, scaleFactor: sf });
const TWO = [disp(101, "DP-1", R(0, 0, 1920, 1080)), disp(202, "HDMI-A-1", R(1920, 0, 1707, 960), 1.5)];
TWO.primaryIdx = 0;
const OUTPUTS = [{ name: "DP-1", x: 0, y: 0, width: 1920, height: 1080, scale: 1 }, { name: "HDMI-A-1", x: 1920, y: 0, width: 1707, height: 960, scale: 1.5 }];
process.env.FAKE_OVL_OUTPUTS = J(OUTPUTS);
function makeScreen(displays) {
  const s = {
    displays,
    getAllDisplays: () => s.displays,
    getPrimaryDisplay: () => s.displays[s.displays.primaryIdx || 0],
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayMatching: () => s.displays[s.displays.primaryIdx || 0],
    getDisplayNearestPoint: () => s.displays[s.displays.primaryIdx || 0],
  };
  return s;
}

// ── Real executor + real module, stubbed input bridge ─────────────────────
const bridgeLog = [];
const diagLines = [];
const spawnCalls = [];
const DOCTOR_WL = (overlay) => ({ contract: 1, bridge: "wlroots-bridge", version: "0.3.0", backend: "wlroots", session_match: true, backend_reachable: true, compositor: "sway", window_geometry: true, screenshot_mask: true, capabilities: overlay === "absent" ? {} : { overlay, overlay_alpha_modifier: true, overlay_fractional_scale: true } });
const DOCTOR_X11 = { contract: 1, bridge: "x11-bridge", version: "0.1.0", backend: "x11", session_match: true, backend_reachable: true, capabilities: { screenshot_mask: true, compositing: true } };
const asyncLog = [];
const zoomLog = [];
function load({ session = "wayland", desktop = "sway", wlroots = true, overlay = true, kwin = false, target = null, glow = true, displays = TWO, doctorDelay = 0, screens = null, zoom = null, zoomDelay = 0 } = {}) {
  zoomLog.length = 0;
  asyncLog.length = 0;
  let screensCalls = 0;
  const screen = makeScreen(displays);
  bridgeLog.length = 0; diagLines.length = 0; spawnCalls.length = 0;
  const cp = {
    execFileSync(bin, args) { bridgeLog.push(path.basename(String(bin)) + " " + args.join(" ")); return "{}"; },
    execSync() { throw new Error("nope"); },
    spawnSync() { return { status: 1 }; },
    execFile(bin, args, opts, cb) {
      const c = typeof opts === "function" ? opts : cb;
      if (args && args[0] === "doctor") {
        const d = path.basename(String(bin)) === "x11-bridge" ? DOCTOR_X11 : DOCTOR_WL(overlay);
        setTimeout(() => c(null, J(d), ""), doctorDelay);
        return { on() {} };
      }
      asyncLog.push(path.basename(String(bin)) + " " + (args || []).join(" "));
      if (screens && args && args[0] === "screens") { const l = screens(++screensCalls); setTimeout(() => c(null, J(l), ""), 0); return { on() {} }; }
      if (zoom && args && args[0] === "zoom") {
        zoomLog.push({ t: Date.now(), p: performance.now() });
        const z = zoom(args);
        if (z === "hang") { let dead = false; return { on() {}, kill() { if (dead) return; dead = true; const e = new Error("Command failed: zoom"); e.killed = true; e.signal = "SIGTERM"; setTimeout(() => c(e, "", ""), 0); } }; }
        setTimeout(() => (z instanceof Error ? c(z, "", String(z.message)) : c(null, z, "")), zoomDelay);
        return { on() {}, kill() {} };
      }
      setTimeout(() => c && c(new Error("not found"), "", ""), 0); return { on() {} };
    },
    spawn() { return { on() {}, unref() {}, stdout: { on() {} }, stderr: { on() {} } }; },
  };
  const electron = {
    app: { commandLine: { getSwitchValue: () => "" }, getPath: () => os.tmpdir(), on() {} },
    BrowserWindow: { getAllWindows: () => [] },
    screen,
    desktopCapturer: { getSources: async () => [] },
    clipboard: { readText: () => "", writeText: () => {} },
    nativeImage: {},
    systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: globalThis.__testRM === true }) },
  };
  const fsStub = { readFileSync: () => Buffer.alloc(0), writeFileSync() {}, unlinkSync() {}, existsSync: () => false, renameSync() {}, accessSync() { throw new Error("no"); }, readdirSync: () => [], statSync: () => ({ isDirectory: () => false }), constants: { X_OK: 1 } };
  const reqEx = (id) => ({ child_process: cp, electron, path, os, fs: fsStub })[id] || (() => { throw new Error("unexpected require " + id); })();
  // The module gets the REAL child_process (spawn recorded, not replaced).
  const cpRec = { ...realCp, spawn: (cmd, args, opts) => { spawnCalls.push({ cmd, args, opts }); return realCp.spawn(cmd, args, opts); } };
  const reqMod = (id) => ({ child_process: cpRec, electron })[id] || (() => { throw new Error("unexpected require " + id); })();
  globalThis.__cdbDiag = (m) => diagLines.push(String(m));
  globalThis.__cuX11BridgeBin = "/res/x11-bridge";
  delete globalThis.__cuGnomeBridgeBin; delete globalThis.__cuWlrootsBridgeBin;
  globalThis.__cuKwinMode = kwin;
  if (target) globalThis.__cuTargetRead = () => target; else delete globalThis.__cuTargetRead;
  globalThis.__cdbCuGlowEnabled = () => glow;
  process.env.XDG_CURRENT_DESKTOP = desktop;
  process.env.XDG_SESSION_TYPE = session;
  if (session === "wayland") process.env.WAYLAND_DISPLAY = "wayland-1"; else delete process.env.WAYLAND_DISPLAY;
  for (const k of ["SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE", "NIRI_SOCKET", "COWORK_SCREENSHOT_CMD", "X11_BRIDGE_BIN", "YDOTOOL_SOCKET", "WLROOTS_BRIDGE_BIN", "GNOME_PORTAL_BRIDGE_BIN"]) delete process.env[k];
  if (wlroots) { process.env.SWAYSOCK = "/run/user/1000/sway-ipc.sock"; process.env.WLROOTS_BRIDGE_BIN = FAKE; }
  for (const k of ["__cdbCuElectronDisplayId", "__cdbCuGlowOff", "__linuxExecutor", "__cdbCuWlGlow", "__cdbCuDrawnPointer"]) delete globalThis[k];
  new Function("require", "process", readFileSync(EXECUTOR, "utf8"))(reqEx, process);
  new Function("require", "process", readFileSync(MODULE, "utf8"))(reqMod, process);
  return { screen, ex: globalThis.__linuxExecutor, glow: globalThis.__cdbCuWlGlow };
}

const noop = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive || k === "then" ? undefined : noop), apply: () => undefined });
function scopeFor(declared, preset) {
  const t = { ...preset };
  return new Proxy(t, {
    has: (o, k) => typeof k === "string" && (k in o || (!declared.has(k) && !(k in globalThis))),
    get: (o, k) => (k in o ? o[k] : k === Symbol.unscopables ? undefined : noop),
    set: (o, k, v) => { o[k] = v; return true; },
  });
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

try {
  // ── [1] the patch ──────────────────────────────────────────────────────
  console.log("\n[1] 10e-10h: apply, idempotency, Rule 6");
  let blob = readFileSync(path.join(BUILD_DIR, "index.js"), "utf8");
  for (const c of readdirSync(BUILD_DIR).filter((d) => /^index.*\.chunk-.*\.js$/.test(d)).sort()) blob += "\n/*__CDB_SPLIT__" + c + "__*/\n" + readFileSync(path.join(BUILD_DIR, c), "utf8");
  const staged = path.join(scratch, "staged_index.js");
  writeFileSync(staged, blob);
  const run = (f) => { const r = spawnSync(PATCH_BIN, [f], { encoding: "utf8" }); return { status: r.status, out: String(r.stdout || "") + String(r.stderr || "") }; };
  const r1 = run(staged);
  check("first run exits 0", r1.status, 0);
  check(`[PASS] ${EXPECTED_PATCHES}/${EXPECTED_PATCHES}`, r1.out.includes(`[PASS] ${EXPECTED_PATCHES}/${EXPECTED_PATCHES} sub-patches applied`), true);
  for (const k of ["10e glow show", "10f glow hide", "10g glow display setter", "10h glide planner"]) check(`${k} reported [OK]`, new RegExp("\\[OK\\] " + k + " ").test(r1.out), true);
  if (r1.status !== 0) console.log(r1.out);
  const patched = readFileSync(staged, "utf8");
  const r2 = run(staged);
  check("second run: idempotent, no change", r2.status === 0 && readFileSync(staged, "utf8") === patched, true);
  const SHOW_RE = /function ([\w$]+)\(([\w$]+)\)\{if\(process\.platform==="linux"&&globalThis\.__cdbCuWlGlow\?\.show\?\.\(\2,([\w$]+),([\w$]+)\)===!0\)return Promise\.resolve\(\);if\(!([\w$]+)\|\|/;
  const HIDE_RE = /function ([\w$]+)\(\)\{process\.platform==="linux"&&globalThis\.__cdbCuWlGlow\?\.hide\?\.\(\);if\(\+\+([\w$]+),([\w$]+)\(\),!([\w$]+)\|\|/;
  const DISP_RE = /function ([\w$]+)\(([\w$]+)\)\{([\w$]+)=\2\?\?null,process\.platform==="linux"&&globalThis\.__cdbCuWlGlow\?\.display\?\.\(([\w$]+)\),/;
  const PLAN_RE = /process\.platform==="linux"&&\(globalThis\.__cdbCuGlidePlan=\{plan:([\w$]+),frameMs:\(\)=>([\w$]+)\.frameMs\}\);function \1\(/;
  for (const [n, re] of [["10e", SHOW_RE], ["10f", HIDE_RE], ["10g", DISP_RE], ["10h", PLAN_RE]]) check(`${n} injected once`, countRe(patched, re), 1);
  check("module embedded once", patched.split("globalThis.__cdbCuWlGlow={").length - 1, 1);
  const [, showFn, , getter, flagFn, ct] = SHOW_RE.exec(patched) || [];
  const [, hideFn, , , winVar] = HIDE_RE.exec(patched) || [];
  const [, dispFn] = DISP_RE.exec(patched) || [];
  const [, planFn, cfgVar] = PLAN_RE.exec(patched) || [];
  const after = splitParts(patched);
  const ci = after.bodies.findIndex((b) => SHOW_RE.test(b));
  const pi = after.bodies.findIndex((b) => PLAN_RE.test(b));
  check("show, hide, display setter in one chunk", ci >= 0 && HIDE_RE.test(after.bodies[ci]) && DISP_RE.test(after.bodies[ci]), true);
  for (const idx of new Set([ci, pi, 0])) {
    if (idx < 0) continue;
    const f = path.join(scratch, "check-" + after.names[idx]);
    writeFileSync(f, after.bodies[idx]);
    let okc = true;
    try { execFileSync("node", ["--check", f], { stdio: "pipe" }); } catch { okc = false; }
    check(`node --check ${after.names[idx]}`, okc, true);
  }
  // Rule 6: a bundle without any one of them is half-patched.
  const strip = {
    "10e glow show to the Wayland overlay": (s) => s.replace(/if\(process\.platform==="linux"&&globalThis\.__cdbCuWlGlow\?\.show\?\.\([\w$]+,[\w$]+,[\w$]+\)===!0\)return Promise\.resolve\(\);/, ""),
    "10f glow hide to the Wayland overlay": (s) => s.replace('process.platform==="linux"&&globalThis.__cdbCuWlGlow?.hide?.();', ""),
    "10g glow display to the Wayland overlay": (s) => s.replace(/process\.platform==="linux"&&globalThis\.__cdbCuWlGlow\?\.display\?\.\([\w$]+\),/, ""),
    "10h glide planner for the Linux executor": (s) => s.replace(/process\.platform==="linux"&&\(globalThis\.__cdbCuGlidePlan=\{[^}]*\}\);/, ""),
  };
  for (const [name, f] of Object.entries(strip)) {
    const half = path.join(scratch, "half.js");
    const mutated = f(patched);
    writeFileSync(half, mutated);
    const r = run(half);
    check(`without ${name.slice(0, 3)}: refused as half-patched`, mutated !== patched && r.status !== 0 && r.out.includes("half-patched input") && r.out.includes(name), true);
  }
  // A moved anchor fails loud: the show with its flag read renamed away.
  {
    const mut = blob.replace(/\(([\w$]+)\?\.claudeHasThePointer\?\?!0\)&&/, "($1?.claudeHasThePointer??!1)&&");
    const f = path.join(scratch, "moved.js");
    writeFileSync(f, mut);
    const r = run(f);
    check("moved show anchor: [FAIL] 10e, no [PASS]", mut !== blob && r.status !== 0 && /\[FAIL\] 10e/.test(r.out) && !/\[PASS\]/.test(r.out), true);
  }

  // ── The real upstream functions + planner in vm ────────────────────────
  const chunk = after.bodies[ci] || "";
  const pristineChunk = splitParts(blob).bodies.find((b) => b.includes("function " + showFn + "(")) || "";
  // Upstream's glow lock handler, unchanged (no kwin-mode early return: kwin
  // mode reaches the overlay too, see [4]).
  const lockFn = (/function ([\w$]+)\([\w$]+,[\w$]+\)\{[\w$]+\.on\("cuLockChanged",\(\(\{holder:[\w$]+\}\)=>\{if\([\w$]+\)\{let [\w$]+=/.exec(chunk) || [])[1];
  check("upstream's glow lock handler registers in every mode (no kwin early return)", /__cuKwinMode\)return;[\w$]+(?:\.[\w$]+)*\.on\(["`]cuLockChanged/.test(patched), false);
  const switchFn = (new RegExp("function ([\\w$]+)\\(([\\w$]+),([\\w$]+)\\)\\{\\2===([\\w$]+)\\.currentHolder&&" + esc(dispFn || "\u0000") + "\\(").exec(chunk) || []);
  const resolverFn = (new RegExp("function " + esc(getter || "\u0000") + "\\(\\)\\{return ([\\w$]+)\\(").exec(chunk) || [])[1];
  const scrN = (new RegExp("function " + esc(resolverFn || "\u0000") + "\\([\\w$]+\\)\\{return [\\w$]+===null\\?([\\w$]+)\\.screen").exec(chunk) || [])[1];
  const showSrcP = fnSource(chunk, showFn) || "";
  const busyN = (/let [\w$]+=\+\+[\w$]+;([\w$]+)\(!0\);/.exec(showSrcP) || [])[1];
  const genN = (/let [\w$]+=\+\+([\w$]+);/.exec(showSrcP) || [])[1];
  check("vm: lock handler, switch, getter, resolver, busy setter located", [lockFn, switchFn[1], resolverFn, scrN, busyN, genN].every(Boolean), true);
  function world(src, screen, { wayland, flag }) {
    const names = [lockFn, switchFn[1], dispFn, getter, resolverFn, showFn, hideFn];
    const srcs = names.map((n) => fnSource(src, n));
    if (srcs.some((x) => !x)) return null;
    const listeners = [];
    const trace = [];
    const holder = { currentHolder: undefined, on(ev, fn) { if (ev === "cuLockChanged") listeners.push(fn); } };
    const preset = {
      [scrN]: { screen }, [switchFn[4]]: holder, [winVar]: null, [ct]: !wayland, [flagFn]: () => flag, [genN]: 0,
      [busyN]: (v) => trace.push("busy " + v),
    };
    const scope = scopeFor(new Set(names), preset);
    const api = new Function("__scope", "with(__scope){" + srcs.join("\n") + "\nreturn{" + names.map((n) => J(n) + ":" + n).join(",") + "}}")(scope);
    return { api, listeners, holder, trace, scope };
  }
  // The planner from the patched chunk (config .. planner, with our assignment).
  {
    const pc = after.bodies[pi] || "";
    const cfg = new RegExp("var " + esc(cfgVar || "\u0000") + "=\\{baseMs:").exec(pc);
    const planSrc = fnSource(pc, planFn);
    const slice = cfg && planSrc ? pc.slice(cfg.index, pc.indexOf(planSrc) + planSrc.length) : "";
    const clampN = (/Math\.round\(([\w$]+)\([\w$]+\.baseMs\+/.exec(slice) || [])[1];
    const elbowN = (/\{elbow:[\w$]+\}=([\w$]+)/.exec(slice) || [])[1];
    const elbowSrc = elbowN && new RegExp("(?<![\\w$.])" + esc(elbowN) + "=\\{[^}]*elbow:\\{x:([\\d.]+),y:([\\d.]+)\\}").exec(pc);
    const clampSrc = clampN && (fnSource(pc, clampN) || fnSource(patched, clampN));
    check("planner slice located (config .. planner, our assignment inside)", !!slice && PLAN_RE.test(slice) && !!elbowSrc && !!clampSrc, true);
    delete globalThis.__cdbCuGlidePlan;
    const clamp = new Function(clampSrc + "\nreturn " + clampN + ";")();
    new Function("process", clampN, elbowN, slice)({ platform: "linux" }, clamp, { elbow: { x: +elbowSrc[1], y: +elbowSrc[2] } });
    check("10h: __cdbCuGlidePlan set at module load, frameMs 16", typeof globalThis.__cdbCuGlidePlan?.plan === "function" && globalThis.__cdbCuGlidePlan.frameMs() === 16, true);
  }
  const PLAN = globalThis.__cdbCuGlidePlan;

  // One Computer Use lock on a Wayland row: our lock hook first (as 4b), then
  // upstream's cuLockChanged handler with the session's selected display.
  async function rig(opts = {}) {
    resetLog();
    const { screen, ex, glow } = load(opts);
    const w = world(chunk, screen, { wayland: (opts.session || "wayland") === "wayland", flag: opts.flag === true });
    const mainWin = { isDestroyed: () => false, getBounds: () => ({ x: 10, y: 10, width: 100, height: 100 }) };
    w.api[lockFn]((sid) => (typeof opts.getSel === "function" ? opts.getSel(sid) : opts.selected === undefined ? 1 : opts.selected), mainWin);
    await sleep(5); // the doctor warmed at load answers
    const acquire = () => { w.holder.currentHolder = "s1"; ex.__setLockHeld(true, "s1").catch(() => {}); w.listeners.forEach((f) => f({ holder: "s1" })); };
    const release = () => { ex.__setLockHeld(false).catch(() => {}); w.holder.currentHolder = undefined; w.listeners.forEach((f) => f({ holder: undefined })); };
    return { ex, glow, w, screen, acquire, release };
  }
  const kinds = () => cmds().map((c) => c.cmd);
  const shown = (g) => waitFor(() => g.state().shown);

  // ── [2] Wayland rows ───────────────────────────────────────────────────
  console.log("\n[2] the glow on a wlroots row (real upstream functions, real executor, fake overlay)");
  {
    // Default: flag off -> the classic glow on the selected display.
    const r = await rig();
    r.acquire();
    check("lock: the overlay child spawned once", await waitFor(() => starts().length === 1), true);
    check("lock: upstream's busy flag untouched (its body skipped)", J(r.w.trace), "[]");
    await shown(r.glow);
    const st = starts()[0] || {};
    check("spawn: `<bridge> overlay`, the row's bridge", J(spawnCalls.map((c) => [c.cmd, c.args])), J([[FAKE, ["overlay"]]]));
    check("spawn: direct (no shell option, no wrapper)", spawnCalls.every((c) => !c.opts.shell && !c.opts.detached), true);
    check("spawn: the child's parent is this (main) process", st.ppid, process.pid);
    check("spawn: CLAUDE_CU_PARENT_PID is this process", st.parentEnv, String(process.pid));
    check("show: glow look on the selected display's output, badge, no arrow", J(cmds()[0]), J({ cmd: "show", output: "HDMI-A-1", look: "glow", badge: true, reducedMotion: false, arrow: null }));
    check("flag off: live() false", r.glow.pointer().live(), false);
    const t0 = performance.now();
    const spt = await r.ex.showPointerTravel(2500, 300, () => false);
    check("flag off: showPointerTravel false without delay", spt === false && performance.now() - t0 < 30, true);
    await r.ex.click(2500, 300, "left", 1);
    await sleep(30);
    check("flag off: no arrow commands at all", J(kinds()), J(["show"]));
    check("flag off: the click reached the bridge", bridgeLog.includes("fake-bridge pointer-click --x 2500 --y 300 --button left --count 1"), true);
    // Display switch (upstream's glow switch with our index 0).
    r.w.api[switchFn[1]]("s1", 0);
    await waitFor(() => kinds().includes("move"));
    check("display switch: move to DP-1", J(cmds().at(-1)), J({ cmd: "move", output: "DP-1" }));
    // Lock release: hide, stdin closed, child gone.
    const pid = st.pid;
    r.release();
    check("release: hide sent, stdin closed (EOF seen)", await waitFor(() => readLog().some((x) => x.eof)) && kinds().at(-1) === "hide", true);
    check("release: child exited", await waitFor(() => !pidAlive(pid)), true);
    check("release: state reset", J(r.glow.state()), J({ held: false, running: false, ready: false, shown: false, look: null, output: null, off: false }));
  }
  {
    // Flag on: rim + arrow, the exact sequence per action.
    const r = await rig({ flag: true });
    r.acquire();
    await shown(r.glow);
    check("flag on: show look rim, no arrow yet (no real pointer known)", J(cmds()[0]), J({ cmd: "show", output: "HDMI-A-1", look: "rim", badge: true, reducedMotion: false, arrow: null }));
    check("flag on: live() true once shown", r.glow.pointer().live(), true);
    resetLog();
    await r.ex.moveMouse(2100, 100);
    const t0 = performance.now();
    const spt = await r.ex.showPointerTravel(2500.4, 300.6, () => false);
    const travelMs = performance.now() - t0;
    await r.ex.click(2500.4, 300.6, "left", 1);
    await r.ex.mouseDown();
    await r.ex.moveMouse(2600, 400);
    await r.ex.mouseUp();
    await r.ex.drag({ x: 2000, y: 50 }, { x: 2100, y: 60 });
    await r.ex.scroll(2200, 200, 0, 3);
    await waitFor(() => cmds().length >= 8);
    const c = cmds();
    check("sequence: jump (first move), glide (travel), press (click), press (down), jump (held move), press+jump (drag), glide (scroll)",
      J(c.map((x) => x.cmd)), J(["jump", "glide", "press", "press", "jump", "press", "jump", "glide"]));
    check("move: arrow placed at the global point", J(c[0]), J({ cmd: "jump", x: 2100, y: 100 }));
    const plan = PLAN.plan({ x: 2100, y: 100 }, { x: 2500.4, y: 300.6 });
    const r2 = (v) => Math.round((+v || 0) * 100) / 100;
    check("travel: glide frames = upstream's planner frames (global coords)", J(c[1].frames), J(plan.frames.map((f) => [r2(f.x), r2(f.y), r2(f.deg), r2(f.lift)])));
    check("travel: frameMs 16", c[1].frameMs, 16);
    check(`travel: waited for the arrival (${Math.round(travelMs)} ms, plan ${plan.arriveMs})`, spt === true && travelMs >= plan.arriveMs - 20 && travelMs < plan.arriveMs + 120, true);
    check("click: press at the click point (second output, fractional)", J(c[2]), J({ cmd: "press", x: 2500.4, y: 300.6 }));
    check("mouseDown: press at the real pointer", J(c[3]), J({ cmd: "press", x: 2500.4, y: 300.6 }));
    check("held move: jump", J(c[4]), J({ cmd: "jump", x: 2600, y: 400 }));
    check("drag: press at the start, jump to the end", J([c[5], c[6]]), J([{ cmd: "press", x: 2000, y: 50 }, { cmd: "jump", x: 2100, y: 60 }]));
    check("scroll: glide to the target", J(c[7].frames.at(-1).slice(0, 2)), J([2200, 200]));
    check("bridge commands in global logical coords (rounded, as before)", J(bridgeLog.filter((x) => x.startsWith("fake-bridge "))), J([
      "fake-bridge pointer-move --x 2100 --y 100",
      "fake-bridge pointer-move --x 2500 --y 301",
      "fake-bridge pointer-click --x 2500 --y 301 --button left --count 1",
      "fake-bridge left-mouse-down",
      "fake-bridge pointer-move --x 2600 --y 400",
      "fake-bridge left-mouse-up",
      "fake-bridge pointer-drag --from-x 2000 --from-y 50 --to-x 2100 --to-y 60",
      "fake-bridge pointer-move --x 2200 --y 200",
      "fake-bridge pointer-scroll --x 2200 --y 200 --dx 0 --dy 3",
    ]));
    // glideTo's remaining time: decreasing, from the frame list's arrival.
    const p = r.glow.pointer();
    await sleep(1400); // the scroll's glide (arrival + settle frames) is over
    const to = { x: 3000, y: 700 };
    const from = { x: 2200, y: 200 };
    const want = PLAN.plan(from, to);
    const a = p.glideTo(to);
    await sleep(60);
    const b = p.glideTo(to);
    check(`glideTo: first answer = the plan's arriveMs (${want.arriveMs})`, a, want.arriveMs);
    check(`glideTo: re-asked later, less remains (${Math.round(b)} < ${a})`, b > 0 && b < a && b <= a - 40, true);
    await waitFor(() => cmds().filter((x) => x.cmd === "glide").length >= 3, 1000);
    await sleep(50);
    check("glideTo: the same target re-asked sends no second glide", cmds().filter((x) => x.cmd === "glide").length, 3);
    // Lock release stops the child.
    const pid = starts()[0] && readLog().find((x) => x.cmd) && starts()[0].pid;
    r.release();
    check("flag on: release -> child gone", await waitFor(() => readLog().some((x) => x.eof)), true);
    check("flag on: after release live() false and glideTo 0", p.live() === false && p.glideTo({ x: 1, y: 1 }) === 0, true);
    void pid;
  }
  {
    // Child death mid-glide: input never delayed, one respawn, then off.
    process.env.FAKE_OVL_MODE = "die-on-glide";
    const r = await rig({ flag: true });
    r.acquire();
    await shown(r.glow);
    await r.ex.moveMouse(2100, 100);
    let t0 = performance.now();
    const spt = await r.ex.showPointerTravel(2600, 500, () => false);
    await r.ex.click(2600, 500, "left", 1);
    const ms1 = performance.now() - t0;
    // Bounded by the first glide's planned arrival (the travel never waits
    // longer than the arrow it started), whatever the child does meanwhile.
    const firstArrive = PLAN.plan({ x: 2100, y: 100 }, { x: 2600, y: 500 }).arriveMs;
    check(`death mid-glide: travel + click within the planned arrival (${Math.round(ms1)} ms <= ${firstArrive} + 150)`, ms1 <= firstArrive + 150, true);
    check("death mid-glide: the click still reached the bridge", bridgeLog.includes("fake-bridge pointer-click --x 2600 --y 500 --button left --count 1"), true);
    void spt;
    check("one respawn", await waitFor(() => starts().length === 2), true);
    await shown(r.glow);
    check("respawn: the glow shown again", cmds().filter((x) => x.cmd === "show").length, 2);
    t0 = performance.now();
    await r.ex.scroll(2300, 300, 0, 2);
    check("second death: the scroll returns quickly", performance.now() - t0 < 200, true);
    await waitFor(() => r.glow.state().off);
    await sleep(200);
    check("second death: off for this lock, no third spawn", r.glow.state().off === true && starts().length === 2, true);
    check("second death: exactly one wl-glow diag line", diagLines.filter((m) => /wl-glow: .*overlay failed/.test(m)).length, 1);
    check("off: live() false, input goes on", r.glow.pointer().live(), false);
    r.release();
    // The next lock starts afresh.
    process.env.FAKE_OVL_MODE = "normal";
    resetLog();
    r.acquire();
    check("next lock: spawned again", await waitFor(() => starts().length === 1), true);
    r.release();
    await waitFor(() => readLog().some((x) => x.eof));
  }
  {
    // Fatal error (no layer-shell): off at once, no respawn.
    process.env.FAKE_OVL_MODE = "fatal";
    const r = await rig({ flag: true });
    r.acquire();
    await waitFor(() => r.glow.state().off);
    await sleep(100);
    check("fatal: one spawn, off", starts().length === 1 && r.glow.state().off, true);
    check("fatal: the line carries the overlay's message", diagLines.filter((m) => /wl-glow: .*overlay failed \(no wlr-layer-shell on this compositor/.test(m)).length, 1);
    r.release();
    // Delayed ready: the show waits for it, input does not.
    process.env.FAKE_OVL_MODE = "delay"; process.env.FAKE_OVL_DELAY = "400";
    const d = await rig({ flag: true });
    d.acquire();
    const t0 = performance.now();
    await d.ex.click(100, 100, "left", 1);
    check("delayed ready: a click meanwhile is not delayed", performance.now() - t0 < 50 && bridgeLog.includes("fake-bridge pointer-click --x 100 --y 100 --button left --count 1"), true);
    check("delayed ready: nothing sent before ready", kinds().length, 0);
    check("delayed ready: shown after ready", await shown(d.glow) && kinds()[0] === "show", true);
    d.release();
    await waitFor(() => readLog().some((x) => x.eof));
    // Never ready: killed after 3 s, one respawn, then off.
    process.env.FAKE_OVL_MODE = "silent";
    const s = await rig({ flag: true });
    s.acquire();
    check("never ready: off after two 3 s waits", await waitFor(() => s.glow.state().off, 8000) && starts().length === 2, true);
    check("never ready: one line names it", diagLines.filter((m) => /wl-glow: .*no ready line within 3 s/.test(m)).length, 1);
    s.release();
    process.env.FAKE_OVL_MODE = "normal";
  }
  {
    // Capability unknown at the show (doctor slow): starts once it says yes.
    const r = await rig({ doctorDelay: 150 });
    // load() warmed nothing (the executor does not probe at load on Wayland),
    // so the first show asks.
    r.acquire();
    check("capability answered late: spawned after the doctor's yes", await waitFor(() => starts().length === 1, 2000), true);
    r.release();
    await waitFor(() => readLog().some((x) => x.eof));
  }
  // ── The glow's output follows the display Computer Use works on ───────
  // The REAL Linux tool handler (js/cu_handler_injection.js) with a session
  // object shaped like upstream's (onCuDisplayPinned / onCuSelectedDisplayUpdated
  // store the id and emit cuSelectedDisplayChanged, whose listener is upstream's
  // glow switch; the lock handler reads the stored id at the lock).
  console.log("\n[2b] rim, arrow and input on the same output (switch_display, screenshot, auto-target)");
  const HSRC = readFileSync(path.join(repo, "js", "cu_handler_injection.js"), "utf8");
  const handler = new Function("__TOOL_NAME__", "__INPUT__", "__SESSION__", "__SELF__", "__STATE__", "__MAKE_DISPATCH__", "require", "return (async()=>{" + HSRC + "\n})()");
  const outputAt = (x, y) => (OUTPUTS.find((o) => x >= o.x && x < o.x + o.width && y >= o.y && y < o.y + o.height) || {}).name;
  const lastOutput = () => { const c = cmds().filter((x) => x.cmd === "show" || x.cmd === "move"); return c.length ? c[c.length - 1].output : null; };
  const lastClick = () => { const l = bridgeLog.filter((x) => /pointer-click/.test(x)).pop() || ""; const m = /--x (-?\d+) --y (-?\d+)/.exec(l); return m ? [+m[1], +m[2]] : null; };
  async function selRig() {
    const box = {};
    const sess = {
      sessionId: "s1", sel: undefined,
      getCuSelectedDisplayId() { return sess.sel; },
      onCuDisplayPinned(t) { sess.sel = t; box.r.w.api[switchFn[1]]("s1", t); },
      onCuSelectedDisplayUpdated(t) { sess.sel = t; box.r.w.api[switchFn[1]]("s1", t); },
      onCuScreenshotDimsUpdated() {},
      isAborted: () => false,
      checkCuLock() { return { holder: box.r.w.holder.currentHolder, isSelf: box.r.w.holder.currentHolder === "s1" }; },
      acquireCuLock() { if (box.r.w.holder.currentHolder === undefined) box.r.acquire(); },
    };
    box.r = await rig({ flag: true, getSel: () => sess.sel });
    // The capture itself is not under test here: a successful one of the
    // display asked for (the handler reports a display only after a capture).
    box.r.ex.screenshot = async (o) => {
      const m = (await box.r.ex.listDisplays()).find((d) => d.displayId === o.displayId);
      return { base64: "AA==", mimeType: "image/png", imgW: m.width, imgH: m.height, displayWidth: m.width, displayHeight: m.height, displayId: m.displayId, originX: m.originX, originY: m.originY };
    };
    globalThis.__cuPinnedDisplay = undefined; globalThis.__cuLastShot = null; globalThis.__cuActiveOrigin = { x: 0, y: 0 };
    // The handler's one require is electron (its own windows for the hit test).
    const H = (tool, input) => handler(tool, input, sess, {}, {}, null, (id) => { if (id === "electron") return { BrowserWindow: { getAllWindows: () => [] }, screen: box.r.screen }; throw new Error("unexpected require " + id); });
    return { ...box.r, sess, H };
  }
  const agree = (label) => {
    const c = lastClick(), o = lastOutput();
    check(`${label}: the glow's output (${o}) holds the click (${c})`, !!c && !!o && outputAt(c[0], c[1]) === o, true);
  };
  {
    // 1. switch_display BEFORE the lock (the live defect): the rim starts there.
    const r = await selRig();
    await r.H("switch_display", { display: "HDMI-A-1" });
    check("before the lock: no child yet (switch_display takes no lock)", starts().length, 0);
    check("before the lock: the session holds the pinned index 1", r.sess.sel, 1);
    await r.H("screenshot", {});
    await shown(r.glow);
    check("before the lock: show names HDMI-A-1", J(cmds().filter((x) => x.cmd === "show").map((x) => x.output)), J(["HDMI-A-1"]));
    const lc = await r.H("left_click", { coordinate: [100, 100] });
    if (!lastClick()) console.log("    left_click answered: " + J(lc));
    agree("before the lock");
    // 2. switch_display DURING the lock: move.
    await r.H("switch_display", { display: "DP-1" });
    check("during the lock: move to DP-1", await waitFor(() => lastOutput() === "DP-1"), true);
    await r.H("left_click", { coordinate: [100, 100] });
    agree("during the lock");
    // The handler's own click path (upstream's conditions: __travel ->
    // executor.showPointerTravel) drives the Wayland arrow as on X11: a glide
    // to the target, then the real click.
    const glidesBefore = cmds().filter((x) => x.cmd === "glide").length;
    const t0c = performance.now();
    await r.H("left_click", { coordinate: [400, 300] });
    const clickMs = performance.now() - t0c;
    await waitFor(() => cmds().filter((x) => x.cmd === "glide").length > glidesBefore);
    const lastGlide = cmds().filter((x) => x.cmd === "glide").pop();
    check("handler click: the arrow glides to the target first", !!lastGlide && J(lastGlide.frames.at(-1).slice(0, 2)) === J([400, 300]), true);
    check(`handler click: the click waited for the glide (${Math.round(clickMs)} ms)`, clickMs >= 300, true);
    agree("handler click after the glide");
    // The accessibility tools make a window's display current through the
    // handler's pin (app_ax_find on another monitor): reported like switch_display.
    globalThis.__cdbAxHandles = (t) => t === "app_ax_find";
    globalThis.__cdbAxCall = async (t, i, o) => { o.pin({ displayId: 1, originX: 1920, originY: 0 }); return { content: [{ type: "text", text: "ok" }] }; };
    await r.H("app_ax_find", { window: "x" });
    delete globalThis.__cdbAxHandles; delete globalThis.__cdbAxCall;
    check("accessibility pin: reported to upstream's session, the glow moves", r.sess.sel === 1 && await waitFor(() => lastOutput() === "HDMI-A-1"), true);
    // back to auto: the session forgets the pin
    await r.H("switch_display", { display: "auto" });
    check("auto: the pin is cleared upstream too", r.sess.sel, undefined);
    r.release();
    await waitFor(() => readLog().some((x) => x.eof));
  }
  {
    // 3. No selection at all: the glow starts on upstream's fallback (the
    // main window's display) and follows the display the screenshot used.
    const r = await selRig();
    TWO.primaryIdx = 1;
    await r.H("screenshot", {});
    await shown(r.glow);
    check("no selection: the screenshot's display reached upstream's session", r.sess.sel, 1);
    check("no selection: the glow is on that display's output", await waitFor(() => lastOutput() === "HDMI-A-1"), true);
    await r.H("left_click", { coordinate: [100, 100] });
    agree("no selection");
    TWO.primaryIdx = 0;
    r.release();
    await waitFor(() => readLog().some((x) => x.eof));
  }
  {
    // 4. Auto-target (upstream's own dispatch: resolvePrepareCapture picks the
    // display of the granted apps and stores it with onCuSelectedDisplayUpdated).
    const r = await selRig();
    await r.H("screenshot", {});
    await shown(r.glow);
    check("auto-target: starts on DP-1", lastOutput(), "DP-1");
    r.sess.onCuSelectedDisplayUpdated(1);
    check("auto-target: move to HDMI-A-1", await waitFor(() => lastOutput() === "HDMI-A-1"), true);
    await r.ex.click(2400, 300, "left", 1);
    agree("auto-target");
    // An arrow command for a point off the shown output is not sent (the
    // overlay would draw that subsurface on the other output).
    r.sess.onCuSelectedDisplayUpdated(0);
    await waitFor(() => lastOutput() === "DP-1");
    const before = cmds().length;
    r.glow.pointer().jumpTo({ x: 2500, y: 300 });
    r.glow.pointer().realPointerGoesTo({ x: 2500, y: 300 });
    r.glow.pointer().press();
    await sleep(40);
    check("arrow commands off the shown output are not sent", cmds().length, before);
    r.release();
    await waitFor(() => readLog().some((x) => x.eof));
  }

  // ── The debug trace (CDB_CU_DEBUG=1) ──────────────────────────────────
  console.log("\n[2c] wl-glow trace");
  {
    const traceLines = () => diagLines.filter((m) => /^\[claude-cu\] wl-glow: trace: t=\d+\.\d /.test(m));
    let r = await rig({ flag: true });
    r.acquire(); await shown(r.glow);
    await r.ex.moveMouse(2100, 100);
    await r.ex.showPointerTravel(2500, 300, () => false);
    await r.ex.click(2500, 300, "left", 1);
    check("trace off (default): no trace line", traceLines().length, 0);
    r.release(); await waitFor(() => readLog().some((x) => x.eof));
    process.env.CDB_CU_DEBUG = "1";
    r = await rig({ flag: true });
    r.acquire(); await shown(r.glow);
    await r.ex.moveMouse(2100, 100);
    await r.ex.showPointerTravel(2500, 300, () => false);
    await r.ex.click(2500, 300, "left", 1);
    const tl = traceLines();
    const t = (m) => +/t=(\d+\.\d)/.exec(m)[1];
    const g = tl.find((m) => / send glide frames=\d+ arrive=\d+ to=2500,300$/.test(m));
    const mv = tl.find((m) => / input pointer-move 2500,300$/.test(m));
    const ck = tl.find((m) => / input pointer-click 2500,300$/.test(m));
    check("trace on: show, jump, glide, press and the real input are traced", !!tl.find((m) => / send show output=HDMI-A-1 look=rim/.test(m)) && !!tl.find((m) => / send jump 2100,100$/.test(m)) && !!g && !!mv && !!ck && !!tl.find((m) => / send press 2500,300$/.test(m)), true);
    const arrive = g ? +/arrive=(\d+)/.exec(g)[1] : NaN;
    check(`trace on: the real move follows the glide by its arrival (${g && mv ? Math.round(t(mv) - t(g)) : "?"} ms, arrive ${arrive})`, !!g && !!mv && t(mv) - t(g) >= arrive - 20 && t(ck) >= t(mv), true);
    r.release(); await waitFor(() => readLog().some((x) => x.eof));
    check("trace on: hide traced", diagLines.some((m) => / send hide$/.test(m)), true);
    delete process.env.CDB_CU_DEBUG;
  }

  // ── Hot-plugged monitor: the zoom names the new output ────────────────
  console.log("\n[2d] a monitor plugged in after the bridge's monitor list was cached");
  {
    const scr = (o, i) => ({ id: i, name: o.name, geometry: { x: o.x, y: o.y, width: o.width, height: o.height }, scale: o.scale, refresh_millihz: 60000, is_active: true, is_primary: i === 0 });
    const r = await rig({ screens: (n) => (n === 1 ? [scr(OUTPUTS[0], 0)] : OUTPUTS.map(scr)) });
    try { await r.ex.zoom({ x: 100, y: 100, w: 50, h: 50 }, undefined, null, 1, { globalCoords: true }); } catch {}
    try { await r.ex.zoom({ x: 2000, y: 100, w: 50, h: 50 }, undefined, null, 1, { globalCoords: true }); } catch {}
    const z = asyncLog.filter((x) => / zoom /.test(x));
    check("first zoom: the one known monitor", /--display DP-1/.test(z[0] || ""), true);
    check("a point on no cached monitor: the list is enumerated again", asyncLog.filter((x) => / screens$/.test(x)).length, 2);
    check("then the zoom names the new output with local coordinates", /--x 80 --y 100 .*--display HDMI-A-1|--display HDMI-A-1.*--x 80 --y 100/.test(z[1] || ""), true);
    check("one diag line says so", diagLines.filter((m) => /is on no known monitor - monitor list refreshed/.test(m)).length, 1);
  }

  // ── The drawn cursor stays out of the screenshots ──────────────────────
  console.log("\n[2e] capture: the arrow hidden around each bridge capture");
  {
    const scr = (o, i) => ({ id: i, name: o.name, geometry: { x: o.x, y: o.y, width: o.width, height: o.height }, scale: o.scale, refresh_millihz: 60000, is_active: true, is_primary: i === 0 });
    const ZOK = () => J({ base64: "AA==", width: 10, height: 10 });
    const capCmds = () => readLog().filter((x) => x.cmd && x.cmd.cmd === "capture");
    const zoomAt = async (r) => { let err = null; const t0 = performance.now(); try { await r.ex.zoom({ x: 2000, y: 100, w: 50, h: 50 }, undefined, null, 1, { globalCoords: true }); } catch (e) { err = e; } return { err, ms: performance.now() - t0 }; };
    const ready2 = async (opts) => { const r = await rig({ flag: true, screens: () => OUTPUTS.map(scr), ...opts }); r.acquire(); await shown(r.glow); await r.ex.moveMouse(2100, 100); await sleep(30); return r; };
    process.env.CDB_CU_DEBUG = "1";
    let r = await ready2({ zoom: ZOK });
    let z = await zoomAt(r);
    await waitFor(() => capCmds().length >= 2);
    let cc = capCmds();
    check("hide with scope cursor, then restore", J(cc.map((x) => [x.cmd.phase, x.cmd.scope || null])), J([["hide", "cursor"], ["restore", null]]));
    check("the hide reached the overlay before the bridge capture, the restore after", !!zoomLog[0] && cc[0].t <= zoomLog[0].t && cc[1].t >= zoomLog[0].t, true);
    check("capture result unchanged", z.err, null);
    check("trace: capture hide with the ack latency, send capture restore", diagLines.some((m) => /wl-glow: trace: t=[\d.]+ capture hide id=\d+ ack after [\d.]+ ms$/.test(m)) && diagLines.some((m) => /wl-glow: trace: t=[\d.]+ send capture restore id=\d+$/.test(m)), true);
    r.release(); await waitFor(() => readLog().some((x) => x.eof));
    // The capture fails: restored anyway, the error unchanged.
    r = await ready2({ zoom: () => new Error("Command failed: zoom\nwlroots-bridge: screencopy failed") });
    z = await zoomAt(r);
    await waitFor(() => capCmds().length >= 2);
    check("capture rejects: restore still sent, the error surfaces", J(capCmds().map((x) => x.cmd.phase)) === J(["hide", "restore"]) && !!z.err, true);
    r.release(); await waitFor(() => readLog().some((x) => x.eof));
    // No ack: the capture runs after the 50 ms bound, then the restore.
    process.env.FAKE_OVL_NOACK = "1";
    r = await ready2({ zoom: ZOK });
    z = await zoomAt(r);
    await waitFor(() => capCmds().length >= 2);
    const lag = zoomLog[0] ? zoomLog[0].t - capCmds()[0].t : -1;
    check(`no ack: the capture waits the bound only (${lag} ms, bound 50), then restore`, lag >= 40 && lag < 200 && J(capCmds().map((x) => x.cmd.phase)) === J(["hide", "restore"]) && z.err === null, true);
    delete process.env.FAKE_OVL_NOACK;
    r.release(); await waitFor(() => readLog().some((x) => x.eof));
    // Lock released mid-capture: the capture is cancelled, nothing stays hidden.
    r = await ready2({ zoom: () => "hang" });
    const zp = zoomAt(r);
    await waitFor(() => zoomLog.length === 1);
    r.release();
    z = await zp;
    check(`lock release mid-capture: cancelled promptly (${Math.round(z.ms)} ms)`, !!z.err && /cancelled/.test(z.err.message) && z.ms < 500, true);
    check("lock release mid-capture: the overlay got the hide, then hide and EOF (it exits; nothing left hidden)", await waitFor(() => readLog().some((x) => x.eof)) && capCmds().length >= 1, true);
    // Not sent: no "cursor" scope, the classic glow look, the switch off.
    process.env.FAKE_OVL_SCOPES = '["all"]';
    r = await ready2({ zoom: ZOK });
    await zoomAt(r); await sleep(50);
    check("overlay without the cursor scope: no capture command (never a scope-less hide)", capCmds().length, 0);
    delete process.env.FAKE_OVL_SCOPES;
    r.release(); await waitFor(() => readLog().some((x) => x.eof));
    r = await rig({ flag: false, screens: () => OUTPUTS.map(scr), zoom: ZOK });
    r.acquire(); await shown(r.glow); await r.ex.moveMouse(2100, 100);
    await zoomAt(r); await sleep(50);
    check("classic glow look (no arrow): no capture command", capCmds().length, 0);
    r.release(); await waitFor(() => readLog().some((x) => x.eof));
    r = await rig({ flag: true, glow: false, screens: () => OUTPUTS.map(scr), zoom: ZOK });
    r.acquire(); await sleep(60);
    z = await zoomAt(r);
    check("glow switch off: no child, no capture command, the capture runs", spawnCalls.length === 0 && capCmds().length === 0 && z.err === null && zoomLog.length === 1, true);
    r.release();
    delete process.env.CDB_CU_DEBUG;
  }

  // ── Capture before the overlay is up: the show waits for the restore ──
  console.log("\n[2e2] capture requested while a show is pending: the overlay never appears during it");
  {
    const scr = (o, i) => ({ id: i, name: o.name, geometry: { x: o.x, y: o.y, width: o.width, height: o.height }, scale: o.scale, refresh_millihz: 60000, is_active: true, is_primary: i === 0 });
    const ZOK = () => J({ base64: "AA==", width: 10, height: 10 });
    const capCmds = () => readLog().filter((x) => x.cmd && x.cmd.cmd === "capture");
    const showsAt = () => readLog().filter((x) => x.cmd && x.cmd.cmd === "show").map((x) => x.t);
    const zoomAt = async (r) => { let err = null; const t0 = performance.now(); try { await r.ex.zoom({ x: 2000, y: 100, w: 50, h: 50 }, undefined, null, 1, { globalCoords: true }); } catch (e) { err = e; } return { err, ms: performance.now() - t0, end: Date.now() }; };
    const base = { flag: true, screens: () => OUTPUTS.map(scr), zoom: ZOK, zoomDelay: 700 };
    // 1. The capture before the child has answered ready (slow fake: 250 ms).
    process.env.FAKE_OVL_MODE = "delay"; process.env.FAKE_OVL_DELAY = "250";
    let r = await rig(base);
    r.acquire();
    let z = await zoomAt(r);
    check("capture before ready: no show reached the overlay during the capture", showsAt().filter((t) => t <= z.end).length, 0);
    check("capture before ready: the capture was not delayed (zoomDelay 700 only)", z.ms < 900, true);
    check("capture before ready: the show follows the restore", await waitFor(() => showsAt().length === 1) && await shown(r.glow), true);
    check("capture before ready: the badge flag survived the deferral", readLog().filter((x) => x.cmd && x.cmd.cmd === "show")[0].cmd.badge, true);
    r.release(); await waitFor(() => readLog().some((x) => x.eof));
    // 2. The show is sent, the overlay has not answered `shown` yet: the hide goes out after it.
    process.env.FAKE_OVL_MODE = "normal"; delete process.env.FAKE_OVL_DELAY; process.env.FAKE_OVL_SHOWN_DELAY = "400"; process.env.FAKE_OVL_BADGE = "true";
    r = await rig({ flag: true, screens: () => OUTPUTS.map(scr) });
    r.acquire();
    await waitFor(() => showsAt().length === 1);
    check("show sent, not yet shown", !r.glow.state().shown, true);
    const tk = await r.glow.captureCursor(50);
    await sleep(20);
    check("capture between show and shown: a hide (scope all, the badge is up) goes out after the show", J(capCmds().map((x) => [x.cmd.phase, x.cmd.scope || null])), J([["hide", "all"]]));
    r.glow.captureRestore(tk);
    check("... and the restore follows", await waitFor(() => capCmds().length === 2), true);
    delete process.env.FAKE_OVL_SHOWN_DELAY; delete process.env.FAKE_OVL_BADGE;
    r.release(); await waitFor(() => readLog().some((x) => x.eof));
    // 3. Direct API: a hold is an already-resolved token (zero wait), the restore sends the show.
    r = await rig({ flag: true, screens: () => OUTPUTS.map(scr) });
    r.acquire();
    let t0 = performance.now();
    const tok = await r.glow.captureCursor(50);
    check("hold token returned without waiting", !!tok && performance.now() - t0 < 20, true);
    await waitFor(() => r.glow.state().ready); await sleep(60);
    check("held: ready, nothing shown", r.glow.state().ready && !r.glow.state().shown && showsAt().length === 0, true);
    r.glow.captureRestore(tok);
    check("restore: the show goes out", await shown(r.glow) && showsAt().length === 1, true);
    r.glow.captureRestore(tok);
    await sleep(40);
    check("a second restore of the same token is a no-op", showsAt().length, 1);
    r.release(); await waitFor(() => readLog().some((x) => x.eof));
    // 4. Hold, then lock release: the late restore does nothing, the next lock is not held back.
    r = await rig({ flag: true, screens: () => OUTPUTS.map(scr) });
    r.acquire();
    const old = await r.glow.captureCursor(50);
    r.release(); await sleep(30);
    resetLog();
    r.acquire();
    await shown(r.glow);
    r.glow.captureRestore(old);
    check("next lock shows although the old token never restored first", showsAt().length === 1, true);
    r.release(); await waitFor(() => readLog().some((x) => x.eof));
    // 5. Lock released while the show is deferred: no show is ever sent.
    r = await rig(base);
    r.acquire();
    const zp = zoomAt(r);
    await waitFor(() => zoomLog.length === 1);
    await waitFor(() => r.glow.state().ready);
    r.release();
    await zp.catch(() => {});
    await sleep(80);
    check("release while a show is deferred: nothing shown", showsAt().length, 0);
    // 6. No overlay expected: zero added delay, no token, nothing deferred.
    r = await rig({ flag: true, glow: false, screens: () => OUTPUTS.map(scr), zoom: ZOK });
    r.acquire(); await sleep(30);
    t0 = performance.now();
    check("glow switch off: captureCursor null", r.glow.captureCursor(50), null);
    check("glow switch off: no wait", performance.now() - t0 < 10, true);
    r.release();
    r = await rig({ flag: true, overlay: false, screens: () => OUTPUTS.map(scr), zoom: ZOK });
    r.acquire(); await sleep(60);
    check("row without overlay: captureCursor null", r.glow.captureCursor(50), null);
    r.release();
    r = await rig({ flag: true, screens: () => OUTPUTS.map(scr), zoom: ZOK });
    check("lock not held: captureCursor null", r.glow.captureCursor(50), null);
    process.env.FAKE_OVL_MODE = "fatal";
    r = await rig({ flag: true, screens: () => OUTPUTS.map(scr) });
    r.acquire(); await waitFor(() => r.glow.state().off);
    check("overlay failed: captureCursor null", r.glow.captureCursor(50), null);
    r.release();
    process.env.FAKE_OVL_MODE = "normal";
    // 7. Respawn mid-capture: the new child's show waits for the restore as well.
    process.env.FAKE_OVL_MODE = "die-on-glide";
    r = await rig({ flag: true, screens: () => OUTPUTS.map(scr) });
    r.acquire(); await shown(r.glow);
    const c1 = await r.glow.captureCursor(50);
    check("shown overlay, glow look, nothing to hide: still a hold (a re-show during the capture is deferred)", !!c1, true);
    r.glow.captureRestore(c1);
    r.release(); await waitFor(() => readLog().some((x) => x.eof));
    process.env.FAKE_OVL_MODE = "normal";
  }

  // ── The badge: once per run, never repeated or cut short on our paths ───
  console.log("\n[2f] badge: sent once per run to an overlay that draws it, capture scope while it is up");
  {
    const shows = () => cmds().filter((x) => x.cmd === "show");
    const bshows = () => shows().map((x) => x.badge);
    const capCmds = () => readLog().filter((x) => x.cmd && x.cmd.cmd === "capture");
    const scr = (o, i) => ({ id: i, name: o.name, geometry: { x: o.x, y: o.y, width: o.width, height: o.height }, scale: o.scale, refresh_millihz: 60000, is_active: true, is_primary: i === 0 });
    const ZOK = () => J({ base64: "AA==", width: 10, height: 10 });
    const zoomAt = async (r) => { try { await r.ex.zoom({ x: 2000, y: 100, w: 50, h: 50 }, undefined, null, 1, { globalCoords: true }); } catch { /* the scope is what is under test */ } };
    process.env.FAKE_OVL_BADGE = "true";
    // Plain run: badge on the first show; a display switch is a move, no show.
    let r = await rig();
    r.acquire(); await shown(r.glow);
    check("badge overlay: the run's show carries badge:true", J(bshows()), J([true]));
    r.w.api[switchFn[1]]("s1", 0);
    await waitFor(() => kinds().includes("move"));
    check("badge overlay: a display switch sends a move only (the flash runs on)", J([kinds().filter((k) => k === "show").length, J(cmds().at(-1))]), J([1, J({ cmd: "move", output: "DP-1" })]));
    // Another upstream show (it restarts the flash on its own page too).
    await r.w.api[showFn]({ showBadge: true, claudeHasThePointer: true });
    await waitFor(() => shows().length === 2);
    check("badge overlay: a second upstream show with showBadge asks for the flash again, as upstream", J(bshows()), J([true, true]));
    await r.w.api[showFn]({ showBadge: false, claudeHasThePointer: true });
    await waitFor(() => shows().length === 3);
    check("badge overlay: an upstream show without showBadge sends none", J(bshows()), J([true, true, false]));
    r.release(); await waitFor(() => readLog().some((x) => x.eof));
    // The next lock is a new run.
    r = await rig(); r.acquire(); await shown(r.glow);
    check("badge overlay: the next lock flashes again", J(bshows()), J([true]));
    r.release(); await waitFor(() => readLog().some((x) => x.eof));
    // Respawn mid-lock: the new overlay gets no badge.
    process.env.FAKE_OVL_MODE = "die-on-glide";
    r = await rig({ flag: true });
    r.acquire(); await shown(r.glow);
    await r.ex.moveMouse(2100, 100);
    await r.ex.showPointerTravel(2600, 500, () => false);
    check("respawn: a second overlay", await waitFor(() => starts().length === 2), true);
    await waitFor(() => shows().length === 2);
    check("respawn: the re-show carries no badge (not flashed twice)", J(bshows()), J([true, false]));
    await waitFor(() => r.glow.state().off || true);
    r.release(); await sleep(100);
    delete process.env.FAKE_OVL_MODE;
    // Reduced motion: none.
    globalThis.__testRM = true;
    r = await rig(); r.acquire(); await shown(r.glow);
    check("reduced motion: show without badge, reducedMotion true", J(shows().map((x) => [x.badge, x.reducedMotion])), J([[false, true]]));
    globalThis.__testRM = false;
    r.release(); await waitFor(() => readLog().some((x) => x.eof));
    // An overlay that reports badge:false: show as before (badge as upstream asked), no scope change.
    process.env.FAKE_OVL_BADGE = "false";
    r = await rig({ flag: true, screens: () => OUTPUTS.map(scr), zoom: ZOK }); r.acquire(); await shown(r.glow);
    await r.ex.moveMouse(2100, 100); await sleep(30);
    await r.w.api[showFn]({ showBadge: true, claudeHasThePointer: true });
    await waitFor(() => shows().length === 2);
    check("ready.badge false: every show unchanged (badge as upstream asked)", J(bshows()), J([true, true]));
    await zoomAt(r); await waitFor(() => capCmds().length >= 2);
    check("ready.badge false: the capture hide stays scope cursor", J(capCmds().map((x) => x.cmd.scope || null)), J(["cursor", null]));
    r.release(); await waitFor(() => readLog().some((x) => x.eof));
    process.env.FAKE_OVL_BADGE = "true";
    // Capture while the badge is up: scope all, also with the classic glow look.
    r = await rig({ flag: false, screens: () => OUTPUTS.map(scr), zoom: ZOK }); r.acquire(); await shown(r.glow);
    await r.ex.moveMouse(2100, 100); await sleep(30);
    await zoomAt(r); await waitFor(() => capCmds().length >= 2);
    check("badge up, glow look: capture hide with scope all, then restore", J(capCmds().map((x) => [x.cmd.phase, x.cmd.scope || null])), J([["hide", "all"], ["restore", null]]));
    r.release(); await waitFor(() => readLog().some((x) => x.eof));
    // After its 6 s the hide is the cursor one again (or none for the glow look).
    r = await rig({ flag: true, screens: () => OUTPUTS.map(scr), zoom: ZOK }); r.acquire(); await shown(r.glow);
    await r.ex.moveMouse(2100, 100);
    await sleep(6700);
    resetLog();
    await zoomAt(r); await waitFor(() => capCmds().length >= 2);
    check("badge over (6.5 s): capture hide with scope cursor", J(capCmds().map((x) => [x.cmd.phase, x.cmd.scope || null])), J([["hide", "cursor"], ["restore", null]]));
    r.release(); await waitFor(() => readLog().some((x) => x.eof));
    r = await rig({ flag: false, screens: () => OUTPUTS.map(scr), zoom: ZOK }); r.acquire(); await shown(r.glow);
    await sleep(6700);
    resetLog();
    await zoomAt(r); await sleep(50);
    check("badge over, glow look: no capture command", capCmds().length, 0);
    r.release(); await waitFor(() => readLog().some((x) => x.eof));
    delete process.env.FAKE_OVL_BADGE;
  }

  // No child at all.
  for (const [label, opts] of [
    ["no overlay capability (doctor false)", { overlay: false }],
    ["older bridge (no capability key)", { overlay: "absent" }],
    ["glow switch off", { glow: false, flag: true }],
    ["background display", { target: { kind: "wlroots", display: "wayland-9", env: {} } }],
    ["regular executor in kwin mode (its row is null; kwin mode is [4])", { kwin: true, wlroots: false, desktop: "KDE" }],
    ["KDE < 6.6 / exotic Wayland (no first-party bridge)", { wlroots: false, desktop: "COSMIC" }],
  ]) {
    const r = await rig(opts);
    r.acquire();
    await sleep(80);
    const spt = await r.ex.showPointerTravel(2500, 300, () => false);
    try { await r.ex.click(2500, 300, "left", 1); } catch { /* a background display that is not running refuses input */ }
    check(`${label}: no overlay child`, spawnCalls.length, 0);
    check(`${label}: upstream's own Wayland path (nothing drawn: busy flag untouched)`, J(r.w.trace), "[]");
    check(`${label}: showPointerTravel false`, spt, false);
    r.release();
  }
  {
    // XWayland on sway follows the compositor's row (same bridge, same overlay).
    const r = await rig({ desktop: "sway" });
    process.env.DISPLAY = ":0";
    r.acquire();
    check("XWayland on sway: the wlroots row's overlay", await waitFor(() => starts().length === 1), true);
    r.release();
    delete process.env.DISPLAY;
    await waitFor(() => readLog().some((x) => x.eof));
  }

  // ── [4] KDE Plasma Wayland (kwin mode, js/executor_linux.js) ────────────
  // The REAL kwin executor (its bridge calls stubbed and recorded, env
  // included), the REAL module (the overlay child is the fake bridge, spawned
  // for real) and the REAL patched upstream glow functions.
  console.log("\n[4] kwin mode: the shared overlay when kwin-portal-bridge announces it, its own glow otherwise");
  {
    const KEXEC = path.join(repo, "js", "executor_linux.js");
    const KSCREENS = [
      { id: "DP-1", name: "DP-1", geometry: R(0, 0, 1920, 1080), scale: 1, is_primary: true },
      { id: "HDMI-A-1", name: "HDMI-A-1", geometry: R(1920, 0, 1707, 960), scale: 1.5, is_primary: false },
    ];
    const KDOC = (caps) => ({ contract: 1, bridge: "kwin-portal-bridge", version: "0.4.0", backend: "kwin-portal", session_match: true, backend_reachable: true, ...(caps === "absent" ? {} : { capabilities: caps }) });
    const FULL = { overlay: true, overlay_alpha_modifier: true, overlay_fractional_scale: true, session_overlay_opt_out: true };
    const kw = [];
    const consoleDebug = console.debug;
    console.debug = () => {}; // the kwin executor's debugLog
    function loadKwin({ caps = FULL, glow = true, doctorDelay = 0 } = {}) {
      kw.length = 0; diagLines.length = 0; spawnCalls.length = 0;
      const screen = makeScreen(TWO);
      const reply = (sub) => {
        if (sub === "screens") return J(KSCREENS);
        if (sub === "session-start") return J({ ok: true, session: "daemon" });
        if (sub === "session-end") return J({ ok: true, ended: true, daemon: "exited" });
        if (sub === "screenshot") return J({ base64: "AAAA", width: 1707, height: 960 });
        if (sub === "restore-prepare-state") return J({ hidden: [], activated: null });
        return "{}";
      };
      const cpStub = {
        execFile(bin, args, opts, cb) {
          if (typeof opts === "function") { cb = opts; opts = {}; }
          const sub = (args || [])[0];
          kw.push({ sub, env: opts && opts.env ? opts.env.KWIN_PORTAL_BRIDGE_SESSION_OVERLAY ?? "(unset)" : null });
          if (sub === "doctor") {
            setTimeout(() => (caps === "fail" ? cb(Object.assign(new Error("Command failed: doctor"), { code: 1, stderr: "boom" })) : cb(null, { stdout: J(KDOC(caps)), stderr: "" })), doctorDelay);
            return;
          }
          setImmediate(() => cb(null, { stdout: reply(sub), stderr: "" }));
        },
        spawnSync() { return { status: 0 }; },
      };
      const src = readFileSync(KEXEC, "utf8")
        .replace("import { execFile as execFileCb, spawnSync } from 'node:child_process'", "const { execFile: execFileCb, spawnSync } = __cp")
        .replace("import { screen as electronScreen } from 'electron'", "const electronScreen = __screen")
        .replace("import { promisify } from 'node:util'", "const { promisify } = __util")
        .replace(/^export /gm, "");
      if (/^import /m.test(src)) throw new Error("executor_linux.js imports changed - update this splice");
      const electron = { screen, systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: false }) } };
      const cpRec = { ...realCp, spawn: (cmd, args, opts) => { spawnCalls.push({ cmd, args, opts }); return realCp.spawn(cmd, args, opts); } };
      const reqMod = (id) => ({ child_process: cpRec, electron })[id] || (() => { throw new Error("unexpected require " + id); })();
      for (const k of ["__cdbCuElectronDisplayId", "__cdbCuGlowOff", "__linuxExecutor", "__cdbCuWlGlow", "__cdbCuDrawnPointer", "__cuTargetRead", "__cuTargetSig"]) delete globalThis[k];
      for (const k of ["SWAYSOCK", "WLROOTS_BRIDGE_BIN", "KWIN_PORTAL_BRIDGE_BIN", "KWIN_PORTAL_BRIDGE_SESSION_OVERLAY"]) delete process.env[k];
      process.env.XDG_CURRENT_DESKTOP = "KDE"; process.env.XDG_SESSION_TYPE = "wayland"; process.env.WAYLAND_DISPLAY = "wayland-0";
      globalThis.__cdbDiag = (m) => diagLines.push(String(m));
      globalThis.__cuKwinMode = true;
      globalThis.__cuKwinBridgeBin = FAKE;
      globalThis.__cdbCuGlowEnabled = () => glow;
      const mod = new Function("__cp", "__util", "__screen", src + "\nreturn { createLinuxExecutor };")(cpStub, util, screen);
      globalThis.__linuxExecutor = mod.createLinuxExecutor({ hostBundleId: "com.anthropic.claude" });
      new Function("require", "process", readFileSync(MODULE, "utf8"))(reqMod, process);
      return { screen, ex: globalThis.__linuxExecutor, glow: globalThis.__cdbCuWlGlow };
    }
    async function rigKwin(opts = {}) {
      resetLog();
      const { screen, ex, glow } = loadKwin(opts);
      // pai: upstream's CLICK_THROUGH_WINDOWS true (it could draw its own glow).
      const w = world(chunk, screen, { wayland: opts.pai !== true, flag: opts.flag === true });
      const mainWin = { isDestroyed: () => false, getBounds: () => ({ x: 10, y: 10, width: 100, height: 100 }) };
      // kwin display ids are Electron ids (202 = HDMI-A-1).
      w.api[lockFn](() => 202, mainWin);
      let lockP = null;
      const acquire = () => { w.holder.currentHolder = "s1"; lockP = ex.__setLockHeld(true, "s1").catch((e) => diagLines.push("lock failed " + e)); w.listeners.forEach((f) => f({ holder: "s1" })); };
      const release = async () => { const p = ex.__setLockHeld(false).catch(() => {}); w.holder.currentHolder = undefined; w.listeners.forEach((f) => f({ holder: undefined })); await p; };
      return { ex, glow, w, acquire, release, settled: () => lockP };
    }
    const subs = () => kw.map((k) => k.sub);
    const startEnvs = () => kw.filter((k) => k.sub === "session-start").map((k) => k.env);
    const KSEQ = ["jump", "glide", "press", "press", "jump", "press", "jump", "glide"];

    // (a) a bridge that announces the overlay and the session-glow opt-out.
    {
      const r = await rigKwin({ flag: true, doctorDelay: 40 });
      r.acquire();
      check("capable: upstream's show waits for the decision (no child before the doctor answers)", spawnCalls.length, 0);
      check("capable: the module owns the show at once (upstream's body skipped)", J(r.w.trace), "[]");
      await r.settled();
      check("capable: the doctor ran before session-start", subs().indexOf("doctor") >= 0 && subs().indexOf("doctor") < subs().indexOf("session-start"), true);
      check("capable: session-start runs with KWIN_PORTAL_BRIDGE_SESSION_OVERLAY=0 (no session glow)", J(startEnvs()), J(["0"]));
      check("capable: set-overlay-display still sent (a no-op for the bridge)", subs().includes("set-overlay-display"), true);
      check("capable: one overlay child, `kwin-portal-bridge overlay`", await waitFor(() => starts().length === 1) && J(spawnCalls.map((c) => [c.cmd, c.args])), J([[FAKE, ["overlay"]]]));
      check("capable: a direct child of this process with CLAUDE_CU_PARENT_PID", (starts()[0] || {}).ppid === process.pid && (starts()[0] || {}).parentEnv === String(process.pid), true);
      await shown(r.glow);
      check("capable: rim on the selected display's output", J(cmds()[0]), J({ cmd: "show", output: "HDMI-A-1", look: "rim", badge: true, reducedMotion: false, arrow: null }));
      check("capable: __wlGlowRow overlay true, __glowNow overlay", r.ex.__wlGlowRow().overlay === true && r.ex.__glowNow().where === "overlay", true);
      check("capable: __cdbCuGlowOff false (switch on)", globalThis.__cdbCuGlowOff(), false);
      resetLog();
      const before = kw.length;
      await r.ex.moveMouse(2100, 100);
      const spt = await r.ex.showPointerTravel(2500.4, 300.6, () => false);
      await r.ex.click(2500.4, 300.6, "left", 1);
      await r.ex.mouseDown();
      await r.ex.moveMouse(2600, 400);
      await r.ex.mouseUp();
      await r.ex.drag({ x: 2000, y: 50 }, { x: 2100, y: 60 });
      await r.ex.scroll(2200, 200, 0, 3);
      await waitFor(() => cmds().length >= KSEQ.length);
      check("capable: showPointerTravel glided (true)", spt, true);
      check("capable: the drawn pointer is fed like the wlroots rows", J(cmds().map((x) => x.cmd)), J(KSEQ));
      check("capable: arrow commands in the bridge's own coordinates", J(cmds()[0]) + J(cmds()[2]), J({ cmd: "jump", x: 2100, y: 100 }) + J({ cmd: "press", x: 2500.4, y: 300.6 }));
      check("capable: the real input reached the bridge, one command per action",
        J(kw.slice(before).map((k) => k.sub).filter((s) => /^(pointer-|left-mouse-)/.test(s))), J(["pointer-move", "pointer-click", "left-mouse-down", "pointer-move", "left-mouse-up", "pointer-drag", "pointer-scroll"]));
      resetLog();
      await r.ex.screenshot({ displayId: 202 });
      await sleep(20);
      check("capable: a screenshot sends no capture round trip (the bridge excludes the overlay from capture)", cmds().filter((c) => c.cmd === "capture").length, 0);
      // A session ended at a task boundary restarts with the same decision.
      await r.ex.__cuTaskBoundary("s1", "renderer", "s1");
      await r.ex.key("a");
      check("capable: the restarted session gets the variable too", J(startEnvs()), J(["0", "0"]));
      const pid = (starts()[0] || {}).pid;
      await r.release();
      check("capable: release hides and ends the child", await waitFor(() => readLog().some((x) => x.eof)) && kinds().at(-1) === "hide" && await waitFor(() => !pidAlive(pid)), true);
      const doctors = subs().filter((s) => s === "doctor").length;
      r.acquire(); await r.settled();
      check("capable: the next lock reuses the cached doctor and decides the same", subs().filter((s) => s === "doctor").length === doctors && J(startEnvs().slice(-1)) === J(["0"]), true);
      await r.release();
      await waitFor(() => readLog().filter((x) => x.eof).length >= 2);
    }
    // (b) bridges without both keys: the bridge's own glow, exactly as before.
    for (const [label, caps] of [["older bridge (no capabilities)", "absent"], ["overlay without the session-glow opt-out", { overlay: true }], ["doctor failed", "fail"]]) {
      const r = await rigKwin({ caps, flag: true });
      r.acquire();
      await r.settled();
      await sleep(60);
      check(`${label}: session-start without the variable`, J(startEnvs()), J([null]));
      check(`${label}: no overlay child`, spawnCalls.length, 0);
      check(`${label}: upstream's lock-time show did not draw (busy untouched)`, J(r.w.trace), "[]");
      check(`${label}: showPointerTravel false, the click reached the bridge`, (await r.ex.showPointerTravel(2500, 300, () => false)) === false && (await r.ex.click(2500, 300, "left", 1), subs().includes("pointer-click")), true);
      check(`${label}: __wlGlowRow overlay false, __glowNow kwin`, r.ex.__wlGlowRow().overlay === false && r.ex.__glowNow().where === "kwin", true);
      check(`${label}: __cdbCuGlowOff true (upstream's Electron glow never next to the bridge's)`, globalThis.__cdbCuGlowOff(), true);
      if (caps === "fail") check(`${label}: one diag line`, diagLines.filter((m) => /kwin-portal-bridge doctor failed/.test(m)).length, 1);
      await r.release();
    }
    {
      // Where upstream WOULD draw (CLICK_THROUGH_WINDOWS true: XDG_SESSION_TYPE
      // says x11 while kwin mode runs): its show after the decision stays off.
      const r = await rigKwin({ caps: "absent", pai: true, flag: true });
      r.acquire();
      await r.settled();
      r.w.trace.length = 0;
      await r.w.api[showFn]({ showBadge: !1, claudeHasThePointer: !1 });
      check("older bridge, upstream able to draw: its show is refused by 10c (__cdbCuGlowOff)", J(r.w.trace), "[]");
      await r.release();
    }
    // (c) the glow switch off.
    {
      const r = await rigKwin({ glow: false, flag: true });
      r.acquire(); await r.settled(); await sleep(60);
      check("switch off, capable bridge: session-start with the variable (no session glow)", J(startEnvs()), J(["0"]));
      check("switch off, capable bridge: no overlay child, nothing drawn", spawnCalls.length === 0 && J(r.w.trace) === "[]", true);
      check("switch off: __cdbCuGlowOff true", globalThis.__cdbCuGlowOff(), true);
      await r.release();
    }
    {
      const r = await rigKwin({ glow: false, caps: { session_overlay_opt_out: true } });
      r.acquire(); await r.settled();
      check("switch off, opt-out without overlay: session-start with the variable", J(startEnvs()), J(["0"]));
      await r.release();
      globalThis.__cdbCuGlowEnabled = () => true;
      r.acquire(); await r.settled();
      check("switch on again, opt-out without overlay: its own glow (no variable)", J(startEnvs().slice(-1)), J([null]));
      await r.release();
    }
    {
      const r = await rigKwin({ glow: false, caps: "absent" });
      r.acquire(); await r.settled();
      check("switch off, older bridge: no variable (it cannot opt out; its own glow stays)", J(startEnvs()), J([null]));
      await r.release();
    }
    {
      // Released before the doctor answered: no child, the late answer is dropped.
      const r = await rigKwin({ flag: true, doctorDelay: 80 });
      r.acquire();
      await sleep(5);
      await r.release();
      await sleep(150);
      check("released before the decision: no overlay child", spawnCalls.length, 0);
    }
    delete process.env.KWIN_PORTAL_BRIDGE_SESSION_OVERLAY;
    delete globalThis.__cuKwinBridgeBin;
    globalThis.__cuKwinMode = false;
    console.debug = consoleDebug;
  }

  // ── [3] X11: upstream unchanged with the switch on, off with it off ─────
  console.log("\n[3] X11 (upstream's own Electron glow)");
  {
    const traceOf = async (src, glowOn) => {
      load({ session: "x11", desktop: "XFCE", wlroots: false, glow: glowOn });
      await sleep(10); // x11-bridge doctor (compositing manager) answers
      const screen = makeScreen(TWO);
      const w = world(src, screen, { wayland: false, flag: true });
      const mainWin = { isDestroyed: () => false, getBounds: () => ({ x: 10, y: 10, width: 100, height: 100 }) };
      w.api[lockFn](() => 1, mainWin);
      w.holder.currentHolder = "s1";
      w.listeners.forEach((f) => f({ holder: "s1" }));
      w.api[switchFn[1]]("s1", 0);
      w.holder.currentHolder = undefined;
      w.listeners.forEach((f) => f({ holder: undefined }));
      return { trace: w.trace, spawned: spawnCalls.length, vars: { sel: w.scope[(/([\w$]+)=[\w$]+\?\?null/.exec(fnSource(src, dispFn)) || [])[1]] } };
    };
    const pristineTrace = (() => {
      // The pristine functions: no 10c/10e-10g; the executor's helpers absent.
      load({ session: "x11", desktop: "XFCE", wlroots: false });
      const w = world(pristineChunk, makeScreen(TWO), { wayland: false, flag: true });
      if (!w) return null;
      const mainWin = { isDestroyed: () => false, getBounds: () => ({ x: 10, y: 10, width: 100, height: 100 }) };
      w.api[lockFn](() => 1, mainWin);
      w.holder.currentHolder = "s1";
      w.listeners.forEach((f) => f({ holder: "s1" }));
      w.holder.currentHolder = undefined;
      w.listeners.forEach((f) => f({ holder: undefined }));
      return w.trace;
    })();
    const on = await traceOf(chunk, true);
    check("X11, switch on: upstream's show and hide ran (busy true, then false)", J(on.trace), J(["busy true", "busy false"]));
    check("X11, switch on: same trace as the pristine functions", J(on.trace), J(pristineTrace));
    check("X11, switch on: no overlay child", on.spawned, 0);
    const off = await traceOf(chunk, false);
    check("X11, switch off: upstream's Electron glow not shown (hide only)", J(off.trace), J(["busy false"]));
    check("X11, switch off: one diag line says so", diagLines.filter((m) => /glow off: switched off in Settings -> Extra -> Cowork \(Linux\) -> Computer Use/.test(m)).length, 1);
    // The executor's own answer, per row and switch.
    load({ session: "x11", desktop: "XFCE", wlroots: false, glow: false });
    check("__cdbCuGlowOff: switch off -> true", globalThis.__cdbCuGlowOff(), true);
    load({ glow: false });
    check("__cdbCuGlowOff on Wayland, switch off -> true", globalThis.__cdbCuGlowOff(), true);
    load({ glow: true });
    check("__cdbCuGlowOff on Wayland, switch on -> false", globalThis.__cdbCuGlowOff(), false);
    globalThis.__cdbCuGlowEnabled = () => { throw new Error("unreadable"); };
    check("__cdbCuGlowOff: unreadable switch -> glow on (default)", globalThis.__cdbCuGlowOff(), false);
  }
  {
    const src = readFileSync(MODULE, "utf8");
    check("module: one spawn site, no shell, no exec", (src.match(/_cp\.spawn\(/g) || []).length === 1 && !/shell\s*:/.test(src) && !/exec(File)?(Sync)?\(/.test(src), true);
  }
} finally {
  for (const k of ["FAKE_OVL_MODE", "FAKE_OVL_DELAY", "FAKE_OVL_BADGE"]) delete process.env[k];
  rmSync(scratch, { recursive: true, force: true });
}

console.log("");
if (failures.length) {
  console.log(`${failures.length} CHECK(S) FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("ALL " + pass + " CHECKS PASSED");
process.exit(0);
