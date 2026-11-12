#!/usr/bin/env node
// Computer Use coordinates before any screenshot in this app run.
//
// WHY THIS EXISTS
// ---------------
// The model's coordinates are pixels of the last screenshot it saw. Our tool
// handler (js/cu_handler_injection.js) maps them with globalThis.__cuLastShot,
// which an app restart empties (and switch_display, and a background display
// change). With it empty the handler used to take the coordinates as display
// pixels (identity + origin), so after a restart in the middle of a session
// the first clicks of the next turn landed short wherever the capture
// downscales: Hyprland at scale 1.6, 1920x1080 logical, 1430x804 image: the
// model's 155,626 (a key at 208,841) was clicked at 155,626. Upstream's own
// pixels-mode mapping (kwin mode, cloud sessions, teach mode) divided by the
// scale factor instead, also short.
//
// Both now read the point in the frame the next screenshot of the display
// will have (the executors' __coldFrame: the capture tiers' size rule), and
// refuse a point outside it with upstream's own "Take a screenshot first"
// text. This harness pins:
//   [1] the regular executor's cold frame equals the frame of a real capture
//       of the same display (stub bridges with the bridges' size rule), on
//       X11 at scale 1 / 1.6 / 2, Hyprland at 1.6, a second monitor with a
//       non-zero origin, and the native-size tiers (COWORK_SCREENSHOT_CMD,
//       KDE spectacle; unknown mask answer = no frame);
//   [2] the handler: the observed 155,626 -> 208,841; a small display at
//       scale 1 stays identity; the pinned display after switch_display; a
//       point outside the frame and a frame that cannot be told are refused;
//       cursor_position reads back in the frame; a warm cache is unchanged;
//       the guard runs before every action tool, zoom and cursor_position;
//   [3] the kwin executor's __coldFrame (kwin-portal-bridge's rule);
//   [4] sub-patch 5e on upstream's own mapping, cut from the patched bundle:
//       Linux reads through __coldFrame, out-of-frame gets upstream's text,
//       no __coldFrame / another platform / a prior screenshot = upstream's
//       own result. Needs the extract and the compiled patch, else those
//       cases are skipped (the rest still runs).
//
// CDB_BUNDLE_DIR points at another extract, CDB_CU_PATCH_BIN at another
// compiled patch. The temp dir is removed on exit.
// Exit codes follow the repo convention: 0 = PASS, other = FAIL.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, rmSync, accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import util from "node:util";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EXECUTOR = path.join(ROOT, "js", "cu_linux_executor.js");
const KWIN = path.join(ROOT, "js", "executor_linux.js");
const HANDLER = readFileSync(path.join(ROOT, "js", "cu_handler_injection.js"), "utf8");
const CU_BIN = process.env.CDB_CU_PATCH_BIN || path.join(ROOT, "patches", "linux", "fix_computer_use_linux");
const BUILD_DIR = path.join(process.env.CDB_BUNDLE_DIR || path.join(ROOT, "tmp", "app.asar.contents"), ".vite", "build");

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  PASS " + label + (extra !== undefined ? "  -> " + extra : "")); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + extra : "")); }
}
const J = JSON.stringify;
let scratch = null;
process.on("exit", () => { if (scratch) { try { rmSync(scratch, { recursive: true, force: true }); } catch {} } });

// The bridges' compute_target_dims (x11 / wlroots / gnome / kwin).
function bridgeDims(pw, ph) {
  const s = Math.min(1, 1568 / Math.max(pw, ph), Math.sqrt(1150000 / (pw * ph)));
  return { width: Math.max(1, Math.round(pw * s)), height: Math.max(1, Math.round(ph * s)) };
}

// Brace-balanced cut of `function NAME(` out of src.
function cutFn(src, name) {
  const at = src.indexOf("function " + name + "(");
  if (at < 0) throw new Error("no function " + name);
  const from = src.slice(Math.max(0, at - 6), at) === "async " ? at - 6 : at;
  let depth = 0;
  for (let j = src.indexOf("{", at); j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(from, j + 1);
  }
  throw new Error("unbalanced " + name);
}

