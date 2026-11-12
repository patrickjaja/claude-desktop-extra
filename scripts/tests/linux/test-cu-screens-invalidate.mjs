#!/usr/bin/env node
// Monitor hotplug vs the cached bridge monitor list in js/cu_linux_executor.js.
//
// A capture maps its region to a bridge monitor and passes the name as
// `zoom --display <name>`. The executor caches the bridge's `screens` answer:
// wlroots/GNOME for the process (only a GNOME portal session start dropped it),
// x11 forever, a FAILED x11 enumeration included (cached as []). After a monitor
// was unplugged or renamed every zoom named a display the bridge no longer has
// and answered "display `<name>` not found" (the same text in all three bridges)
// until Claude was restarted; on X11 one slow `screens` at startup pinned every
// later capture to root coordinates with no --display.
//
// Pinned here against the real executor (child_process / fs / electron stubbed):
//   1. hotplug: a not-found zoom drops the cache, re-queries `screens` ONCE and
//      retries the zoom ONCE on the fresh monitor - x11, wlroots and GNOME, via
//      screenshot and zoom;
//   2. a second not-found is not retried again (no loop): it takes the normal
//      failure path (logged, next tier);
//   3. any other zoom error is not retried;
//   4. x11: a failed `screens` is not cached - retried after the 30 s window;
//   5. none of this spawns synchronously (issue #232).
//
// CU_EXECUTOR=<file> runs the harness against another copy of the executor
// (used to show it fails on the code before the fix).
// Exit codes follow the repo convention: 0 = PASS, other = FAIL.
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EXECUTOR = process.env.CU_EXECUTOR || path.join(ROOT, "js", "cu_linux_executor.js");
const SRC = readFileSync(EXECUTOR, "utf8");

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log("  PASS " + label); return; }
  fail++; console.log("  FAIL " + label + (extra ? "  -> " + extra : ""));
}

let clockOffset = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + clockOffset;

