#!/usr/bin/env node
// Computer Use display auto-target on Linux (js/cu_display_target.js).
//
// Upstream's screenshot handler (cloud Cowork, Dispatch, kwin mode) calls the
// executor's resolvePrepareCapture({allowedBundleIds, preferredDisplayId,
// autoResolve}) and keeps the displayId it returns; request_access asks
// findWindowDisplays(bundleIds) for a per-app monitor note. Both used to ignore
// the granted apps on Linux, so a cloud task granted Chrome on a side monitor
// got a screenshot of the primary one.
//
// Covered here, with each bridge's real `windows` JSON shape:
//   [A] the bridge-agnostic helper (pick / windowDisplays) on normalized data
//   [B] js/cu_linux_executor.js + x11-bridge: the maintainer's 3-monitor XFCE
//       layout, autoResolve off, two monitors, minimized / other-workspace
//       windows, unknown app, HiDPI (root pixels vs DIP), offset origins
//   [C] js/cu_linux_executor.js on wlroots / GNOME / native-Wayland Electron:
//       no window positions -> preferred display, nothing guessed
//   [D] js/executor_linux.js (kwin mode) + kwin-portal-bridge: logical
//       coordinates, fractional scale, negative origin, output-only windows
// Background display (#300): scripts/tests/linux/test-cu-target-session.mjs.
//
// Exit codes follow the repo convention: 0 = PASS, other = FAIL.
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import util from "node:util";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (f) => readFileSync(path.join(ROOT, "js", f), "utf8");

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  PASS " + label); return; }
  fail++; console.error("  FAIL " + label + (extra !== undefined ? "  -> " + extra : ""));
}
console.debug = () => {};

// The shared runtime: the grant -> window matcher (js/cu_ax_tools.js) and the
// display-target helper, loaded once like Patch 1 injects them.
const nreq = (id) => ({ child_process: { execFileSync() { throw new Error("no"); } }, fs: { existsSync: () => false }, path, electron: { app: { getPath() { throw new Error("no"); } } } })[id];
new Function("require", "process", read("cu_ax_tools.js"))(nreq, process);
new Function("process", read("cu_display_target.js"))(process);
const DT = globalThis.__cdbCuDisplayTarget;
ok(typeof globalThis.__cdbCuWindowOwns === "function" && DT && typeof DT.pick === "function", "runtime: matcher + helper defined");

// ── window shapes, per bridge ──────────────────────────────────────────────
const R = (x, y, width, height) => ({ x, y, width, height });
const base = { pid: 1, window_role: null, window_type: "normal", is_dock: false, is_desktop: false, is_visible: true, is_minimized: false, is_normal_window: true, is_dialog: false, transient: false, transient_for: null, stacking_order: 0, is_active: false, exclude_from_capture: false, keep_above: false };
// x11-bridge (src/wm.rs windows()): root-pixel geometry, WM_CLASS, the RandR
// monitor holding the centre as output, viewable map state as is_visible.
const x11Win = (cls, name, g, extra = {}) => ({ ...base, id: String(Math.random()).slice(2, 9), title: name + " window", geometry: g, desktop_file_name: null, resource_class: cls, resource_name: name, output: null, ...extra });
// wlroots-bridge (src/wm.rs to_window_info): app_id only, geometry all zero.
const wlrWin = (appId, extra = {}) => ({ ...base, id: "7", title: appId, geometry: R(0, 0, 0, 0), desktop_file_name: appId, resource_class: appId, resource_name: null, output: null, ...extra });
// gnome-portal-bridge (src/windows.rs window_from_props): size only, x/y 0.
const gnomeWin = (appId, w, h, extra = {}) => ({ ...base, id: "9", title: appId, geometry: R(0, 0, w, h), desktop_file_name: appId + ".desktop", resource_class: appId, resource_name: appId, output: null, ...extra });
// kwin-portal-bridge (src/kwin.rs SCRIPT_WINDOWS): KWin logical frameGeometry, output name.
const kwinWin = (dfn, cls, g, output, extra = {}) => ({ ...base, id: "{" + dfn + "}", title: dfn, geometry: g, desktop_file_name: dfn, resource_class: cls, resource_name: cls, output, ...extra });

