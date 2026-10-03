#!/usr/bin/env node
/*
 * test-transcript-limits-main.mjs - the main-process half of "Load large
 * sessions in full" (js/transcript_limits_main.js).
 *
 * A clean patch run says nothing about WHAT the module hands Anthropic's session
 * manager, WHICH file the pref is written to, whether a .jsonc lock wins, or
 * whether "off" really is untouched upstream. So this runs the real module with
 * electron shimmed and a temporary profile dir. Exit 0 = PASS, other = FAIL.
 */
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import Module from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MIB = 1048576;
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok   " + n); }
  else { fail++; console.log("  FAIL " + n); } };
const tick = () => new Promise((r) => setTimeout(r, 5));

// profileDir: a string for a real profile dir; platform: "linux" unless testing
// the gate; env: the process.env the module sees (and mutates).
function load(profileDir, { platform = "linux", env = {}, diag = true } = {}) {
  const handlers = {};
  const logs = [];
  const electron = {
    app: { getPath: () => profileDir, on: () => {} },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }
  };
  const src = readFileSync(join(ROOT, "js/transcript_limits_main.js"), "utf8");
  const sandbox = {
    require: (m) => (m === "electron" ? electron : Module.createRequire(import.meta.url)(m)),
    process: { platform, env }, console, globalThis: {}, setTimeout
  };
  if (diag) sandbox.__cdbDiag = (m) => logs.push(m);
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, vm.createContext(sandbox));
  return { handlers, logs, g: sandbox, env: sandbox.process.env };
}
function profile(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cdb-tlimits-main-"));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}
const J = "claude-desktop-extra.json", JC = "claude-desktop-extra.jsonc";
// A real webContents always has isDestroyed(); okSender must fail CLOSED if it is
// ever missing, so every fake sender below carries one.
function sender(url) { return { sender: { getURL: () => url, isDestroyed: () => false } }; }
const okEv = sender("https://claude.ai/settings");
const snap = (o) => JSON.stringify(o);

// --- 1. default: OFF, and off is completely untouched ----------------------------
{
  const dir = profile();
  const m = load(dir, { env: { CDB_TRANSCRIPT_LIMITS: "1,2,3,4" } });
  ok(typeof m.handlers["cdb-tlimits:pref-read"] === "function", "registers cdb-tlimits:pref-read");
  ok(typeof m.handlers["cdb-tlimits:pref-set"] === "function", "registers cdb-tlimits:pref-set");
  ok(typeof m.g.__cdbTranscriptLimits === "function", "exposes globalThis.__cdbTranscriptLimits");
  ok(m.g.__cdbTranscriptLimits() === undefined,
     "OFF: __cdbTranscriptLimits() is undefined, so loadLimits stays unset and upstream's numbers stand");
  ok(!("CDB_TRANSCRIPT_LIMITS" in m.env),
     "OFF: an inherited CDB_TRANSCRIPT_LIMITS is scrubbed, so the worker cannot be switched on behind the pref's back");
  const r = await m.handlers["cdb-tlimits:pref-read"](okEv);
  ok(r.ok === true && r.enabled === false && r.source === "default" && r.lockedByJsonc === false,
     "defaults to off (opt-in), unlocked, source default");
  ok(r.mainMiB === 256 && r.subagentMiB === 192, "reports the 'on' defaults (256 / 192 MiB) for the row to show");
  ok(r.activeNow === false && r.pendingRestart === false, "nothing owed: not active, not wanted");
  await tick();
  ok(m.logs.some((l) => /installed \(main\); transcriptLimits=off/.test(l) && /untouched/.test(l)), "logs that Anthropic's limits are untouched");
  m.g.__cdbTranscriptLimits();
  ok(m.logs.some((l) => /session manager #1 asked for limits -> off - passing nothing/.test(l)),
     "logs when a session manager asks and gets nothing (proves the hook fired, and that off passes nothing)");
  rmSync(dir, { recursive: true, force: true });
}

// --- 2. ON with defaults: the derivation -------------------------------------------
{
  const dir = profile({ [J]: { transcriptLimits: true } });
  const m = load(dir);
  const L = m.g.__cdbTranscriptLimits();
  ok(L && L.mainBytes === 256 * MIB && L.subagentBytes === 192 * MIB, "ON: main 256 MiB, subagents 192 MiB");
  // ceil((256+192)*1.25) = 560 per session, total = 2x = 1120.
  ok(L.cachedEntryBytes === 560 * MIB, "ON: per-session cache ceiling = 1.25x (main + subagents) = 560 MiB");
  ok(L.cachedTotalBytes === 1120 * MIB, "ON: cache total = 2x the per-session ceiling = 1120 MiB");
  ok(L.cachedEntryBytes >= L.mainBytes + L.subagentBytes,
     "ceiling always covers main + subagents (else the main window is re-truncated)");
  ok(m.env.CDB_TRANSCRIPT_LIMITS === [L.mainBytes, L.subagentBytes, L.cachedEntryBytes, L.cachedTotalBytes].join(","),
     "ON: the worker gate carries the same four numbers, in order");
  const r = await m.handlers["cdb-tlimits:pref-read"](okEv);
  ok(r.enabled === true && r.activeNow === true && r.pendingRestart === false && r.activeMainMiB === 256,
     "the running app was started with it, so no restart is owed");
  await tick();
  ok(m.logs.some((l) => /installed \(main\); transcriptLimits=on/.test(l)), "logs that it is installed and on");
  ok(m.logs.some((l) => /session manager #1 asked for limits -> on: main 256 MiB, subagents 192 MiB, parse cache 560 MiB per session \/ 1120 MiB total/.test(l)),
     "logs the effective numbers the first time a session manager asks");
  const copy = m.g.__cdbTranscriptLimits(); copy.mainBytes = 1;
  ok(m.g.__cdbTranscriptLimits().mainBytes === 256 * MIB, "callers get a copy; mutating it cannot change the next manager's limits");
  rmSync(dir, { recursive: true, force: true });
}

// --- 3. custom numbers, per-key merge (.jsonc wins per key, .json fills the rest) ---
{
  const dir = profile({
    [JC]: '{\n  // hand-edited\n  "transcriptLimits": true,\n  "transcriptLimitsMainMiB": 512, "transcriptLimitsSubagentMiB": 384\n}\n'
  });
  const m = load(dir);
  const L = m.g.__cdbTranscriptLimits();
  ok(L.mainBytes === 512 * MIB && L.subagentBytes === 384 * MIB, "custom numbers from the .jsonc are used");
  ok(L.cachedEntryBytes === 1120 * MIB && L.cachedTotalBytes === 2240 * MIB,
     "the cache is re-derived from the custom numbers (ceil(896 * 1.25) = 1120, total 2240)");
  const r = await m.handlers["cdb-tlimits:pref-read"](okEv);
  ok(r.lockedByJsonc === true && r.source === "jsonc-locked", "a switch value in the .jsonc reports locked");
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = profile({ [JC]: { transcriptLimits: true }, [J]: { transcriptLimitsMainMiB: 300 } });
  const L = load(dir).g.__cdbTranscriptLimits();
  ok(L.mainBytes === 300 * MIB && L.subagentBytes === 192 * MIB,
     "per-key merge: main from the .json, subagents default, switch from the .jsonc");
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = profile({ [JC]: { transcriptLimits: true, transcriptLimitsMainMiB: 100 }, [J]: { transcriptLimitsMainMiB: 999 } });
  ok(load(dir).g.__cdbTranscriptLimits().mainBytes === 100 * MIB, "the .jsonc wins when both files carry the number");
  rmSync(dir, { recursive: true, force: true });
}

// --- 4. numbers: both directions allowed; clamped into range, non-numbers fall back ---
{
  const dir = profile({ [J]: { transcriptLimits: true, transcriptLimitsMainMiB: 20, transcriptLimitsSubagentMiB: 10 } });
  const L = load(dir).g.__cdbTranscriptLimits();
  ok(L.mainBytes === 20 * MIB && L.subagentBytes === 10 * MIB,
     "LOWER than Anthropic's own numbers is allowed (a weak machine may want less)");
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = profile({ [J]: { transcriptLimits: true, transcriptLimitsMainMiB: 8, transcriptLimitsSubagentMiB: 4096 } });
  const L = load(dir).g.__cdbTranscriptLimits();
  ok(L.mainBytes === 8 * MIB && L.subagentBytes === 4096 * MIB, "the range endpoints (8 and 4096 MiB) are accepted");
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = profile({ [J]: { transcriptLimits: true, transcriptLimitsMainMiB: 100.4 } });
  ok(load(dir).g.__cdbTranscriptLimits().mainBytes === 100 * MIB, "a fractional number is rounded to whole MiB");
  rmSync(dir, { recursive: true, force: true });
}
// Same as coworkGlowOpacity: a number outside the range is CLAMPED into it, a value that
// is not a number falls back to the default, and nothing is warned about - the numbers in
// effect (shown in the row and the startup log) are the feedback.
for (const [label, val, want] of [["below the minimum", 7, 8], ["above the maximum", 5000, 4096], ["negative", -5, 8]]) {
  const dir = profile({ [J]: { transcriptLimits: true, transcriptLimitsMainMiB: val } });
  const m = load(dir);
  const L = m.g.__cdbTranscriptLimits();
  await tick();
  ok(L.mainBytes === want * MIB, "a number outside the range (" + label + ") is clamped to " + want + " MiB, as coworkGlowOpacity is");
  ok(m.logs.every((l) => !/WARN/.test(l)), "...without a warning (" + label + ")");
  rmSync(dir, { recursive: true, force: true });
}
// A quoted number is accepted, as coworkGlowOpacity accepts "0.5": an easy slip in hand-edited JSON.
for (const [label, val, want] of [["a quoted number", "100", 100], ["a quoted number above the range", "5000", 4096], ["a quoted number below the range", "2", 8]]) {
  const dir = profile({ [J]: { transcriptLimits: true, transcriptLimitsMainMiB: val } });
  const L = load(dir).g.__cdbTranscriptLimits();
  ok(L.mainBytes === want * MIB, label + " is read like coworkGlowOpacity reads one (" + JSON.stringify(val) + " -> " + want + " MiB)");
  rmSync(dir, { recursive: true, force: true });
}
for (const [label, val] of [["text", "lots"], ["an empty string", ""], ["null", null], ["an object", {}], ["an array", []], ["a boolean", true]]) {
  const dir = profile({ [J]: { transcriptLimits: true, transcriptLimitsMainMiB: val } });
  const L = load(dir).g.__cdbTranscriptLimits();
  ok(L.mainBytes === 256 * MIB, "a value that is not a number (" + label + ") falls back to the default");
  rmSync(dir, { recursive: true, force: true });
}

// --- 4b. a misspelled key is ignored, exactly as every other feature's config is ----------
// The real-world case was "transcriptLimtisMainMiB": 20 (letters swapped). Like a misspelled
// coworkGlowOpacity it simply has no effect; the row and the startup log show the numbers
// actually in effect, which is how it shows.
{
  const dir = profile({ [J]: { transcriptLimits: true, transcriptLimtisMainMiB: 20 } });
  const m = load(dir);
  const L = m.g.__cdbTranscriptLimits();
  const r = await m.handlers["cdb-tlimits:pref-read"](okEv);
  await tick();
  ok(L.mainBytes === 256 * MIB && r.mainMiB === 256, "a misspelled key is ignored: the default stays, and the row reports the numbers in effect");
  ok(!("warnings" in r) && m.logs.every((l) => !/WARN/.test(l)), "...with no warning, like every other feature's config");
  rmSync(dir, { recursive: true, force: true });
}

// --- 5. "restart owed" reporting --------------------------------------------------------
{
  const dir = profile({ [J]: { transcriptLimits: true } });
  const m = load(dir);                                   // started ON with 256
  writeFileSync(join(dir, J), JSON.stringify({ transcriptLimits: true, transcriptLimitsMainMiB: 300 }));
  const r = await m.handlers["cdb-tlimits:pref-read"](okEv);
  ok(r.pendingRestart === true && r.mainMiB === 300 && r.activeMainMiB === 256,
     "editing the numbers after start: saved 300 vs running 256 -> restart owed");
  const off = await m.handlers["cdb-tlimits:pref-set"](okEv, false);
  ok(off.ok === true && off.enabled === false && off.pendingRestart === true,
     "switching OFF while the app runs ON: the change is saved, a restart is owed");
  ok(m.g.__cdbTranscriptLimits() !== undefined, "...and the running app keeps what it started with (not live)");
  rmSync(dir, { recursive: true, force: true });
}

// --- 6. pref-set: which file, what survives, locks, refusals ---------------------------------
{
  const dir = profile({ [J]: { someOtherExtra: "keep me" } });
  const m = load(dir);
  const on = await m.handlers["cdb-tlimits:pref-set"](okEv, true);
  ok(on.ok === true && on.enabled === true && on.pendingRestart === true,
     "pref-set(true) saves and reports that a restart is owed");
  const disk = JSON.parse(readFileSync(join(dir, J), "utf8"));
  ok(disk.transcriptLimits === true && disk.someOtherExtra === "keep me",
     "pref-set wrote claude-desktop-extra.json and kept every other key");
  const off = await m.handlers["cdb-tlimits:pref-set"](okEv, false);
  const offDisk = JSON.parse(readFileSync(join(dir, J), "utf8"));
  ok(off.ok === true && !("transcriptLimits" in offDisk) && offDisk.someOtherExtra === "keep me",
     "setting back to the default REMOVES the key instead of writing false");
  const bad = await m.handlers["cdb-tlimits:pref-set"](okEv, "yes");
  ok(bad.ok === false, "pref-set rejects a non-boolean");
  rmSync(dir, { recursive: true, force: true });
}
{
  const untouched = '{\n  "someOtherExtra": "leave me alone"\n}\n';
  const dir = profile({ [JC]: '{ "transcriptLimits": false }', [J]: untouched });
  const m = load(dir);
  const set = await m.handlers["cdb-tlimits:pref-set"](okEv, true);
  ok(set.ok === false && /claude-desktop-extra\.jsonc/.test(set.error), "pref-set refuses while the .jsonc holds the switch");
  ok(readFileSync(join(dir, J), "utf8") === untouched, "a refused (locked) pref-set does not touch the .json at all");
  rmSync(dir, { recursive: true, force: true });
}
{
  const broken = '{ "someOtherExtra": 1,, }';
  const dir = profile({ [J]: broken });
  const m = load(dir);
  const set = await m.handlers["cdb-tlimits:pref-set"](okEv, true);
  ok(set.ok === false && /not valid JSON/.test(set.error), "a broken .json is refused, not silently overwritten");
  ok(readFileSync(join(dir, J), "utf8") === broken, "...and left byte-for-byte as it was");
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = profile({ [J]: '{\n  "note": "see a//b for details",\n  "transcriptLimits": true\n}\n' });
  const r = await load(dir).handlers["cdb-tlimits:pref-read"](okEv);
  ok(r.ok === true && r.enabled === true, "comment stripping does not corrupt a string value containing //");
  rmSync(dir, { recursive: true, force: true });
}

// --- 7. sender checks: remote claude.ai code is the caller ---------------------------------------
{
  const dir = profile();
  const h = load(dir).handlers;
  const evil = await h["cdb-tlimits:pref-set"](sender("https://evil.example"), true);
  ok(evil.ok === false && /sender/.test(evil.error), "rejects an unrecognised sender");
  const sub = await h["cdb-tlimits:pref-set"](sender("https://evil.example/?next=claude.ai"), true);
  ok(sub.ok === false, "rejects a URL that merely CONTAINS claude.ai (origin comparison, not substring)");
  const look = await h["cdb-tlimits:pref-read"](sender("https://claude.ai.evil.example/"));
  ok(look.ok === false, "rejects a lookalike host that starts with claude.ai");
  const noDestroyed = await h["cdb-tlimits:pref-read"]({ sender: { getURL: () => "https://claude.ai/x" } });
  ok(noDestroyed.ok === false, "fails CLOSED when the sender has no isDestroyed()");
  const framed = await h["cdb-tlimits:pref-read"]({ sender: { getURL: () => "https://claude.ai/x", isDestroyed: () => false }, senderFrame: { parent: {} } });
  ok(framed.ok === false, "rejects a call from a sub-frame");
  for (const u of ["https://claude.ai/x", "https://preview.claude.ai/x", "https://claude.com/x", "https://preview.claude.com/x"]) {
    const res = await h["cdb-tlimits:pref-read"](sender(u));
    ok(res.ok === true, "accepts the allowed origin " + new URL(u).origin);
  }
  rmSync(dir, { recursive: true, force: true });
}

// --- 7b. logging: the real logger does not exist yet when this module loads --------------
// __cdbDiag is defined inside upstream's app "ready" handler, and console.log is
// discarded by the official build, so anything written before it exists is lost.
// The module must write NOTHING until it appears, then flush what it queued.
{
  const dir = profile({ [J]: { transcriptLimits: true } });
  const m = load(dir, { diag: false });
  m.g.__cdbTranscriptLimits();                 // a manager asks before the logger exists
  await tick();
  ok(m.logs.length === 0, "no logger yet: nothing is written (and nothing is lost to a discarded console.log)");
  m.g.__cdbDiag = (x) => m.logs.push(x);       // upstream's ready handler defines it
  await new Promise((r) => setTimeout(r, 700)); // the module polls every 500 ms
  ok(m.logs.some((l) => /installed \(main\); transcriptLimits=on/.test(l)), "once the logger exists, the queued 'installed' line is flushed");
  ok(m.logs.some((l) => /session manager #1 asked for limits -> on: main 256 MiB/.test(l)),
     "and so is the hand-out that happened before it existed");
  for (let i = 0; i < 4; i++) m.g.__cdbTranscriptLimits();
  ok(m.logs.filter((l) => /asked for limits/.test(l)).length === 2,
     "only the first two hand-outs are logged (the session manager and the sidebar reader), never one line per call");
  rmSync(dir, { recursive: true, force: true });
}

// --- 8. platform gate: the whole feature is Linux-repackage only ------------------------------------------
{
  const dir = profile({ [J]: { transcriptLimits: true } });
  const m = load(dir, { platform: "darwin" });
  ok(Object.keys(m.handlers).length === 0 && m.g.__cdbTranscriptLimits === undefined,
     "on a non-linux platform nothing is installed");
  rmSync(dir, { recursive: true, force: true });
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
