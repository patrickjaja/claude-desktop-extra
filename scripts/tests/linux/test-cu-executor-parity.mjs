#!/usr/bin/env node
// Computer Use executor method parity: js/cu_linux_executor.js (regular mode)
// and js/executor_linux.js (KWin mode) against upstream's own Linux executor.
//
// WHY THIS EXISTS
// ---------------
// Both executors replace upstream's Linux executor (sub-patches 4 / 4d of
// fix_computer_use_linux.nim), and upstream's own tool dispatcher calls them
// directly wherever our Code-session handler (sub-patch 6) does not run:
// cloud Cowork / Dispatch / chat sessions, teach mode, and everything in KWin
// mode. 4.16336.0 added `getKeyFocusApp` (upstream's Linux executors answer
// `return this.getFrontmostApp()`); ours lacked it, so every keyboard action
// at a granted app on those paths failed with
// "e.executor.getKeyFocusApp is not a function".
//
// This harness reads the bundle under test and derives the REQUIRED methods:
//   - the methods of upstream's Linux executors (the X11 one exported as
//     createLinuxExecutor, and the Wayland portal one beside the
//     "computer-use executor not implemented" factory), minus those a caller
//     probes before use (`?.(`, `typeof`, `!x.executor.m`, `!==void 0`, `&&`);
//   - every method upstream's dispatcher calls unguarded
//     (`.executor.<name>(`, not `deps.executor`), which covers the methods
//     the executors take from their shared input base by spread.
// Both our executors must define each one as a function, so a method upstream
// adds later turns the build red instead of failing at run time.
// It also runs the new getKeyFocusApp of each executor (it answers what
// getFrontmostApp answers; regular mode makes no portal call).
// Bundle sections SKIP (exit 3) when the extract is missing.
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import util from "node:util";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..", "..");
const REG = process.env.CU_EXECUTOR || path.join(repo, "js", "cu_linux_executor.js");
const KWIN = process.env.CU_KWIN_EXECUTOR || path.join(repo, "js", "executor_linux.js");
const BUILD_DIR = path.join(process.env.CDB_BUNDLE_DIR || path.join(repo, "tmp", "app.asar.contents"), ".vite", "build");

let pass = 0;
const failures = [];
function check(label, actual, expected) {
  if (actual === expected) { console.log(`  PASS ${label} -> ${actual}`); pass++; }
  else { console.log(`  FAIL ${label} -> got ${actual}, expected ${expected}`); failures.push(label); }
}

// ── our executors ────────────────────────────────────────────────────────
function loadKwin(frontmost) {
  const src = readFileSync(KWIN, "utf8")
    .replace("import { execFile as execFileCb, spawnSync } from 'node:child_process'", "const { execFile: execFileCb, spawnSync } = __cp")
    .replace("import { screen as electronScreen } from 'electron'", "const electronScreen = { getAllDisplays: () => [], getPrimaryDisplay: () => ({}) }")
    .replace("import { promisify } from 'node:util'", "const { promisify } = __util")
    .replace(/^export /gm, "");
  if (/^import /m.test(src)) throw new Error("executor_linux.js imports changed - update this splice");
  const calls = [];
  const cp = {
    execFile(bin, args, opts, cb) {
      if (typeof opts === "function") cb = opts;
      calls.push((args || [])[0]);
      const sub = (args || [])[0];
      setImmediate(() => sub === "frontmost-app" ? cb(null, { stdout: JSON.stringify(frontmost), stderr: "" }) : cb(new Error("not stubbed: " + sub), "", ""));
    },
    spawnSync() { return { status: 1 }; },
  };
  globalThis.__cdbDiag = () => {};
  globalThis.__cuKwinBridgeBin = "/res/kwin-portal-bridge";
  const mod = new Function("__cp", "__util", src + "\nreturn { createLinuxExecutor };")(cp, util);
  return { ex: mod.createLinuxExecutor({ hostBundleId: "com.anthropic.claude" }), calls };
}
function loadRegular(windows) {
  const calls = [];
  const reply = (args) => {
    if (args[0] === "windows" || args[0] === "list-windows") return JSON.stringify(windows);
    if (args[0] === "screens") return JSON.stringify([{ id: "screen", name: "screen", geometry: { x: 0, y: 0, width: 1920, height: 1080 }, scale: 1, is_primary: true }]);
    if (args[0] === "frontmost-app") return JSON.stringify(null);
    return "{}";
  };
  const cp = {
    execFileSync(bin, args) { if (path.basename(String(bin)) !== "x11-bridge") throw new Error("not found"); calls.push(args[0]); return reply(args); },
    execSync() { throw new Error("nope"); },
    spawnSync() { return { status: 1 }; },
    execFile(bin, args, opts, cb) { const c = typeof opts === "function" ? opts : cb; if (path.basename(String(bin)) !== "x11-bridge") { setTimeout(() => c(new Error("not found"), "", ""), 0); return; } calls.push(args[0]); setTimeout(() => c(null, reply(args), ""), 0); },
    spawn() { return { on() {}, unref() {} }; },
  };
  const electron = {
    app: { commandLine: { getSwitchValue: () => "" }, getPath: () => os.tmpdir() },
    screen: { getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 }], getPrimaryDisplay() { return this.getAllDisplays()[0]; }, getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    desktopCapturer: { getSources: async () => [] },
    clipboard: { readText: () => "", writeText: () => {} },
    nativeImage: {},
  };
  const req = (id) => {
    if (id === "child_process") return cp;
    if (id === "electron") return electron;
    if (id === "path") return path;
    if (id === "os") return os;
    if (id === "fs") return { readFileSync: () => Buffer.alloc(0), writeFileSync() {}, unlinkSync() {}, existsSync: () => false, renameSync() {}, accessSync() { throw new Error("no"); }, readdirSync: () => [], statSync: () => ({ isDirectory: () => false }) };
    throw new Error("unexpected require " + id);
  };
  globalThis.__cdbDiag = () => {};
  globalThis.__cuX11BridgeBin = "/res/x11-bridge";
  globalThis.__cuKwinMode = false;
  delete globalThis.__cuGnomeBridgeBin; delete globalThis.__cuWlrootsBridgeBin; delete globalThis.__cuTargetRead;
  process.env.XDG_SESSION_TYPE = "x11"; process.env.XDG_CURRENT_DESKTOP = "XFCE"; delete process.env.WAYLAND_DISPLAY;
  new Function("require", "process", readFileSync(REG, "utf8"))(req, process);
  return { ex: globalThis.__linuxExecutor, calls };
}

