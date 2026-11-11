#!/usr/bin/env node
// Computer Use overlay display on Linux (sub-patches 10b1-10b5 / 10c of
// fix_computer_use_linux.nim, helpers in js/cu_linux_executor.js).
//
// WHY THIS EXISTS
// ---------------
// Upstream's overlay display resolver (4.23118.1, main chunk):
//   function xui(e){return e===null?u.screen.getPrimaryDisplay():
//     u.screen.getAllDisplays().find((t=>t.id===e))??u.screen.getPrimaryDisplay()}
// feeds the glow ("Claude is using your computer", Uvo), the teach overlay
// (kyo) and the screenshot target label (Nui). It takes Electron display ids:
// the session's selected display, else the display the MAIN WINDOW is on
// (`screen.getDisplayMatching(win.getBounds()).id`). The Linux executor's ids
// are list indexes, so the old 10b forced every Linux lookup to Electron's
// primary: on an X11 host with three monitors and no RandR primary the glow
// framed the notebook panel (Electron's primary, 7040,0) while Claude worked on
// the ultrawide (our index 2, 0,0). The resolver cannot tell an index from an
// Electron id: on EDID-less X11 outputs (VMs, Xvfb, XWayland, dummy plugs)
// Chromium's ids are small integers from the RandR output index, so index 1
// can be another monitor's Electron id. 10b1-10b5 therefore translate the
// SELECTED id where it enters the overlay code (glow switch, glow at lock,
// teach start, teach switch, target label) through
// globalThis.__cdbCuElectronDisplayId; the resolver and its main-window
// fallback stay byte-unchanged. 10c keeps the glow off on a background display.
//
// This harness pins:
//   [1] the REAL executor helpers on every session row whose monitor list
//       comes from Electron (X11 incl. HiDPI, XWayland, wlroots, GNOME), the
//       misaligned small-id layout (ids {1,4}, indexes {0,1}), the EDID-less
//       ids == indexes layout, the background display, the glow-off flag;
//       [1b] the glow stays off on X11 without a compositing manager (x11-bridge
//       doctor capabilities.compositing false / unknown, issue #327), picks up
//       a compositor switched on or off at run time, one line per change.
//   [2] the pristine anchors (setters, resolver, five entry sites), the
//       compiled patch applies with the full counter, is idempotent, leaves the
//       resolver byte-unchanged, the changed chunk passes node --check.
//   [3] Rule 6: a bundle missing any one of 10b1-10b5 / 10c is refused as
//       half-patched; a moved anchor fails the build.
//   [4] the REAL upstream functions (glow setter + lock handler + switch,
//       teach controller, target label, resolver) from the patched bundle in
//       vm, against the executor helper, for the host layout and the
//       misaligned layout, selected-id AND main-window-fallback paths; the same
//       flows on the pristine bundle and with the old force-primary 10b show
//       the bug. The glow show (10c) on X11, background display, Wayland.
//   [3b] 10d: upstream's drawn-pointer factory exposed as
//       globalThis.__cdbCuDrawnPointer (one assignment, in the factory's own
//       chunk), the flag decision byte-unchanged, Rule 6 (half-patched, the
//       old "drawn cursor off" output refused, moved shapes fail loud).
//   [5] the REAL drawn-pointer module of the patched chunk in vm, fed by the
//       REAL executor on a stub x11-bridge: flag on (the glow shows the
//       arrow) -> upstream's mixin order per action (move, click after
//       showPointerTravel, mouseDown, held move, mouseUp, drag with and
//       without a start, scroll), the press ring on the real pointer, HiDPI
//       on a second monitor; flag off -> nothing animated, the bridge
//       commands of an executor without a drawn pointer; abort cuts the
//       glide; a throwing drawn pointer never breaks input; no call at all on
//       Wayland rows, kwin mode and a background display. Claude's own
//       Escape under upstream's X11 grab resumes it exactly once when the
//       bridge throws (the error propagates); a lock change clears the
//       drawn pointer's held state.
// Sections [2]-[5] SKIP (exit 3) when the binary or the extract is missing.
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, rmSync, accessSync, constants } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..", "..");
const EXECUTOR = process.env.CU_EXECUTOR || path.join(repo, "js", "cu_linux_executor.js");
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
const countRe = (hay, re) => (hay.match(new RegExp(re.source, "g")) || []).length;
const esc = (x) => x.replace(/[$]/g, "\\$");

// ── Electron display fixtures ────────────────────────────────────────────
const R = (x, y, width, height) => ({ x, y, width, height });
const disp = (id, label, b, sf = 1, no) => ({ id, label, bounds: b, size: { width: b.width, height: b.height }, workArea: b, scaleFactor: sf, ...(no ? { nativeOrigin: no } : {}) });
// The maintainer's X11/XFCE host: no RandR primary, Electron's primary is the
// notebook panel; getAllDisplays() order puts the ultrawide at index 2.
// Ids are EDID-derived (large), as Chromium builds them on X11 with EDID.
const HOST = [
  disp(21420523520, "DP-2", R(5120, 0, 1920, 1080)),
  disp(21474836481, "eDP-1", R(7040, 0, 1920, 1200)),
  disp(26616532992, "C49RG9x", R(0, 0, 5120, 1440)),
];
HOST.primaryIdx = 1;
// EDID-less X11 (Chromium: display id = the RandR output loop index, which
// counts disconnected outputs): DVI-D-0 disconnected (i=0), HDMI-0 (i=1),
// DP-2 (i=4). Electron ids {1,4}, our indexes {0,1}.
const MISALIGNED = [disp(1, "HDMI-0", R(0, 0, 1920, 1080)), disp(4, "DP-2", R(1920, 0, 2560, 1440))];
MISALIGNED.primaryIdx = 0;
// EDID-less with no disconnected output before them: ids == indexes.
const ALIGNED = [disp(0, "Virtual-1", R(0, 0, 1280, 800)), disp(1, "Virtual-2", R(1280, 0, 1024, 768))];
ALIGNED.primaryIdx = 0;

function makeScreen(displays) {
  const s = {
    displays,
    getAllDisplays: () => s.displays,
    getPrimaryDisplay: () => s.displays[s.displays.primaryIdx || 0],
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayMatching: (r) => s.displays.find((d) => r.x >= d.bounds.x && r.x < d.bounds.x + d.bounds.width) || s.displays[s.displays.primaryIdx || 0],
    getDisplayNearestPoint: () => s.displays[s.displays.primaryIdx || 0],
  };
  return s;
}

// Loads the REAL executor with stubs; returns the screen object it reads.
// x11-bridge doctor (src/doctor.rs); `doctor` = the object, a function of the
// call count, or an Error. Default: a compositing manager runs.
const X11_DOCTOR = (cm, extra = {}) => ({ contract: 1, bridge: "x11-bridge", version: "0.1.0", backend: "x11", session_match: true, backend_reachable: true, capabilities: { screenshot_mask: true, screenshot_mask_ignore: true, compositing: cm, ...extra } });
const diagLines = [];
let doctorCalls = 0;
// Fake BrowserWindows (only what the glow guard uses) and the app's
// browser-window-created listeners, so a "show" can be fired like Electron's.
const fakeWins = [];
const appListeners = {};
function fakeGlow({ url = "file:///tmp/cu-glow.html", visible = false, loading = false } = {}) {
  const ev = {};
  const w = {
    destroyed: false, visible, loading, url,
    isDestroyed: () => w.destroyed, isVisible: () => w.visible, destroy() { w.destroyed = true; w.visible = false; },
    on(n, f) { (ev[n] = ev[n] || []).push(f); },
    emit(n) { (ev[n] || []).forEach((f) => f()); },
    webContents: { isDestroyed: () => w.destroyed, getURL: () => w.url, isLoading: () => w.loading,
      // The capture hide / restore scripts (section [6]); jsResult: the page's answer.
      executeJavaScript: (js) => { (w.js ||= []).push(js); capLog.push(/classList\.remove/.test(js) ? "js show" : "js hide"); return w.jsAnswer ? w.jsAnswer(js) : Promise.resolve(w.jsResult !== undefined ? w.jsResult : true); } },
  };
  fakeWins.push(w);
  (appListeners["browser-window-created"] || []).forEach((f) => f({}, w));
  return w;
}
// `bridge(args)`: the stub x11-bridge's synchronous answer (input commands);
// without it every synchronous tool call fails as "not found".
const capLog = [];
function loadExecutor({ displays, session = "x11", desktop = "XFCE", target = null, doctor = X11_DOCTOR(true), bridge = null, asyncBridge = null }) {
  fakeWins.length = 0;
  for (const k of Object.keys(appListeners)) delete appListeners[k];
  const screen = makeScreen(displays);
  doctorCalls = 0;
  const cp = {
    execFileSync(bin, args) {
      if (bridge && path.basename(String(bin)) === "x11-bridge") return bridge(args);
      throw new Error("not found");
    },
    execSync() { throw new Error("nope"); },
    spawnSync() { return { status: 1 }; },
    execFile(bin, args, opts, cb) {
      const c = typeof opts === "function" ? opts : cb;
      if (path.basename(String(bin)) === "x11-bridge" && args && args[0] === "doctor") {
        const d = typeof doctor === "function" ? doctor(++doctorCalls) : (++doctorCalls, doctor);
        setTimeout(() => (d instanceof Error ? c(d, "", String(d.message)) : c(null, JSON.stringify(d), "")), 0);
        return { on() {} };
      }
      if (asyncBridge && args && args[0] !== "screens") { const r = asyncBridge(args); setTimeout(() => c && (r instanceof Error ? c(r, "", String(r.message)) : c(null, r, "")), r && r.delayMs || 0); return { on() {} }; }
      setTimeout(() => c && c(new Error("not found"), "", ""), 0); return { on() {} };
    },
    spawn() { return { on() {}, unref() {}, stdout: { on() {} }, stderr: { on() {} } }; },
  };
  const electron = {
    app: { commandLine: { getSwitchValue: () => "" }, getPath: () => os.tmpdir(), on(n, f) { (appListeners[n] = appListeners[n] || []).push(f); } },
    BrowserWindow: { getAllWindows: () => fakeWins.filter((w) => !w.destroyed) },
    screen,
    desktopCapturer: { getSources: async () => [] },
    clipboard: { readText: () => "", writeText: () => {} },
    nativeImage: {},
  };
  const requireStub = (id) => {
    if (id === "child_process") return cp;
    if (id === "electron") return electron;
    if (id === "path") return path;
    if (id === "os") return os;
    if (id === "fs") return { readFileSync: () => Buffer.alloc(0), writeFileSync() {}, unlinkSync() {}, existsSync: () => false, renameSync() {}, accessSync() { throw new Error("no"); }, readdirSync: () => [], statSync: () => ({ isDirectory: () => false }), constants: { X_OK: 1 } };
    throw new Error("unexpected require " + id);
  };
  diagLines.length = 0;
  globalThis.__cdbDiag = (m) => diagLines.push(String(m));
  globalThis.__cuX11BridgeBin = "/res/x11-bridge";
  delete globalThis.__cuGnomeBridgeBin; delete globalThis.__cuWlrootsBridgeBin;
  globalThis.__cuKwinMode = false;
  if (target) globalThis.__cuTargetRead = () => target; else delete globalThis.__cuTargetRead;
  process.env.XDG_CURRENT_DESKTOP = desktop;
  process.env.XDG_SESSION_TYPE = session;
  if (session === "wayland") process.env.WAYLAND_DISPLAY = "wayland-0"; else delete process.env.WAYLAND_DISPLAY;
  for (const k of ["SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE", "NIRI_SOCKET", "COWORK_SCREENSHOT_CMD", "X11_BRIDGE_BIN", "YDOTOOL_SOCKET", "WLROOTS_BRIDGE_BIN"]) delete process.env[k];
  delete globalThis.__cdbCuElectronDisplayId; delete globalThis.__cdbCuGlowOff; delete globalThis.__linuxExecutor;
  new Function("require", "process", readFileSync(EXECUTOR, "utf8"))(requireStub, process);
  return screen;
}
const T = (v) => globalThis.__cdbCuElectronDisplayId?.(v);
const tick = () => new Promise((r) => setTimeout(r, 5));

