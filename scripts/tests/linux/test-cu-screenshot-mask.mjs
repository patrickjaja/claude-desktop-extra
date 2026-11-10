#!/usr/bin/env node
// Computer Use allowlist mask (screenshot filtering) in js/cu_linux_executor.js.
//
// Upstream's screenshot path (cloud Cowork, Dispatch) calls
// resolvePrepareCapture({allowedBundleIds}), screenshot({allowedBundleIds})
// and zoom(rect, allowedBundleIds, displayId, scale) with the granted apps.
// On a bridge that can mask (x11-bridge `doctor` capabilities.screenshot_mask,
// wlroots-bridge `doctor` screenshot_mask on sway / Hyprland) the executor
// keeps only those apps' windows (--keep-window <id>..., or --mask-all when
// none is on screen) and never Claude's own; everything else is painted over.
// Mask mode fails closed: no other capture tier, no unmasked image.
//
// Covered, with the real JSON shapes of both bridges (x11-bridge measured on
// the maintainer's XFCE 3-monitor desktop, wlroots-bridge src/mask.rs):
//   [A] capabilitiesNow / capabilities.screenshotFiltering per backend
//   [B] x11-bridge mask flags, --mask-all, Claude never kept, hidden list,
//       legacy undefined path unchanged, zoom argument order + coordinates
//   [C] fail closed: bridge exit 1, exit 2 (old bridge), no mask report,
//       doctor failure; never desktopCapturer / spectacle / an unmasked zoom
//   [D] wlroots-bridge mask + post-capture verification of kept windows
//   [E] wlroots window geometry: display auto-target, output mapping,
//       appUnderPoint hit test by stacking_order
//   [F] listRunningApps keeps apps whose windows are on another workspace
//   [G] background Xvfb display (x11 target on a Wayland desktop)
//   [H] every capture result says what was done (masked / filtering /
//       maskGaps, __lastCapture for the status line); getFrontmostApp tells a
//       failed bridge from nothing focused; the lock release clears the
//       ask-before-control notes
//
// Exit codes follow the repo convention: 0 = PASS, other = FAIL.
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (f) => readFileSync(path.join(ROOT, "js", f), "utf8");

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  PASS " + label); return; }
  fail++; console.error("  FAIL " + label + (extra !== undefined ? "  -> " + extra : ""));
}
async function settle(p) { try { return { v: await p }; } catch (e) { return { e }; } }
console.debug = () => {};

// The grant -> window matcher (js/cu_ax_tools.js) and the display-target
// helper, loaded once like Patch 1 injects them.
const nreq = (id) => ({ child_process: { execFileSync() { throw new Error("no"); } }, fs: { existsSync: () => false }, path, electron: { app: { getPath() { throw new Error("no"); } } } })[id];
new Function("require", "process", read("cu_ax_tools.js"))(nreq, process);
new Function("process", read("cu_display_target.js"))(process);

const R = (x, y, width, height) => ({ x, y, width, height });
const base = { window_role: null, window_type: "normal", is_dock: false, is_desktop: false, is_visible: true, is_minimized: false, is_normal_window: true, is_dialog: false, transient: false, transient_for: null, stacking_order: 0, is_active: false, exclude_from_capture: false, keep_above: false };
// x11-bridge `windows` (live on the maintainer's XFCE desktop, 2026-11-04).
const xw = (id, cls, name, g, extra = {}) => ({ ...base, id: String(id), title: name, geometry: g, pid: 1000 + (id % 1000), desktop_file_name: null, resource_class: cls, resource_name: name, output: null, ...extra });
const X11_WINS = [
  xw(10485826, "Xfdesktop", "xfdesktop", R(0, 0, 5120, 1440), { desktop_file_name: "org.xfce.xfdesktop", is_desktop: true, output: "DP-3-2" }),
  xw(18874372, "com.mitchellh.ghostty", "ghostty", R(1013, 197, 1054, 894), { desktop_file_name: "com.mitchellh.ghostty", output: "DP-3-2" }),
  xw(79691779, "Google-chrome", "google-chrome", R(5120, 0, 1920, 1080), { output: "DP-3-1" }),
  // Claude's own window: same pid as this process.
  xw(37748740, "com.anthropic.Claude", "com.anthropic.claude", R(3715, 104, 1277, 1144), { pid: process.pid, output: "DP-3-2" }),
  xw(12582915, "Xfce4-panel", "xfce4-panel", R(0, 0, 5120, 21), { is_dock: true, output: "DP-3-2" }),
  xw(18874404, "com.mitchellh.ghostty", "ghostty", R(2081, 141, 1414, 1057), { desktop_file_name: "com.mitchellh.ghostty", output: "DP-3-2" }),
  xw(55555555, "Slack", "slack", R(100, 100, 800, 600), { is_minimized: true, is_visible: false }),
  xw(66666666, "Mousepad", "mousepad", R(100, 100, 800, 600), { is_visible: false })
];
const MAINT_SCREENS = [
  { id: "eDP-1", name: "eDP-1", geometry: R(7040, 0, 1920, 1200), scale: 1, is_primary: true },
  { id: "DP-3-1", name: "DP-3-1", geometry: R(5120, 0, 1920, 1080), scale: 1, is_primary: false },
  { id: "DP-3-2", name: "DP-3-2", geometry: R(0, 0, 5120, 1440), scale: 1, is_primary: false }
];
const disp = (id, label, b, sf = 1) => ({ id, label, bounds: b, size: { width: b.width, height: b.height }, workArea: b, scaleFactor: sf, nativeOrigin: { x: b.x, y: b.y } });
const MAINT = Object.assign([disp(1, "Built-in display", R(7040, 0, 1920, 1200)), disp(2, "Acer XB271H", R(5120, 0, 1920, 1080)), disp(3, "C49RG9x", R(0, 0, 5120, 1440))], { primaryIdx: 0 });
// x11-bridge doctor (live, trimmed) and an x11-bridge without the mask flags.
const X11_DOCTOR = { contract: 1, bridge: "x11-bridge", version: "0.1.0", backend: "x11", session_match: true, backend_reachable: true, backend_error: null, session_supported: false, restore_token_present: false, restore_token_path: null, daemon_running: false, session_socket: null, display: ":0", atspi: { bus: true, is_enabled: false, screen_reader: false }, capabilities: { screenshot_mask: true } };
const X11_DOCTOR_OLD = { ...X11_DOCTOR, capabilities: undefined };
// wlroots-bridge doctor on sway / Hyprland / niri (src/doctor.rs).
const wlDoctor = (o) => ({ contract: 1, bridge: "wlroots-bridge", version: "0.2.0", backend: "wlroots", session_match: true, backend_reachable: true, backend_error: null, session_supported: false, restore_token_present: false, restore_token_path: null, daemon_running: false, session_socket: null, window_geometry: false, screenshot_mask: false, screenshot_mask_gaps: [], ...o });
const SWAY_DOCTOR = wlDoctor({ window_geometry: true, screenshot_mask: true, screenshot_mask_gaps: ["popups", "layer_shell_top_overlay", "xwayland_unmanaged"] });
const HYPR_DOCTOR = wlDoctor({ window_geometry: true, screenshot_mask: true, screenshot_mask_gaps: ["popups"] });
const NIRI_DOCTOR = wlDoctor({});

