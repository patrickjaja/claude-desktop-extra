#!/usr/bin/env node
// Computer Use: a bridge that is present but cannot run must never be selected.
//
// WHY THIS EXISTS
// ---------------
// js/cu_mode_preamble.js used to pick a bridge on an X_OK check alone. A bridge
// that is on disk but cannot load (NixOS: foreign ELF interpreter; Ubuntu 22.04 /
// Debian 12 / RHEL 9: PipeWire or glibc older than the gnome/kwin bridge floor)
// was selected anyway, every Computer Use action then failed, and the error said
// "reinstall the package" - which fixes nothing. On NixOS KDE the documented
// spectacle tier was never reached, because kwin mode won on X_OK.
//
// This harness runs the REAL preamble (wrapped in an async function, exactly as
// it sits inside upstream's async app-ready handler) against fake bridges in a
// temp resources dir, with the real child_process, and pins:
//
//   1. a working bridge is selected exactly as before (kwin mode on KDE 6.6+);
//   2. an unloadable kwin bridge (exit 127 + loader stderr) routes KDE to the
//      regular executor, and the log names the real cause + a PipeWire hint;
//   3. a foreign-interpreter bridge (execve ENOENT on an existing file) gets the
//      NixOS hint; a GLIBC_x.y error gets the glibc hint; an undefined
//      pw_stream_get_nsec gets the PipeWire >= 1.0.5 hint;
//   4. a bridge that hangs is given up on after ~3 s WITHOUT blocking the event
//      loop, and nothing on the selection path is synchronous;
//   5. the probe is cached per process (one spawn per binary);
//   6. the regular executor's error text carries the cause, not "reinstall".
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..", "..");
const PREAMBLE = path.join(ROOT, "js", "cu_mode_preamble.js");
const EXECUTOR = path.join(ROOT, "js", "cu_linux_executor.js");
const realRequire = createRequire(import.meta.url);
const realCp = realRequire("node:child_process");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

let pass = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; console.log("  PASS " + msg); }
  else { failures.push(msg); console.log("  FAIL " + msg); }
}

const TMP = mkdtempSync(path.join(os.tmpdir(), "cdb-cu-runnable-"));
const FAKE_BIN = path.join(TMP, "bin");
mkdirSync(FAKE_BIN);
function script(file, body) {
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}
// kwin_wayland on PATH reports a KWin new enough for the kwin-portal-bridge.
script(path.join(FAKE_BIN, "kwin_wayland"), "#!/bin/sh\necho 'kwin 6.6.1'\n");

const GOOD = (name) => `#!/bin/sh\necho '${name} 0.1.0'\n`;
const LOADER_PW = (name) =>
  `#!/bin/sh\necho '/usr/lib/claude-desktop/resources/${name}: error while loading shared libraries: libpipewire-0.3.so.0: cannot open shared object file: No such file or directory' >&2\nexit 127\n`;
const GLIBC = (name) =>
  `#!/bin/sh\necho '/usr/lib/claude-desktop/resources/${name}: /lib/x86_64-linux-gnu/libc.so.6: version \`GLIBC_2.39'"'"' not found (required by /usr/lib/claude-desktop/resources/${name})' >&2\nexit 1\n`;
const PW_SYMBOL = (name) =>
  `#!/bin/sh\necho '/usr/lib/claude-desktop/resources/${name}: symbol lookup error: /usr/lib/claude-desktop/resources/${name}: undefined symbol: pw_stream_get_nsec' >&2\nexit 127\n`;
// The kernel answers execve with ENOENT when the interpreter is missing - the
// same errno a NixOS host gives a bridge linked against /lib64/ld-linux-*.so.
const FOREIGN = "#!/nonexistent/lib64/ld-linux-x86-64.so.2\n";
const HANG = "#!/bin/sh\nexec sleep 20\n";

let caseNo = 0;
function resDir(bridges) {
  const d = path.join(TMP, "res" + (++caseNo));
  mkdirSync(d);
  for (const [name, body] of Object.entries(bridges)) script(path.join(d, name), body);
  return d;
}

const ENV_KEYS = ["XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE", "WAYLAND_DISPLAY", "DISPLAY",
  "SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE", "NIRI_SOCKET", "CLAUDE_CU_MODE",
  "KWIN_PORTAL_BRIDGE_BIN", "X11_BRIDGE_BIN", "WLROOTS_BRIDGE_BIN", "GNOME_PORTAL_BRIDGE_BIN", "PATH"];