console.log("\n[1] the executor helpers on each session row (monitor list from Electron)");
const rows = [
  { name: "X11 / XFCE", session: "x11", desktop: "XFCE" },
  { name: "XWayland / sway", session: "wayland", desktop: "sway" },
  { name: "wlroots / Hyprland", session: "wayland", desktop: "Hyprland" },
  { name: "GNOME Wayland", session: "wayland", desktop: "GNOME" },
  { name: "KDE X11", session: "x11", desktop: "KDE" },
];
for (const row of rows) {
  loadExecutor({ displays: HOST, session: row.session, desktop: row.desktop });
  check(`${row.name}: helper defined`, typeof globalThis.__cdbCuElectronDisplayId, "function");
  check(`${row.name}: index 2 -> the ultrawide's Electron id`, T(2), 26616532992);
  check(`${row.name}: index 1 -> eDP-1's Electron id`, T(1), 21474836481);
  check(`${row.name}: index 0 -> DP-2's Electron id`, T(0), 21420523520);
  check(`${row.name}: undefined stays undefined (upstream's fallback fires)`, T(undefined), undefined);
  check(`${row.name}: null stays null`, T(null), null);
  check(`${row.name}: unknown index 7 unchanged`, T(7), 7);
  check(`${row.name}: -1 / 1.5 / "2" unchanged`, JSON.stringify([T(-1), T(1.5), T("2")]), JSON.stringify([-1, 1.5, "2"]));
  await tick(); // the doctor warmed at executor load answers
  check(`${row.name}: glow on (desktop session, compositing manager running)`, globalThis.__cdbCuGlowOff?.(), false);
}
{
  loadExecutor({ displays: MISALIGNED });
  check("misaligned EDID-less ids {1,4}: index 1 -> DP-2 (Electron id 4)", T(1), 4);
  check("misaligned EDID-less ids {1,4}: index 0 -> HDMI-0 (Electron id 1)", T(0), 1);
  check("misaligned: index 4 (not ours) unchanged", T(4), 4);
  loadExecutor({ displays: ALIGNED });
  check("EDID-less ids == indexes: index 1 -> 1", T(1), 1);
  check("EDID-less ids == indexes: index 0 -> 0", T(0), 0);
  // X11 HiDPI: Chromium's DIP layout (2560x1440 px at 1.5 -> 1707x960 DIP).
  const hidpi = [disp(11, "HDMI-1", R(0, 0, 1707, 960), 1.5, { x: 0, y: 0 }), disp(12, "DP-1", R(1707, 0, 1920, 1080), 1, { x: 2560, y: 0 })];
  loadExecutor({ displays: hidpi });
  check("X11 HiDPI 1.5: index 1 -> DP-1 (DIP bounds)", T(1), 12);
  check("X11 HiDPI 1.5: index 0 -> HDMI-1", T(0), 11);
  const screen = loadExecutor({ displays: HOST });
  const reordered = [HOST[2], HOST[0], HOST[1]]; reordered.primaryIdx = 2;
  screen.displays = reordered;
  check("list reordered: index 0 is the ultrawide now (index = current Electron order)", T(0), 26616532992);
  screen.displays = [];
  check("no Electron displays: unchanged", T(0), 0);
  screen.getAllDisplays = () => { throw new Error("boom"); };
  check("getAllDisplays throws: unchanged", T(1), 1);
}
{
  loadExecutor({ displays: HOST, target: { kind: "x11", display: ":99", env: {} } });
  check("background display: index unchanged (names the target's monitor)", T(2), 2);
  check("background display: glow off", globalThis.__cdbCuGlowOff?.(), true);
  // Switched on after the latch (reader says on, _tgt still null): still off.
  loadExecutor({ displays: HOST });
  globalThis.__cuTargetRead = () => ({ kind: "x11", display: ":99", env: {} });
  check("background display switched on mid-run, before the re-latch: glow off", globalThis.__cdbCuGlowOff?.(), true);
  globalThis.__cuTargetRead = () => { throw new Error("unreadable"); };
  check("setting unreadable: glow off (fail closed, as the latch refuses)", globalThis.__cdbCuGlowOff?.(), true);
  globalThis.__cuTargetRead = () => null;
  await tick();
  check("setting off: glow on", globalThis.__cdbCuGlowOff?.(), false);
  delete globalThis.__cuTargetRead;
}

console.log("\n[1b] glow off on X11 without a compositing manager (issue #327)");
{
  const offLines = () => diagLines.filter((m) => /glow off:/.test(m));
  loadExecutor({ displays: HOST, doctor: X11_DOCTOR(false) });
  await tick();
  check("no compositing manager: glow off", globalThis.__cdbCuGlowOff?.(), true);
  globalThis.__cdbCuGlowOff?.(); globalThis.__cdbCuGlowOff?.();
  check("one diag line, not one per lock", offLines().length, 1);
  check("the line names the reason", /no compositing manager runs on this X11 display/.test(offLines()[0] || ""), true);
  loadExecutor({ displays: HOST, doctor: X11_DOCTOR(null, { compositing_error: "no X connection" }) });
  await tick();
  check("compositing null (unknown): glow off", globalThis.__cdbCuGlowOff?.(), true);
  check("unknown: the line carries the bridge's reason", /did not say whether a compositing manager runs \(no X connection\)/.test(offLines()[0] || ""), true);
  const old = X11_DOCTOR(true); delete old.capabilities.compositing;
  loadExecutor({ displays: HOST, doctor: old });
  await tick();
  check("bridge without the doctor key: glow off", globalThis.__cdbCuGlowOff?.(), true);
  loadExecutor({ displays: HOST, doctor: new Error("Command failed: doctor timed out") });
  await tick();
  check("doctor failed: glow off", globalThis.__cdbCuGlowOff?.(), true);
  loadExecutor({ displays: HOST, doctor: X11_DOCTOR(true) });
  check("no doctor answer yet (sync read at load): glow off", globalThis.__cdbCuGlowOff?.(), true);
  check("the sync read spawned no second doctor while one runs", doctorCalls, 1);
  await tick();
  check("after the answer: glow on", globalThis.__cdbCuGlowOff?.(), false);
  check("glow back on: one 'glow on' line", diagLines.filter((m) => /glow on: a compositing manager runs/.test(m)).length, 1);
  // Compositor stopped between tasks: the decision is synchronous, so the
  // cached "compositor" answer still lets upstream create the glow, but the
  // decision itself starts a fresh doctor (even inside the 60 s TTL) and its
  // "no compositor" answer closes the glow window before or right after the
  // show - never a task in black.
  loadExecutor({ displays: HOST, doctor: (n) => X11_DOCTOR(n === 1) });
  await tick();
  check("stopped between tasks: load answer (compositing) -> glow on", globalThis.__cdbCuGlowOff?.(), false);
  await tick(); // the refresh that decision started answers: compositor gone
  check("stopped between tasks: every decision asks a fresh doctor (inside the TTL)", doctorCalls, 2);
  check("stopped between tasks: next decision -> glow off", globalThis.__cdbCuGlowOff?.(), true);
  {
    // Upstream created the glow on the stale answer (loading, then shown).
    loadExecutor({ displays: HOST, doctor: (n) => X11_DOCTOR(n === 1) });
    await tick();
    check("stale: decision says glow on", globalThis.__cdbCuGlowOff?.(), false);
    const g = fakeGlow({ loading: true });
    await tick(); // fresh answer: no compositor; the window is still loading
    check("stale: a glow window still loading is not destroyed by the answer (upstream's creation completes)", g.destroyed, false);
    g.loading = false; g.visible = true; g.emit("show");
    check("stale: shown while 'no compositor' is known -> not destroyed synchronously (upstream's show function completes)", g.destroyed, false);
    await tick();
    check("stale: destroyed one tick after the show", g.destroyed, true);
    check("stale: one line says why", diagLines.filter((m) => /glow window closed: no compositing manager is known to run/.test(m)).length, 1);
    // Same, but the window was already shown when the answer arrived.
    loadExecutor({ displays: HOST, doctor: (n) => X11_DOCTOR(n === 1) });
    await tick();
    globalThis.__cdbCuGlowOff?.();
    const g2 = fakeGlow({ visible: true }); g2.emit("show"); // cached answer still "compositor": kept
    await tick();
    check("stale: an already shown glow is destroyed when the answer says no compositor", g2.destroyed, true);
    // A hidden, loaded glow (created in an earlier task under a compositor)
    // is destroyed too, so it is never reused without one.
    const g3 = fakeGlow({ visible: false });
    globalThis.__cdbCuGlowOff?.();
    await tick();
    check("hidden loaded glow: destroyed on a 'no compositor' answer", g3.destroyed, true);
    // Unrelated windows are never touched.
    const other = fakeGlow({ url: "file:///tmp/cu-teach-1.html", visible: true });
    const main = fakeGlow({ url: "https://claude.ai/new", visible: true });
    globalThis.__cdbCuGlowOff?.();
    await tick();
    check("teach overlay and main window are never destroyed", other.destroyed || main.destroyed, false);
  }
  {
    // Compositor running throughout: the glow window is kept and reused.
    loadExecutor({ displays: HOST, doctor: X11_DOCTOR(true) });
    await tick();
    check("compositor: glow on", globalThis.__cdbCuGlowOff?.(), false);
    const g = fakeGlow({ visible: true }); g.emit("show");
    await tick(); globalThis.__cdbCuGlowOff?.(); await tick();
    check("compositor: the glow window is kept (upstream reuses it)", g.destroyed, false);
    // A doctor that fails while the glow is up: unknown -> closed.
    loadExecutor({ displays: HOST, doctor: (n) => (n === 1 ? X11_DOCTOR(true) : new Error("doctor timed out")) });
    await tick();
    globalThis.__cdbCuGlowOff?.();
    const gf = fakeGlow({ visible: true });
    await tick();
    check("doctor fails while the glow is up: glow window closed", gf.destroyed, true);
  }
  // Never on Wayland (upstream shows no glow there), never asks for it.
  loadExecutor({ displays: HOST, session: "wayland", desktop: "sway", doctor: X11_DOCTOR(false) });
  await tick();
  check("Wayland: the compositor rule does not apply", globalThis.__cdbCuGlowOff?.(), false);
  // Background display still wins (no host doctor needed).
  loadExecutor({ displays: HOST, target: { kind: "x11", display: ":99", env: {} }, doctor: X11_DOCTOR(true) });
  await tick();
  check("background display + compositor: glow off", globalThis.__cdbCuGlowOff?.(), true);
  // No x11-bridge at all on X11: off.
  loadExecutor({ displays: HOST });
  delete globalThis.__cuX11BridgeBin;
  check("X11 without x11-bridge: glow off", globalThis.__cdbCuGlowOff?.(), true);
  globalThis.__cuX11BridgeBin = "/res/x11-bridge";
}
{
  const src = readFileSync(EXECUTOR, "utf8");
  check("helper defined once, from its defining line", src.split("globalThis.__cdbCuElectronDisplayId=function(v){").length - 1, 1);
  check("glow-off helper defined once", src.split("globalThis.__cdbCuGlowOff=function(){").length - 1, 1);
  const kwin = readFileSync(path.join(repo, "js", "executor_linux.js"), "utf8");
  check("KWin executor defines no helper (its ids are Electron ids)", /__cdbCuElectronDisplayId\s*=/.test(kwin), false);
}

