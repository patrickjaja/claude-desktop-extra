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
// Sections [2]-[4] SKIP (exit 3) when the binary or the extract is missing.
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
    webContents: { isDestroyed: () => w.destroyed, getURL: () => w.url, isLoading: () => w.loading },
  };
  fakeWins.push(w);
  (appListeners["browser-window-created"] || []).forEach((f) => f({}, w));
  return w;
}
function loadExecutor({ displays, session = "x11", desktop = "XFCE", target = null, doctor = X11_DOCTOR(true) }) {
  fakeWins.length = 0;
  for (const k of Object.keys(appListeners)) delete appListeners[k];
  const screen = makeScreen(displays);
  doctorCalls = 0;
  const cp = {
    execFileSync() { throw new Error("not found"); },
    execSync() { throw new Error("nope"); },
    spawnSync() { return { status: 1 }; },
    execFile(bin, args, opts, cb) {
      const c = typeof opts === "function" ? opts : cb;
      if (path.basename(String(bin)) === "x11-bridge" && args && args[0] === "doctor") {
        const d = typeof doctor === "function" ? doctor(++doctorCalls) : (++doctorCalls, doctor);
        setTimeout(() => (d instanceof Error ? c(d, "", String(d.message)) : c(null, JSON.stringify(d), "")), 0);
        return { on() {} };
      }
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
  delete globalThis.__cdbCuElectronDisplayId; delete globalThis.__cdbCuGlowOff;
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
const GLOW_SET_RE = /function ([\w$]+)\(([\w$]+)\)\{([\w$]+)=\2\?\?null,([\w$]+)&&!\4\.isDestroyed\(\)&&\4\.setBounds\(([\w$]+)\(\)\.bounds\)\}/;
const TEACH_SET_RE = /function ([\w$]+)\(([\w$]+)\)\{([\w$]+)=\2\?\?null;let ([\w$]+)=([\w$]+)\(\);\4&&\4\.setBounds\(([\w$]+)\(\)\.workArea\)\}/;
const GLOW_RE = /function ([\w$]+)\(([\w$]+)\)\{if\(!([\w$]+)\)return Promise\.resolve\(\);([\w$]+)&&=\(clearTimeout\(\4\),null\);let [\w$]+=\+\+[\w$]+;([\w$]+)\(!0\);/;
const GLOW_PATCHED_RE = /function ([\w$]+)\(([\w$]+)\)\{if\(!([\w$]+)\|\|process\.platform==="linux"&&globalThis\.__cdbCuGlowOff\?\.\(\)===!0\)return Promise\.resolve\(\);([\w$]+)&&=\(clearTimeout\(\4\),null\);let [\w$]+=\+\+[\w$]+;([\w$]+)\(!0\);/;
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
    const [, glowSet, , , , glowGet] = GLOW_SET_RE.exec(blob) || [];
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