// x11-bridge masked zoom answer: the real `mask` report shape.
function x11MaskReply(args, wins) {
  const keep = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--keep-window") keep.push(args[i + 1]);
  const all = args.includes("--mask-all");
  const masked = wins.filter((w) => !keep.includes(w.id) && w.is_visible !== false).map((w) => ({ id: w.id, frame: String(+w.id + 1), pid: w.pid, desktop_file_name: w.desktop_file_name, resource_class: w.resource_class, resource_name: w.resource_name, override_redirect: false }));
  masked.push({ id: "77777777", frame: "77777777", pid: 4321, desktop_file_name: null, resource_class: "Xfce4-notifyd", resource_name: "xfce4-notifyd", override_redirect: true });
  return { base64: "MASKED", width: 1568, height: 441, mask: { mode: all ? "all" : "keep", fill: "#1E1E1E", kept: keep.filter((k) => wins.some((w) => w.id === k && w.is_visible !== false)), kept_hidden: [], kept_missing: keep.filter((k) => !wins.some((w) => w.id === k && w.is_visible !== false)), auto_kept: [], masked } };
}
// wlroots-bridge masked zoom answer (src/mask.rs MaskReport, camelCase kept).
function wlMaskReply(args, wins, tweak) {
  const keep = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--keep-window") keep.push(args[i + 1]);
  const all = args.includes("--mask-all");
  let kept = keep.map((id) => { const w = wins.find((v) => v.id === id); return { id, appId: w.desktop_file_name, title: w.title, visible: w.is_visible !== false }; });
  if (tweak) kept = tweak(kept);
  return { base64: "WLMASKED", width: 1280, height: 720, mask: { mode: all ? "all" : "keep", kept, regions: kept.length ? [R(0, 0, 100, 100)] : [] } };
}