// ── Bundle sections ──────────────────────────────────────────────────────
const DID = '/*__cdbCuDid*/((v)=>{try{let f=globalThis.__cdbCuElectronDisplayId;return process.platform==="linux"&&typeof f=="function"?f(v):v}catch{return v}})(';
const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const D = reEsc(DID);
const RESOLVER_RE = /function ([\w$]+)\(([\w$]+)\)\{return \2===null\?([\w$]+)\.screen\.getPrimaryDisplay\(\):\3\.screen\.getAllDisplays\(\)\.find\(\(?([\w$]+)\)?=>\4\.id===\2\)?\)\?\?\3\.screen\.getPrimaryDisplay\(\)\}/;
// v5.1231.0 wraps the setBounds with a drawn-cursor redraw:
// `(j.setBounds(U().bounds),R())`; both shapes are the same setter.
// 10g (test-cu-wl-glow.mjs) adds the Wayland overlay's display hook after the assignment.
const GLOW_SET_RE = /function ([\w$]+)\(([\w$]+)\)\{([\w$]+)=\2\?\?null,(?:process\.platform==="linux"&&globalThis\.__cdbCuWlGlow\?\.display\?\.\([\w$]+\),)?([\w$]+)&&!\4\.isDestroyed\(\)&&(?:\4\.setBounds\(([\w$]+)\(\)\.bounds\)|\(\4\.setBounds\(([\w$]+)\(\)\.bounds\),[\w$]+\(\)\))\}/;
const TEACH_SET_RE = /function ([\w$]+)\(([\w$]+)\)\{([\w$]+)=\2\?\?null;let ([\w$]+)=([\w$]+)\(\);\4&&\4\.setBounds\(([\w$]+)\(\)\.workArea\)\}/;
const GLOW_RE = /function ([\w$]+)\(([\w$]+)\)\{if\(!([\w$]+)\)return Promise\.resolve\(\);([\w$]+)&&=\(clearTimeout\(\4\),null\);let [\w$]+=\+\+[\w$]+;([\w$]+)\(!0\);/;
// 10e (test-cu-wl-glow.mjs) puts the Wayland overlay's takeover in front.
const GLOW_PATCHED_RE = /function ([\w$]+)\(([\w$]+)\)\{(?:if\(process\.platform==="linux"&&globalThis\.__cdbCuWlGlow\?\.show\?\.\(\2,[\w$]+,[\w$]+\)===!0\)return Promise\.resolve\(\);)?if\(!([\w$]+)\|\|process\.platform==="linux"&&globalThis\.__cdbCuGlowOff\?\.\(\)===!0\)return Promise\.resolve\(\);([\w$]+)&&=\(clearTimeout\(\4\),null\);let [\w$]+=\+\+[\w$]+;([\w$]+)\(!0\);/;
// Sub-patch 10d: upstream's drawn-pointer factory, and our assignment in
// front of it (captures: factory, wrapper).
const DP_FACTORY_RE = /(?<![\w$.])function ([\w$]+)\(([\w$]+)\)\{return\{glideTo:([\w$]+)\(0,\(\(([\w$]+),([\w$]+)\)=>\{let [\w$]+=\2\(\5\);/;
const DP_PATCHED_RE = /process\.platform==="linux"&&\(globalThis\.__cdbCuDrawnPointer=Object\.assign\(([\w$]+)\(e=>e\),\{live:([\w$]+)\(!1,\(\)=>!0\)\}\)\);function \1\([\w$]+\)\{return\{glideTo:\2\(0,/;
// The five entry sites, pristine and patched.
const SITES = [
  ["10b1 glow display switch", /function ([\w$]+)\(([\w$]+),([\w$]+)\)\{\2===[\w$]+\.currentHolder&&([\w$]+)\(\3\)\}/, new RegExp("function ([\\w$]+)\\(([\\w$]+),([\\w$]+)\\)\\{\\2===[\\w$]+\\.currentHolder&&([\\w$]+)\\(" + D + "\\3\\)\\)\\}")],
  ["10b2 glow display at lock", /let ([\w$]+)=([\w$]+)\(([\w$]+)\);\1===void 0&&!([\w$]+)\.isDestroyed\(\)&&\(\1=[\w$]+\.screen\.getDisplayMatching\(\4\.getBounds\(\)\)\.id\),([\w$]+)\(\1\),/, new RegExp("let ([\\w$]+)=" + D + "([\\w$]+)\\(([\\w$]+)\\)\\);\\1===void 0&&!([\\w$]+)\\.isDestroyed\\(\\)&&\\(\\1=[\\w$]+\\.screen\\.getDisplayMatching\\(\\4\\.getBounds\\(\\)\\)\\.id\\),([\\w$]+)\\(\\1\\),")],
  ["10b3 teach display at teach start", /let ([\w$]+)=[\w$]+\.getSession\([\w$]+\)\?\.cuSelectedDisplayId;\1===void 0&&/, new RegExp("let ([\\w$]+)=" + D + "[\\w$]+\\.getSession\\([\\w$]+\\)\\?\\.cuSelectedDisplayId\\);\\1===void 0&&")],
  ["10b4 teach display switch", /\.on\(["`]cuSelectedDisplayChanged["`],\(\(\{sessionId:([\w$]+),displayId:([\w$]+)\}\)=>\{\1===[\w$]+&&[\w$]+\(\2\)\}\)\)/, new RegExp("\\.on\\([\"`]cuSelectedDisplayChanged[\"`],\\(\\(\\{sessionId:([\\w$]+),displayId:([\\w$]+)\\}\\)=>\\{\\1===[\\w$]+&&[\\w$]+\\(" + D + "\\2\\)\\)\\}\\)\\)")],
  ["10b5 target label display", /function ([\w$]+)\(([\w$]+)\)\{if\(\2\.mode===["`]app["`]\)return \2\.displayName;let [\w$]+=[\w$]+\(\2\.displayId\?\?null\);/, new RegExp("function ([\\w$]+)\\(([\\w$]+)\\)\\{if\\(\\2\\.mode===[\"`]app[\"`]\\)return \\2\\.displayName;let [\\w$]+=[\\w$]+\\(" + D + "\\2\\.displayId\\?\\?null\\)\\);")],
];
const SPLIT_RE = /\n\/\*__CDB_SPLIT__([^*\n]+?)__\*\/\n/;
function splitParts(blob) {
  const pieces = blob.split(SPLIT_RE);
  const names = ["index.js"], bodies = [pieces[0]];
  for (let i = 1; i < pieces.length; i += 2) { names.push(pieces[i]); bodies.push(pieces[i + 1]); }
  return { names, bodies };
}
// Source of `function NAME(` with balanced braces; skips '...' / "..." strings.
function fnSource(s, name) {
  const start = s.indexOf("function " + name + "(");
  if (start < 0) return null;
  let depth = 0, q = null;
  for (let i = s.indexOf("{", start); i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === "\\") { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

let skipped = false;
let haveBin = true;
try { accessSync(PATCH_BIN, constants.X_OK); } catch { haveBin = false; }
if (!haveBin || !existsSync(path.join(BUILD_DIR, "index.js"))) {
  skipped = true;
  console.log("\n  SKIP bundle sections: " + (haveBin ? "no extract under tmp/app.asar.contents/" : `${PATCH_BIN} is not compiled`));
} else {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "cdb-cu-overlay-display-"));
  try {
    let blob = readFileSync(path.join(BUILD_DIR, "index.js"), "utf8");
    for (const c of readdirSync(BUILD_DIR).filter((d) => /^index.*\.chunk-.*\.js$/.test(d)).sort()) blob += "\n/*__CDB_SPLIT__" + c + "__*/\n" + readFileSync(path.join(BUILD_DIR, c), "utf8");
    const staged = path.join(scratch, "staged_index.js");
    writeFileSync(staged, blob);

    console.log("\n[2] pristine anchors, apply, idempotency");
    check("resolver present once", countRe(blob, RESOLVER_RE), 1);
    check("glow setter present once", countRe(blob, GLOW_SET_RE), 1);
    check("teach setter present once", countRe(blob, TEACH_SET_RE), 1);
    check("glow show present once", countRe(blob, GLOW_RE), 1);
    for (const [name, pre] of SITES) check(`${name}: pristine site once`, countRe(blob, pre), 1);
    const resolverSrc = (RESOLVER_RE.exec(blob) || [])[0] || "";
    const [, resolver, , scr] = RESOLVER_RE.exec(blob) || [];
    const [, glowSet, , , , glowGetBare, glowGetWrapped] = GLOW_SET_RE.exec(blob) || [];
    const glowGet = glowGetBare || glowGetWrapped;
    const [, teachSet, , , , , teachGet] = TEACH_SET_RE.exec(blob) || [];
    const [, glowFn, , ct, , busyFn] = GLOW_RE.exec(blob) || [];
    const [, glowSwitch] = SITES[0][1].exec(blob) || [];
    const [, labelFn] = SITES[4][1].exec(blob) || [];
    // Every caller of the two setters is one of the entry sites (or the
    // main-window fallback right after site 10b2 / 10b3).
    const callers = (n) => [...blob.matchAll(new RegExp("(?<![\\w$.])" + esc(n || "\u0000") + "\\(", "g"))].length - 1;
    check(`glow setter ${glowSet}() callers: the switch ${glowSwitch} and the lock handler`, callers(glowSet), 2);
    check(`teach setter ${teachSet}() callers: teach start and teach switch`, callers(teachSet), 2);
    check(`resolver ${resolver}() callers: glow getter, teach getter, label`, callers(resolver), 3);
    check(`glow switch ${glowSwitch}() callers: two cuSelectedDisplayChanged registrations and the remote-tools callback`, callers(glowSwitch), 3);
    check(`${ct} is the CLICK_THROUGH_WINDOWS key`, countRe(blob, new RegExp("CLICK_THROUGH_WINDOWS:\\(\\)=>" + esc(ct || "\u0000") + "[,}]")), 1);
    const pristine = splitParts(blob);
    const rIdx = pristine.bodies.findIndex((b) => RESOLVER_RE.test(b));

    const run = (f) => { const r = spawnSync(PATCH_BIN, [f], { encoding: "utf8" }); return { status: r.status, out: String(r.stdout || "") + String(r.stderr || "") }; };
    const r1 = run(staged);
    check("first run exits 0", r1.status, 0);
    check("no [FAIL] line", /\[FAIL\]/.test(r1.out), false);
    check(`[PASS] ${EXPECTED_PATCHES}/${EXPECTED_PATCHES} reported`, r1.out.includes(`[PASS] ${EXPECTED_PATCHES}/${EXPECTED_PATCHES} sub-patches applied`), true);
    for (const [name] of SITES) check(`${name} reported [OK]`, r1.out.includes(`[OK] ${name}: Linux display id -> Electron id`), true);
    check("10c reported [OK]", r1.out.includes(`[OK] 10c glow show ${glowFn}: off on a background display or without a compositing manager (1 match)`), true);
    if (r1.status !== 0) console.log(r1.out);
    const patched = readFileSync(staged, "utf8");
    const r2 = run(staged);
    check("second run exits 0 and changes nothing", r2.status === 0 && readFileSync(staged, "utf8") === patched, true);
    check("resolver byte-unchanged", patched.split(resolverSrc).length - 1, 1);
    check("no force-primary injection", /\{if\(process\.platform==="linux"\)[\w$]+=null;return /.test(patched), false);
    for (const [name, pre, post] of SITES) {
      check(`${name}: patched once`, countRe(patched, post), 1);
      check(`${name}: pristine shape gone`, countRe(patched, pre), 0);
    }
    check("patched glow show once", countRe(patched, GLOW_PATCHED_RE), 1);
    check("translation expression 5 times", patched.split(DID).length - 1, 5);
    check("executor helper embedded once", patched.split("globalThis.__cdbCuElectronDisplayId=function(v){").length - 1, 1);
    const after = splitParts(patched);
    const pIdx = after.bodies.findIndex((b) => GLOW_PATCHED_RE.test(b));
    check("all rewrites in the resolver's own chunk", after.names[pIdx] === pristine.names[rIdx] && after.bodies[pIdx].split(DID).length - 1 === 5, true);
    if (pIdx >= 0) {
      const f = path.join(scratch, after.names[pIdx]);
      writeFileSync(f, after.bodies[pIdx]);
      let okc = true;
      try { execFileSync("node", ["--check", f], { stdio: "pipe" }); } catch { okc = false; }
      check(`node --check ${after.names[pIdx]}`, okc, true);
    }

    console.log("\n[3] Rule 6: no false success");
    for (const [name, pre, post] of SITES) {
      const pm = post.exec(patched), om = pre.exec(blob);
      const half = path.join(scratch, "half.js");
      writeFileSync(half, pm && om ? patched.replace(pm[0], om[0]) : patched);
      const r = run(half);
      check(`bundle without ${name}: refused as half-patched`, r.status !== 0 && new RegExp("half-patched input: .*missing: .*" + reEsc(name)).test(r.out), true);
    }
    {
      const pgm = GLOW_PATCHED_RE.exec(patched), gm = GLOW_RE.exec(blob);
      const half = path.join(scratch, "half10c.js");
      writeFileSync(half, pgm && gm ? patched.replace(pgm[0], gm[0]) : patched);
      const r = run(half);
      check("bundle without 10c: refused as half-patched", r.status !== 0 && /half-patched input: .*missing: .*10c glow off/.test(r.out), true);
    }
    const movedCases = [
      ["moved teach start", (b) => b.replace(/(let [\w$]+=[\w$]+\.getSession\([\w$]+\)\?\.)cuSelectedDisplayId(;)/, "$1cuDisplayId$2"), /\[FAIL\] 10b3 teach display at teach start: 0 matches, expected 1/],
      ["moved label", (b) => b.replace(/(return ([\w$]+)\.displayName;let [\w$]+=[\w$]+\()\2\.displayId\?\?null\)/, "$1$2.display??null)"), /\[FAIL\] 10b5 target label display: 0 matches, expected 1/],
      ["moved glow setter", (b) => b.replace(GLOW_SET_RE, (m) => m.replace(".bounds)", ".workArea)")), /\[FAIL\] 10b glow setter .*: 0 definitions, expected 1/],
      ["moved resolver", (b) => b.replace(RESOLVER_RE, (m) => m.replace(".find(", ".filter(")), /\[FAIL\] 10b overlay display resolver: 0 definitions, expected 1/],
      ["glow show without its cuLockChanged call", (b) => b.replace("[cu-glow] showGlow failed", "[cu-glow] show failed"), /\[FAIL\] 10c glow show [\w$]+: not the cuLockChanged glow call/],
    ];
    for (const [label, mut, want] of movedCases) {
      const f = path.join(scratch, "moved.js");
      writeFileSync(f, mut(blob));
      const r = run(f);
      check(`${label}: names the sub-patch and fails`, r.status !== 0 && want.test(r.out) && !/\[PASS\]/.test(r.out), true);
    }

    console.log("\n[3b] 10d: upstream's drawn pointer exposed to the Linux executor (flag 1916550538)");
    // The flag decision the glow show reads stays upstream's:
    // `r=(e?.claudeHasThePointer??!0)&&T()`.
    const CURSOR_RE = /function ([\w$]+)\(\)\{try\{let ([\w$]+)=([\w$]+)\(\);return \2==="default"\?([\w$]+)\(([\w$]+)\):\2==="on"\}catch\(([\w$]+)\)\{return [\w$]+\.warn\("\[cu-glow\] flag unreadable, staying off"/;
    const OLD_10D = 'if(process.platform==="linux")return!1;try{';
    const [, curFn, , , , flagVar] = CURSOR_RE.exec(blob) || [];
    {
      check("drawn-pointer flag decision: pristine once", countRe(blob, CURSOR_RE), 1);
      check(`${flagVar} is flag 1916550538`, countRe(blob, new RegExp("(?<![\\w$.])" + esc(flagVar || "\u0000") + '="1916550538"')), 1);
      check(`glow show reads ${curFn}() for claudeHasThePointer`, countRe(blob, new RegExp("\\(([\\w$]+)\\?\\.claudeHasThePointer\\?\\?!0\\)&&" + esc(curFn || "\u0000") + "\\(\\)")), 1);
      check(`flag decision ${curFn}() byte-unchanged by the patch`, !!curFn && fnSource(patched, curFn) === fnSource(blob, curFn), true);
      check("no Linux override of the flag decision", patched.includes(OLD_10D), false);
      check("factory: pristine once", countRe(blob, DP_FACTORY_RE), 1);
      check("factory: exposed once (patched)", countRe(patched, DP_PATCHED_RE), 1);
      check("factory: pristine shape only behind our assignment", countRe(patched, DP_FACTORY_RE), 1);
      const [, fac, wrap] = DP_PATCHED_RE.exec(patched) || [];
      check(`factory ${fac}: one darwin consumer (drawnPointer:${fac}(e=>e))`, countRe(blob, new RegExp("drawnPointer:" + esc(fac || "\u0000") + "\\(\\(?\\(?[\\w$]+\\)?=>[\\w$]+\\)?\\)")), 1);
      check("10d reported [OK]", r1.out.includes(`[OK] 10d drawn pointer factory ${fac} (wrapper ${wrap}): exposed to the Linux executor`), true);
      const after3b = splitParts(patched);
      const dIdx = after3b.bodies.findIndex((b) => DP_PATCHED_RE.test(b));
      check("the assignment sits in the factory's own chunk", dIdx >= 0 && after3b.names[dIdx] === pristine.names[pristine.bodies.findIndex((b) => DP_FACTORY_RE.test(b))], true);
      if (dIdx >= 0) {
        const f = path.join(scratch, "dp-" + after3b.names[dIdx]);
        writeFileSync(f, after3b.bodies[dIdx]);
        let okc = true;
        try { execFileSync("node", ["--check", f], { stdio: "pipe" }); } catch { okc = false; }
        check(`node --check ${after3b.names[dIdx]} (with the assignment)`, okc, true);
      }
      // Rule 6: a bundle missing only 10d is refused as half-patched.
      const pm3 = DP_PATCHED_RE.exec(patched);
      const assign = pm3 ? pm3[0].slice(0, pm3[0].indexOf("function ")) : "";
      const half = path.join(scratch, "half10d.js");
      writeFileSync(half, assign ? patched.replace(assign, "") : patched);
      let r = run(half);
      check("bundle without 10d: refused as half-patched", r.status !== 0 && /half-patched input: .*missing: .*10d drawn pointer for the Linux executor/.test(r.out), true);
      // The old 10d (flag decision forced off on Linux) is never "already patched".
      const oldShape = (b) => b.replace(CURSOR_RE, (m0) => m0.replace("{try{", "{" + OLD_10D));
      const oldBuild = path.join(scratch, "old10d.js");
      writeFileSync(oldBuild, oldShape(assign ? patched.replace(assign, "") : patched));
      r = run(oldBuild);
      check("output of the old 10d: refused", r.status !== 0 && /\[FAIL\] 10d: input carries the old "drawn cursor off on Linux" edit/.test(r.out) && !/already present/.test(r.out), true);
      writeFileSync(oldBuild, oldShape(patched));
      r = run(oldBuild);
      check("new 10d plus the old edit: refused, not idempotent", r.status !== 0 && /\[FAIL\] 10d: input carries the old/.test(r.out), true);
      writeFileSync(oldBuild, oldShape(blob));
      r = run(oldBuild);
      check("pristine plus the old edit: refused", r.status !== 0 && !/\[PASS\]/.test(r.out), true);
      // Moved factory shapes fail loud, naming the sub-patch.
      const movedDp = [
        ["factory without realPointerGoesTo", (b) => b.replace(/realPointerGoesTo:([\w$]+)\(void 0,/, "realPointerMoves:$1(void 0,"), /\[FAIL\] 10d drawn pointer factory [\w$]+: methods not found exactly once .*realPointerGoesTo\(0 in the factory/],
        ["factory renamed glideTo", (b) => b.replace(/\{return\{glideTo:([\w$]+)\(0,/, "{return{slideTo:$1(0,"), /\[FAIL\] 10d drawn pointer factory \(`function F\(e\)\{return\{glideTo:W\(0,.*: 0 matches, expected 1/],
        ["wrapper changed shape", (b) => b.replace(/(function [\w$]+\([\w$]+,[\w$]+\)\{return\(\.\.\.[\w$]+\)=>\{let [\w$]+=[\w$]+;try\{return )([\w$]+\(\)&&)/, "$1!0&&$2"), /\[FAIL\] 10d drawn pointer factory [\w$]+: wrapper [\w$]+ is not/],
        ["no darwin consumer", (b) => b.replace(/drawnPointer:([\w$]+)\(\(e=>e\)\)/, "drawnPointer:void 0"), /\[FAIL\] 10d drawn pointer factory [\w$]+: not the darwin executor's drawnPointer/],
      ];
      for (const [label, mut, want] of movedDp) {
        const f = path.join(scratch, "moved10d.js");
        const mb = mut(blob);
        writeFileSync(f, mb);
        r = run(f);
        check(`${label}: mutation applied`, mb !== blob, true);
        check(`${label}: names the sub-patch and fails`, r.status !== 0 && want.test(r.out) && !/\[PASS\]/.test(r.out), true);
      }
    }

    console.log("\n[4] the REAL upstream overlay code in vm");
    // One vm per run: the setters, getters, resolver, glow switch, lock
    // handler, teach controller and label from the given chunk; the free names
    // they touch (logger, window refs, other module state) come from a scope
    // object: functions we do not load are no-ops.
    const chunkOf = (b) => splitParts(b).bodies.find((x) => x.includes("function " + resolver + "(")) || "";
    const lockFn = (() => { const m = /function ([\w$]+)\([\w$]+,[\w$]+\)\{(?:if\(process\.platform==="linux"&&globalThis\.__cuKwinMode\)return;)?[\w$]+\.on\("cuLockChanged",/.exec(blob); return m && m[1]; })();
    const teachCtl = (() => { const i = blob.indexOf('.on("teachModeChanged",'); const head = blob.lastIndexOf("function ", i); const m = /^function ([\w$]+)\(/.exec(blob.slice(head)); return m && m[1]; })();
    check("lock handler and teach controller located", !!(lockFn && teachCtl), true);
    // Free names: anything not loaded and not a real global is a no-op that
    // absorbs property reads and calls (logger, IPC, other module state).
    const noop = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive || k === "then" ? undefined : noop), apply: () => undefined });
    function scopeFor(declared, preset) {
      const t = { ...preset };
      return new Proxy(t, {
        has: (o, k) => typeof k === "string" && (k in o || (!declared.has(k) && !(k in globalThis))),
        get: (o, k) => (k in o ? o[k] : k === Symbol.unscopables ? undefined : noop),
        set: (o, k, v) => { o[k] = v; return true; },
      });
    }
    function world(chunk, screen, { resolverOverride } = {}) {
      const names = [resolver, glowGet, glowSet, glowSwitch, lockFn, teachGet, teachSet, teachCtl, labelFn];
      const srcs = names.map((n) => (n === resolver && resolverOverride) ? resolverOverride : fnSource(chunk, n));
      if (srcs.some((x) => !x)) return null;
      const bounds = { glow: null };
      const lockListeners = [];
      const holderStore = { currentHolder: null, on(ev, fn) { if (ev === "cuLockChanged") lockListeners.push(fn); } };
      const teachMgr = { handlers: {}, sessions: {}, on(ev, fn) { (this.handlers[ev] ||= []).push(fn); }, getSession(id) { return this.sessions[id]; }, emit(ev, a) { for (const f of this.handlers[ev] || []) f(a); } };
      const glowWin = { isDestroyed: () => false, setBounds(b) { bounds.glow = b; } };
      const holderVar = /===([\w$]+)\.currentHolder/.exec(fnSource(chunk, glowSwitch))[1];
      const glowWinVar = GLOW_SET_RE.exec(chunk)[4];
      const scope = scopeFor(new Set(names), { [scr]: { screen }, [holderVar]: holderStore, [glowWinVar]: glowWin, [glowFn]: () => Promise.resolve() });
      const api = new Function("__scope", "with(__scope){" + srcs.join("\n") + "\nreturn{" + names.map((n) => JSON.stringify(n) + ":" + n).join(",") + "}}")(scope);
      return { api, bounds, lockListeners, holderStore, teachMgr, scope };
    }
    function flows(chunk, displays, sel, mainWinX, opts) {
      const screen = makeScreen(displays);
      // The helper reads the executor's Electron screen: same layout.
      loadExecutor({ displays });
      const w = world(chunk, screen, opts);
      if (!w) return null;
      const out = {};
      const mainWin = { isDestroyed: () => false, getBounds: () => ({ x: mainWinX, y: 10, width: 100, height: 100 }) };
      // Glow at lock: selected id (or undefined -> the main window's display).
      w.api[lockFn]((sid) => sel, mainWin);
      w.lockListeners.forEach((f) => f({ holder: "s1" }));
      out.glowLock = (screen.displays.find((d) => JSON.stringify(d.bounds) === JSON.stringify(w.bounds.glow)) || {}).label;
      // Glow switch to the selected display.
      w.holderStore.currentHolder = "s1";
      if (sel !== undefined) { w.api[glowSwitch]("s1", sel); out.glowSwitch = (screen.displays.find((d) => JSON.stringify(d.bounds) === JSON.stringify(w.bounds.glow)) || {}).label; }
      // Teach: start (selected or main window), then switch.
      w.api[teachCtl](w.teachMgr, mainWin);
      w.teachMgr.sessions.s1 = { cuSelectedDisplayId: sel };
      w.teachMgr.emit("teachModeChanged", { sessionId: "s1", active: true });
      out.teachStart = w.api[teachGet]().label;
      if (sel !== undefined) { w.teachMgr.emit("cuSelectedDisplayChanged", { sessionId: "s1", displayId: sel }); out.teachSwitch = w.api[teachGet]().label; }
      // Target label of a screenshot of display `sel`.
      if (sel !== undefined) out.label = w.api[labelFn]({ mode: "display", displayId: sel });
      return out;
    }
    const pChunk = chunkOf(patched), oChunk = chunkOf(blob);
    const oldResolver = resolverSrc.replace(/^(function [\w$]+\(([\w$]+)\)\{)/, (m0, head, p) => head + `if(process.platform==="linux")${p}=null;`);
    const show = (o) => o ? JSON.stringify(o) : "null";
    // Host layout, selected = our index 2 (the ultrawide at 0,0).
    const want2 = { glowLock: "C49RG9x", glowSwitch: "C49RG9x", teachStart: "C49RG9x", teachSwitch: "C49RG9x", label: "C49RG9x" };
    check("host, selected index 2: patched -> the ultrawide everywhere", show(flows(pChunk, HOST, 2, 7100)), JSON.stringify(want2));
    const pristineHost = flows(oChunk, HOST, 2, 7100);
    check("host, selected index 2: pristine upstream -> eDP-1 (index is no Electron id)", pristineHost && pristineHost.glowLock, "eDP-1");
    const oldHost = flows(oChunk, HOST, 2, 7100, { resolverOverride: oldResolver });
    check("host, selected index 2: old force-primary 10b -> eDP-1 (the reported bug)", oldHost && oldHost.glowLock, "eDP-1");
    // Host layout, nothing selected: the main window's display (real Electron id).
    check("host, no selection, main window on DP-2: glow + teach on DP-2", show(flows(pChunk, HOST, undefined, 5200)), JSON.stringify({ glowLock: "DP-2", teachStart: "DP-2" }));
    // Misaligned EDID-less ids {1,4}, our indexes {0,1}.
    const wantM = { glowLock: "DP-2", glowSwitch: "DP-2", teachStart: "DP-2", teachSwitch: "DP-2", label: "DP-2" };
    check("misaligned, selected index 1 (our DP-2): patched -> DP-2 everywhere", show(flows(pChunk, MISALIGNED, 1, 50)), JSON.stringify(wantM));
    const pm = flows(oChunk, MISALIGNED, 1, 50);
    check("misaligned, selected index 1: pristine -> HDMI-0 (Electron id 1 is another monitor)", pm && pm.glowLock, "HDMI-0");
    check("misaligned, no selection, main window on DP-2 (Electron id 4): DP-2 via upstream's fallback", show(flows(pChunk, MISALIGNED, undefined, 2000)), JSON.stringify({ glowLock: "DP-2", teachStart: "DP-2" }));
    check("misaligned, no selection, main window on HDMI-0 (Electron id 1): HDMI-0", show(flows(pChunk, MISALIGNED, undefined, 50)), JSON.stringify({ glowLock: "HDMI-0", teachStart: "HDMI-0" }));
    // EDID-less ids == indexes.
    check("aligned ids == indexes, selected 1: Virtual-2 everywhere", show(flows(pChunk, ALIGNED, 1, 50)), JSON.stringify({ glowLock: "Virtual-2", glowSwitch: "Virtual-2", teachStart: "Virtual-2", teachSwitch: "Virtual-2", label: "Virtual-2" }));
    // Helper missing or throwing: upstream unchanged.
    {
      const screen = makeScreen(HOST);
      loadExecutor({ displays: HOST });
      const keep = globalThis.__cdbCuElectronDisplayId;
      globalThis.__cdbCuElectronDisplayId = () => { throw new Error("boom"); };
      const w = world(pChunk, screen);
      w.holderStore.currentHolder = "s1";
      w.api[glowSwitch]("s1", 2);
      check("helper throws: glow switch -> upstream (index 2 is no Electron id -> primary)", (HOST.find((d) => JSON.stringify(d.bounds) === JSON.stringify(w.bounds.glow)) || {}).label, "eDP-1");
      delete globalThis.__cdbCuElectronDisplayId;
      w.api[glowSwitch]("s1", 26616532992);
      check("no helper (KWin executor): an Electron id still resolves", (HOST.find((d) => JSON.stringify(d.bounds) === JSON.stringify(w.bounds.glow)) || {}).label, "C49RG9x");
      globalThis.__cdbCuElectronDisplayId = keep;
    }
    // Background display: the index is not translated (upstream: primary).
    {
      loadExecutor({ displays: HOST, target: { kind: "x11", display: ":99", env: {} } });
      const w = world(pChunk, makeScreen(HOST));
      w.holderStore.currentHolder = "s1";
      w.api[glowSwitch]("s1", 2);
      check("background display: selected index 2 not mapped onto the user's monitor", (HOST.find((d) => JSON.stringify(d.bounds) === JSON.stringify(w.bounds.glow)) || {}).label, "eDP-1");
      loadExecutor({ displays: HOST });
    }

    // The glow show (10c): upstream's own no-glow path when the flag says off.
    const glowSrc = fnSource(pChunk, glowFn) || "";
    const runGlow = (st) => {
      let shown = false;
      const keep = globalThis.__cdbCuGlowOff;
      globalThis.__cdbCuGlowOff = () => !!st.off;
      const scope = scopeFor(new Set([glowFn]), { process: { platform: st.platform || "linux" }, [ct]: !st.wayland, [busyFn]: () => { shown = true; throw new Error("past the gate"); } });
      try { new Function("__scope", "with(__scope){" + glowSrc + "\nreturn " + glowFn + "()}")(scope); } catch { /* past the gate */ }
      globalThis.__cdbCuGlowOff = keep;
      return shown;
    };
    check(`glow show: the busy flag ${busyFn} is derived from the bundle`, typeof busyFn === "string" && glowSrc.includes(busyFn + "(!0)"), true);
    check("glow: X11 desktop session -> shown", runGlow({}), true);
    check("glow: X11 background display -> not shown", runGlow({ off: true }), false);
    check("glow: Wayland session -> not shown (upstream)", runGlow({ wayland: true }), false);
    check("glow: non-Linux with the flag set -> shown (unchanged)", runGlow({ platform: "darwin", off: true }), true);

    console.log("\n[5] upstream's drawn pointer in vm, fed by the real executor (10d, flag 1916550538)");
    {
      // The drawn-pointer module of the patched chunk, from its config object
      // to the end of the factory: our assignment runs inside it, as at module
      // load. Its free names come from the bundle itself.
      const dpChunk = splitParts(patched).bodies.find((b) => DP_PATCHED_RE.test(b)) || "";
      const cfg = /var ([\w$]+)=\{baseMs:[\d.]+,perBitMs:[\d.]+,targetPx:[\d.]+,minMs:[\d.]+,maxMs:[\d.]+,curve:/.exec(dpChunk);
      const [, facName, wrapName] = DP_PATCHED_RE.exec(dpChunk) || [];
      const facSrc = facName ? fnSource(dpChunk, facName) : null;
      const slice = cfg && facSrc ? dpChunk.slice(cfg.index, dpChunk.indexOf(facSrc) + facSrc.length) : "";
      check("drawn-pointer module located (config .. factory, with our assignment)", !!slice && DP_PATCHED_RE.test(slice), true);
      const name = (re) => (re.exec(slice) || [])[1];
      const clampN = name(/Math\.round\(([\w$]+)\([\w$]+\.baseMs\+/);
      const elbowN = name(/\{elbow:[\w$]+\}=([\w$]+)/);
      const electronN = (/let [\w$]+=([\w$]+)\.screen\.getCursorScreenPoint\(\)/.exec(slice) || [])[1];
      const motionN = name(/let [\w$]+=!([\w$]+)\(\)&&/);
      const logN = name(/([\w$]+)\.warn\(["`]\[cu-glow\] drawing/);
      const nativeN = name(/try\{[\w$]+=([\w$]+)\(\)\?\.cuSetSystemPointerHidden/);
      const wrapSrc = fnSource(slice, wrapName) || "";
      const stateN = (/let [\w$]+=([\w$]+);try/.exec(wrapSrc) || [])[1];
      const activateN = stateN && (new RegExp("function ([\\w$]+)\\(([\\w$]+),([\\w$]+)\\)\\{" + esc(stateN) + "=\\2,[\\w$]+\\(\\3\\)\\}").exec(slice) || [])[1];
      const elbowSrc = elbowN && new RegExp("(?<![\\w$.])" + esc(elbowN) + "=\\{[^}]*elbow:\\{x:([\\d.]+),y:([\\d.]+)\\}").exec(dpChunk);
      check("module free names derived from the bundle", [clampN, elbowN, electronN, motionN, logN, nativeN, stateN, activateN].every(Boolean) && !!elbowSrc, true);
      // Load it; returns the glow show's arrow switch (NQa: the arrow on in a glow window).
      const loadDp = (screen, platform = "linux") => {
        delete globalThis.__cdbCuDrawnPointer;
        const clampSrc = fnSource(dpChunk, clampN) || fnSource(blob, clampN);
        const clamp = new Function(clampSrc + "\nreturn " + clampN + ";")();
        return new Function("process", clampN, elbowN, electronN, motionN, logN, nativeN, slice + "\nreturn " + activateN + ";")(
          { platform }, clamp, { elbow: { x: +elbowSrc[1], y: +elbowSrc[2] } }, { screen }, () => false, { warn() {}, info() {}, debug() {}, error() {} }, () => null);
      };
      const glowWin = (bounds) => {
        const w = { destroyed: false, scripts: [], isDestroyed: () => w.destroyed, isVisible: () => true, getBounds: () => bounds,
          webContents: { isCrashed: () => false, executeJavaScript: (js) => { w.scripts.push(js); return Promise.resolve(); } } };
        return w;
      };
      const lastAt = (w, id) => { let m = null; for (const js of w.scripts) for (const x of js.matchAll(new RegExp('\\["' + id + '","([-\\d.]+)px ([-\\d.]+)px"\\]', "g"))) m = [+x[1], +x[2]]; return m; };
      check("darwin: the module sets no global", (loadDp(makeScreen(HOST), "darwin"), globalThis.__cdbCuDrawnPointer), undefined);
      // One rig: real executor on a stub x11-bridge that moves the real
      // pointer (root px -> DIP, as Electron reports it), real drawn pointer
      // with every call recorded in the same log as the bridge commands.
      const log = [];
      let liveCalls = 0;
      const pxToDip = (displays, px, py) => {
        for (const d of displays) {
          const sf = d.scaleFactor || 1, no = d.nativeOrigin || { x: d.bounds.x * sf, y: d.bounds.y * sf };
          if (px >= no.x && px < no.x + d.bounds.width * sf && py >= no.y && py < no.y + d.bounds.height * sf) return { x: d.bounds.x + (px - no.x) / sf, y: d.bounds.y + (py - no.y) / sf };
        }
        return { x: px, y: py };
      };
      const rig = ({ displays, session = "x11", desktop = "XFCE", target = null, glowBounds, arrow = true, kwin = false, cursor = { x: 10, y: 10 } }) => {
        let cur = { ...cursor };
        const bridge = (args) => {
          log.push("bridge " + args.join(" "));
          const a = (k) => +args[args.indexOf(k) + 1];
          if (["pointer-move", "pointer-click", "pointer-scroll"].includes(args[0])) cur = pxToDip(displays, a("--x"), a("--y"));
          if (args[0] === "pointer-drag") cur = pxToDip(displays, a("--to-x"), a("--to-y"));
          return "{}";
        };
        const screen = loadExecutor({ displays, session, desktop, target, bridge });
        globalThis.__cuKwinMode = kwin;
        screen.getCursorScreenPoint = () => ({ ...cur });
        const ex = globalThis.__linuxExecutor;
        const activate = loadDp(screen);
        const win = glowWin(glowBounds || displays[0].bounds);
        if (arrow) activate(win, 0);
        const d = globalThis.__cdbCuDrawnPointer;
        for (const k of ["glideTo", "jumpTo", "press", "realPointerGoesTo"]) {
          const f = d[k];
          d[k] = (...a) => { log.push(a[0] ? `${k}(${a[0].x},${a[0].y})` : `${k}()`); return f(...a); };
        }
        const lv = d.live; d.live = () => { liveCalls++; return lv(); };
        log.length = 0; liveCalls = 0;
        return { ex, win, screen, cur: () => cur };
      };
      const take = () => log.splice(0);
      const bridgeOnly = (l) => l.filter((x) => x.startsWith("bridge "));
      // The action script every row runs (a glide before the click, as the
      // handler does for an unbatched, attended click).
      const script = async (ex) => {
        const out = [];
        const step = async (label, fn) => { try { await fn(); } catch (e) { log.push("threw " + (e && e.message)); } out.push([label, take()]); };
        await step("move", () => ex.moveMouse(100, 200));
        let spt;
        await step("travel", async () => { spt = await ex.showPointerTravel(300, 400, () => false); });
        await step("click", () => ex.click(300, 400, "left", 1));
        await step("down", () => ex.mouseDown());
        await step("held move", () => ex.moveMouse(500, 600));
        await step("up", () => ex.mouseUp());
        await step("move after up", () => ex.moveMouse(10, 10));
        await step("drag from start", () => ex.drag({ x: 20, y: 30 }, { x: 40, y: 50 }));
        await step("drag from pointer", () => ex.drag(void 0, { x: 70, y: 80 }));
        await step("scroll", () => ex.scroll(90, 95, 0, 3));
        return { steps: Object.fromEntries(out), spt };
      };
      const J = (x) => JSON.stringify(x);
      // Flag ON: X11 with a compositing manager, the glow shows the arrow.
      {
        const r = rig({ displays: HOST, glowBounds: HOST[2].bounds });
        check("flag on: live() true while the glow shows the arrow", globalThis.__cdbCuDrawnPointer.live(), true);
        liveCalls = 0;
        const { steps, spt } = await script(r.ex);
        check("flag on: move = glideTo, realPointerGoesTo, real move", J(steps.move), J(["glideTo(100,200)", "realPointerGoesTo(100,200)", "bridge pointer-move --x 100 --y 200"]));
        check("flag on: showPointerTravel animated (true)", spt, true);
        check("flag on: showPointerTravel only re-asks glideTo(target), no input", steps.travel.length >= 2 && steps.travel.every((x) => x === "glideTo(300,400)"), true);
        check("flag on: click = realPointerGoesTo, real move, press, click", J(steps.click), J(["realPointerGoesTo(300,400)", "bridge pointer-move --x 300 --y 400", "press()", "bridge pointer-click --x 300 --y 400 --button left --count 1"]));
        check("flag on: mouseDown = press, button down", J(steps.down), J(["press()", "bridge left-mouse-down"]));
        check("flag on: move while held = jumpTo (no glide)", J(steps["held move"]), J(["jumpTo(500,600)", "realPointerGoesTo(500,600)", "bridge pointer-move --x 500 --y 600"]));
        check("flag on: mouseUp = button up only", J(steps.up), J(["bridge left-mouse-up"]));
        check("flag on: after mouseUp moves glide again", steps["move after up"][0], "glideTo(10,10)");
        check("flag on: drag with a start = real pointer to start, press there, jump to end while held, drag",
          J(steps["drag from start"]), J(["realPointerGoesTo(20,30)", "bridge pointer-move --x 20 --y 30", "press()", "jumpTo(40,50)", "realPointerGoesTo(40,50)", "bridge pointer-drag --from-x 20 --from-y 30 --to-x 40 --to-y 50"]));
        check("flag on: drag from the pointer = press, jump to end, drag (no extra move)",
          J(steps["drag from pointer"]), J(["press()", "jumpTo(70,80)", "realPointerGoesTo(70,80)", "bridge pointer-drag --from-x 40 --from-y 50 --to-x 70 --to-y 80"]));
        check("flag on: scroll = glideTo, realPointerGoesTo, real move, wheel", J(steps.scroll), J(["glideTo(90,95)", "realPointerGoesTo(90,95)", "bridge pointer-move --x 90 --y 95", "bridge pointer-scroll --x 90 --y 95 --dx 0 --dy 3"]));
        check("flag on: one live() per action that feeds it (mouseUp feeds nothing)", liveCalls, 9);
        const ring = lastAt(r.win, "cursor-press"), arrowAt = lastAt(r.win, "cursor");
        check("flag on: last press ring at the drag start of the last press (real pointer)", J(ring), J([40, 50]));
        check("flag on: arrow rests on the scroll target", J(arrowAt), J([90, 95]));
      }
      // The drag-with-start press ring sits on the start (the real pointer was moved there first).
      {
        const r = rig({ displays: HOST, glowBounds: HOST[2].bounds });
        await r.ex.moveMouse(600, 600); // arrow gliding elsewhere
        await r.ex.drag({ x: 20, y: 30 }, { x: 40, y: 50 });
        check("flag on: drag with a start rings the start, not where the arrow was", J(lastAt(r.win, "cursor-press")), J([20, 30]));
        check("flag on: then the arrow is at the end", J(lastAt(r.win, "cursor")), J([40, 50]));
      }
      // Flag OFF (the default): the glow shows no arrow. Same bridge commands as
      // without any drawn pointer, nothing but live() called, nothing animated.
      let baseline;
      {
        rig({ displays: HOST, glowBounds: HOST[2].bounds, arrow: false });
        const keep = globalThis.__cdbCuDrawnPointer; delete globalThis.__cdbCuDrawnPointer;
        const { steps, spt } = await script(globalThis.__linuxExecutor);
        baseline = steps;
        check("no drawn pointer object: showPointerTravel false", spt, false);
        globalThis.__cdbCuDrawnPointer = keep;
        const r = rig({ displays: HOST, glowBounds: HOST[2].bounds, arrow: false });
        check("flag off: live() false", globalThis.__cdbCuDrawnPointer.live(), false);
        liveCalls = 0;
        const off = await script(r.ex);
        check("flag off: showPointerTravel reports nothing to animate", off.spt, false);
        check("flag off: no drawn-pointer method called", Object.values(off.steps).flat().filter((x) => !x.startsWith("bridge ")).length, 0);
        check("flag off: bridge commands identical to no drawn pointer at all", J(off.steps), J(baseline));
        check("flag off: no arrow drawn in the glow", r.win.scripts.length, 0);
        // The flag on adds input only for a drag with a start (the move to the start, which pointer-drag makes first anyway).
        const on = rig({ displays: HOST, glowBounds: HOST[2].bounds });
        const onRun = await script(on.ex);
        const onBridge = Object.fromEntries(Object.entries(onRun.steps).map(([k, v]) => [k, bridgeOnly(v)]));
        const want = { ...baseline, "drag from start": ["bridge pointer-move --x 20 --y 30", ...baseline["drag from start"]] };
        check("flag on: bridge commands = flag off + the start move of a drag", J(onBridge), J(want));
      }
      // HiDPI second monitor: the arrow lands where the real pointer lands.
      {
        const two = [disp(1, "A", R(0, 0, 1920, 1080), 1, { x: 0, y: 0 }), disp(2, "B", R(1920, 0, 1280, 720), 1.5, { x: 1920, y: 0 })];
        two.primaryIdx = 0;
        const r = rig({ displays: two, glowBounds: two[1].bounds, cursor: { x: 2000, y: 100 } });
        const spt = await r.ex.showPointerTravel(2500.4, 300.6, () => false);
        await r.ex.click(2500.4, 300.6, "left", 1);
        const lg = take();
        const click = lg.find((x) => x.startsWith("bridge pointer-click"));
        check("HiDPI 1.5 on the second monitor: glide animated", spt, true);
        check("HiDPI 1.5: real click in root pixels (x11-bridge)", click, "bridge pointer-click --x 2790 --y 451 --button left --count 1");
        const ring = lastAt(r.win, "cursor-press") || [NaN, NaN], real = r.cur();
        check("HiDPI 1.5: press ring within 1 DIP of the real pointer (glow-relative)", Math.hypot(ring[0] + 1920 - real.x, ring[1] - real.y) <= 1, true);
        check("HiDPI 1.5: no snap needed (arrow already on the real pointer)", J(ring), J([580.4, 300.6]));
      }
      // Abort (Escape stop key -> upstream's turn abort) cuts the glide short.
      {
        let r = rig({ displays: HOST, glowBounds: HOST[2].bounds });
        let t0 = performance.now();
        const full = await r.ex.showPointerTravel(4000, 1200, () => false);
        const fullMs = performance.now() - t0;
        r = rig({ displays: HOST, glowBounds: HOST[2].bounds });
        t0 = performance.now();
        const cut = await r.ex.showPointerTravel(4000, 1200, () => performance.now() - t0 > 60);
        const cutMs = performance.now() - t0;
        r = rig({ displays: HOST, glowBounds: HOST[2].bounds });
        t0 = performance.now();
        const now = await r.ex.showPointerTravel(4000, 1200, () => true);
        const nowMs = performance.now() - t0;
        check(`no abort: waits for the glide (${Math.round(fullMs)} ms, upstream 420-900)`, full === true && fullMs >= 200 && fullMs < 1100, true);
        check(`abort after 60 ms: returns within the next 50 ms poll (${Math.round(cutMs)} ms)`, cut === true && cutMs >= 60 && cutMs < 160, true);
        check(`aborted already: returns at once (${Math.round(nowMs)} ms)`, now === true && nowMs < 40, true);
        r = rig({ displays: HOST, glowBounds: HOST[2].bounds });
        t0 = performance.now();
        const thr = await r.ex.showPointerTravel(4000, 1200, () => { throw new Error("abort check failed"); });
        check("an abort check that throws ends the wait, never throws", thr === true && performance.now() - t0 < 40, true);
      }
      // A failing cosmetic layer never breaks or delays input.
      {
        rig({ displays: HOST, glowBounds: HOST[2].bounds });
        const boom = () => { throw new Error("boom"); };
        globalThis.__cdbCuDrawnPointer = { live: () => true, glideTo: boom, jumpTo: boom, press: boom, realPointerGoesTo: boom };
        diagLines.length = 0;
        const t0 = performance.now();
        const { steps, spt } = await script(globalThis.__linuxExecutor);
        check("throwing drawn pointer: showPointerTravel false, no throw", spt, false);
        check("throwing drawn pointer: nothing threw out of an action", Object.values(steps).flat().some((x) => x.startsWith("threw")), false);
        const want = { ...baseline, "drag from start": ["bridge pointer-move --x 20 --y 30", ...baseline["drag from start"]] };
        check("throwing drawn pointer: every bridge command still sent", J(Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, bridgeOnly(v)]))), J(want));
        check("throwing drawn pointer: no delay", performance.now() - t0 < 300, true);
        check("throwing drawn pointer: logged once with [claude-cu]", diagLines.filter((m) => /^\[claude-cu\] drawn pointer: .* failed \(boom\) - input goes on without it$/.test(m)).length, 1);
        globalThis.__cdbCuDrawnPointer = { live: boom, glideTo: boom };
        log.length = 0;
        check("live() throws: showPointerTravel false", await globalThis.__linuxExecutor.showPointerTravel(1, 1, () => false), false);
        globalThis.__cdbCuDrawnPointer = { live: () => true };
        check("methods missing: showPointerTravel false", await globalThis.__linuxExecutor.showPointerTravel(1, 1, () => false), false);
        await globalThis.__linuxExecutor.click(5, 6, "left", 1);
        check("methods missing: click still sent", bridgeOnly(take()).includes("bridge pointer-click --x 5 --y 6 --button left --count 1"), true);
        globalThis.__cdbCuDrawnPointer = 42;
        check("not an object: showPointerTravel false", await globalThis.__linuxExecutor.showPointerTravel(1, 1, () => false), false);
      }
      // Every other session row: nothing called at all (the arrow is even forced live).
      for (const row of [
        { label: "XWayland / exotic Wayland", session: "wayland", desktop: "sway" },
        { label: "wlroots Wayland (Hyprland)", session: "wayland", desktop: "Hyprland" },
        { label: "GNOME Wayland", session: "wayland", desktop: "GNOME" },
        { label: "KDE kwin mode", session: "x11", desktop: "KDE", kwin: true },
        { label: "background display", target: { kind: "x11", display: ":99", env: {} } },
      ]) {
        rig({ displays: HOST, glowBounds: HOST[2].bounds, ...row });
        const { steps, spt } = await script(globalThis.__linuxExecutor);
        const dpCalls = Object.values(steps).flat().filter((x) => !x.startsWith("bridge ") && !x.startsWith("threw "));
        check(`${row.label}: no drawn-pointer call (live() included)`, dpCalls.length + liveCalls, 0);
        check(`${row.label}: showPointerTravel false`, spt, false);
      }
      // Claude's own Escape while upstream's X11 grab is up (17h): the grab is
      // resumed exactly once even when the cosmetic layer and the bridge fail,
      // and the bridge error still reaches the caller.
      {
        // The stub x11-bridge throws on the key injection; the live drawn
        // pointer's press throws.
        loadExecutor({ displays: HOST, bridge: (args) => { if (args[0] === "key-sequence") throw new Error("bridge boom"); return "{}"; } });
        const boom = () => { throw new Error("press boom"); };
        globalThis.__cdbCuDrawnPointer = { live: () => true, glideTo: () => 0, jumpTo: () => {}, realPointerGoesTo: () => {}, press: boom };
        let resumed = 0, suspended = 0;
        globalThis.__cdbCuEscGrab = { suspend: () => { suspended++; return true; }, resume: () => { resumed++; } };
        const keepW = globalThis.__cdbCuEscWatch;
        globalThis.__cdbCuEscWatch = { hasEscape: () => true };
        let err = null;
        try { await globalThis.__linuxExecutor.key("Escape"); } catch (e) { err = e; }
        check("key(\"Escape\") under the X11 grab, bridge throws: suspended once", suspended, 1);
        check("  resumed exactly once", resumed, 1);
        check("  the bridge error still propagates", err && /bridge boom/.test(String(err.message || err)), true);
        delete globalThis.__cdbCuEscGrab;
        if (keepW === undefined) delete globalThis.__cdbCuEscWatch; else globalThis.__cdbCuEscWatch = keepW;
      }
      // The drawn pointer's held state ends with the lock: a turn that ended
      // with the button down does not make the next turn's moves jump.
      for (const held of [true, false]) {
        const r = rig({ displays: HOST, glowBounds: HOST[2].bounds });
        await r.ex.mouseDown();
        take();
        await r.ex.__setLockHeld(held, held ? "local_next" : void 0);
        take();
        await r.ex.moveMouse(120, 130);
        check(`lock ${held ? "taken" : "released"} after a mouseDown: the next move glides (held state cleared)`, take()[0], "glideTo(120,130)");
      }
      globalThis.__cuKwinMode = false;
      delete globalThis.__cdbCuDrawnPointer;
      // The KWin executor has no showPointerTravel: upstream's handler skips the glide.
      const kwinSrc = readFileSync(path.join(repo, "js", "executor_linux.js"), "utf8");
      check("KWin executor: no showPointerTravel, no drawn-pointer use (8a: no glow in kwin mode)", /showPointerTravel|__cdbCuDrawnPointer/.test(kwinSrc), false);
    }

    console.log("\n[6] the drawn cursor and the badge stay out of the screenshots (X11 glow page)");
    {
      const J = (x) => JSON.stringify(x);
      // (a) The element ids our hide style targets, in the REAL glow page.
      const pageRe = /([\w$]+)=`<!doctype html>\\n<html>\\n<head>[\s\S]*?<\/html>`/;
      const pm = pageRe.exec(blob);
      const pageTpl = pm ? pm[0] : "";
      check("glow page template located (one cu-glow.html source)", countRe(blob, /<span id="badge-label">Claude is using your computer<\/span>/) === 1 && !!pm, true);
      const arrowTplM = /,([\w$]+)=`\\n    <div id="cursor-press">[\s\S]*?`/.exec(blob);
      for (const id of ["overlay", "badge", "cursor", "cursor-press", "cursor-ring", "cursor-bloom"]) {
        check(`real page has #${id}`, (pageTpl + (arrowTplM ? arrowTplM[0] : "")).includes(`id="${id}"`), true);
      }
      // (b) The real page in headless Chromium: hide, then restore.
      const exSrc = readFileSync(EXECUTOR, "utf8");
      const constSrc = (/var CU_CAP_WL_ACK_MS=[^\n]*\n/.exec(exSrc) || [""])[0] + (/var CU_CAP_HIDE_JS='[\s\S]*?';\n/.exec(exSrc) || [""])[0] + (/var CU_CAP_SHOW_JS='[^\n]*';\n/.exec(exSrc) || [""])[0];
      const consts = new Function(constSrc + "return{hide:CU_CAP_HIDE_JS,show:CU_CAP_SHOW_JS};")();
      check("hide / restore scripts read from the executor", /cursor-press/.test(consts.hide) && /classList\.remove/.test(consts.show), true);
      let chromium = null;
      for (const c of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"]) { try { accessSync(c, constants.X_OK); chromium = c; break; } catch {} }
      // The page as upstream writes it: its constants (colour, scale, the
      // arrow path, the shadow function, the cursor CSS and markup) evaluated
      // from the bundle, then the page template.
      const startM = /var ([\w$]+)="rgb\(217, 119, 87\)",([\w$]+)=2,/.exec(blob);
      const endM = arrowTplM;
      let page = "";
      if (startM && endM && pm) {
        const decl = blob.slice(startM.index + 4, endM.index + endM[0].length);
        try { page = new Function("let " + decl + ";return " + pageTpl.slice(pm[1].length + 1) + ";")(); } catch (e) { page = ""; console.log("    page build failed: " + e.message); }
      }
      check("real glow page rebuilt from the bundle", page.includes('id="cursor-ring"') && page.includes('id="badge"'), true);
      if (!chromium || !page) {
        console.log("  SKIP the in-page check: " + (chromium ? "no page" : "no chromium"));
      } else {
        const probe = `<script>
(async()=>{const o=document.getElementById("overlay");o.style.transition="none";o.classList.add("own-cursor","own-cursor-shown");o.style.opacity="1";
document.getElementById("badge").style.opacity="1";
const st=id=>getComputedStyle(document.getElementById(id)).visibility;
const ids=["cursor","cursor-press","badge","glow"];
const before=ids.map(st);
const hp=(${consts.hide});
const during=ids.map(st);
// Headless Chromium with virtual time issues no frame for a page without
// damage, so the second animation frame may never come here; the executor
// bounds that wait (CU_CAP_X11_MAX_MS).
const hid=await Promise.race([hp,new Promise(f=>setTimeout(()=>f("bounded"),200))]);
${consts.show};
const after=ids.map(st);
// Nothing shown: the overlay faded out -> answers false, adds nothing.
o.style.transition="none";o.style.opacity="0";const none=await Promise.race([(${consts.hide}),new Promise(f=>setTimeout(()=>f("bounded"),200))]);const cls=document.documentElement.className;
document.body.setAttribute("data-r",JSON.stringify({before,hid,during,after,none,cls,styles:document.querySelectorAll("#cdb-cu-capture-style").length}));})();
</script>`;
        const f = path.join(scratch, "glow-page.html");
        writeFileSync(f, page.replace("</body>", probe + "</body>"));
        let dump = "";
        try { dump = execFileSync(chromium, ["--headless", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=3000", "--dump-dom", "file://" + f], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch (e) { dump = ""; }
        const m = /data-r="([^"]*)"/.exec(dump);
        const r = m ? JSON.parse(m[1].replace(/&quot;/g, '"')) : null;
        check("real page: arrow, ring and badge visible before", r && J(r.before), J(["visible", "visible", "visible", "visible"]));
        check("real page: hidden during the capture, the glow / rim stays", r && J(r.during), J(["hidden", "hidden", "hidden", "visible"]));
        check("real page: the hide answered true (two animation frames) or was cut by the bound", !!r && (r.hid === true || r.hid === "bounded"), true);
        check("real page: visible again after the restore", r && J(r.after), J(["visible", "visible", "visible", "visible"]));
        check("real page: nothing shown -> false, no class added", r && r.none === false && r.cls === "", true);
        check("real page: the style is inserted once per page load", r && r.styles, 1);
      }
      // (c) The executor around x11-bridge captures, with a fake glow window.
      const J2 = (x) => JSON.stringify(x);
      const zoomOk = () => JSON.stringify({ base64: "AA==", width: 10, height: 10 });
      const run = async ({ bridgeAnswer = zoomOk, glow = true, switchOn = true, jsResult = true, jsAnswer = null }) => {
        capLog.length = 0;
        loadExecutor({ displays: HOST, asyncBridge: (args) => { capLog.push("bridge " + args[0]); return bridgeAnswer(args); } });
        await tick();
        globalThis.__cdbCuGlowEnabled = () => switchOn;
        let g = null;
        if (glow) { g = fakeGlow({ visible: true }); g.jsResult = jsResult; g.jsAnswer = jsAnswer; }
        capLog.length = 0;
        let err = null, res = null;
        const t0 = performance.now();
        try { res = await globalThis.__linuxExecutor.zoom({ x: 100, y: 100, w: 50, h: 50 }, undefined, null, 1, { globalCoords: true }); } catch (e) { err = e; }
        const ms = performance.now() - t0;
        await tick();
        delete globalThis.__cdbCuGlowEnabled;
        return { log: capLog.slice(), err, res, ms };
      };
      let o = await run({});
      check("x11: hide, then the bridge capture, then restore", J2(o.log.filter((x) => x !== "bridge screens")), J2(["js hide", "bridge zoom", "js show"]));
      check("x11: the capture result is unchanged", !!o.res && !o.err, true);
      o = await run({ bridgeAnswer: () => new Error("Command failed: zoom\nx11-bridge: XGetImage failed") });
      check("x11: capture fails -> restored anyway", o.log.includes("js hide") && o.log.indexOf("js show") > o.log.indexOf("bridge zoom"), true);
      o = await run({ jsResult: false });
      check(`x11: nothing shown in the page -> no restore, no wait (${Math.round(o.ms)} ms)`, J2(o.log.filter((x) => x !== "bridge screens")), J2(["js hide", "bridge zoom"]));
      o = await run({ jsAnswer: () => new Promise(() => {}) });
      check(`x11: a page that never answers: capture after the bound (${Math.round(o.ms)} ms, bound 80), restored`, o.ms >= 60 && o.ms < 300 && J2(o.log.filter((x) => x !== "bridge screens")) === J2(["js hide", "bridge zoom", "js show"]), true);
      o = await run({ glow: false });
      check("x11: no glow window -> no executeJavaScript at all", o.log.filter((x) => /^js/.test(x)).length, 0);
      o = await run({ switchOn: false });
      check("x11: glow switch off -> no executeJavaScript at all", o.log.filter((x) => /^js/.test(x)).length, 0);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

console.log("");
if (failures.length) {
  console.log(`${failures.length} CHECK(S) FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
if (skipped) { console.log(`${pass} checks passed; bundle sections SKIPPED`); process.exit(3); }
console.log("ALL " + pass + " CHECKS PASSED");