// ── [A] helper ─────────────────────────────────────────────────────────────
console.log("\n[A] bridge-agnostic helper");
{
  const mons = [{ displayId: 0, label: "P", isPrimary: true, rect: R(0, 0, 1920, 1080) }, { displayId: 1, label: "S", rect: R(1920, 0, 1920, 1080) }, { displayId: 2, label: "T", rect: R(3840, 0, 1920, 1080) }];
  const w = (bundleId, rect, extra = {}) => ({ bundleId, rect, minimized: false, ...extra });
  ok(DT.pick([w("a", R(2000, 10, 800, 600))], mons, ["a"], 0).displayId === 1, "single window -> its display");
  ok(DT.pick([w("a", R(1500, 0, 1000, 500))], mons, ["a"], 0).displayId === 1, "window across two displays -> the larger part (580 vs 420 px wide)");
  ok(DT.pick([w("a", R(100, 0, 400, 400)), w("b", R(4000, 0, 1000, 1000))], mons, ["a", "b"], 0).displayId === 2, "two apps -> most total area");
  const tie = [w("a", R(100, 0, 500, 500)), w("a", R(2000, 0, 500, 500))];
  ok(DT.pick(tie, mons, ["a"], 1).displayId === 1 && DT.pick(tie, mons, ["a"], 1).why === "tie", "tie -> preferred when tied");
  ok(DT.pick(tie, mons, ["a"], 2).displayId === 0, "tie, preferred not tied -> primary");
  const tie2 = [w("a", R(2000, 0, 500, 500)), w("a", R(4000, 0, 500, 500))];
  ok(DT.pick(tie2, mons, ["a"], 0).displayId === 1, "tie, neither preferred nor primary -> first in display order");
  ok(DT.pick([w("a", R(2000, 0, 500, 500), { minimized: true })], mons, ["a"], 0).displayId === null, "minimized only -> nothing");
  ok(DT.pick([w("x", R(2000, 0, 500, 500))], mons, ["a"], 0).displayId === null, "other app's window -> nothing");
  ok(DT.pick([w("a", null)], mons, ["a"], 0).displayId === null, "no rect, no output -> nothing (never guessed)");
  ok(DT.pick([w("a", null, { displayId: 2 })], mons, ["a"], 0).displayId === 2, "no rect but a known output -> that display");
  ok(DT.pick([w("a", R(-5000, 0, 100, 100))], mons, ["a"], 0).displayId === null, "window off every display -> nothing");
  ok(DT.pick([w("a", R(2000, 0, 500, 500))], [mons[0]], ["a"], 0).why === "only one display", "one display -> nothing to choose");
  ok(DT.pick([w("a", R(2000, 0, 500, 500))], mons, [], 0).displayId === null, "no granted apps -> nothing");
  const wd = DT.windowDisplays([w("a", R(2000, 0, 300, 300)), w("a", R(3900, 0, 1000, 1000)), w("b", R(100, 100, 50, 50)), w("c", null)], mons, ["a", "b", "c", "d"]);
  ok(JSON.stringify(wd) === JSON.stringify([{ bundleId: "a", displayIds: [2, 1] }, { bundleId: "b", displayIds: [0] }]), "windowDisplays: [{bundleId, displayIds}] largest first, unlocated apps left out", JSON.stringify(wd));
  const wd2 = DT.windowDisplays([w("a", R(1500, 0, 1000, 500))], mons, ["a"]);
  ok(JSON.stringify(wd2) === JSON.stringify([{ bundleId: "a", displayIds: [1] }]), "windowDisplays: a window counts only on the display holding most of it", JSON.stringify(wd2));
  ok(globalThis.__cdbCuWindowOwns("google-chrome", x11Win("Google-chrome", "google-chrome", R(0, 0, 1, 1))), "matcher: desktop id google-chrome owns WM_CLASS Google-chrome");
  ok(globalThis.__cdbCuWindowOwns("Google-chrome", x11Win("Google-chrome", "google-chrome", R(0, 0, 1, 1))), "matcher: running-app id Google-chrome owns it too");
  ok(!globalThis.__cdbCuWindowOwns("org.evil.chrome", kwinWin("org.chromium.Chromium", "chromium", R(0, 0, 1, 1), "DP-1")), "matcher: a reverse-DNS grant matches only exactly");
  ok(!globalThis.__cdbCuWindowOwns("firefox", x11Win("Google-chrome", "google-chrome", R(0, 0, 1, 1))), "matcher: other app -> no");
}