// session: x11 | sway | hypr | niri | gnome | cosmic | kde-x11
function makeRig({ session = "x11", displays = MAINT, screens = MAINT_SCREENS, windows = X11_WINS, doctor = X11_DOCTOR, zoom, env = {}, target = null, bridges }) {
  const calls = [], diag = [], dc = [], spawned = [];
  const S = {
    x11: { XDG_CURRENT_DESKTOP: "XFCE", XDG_SESSION_TYPE: "x11", DISPLAY: ":0" },
    "kde-x11": { XDG_CURRENT_DESKTOP: "KDE", XDG_SESSION_TYPE: "x11", DISPLAY: ":0" },
    sway: { XDG_CURRENT_DESKTOP: "sway", XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-1", SWAYSOCK: "/run/user/1000/sway.sock" },
    hypr: { XDG_CURRENT_DESKTOP: "Hyprland", XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-1", HYPRLAND_INSTANCE_SIGNATURE: "abc" },
    niri: { XDG_CURRENT_DESKTOP: "niri", XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-1", NIRI_SOCKET: "/run/user/1000/niri.sock" },
    gnome: { XDG_CURRENT_DESKTOP: "ubuntu:GNOME", XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" },
    cosmic: { XDG_CURRENT_DESKTOP: "COSMIC", XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }
  }[session];
  for (const k of ["SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE", "NIRI_SOCKET", "COWORK_SCREENSHOT_CMD", "X11_BRIDGE_BIN", "WLROOTS_BRIDGE_BIN", "GNOME_PORTAL_BRIDGE_BIN", "YDOTOOL_SOCKET", "WAYLAND_DISPLAY", "DISPLAY", "CHROME_DESKTOP"]) delete process.env[k];
  Object.assign(process.env, S, env);
  process.env.PATH = "/usr/bin:/bin";
  const reply = (b, args, opts) => {
    const sub = args[0];
    if (sub === "doctor") { const d = typeof doctor === "function" ? doctor(b) : doctor; if (d instanceof Error) throw d; return JSON.stringify(d); }
    if (sub === "screens") return JSON.stringify(screens);
    if (sub === "windows") return JSON.stringify(typeof windows === "function" ? windows() : windows);
    if (sub === "zoom") {
      if (zoom) { const z = zoom(b, args, opts); if (z instanceof Error) throw z; return JSON.stringify(z); }
      if (args.includes("--keep-window") || args.includes("--mask-all")) return JSON.stringify(b === "x11-bridge" ? x11MaskReply(args, windows) : wlMaskReply(args, windows));
      return JSON.stringify({ base64: "PLAIN", width: 100, height: 50 });
    }
    if (sub === "app-under-point") return "null";
    return "{}";
  };
  const known = new Set(bridges || ["x11-bridge", "wlroots-bridge", "gnome-portal-bridge"]);
  const cp = {
    execFileSync(bin, args, opts) {
      const b = path.basename(String(bin));
      if (b === "systemd-detect-virt") return "none\n";
      spawned.push(b + " " + (args || []).join(" "));
      if (b === "spectacle" || b === "convert") return "";
      if (!known.has(b)) throw new Error("not found: " + b);
      calls.push({ b, args, sync: true, opts });
      return reply(b, args, opts);
    },
    execSync(c) { spawned.push("sh " + c); throw new Error("nope"); },
    spawnSync() { return { status: 1 }; },
    execFile(bin, args, opts, cb) {
      const b = path.basename(String(bin));
      spawned.push(b + " " + args.join(" "));
      if (!known.has(b)) { setTimeout(() => cb(new Error("not found"), "", ""), 0); return; }
      calls.push({ b, args, opts });
      setTimeout(() => { let out; try { out = reply(b, args, opts); } catch (e) { cb(e, "", String(e.message)); return; } cb(null, out, ""); }, 0);
    },
    spawn() { return { on() {}, unref() {} }; }
  };
  const electron = {
    app: { commandLine: { getSwitchValue: () => "" }, getPath: () => "/ud" },
    screen: { getAllDisplays: () => displays, getPrimaryDisplay: () => displays[displays.primaryIdx || 0], getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    desktopCapturer: { getSources: async (o) => { dc.push(o); return []; } },
    clipboard: { readText: () => "", writeText: () => {} },
    nativeImage: {}
  };
  const installed = new Set(["/usr/bin/spectacle", "/usr/bin/convert"]);
  const requireStub = (id) => {
    if (id === "child_process") return cp;
    if (id === "electron") return electron;
    if (id === "path") return path;
    if (id === "os") return os;
    if (id === "fs") return { constants: { X_OK: 1 }, readFileSync: () => Buffer.alloc(0), writeFileSync() {}, unlinkSync() {}, existsSync: () => false, renameSync() {}, accessSync(p) { if (!installed.has(String(p))) throw new Error("ENOENT"); }, readdirSync: () => [], statSync: () => ({ isDirectory: () => false }), readlinkSync() { throw new Error("no"); }, realpathSync: (p) => p, promises: { stat: async () => { throw new Error("ENOENT"); } } };
    throw new Error("unexpected require " + id);
  };
  globalThis.__cdbDiag = (m) => diag.push(String(m));
  delete globalThis.__cuX11BridgeBin; delete globalThis.__cuGnomeBridgeBin; delete globalThis.__cuWlrootsBridgeBin; delete globalThis.__cuTargetRead; delete globalThis.__cuTargetSig; delete globalThis.__cuTargetIdentity; delete globalThis.__cuBridgeFail;
  if (known.has("x11-bridge")) globalThis.__cuX11BridgeBin = "/res/x11-bridge";
  if (known.has("wlroots-bridge")) globalThis.__cuWlrootsBridgeBin = "/res/wlroots-bridge";
  if (known.has("gnome-portal-bridge")) globalThis.__cuGnomeBridgeBin = "/res/gnome-portal-bridge";
  if (target) globalThis.__cuTargetRead = () => target;
  globalThis.__cuKwinMode = false;
  new Function("require", "process", read("cu_linux_executor.js"))(requireStub, process);
  const ex = globalThis.__linuxExecutor;
  const reset = () => { calls.length = 0; diag.length = 0; dc.length = 0; spawned.length = 0; };
  // What executor creation itself started (the doctor warm-up), kept apart.
  const boot = calls.slice();
  reset();
  return { ex, calls, diag, dc, spawned, reset, boot };
}
const zoomArgs = (rig) => rig.calls.filter((c) => c.args[0] === "zoom").map((c) => c.b + " " + c.args.join(" "));
const doctorCalls = (rig) => rig.calls.filter((c) => c.args[0] === "doctor").length;
const exitErr = (code, msg) => { const e = new Error("Command failed\n" + msg); e.code = code; return e; };

// ── [A] capabilities per backend ───────────────────────────────────────────
console.log("\n[A] screenshotFiltering per backend");
{
  const rig = makeRig({});
  ok(rig.boot.filter((c) => c.args[0] === "doctor" && !c.sync).length === 1 && rig.boot.length === 1, "executor creation warms the capture bridge's doctor (one async call, nothing else)", JSON.stringify(rig.boot.map((c) => c.b + " " + c.args.join(" ") + (c.sync ? " (sync)" : ""))));
  ok(rig.ex.capabilitiesNow().screenshotFiltering === "none", "x11 cold: 'none' until the doctor answered (sync, no blocking spawn)");
  ok(!rig.calls.some((c) => c.sync), "x11 cold: no synchronous bridge call");
  const c = await rig.ex.capabilitiesAsync();
  ok(c.screenshotFiltering === "mask" && rig.ex.capabilities.screenshotFiltering === "mask", "x11 doctor capabilities.screenshot_mask -> 'mask' (capabilitiesNow + static capabilities getter)", JSON.stringify(c));
  ok(c.hitTest === "native" && c.windowPositions === true && JSON.stringify(c.screenshotMaskGaps) === "[]", "x11: hitTest native, positions, no mask gaps", JSON.stringify(c));
  ok(rig.ex.capabilities.platform === "linux" && rig.ex.capabilities.hitTest === undefined, "static capabilities keep platform and no hitTest key");
  const n = doctorCalls(rig);
  rig.ex.capabilitiesNow(); await rig.ex.capabilitiesAsync();
  ok(doctorCalls(rig) === n, "doctor is cached (one spawn)", doctorCalls(rig));
  ok(rig.diag.some((m) => /x11-bridge capabilities: screenshot mask yes, window geometry yes/.test(m)), "one diag line names the capabilities", JSON.stringify(rig.diag));
}
for (const [label, opt, want] of [
  ["x11-bridge without the doctor key", { doctor: X11_DOCTOR_OLD }, "none"],
  ["x11-bridge contract 0 (doctor exit 2)", { doctor: () => exitErr(2, "error: unrecognized subcommand 'doctor'") }, "none"],
  ["sway (doctor screenshot_mask)", { session: "sway", doctor: SWAY_DOCTOR, windows: [] }, "mask"],
  ["Hyprland", { session: "hypr", doctor: HYPR_DOCTOR, windows: [] }, "mask"],
  ["niri (no IPC geometry)", { session: "niri", doctor: NIRI_DOCTOR, windows: [] }, "none"],
  ["GNOME (gnome-portal-bridge)", { session: "gnome", doctor: () => { throw new Error("doctor must not be asked"); }, windows: [] }, "none"],
  ["XWayland-only (COSMIC + x11-bridge)", { session: "cosmic" }, "none"],
  ["X11 without x11-bridge (desktopCapturer only)", { bridges: [] }, "none"],
  ["X11 with COWORK_SCREENSHOT_CMD", { env: { COWORK_SCREENSHOT_CMD: "true" } }, "none"]
]) {
  const rig = makeRig(opt);
  const c = await rig.ex.capabilitiesAsync();
  ok(c.screenshotFiltering === want && rig.ex.capabilities.screenshotFiltering === want, label + " -> " + want, JSON.stringify(c));
  if (label.startsWith("GNOME") || label.startsWith("XWayland") || label.startsWith("X11 without")) ok(doctorCalls(rig) === 0, label + ": no doctor spawned", doctorCalls(rig));
}
{
  const rig = makeRig({ session: "sway", doctor: SWAY_DOCTOR, windows: [] });
  const c = await rig.ex.capabilitiesAsync();
  ok(JSON.stringify(c.screenshotMaskGaps) === JSON.stringify(["popups", "layer_shell_top_overlay", "xwayland_unmanaged"]) && c.hitTest === "native" && c.windowPositions === true, "sway: gaps reported, hitTest native, positions", JSON.stringify(c));
  const rn = makeRig({ session: "niri", doctor: NIRI_DOCTOR, windows: [] });
  const cn = await rn.ex.capabilitiesAsync();
  ok(cn.hitTest === "none" && cn.windowPositions === false, "niri: hitTest none, no positions", JSON.stringify(cn));
}

// ── [B] x11-bridge mask flags ──────────────────────────────────────────────
console.log("\n[B] x11-bridge: flags, Claude never kept, hidden list, legacy path");
{
  const rig = makeRig({});
  const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["com.mitchellh.ghostty"], preferredDisplayId: 2, autoResolve: false, doHide: false });
  const z = zoomArgs(rig);
  ok(r.captureError === undefined && r.base64 === "MASKED", "masked image returned", JSON.stringify(r).slice(0, 200));
  ok(z.length === 1 && z[0] === "x11-bridge zoom --x 0 --y 0 --w 5120 --h 1440 --display DP-3-2 --keep-window 18874372 --keep-window 18874404", "one zoom: --display + --keep-window for both ghostty windows", JSON.stringify(z));
  ok(JSON.stringify(r.hidden) === JSON.stringify(["Google-chrome"]), "hidden = masked apps by id: no Claude, no panel/desktop, no allowed app, no unresolvable override-redirect window", JSON.stringify(r.hidden));
  ok(rig.calls.filter((c) => c.args[0] === "windows").length === 1, "one windows call per capture");
}
{
  const rig = makeRig({});
  const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: [], preferredDisplayId: 1 });
  ok(zoomArgs(rig)[0] === "x11-bridge zoom --x 0 --y 0 --w 1920 --h 1080 --display DP-3-1 --mask-all" && r.base64 === "MASKED", "empty allowlist -> --mask-all", JSON.stringify(zoomArgs(rig)));
  rig.reset();
  await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["org.example.NotRunning"], preferredDisplayId: 1 });
  ok(/--mask-all$/.test(zoomArgs(rig)[0] || ""), "allowed app with no window -> --mask-all", JSON.stringify(zoomArgs(rig)));
  rig.reset();
  await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["com.anthropic.Claude", "Google-chrome"], preferredDisplayId: 2 });
  ok(!(zoomArgs(rig)[0] || "").includes("37748740") && (zoomArgs(rig)[0] || "").includes("--keep-window 79691779"), "Claude's own window is never kept, even when granted", JSON.stringify(zoomArgs(rig)));
}
{
  const rig = makeRig({});
  await rig.ex.capabilitiesAsync(); rig.reset();
  const s = await rig.ex.screenshot({ displayId: 1, allowedBundleIds: ["google-chrome"] });
  ok(s.base64 === "MASKED" && zoomArgs(rig)[0] === "x11-bridge zoom --x 0 --y 0 --w 1920 --h 1080 --display DP-3-1 --keep-window 79691779", "screenshot({allowedBundleIds}) masks", JSON.stringify(zoomArgs(rig)));
  rig.reset();
  const s2 = await rig.ex.screenshot({ displayId: 1 });
  ok(s2.base64 === "PLAIN" && zoomArgs(rig)[0] === "x11-bridge zoom --x 0 --y 0 --w 1920 --h 1080 --display DP-3-1" && s2.hidden === undefined, "screenshot without allowedBundleIds: legacy unmasked capture, unchanged", JSON.stringify(zoomArgs(rig)));
  ok(!rig.calls.some((c) => c.args[0] === "windows"), "legacy path asks for no window list");
  rig.reset();
  // Upstream's zoom: rect relative to displayId's origin.
  const z = await rig.ex.zoom({ x: 10, y: 20, w: 300, h: 200 }, ["google-chrome"], 1, 1);
  ok(z.base64 === "MASKED" && zoomArgs(rig)[0] === "x11-bridge zoom --x 10 --y 20 --w 300 --h 200 --display DP-3-1 --keep-window 79691779", "zoom(rect, allowed, displayId, scale): display-relative rect, masked", JSON.stringify(zoomArgs(rig)));
  rig.reset();
  // Our handler: global rect + opts.globalCoords.
  await rig.ex.zoom({ x: 5130, y: 20, w: 300, h: 200 }, ["google-chrome"], 1, void 0, { globalCoords: true });
  ok(zoomArgs(rig)[0] === "x11-bridge zoom --x 10 --y 20 --w 300 --h 200 --display DP-3-1 --keep-window 79691779", "zoom(..., {globalCoords:true}): global rect", JSON.stringify(zoomArgs(rig)));
  rig.reset();
  // The handler's old call (rect, 1, displayId): unmasked, global coordinates, as before.
  const zl = await rig.ex.zoom({ x: 5130, y: 20, w: 300, h: 200 }, 1, 1);
  ok(zl.base64 === "PLAIN" && zoomArgs(rig)[0] === "x11-bridge zoom --x 10 --y 20 --w 300 --h 200 --display DP-3-1", "zoom(rect, 1, displayId) legacy: unmasked, global", JSON.stringify(zoomArgs(rig)));
  rig.reset();
  await rig.ex.zoom({ x: 5130, y: 20, w: 300, h: 200 }, void 0, 1, void 0, { globalCoords: true });
  ok(zoomArgs(rig)[0] === "x11-bridge zoom --x 10 --y 20 --w 300 --h 200 --display DP-3-1", "zoom(rect, undefined, ...): unmasked", JSON.stringify(zoomArgs(rig)));
}
{
  // A backend that cannot mask: allowlist given, capture unmasked (allowed), caller told via capabilitiesNow.
  const rig = makeRig({ doctor: X11_DOCTOR_OLD });
  const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["google-chrome"], preferredDisplayId: 1 });
  ok(r.base64 === "PLAIN" && !/--keep-window|--mask-all/.test(zoomArgs(rig)[0] || "") && rig.ex.capabilitiesNow().screenshotFiltering === "none", "old x11-bridge: unmasked capture, screenshotFiltering none", JSON.stringify(zoomArgs(rig)));
}

