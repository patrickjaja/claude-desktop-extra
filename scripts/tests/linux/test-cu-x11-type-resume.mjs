#!/usr/bin/env node
// x11-bridge `type`: resume after an interruption, timeout scaled with the text.
//
// WHY THIS EXISTS
// ---------------
// A long text typed through x11-bridge ran into the flat 15 s execFileSync
// timeout and the whole text failed; a retry typed it all again (doubled
// text). The bridge now stops at a safe point when signalled (our timeout's
// SIGTERM) or when the keyboard layout changes mid-text, prints
//   {"action":"type","text":<t>,"charCount":N,"interrupted":true,"reason":...}
// on stdout and exits 1. The executor (js/cu_linux_executor.js _x11Type)
// types only Array.from(text).slice(N) then, at most 3 times and only while
// each run makes progress, and scales the timeout with the text.
//
// The real executor runs on a stub execFileSync. Cases:
//   [1] the timeout rule (never below 15 s, grows with length and non-ASCII);
//   [2] resume after a timeout and after a layout change, the rest typed once;
//   [3] no progress, resume limit, a foreign signal: the original error;
//   [4] an older bridge (no stdout result), unparsable stdout, a lock
//       failure (stderr only), a result for another text: as before.
// Exit codes follow the repo convention: 0 = PASS, other = FAIL.
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SRC = readFileSync(path.join(ROOT, "js", "cu_linux_executor.js"), "utf8");

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  PASS " + label + (extra !== undefined ? "  -> " + extra : "")); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + extra : "")); }
}
const J = JSON.stringify;