// ── regular executor rig (js/cu_linux_executor.js) ─────────────────────────
// displays: Electron Display objects; screens: x11-bridge `screens`;
// windows: the bridge `windows` answer; session x11 | wayland; desktop.
function makeRig({ displays, screens = [], windows = [], session = "x11", desktop = "XFCE", ozone = "", bridges = {} }) {
  const calls = [], diag = [];
  const reply = (bin, args) => {
    const sub = args[0];
    if (sub === "screens") return JSON.stringify(screens);
    if (sub === "windows") return JSON.stringify(windows);
    if (sub === "zoom" || sub === "screenshot") return JSON.stringify({ base64: "AA", width: 100, height: 50 });
    return "{}";
  };
  const known = new Set(["x11-bridge", "wlroots-bridge", "gnome-portal-bridge"]);
  const cp = {
    execFileSync(bin, args) { const b = path.basename(String(bin)); if (!known.has(b)) throw new Error("not found"); calls.push(b + " " + args.join(" ")); return reply(b, args); },
    execSync() { throw new Error("nope"); },
    spawnSync() { return { status: 1 }; },
    execFile(bin, args, opts, cb) {
      const b = path.basename(String(bin));
      if (!known.has(b)) { setTimeout(() => cb(new Error("not found"), "", ""), 0); return; }
      calls.push(b + " " + args.join(" "));
      setTimeout(() => cb(null, reply(b, args), ""), 0);
    },
    spawn() { return { on() {}, unref() {} }; }
  };
  const electron = {
    app: { commandLine: { getSwitchValue: (k) => (k === "ozone-platform" ? ozone : "") }, getPath: () => "/ud" },
    screen: { getAllDisplays: () => displays, getPrimaryDisplay: () => displays[displays.primaryIdx || 0], getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    desktopCapturer: { getSources: async () => [] },
    clipboard: { readText: () => "", writeText: () => {} },
    nativeImage: {}
  };
  const requireStub = (id) => {
    if (id === "child_process") return cp;
    if (id === "electron") return electron;
    if (id === "path") return path;
    if (id === "os") return os;
    if (id === "fs") return { readFileSync: () => Buffer.alloc(0), writeFileSync() {}, unlinkSync() {}, existsSync: () => false, renameSync() {}, accessSync() { throw new Error("no"); }, readdirSync: () => [], statSync: () => ({ isDirectory: () => false }), promises: { stat: async () => { throw new Error("ENOENT"); } } };
    throw new Error("unexpected require " + id);
  };
  globalThis.__cdbDiag = (m) => diag.push(String(m));
  globalThis.__cuX11BridgeBin = "/res/x11-bridge";
  delete globalThis.__cuGnomeBridgeBin; delete globalThis.__cuWlrootsBridgeBin; delete globalThis.__cuTargetRead;
  if (bridges.wlroots) globalThis.__cuWlrootsBridgeBin = "/res/wlroots-bridge";
  if (bridges.gnome) globalThis.__cuGnomeBridgeBin = "/res/gnome-portal-bridge";
  globalThis.__cuKwinMode = false;
  process.env.XDG_CURRENT_DESKTOP = desktop;
  process.env.XDG_SESSION_TYPE = session;
  if (session === "wayland") process.env.WAYLAND_DISPLAY = "wayland-0"; else delete process.env.WAYLAND_DISPLAY;
  for (const k of ["SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE", "NIRI_SOCKET", "COWORK_SCREENSHOT_CMD", "X11_BRIDGE_BIN", "YDOTOOL_SOCKET"]) delete process.env[k];
  if (desktop === "sway") process.env.SWAYSOCK = "/run/user/1000/sway.sock";
  new Function("require", "process", read("cu_linux_executor.js"))(requireStub, process);
  const ex = globalThis.__linuxExecutor;
  diag.length = 0; calls.length = 0;
  return { ex, calls, diag };
}
const d = (id, label, b, sf = 1, no = { x: b.x, y: b.y }) => ({ id, label, bounds: b, size: { width: b.width, height: b.height }, workArea: b, scaleFactor: sf, nativeOrigin: no });
const zooms = (rig) => rig.calls.filter((c) => / zoom /.test(" " + c.split(" ").slice(1).join(" ") + " ") || c.includes(" zoom ")).map((c) => c.replace(/^\S+ /, ""));
const autoLine = (rig) => rig.diag.filter((m) => m.includes("display auto-target")).join(" | ");

// The maintainer's XFCE layout (xrandr --listmonitors): eDP-1 1920x1200+7040+0
// (primary), DP-3-1 1920x1080+5120+0, DP-3-2 5120x1440+0+0, in Electron's order.
const MAINT = Object.assign([
  d(1, "Built-in display", R(7040, 0, 1920, 1200)),
  d(2, "Acer XB271H", R(5120, 0, 1920, 1080)),
  d(3, "C49RG9x", R(0, 0, 5120, 1440))
], { primaryIdx: 0 });
const MAINT_SCREENS = [
  { id: "eDP-1", name: "eDP-1", geometry: R(7040, 0, 1920, 1200), scale: 1, is_primary: true },
  { id: "DP-3-1", name: "DP-3-1", geometry: R(5120, 0, 1920, 1080), scale: 1, is_primary: false },
  { id: "DP-3-2", name: "DP-3-2", geometry: R(0, 0, 5120, 1440), scale: 1, is_primary: false }
];
const chrome = (g, extra) => x11Win("Google-chrome", "google-chrome", g, extra);

console.log("\n[B1] maintainer's 3 monitors, Chrome on DP-3-1 (wmctrl: 5120,0 1920x1080)");
{
  const rig = makeRig({ displays: MAINT, screens: MAINT_SCREENS, windows: [chrome(R(5120, 0, 1920, 1080), { output: "DP-3-1" }), x11Win("Xfce4-terminal", "xfce4-terminal", R(7100, 50, 800, 600), { output: "eDP-1" })] });
  const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["google-chrome"], preferredDisplayId: undefined, autoResolve: true, doHide: false });
  ok(r.displayId === 1, "displayId 1 (Acer XB271H = DP-3-1)", r.displayId);
  ok(r.originX === 5120 && r.displayWidth === 1920 && r.displayHeight === 1080, "captured geometry is DP-3-1's", JSON.stringify([r.originX, r.displayWidth, r.displayHeight]));
  ok(zooms(rig).some((z) => z === "zoom --x 0 --y 0 --w 1920 --h 1080 --display DP-3-1"), "x11-bridge zoom crops DP-3-1", JSON.stringify(rig.calls));
  ok(/apps=google-chrome -> Acer XB271H \(preferred Built-in display\)/.test(autoLine(rig)), "one diag line names the pick and the preferred display", autoLine(rig));
  const wd = await rig.ex.findWindowDisplays(["google-chrome", "xfce4-terminal", "firefox"]);
  ok(JSON.stringify(wd) === JSON.stringify([{ bundleId: "google-chrome", displayIds: [1] }, { bundleId: "xfce4-terminal", displayIds: [0] }]), "findWindowDisplays shape [{bundleId, displayIds}], unknown app left out", JSON.stringify(wd));
}