const mon = (name, x, y, w, h, primary = false) => ({ name, id: name, geometry: { x, y, width: w, height: h }, is_primary: primary });
const DISPLAYS = [{ id: 1, label: "one", bounds: { x: 0, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, nativeOrigin: { x: 0, y: 0 } }];

// state.screens: what `screens` answers (or an Error to throw); state.zoom(args):
// null = success, else the error message the bridge prints.
function makeRig(kind, state) {
  const calls = [], sync = [], diag = [];
  const bridgeName = { wlroots: "wlroots-bridge", gnome: "gnome-portal-bridge", x11: "x11-bridge" }[kind];
  const reply = (args) => {
    const sub = args[0];
    if (sub === "screens") { if (state.screens instanceof Error) throw state.screens; return JSON.stringify(state.screens); }
    if (sub === "zoom") {
      const m = state.zoom(args);
      if (m) { const e = new Error("Command failed: /res/" + bridgeName + " " + args.join(" ") + "\n" + m + "\n"); e.code = 1; throw e; }
      return JSON.stringify({ base64: "AA", width: 100, height: 50 });
    }
    return "{}";
  };
  const cp = {
    execFileSync(bin, args) { sync.push(path.basename(String(bin)) + " " + (args || []).join(" ")); throw new Error("not found"); },
    execSync(c) { sync.push(String(c)); throw new Error("nope"); },
    spawnSync(b) { sync.push(String(b)); return { status: 1 }; },
    execFile(bin, args, opts, cb) {
      if (path.basename(String(bin)) !== bridgeName) { setTimeout(() => cb(new Error("not found"), "", ""), 0); return; }
      calls.push(args.join(" "));
      setTimeout(() => { let out; try { out = reply(args); } catch (e) { cb(e, "", String(e.message)); return; } cb(null, out, ""); }, 0);
    },
    spawn() { return { on() {}, unref() {} }; }
  };
  const screenListeners = {};
  const electron = {
    app: { commandLine: { getSwitchValue: () => "" } },
    screen: { on(n, f) { (screenListeners[n] = screenListeners[n] || []).push(f); }, getAllDisplays: () => DISPLAYS, getPrimaryDisplay: () => DISPLAYS[0], getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    desktopCapturer: { getSources: async () => [] },
    clipboard: { readText: () => "", writeText: () => {} },
    nativeImage: {}
  };
  const fsStub = {
    readFileSync: () => Buffer.alloc(0), writeFileSync() {}, unlinkSync() {}, renameSync() {},
    existsSync: (p) => String(p).endsWith("/gnome-portal-bridge/session.sock"),
    accessSync() { throw new Error("no"); }, readdirSync: () => [], statSync: () => ({ isDirectory: () => false })
  };
  const requireStub = (id) => ({ child_process: cp, electron, path, os, fs: fsStub })[id] || (() => { throw new Error("unexpected require " + id); })();
  globalThis.__cdbDiag = (m) => { diag.push(String(m)); if (process.env.CU_TEST_DEBUG) console.log("    DIAG " + m); };
  delete globalThis.__cuX11BridgeBin; delete globalThis.__cuWlrootsBridgeBin; delete globalThis.__cuGnomeBridgeBin;
  globalThis.__cuKwinMode = false;
  for (const k of ["SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE", "NIRI_SOCKET", "COWORK_SCREENSHOT_CMD", "X11_BRIDGE_BIN", "WLROOTS_BRIDGE_BIN", "GNOME_PORTAL_BRIDGE_BIN", "YDOTOOL_SOCKET", "WAYLAND_DISPLAY"]) delete process.env[k];
  process.env.XDG_RUNTIME_DIR = "/run/user/1000";
  if (kind === "wlroots") { Object.assign(process.env, { XDG_CURRENT_DESKTOP: "sway", XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-1", SWAYSOCK: "/run/sway.sock" }); globalThis.__cuWlrootsBridgeBin = "/res/wlroots-bridge"; }
  else if (kind === "gnome") { Object.assign(process.env, { XDG_CURRENT_DESKTOP: "ubuntu:GNOME", XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" }); globalThis.__cuGnomeBridgeBin = "/res/gnome-portal-bridge"; }
  else { Object.assign(process.env, { XDG_CURRENT_DESKTOP: "XFCE", XDG_SESSION_TYPE: "x11" }); globalThis.__cuX11BridgeBin = "/res/x11-bridge"; }
  new Function("require", "process", SRC)(requireStub, process);
  const ex = globalThis.__linuxExecutor;
  diag.length = 0; sync.length = 0;
  const reset = () => { calls.length = 0; diag.length = 0; };
  const emit = (n) => (screenListeners[n] || []).forEach((f) => f({}, {}));
  return { ex, calls, sync, diag, reset, emit, screenListeners };
}

const NF = (name) => "Error: display `" + name + "` not found";
const zooms = (r) => r.calls.filter((c) => c.startsWith("zoom"));
const screensCalls = (r) => r.calls.filter((c) => c === "screens").length;
const displayOf = (z) => { const m = / --display (\S+)/.exec(z); return m ? m[1] : null; };
const retryLines = (r) => r.diag.filter((d) => /not found - monitor list refreshed, retrying once/.test(d)).length;
async function settle(p) { try { return { v: await p }; } catch (e) { return { e }; } }

for (const kind of ["x11", "wlroots", "gnome"]) {
  for (const via of ["screenshot", "zoom"]) {
    console.log(`\n[${kind} via ${via}] hotplug: DP-1 replaced by HDMI-A-1`);
    const state = { screens: [mon("DP-1", 0, 0, 1920, 1080, true)], zoom: () => null };
    const r = makeRig(kind, state);
    if (kind === "gnome") await r.ex.__setLockHeld(true);
    const shoot = () => via === "screenshot" ? r.ex.screenshot({ displayId: 0 }) : r.ex.zoom({ x: 100, y: 100, w: 400, h: 300 }, 1, 0);
    r.reset();
    let s = await settle(shoot());
    check(!s.e && displayOf(zooms(r)[0] || "") === "DP-1", "first capture primes the cache with DP-1", s.e && s.e.message);
    // Hotplug: the old output is gone, a new one took its place.
    state.screens = [mon("HDMI-A-1", 0, 0, 1920, 1080, true)];
    state.zoom = (args) => displayOf(args.join(" ")) === "DP-1" ? NF("DP-1") : null;
    r.reset();
    s = await settle(shoot());
    const z = zooms(r);
    check(!s.e && s.v && s.v.base64 === "AA" && s.v.mimeType === "image/jpeg", "capture after hotplug succeeds through the bridge", s.e ? s.e.message : JSON.stringify(s.v));
    check(z.length === 2, "exactly one zoom retry", JSON.stringify(z));
    check(displayOf(z[0] || "") === "DP-1" && displayOf(z[1] || "") === "HDMI-A-1", "retry names the re-enumerated monitor", JSON.stringify(z));
    check(screensCalls(r) === 1, "one screens re-query", String(screensCalls(r)));
    check(retryLines(r) === 1, "one diag line for the invalidation", JSON.stringify(r.diag));
    r.reset();
    s = await settle(shoot());
    check(!s.e && zooms(r).length === 1 && displayOf(zooms(r)[0]) === "HDMI-A-1" && screensCalls(r) === 0, "next capture uses the refreshed cache, no re-query", JSON.stringify(r.calls));
    check(r.sync.length === 0, "no synchronous spawn on the capture path", JSON.stringify(r.sync));
  }

  console.log(`\n[${kind}] the bridge keeps answering not-found: no loop`);
  {
    const state = { screens: [mon("DP-1", 0, 0, 1920, 1080, true)], zoom: () => NF("DP-1") };
    const r = makeRig(kind, state);
    if (kind === "gnome") await r.ex.__setLockHeld(true);
    r.reset();
    const s = await settle(r.ex.screenshot({ displayId: 0 }));
    check(zooms(r).length === 2, "zoom tried twice, not more", JSON.stringify(zooms(r)));
    check(screensCalls(r) === 2, "screens: the first query plus one re-query", String(screensCalls(r)));
    check(r.diag.some((d) => /zoom failed: [\s\S]*display `DP-1` not found/.test(d)), "second not-found surfaces in the zoom-failed log line", JSON.stringify(r.diag));
    check(s.e && /Screenshot failed/.test(s.e.message), "capture fails after the normal cascade", s.e ? s.e.message : "resolved");
    check(r.sync.length === 0, "no synchronous spawn", JSON.stringify(r.sync));
  }

  console.log(`\n[${kind}] any other zoom error is not retried`);
  {
    const state = { screens: [mon("DP-1", 0, 0, 1920, 1080, true)], zoom: () => "Error: screencopy did not complete" };
    const r = makeRig(kind, state);
    if (kind === "gnome") await r.ex.__setLockHeld(true);
    r.reset();
    await settle(r.ex.screenshot({ displayId: 0 }));
    check(zooms(r).length === 1 && screensCalls(r) === 1 && retryLines(r) === 0, "one zoom, no invalidation", JSON.stringify(r.calls));
  }
}

console.log("\n[x11] a failed screens is not cached as []");
{
  clockOffset = 0;
  const state = { screens: new Error("Command failed: x11-bridge screens\nError: RandR timeout\n"), zoom: () => null };
  const r = makeRig("x11", state);
  r.reset();
  let s = await settle(r.ex.screenshot({ displayId: 0 }));
  check(!s.e && screensCalls(r) === 1 && displayOf(zooms(r)[0] || "") === null, "failed screens -> zoom without --display", JSON.stringify(r.calls));
  state.screens = [mon("DP-1", 0, 0, 1920, 1080, true)];
  r.reset();
  s = await settle(r.ex.screenshot({ displayId: 0 }));
  check(!s.e && screensCalls(r) === 0, "inside the retry window: no re-query (backoff)", JSON.stringify(r.calls));
  clockOffset = 31000;
  r.reset();
  s = await settle(r.ex.screenshot({ displayId: 0 }));
  check(!s.e && screensCalls(r) === 1 && displayOf(zooms(r)[0] || "") === "DP-1", "after the window: re-queried, --display DP-1", JSON.stringify(r.calls));
  r.reset();
  s = await settle(r.ex.screenshot({ displayId: 0 }));
  check(!s.e && screensCalls(r) === 0, "the good list is then cached", JSON.stringify(r.calls));
  check(r.sync.length === 0, "no synchronous spawn", JSON.stringify(r.sync));
  clockOffset = 0;
}

console.log("\n[x11] layout change through Electron screen events");
for (const evn of ["display-added", "display-removed", "display-metrics-changed"]) {
  const state = { screens: [mon("DP-1", 0, 0, 1920, 1080, true)], zoom: () => null };
  const r = makeRig("x11", state);
  r.reset();
  let s = await settle(r.ex.screenshot({ displayId: 0 }));
  check(!s.e && displayOf(zooms(r)[0] || "") === "DP-1", `${evn}: primed with DP-1`, s.e && s.e.message);
  check(["display-added", "display-removed", "display-metrics-changed"].every((n) => (r.screenListeners[n] || []).length === 1), "listeners armed once for all three events", JSON.stringify(Object.keys(r.screenListeners)));
  r.reset();
  s = await settle(r.ex.screenshot({ displayId: 0 }));
  check(screensCalls(r) === 0, "no event: the cache is used, no bridge call per capture", JSON.stringify(r.calls));
  state.screens = [mon("HDMI-A-1", 0, 0, 1920, 1080, true)];
  r.emit(evn);
  r.reset();
  s = await settle(r.ex.screenshot({ displayId: 0 }));
  check(!s.e && screensCalls(r) === 1 && zooms(r).length === 1 && displayOf(zooms(r)[0]) === "HDMI-A-1", `${evn}: next capture re-enumerates once and names the new monitor, no failed zoom first`, JSON.stringify(r.calls));
  r.reset();
  await settle(r.ex.screenshot({ displayId: 0 }));
  check(screensCalls(r) === 0, "and caches the fresh list again", JSON.stringify(r.calls));
}

console.log("\n[x11] a region on no cached monitor refreshes the list once (Wayland sibling parity)");
{
  const state = { screens: [mon("DP-1", 0, 0, 1920, 1080, true)], zoom: () => null };
  const r = makeRig("x11", state);
  r.reset();
  await settle(r.ex.screenshot({ displayId: 0 }));
  // The layout grew without an event reaching us: DP-1 now sits right of a new monitor.
  state.screens = [mon("DP-1", 0, 0, 1920, 1080, true), mon("DP-2", 1920, 0, 1920, 1080)];
  r.reset();
  const e = await settle(r.ex.zoom({ x: 2100, y: 100, w: 200, h: 100 }, 1, 0));
  const z = zooms(r);
  const miss = r.diag.some((d) => /on no known monitor - monitor list refreshed/.test(d));
  check(!e.e && miss && screensCalls(r) === 1, "a miss on the cached list re-enumerates once", JSON.stringify({ diag: r.diag, calls: r.calls }));
  check(z.length === 1 && displayOf(z[0]) === "DP-2", "zoom names the monitor that now holds the region", JSON.stringify(z));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