// ── [C] fail closed ────────────────────────────────────────────────────────
console.log("\n[C] mask mode fails closed");
for (const [label, z, re] of [
  ["bridge exit 1", (b, a) => (a.includes("--keep-window") || a.includes("--mask-all") ? exitErr(1, "Error: virtual-root window manager refused") : { base64: "PLAIN", width: 1, height: 1 }), /could not hide the apps that are not allowed \(Command failed\nError: virtual-root/],
  ["old bridge: unsupported flag exit 2", (b, a) => (a.includes("--keep-window") || a.includes("--mask-all") ? exitErr(2, "error: unexpected argument '--keep-window' found") : { base64: "PLAIN", width: 1, height: 1 }), /does not take --keep-window \/ --mask-all; update the package/],
  ["result without the mask report", () => ({ base64: "UNMASKED", width: 1, height: 1 }), /carries no mask report/]
]) {
  const rig = makeRig({ session: "kde-x11", zoom: z });
  const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["google-chrome"], preferredDisplayId: 1 });
  ok(r.base64 === "" && re.test(r.captureError || ""), label + ": resolvePrepareCapture -> captureError", r.captureError);
  ok(zoomArgs(rig).length === 1 && rig.dc.length === 0 && !rig.spawned.some((s) => /^spectacle|^convert/.test(s)), label + ": one masked zoom only - no spectacle, no desktopCapturer, no unmasked retry", JSON.stringify(rig.spawned));
  const s = await settle(rig.ex.screenshot({ displayId: 1, allowedBundleIds: ["google-chrome"] }));
  ok(s.e && re.test(s.e.message), label + ": screenshot throws", s.e && s.e.message);
  const zz = await settle(rig.ex.zoom({ x: 0, y: 0, w: 10, h: 10 }, ["google-chrome"], 1));
  ok(zz.e && re.test(zz.e.message) && rig.dc.length === 0, label + ": zoom throws, no fallback", zz.e && zz.e.message);
}
{
  const rig = makeRig({ session: "kde-x11", zoom: () => exitErr(2, "error: unexpected argument") });
  await rig.ex.resolvePrepareCapture({ allowedBundleIds: [], preferredDisplayId: 1 });
  const before = doctorCalls(rig);
  await rig.ex.resolvePrepareCapture({ allowedBundleIds: [], preferredDisplayId: 1 });
  ok(doctorCalls(rig) === before + 1, "exit 2 drops the cached capabilities (doctor asked again)", doctorCalls(rig) + " vs " + before);
}
{
  const rig = makeRig({ doctor: () => exitErr(1, "Error: cannot open display") });
  const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["google-chrome"], preferredDisplayId: 1 });
  ok(/could not check whether x11-bridge can hide/.test(r.captureError || "") && zoomArgs(rig).length === 0 && rig.dc.length === 0, "doctor failure + allowlist: captureError, nothing captured", r.captureError);
  ok(rig.ex.capabilitiesNow().screenshotFiltering === "none", "doctor failure: capabilitiesNow says none");
  // O4: the supported-features path reads the capabilities getter on every
  // build; a doctor that keeps failing must not be re-spawned per read.
  await new Promise((r) => setTimeout(r, 30));
  const n0 = doctorCalls(rig);
  for (let i = 0; i < 5; i++) { rig.ex.capabilitiesNow(); void rig.ex.capabilities.screenshotFiltering; await new Promise((r) => setTimeout(r, 10)); }
  ok(doctorCalls(rig) === n0, "a failed doctor is not asked again by capability reads within 30 s (negative TTL)", doctorCalls(rig) + " vs " + n0);
}
{
  const rig = makeRig({ windows: () => { throw exitErr(1, "windows failed"); } });
  const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["google-chrome"], preferredDisplayId: 1 });
  ok(/window list failed/.test(r.captureError || "") && zoomArgs(rig).length === 0, "window list failure: captureError, no capture", r.captureError);
}
{
  const rig = makeRig({ screens: [] });
  const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["google-chrome"], preferredDisplayId: 1 });
  ok(/no monitor list/.test(r.captureError || "") && zoomArgs(rig).length === 0, "no monitor list: never a zoom without --display", r.captureError);
}
{
  // Legacy path keeps its fallback chain: zoom fails -> desktopCapturer is tried.
  const rig = makeRig({ zoom: () => exitErr(1, "capture failed") });
  const s = await settle(rig.ex.screenshot({ displayId: 1 }));
  ok(s.e && rig.dc.length === 1, "legacy (no allowlist): desktopCapturer fallback still runs", JSON.stringify(rig.dc));
}