const GLOBALS = ["__cuKwinMode", "__cuKwinBridgeBin", "__cuX11BridgeBin", "__cuWlrootsBridgeBin",
  "__cuGnomeBridgeBin", "__cuBridgeFail", "__cuBridgeProbeCache", "__cdbDiag"];

// Run the preamble once. `session` sets the env; `keepCache` keeps the per-process
// probe cache from the previous run (models a second evaluation in one process).
async function runPreamble({ res, session, keepCache = false }) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) if (k !== "PATH") delete process.env[k];
  process.env.PATH = FAKE_BIN + ":" + saved.PATH;
  Object.assign(process.env, session);
  const cache = globalThis.__cuBridgeProbeCache;
  for (const k of GLOBALS) delete globalThis[k];
  if (keepCache && cache) globalThis.__cuBridgeProbeCache = cache;
  const diag = [];
  globalThis.__cdbDiag = (m) => diag.push(String(m));
  process.resourcesPath = res;

  const calls = { sync: [], spawn: [] };
  const cp = new Proxy(realCp, {
    get(target, prop) {
      if (prop === "execSync" || prop === "execFileSync" || prop === "spawnSync") {
        return (...a) => { calls.sync.push(prop + " " + String(a[0])); return target[prop](...a); };
      }
      if (prop === "spawn" || prop === "execFile") {
        return (...a) => { calls.spawn.push(path.basename(String(a[0]))); return target[prop](...a); };
      }
      return target[prop];
    }
  });
  const req = (id) => (id === "child_process" || id === "node:child_process") ? cp : realRequire(id);

  // Event-loop liveness: count timer ticks while the preamble is pending.
  let ticks = 0;
  const iv = setInterval(() => { ticks++; }, 50);
  const t0 = Date.now();
  try {
    await new AsyncFunction("require", "process", readFileSync(PREAMBLE, "utf8"))(req, process);
  } finally {
    clearInterval(iv);
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  const out = {
    ms: Date.now() - t0, ticks, diag, calls,
    kwinMode: globalThis.__cuKwinMode, kwinBin: globalThis.__cuKwinBridgeBin,
    x11: globalThis.__cuX11BridgeBin, wlr: globalThis.__cuWlrootsBridgeBin,
    gnome: globalThis.__cuGnomeBridgeBin, fail: globalThis.__cuBridgeFail || {}
  };
  return out;
}

