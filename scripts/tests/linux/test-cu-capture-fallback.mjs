#!/usr/bin/env node
// desktopCapturer fallback crop in js/cu_linux_executor.js (issue #298).
//
// The Electron desktopCapturer tier is the last resort on X11 when x11-bridge
// fails and on uncovered Wayland (exotic, KDE without kwin mode) always; on a
// covered Wayland session (wlroots / GNOME) a failed bridge capture never
// reaches it, since its portal picker is a desktop dialog. It
// used to request thumbnailSize {w+x, h+y} and crop {x, y, w, h} out of it.
// Chromium fits each screen's frame INSIDE thumbnailSize keeping the aspect
// ratio (ScaleDesktopFrame / ComputeLetterboxRegion), so the crop ran in a
// frame scaled by k = min((x+w)/physW, (y+h)/physH): on a 2400x1350 @1.6
// monitor a zoom of logical 1000,403 403x571 came back 1.71x off. A full
// screenshot came back at the physical 3840x2160 while the bridge path emits
// 1430x804, so the model saw two different frames.
//
// The tier now requests the thumbnail at the full physical size of the monitor
// that holds the region, picks the source by display_id (else by a thumbnail
// aspect that fits exactly one monitor, else the primary with one diag line),
// crops display-relative scaled by the size Chromium returned, and downscales
// by the bridges' rule (long edge <= 1568, <= 1.15 MP).
//
// The real executor runs against stub bridges and a stub desktopCapturer that
// letterboxes like Chromium; image -> DIP goes through the real __txC spliced
// out of js/cu_handler_injection.js.
//
// Exit codes follow the repo convention: 0 = PASS, other = FAIL.
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EXECUTOR = path.join(ROOT, "js", "cu_linux_executor.js");
const HANDLER = path.join(ROOT, "js", "cu_handler_injection.js");

const txSrc = readFileSync(HANDLER, "utf8").match(/function __txC\(c\)\{[\s\S]*?\n\}\n/);
if (!txSrc) { console.error("FAIL: could not splice __txC out of cu_handler_injection.js"); process.exit(1); }
const __txC = new Function(txSrc[0] + "\nreturn __txC;")();

// The bridges' compute_target_dims (wlroots-bridge src/capture.rs).
const targetDims = (w, h) => { const s = Math.min(1, 1568 / Math.max(w, h), Math.sqrt(1150000 / (w * h))); return { width: Math.round(w * s), height: Math.round(h * s) }; };

// A NativeImage stand-in that records crop/resize.
function makeImg(W, H, ops, tag) {
  return {
    tag,
    isEmpty: () => W <= 0 || H <= 0,
    getSize: () => ({ width: W, height: H }),
    crop(r) {
      const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y), x1 = Math.min(W, r.x + r.width), y1 = Math.min(H, r.y + r.height);
      ops.push({ op: "crop", tag, frame: [W, H], rect: [r.x, r.y, r.width, r.height] });
      return makeImg(x1 - x0, y1 - y0, ops, tag);
    },
    resize(o) { ops.push({ op: "resize", tag, from: [W, H], to: [o.width, o.height] }); return makeImg(o.width, o.height, ops, tag); },
    toPNG: () => Buffer.from("png:" + tag)
  };
}
// A screen source as Chromium builds it: its physical frame (pw x ph) fitted
// inside the requested thumbnailSize keeping the aspect ratio. cap < 1 models
// a frame delivered below the requested size.
const source = (tag, pw, ph, displayId = "", cap = 1) => ({ tag, pw, ph, displayId, cap });
function thumbFor(s, ts, ops) {
  const k = Math.min(ts.width / s.pw, ts.height / s.ph, s.cap);
  return { id: "screen:" + s.tag, name: s.tag, display_id: s.displayId, thumbnail: makeImg(Math.round(s.pw * k), Math.round(s.ph * k), ops, s.tag) };
}

const d = (id, label, b, sf, no) => ({ id, label, bounds: b, size: { width: b.width, height: b.height }, workArea: b, scaleFactor: sf, ...(no ? { nativeOrigin: no } : {}) });
const R = (x, y, width, height) => ({ x, y, width, height });