// ── [D] wlroots-bridge mask + verification ─────────────────────────────────
console.log("\n[D] wlroots-bridge (sway): mask + post-capture verification");
const ww = (id, appId, title, g, extra = {}) => ({ ...base, id: String(id), title, geometry: g, pid: 2000 + id, desktop_file_name: appId, resource_class: appId, resource_name: null, output: "DP-1", ...extra });
const SWAY_DISPLAYS = Object.assign([disp(1, "DP-1", R(0, 0, 1920, 1080)), disp(2, "HDMI-A-1", R(1920, 0, 2560, 1440))], { primaryIdx: 0 });
const SWAY_SCREENS = [{ id: "DP-1", name: "DP-1", geometry: R(0, 0, 1920, 1080), scale: 1, is_primary: true }, { id: "HDMI-A-1", name: "HDMI-A-1", geometry: R(1920, 0, 2560, 1440), scale: 1, is_primary: false }];
const SWAY_WINS = [
  ww(11, "firefox", "Mozilla Firefox", R(0, 0, 960, 1080), { stacking_order: 1 }),
  ww(12, "foot", "foot", R(960, 0, 960, 1080), { stacking_order: 2 }),
  ww(13, "com.anthropic.Claude", "Claude", R(1920, 0, 1280, 1440), { pid: process.pid, output: "HDMI-A-1", stacking_order: 3 }),
  ww(14, "org.gnome.Nautilus", "Files", R(300, 300, 800, 500), { stacking_order: 9, is_active: true }),
  ww(15, "thunderbird", "Inbox", R(0, 0, 1920, 1080), { is_visible: false, stacking_order: 0 })
];
{
  const rig = makeRig({ session: "sway", displays: SWAY_DISPLAYS, screens: SWAY_SCREENS, windows: SWAY_WINS, doctor: SWAY_DOCTOR });
  const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox"], preferredDisplayId: 0 });
  ok(r.base64 === "WLMASKED" && zoomArgs(rig)[0] === "wlroots-bridge zoom --x 0 --y 0 --w 1920 --h 1080 --display DP-1 --keep-window 11", "sway: --display + --keep-window", JSON.stringify(zoomArgs(rig)));
  ok(JSON.stringify(r.hidden) === JSON.stringify(["foot", "org.gnome.Nautilus"]), "sway hidden: visible windows on the captured region, not Claude, not the other-workspace one", JSON.stringify(r.hidden));
  rig.reset();
  const r2 = await rig.ex.resolvePrepareCapture({ allowedBundleIds: [], preferredDisplayId: 1 });
  ok(zoomArgs(rig)[0] === "wlroots-bridge zoom --x 0 --y 0 --w 2560 --h 1440 --display HDMI-A-1 --mask-all" && r2.base64 === "WLMASKED", "sway: empty allowlist -> --mask-all", JSON.stringify(zoomArgs(rig)));
}
for (const [label, tweak, good] of [
  ["title changed (terminal, browser): accepted", (k) => k.map((v) => ({ ...v, title: "Other page - Mozilla Firefox" })), true],
  ["id now names a window of another app: discarded", (k) => k.map((v) => ({ ...v, appId: "foot", title: "foot" })), false],
  ["id now names Claude: discarded", (k) => k.map((v) => ({ ...v, appId: "com.anthropic.Claude", title: "Claude" })), false],
  ["fewer kept entries than asked: discarded", () => [], false],
  ["a kept id that was not asked for: discarded", (k) => k.map((v) => ({ ...v, id: "99" })), false]
]) {
  const rig = makeRig({ session: "sway", displays: SWAY_DISPLAYS, screens: SWAY_SCREENS, windows: SWAY_WINS, doctor: SWAY_DOCTOR, zoom: (b, a) => wlMaskReply(a, SWAY_WINS, tweak) });
  const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox"], preferredDisplayId: 0 });
  if (good) ok(r.captureError === undefined && r.base64 === "WLMASKED", label, r.captureError);
  else ok(r.base64 === "" && /could not hide/.test(r.captureError || "") && rig.dc.length === 0, label, r.captureError);
}
{
  const rig = makeRig({ session: "sway", displays: SWAY_DISPLAYS, screens: SWAY_SCREENS, windows: SWAY_WINS, doctor: SWAY_DOCTOR, zoom: (b, a) => (a.includes("--keep-window") ? exitErr(1, "Error: window `11` shares its app id and title with a window that is not kept") : { base64: "PLAIN", width: 1, height: 1 }) });
  const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox"], preferredDisplayId: 0 });
  ok(/shares its app id and title/.test(r.captureError || "") && zoomArgs(rig).length === 1 && rig.dc.length === 0, "sway: bridge refusal (exit 1) -> captureError, no fallback", r.captureError);
  const rn = makeRig({ session: "niri", displays: SWAY_DISPLAYS, screens: SWAY_SCREENS, windows: SWAY_WINS.map((w) => ({ ...w, geometry: R(0, 0, 0, 0), output: null })), doctor: NIRI_DOCTOR });
  const r3 = await rn.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox"], preferredDisplayId: 0 });
  ok(r3.base64 === "PLAIN" && JSON.stringify(r3.hidden) === "[]" && !/--keep-window|--mask-all/.test(zoomArgs(rn)[0] || ""), "niri: cannot mask -> unmasked capture", JSON.stringify(zoomArgs(rn)));
}