const KDE = { XDG_CURRENT_DESKTOP: "KDE", XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":1" };
const GNOME = { XDG_CURRENT_DESKTOP: "ubuntu:GNOME", XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" };
const X11 = { XDG_CURRENT_DESKTOP: "XFCE", XDG_SESSION_TYPE: "x11", DISPLAY: ":0" };
const joined = (r) => r.diag.join("\n");

async function testWorkingBridges() {
  console.log("\n[1] working bridges are selected exactly as before");
  const res = resDir({ "kwin-portal-bridge": GOOD("kwin-portal-bridge"), "x11-bridge": GOOD("x11-bridge") });
  const r = await runPreamble({ res, session: KDE });
  ok(r.kwinMode === true, "KDE Wayland + KWin 6.6 + runnable kwin bridge -> kwin mode");
  ok(r.kwinBin === path.join(res, "kwin-portal-bridge"), "__cuKwinBridgeBin is the bundled path: " + r.kwinBin);
  ok(/mode=kwin-wayland \(auto: KDE Wayland \+ kwin-portal-bridge at /.test(joined(r)),
     "mode line unchanged: " + r.diag.filter((l) => l.includes("mode=")).join(" | "));
  ok(r.calls.sync.length === 0, "no synchronous child_process call on the selection path: " + r.calls.sync.join(", "));

  const g = resDir({ "gnome-portal-bridge": GOOD("gnome-portal-bridge"), "x11-bridge": GOOD("x11-bridge") });
  const rg = await runPreamble({ res: g, session: GNOME });
  ok(rg.gnome === path.join(g, "gnome-portal-bridge") && rg.x11 === path.join(g, "x11-bridge"),
     "GNOME Wayland: gnome-portal-bridge + x11-bridge resolved");
  ok(rg.kwinMode === false && Object.keys(rg.fail).length === 0, "regular mode, no failures recorded");
  ok(/gnome-portal-bridge resolved at /.test(joined(rg)), "resolved line unchanged");
}

async function testUnloadableKwin() {
  console.log("\n[2] an unloadable kwin bridge routes KDE to the regular executor");
  const res = resDir({ "kwin-portal-bridge": LOADER_PW("kwin-portal-bridge"), "x11-bridge": GOOD("x11-bridge") });
  const r = await runPreamble({ res, session: KDE });
  ok(r.kwinMode === false, "kwin mode NOT selected");
  ok(r.kwinBin === undefined, "__cuKwinBridgeBin left unset");
  ok(r.x11 === path.join(res, "x11-bridge"), "the regular executor gets its x11-bridge");
  const log = joined(r);
  ok(/kwin-portal-bridge .*cannot run/.test(log) && /exit 127/.test(log) && /libpipewire-0\.3\.so\.0/.test(log),
     "log names the real cause (exit code + loader line)");
  ok(/PipeWire/.test(log), "with a PipeWire hint");
  ok(!/reinstall/i.test(log), "and does not tell the user to reinstall");
  ok(/mode=regular/.test(log), "mode line says regular");
  ok(r.fail["kwin-portal-bridge"] && /exit 127/.test(r.fail["kwin-portal-bridge"].cause),
     "cause recorded in __cuBridgeFail for the executor's error text");
}

async function testCauseHints() {
  console.log("\n[3] cause-specific hints");
  const nix = resDir({ "kwin-portal-bridge": FOREIGN, "x11-bridge": GOOD("x11-bridge") });
  const rn = await runPreamble({ res: nix, session: KDE });
  const ln = joined(rn);
  ok(rn.kwinMode === false, "foreign-interpreter kwin bridge: kwin mode not selected");
  ok(/ENOENT/.test(ln) && /interpreter|loader/i.test(ln) && /NixOS/.test(ln) && /KWIN_PORTAL_BRIDGE_BIN/.test(ln),
     "NixOS foreign-loader hint naming the override var: " + (rn.diag.find((l) => /cannot run/.test(l)) || "none"));

  const gl = resDir({ "gnome-portal-bridge": GLIBC("gnome-portal-bridge"), "x11-bridge": GOOD("x11-bridge") });
  const rgl = await runPreamble({ res: gl, session: GNOME });
  ok(rgl.gnome === undefined, "glibc-too-old gnome bridge not selected");
  ok(/glibc >= 2\.39/.test(joined(rgl)), "glibc floor hint: " + (rgl.diag.find((l) => /cannot run/.test(l)) || "none"));

  const pw = resDir({ "gnome-portal-bridge": PW_SYMBOL("gnome-portal-bridge"), "x11-bridge": GOOD("x11-bridge") });
  const rpw = await runPreamble({ res: pw, session: GNOME });
  ok(rpw.gnome === undefined, "old-PipeWire gnome bridge not selected");
  ok(/PipeWire >= 1\.0\.5/.test(joined(rpw)), "PipeWire >= 1.0.5 floor hint");
  ok(rpw.x11 === path.join(pw, "x11-bridge"), "an unaffected bridge is still selected");

  const x = resDir({ "x11-bridge": LOADER_PW("x11-bridge") });
  const rx = await runPreamble({ res: x, session: X11 });
  ok(rx.x11 === undefined && rx.fail["x11-bridge"], "broken x11-bridge on X11 is not selected, cause recorded");
}

async function testHangAndCache() {
  console.log("\n[4] a hanging bridge costs <= ~3 s and never blocks the event loop");
  const res = resDir({ "kwin-portal-bridge": HANG, "x11-bridge": GOOD("x11-bridge") });
  const r = await runPreamble({ res, session: KDE });
  ok(r.kwinMode === false, "hanging kwin bridge not selected");
  ok(r.ms >= 2500 && r.ms < 5000, "gave up after the 3 s budget, took " + r.ms + " ms");
  ok(r.ticks >= 30, "the event loop kept ticking while the probe was pending (" + r.ticks + " ticks of 50 ms)");
  ok(/3 s/.test(joined(r)), "log says it timed out");
  ok(r.calls.sync.length === 0, "no synchronous child_process call: " + r.calls.sync.join(", "));

  console.log("\n[5] the probe is cached per process");
  const c = resDir({ "kwin-portal-bridge": GOOD("kwin-portal-bridge"), "x11-bridge": GOOD("x11-bridge") });
  const r1 = await runPreamble({ res: c, session: KDE });
  const r2 = await runPreamble({ res: c, session: KDE, keepCache: true });
  const bridgeSpawns = (rr) => rr.calls.spawn.filter((b) => /bridge$/.test(b)).length;
  ok(bridgeSpawns(r1) >= 1, "first run probed the bridge(s): " + bridgeSpawns(r1));
  ok(bridgeSpawns(r2) === 0, "second run reused the cached verdict: " + bridgeSpawns(r2) + " bridge spawns");
  ok(r2.kwinMode === true, "and reached the same decision");
}

async function testExecutorErrorText() {
  console.log("\n[6] the regular executor reports the cause, not 'reinstall'");
  const diag = [];
  const saved = { ...process.env };
  for (const k of GLOBALS) delete globalThis[k];
  globalThis.__cdbDiag = (m) => diag.push(String(m));
  globalThis.__cuKwinMode = false;
  globalThis.__cuBridgeFail = {
    "gnome-portal-bridge": {
      path: "/usr/lib/claude-desktop/resources/gnome-portal-bridge",
      cause: "exit 127: symbol lookup error: undefined symbol: pw_stream_get_nsec",
      hint: "needs PipeWire >= 1.0.5 (Ubuntu 24.04+, Fedora 40+, Debian 13+)"
    }
  };
  Object.assign(process.env, GNOME);
  for (const k of ["SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE", "NIRI_SOCKET", "COWORK_SCREENSHOT_CMD",
    "X11_BRIDGE_BIN", "GNOME_PORTAL_BRIDGE_BIN", "WLROOTS_BRIDGE_BIN"]) delete process.env[k];
  const cp = {
    execFileSync() { throw new Error("not found"); },
    execSync() { throw new Error("not found"); },
    spawnSync() { return { status: 1 }; },
    execFile(b, a, o, cb) { setTimeout(() => cb(new Error("no"), "", ""), 0); },
    spawn() { return { on() {}, unref() {} }; }
  };
  const electron = {
    screen: {
      getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, size: { width: 800, height: 600 }, scaleFactor: 1, label: "d" }],
      getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, size: { width: 800, height: 600 }, scaleFactor: 1 }),
      getCursorScreenPoint: () => ({ x: 0, y: 0 })
    },
    desktopCapturer: { getSources: async () => [] },
    clipboard: { readText: () => "", writeText: () => {} }
  };
  const fsStub = {
    readFileSync: () => Buffer.alloc(0), writeFileSync: () => {}, unlinkSync: () => {},
    existsSync: () => false, renameSync: () => {}, accessSync: () => { throw new Error("no"); },
    readdirSync: () => [], statSync: () => ({ isDirectory: () => false, isFile: () => false })
  };
  const req = (id) => ({ child_process: cp, electron, path, os, fs: fsStub })[id] ||
    (() => { throw new Error("unexpected require " + id); })();
  try {
    new Function("require", "process", readFileSync(EXECUTOR, "utf8"))(req, process);
    let err = null;
    try { await globalThis.__linuxExecutor.screenshot({}); } catch (e) { err = e; }
    ok(err && /PipeWire >= 1\.0\.5/.test(err.message) && /pw_stream_get_nsec/.test(err.message),
       "screenshot error carries the cause + hint: " + (err ? err.message.slice(0, 160) : "no error"));
    ok(err && !/reinstall/i.test(err.message), "and no reinstall advice");
    const ib = diag.find((l) => l.includes("input-backend=")) || "";
    ok(/cannot run/.test(ib) && !/reinstall/i.test(ib), "diagnostics input-backend line names the cause: " + ib);
  } finally {
    delete globalThis.__linuxExecutor; delete globalThis.__isVM;
    for (const k of GLOBALS) delete globalThis[k];
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

async function main() {
  if (process.platform !== "linux") { console.log("SKIP: needs Linux execve semantics"); process.exit(3); }
  try {
    await testWorkingBridges();
    await testUnloadableKwin();
    await testCauseHints();
    await testHangAndCache();
    await testExecutorErrorText();
  } catch (e) {
    console.error("\nHARNESS ERROR: " + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
  console.log("");
  if (failures.length) {
    console.log("FAILED " + failures.length + " of " + (pass + failures.length) + " checks:");
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  }
  if (process.exitCode) process.exit(process.exitCode);
  console.log("ALL " + pass + " CHECKS PASSED");
}

main();