console.log("\n[B2] autoResolve false (model pinned / apps unchanged): preferred display, no window list");
{
  const rig = makeRig({ displays: MAINT, screens: MAINT_SCREENS, windows: [chrome(R(5120, 0, 1920, 1080))] });
  const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["google-chrome"], preferredDisplayId: 2, autoResolve: false, doHide: false });
  ok(r.displayId === 2, "displayId stays 2", r.displayId);
  ok(!rig.calls.some((c) => / windows/.test(c)), "the window list is not asked for", JSON.stringify(rig.calls));
  ok(autoLine(rig) === "", "no auto-target line", autoLine(rig));
  const r2 = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["google-chrome"], autoResolve: false, doHide: false });
  ok(r2.displayId === 0, "no preferred -> primary, as before", r2.displayId);
}

console.log("\n[B3] app with windows on two monitors -> the larger area");
{
  const rig = makeRig({ displays: MAINT, screens: MAINT_SCREENS, windows: [chrome(R(7040, 0, 800, 600)), chrome(R(100, 100, 3000, 1200))] });
  const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["google-chrome"], preferredDisplayId: 0, autoResolve: true, doHide: false });
  ok(r.displayId === 2, "displayId 2 (C49RG9x)", r.displayId);
  const wd = await rig.ex.findWindowDisplays(["google-chrome"]);
  ok(JSON.stringify(wd) === JSON.stringify([{ bundleId: "google-chrome", displayIds: [2, 0] }]), "findWindowDisplays lists both, larger first", JSON.stringify(wd));
}