// script: one entry per `type` call: {ok:true} | {stdout, code, signal, stderr}.
function rig(script) {
  const calls = [], diag = [];
  const err = (e) => { const x = new Error(e.stderr || "Command failed: x11-bridge type"); x.status = e.signal ? null : 1; x.signal = e.signal || null; x.code = e.code; x.stdout = e.stdout ?? ""; x.stderr = e.stderr ?? ""; return x; };
  const cp = {
    execFileSync(bin, args, opts) {
      const b = path.basename(String(bin));
      if (b === "systemd-detect-virt") return "none\n";
      if (b !== "x11-bridge") throw new Error("not found");
      if (args[0] !== "type") return "{}";
      const text = args[args.indexOf("--text") + 1];
      calls.push({ text, timeout: opts && opts.timeout });
      const s = script.shift() || { ok: true };
      if (s.ok) return J({ action: "type", text, charCount: Array.from(text).length });
      throw err(typeof s === "function" ? s(text) : s);
    },
    execSync() { return ""; }, spawnSync() { return { status: 1 }; },
    execFile(b, a, o, cb) { (typeof o === "function" ? o : cb)(new Error("not found"), "", ""); },
    spawn() { return { on() {}, unref() {}, kill() {} }; },
  };
  const electron = {
    app: { commandLine: { getSwitchValue: () => "" }, getPath: () => os.tmpdir() },
    screen: { getAllDisplays: () => [{ id: 1, label: "A", bounds: { x: 0, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }], getPrimaryDisplay: () => ({}), getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    desktopCapturer: { getSources: async () => [] }, clipboard: { readText: () => "", writeText: () => {} }, nativeImage: {},
  };
  const fsStub = { constants: { X_OK: 1, W_OK: 2 }, readFileSync: () => Buffer.from(""), writeFileSync() {}, unlinkSync() {}, renameSync() {}, existsSync: () => false, accessSync(p) { if (String(p) !== "/res/x11-bridge") throw new Error("ENOENT"); }, readdirSync: () => [], statSync: () => ({ isDirectory: () => false }) };
  const req = (id) => ({ child_process: cp, electron, path, os, fs: fsStub })[id] || (() => { throw new Error("unexpected require " + id); })();
  globalThis.__cdbDiag = (m) => diag.push(String(m));
  globalThis.__cuX11BridgeBin = "/res/x11-bridge";
  delete globalThis.__cuGnomeBridgeBin; delete globalThis.__cuWlrootsBridgeBin; delete globalThis.__cuTargetRead; delete globalThis.__cdbCuEscWatch; delete globalThis.__cdbCuEscGrab;
  globalThis.__cuKwinMode = false;
  for (const k of ["SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE", "NIRI_SOCKET", "COWORK_SCREENSHOT_CMD", "X11_BRIDGE_BIN", "WLROOTS_BRIDGE_BIN", "YDOTOOL_SOCKET", "WAYLAND_DISPLAY"]) delete process.env[k];
  Object.assign(process.env, { XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "XFCE", DISPLAY: ":0", PATH: "/usr/bin" });
  new Function("require", "process", SRC)(req, process);
  return { ex: globalThis.__linuxExecutor, calls, diag };
}
const stop = (text, n, reason, extra = {}) => ({ stdout: J({ action: "type", text, charCount: n, interrupted: true, reason }) + "\n", stderr: "x11-bridge: type interrupted", ...extra });
const TIMEOUT = { code: "ETIMEDOUT", signal: "SIGTERM" };
async function typed(r, text) { try { await r.ex.type(text); return null; } catch (e) { return e; } }

// ── [1] timeout ────────────────────────────────────────────────────────────
console.log("\n[1] the type timeout scales with the text");
{
  const r = rig([]);
  await r.ex.type("hello");
  ok(r.calls[0].timeout === 15000, "a short text: 15 s as before", r.calls[0].timeout);
  const long = "a".repeat(2000);
  await r.ex.type(long);
  ok(r.calls[1].timeout === 5000 + 2000 * 15, "2000 ASCII characters: 5 s + 15 ms each = 35 s", r.calls[1].timeout);
  const cyr = "ж".repeat(1000);
  await r.ex.type(cyr);
  ok(r.calls[2].timeout === 5000 + 1000 * 15 + Math.ceil(1000 / 30) * 300, "1000 non-ASCII: + 0.3 s per 30 (spare keycode pages)", r.calls[2].timeout);
  const emoji = "\u{1F600}".repeat(1000);
  await r.ex.type(emoji);
  ok(r.calls[3].timeout === 5000 + 1000 * 15 + Math.ceil(1000 / 30) * 300, "counted in code points, not UTF-16 units", r.calls[3].timeout);
}

// ── [2] resume ─────────────────────────────────────────────────────────────
console.log("\n[2] resume");
{
  const text = "Hello wörld \u{1F600} and the rest of it";
  const cps = Array.from(text);
  const r = rig([{ ...stop(text, 9, "signal"), ...TIMEOUT }, { ok: true }]);
  const e = await typed(r, text);
  ok(e === null && r.calls.length === 2, "timeout after 9 characters: one more run, no error", e && e.message);
  ok(r.calls[1].text === cps.slice(9).join(""), "the second run types only the rest (code points, emoji intact)", J(r.calls[1].text));
  ok(r.diag.some((l) => /stopped after 9 of 32 characters \(signal, timeout\) - typing the remaining 23/.test(l)), "one diag line names the progress", r.diag.find((l) => /x11-bridge type/.test(l)));
  const r2 = rig([stop(text, 4, "keymapChanged"), (t) => stop(t, 3, "keymapChanged"), { ok: true }]);
  const e2 = await typed(r2, text);
  ok(e2 === null && r2.calls.length === 3 && r2.calls[2].text === cps.slice(7).join(""), "layout changed twice: rest after 4, then after 4 + 3", J(r2.calls.map((c) => c.text)));
  const r3 = rig([{ ...stop(text, cps.length, "signal"), ...TIMEOUT }]);
  const e3 = await typed(r3, text);
  ok(e3 === null && r3.calls.length === 1, "stopped after the last character: done, nothing typed again");
}

// ── [3] no resume ──────────────────────────────────────────────────────────
console.log("\n[3] no progress, limit, a foreign signal: the original error");
{
  const text = "abcdef";
  const r = rig([{ ...stop(text, 0, "signal"), ...TIMEOUT }]);
  const e = await typed(r, text);
  ok(e && /interrupted|Command failed/.test(e.message) && r.calls.length === 1, "no progress: the bridge's error, not retried", e && e.message);
  ok(r.diag.some((l) => /not resumed \(no progress\)/.test(l)), "logged as no progress");
  const r2 = rig([stop(text, 1, "keymapChanged"), (t) => stop(t, 1, "keymapChanged"), (t) => stop(t, 1, "keymapChanged"), (t) => stop(t, 1, "keymapChanged"), { ok: true }]);
  const e2 = await typed(r2, text);
  ok(e2 && r2.calls.length === 4, "resume limit: 1 + 3 runs, then the error", r2.calls.length);
  const r3 = rig([stop(text, 2, "signal", { signal: "SIGTERM" })]);
  const e3 = await typed(r3, text);
  ok(e3 && r3.calls.length === 1 && r3.diag.some((l) => /not our stop/.test(l)), "a SIGTERM that is not our timeout (app quit): not resumed");
  const r4 = rig([stop(text, 99, "signal", TIMEOUT)]);
  ok((await typed(r4, text)) && r4.calls.length === 1, "a charCount past the text: not resumed");
}

// ── [4] as before ──────────────────────────────────────────────────────────
console.log("\n[4] older bridge, unparsable stdout, lock failure: as before");
{
  const text = "abcdef";
  const old = rig([{ stdout: "", stderr: "", ...TIMEOUT }]);
  const e = await typed(old, text);
  ok(e && e.code === "ETIMEDOUT" && old.calls.length === 1 && !old.diag.some((l) => /x11-bridge type/.test(l)), "an older bridge killed by the timeout: the same error, one run, no new log line", e && e.code);
  const garbage = rig([{ stdout: "{not json", stderr: "boom", ...TIMEOUT }]);
  const e2 = await typed(garbage, text);
  ok(e2 && garbage.calls.length === 1, "unparsable stdout: the error, one run");
  const ok1 = rig([{ stdout: J({ action: "type", text, charCount: 3 }) }]);
  ok((await typed(ok1, text)) && ok1.calls.length === 1, "a result without interrupted:true: not resumed");
  const lock = rig([{ stdout: "", stderr: "x11-bridge: another bridge holds the keymap lock" }]);
  const e4 = await typed(lock, text);
  ok(e4 && /keymap lock/.test(e4.message) && lock.calls.length === 1, "keymap lock not taken (stderr only, nothing typed): the error, not retried", e4 && e4.message);
  const other = rig([{ ...stop("something else", 2, "signal"), ...TIMEOUT }]);
  ok((await typed(other, text)) && other.calls.length === 1, "a result for another text: not resumed");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