// ── [E] wlroots window geometry ────────────────────────────────────────────
console.log("\n[E] wlroots-bridge window geometry: auto-target, output, hit test");
{
  const wins = [ww(21, "firefox", "Docs", R(2000, 100, 1200, 900), { output: "HDMI-A-1" }), ww(22, "foot", "foot", R(10, 10, 500, 500)), ww(23, "gimp", "GIMP", R(0, 0, 0, 0), { output: "HDMI-A-1" })];
  const rig = makeRig({ session: "sway", displays: SWAY_DISPLAYS, screens: SWAY_SCREENS, windows: wins, doctor: SWAY_DOCTOR });
  const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox"], preferredDisplayId: 0, autoResolve: true });
  ok(r.displayId === 1 && /--display HDMI-A-1/.test(zoomArgs(rig)[0] || ""), "sway: Firefox on HDMI-A-1 -> displayId 1", JSON.stringify([r.displayId, zoomArgs(rig)]));
  const wd = await rig.ex.findWindowDisplays(["firefox", "foot", "gimp", "nope"]);
  ok(JSON.stringify(wd) === JSON.stringify([{ bundleId: "firefox", displayIds: [1] }, { bundleId: "foot", displayIds: [0] }, { bundleId: "gimp", displayIds: [1] }]), "findWindowDisplays: geometry, and output for a window without a rect", JSON.stringify(wd));
  const rn = makeRig({ session: "niri", displays: SWAY_DISPLAYS, screens: SWAY_SCREENS, windows: wins, doctor: NIRI_DOCTOR });
  const r2 = await rn.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox"], preferredDisplayId: 0, autoResolve: true });
  ok(r2.displayId === 0 && rn.diag.some((m) => /kept DP-1 \(wlroots-bridge reports no window positions\)/.test(m)), "niri (no window_geometry): preferred display, says why", JSON.stringify(rn.diag.filter((m) => /auto-target/.test(m))));
}
{
  const rig = makeRig({ session: "sway", displays: SWAY_DISPLAYS, screens: SWAY_SCREENS, windows: SWAY_WINS, doctor: SWAY_DOCTOR });
  const hit = await rig.ex.appUnderPoint(400, 400);
  ok(hit && hit.bundleId === "org.gnome.Nautilus", "hit test: the highest stacking_order at the point (Files over Firefox)", JSON.stringify(hit));
  const hit2 = await rig.ex.appUnderPoint(100, 100);
  ok(hit2 && hit2.bundleId === "firefox", "hit test: other-workspace window (is_visible false) ignored", JSON.stringify(hit2));
  ok((await rig.ex.appUnderPoint(1700, 1070)) && (await rig.ex.appUnderPoint(1700, 1070)).bundleId === "foot", "hit test: foot");
  ok((await rig.ex.appUnderPoint(-50, -50)) === null, "hit test: nothing there -> null");
  const amb = makeRig({ session: "sway", displays: SWAY_DISPLAYS, screens: SWAY_SCREENS, windows: [...SWAY_WINS, ww(30, "foot", "foot", R(0, 0, 0, 0))], doctor: SWAY_DOCTOR });
  ok((await amb.ex.appUnderPoint(400, 400)) === null, "hit test: a visible window without a position -> null (cannot tell)");
  const rn = makeRig({ session: "niri", displays: SWAY_DISPLAYS, screens: SWAY_SCREENS, windows: SWAY_WINS, doctor: NIRI_DOCTOR });
  ok((await rn.ex.appUnderPoint(400, 400)) === null, "niri: no hit test");
}