// ── the regular executor on stub bridges ───────────────────────────────────
// displays: Electron Display objects (primaryIdx marks the primary);
// screens: the bridge's `screens` answer; host: x11 | hyprland | kde.
function makeRig({ displays, screens = [], host = "x11", env = {}, mask = null }) {
  const diag = [], zooms = [];
  const scaleOf = (name) => { const s = screens.find((x) => x.name === name); return s && s.scale || 1; };
  const reply = (bin, args) => {
    const sub = args[0];
    if (sub === "screens") return J(screens);
    if (sub === "doctor") return J({ contract: 1, screenshot_mask: mask === true, window_geometry: true, backend_reachable: true });
    if (sub === "zoom") {
      const w = +args[args.indexOf("--w") + 1], h = +args[args.indexOf("--h") + 1];
      zooms.push(bin + " " + args.join(" "));
      // x11-bridge gets root pixels; wlroots-bridge a logical region of the
      // named output and captures it at that output's scale.
      const k = /wlroots/.test(bin) ? scaleOf(args[args.indexOf("--display") + 1]) : 1;
      const t = bridgeDims(Math.round(w * k), Math.round(h * k));
      return J({ base64: "AA", width: t.width, height: t.height });
    }
    if (sub === "cursor-position") return J({ x: 1, y: 1 });
    return "{}";
  };
  const bridge = (b) => /-bridge$/.test(path.basename(String(b)));
  const cp = {
    execFileSync(bin, args) { const b = path.basename(String(bin)); if (b === "systemd-detect-virt") return "none\n"; if (b === "spectacle" || b === "convert") return ""; if (!bridge(bin)) throw new Error("not found"); return reply(b, args); },
    execSync() { return ""; },
    spawnSync() { return { status: 1 }; },
    execFile(bin, args, opts, cb) { const c = typeof opts === "function" ? opts : cb; if (!bridge(bin)) { setTimeout(() => c(new Error("not found"), "", ""), 0); return; } setTimeout(() => { let out; try { out = reply(path.basename(String(bin)), args); } catch (e) { c(e, "", ""); return; } c(null, out, ""); }, 0); },
    spawn() { return { on() {}, unref() {}, kill() {} }; }
  };
  const electron = {
    app: { commandLine: { getSwitchValue: () => "" }, getPath: () => os.tmpdir() },
    screen: { getAllDisplays: () => displays, getPrimaryDisplay: () => displays[displays.primaryIdx || 0], getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    desktopCapturer: { getSources: async () => [] },
    clipboard: { readText: () => "", writeText: () => {} },
    nativeImage: {}
  };
  const installed = new Set(["/res/x11-bridge", "/res/wlroots-bridge", ...(host === "kde" ? ["/usr/bin/spectacle", "/usr/bin/convert"] : [])]);
  const fsStub = {
    constants: { X_OK: 1, W_OK: 2 },
    readFileSync: () => Buffer.from("PNG"), writeFileSync() {}, unlinkSync() {}, renameSync() {},
    existsSync: (p) => /claude-cu-spectacle/.test(String(p)),
    accessSync(p) { if (!installed.has(String(p))) throw new Error("ENOENT"); },
    readdirSync: () => [], statSync: () => ({ isDirectory: () => false })
  };
  const req = (id) => ({ child_process: cp, electron, path, os, fs: fsStub })[id] || (() => { throw new Error("unexpected require " + id); })();
  globalThis.__cdbDiag = (m) => diag.push(String(m));
  globalThis.__cuX11BridgeBin = "/res/x11-bridge";
  delete globalThis.__cuGnomeBridgeBin; delete globalThis.__cuWlrootsBridgeBin; delete globalThis.__cuTargetRead;
  globalThis.__cuKwinMode = false;
  globalThis.__cuLastShot = null; globalThis.__cuPinnedDisplay = void 0; globalThis.__cuActiveOrigin = { x: 0, y: 0 };
  for (const k of ["SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE", "NIRI_SOCKET", "COWORK_SCREENSHOT_CMD", "X11_BRIDGE_BIN", "WLROOTS_BRIDGE_BIN", "YDOTOOL_SOCKET", "WAYLAND_DISPLAY"]) delete process.env[k];
  process.env.PATH = "/usr/bin";
  if (host === "hyprland") {
    Object.assign(process.env, { XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "Hyprland", WAYLAND_DISPLAY: "wayland-1", HYPRLAND_INSTANCE_SIGNATURE: "sig" });
    globalThis.__cuWlrootsBridgeBin = "/res/wlroots-bridge";
  } else {
    Object.assign(process.env, { XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: host === "kde" ? "KDE" : "XFCE", DISPLAY: ":0" });
  }
  Object.assign(process.env, env);
  new Function("require", "process", readFileSync(EXECUTOR, "utf8"))(req, process);
  return { ex: globalThis.__linuxExecutor, diag, zooms };
}
const disp = (id, b, sf, no, label = "") => ({ id, label, bounds: b, size: { width: b.width, height: b.height }, workArea: b, scaleFactor: sf, ...(no ? { nativeOrigin: no } : {}) });
const R = (x, y, width, height) => ({ x, y, width, height });
const scr = (name, x, y, width, height, scale = 1, primary = false) => ({ id: name, name, geometry: R(x, y, width, height), scale, is_primary: primary });

// The handler's cold path, cut verbatim, run with the handler's free names.
const HNAMES = ["__txC", "__untxC", "__coldShot", "__coldGuard", "__coldPts", "__pinDisplay", "__syncUpstreamShotDims"];
const HSRC = HNAMES.map((n) => cutFn(HANDLER, n)).join("\n");
function handler(ex, tool, input, ask = false, session = null) {
  return new Function("ex", "__ask", "__TOOL_NAME__", "__INPUT__", "__SESSION__",
    "var __cold=null;\n" + HSRC + "\nreturn{__txC,__untxC,__coldGuard,__coldPts,__pinDisplay,cold:function(){return __cold}};")(ex, ask, tool, input, session);
}
// One tool call through the guard: {refused} or {pt} (the mapped point).
async function call(ex, tool, input, ask = false) {
  const h = handler(ex, tool, input, ask);
  const g = await h.__coldGuard(h.__coldPts());
  if (g) return { refused: g.content[0].text, isError: g.isError };
  const c = input.coordinate || [input.x, input.y];
  return { pt: h.__txC(c), h };
}
// The frame a real screenshot gives (the handler's screenshot bookkeeping).
async function shoot(ex, displayId) {
  const ss = await ex.screenshot({ displayId });
  return { imgW: ss.imgW, imgH: ss.imgH, dispW: ss.displayWidth, dispH: ss.displayHeight, originX: ss.originX, originY: ss.originY };
}
async function coldEqualsWarm(label, rigOpts, displayId, pts) {
  const r = makeRig(rigOpts);
  const mons = await r.ex.listDisplays();
  const m = mons.find((x) => x.displayId === displayId);
  const cold = r.ex.__coldFrame(m, false);
  const warm = await shoot(r.ex, displayId);
  ok(cold && cold.imgW === warm.imgW && cold.imgH === warm.imgH && cold.originX === warm.originX && cold.originY === warm.originY && cold.dispW === warm.dispW,
    label + ": cold frame = the frame of a real capture", J({ cold, warm }));
  if (pts) {
    globalThis.__cuPinnedDisplay = displayId;
    for (const p of pts) {
      globalThis.__cuLastShot = null;
      const c = await call(r.ex, "left_click", { coordinate: p });
      globalThis.__cuLastShot = warm;
      const w = handler(r.ex, "left_click", { coordinate: p }).__txC(p);
      ok(c.pt && c.pt[0] === w[0] && c.pt[1] === w[1], label + `: click ${J(p)} cold = warm`, J({ cold: c.pt || c.refused, warm: w }));
    }
    globalThis.__cuLastShot = null; globalThis.__cuPinnedDisplay = void 0;
  }
  return { r, cold, warm };
}

// ── [1] the regular executor's frame ───────────────────────────────────────
console.log("\n[1] regular executor: cold frame = real capture frame");
{
  const one = [disp(1, R(0, 0, 1920, 1080), 1, { x: 0, y: 0 })];
  const { cold } = await coldEqualsWarm("X11 1920x1080 @1", { displays: one, screens: [scr("A", 0, 0, 1920, 1080, 1, true)] }, 0, [[0, 0], [715, 402], [1429, 803]]);
  ok(cold.imgW === 1430 && cold.imgH === 804, "X11 1920x1080 @1 downscales to 1430x804 (so identity was wrong here too)", J(cold));
  const small = [disp(1, R(0, 0, 1280, 800), 1, { x: 0, y: 0 })];
  const s = await coldEqualsWarm("X11 1280x800 @1", { displays: small, screens: [scr("A", 0, 0, 1280, 800, 1, true)] }, 0, [[640, 400]]);
  ok(s.cold.imgW === 1280 && s.cold.imgH === 800, "X11 1280x800 @1 fits: frame = display (identity)", J(s.cold));
  const hi = [disp(1, R(0, 0, 1920, 1080), 1.6, { x: 0, y: 0 })];
  const h = await coldEqualsWarm("X11 1920x1080 DIP @1.6 (3072x1728 root px)", { displays: hi, screens: [scr("A", 0, 0, 3072, 1728, 1, true)] }, 0, [[155, 626], [1000, 500]]);
  ok(h.cold.imgW === 1430 && h.cold.imgH === 804, "X11 @1.6: 1430x804", J(h.cold));
  const x2 = [disp(1, R(0, 0, 1920, 1080), 2, { x: 0, y: 0 })];
  const d2 = await coldEqualsWarm("X11 1920x1080 DIP @2 (3840x2160 root px)", { displays: x2, screens: [scr("A", 0, 0, 3840, 2160, 1, true)] }, 0, [[155, 626], [1429, 803]]);
  ok(d2.cold.imgW === 1430 && d2.cold.imgH === 804, "X11 @2: 1430x804", J(d2.cold));
  const hypr = [disp(1, R(0, 0, 1920, 1080), 1.6)];
  const hy = await coldEqualsWarm("Hyprland 1920x1080 @1.6 (wlroots-bridge)", { host: "hyprland", displays: hypr, screens: [scr("eDP-1", 0, 0, 1920, 1080, 1.6, true)] }, 0, [[155, 626]]);
  ok(hy.cold.imgW === 1430 && hy.cold.imgH === 804, "Hyprland @1.6: 1430x804 (the observed image)", J(hy.cold));
  const two = [disp(1, R(0, 0, 1920, 1080), 1), disp(2, R(1920, 0, 2560, 1440), 1)];
  two.primaryIdx = 0;
  const t2 = await coldEqualsWarm("Hyprland second monitor 2560x1440 at 1920,0", { host: "hyprland", displays: two, screens: [scr("DP-1", 0, 0, 1920, 1080, 1, true), scr("DP-2", 1920, 0, 2560, 1440, 1)] }, 1, [[0, 0], [700, 400]]);
  ok(t2.cold.originX === 1920 && t2.cold.imgW === 1430, "second monitor: its origin and its own frame", J(t2.cold));
}
{
  const one = [disp(1, R(0, 0, 1920, 1080), 1.6, { x: 0, y: 0 })];
  const r = makeRig({ displays: one, screens: [scr("A", 0, 0, 3072, 1728, 1, true)], env: { COWORK_SCREENSHOT_CMD: "true {FILE}" } });
  const f = r.ex.__coldFrame((await r.ex.listDisplays())[0], true);
  const w = await shoot(r.ex, 0);
  ok(f && f.imgW === 3072 && f.imgH === 1728 && w.imgW === 3072, "COWORK_SCREENSHOT_CMD: native size (no downscale), as its capture", J({ f, w }));
}
{
  const one = [disp(1, R(0, 0, 1920, 1080), 1, { x: 0, y: 0 })];
  const r = makeRig({ host: "kde", displays: one, screens: [scr("A", 0, 0, 1920, 1080, 1, true)], mask: true });
  const m = (await r.ex.listDisplays())[0];
  const fn = r.ex.__coldFrame(m, false);
  const w = await shoot(r.ex, 0);
  ok(fn && fn.imgW === 1920 && fn.imgH === 1080 && w.imgW === 1920, "KDE X11 with spectacle, unmasked: native size, as the spectacle capture", J({ fn, w }));
  const r2 = makeRig({ host: "kde", displays: one, screens: [scr("A", 0, 0, 1920, 1080, 1, true)], mask: true });
  const m2 = (await r2.ex.listDisplays())[0];
  const unknown = r2.ex.__coldFrame(m2, true);
  ok(unknown === null, "KDE X11 with spectacle, allowlist, mask answer not known yet: no frame", J(unknown));
  await new Promise((res) => setTimeout(res, 20));
  const known = r2.ex.__coldFrame(m2, true);
  ok(known && known.imgW === 1430, "... once the bridge said it masks: the bridge's downscaled frame", J(known));
  ok(r2.diag.some((l) => /no screenshot yet in this app run: coordinates read in the 1430x804 frame/.test(l)), "the cold frame is logged");
}

// ── [2] the handler ────────────────────────────────────────────────────────
console.log("\n[2] handler: cold clicks");
{
  const hypr = [disp(1, R(0, 0, 1920, 1080), 1.6)];
  const rig = () => makeRig({ host: "hyprland", displays: hypr, screens: [scr("eDP-1", 0, 0, 1920, 1080, 1.6, true)] });
  let r = rig();
  const c = await call(r.ex, "left_click", { coordinate: [155, 626] });
  ok(c.pt && c.pt[0] === 208 && c.pt[1] === 841, "observed case: 155,626 in the 1430x804 image -> 208,841", J(c.pt || c.refused));
  for (const tool of ["right_click", "double_click", "triple_click", "middle_click", "mouse_move", "scroll"]) {
    const t = await call(r.ex, tool, { coordinate: [155, 626] });
    ok(t.pt && t.pt[0] === 208 && t.pt[1] === 841, tool + " maps the same", J(t.pt || t.refused));
  }
  const dr = handler(r.ex, "left_click_drag", { start_coordinate: [0, 0], coordinate: [715, 402] });
  ok((await dr.__coldGuard(dr.__coldPts())) === null && J(dr.__txC([715, 402])) === J([960, 540]), "left_click_drag: both ends in the frame", J(dr.__txC([715, 402])));
  const out = await call(r.ex, "left_click", { coordinate: [1500, 300] });
  ok(out.isError && out.refused === "coordinate is outside the display bounds, and there is no prior screenshot to interpret it against. Take a screenshot first.", "a point outside the 1430x804 frame is refused with upstream's text", out.refused);
  const out2 = await call(r.ex, "left_click_drag", { start_coordinate: [2000, 10], coordinate: [10, 10] });
  ok(out2.refused && /^start_coordinate is outside the display bounds/.test(out2.refused), "a drag start outside the frame is refused by its name", out2.refused);
  const neg = await call(r.ex, "scroll", { coordinate: [-5, 10] });
  ok(neg.refused && /outside the display bounds/.test(neg.refused), "a negative point is refused", neg.refused);
  const zr = handler(r.ex, "zoom", { region: [0, 0, 2000, 900] });
  const zg = await zr.__coldGuard(zr.__coldPts());
  ok(zg && /^region is outside the display bounds/.test(zg.content[0].text), "a zoom region past the frame is refused", zg && zg.content[0].text);
  const cpH = handler(r.ex, "cursor_position", {});
  ok((await cpH.__coldGuard(cpH.__coldPts())) === null && J(cpH.__untxC(208, 841)) === J([155, 626]), "cursor_position reads back in the frame", J(cpH.__untxC(208, 841)));
  // Warm cache: unchanged, even for a point the cold frame would refuse.
  globalThis.__cuLastShot = { imgW: 1920, imgH: 1080, dispW: 1920, dispH: 1080, originX: 0, originY: 0 };
  const warm = await call(r.ex, "left_click", { coordinate: [1500, 300] });
  ok(warm.pt && warm.pt[0] === 1500 && warm.pt[1] === 300 && warm.h.cold() === null, "warm cache: the last screenshot's mapping, no guard", J(warm.pt || warm.refused));
  globalThis.__cuLastShot = null;
  // switch_display: the pinned display's frame, not the old display's scale.
  const two = [disp(1, R(0, 0, 1920, 1080), 1.6), disp(2, R(1920, 0, 1280, 800), 1)];
  r = makeRig({ host: "hyprland", displays: two, screens: [scr("eDP-1", 0, 0, 1920, 1080, 1.6, true), scr("HDMI-1", 1920, 0, 1280, 800, 1)] });
  globalThis.__cuLastShot = { imgW: 1430, imgH: 804, dispW: 1920, dispH: 1080, originX: 0, originY: 0 };
  const synced = [];
  const sw = handler(r.ex, "switch_display", { display: "HDMI-1" }, false, { onCuScreenshotDimsUpdated: (d) => synced.push(d) });
  sw.__pinDisplay((await r.ex.listDisplays())[1]);
  ok(globalThis.__cuLastShot === null && synced.length === 1 && synced[0] === void 0, "switch_display drops the old frame (ours and upstream's)");
  const s1 = await call(r.ex, "left_click", { coordinate: [640, 400] });
  ok(s1.pt && s1.pt[0] === 2560 && s1.pt[1] === 400, "after switch_display: the pinned 1280x800 display at 1920,0 (identity + origin)", J(s1.pt || s1.refused));
  const s2 = await call(r.ex, "left_click", { coordinate: [1400, 400] });
  ok(s2.refused && /outside the display bounds/.test(s2.refused), "after switch_display: a point of the old 1430-wide frame is refused", s2.refused);
  globalThis.__cuPinnedDisplay = void 0;
  const s3 = await call(r.ex, "left_click", { coordinate: [155, 626] });
  ok(s3.pt && s3.pt[0] === 208 && s3.pt[1] === 841, "auto: the primary display's frame", J(s3.pt || s3.refused));
  globalThis.__cuPinnedDisplay = 7;
  const s4 = await call(r.ex, "left_click", { coordinate: [10, 10] });
  ok(s4.refused === "There is no prior screenshot to interpret coordinate against. Take a screenshot first.", "a pinned display that is gone: refused", s4.refused);
  globalThis.__cuPinnedDisplay = void 0;
  // A frame that cannot be told (KDE + spectacle, allowlist, mask unknown).
  const one = [disp(1, R(0, 0, 1920, 1080), 1, { x: 0, y: 0 })];
  const k = makeRig({ host: "kde", displays: one, screens: [scr("A", 0, 0, 1920, 1080, 1, true)], mask: true });
  const ku = await call(k.ex, "left_click", { coordinate: [10, 10] }, true);
  ok(ku.refused === "There is no prior screenshot to interpret coordinate against. Take a screenshot first.", "no frame known: refused, never guessed", ku.refused);
  const kc = handler(k.ex, "cursor_position", {}, true);
  ok((await kc.__coldGuard(kc.__coldPts())) === null && kc.cold() === null, "cursor_position is never refused (no frame: as before)");
  const bare = await call({ listDisplays: async () => [] }, "left_click", { coordinate: [10, 20] });
  ok(bare.pt && bare.pt[0] === 10 && bare.pt[1] === 20, "an executor without __coldFrame: the old origin-only fallback, no refusal", J(bare.pt || bare.refused));
  const kt = handler(k.ex, "key", { text: "a" });
  ok((await kt.__coldGuard(kt.__coldPts())) === null, "tools without coordinates are not touched");
  // Wiring: the guard runs before the action block, zoom and cursor_position.
  const gi = HANDLER.indexOf("var __cg=await __coldGuard(__coldPts());if(__cg)return __cg;");
  ok(gi > 0 && gi < HANDLER.indexOf("if(__actionTools.has(__TOOL_NAME__))") && gi < HANDLER.indexOf('case"zoom":{') && gi < HANDLER.indexOf('case"cursor_position":{'),
    "the guard runs before the action tools, zoom and cursor_position");
  ok(/ls=globalThis\.__cuLastShot\|\|__cold;/.test(cutFn(HANDLER, "__txC")) && /ls=globalThis\.__cuLastShot\|\|__cold;/.test(cutFn(HANDLER, "__untxC")), "__txC / __untxC prefer the last screenshot, then the cold frame");
}

// ── [3] the kwin executor ──────────────────────────────────────────────────
console.log("\n[3] kwin executor");
{
  const src = readFileSync(KWIN, "utf8")
    .replace("import { execFile as execFileCb, spawnSync } from 'node:child_process'", "const { execFile: execFileCb, spawnSync } = __cp")
    .replace("import { screen as electronScreen } from 'electron'", "const electronScreen = { getAllDisplays: () => [], getPrimaryDisplay: () => ({}) }")
    .replace("import { promisify } from 'node:util'", "const { promisify } = __util")
    .replace(/^export /gm, "");
  ok(!/^import /m.test(src), "executor_linux.js imports spliced");
  const diag = [];
  globalThis.__cdbDiag = (m) => diag.push(String(m));
  globalThis.__cuKwinBridgeBin = "/res/kwin-portal-bridge";
  const mod = new Function("__cp", "__util", src + "\nreturn { createLinuxExecutor };")({ execFile(b, a, o, cb) { (typeof o === "function" ? o : cb)(new Error("not stubbed")); }, spawnSync() { return { status: 1 }; } }, util);
  const kx = mod.createLinuxExecutor({ hostBundleId: "com.anthropic.claude" });
  const f = kx.__coldFrame({ displayId: 0, width: 1920, height: 1080, scaleFactor: 1.6, originX: 0, originY: 0 });
  ok(f && f.imgW === 1430 && f.imgH === 804 && f.dispW === 1920, "1920x1080 @1.6: 1430x804", J(f));
  const f2 = kx.__coldFrame({ width: 2560, height: 1440, scaleFactor: 1, originX: 1920, originY: 0 });
  const t2 = bridgeDims(2560, 1440);
  ok(f2 && f2.imgW === t2.width && f2.imgH === t2.height && f2.originX === 1920, "second monitor: its origin and kwin-portal-bridge's size", J(f2));
  const f3 = kx.__coldFrame({ width: 1280, height: 800, scaleFactor: 1 });
  ok(f3 && f3.imgW === 1280 && f3.imgH === 800, "1280x800 @1: frame = display", J(f3));
  ok(kx.__coldFrame({ width: 0, height: 0 }) === null && kx.__coldFrame(null) === null, "no geometry: no frame");
}

// ── [4] sub-patch 5e on upstream's mapping ─────────────────────────────────
console.log("\n[4] sub-patch 5e: upstream's pixels-mode mapping with no prior screenshot");
let haveBundle = existsSync(path.join(BUILD_DIR, "index.js"));
try { accessSync(CU_BIN, constants.X_OK); } catch { haveBundle = false; }
if (!haveBundle) {
  console.log("  SKIP sub-patch 5e cases: no extract or fix_computer_use_linux not compiled (cd patches && make; CDB_BUNDLE_DIR)");
} else {
  const chunks = readdirSync(BUILD_DIR).filter((d) => /^index.*\.chunk-.*\.js$/.test(d)).sort();
  let pristine = readFileSync(path.join(BUILD_DIR, "index.js"), "utf8");
  for (const c of chunks) pristine += "\n/*__CDB_SPLIT__" + c + "__*/\n" + readFileSync(path.join(BUILD_DIR, c), "utf8");
  scratch = mkdtempSync(path.join(os.tmpdir(), "cdb-cu-cold-coords-"));
  const staged = path.join(scratch, "staged_index.js");
  writeFileSync(staged, pristine);
  const r = spawnSync(CU_BIN, [staged], { encoding: "utf8", maxBuffer: 64 << 20 });
  ok(r.status === 0 && /\[OK\] 5e no-screenshot coordinate/.test(r.stdout || ""), "fix_computer_use_linux applies, 5e reported", r.status + " " + String(r.stdout || "").split("\n").filter((l) => /FAIL|5e/.test(l)).join(" | "));
  const patched = readFileSync(staged, "utf8");
  const MARK = "pixels-mode coordinate received with no prior screenshot";
  function mapper(src) {
    const at = src.indexOf(MARK);
    const head = src.lastIndexOf("function ", at);
    const name = /^function ([\w$]+)\(/.exec(src.slice(head))[1];
    const fn = cutFn(src.slice(head), name);
    const helper = /Take a screenshot first\.`\):([\w$]+)\(/.exec(fn)[1];
    const hfn = cutFn(src.slice(head), helper);
    return new Function(fn + "\n" + hfn + "\nreturn " + name + ";")();
  }
  const up = mapper(pristine), ours = mapper(patched);
  ok(/let __cdbCf=process\.platform==="linux"\?globalThis\.__linuxExecutor\?\.__coldFrame\?\.\(/.test(ours.toString()), "the patched mapping asks the Linux executor");
  const log = { warn() {} };
  const disp16 = { width: 1920, height: 1080, scaleFactor: 1.6, originX: 0, originY: 0 };
  const saved = globalThis.__linuxExecutor;
  const kwinLike = { __coldFrame: (d) => { const t = bridgeDims(Math.round(d.width * d.scaleFactor), Math.round(d.height * d.scaleFactor)); return { imgW: t.width, imgH: t.height, dispW: d.width, dispH: d.height, originX: d.originX, originY: d.originY }; } };
  globalThis.__linuxExecutor = kwinLike;
  const a = ours(155, 626, "pixels", disp16, void 0, log);
  ok(a && a.x === 208 && a.y === 841, "Linux, no prior screenshot: 155,626 -> 208,841 through __coldFrame", J(a));
  const b = up(155, 626, "pixels", disp16, void 0, log);
  ok(b && b.x === 97 && b.y === 391, "(upstream alone divides by 1.6: 97,391)", J(b));
  const o = ours(1500, 300, "pixels", disp16, void 0, log);
  ok(o instanceof Error && o.message === "coordinate is outside the display bounds, and there is no prior screenshot to interpret it against. Take a screenshot first.", "outside the frame: upstream's own refusal", o && o.message);
  const o2 = ours(1429, 803, "pixels", disp16, void 0, log);
  ok(o2 && o2.x === 1919 && o2.y === 1079, "the frame's last pixel: the display's last pixel", J(o2));
  const two = { width: 2560, height: 1440, scaleFactor: 1, originX: 1920, originY: 0 };
  const m2 = ours(700, 400, "pixels", two, void 0, log);
  const t2 = bridgeDims(2560, 1440);
  ok(m2 && m2.x === 1920 + Math.round(700 * 2560 / t2.width) && m2.y === Math.round(400 * 1440 / t2.height), "second monitor: origin + its frame", J(m2));
  const prior = { width: 1430, height: 804, displayWidth: 1920, displayHeight: 1080, originX: 0, originY: 0 };
  ok(J(ours(155, 626, "pixels", disp16, prior, log)) === J(up(155, 626, "pixels", disp16, prior, log)), "a prior screenshot: upstream's result, unchanged");
  ok(J(ours(10, 20, "normalized_0_100", disp16, void 0, log)) === J(up(10, 20, "normalized_0_100", disp16, void 0, log)), "normalized mode: unchanged");
  globalThis.__linuxExecutor = {};
  ok(J(ours(155, 626, "pixels", disp16, void 0, log)) === J(b), "an executor without __coldFrame: upstream's division");
  globalThis.__linuxExecutor = { __coldFrame: () => null };
  ok(J(ours(155, 626, "pixels", disp16, void 0, log)) === J(b), "no frame known: upstream's division");
  globalThis.__linuxExecutor = kwinLike;
  const plat = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });
  const dm = ours(155, 626, "pixels", disp16, void 0, log);
  Object.defineProperty(process, "platform", plat);
  ok(J(dm) === J(b), "another platform: upstream's division", J(dm));
  globalThis.__linuxExecutor = saved;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