console.log("\n[B4] no windows / unknown app -> preferred");
for (const [label, wins, apps] of [["no windows at all", [], ["google-chrome"]], ["granted app has no window", [x11Win("Mousepad", "mousepad", R(5200, 0, 500, 500))], ["google-chrome"]], ["unknown app id", [chrome(R(5120, 0, 1920, 1080))], ["org.example.Nope"]]]) {
  const rig = makeRig({ displays: MAINT, screens: MAINT_SCREENS, windows: wins });
  const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: apps, preferredDisplayId: 2, autoResolve: true, doHide: false });
  ok(r.displayId === 2 && /kept C49RG9x \(no visible window of the granted apps with a known position\)/.test(autoLine(rig)), label + ": keeps C49RG9x and says why", r.displayId + " " + autoLine(rig));
}

console.log("\n[B5] minimized / other-workspace windows are ignored");
{
  // x11-bridge: _NET_WM_STATE_HIDDEN -> is_minimized true, is_visible false;
  // a window on another workspace is unmapped -> is_visible false.
  const rig = makeRig({ displays: MAINT, screens: MAINT_SCREENS, windows: [chrome(R(0, 0, 5120, 1440), { is_minimized: true, is_visible: false }), chrome(R(0, 0, 5120, 1440), { is_visible: false }), chrome(R(5200, 100, 400, 300))] });
  const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["google-chrome"], preferredDisplayId: 0, autoResolve: true, doHide: false });
  ok(r.displayId === 1, "the small visible window on DP-3-1 wins over hidden full-screen ones", r.displayId);
  const rig2 = makeRig({ displays: MAINT, screens: MAINT_SCREENS, windows: [chrome(R(5120, 0, 1920, 1080), { is_minimized: true, is_visible: false })] });
  const r2 = await rig2.ex.resolvePrepareCapture({ allowedBundleIds: ["google-chrome"], preferredDisplayId: 0, autoResolve: true, doHide: false });
  ok(r2.displayId === 0, "minimized only -> preferred", r2.displayId);
}

