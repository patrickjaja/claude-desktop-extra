#!/usr/bin/env node
// "Keep computer awake" must hold a logind idle inhibitor on Linux desktops
// where Chromium's powerSaveBlocker is a silent no-op, and must never leak it.
//
// WHY THIS EXISTS
// ---------------
// Chromium's Linux "prevent-app-suspension" blocker only calls
// org.gnome.SessionManager.Inhibit, then org.freedesktop.PowerManagement.Inhibit,
// and does nothing when neither name has an owner (Sway, Hyprland, niri, i3, ...).
// js/keep_awake_inhibit.js (injected by patches/linux/fix_keep_awake_linux.nim)
// holds `systemd-inhibit --what=idle --mode=block cat` in that case.
//
// This harness runs the real helper source in child node processes, with fake
// `systemd-inhibit` and `busctl` on a sandboxed PATH, and asserts:
//   - start spawns one inhibitor with the right arguments; stop kills it
//   - double start spawns once; start/stop/start leaves exactly one
//   - app "will-quit", process exit and SIGKILL of the app all release it
//   - an owned native service (GNOME / fd.o PowerManagement) means no spawn
//   - no systemd-inhibit on PATH means no spawn and no throw
//   - no busctl means the inhibitor is still taken
//   - stop during the async probe means no spawn
//   - start() returns upstream's blocker id unchanged
// and, when the compiled patch binary exists, runs it on an upstream-shaped
// fixture and drives the patched start/stop site end to end.
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import { readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, existsSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const helperPath = join(repo, "js", "keep_awake_inhibit.js");
const patchBin = join(repo, "patches", "linux", "fix_keep_awake_linux");

for (const tool of ["bash", "cat", "sleep"]) {
  const r = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
  if (r.status !== 0) {
    console.log(`SKIP: ${tool} not available`);
    process.exit(3);
  }
}

let pass = 0;
const failures = [];
function check(label, ok, detail = "") {
  if (ok) {
    console.log(`  PASS ${label}`);
    pass++;
  } else {
    console.log(`  FAIL ${label}${detail ? " - " + detail : ""}`);
    failures.push(label);
  }
}

const scratch = join(tmpdir(), `cdb-keep-awake-${process.pid}`);
rmSync(scratch, { recursive: true, force: true });
const toolsDir = join(scratch, "tools");
const inhibitDir = join(scratch, "inhibit");
const busctlDir = join(scratch, "busctl");
for (const d of [toolsDir, inhibitDir, busctlDir]) mkdirSync(d, { recursive: true });
for (const t of ["cat", "sleep"]) {
  const p = spawnSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
  symlinkSync(p, join(toolsDir, t));
}
const bash = spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim();

// Fake systemd-inhibit: log argv, then exec the trailing command (after the
// --options) like the real one runs it, so `cat` blocks on our stdin pipe.
writeFileSync(
  join(inhibitDir, "systemd-inhibit"),
  `#!${bash}
printf '%s\\n' "$*" >> "$FAKE_LOG"
while [ $# -gt 0 ] && [ "\${1#--}" != "$1" ]; do shift; done
exec "$@"
`
);
// Fake busctl: NameHasOwner answers "b true" only for $FAKE_NATIVE.
writeFileSync(
  join(busctlDir, "busctl"),
  `#!${bash}
[ -n "$FAKE_BUSCTL_DELAY" ] && sleep "$FAKE_BUSCTL_DELAY"
name="\${!#}"
if [ "$name" = "$FAKE_NATIVE" ]; then echo "b true"; else echo "b false"; fi
`
);
chmodSync(join(inhibitDir, "systemd-inhibit"), 0o755);
chmodSync(join(busctlDir, "busctl"), 0o755);

// Driver: loads a JS file (the helper, or a patched fixture) with a fake
// electron module, runs one scenario, prints JSON lines.
const driver = join(scratch, "driver.cjs");
writeFileSync(
  driver,
  `
const Module = require("module");
const { EventEmitter } = require("events");
const app = new EventEmitter();
const psb = { started: 0, stopped: [] , start(t){ this.started++; this.type=t; return 42; }, stop(id){ this.stopped.push(id); } };
const orig = Module._load;
Module._load = function (r, ...a) { if (r === "electron") return { app, powerSaveBlocker: psb }; return orig.call(this, r, ...a); };
const logs = [];
globalThis.__cdbDiag = (m) => logs.push(m);
const src = require("fs").readFileSync(process.env.LOAD_JS, "utf8");
const glue = process.env.GLUE || "";
eval(src + "\\n" + glue);
const K = globalThis.__cdbKeepAwake;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const st = () => K._state();
// Poll instead of sleeping a fixed time, so a loaded machine cannot flake us.
const until = async (cond, ms = 8000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await wait(20); };
const logLines = () => require("fs").readFileSync(process.env.FAKE_LOG, "utf8").split("\\n").filter(Boolean).length;
// Probe finished and, if an inhibitor was spawned, its argv is logged (the fake
// logs before exec'ing cat, so stopping earlier could lose the line).
const settled = async (n = 1) => { await until(() => st().probes >= n); if (st().pid) await until(() => logLines() >= 1); };
(async () => {
  const sc = process.env.SCENARIO;
  if (sc === "basic") {
    const id = K.start(42); await settled();
    const s1 = st(); K.stop();
    out({ id, pidAfterStart: s1.pid, pidAfterStop: st().pid, logs });
  } else if (sc === "double") {
    K.start(1); K.start(1); await settled(); await wait(100);
    const s = st(); K.stop(); await wait(200); out({ pid: s.pid, logs });
  } else if (sc === "restart") {
    K.start(1); K.stop(); K.start(2); await settled(2);
    const s = st(); K.stop(); await wait(200); out({ pid: s.pid, logs });
  } else if (sc === "quit") {
    K.start(1); await settled(); const s = st();
    app.emit("will-quit"); out({ pid: s.pid, after: st().pid, logs });
  } else if (sc === "exit" || sc === "sigkill") {
    K.start(1); await settled(); out({ pid: st().pid, logs });
    if (sc === "exit") process.exit(0); else process.kill(process.pid, "SIGKILL");
  } else if (sc === "probe") {
    K.start(1); if (process.env.NOPROBE) await wait(200); else await settled(); const s = st(); K.stop(); out({ pid: s.pid, logs });
  } else if (sc === "race") {
    K.start(1); await wait(50); K.stop(); await settled(); out({ pid: st().pid, logs });
  } else if (sc === "patched") {
    globalThis.claim("x"); await settled(); const s = st();
    globalThis.release("x");
    out({ pid: s.pid, after: st().pid, started: psb.started, type: psb.type, stopped: psb.stopped, logs });
  }
})();
`
);

const logFile = join(scratch, "inhibit.log");
function run(scenario, { path, native = "", delay = "", load = helperPath, glue = "", noprobe = "" } = {}) {
  writeFileSync(logFile, "");
  const r = spawnSync(process.execPath, [driver], {
    encoding: "utf8",
    env: {
      PATH: path,
      SCENARIO: scenario,
      FAKE_LOG: logFile,
      FAKE_NATIVE: native,
      FAKE_BUSCTL_DELAY: delay,
      LOAD_JS: load,
      GLUE: glue,
      NOPROBE: noprobe,
    },
    timeout: 15000,
  });
  const line = (r.stdout || "").trim().split("\n").filter(Boolean).pop() || "{}";
  let res = {};
  try {
    res = JSON.parse(line);
  } catch {
    res = { parseError: line, stderr: r.stderr };
  }
  res.spawns = readFileSync(logFile, "utf8").split("\n").filter(Boolean);
  res.status = r.status;
  res.signal = r.signal;
  return res;
}
function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
const sleepMs = (ms) => execFileSync("sleep", [String(ms / 1000)]);
// Poll for the process to disappear (up to 8 s) instead of a fixed sleep.
function gone(pid) {
  for (let i = 0; i < 160 && alive(pid); i++) sleepMs(50);
  return !alive(pid);
}

const ALL = [inhibitDir, busctlDir, toolsDir].join(":");
const EXPECTED_ARGS = "--what=idle --who=Claude --why=Keep computer awake is on --mode=block cat";

console.log("helper behavior (fake systemd-inhibit + busctl):");
{
  const r = run("basic", { path: ALL });
  check("start() returns upstream's id unchanged", r.id === 42, JSON.stringify(r.id));
  check("start spawns one inhibitor", r.spawns.length === 1 && !!r.pidAfterStart, JSON.stringify(r));
  check("inhibitor arguments", r.spawns[0] === EXPECTED_ARGS, r.spawns[0]);
  check("stop clears state", r.pidAfterStop === null);
  check("stop kills the inhibitor process", gone(r.pidAfterStart));
}
{
  const r = run("double", { path: ALL });
  check("double start spawns once", r.spawns.length === 1 && !!r.pid, JSON.stringify(r.spawns));
  check("double start leaves no process after stop", gone(r.pid));
}
{
  const r = run("restart", { path: ALL });
  check("start/stop/start spawns exactly one", r.spawns.length === 1 && !!r.pid, JSON.stringify(r.spawns));
}
{
  const r = run("quit", { path: ALL });
  check("app will-quit releases the inhibitor", !!r.pid && r.after === null && gone(r.pid), JSON.stringify(r));
}
for (const sc of ["exit", "sigkill"]) {
  const r = run(sc, { path: ALL });
  check(`${sc} of the app releases the inhibitor`, !!r.pid && gone(r.pid), JSON.stringify({ pid: r.pid, signal: r.signal }));
}
for (const native of ["org.gnome.SessionManager", "org.freedesktop.PowerManagement"]) {
  const r = run("probe", { path: ALL, native });
  check(`native ${native} owned -> no inhibitor`, r.spawns.length === 0 && r.pid === null, JSON.stringify(r));
  check(`native ${native} logged`, (r.logs || []).some((l) => l.includes(native)));
}
{
  const r = run("probe", { path: [busctlDir, toolsDir].join(":"), noprobe: "1" });
  check("no systemd-inhibit on PATH -> no spawn, no throw", r.status === 0 && r.spawns.length === 0 && r.pid === null, JSON.stringify(r));
  check("missing systemd-inhibit logged", (r.logs || []).some((l) => l.includes("not on PATH")));
}
{
  const r = run("probe", { path: [inhibitDir, toolsDir].join(":") });
  check("no busctl -> inhibitor still taken", r.spawns.length === 1 && !!r.pid, JSON.stringify(r));
}
{
  const r = run("race", { path: ALL, delay: "0.3" });
  check("stop during probe -> no spawn", r.spawns.length === 0 && r.pid === null, JSON.stringify(r));
}

console.log("patched upstream site (compiled patch on an upstream-shaped fixture):");
if (!existsSync(patchBin)) {
  console.log("  SKIP patch binary not built (cd patches && make)");
} else {
  // v2.7032.0 shape of upstream's keep-awake claim set and its single
  // start/stop site, with its logger and config gate stubbed.
  const fixture = join(scratch, "fixture.js");
  writeFileSync(
    fixture,
    `"use strict";var a=require("electron"),P={info(){}};function PV(){return !0}` +
      `var HV=new Set,UV=null;function VKn(e){let t=HV.size>0&&PV();t&&UV===null?(UV=a.powerSaveBlocker.start("prevent-app-suspension"),P.info("[keep-awake] started (id=%d, claims=%s)",UV,[...HV].join(","))):!t&&UV!==null&&(a.powerSaveBlocker.stop(UV),HV.size===0?P.info("[keep-awake] stopped (id=%d): last claim %s released",UV,e):P.info("x"),UV=null)}` +
      `function WV(e){HV.has(e)||(HV.add(e),VKn())}function GV(e){HV.delete(e)&&VKn(e)}`
  );
  const p = spawnSync(patchBin, [fixture], { encoding: "utf8" });
  check("patch applies to the fixture", p.status === 0, p.stdout + p.stderr);
  const once = readFileSync(fixture, "utf8");
  const p2 = spawnSync(patchBin, [fixture], { encoding: "utf8" });
  check("patch is idempotent", p2.status === 0 && readFileSync(fixture, "utf8") === once, p2.stdout);
  const r = run("patched", { path: ALL, load: fixture, glue: "globalThis.claim=WV;globalThis.release=GV;" });
  check("patched start calls upstream blocker with prevent-app-suspension", r.started === 1 && r.type === "prevent-app-suspension", JSON.stringify(r));
  check("patched start holds the inhibitor", !!r.pid && r.spawns.length === 1, JSON.stringify(r));
  check("patched stop calls upstream stop with its id and releases", JSON.stringify(r.stopped) === "[42]" && r.after === null, JSON.stringify(r));
  check("patched stop leaves no inhibitor process", gone(r.pid));
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