// ── [F] listRunningApps ────────────────────────────────────────────────────
console.log("\n[F] listRunningApps: other-workspace windows count, minimized do not");
{
  const rig = makeRig({});
  const ids = (await rig.ex.listRunningApps()).map((a) => a.bundleId);
  ok(ids.includes("Mousepad") && !ids.includes("Slack"), "x11: Mousepad (other workspace, unmapped) listed, minimized Slack not", JSON.stringify(ids));
  const rs = makeRig({ session: "sway", displays: SWAY_DISPLAYS, screens: SWAY_SCREENS, windows: [...SWAY_WINS, ww(31, "signal", "Signal", R(0, 0, 10, 10), { is_minimized: true, is_visible: false })], doctor: SWAY_DOCTOR });
  const sids = (await rs.ex.listRunningApps()).map((a) => a.bundleId);
  ok(sids.includes("thunderbird") && !sids.includes("signal"), "sway: thunderbird (other workspace) listed, minimized signal not", JSON.stringify(sids));
}

// ── [G] background display ─────────────────────────────────────────────────
console.log("\n[G] background Xvfb display (x11 target on a sway desktop)");
{
  const TS = [{ id: "screen", name: "screen", geometry: R(0, 0, 1280, 800), scale: 1, is_primary: true }];
  const tw = [xw(4194307, "Xterm", "xterm", R(0, 0, 640, 400)), xw(4194400, "Gedit", "gedit", R(640, 0, 640, 400))];
  const rig = makeRig({ session: "sway", displays: SWAY_DISPLAYS, screens: TS, windows: tw, target: { kind: "x11", display: ":99" } });
  const c = await rig.ex.capabilitiesAsync();
  const dcall = rig.boot.concat(rig.calls).find((x) => x.args[0] === "doctor");
  ok(c.screenshotFiltering === "mask" && dcall && dcall.b === "x11-bridge" && dcall.opts.env && dcall.opts.env.DISPLAY === ":99", "target: x11-bridge doctor on :99 -> mask", JSON.stringify([c.screenshotFiltering, dcall && dcall.b, dcall && dcall.opts.env && dcall.opts.env.DISPLAY]));
  rig.reset();
  const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["xterm"], preferredDisplayId: 0 });
  const z = rig.calls.find((x) => x.args[0] === "zoom");
  ok(r.base64 === "MASKED" && z && z.args.join(" ") === "zoom --x 0 --y 0 --w 1280 --h 800 --display screen --keep-window 4194307" && z.opts.env.DISPLAY === ":99", "target: masked zoom on the target display", JSON.stringify(z && [z.args, z.opts.env && z.opts.env.DISPLAY]));
  ok(JSON.stringify(r.hidden) === JSON.stringify(["Gedit"]), "target: hidden lists the target's other app", JSON.stringify(r.hidden));
  const bad = makeRig({ session: "sway", displays: SWAY_DISPLAYS, screens: TS, windows: tw, target: { kind: "x11", display: ":99" }, zoom: (b, a) => (a.includes("--keep-window") ? exitErr(1, "Error: BadMatch") : { base64: "PLAIN", width: 1, height: 1 }) });
  const r2 = await bad.ex.resolvePrepareCapture({ allowedBundleIds: ["xterm"], preferredDisplayId: 0 });
  ok(r2.base64 === "" && /BadMatch/.test(r2.captureError || "") && bad.dc.length === 0 && !bad.calls.some((x) => x.b === "wlroots-bridge" && x.args[0] === "zoom"), "target: mask failure -> captureError, never the desktop's bridge or desktopCapturer", r2.captureError);
}