console.log("\n[B6] X11 HiDPI: window geometry is root pixels, displays map through nativeOrigin");
{
  // RandR: DP-1 2560x1440 at 0,0 scale 2 (DIP 1280x720), HDMI-1 1920x1080 at
  // 2560,0 scale 1 (Chromium places it at DIP 1280,0).
  const displays = Object.assign([d(1, "DP-1", R(0, 0, 1280, 720), 2, { x: 0, y: 0 }), d(2, "HDMI-1", R(1280, 0, 1920, 1080), 1, { x: 2560, y: 0 })], { primaryIdx: 0 });
  const screens = [{ id: "DP-1", name: "DP-1", geometry: R(0, 0, 2560, 1440), scale: 1, is_primary: true }, { id: "HDMI-1", name: "HDMI-1", geometry: R(2560, 0, 1920, 1080), scale: 1 }];
  // At root px 1400 the window is on DP-1; read as DIP it would be HDMI-1.
  const rig = makeRig({ displays, screens, windows: [chrome(R(1400, 100, 900, 600))] });
  const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["google-chrome"], preferredDisplayId: 1, autoResolve: true, doHide: false });
  ok(r.displayId === 0, "root px 1400,100 -> DP-1 (not HDMI-1)", r.displayId);
  const rig2 = makeRig({ displays, screens, windows: [chrome(R(2600, 100, 900, 600))] });
  const r2 = await rig2.ex.resolvePrepareCapture({ allowedBundleIds: ["google-chrome"], preferredDisplayId: 0, autoResolve: true, doHide: false });
  ok(r2.displayId === 1, "root px 2600,100 -> HDMI-1", r2.displayId);
}

console.log("\n[B7] offset / negative X origins (monitor left of the primary)");
{
  const displays = Object.assign([d(1, "LEFT", R(-1920, 200, 1920, 1080)), d(2, "MAIN", R(0, 0, 2560, 1440))], { primaryIdx: 1 });
  const screens = [{ id: "LEFT", name: "LEFT", geometry: R(-1920, 200, 1920, 1080), scale: 1 }, { id: "MAIN", name: "MAIN", geometry: R(0, 0, 2560, 1440), scale: 1, is_primary: true }];
  const rig = makeRig({ displays, screens, windows: [chrome(R(-1800, 300, 1200, 800))] });
  const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["google-chrome"], autoResolve: true, doHide: false });
  ok(r.displayId === 0 && r.originX === -1920, "window at -1800,300 -> LEFT", JSON.stringify([r.displayId, r.originX]));
}