const kw = loadKwin({ bundleId: "org.kde.kate", displayName: "Kate" });
const rg = loadRegular([{ id: "0x1", title: "notes.txt - Mousepad", wm_class: "mousepad", app_id: "org.xfce.mousepad", pid: 4242, is_active: true, is_minimized: false, stacking_order: 3, geometry: { x: 0, y: 0, width: 800, height: 600 } }]);
const ours = { "cu_linux_executor.js": rg.ex, "executor_linux.js": kw.ex };

console.log("\n[1] getKeyFocusApp answers what getFrontmostApp answers");
{
  const a = await kw.ex.getFrontmostApp(), b = await kw.ex.getKeyFocusApp?.();
  check("KWin: getKeyFocusApp defined", typeof kw.ex.getKeyFocusApp, "function");
  check("KWin: same app as getFrontmostApp", JSON.stringify(b), JSON.stringify(a));
  check("KWin: one bridge frontmost-app call per lookup", kw.calls.filter((c) => c === "frontmost-app").length, 2);
  check("regular: getKeyFocusApp defined", typeof rg.ex.getKeyFocusApp, "function");
  let r1, r2, e1, e2;
  try { r1 = await rg.ex.getFrontmostApp(); } catch (e) { e1 = e.message; }
  try { r2 = await rg.ex.getKeyFocusApp?.(); } catch (e) { e2 = e.message; }
  check("regular: same answer as getFrontmostApp", JSON.stringify([r2, e2]), JSON.stringify([r1, e1]));
  // Unbound call (upstream calls it as a member, but must not depend on `this`).
  const f = rg.ex.getKeyFocusApp;
  let r3, e3;
  try { r3 = await f?.(); } catch (e) { e3 = e.message; }
  check("regular: works unbound", JSON.stringify([r3, e3]), JSON.stringify([r1, e1]));
  check("regular: no portal command", rg.calls.some((c) => ["zoom", "screenshot", "pointer-move", "key-sequence", "type", "hold-key"].includes(c)), false);
}