// ── [H] what each capture did; frontmost errors; lock release ─────────────
console.log("\n[H] capture results say what was done; frontmost errors; lock release");
{
  const rig = makeRig({});
  ok(typeof rig.ex.__lastCapture === "function" && rig.ex.__lastCapture() === null, "R2: no capture yet: __lastCapture() null");
  const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["google-chrome"], preferredDisplayId: 1 });
  ok(r.masked === true && r.filtering === "mask" && JSON.stringify(r.maskGaps) === "[]", "R2: x11 masked capture: masked true, filtering mask", JSON.stringify([r.masked, r.filtering, r.maskGaps]));
  const s1 = await rig.ex.screenshot({ displayId: 1, allowedBundleIds: ["google-chrome"] });
  ok(s1.masked === true && s1.filtering === "mask", "R2: screenshot({allowedBundleIds}) result: masked", JSON.stringify([s1.masked, s1.filtering]));
  const z1 = await rig.ex.zoom({ x: 5130, y: 20, w: 300, h: 200 }, ["google-chrome"], 1, void 0, { globalCoords: true });
  ok(z1.masked === true && z1.filtering === "mask", "R2: zoom result: masked", JSON.stringify([z1.masked, z1.filtering]));
  const lc = rig.ex.__lastCapture ? rig.ex.__lastCapture() : null;
  ok(lc && lc.filtering === "mask", "R2: __lastCapture after a masked capture: mask", JSON.stringify(lc));
  const s2 = await rig.ex.screenshot({ displayId: 1 });
  ok(s2.masked === false && s2.filtering === "none" && (rig.ex.__lastCapture() || {}).filtering === "mask", "R2: legacy capture: masked false, and it does not overwrite __lastCapture", JSON.stringify([s2.masked, s2.filtering]));
}
{
  // cannot mask (old bridge): the allowlist is honored by saying so
  const rig = makeRig({ doctor: X11_DOCTOR_OLD });
  const s = await rig.ex.screenshot({ displayId: 1, allowedBundleIds: ["google-chrome"] });
  ok(s.base64 === "PLAIN" && s.masked === false && s.filtering === "none" && (rig.ex.__lastCapture ? rig.ex.__lastCapture() : {}).filtering === "none",
    "R2: a bridge that cannot mask: unmasked, and the result + __lastCapture say none", JSON.stringify([s.masked, s.filtering]));
}
{
  // the doctor failed: screenshot and zoom with an allowlist refuse (never unmasked)
  const rig = makeRig({ doctor: () => exitErr(1, "Error: cannot open display") });
  const s = await settle(rig.ex.screenshot({ displayId: 1, allowedBundleIds: ["google-chrome"] }));
  const z = await settle(rig.ex.zoom({ x: 0, y: 0, w: 10, h: 10 }, ["google-chrome"], 1));
  ok(s.e && /could not check whether x11-bridge can hide/.test(s.e.message) && z.e && /could not check/.test(z.e.message) && zoomArgs(rig).length === 0 && rig.dc.length === 0,
    "R2: doctor failure: screenshot and zoom throw, nothing captured", (s.e && s.e.message) + " | " + (z.e && z.e.message));
}
{
  const rig = makeRig({ session: "sway", displays: SWAY_DISPLAYS, screens: SWAY_SCREENS, windows: SWAY_WINS, doctor: SWAY_DOCTOR });
  const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox"], preferredDisplayId: 0 });
  ok(r.masked === true && JSON.stringify(r.maskGaps) === JSON.stringify(["popups", "layer_shell_top_overlay", "xwayland_unmanaged"]) && JSON.stringify((rig.ex.__lastCapture ? rig.ex.__lastCapture() : {}).gaps) === JSON.stringify(["popups", "layer_shell_top_overlay", "xwayland_unmanaged"]),
    "O3: sway: the result and __lastCapture carry the mask gaps", JSON.stringify(r.maskGaps));
}
{
  // R5: a failed window list is not "nothing focused"
  const rig = makeRig({ windows: () => { throw exitErr(1, "Error: cannot open display :0"); } });
  const f = await settle(rig.ex.getFrontmostApp());
  ok(f.e && f.e.__cdbFront === true && /x11-bridge/.test(f.e.message), "R5: x11 windows failure: getFrontmostApp rejects (__cdbFront)", f.e ? f.e.message : JSON.stringify(f.v));
  const rs = makeRig({ session: "sway", displays: SWAY_DISPLAYS, screens: SWAY_SCREENS, windows: () => { throw exitErr(1, "Error: compositor gone"); }, doctor: SWAY_DOCTOR });
  const fs2 = await settle(rs.ex.getFrontmostApp());
  ok(fs2.e && fs2.e.__cdbFront === true, "R5: wlroots windows failure: rejects", fs2.e ? fs2.e.message : JSON.stringify(fs2.v));
  const rn = makeRig({ session: "sway", displays: SWAY_DISPLAYS, screens: SWAY_SCREENS, windows: SWAY_WINS.map((w) => ({ ...w, is_active: false })), doctor: SWAY_DOCTOR });
  const fn = await settle(rn.ex.getFrontmostApp());
  ok(!fn.e && fn.v === null, "R5: nothing focused: null (no error)", fn.e ? fn.e.message : JSON.stringify(fn.v));
  const ra = makeRig({ session: "sway", displays: SWAY_DISPLAYS, screens: SWAY_SCREENS, windows: SWAY_WINS, doctor: SWAY_DOCTOR });
  ok(((await ra.ex.getFrontmostApp()) || {}).bundleId === "org.gnome.Nautilus", "R5: the focused window still answers");
}
{
  // the lock release clears the per-session notes of js/cu_consent.js
  const rig = makeRig({});
  let n = 0;
  globalThis.__cdbCuConsent = { lockReleased() { n++; } };
  await rig.ex.__setLockHeld(true, "s1");
  await rig.ex.__setLockHeld(false);
  delete globalThis.__cdbCuConsent;
  ok(n === 1, "lock release calls __cdbCuConsent.lockReleased once (not on acquire)", n);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