// kind: "wlroots" | "gnome" | "x11" | "cosmic" (exotic Wayland, no bridge).
// bridgeFails(sub): true -> that bridge subcommand fails with a generic error.
function makeRig({ kind, displays, screens = [], sources = [], bridgeFails = () => false, zoomImg = (pw, ph) => targetDims(pw, ph), sfOf = () => 1 }) {
  const calls = [], diag = [], ops = [], requests = [];
  const bridgeName = { wlroots: "wlroots-bridge", gnome: "gnome-portal-bridge", x11: "x11-bridge" }[kind];
  const reply = (args) => {
    const sub = args[0];
    if (bridgeFails(sub)) throw new Error(sub === "zoom" ? "screencopy did not complete (no ready event)" : sub + " failed");
    if (sub === "screens") return JSON.stringify(screens);
    if (sub === "zoom") {
      const w = +args[args.indexOf("--w") + 1], h = +args[args.indexOf("--h") + 1];
      const sf = sfOf(args);
      const o = zoomImg(Math.round(w * sf), Math.round(h * sf));
      return JSON.stringify({ base64: "AA", width: o.width, height: o.height });
    }
    return "{}";
  };
  const cp = {
    execFileSync(bin, args) {
      if (path.basename(String(bin)) !== bridgeName) throw new Error("not found");
      calls.push(args.join(" "));
      return reply(args);
    },
    execSync() { throw new Error("nope"); },
    spawnSync() { return { status: 1 }; },
    execFile(bin, args, opts, cb) {
      if (path.basename(String(bin)) !== bridgeName) { setTimeout(() => cb(new Error("not found"), "", ""), 0); return; }
      calls.push(args.join(" "));
      setTimeout(() => { let out; try { out = reply(args); } catch (e) { cb(e, "", String(e.message)); return; } cb(null, out, ""); }, 0);
    },
    spawn() { return { on() {}, unref() {} }; }
  };
  const electron = {
    app: { commandLine: { getSwitchValue: () => "" } },
    screen: { getAllDisplays: () => displays, getPrimaryDisplay: () => displays[displays.primaryIdx || 0], getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    desktopCapturer: { getSources: async (o) => { requests.push(o.thumbnailSize); return sources.map((s) => thumbFor(s, o.thumbnailSize, ops)); } },
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
  globalThis.__cuLastShot = null;
  for (const k of ["SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE", "NIRI_SOCKET", "COWORK_SCREENSHOT_CMD", "X11_BRIDGE_BIN", "WLROOTS_BRIDGE_BIN", "GNOME_PORTAL_BRIDGE_BIN", "YDOTOOL_SOCKET", "WAYLAND_DISPLAY"]) delete process.env[k];
  if (kind === "wlroots") { Object.assign(process.env, { XDG_CURRENT_DESKTOP: "Hyprland", XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-1", HYPRLAND_INSTANCE_SIGNATURE: "x" }); globalThis.__cuWlrootsBridgeBin = "/res/wlroots-bridge"; }
  else if (kind === "gnome") { Object.assign(process.env, { XDG_CURRENT_DESKTOP: "ubuntu:GNOME", XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" }); globalThis.__cuGnomeBridgeBin = "/res/gnome-portal-bridge"; }
  else if (kind === "x11") { Object.assign(process.env, { XDG_CURRENT_DESKTOP: "XFCE", XDG_SESSION_TYPE: "x11" }); globalThis.__cuX11BridgeBin = "/res/x11-bridge"; }
  else { Object.assign(process.env, { XDG_CURRENT_DESKTOP: "COSMIC", XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" }); }
  new Function("require", "process", readFileSync(EXECUTOR, "utf8"))(requireStub, process);
  const ex = globalThis.__linuxExecutor;
  diag.length = 0; calls.length = 0;
  return { ex, calls, diag, ops, requests };
}

// The handler's screenshot bookkeeping (what __txC reads).
async function shoot(ex, displayId) {
  const ss = await ex.screenshot({ displayId });
  globalThis.__cuLastShot = { imgW: ss.imgW, imgH: ss.imgH, dispW: ss.displayWidth, dispH: ss.displayHeight, originX: ss.originX, originY: ss.originY };
  return ss;
}
// The handler's zoom: image-pixel corners -> DIP rect.
async function zoomImgRegion(ex, r, displayId = null) {
  const c0 = __txC([r[0], r[1]]), c1 = __txC([r[2], r[3]]);
  const rect = { x: Math.min(c0[0], c1[0]), y: Math.min(c0[1], c1[1]), w: Math.abs(c1[0] - c0[0]), h: Math.abs(c1[1] - c0[1]) };
  const cap = await ex.zoom(rect, 1, displayId);
  return { rect, cap };
}
const lastOp = (ops, op) => [...ops].reverse().find((o) => o.op === op);
const last = (calls, sub) => [...calls].reverse().find((c) => c.startsWith(sub + " "));
const J = (v) => JSON.stringify(v);

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  PASS " + label + (extra ? "  -> " + extra : "")); return; }
  fail++; console.error("  FAIL " + label + (extra ? "  -> " + extra : ""));
}

// The reporter's layout (issue #298): one 3840x2160 monitor at 1.6 under Hyprland.
const HDMI = () => { const ds = [d(1, "HDMI-A-1", R(0, 0, 2400, 1350), 1.6)]; return ds; };
const HDMI_SCREENS = [{ id: "HDMI-A-1", name: "HDMI-A-1", geometry: R(0, 0, 2400, 1350), scale: 1.6, is_primary: true, is_active: true }];
const sf16 = () => 1.6;

console.log("\n[1] wlroots 2400x1350 @1.6, bridge working: unchanged bridge path");
{
  const rig = makeRig({ kind: "wlroots", displays: HDMI(), screens: HDMI_SCREENS, sources: [source("HDMI-A-1", 3840, 2160)], sfOf: sf16 });
  const ss = await shoot(rig.ex, 0);
  ok(ss.imgW === 1430 && ss.imgH === 804, "bridge screenshot is 1430x804", ss.imgW + "x" + ss.imgH);
  ok(J(__txC([632, 415])) === "[1061,697]", "image 632,415 maps to logical 1061,697", J(__txC([632, 415])));
  const { rect } = await zoomImgRegion(rig.ex, [596, 240, 836, 580]);
  ok(J(rect) === J({ x: 1000, y: 403, w: 403, h: 571 }), "zoom [596,240,836,580] is logical 1000,403 403x571", J(rect));
  ok(last(rig.calls, "zoom") === "zoom --x 1000 --y 403 --w 403 --h 571 --display HDMI-A-1", "bridge zoom args", last(rig.calls, "zoom"));
  ok(rig.requests.length === 0, "desktopCapturer is not touched while the bridge works");
}

console.log("\n[2] wlroots, bridge zoom failing: no desktopCapturer (its portal chooser is a desktop dialog), an error that says to retry");
{
  let failing = false;
  const rig = makeRig({ kind: "wlroots", displays: HDMI(), screens: HDMI_SCREENS, sources: [source("HDMI-A-1", 3840, 2160)], sfOf: sf16, bridgeFails: (s) => failing && s === "zoom" });
  await shoot(rig.ex, 0);
  failing = true;
  let threw = null;
  try { await zoomImgRegion(rig.ex, [596, 240, 836, 580]); } catch (e) { threw = e; }
  ok(rig.requests.length === 0, "desktopCapturer.getSources is never called on a covered wlroots session", rig.requests.length);
  ok(threw && /^Screenshot failed: wlroots-bridge could not capture the screen \(screencopy did not complete/.test(threw.message) && /taking the screenshot again once is reasonable/.test(threw.message),
     "the model reads that the capture failed and that retrying is reasonable", threw && threw.message);
  ok(rig.diag.some((l) => l.includes("no desktopCapturer")), "the cascade says why in the log");
}

console.log("\n[2x] exotic Wayland (no bridge) at 2400x1350 @1.6: the fallback crops display-relative physical pixels");
{
  const rig = makeRig({ kind: "cosmic", displays: HDMI(), sources: [source("HDMI-A-1", 3840, 2160)] });
  await shoot(rig.ex, 0);
  const n0 = rig.ops.length;
  const { cap } = await zoomImgRegion(rig.ex, [596, 240, 836, 580]);
  ok(J(rig.requests.at(-1)) === J({ width: 3840, height: 2160 }), "thumbnail requested at the monitor's physical size (was 1403x974)", J(rig.requests.at(-1)));
  const c = lastOp(rig.ops, "crop");
  ok(c && J(c.frame) === "[3840,2160]" && J(c.rect) === "[1600,645,645,914]", "crop is 1600,645 645x914 in the 3840x2160 frame", c && J(c));
  ok(cap.imgW === 645 && cap.imgH === 914 && cap.mimeType === "image/png", "zoom reports the real cropped size", cap.imgW + "x" + cap.imgH + " " + cap.mimeType);
  ok(!rig.ops.slice(n0).some((o) => o.op === "resize"), "a zoom below the size cap is not resized");
  ok(rig.diag.some((l) => l.includes("captured via desktopCapturer")), "the fallback is logged", rig.diag.filter((l) => /desktopCapturer/.test(l)).join(" | "));
}

console.log("\n[3] exotic Wayland: a fallback screenshot has the bridge's frame and clicks map the same way");
{
  const rig = makeRig({ kind: "cosmic", displays: HDMI(), sources: [source("HDMI-A-1", 3840, 2160)] });
  const ss = await shoot(rig.ex, 0);
  const r = lastOp(rig.ops, "resize");
  ok(ss.imgW <= 1568 && ss.imgW === 1430 && ss.imgH === 804, "fallback screenshot is 1430x804, the bridge frame (was 3840x2160)", ss.imgW + "x" + ss.imgH);
  ok(r && J(r.from) === "[3840,2160]" && J(r.to) === "[1430,804]", "the full-monitor crop is downscaled by the bridge rule", r && J(r));
  ok(J(__txC([632, 415])) === "[1061,697]", "image 632,415 still maps to logical 1061,697", J(__txC([632, 415])));
  const { cap } = await zoomImgRegion(rig.ex, [596, 240, 836, 580]);
  ok(J(lastOp(rig.ops, "crop").rect) === "[1600,645,645,914]" && cap.imgW === 645, "a zoom from the fallback frame crops the same region", J(lastOp(rig.ops, "crop").rect));
}

console.log("\n[4] the frame Chromium returns is smaller than requested: the crop scales with it");
{
  const rig = makeRig({ kind: "cosmic", displays: HDMI(), sources: [source("HDMI-A-1", 3840, 2160, "", 0.5)] });
  const cap = await rig.ex.zoom({ x: 1000, y: 403, w: 403, h: 571 }, 1, null);
  const c = lastOp(rig.ops, "crop");
  // 1920x1080 frame = half the physical size: logical 1000,403 403x571 -> 800,323 .. 1123,780.
  ok(c && J(c.frame) === "[1920,1080]" && J(c.rect) === "[800,323,323,457]", "crop scaled by 0.5", c && J(c));
  const back = [c.rect[0] / 1920 * 2400, c.rect[1] / 1080 * 1350, (c.rect[0] + c.rect[2]) / 1920 * 2400, (c.rect[1] + c.rect[3]) / 1080 * 1350];
  ok(Math.abs(back[0] - 1000) <= 1 && Math.abs(back[1] - 403) <= 1 && Math.abs(back[2] - 1403) <= 1 && Math.abs(back[3] - 974) <= 1, "and still covers logical 1000,403 .. 1403,974", back.map((v) => v.toFixed(1)).join(","));
  ok(cap.imgW === 323 && cap.imgH === 457, "imgW/imgH are the real crop", cap.imgW + "x" + cap.imgH);
}

console.log("\n[5] exotic Wayland, two monitors: source chosen by display_id, never by list order");
{
  const ds = [d(11, "DP-1", R(0, 0, 2560, 1440), 1), d(22, "eDP-1", R(2560, 0, 1280, 800), 2)];
  const rig = makeRig({ kind: "cosmic", displays: ds, sources: [source("DP-1", 2560, 1440, "11"), source("eDP-1", 2560, 1600, "22")] });
  const cap = await rig.ex.zoom({ x: 2660, y: 100, w: 200, h: 150 }, 1, null);
  const c = lastOp(rig.ops, "crop");
  ok(J(rig.requests.at(-1)) === J({ width: 2560, height: 1600 }), "thumbnail at eDP-1's physical size", J(rig.requests.at(-1)));
  ok(c && c.tag === "eDP-1" && J(c.rect) === "[200,200,400,300]", "eDP-1's source, crop relative to its origin at scale 2", c && J(c));
  ok(cap.imgW === 400 && cap.imgH === 300, "real crop size", cap.imgW + "x" + cap.imgH);
  const ss = await shoot(rig.ex, 0);
  ok(lastOp(rig.ops, "crop").tag === "DP-1" && ss.imgW === 1430 && ss.imgH === 804, "a screenshot of DP-1 uses DP-1's source, downscaled", lastOp(rig.ops, "crop").tag + " " + ss.imgW + "x" + ss.imgH);
}

console.log("\n[6] exotic Wayland, portal sources without display_id: aspect match, else the primary");
{
  // DP-1 16:9 primary, HDMI-1 16:10. The portal returns only the screen the user picked.
  const ds = [d(11, "DP-1", R(0, 0, 2400, 1350), 1.6), d(22, "HDMI-1", R(2400, 0, 1920, 1200), 1)];
  const rig = makeRig({ kind: "cosmic", displays: ds, sources: [source("portal", 1920, 1200)] });
  const ss = await shoot(rig.ex, 1);
  const c = lastOp(rig.ops, "crop");
  ok(c && c.tag === "portal" && J(c.rect) === "[0,0,1920,1200]" && ss.imgW === 1356 && ss.imgH === 848,
     "a 16:10 source with no display_id is HDMI-1 (aspect fits only it)", c && J(c) + " img " + ss.imgW + "x" + ss.imgH);
  ok(rig.diag.some((l) => l.includes("source by aspect match")), "logged as an aspect match");
  const n = rig.ops.length;
  let threw = null;
  try { await shoot(rig.ex, 0); } catch (e) { threw = e; }
  ok(threw && /Screenshot failed/.test(threw.message) && rig.ops.length === n, "a screenshot of DP-1 fails instead of returning HDMI-1", threw && threw.message);
  ok(rig.diag.some((l) => l.includes("desktopCapturer fallback failed") && l.includes("DP-1")), "and says why", rig.diag.filter((l) => l.includes("fallback failed")).pop());

  // Same aspect on both monitors: the source cannot be told apart, so it is taken to be the primary.
  const ds2 = [d(11, "DP-1", R(0, 0, 2400, 1350), 1.6), d(22, "HDMI-1", R(2400, 0, 1920, 1080), 1)];
  const rig2 = makeRig({ kind: "cosmic", displays: ds2, sources: [source("portal", 3840, 2160)] });
  const s0 = await shoot(rig2.ex, 0);
  await shoot(rig2.ex, 0);
  ok(lastOp(rig2.ops, "crop").tag === "portal" && s0.imgW === 1430, "an ambiguous source is used for the primary", s0.imgW + "x" + s0.imgH);
  ok(rig2.diag.filter((l) => l.includes("taking it to show the primary display DP-1")).length === 1, "with one diag line, not one per capture",
     rig2.diag.filter((l) => l.includes("primary display")).join(" | "));
  let threw2 = null;
  try { await rig2.ex.zoom({ x: 2500, y: 10, w: 100, h: 100 }, 1, null); } catch (e) { threw2 = e; }
  ok(threw2 && rig2.diag.some((l) => l.includes("shows the primary display DP-1, not HDMI-1")), "a zoom on the secondary is refused, not cropped from the primary", threw2 && threw2.message);

  // A single monitor whose source matches nothing: the primary (= the monitor) is used.
  const rig3 = makeRig({ kind: "cosmic", displays: [d(5, "eDP-1", R(0, 0, 1920, 1080), 1)], sources: [source("odd", 1000, 1000)] });
  const s3 = await shoot(rig3.ex, 0);
  ok(s3.imgW > 0 && rig3.diag.some((l) => l.includes("taking it to show the primary display eDP-1")), "one monitor, odd source: primary assumed and logged", s3.imgW + "x" + s3.imgH);
}

console.log("\n[7] GNOME Wayland, gnome-portal-bridge zoom failing, secondary monitor at scale 2");
{
  const ds = [d(1, "DP-1", R(0, 0, 1920, 1080), 1), d(2, "eDP-1", R(1920, 0, 1280, 800), 2)];
  const screens = [
    { id: "DP-1", name: "DP-1", geometry: R(0, 0, 1920, 1080), scale: 1, is_primary: true, is_active: true },
    { id: "eDP-1", name: "eDP-1", geometry: R(1920, 0, 1280, 800), scale: 2, is_primary: false, is_active: false }
  ];
  const rig = makeRig({ kind: "gnome", displays: ds, screens, sources: [source("eDP-1", 2560, 1600, "2"), source("DP-1", 1920, 1080, "1")], bridgeFails: (s) => s === "zoom" });
  let threw = null;
  try { await rig.ex.zoom({ x: 2000, y: 100, w: 400, h: 300 }, 1, null); } catch (e) { threw = e; }
  ok(rig.diag.some((l) => l.includes("gnome-portal-bridge zoom failed")), "the bridge zoom was tried and failed", rig.diag.filter((l) => l.includes("zoom failed")).pop());
  ok(rig.requests.length === 0, "desktopCapturer.getSources is never called (GNOME would raise its Share Screen dialog)", rig.requests.length);
  ok(threw && /^Screenshot failed: gnome-portal-bridge could not capture the screen/.test(threw.message) && /again once is reasonable/.test(threw.message), "the error says the capture failed and a retry is reasonable", threw && threw.message);
  let threw2 = null;
  try { await shoot(rig.ex, 1); } catch (e) { threw2 = e; }
  ok(threw2 && rig.requests.length === 0, "a full screenshot fails the same way, still no getSources", threw2 && threw2.message);
}

console.log("\n[7x] exotic Wayland, secondary monitor at scale 2: the fallback crops in that monitor's pixels");
{
  const ds = [d(1, "DP-1", R(0, 0, 1920, 1080), 1), d(2, "eDP-1", R(1920, 0, 1280, 800), 2)];
  const rig = makeRig({ kind: "cosmic", displays: ds, sources: [source("eDP-1", 2560, 1600, "2"), source("DP-1", 1920, 1080, "1")] });
  const cap = await rig.ex.zoom({ x: 2000, y: 100, w: 400, h: 300 }, 1, null);
  const c = lastOp(rig.ops, "crop");
  ok(c && c.tag === "eDP-1" && J(c.frame) === "[2560,1600]" && J(c.rect) === "[160,200,800,600]", "crop is eDP-1-relative physical 160,200 800x600", c && J(c));
  ok(cap.imgW === 800 && cap.imgH === 600, "real crop size", cap.imgW + "x" + cap.imgH);
  const ss = await shoot(rig.ex, 1);
  ok(ss.imgW === 1356 && ss.imgH === 848 && ss.displayWidth === 1280, "a fallback screenshot of eDP-1 is 1356x848 (2560x1600 by the bridge rule)", ss.imgW + "x" + ss.imgH);
  const t = targetDims(2560, 1600);
  ok(t.width === ss.imgW && t.height === ss.imgH, "same dims the bridge would emit", J(t));
}

console.log("\n[8] X11 at 1.25, x11-bridge zoom failing: crop in the display's own root pixels");
{
  // RandR: DP-1 3840x2160+0+0 (primary), HDMI-1 1920x1080+3840+0, scale 1.25.
  const ds = [d(1, "DP-1", R(0, 0, 3072, 1728), 1.25, { x: 0, y: 0 }), d(2, "HDMI-1", R(3072, 0, 1536, 864), 1.25, { x: 3840, y: 0 })];
  const screens = [
    { id: "DP-1", name: "DP-1", geometry: R(0, 0, 3840, 2160), scale: 1, is_primary: true, is_active: true },
    { id: "HDMI-1", name: "HDMI-1", geometry: R(3840, 0, 1920, 1080), scale: 1, is_primary: false, is_active: false }
  ];
  const rig = makeRig({ kind: "x11", displays: ds, screens, sources: [source("DP-1", 3840, 2160, "1"), source("HDMI-1", 1920, 1080, "2")], bridgeFails: (s) => s === "zoom" });
  const cap = await rig.ex.zoom({ x: 3172, y: 50, w: 200, h: 100 }, 1, null);
  const c = lastOp(rig.ops, "crop");
  ok(J(rig.requests.at(-1)) === J({ width: 1920, height: 1080 }), "thumbnail at HDMI-1's pixel size", J(rig.requests.at(-1)));
  ok(c && c.tag === "HDMI-1" && J(c.rect) === "[125,62,250,125]", "crop is HDMI-1-relative (root 3965,62 minus its origin 3840,0)", c && J(c));
  ok(cap.imgW === 250 && cap.imgH === 125, "real crop size", cap.imgW + "x" + cap.imgH);
  const ss = await shoot(rig.ex, 0);
  ok(ss.imgW === 1430 && ss.imgH === 804 && lastOp(rig.ops, "crop").tag === "DP-1", "fallback screenshot of DP-1 is 1430x804", ss.imgW + "x" + ss.imgH);
  const p = __txC([715, 402]);
  await rig.ex.click(p[0], p[1], "left", 1);
  const pc = (last(rig.calls, "pointer-click") || "").split(" ");
  ok(Math.abs(+pc[2] - 1920) <= 3 && Math.abs(+pc[4] - 1080) <= 3, "a click on the image centre lands on DP-1's pixel centre", "DIP " + p + " -> " + pc.slice(0, 5).join(" "));
}

delete globalThis.__linuxExecutor;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