console.log("\n[C] sessions whose bridge reports no window positions: preferred display, nothing guessed");
{
  const DUAL = Object.assign([d(1, "A", R(0, 0, 1920, 1080)), d(2, "B", R(1920, 0, 1920, 1080))], { primaryIdx: 0 });
  // wlroots (sway): foreign-toplevel windows have geometry {0,0,0,0}.
  const rw = makeRig({ displays: DUAL, windows: [wlrWin("google-chrome")], session: "wayland", desktop: "sway", bridges: { wlroots: true } });
  const r = await rw.ex.resolvePrepareCapture({ allowedBundleIds: ["google-chrome"], preferredDisplayId: 1, autoResolve: true, doHide: false });
  ok(r.displayId === 1 && /kept B \(wlroots-bridge reports no window positions\)/.test(autoLine(rw)), "wlroots: keeps B and says why", r.displayId + " " + autoLine(rw));
  ok(JSON.stringify(await rw.ex.findWindowDisplays(["google-chrome"])) === "[]", "wlroots: findWindowDisplays []");
  ok(!rw.calls.some((c) => / windows$/.test(c)), "wlroots: the window list is not asked for", JSON.stringify(rw.calls));
  // GNOME: Introspect gives width/height only (x/y always 0) - must not read as "at the origin".
  const rg = makeRig({ displays: DUAL, windows: [gnomeWin("google-chrome", 1200, 800)], session: "wayland", desktop: "GNOME", bridges: { gnome: true } });
  ok(JSON.stringify(await rg.ex.findWindowDisplays(["google-chrome"])) === "[]", "GNOME: findWindowDisplays [] (size-only geometry ignored)");
  ok(!rg.calls.some((c) => / windows$/.test(c)), "GNOME: no Introspect call for it", JSON.stringify(rg.calls));
  // Electron on native Wayland with only x11-bridge (uncovered compositor): XWayland root coordinates are not Electron's.
  const rx = makeRig({ displays: DUAL, windows: [chrome(R(1920, 0, 1920, 1080))], session: "wayland", desktop: "COSMIC" });
  const rr = await rx.ex.resolvePrepareCapture({ allowedBundleIds: ["google-chrome"], preferredDisplayId: 0, autoResolve: true, doHide: false });
  ok(rr.displayId === 0 && /kept A \(X window positions cannot be mapped/.test(autoLine(rx)), "native-Wayland Electron + x11-bridge: keeps A", rr.displayId + " " + autoLine(rx));
  // Same compositor, Electron on XWayland (--ozone-platform=x11): Electron's displays are XWayland's -> mapped.
  const rxo = makeRig({ displays: DUAL, windows: [chrome(R(1920, 0, 1920, 1080))], session: "wayland", desktop: "COSMIC", ozone: "x11" });
  const rro = await rxo.ex.resolvePrepareCapture({ allowedBundleIds: ["google-chrome"], preferredDisplayId: 0, autoResolve: true, doHide: false });
  ok(rro.displayId === 1, "Electron on XWayland + x11-bridge: -> B", rro.displayId + " " + autoLine(rxo));
}

// ── [D] kwin mode (js/executor_linux.js + kwin-portal-bridge) ───────────────
function loadKwin({ screens, windows }) {
  const argv = [], diag = [];
  const reply = (sub) => {
    if (sub === "screens") return JSON.stringify(screens);
    if (sub === "windows") return JSON.stringify(windows);
    if (sub === "screenshot") return JSON.stringify({ base64: "AA", width: 100, height: 50 });
    if (sub === "prepare-for-action") return JSON.stringify({ hidden: [], activated: null });
    return "{}";
  };
  const cpStub = {
    execFile(bin, args, opts, cb) { if (typeof opts === "function") cb = opts; argv.push((args || []).join(" ")); setImmediate(() => cb(null, { stdout: reply((args || [])[0]), stderr: "" })); },
    spawnSync() { return { status: 0 }; }
  };
  const src = read("executor_linux.js")
    .replace("import { execFile as execFileCb, spawnSync } from 'node:child_process'", "const { execFile: execFileCb, spawnSync } = __cp")
    .replace("import { screen as electronScreen } from 'electron'", "const electronScreen = { getAllDisplays: () => [], getPrimaryDisplay: () => ({}) }")
    .replace("import { promisify } from 'node:util'", "const { promisify } = __util")
    .replace(/^export /gm, "");
  if (/^import /m.test(src)) throw new Error("executor_linux.js imports changed - update this splice");
  globalThis.__cdbDiag = (m) => diag.push(String(m));
  globalThis.__cuKwinBridgeBin = "/res/kwin-portal-bridge";
  const mod = new Function("__cp", "__util", src + "\nreturn { createLinuxExecutor };")(cpStub, util);
  return { ex: mod.createLinuxExecutor({ hostBundleId: "com.anthropic.claude" }), argv, diag };
}
process.setMaxListeners(50);
console.log("\n[D] kwin mode: KWin logical coordinates, fractional scale, negative origin");
{
  // KWin workspace.screens geometry is logical: a 2560x1440 panel at 1.5 is
  // 1707x960; eDP-1 sits left of it at a negative origin.
  const screens = [
    { id: "DP-1", name: "DP-1", geometry: R(0, 0, 1707, 960), scale: 1.5, is_primary: true, is_active: true },
    { id: "HDMI-A-1", name: "HDMI-A-1", geometry: R(1707, 0, 1920, 1080), scale: 1, is_primary: false, is_active: false },
    { id: "eDP-1", name: "eDP-1", geometry: R(-1280, 200, 1280, 800), scale: 1.25, is_primary: false, is_active: false }
  ];
  const windows = [
    kwinWin("google-chrome", "google-chrome", R(1800, 50, 1200, 800), "HDMI-A-1"),
    // An XWayland window: KWin still reports logical frameGeometry and its output.
    kwinWin("", "Gimp", R(-1200, 300, 1000, 600), "eDP-1", { desktop_file_name: null, resource_class: "Gimp", resource_name: "gimp" }),
    kwinWin("org.kde.dolphin", "dolphin", R(10, 10, 1600, 900), "DP-1", { is_minimized: true }),
    kwinWin("org.kde.dolphin", "dolphin", R(1750, 40, 300, 200), "HDMI-A-1"),
    kwinWin("org.kde.plasmashell", "plasmashell", R(0, 0, 1707, 960), "DP-1", { is_desktop: true })
  ];
  const k = loadKwin({ screens, windows });
  await k.ex.__setLockHeld(true);
  const r = await k.ex.resolvePrepareCapture({ allowedBundleIds: ["google-chrome"], preferredDisplayId: 0, autoResolve: true, doHide: false });
  ok(r.displayId === 1 && k.argv.includes("screenshot --display HDMI-A-1"), "Chrome on HDMI-A-1 -> displayId 1, screenshot --display HDMI-A-1", JSON.stringify([r.displayId, k.argv.filter((a) => a.startsWith("screenshot"))]));
  ok(k.diag.some((m) => /display auto-target: apps=google-chrome -> HDMI-A-1 \(preferred DP-1\)/.test(m)), "kwin: one diag line", JSON.stringify(k.diag.filter((m) => m.includes("auto-target"))));
  const r2 = await k.ex.resolvePrepareCapture({ allowedBundleIds: ["gimp"], preferredDisplayId: 0, autoResolve: true, doHide: true });
  ok(r2.displayId === 2 && k.argv.includes("prepare-for-action --allowed-bundle-id gimp --host-bundle-id com.anthropic.claude --display eDP-1"), "XWayland Gimp at a negative origin -> eDP-1; prepare-for-action targets it too", JSON.stringify([r2.displayId, k.argv.filter((a) => a.startsWith("prepare"))]));
  const r3 = await k.ex.resolvePrepareCapture({ allowedBundleIds: ["org.kde.dolphin"], preferredDisplayId: 0, autoResolve: true, doHide: false });
  ok(r3.displayId === 1, "minimized full-screen Dolphin ignored -> the visible one on HDMI-A-1", r3.displayId);
  const r4 = await k.ex.resolvePrepareCapture({ allowedBundleIds: ["google-chrome"], preferredDisplayId: 2, autoResolve: false, doHide: false });
  ok(r4.displayId === 2, "kwin: autoResolve false -> preferred", r4.displayId);
  const wd = await k.ex.findWindowDisplays(["google-chrome", "gimp", "org.kde.dolphin", "org.kde.plasmashell", "nope"]);
  ok(JSON.stringify(wd) === JSON.stringify([{ bundleId: "google-chrome", displayIds: [1] }, { bundleId: "gimp", displayIds: [2] }, { bundleId: "org.kde.dolphin", displayIds: [1] }]), "kwin findWindowDisplays (desktop window, minimized and unknown left out)", JSON.stringify(wd));
  // A window KWin gives no usable frame for still counts on its output.
  const k2 = loadKwin({ screens, windows: [kwinWin("google-chrome", "google-chrome", R(0, 0, 0, 0), "eDP-1")] });
  await k2.ex.__setLockHeld(true);
  const r5 = await k2.ex.resolvePrepareCapture({ allowedBundleIds: ["google-chrome"], preferredDisplayId: 0, autoResolve: true, doHide: false });
  ok(r5.displayId === 2, "no frame, output eDP-1 -> eDP-1", r5.displayId);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