// ── upstream's required methods ──────────────────────────────────────────
let skipped = false;
if (!existsSync(path.join(BUILD_DIR, "index.js"))) {
  skipped = true;
  console.log("\n  SKIP bundle sections: no extract under tmp/app.asar.contents/");
} else {
  const files = readdirSync(BUILD_DIR).filter((f) => /^index.*\.js$/.test(f)).sort();
  const blobs = files.map((f) => [f, readFileSync(path.join(BUILD_DIR, f), "utf8")]);
  // Top-level keys of the object literal starting at `start` (the `{`).
  function topKeys(s, start) {
    const keys = [];
    let depth = 0, i = start, str = null;
    for (; i < s.length; i++) {
      const ch = s[i];
      if (str) { if (ch === "\\") { i++; continue; } if (ch === str) str = null; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { str = ch; continue; }
      if (ch === "{" || ch === "(" || ch === "[") { depth++; if (depth === 1 && ch === "{") { /* object start */ } continue; }
      if (ch === "}" || ch === ")" || ch === "]") { depth--; if (depth === 0) break; continue; }
      if (depth === 1 && (s[i - 1] === "{" || s[i - 1] === ",")) {
        const m = /^(?:async )?([A-Za-z_$][\w$]*)\s*(?:\(|:)/.exec(s.slice(i, i + 80));
        if (m) keys.push(m[1]);
      }
    }
    return keys;
  }
  // Upstream's Linux executors: the X11 one (createLinuxExecutor) and the
  // Wayland portal one, both return {capabilities:{...},...}.
  const adapters = [];
  for (const [f, s] of blobs) {
    const m = /createLinuxExecutor:\(\)=>([\w$]+)/.exec(s);
    if (m) {
      const def = s.indexOf("function " + m[1] + "(");
      const ret = s.indexOf("return{capabilities:", def);
      if (def >= 0 && ret > def) adapters.push(["X11 (createLinuxExecutor, " + f + ")", topKeys(s, ret + 6)]);
    }
    const fm = /if\(process\.platform==="linux"\)return [\w$.]+\(\),[\w$.]+\(\)\?([\w$]+)\([\w$]+\):[\w$.]+\([\w$]+\);throw (?:new )?Error\(`computer-use executor not implemented/.exec(s);
    if (fm) {
      const def = s.indexOf("function " + fm[1] + "(");
      const ret = s.indexOf("return{capabilities:", def);
      if (def >= 0 && ret > def) adapters.push(["Wayland portal (" + f + ")", topKeys(s, ret + 6)]);
    }
  }
  console.log("\n[2] upstream's Linux executors in the bundle");
  check("both upstream Linux executors found", adapters.length, 2);
  for (const [name, keys] of adapters) console.log(`  info ${name}: ${keys.join(" ")}`);

  // Caller side: unguarded `.executor.<m>(` and the probes.
  const called = new Set(), guarded = new Set();
  for (const [, s] of blobs) {
    for (const m of s.matchAll(/(deps\.)?executor\.([A-Za-z_$][\w$]*)(\?\.)?(\(|\.bind\b)?/g)) {
      if (m[1]) continue;
      const name = m[2], pre = s.slice(Math.max(0, m.index - 24), m.index), post = s.slice(m.index + m[0].length, m.index + m[0].length + 14);
      if (m[3] || /typeof\s*[\w$.]*$/.test(pre) || /!\s*[\w$.]*$/.test(pre) || /^\s*(?:!==|===|!=|==)\s*(?:void 0|null|undefined)/.test(post) || /^\s*&&/.test(post)) guarded.add(name);
      else if (m[4]) called.add(name);
    }
  }
  const adapterKeys = new Set(adapters.flatMap(([, k]) => k));
  // A method upstream probes anywhere (`if(!e.executor.m)return null;` then
  // `await e.executor.m()`) is one it treats as optional.
  const required = new Set([...called, ...adapterKeys].filter((k) => !guarded.has(k) && k !== "capabilities"));
  const optional = [...adapterKeys].filter((k) => guarded.has(k));
  console.log(`  info required (${required.size}): ${[...required].sort().join(" ")}`);
  console.log(`  info optional (probed before use): ${[...guarded].sort().join(" ")}`);
  console.log(`  info upstream Linux executor methods that are optional: ${optional.sort().join(" ") || "-"}`);
  check("extraction sanity: getFrontmostApp, key and screenshot required", ["getFrontmostApp", "key", "screenshot"].every((k) => required.has(k)), true);
  check("extraction sanity: at least 20 required methods", required.size >= 20, true);
  check("upstream's Linux executors define getKeyFocusApp (4.16336.0+)", adapters.every(([, k]) => k.includes("getKeyFocusApp")), true);

  console.log("\n[3] both our executors define every required method");
  for (const [file, ex] of Object.entries(ours)) {
    const missing = [...required].filter((k) => k === "capabilities" ? !ex.capabilities : typeof ex[k] !== "function").sort();
    check(`${file}: missing required methods`, missing.join(" ") || "none", "none");
  }
}

console.log("");
if (failures.length) {
  console.log(`${failures.length} CHECK(S) FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
if (skipped) { console.log(`${pass} checks passed; bundle sections SKIPPED`); process.exit(3); }
console.log("ALL " + pass + " CHECKS PASSED");
process.exit(0);
