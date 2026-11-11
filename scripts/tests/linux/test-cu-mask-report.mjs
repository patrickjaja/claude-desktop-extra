#!/usr/bin/env node
// What the model gets from a masked capture (issue #329), through upstream's
// REAL dispatcher.
//
// WHY THIS EXISTS
// ---------------
// Masked sessions (cloud chat / cloud Cowork, the Code tab with "Ask before
// Computer Use controls an app") keep only the approved apps' windows in a
// screenshot. On Hyprland two paths handed the model a uniform #1E1E1E image
// as a success: (a) keep mode where wlroots-bridge's cut left nothing
// (Omarchy's full-output notification layer: `regions: []`), and (b) an
// allowlist where no window resolved to an approved app, where the executor
// itself sent --mask-all. The model read "the app shows nothing" and acted on
// a guess. Now: when no approved window is shown, the capture throws and
// upstream's dispatcher gives the model the reason per app as the tool's
// error text, without an image; when some are shown, the image goes out with
// a note (sub-patch 5c) on what covers a shown window and which approved apps
// are missing and why. wlroots-bridge reports per kept window `shown`,
// `reason`, `coveredBy` and `mask.capture`; an older bridge is read from
// `visible` and `regions`. A field of the wrong type discards the image.
//
// Sections:
//   [P] sub-patch 5c on the bundle: [OK], 65/65, idempotent, node --check,
//       moved anchors refused (no [PASS]).
//   [R] refusals through upstream's pristine dispatcher (no patch needed):
//       screenshot (resolvePrepareCapture and screenshot() paths), zoom,
//       computer_batch - text, isError, no image block.
//   [N] notes through the patched dispatcher: covered shown window (toplevel
//       and output wording), approved apps not shown; the note is handed out
//       once and only for its own image; the pristine dispatcher drops it.
//   [V] validation of the bridge report (fail closed).
//   [L] one [claude-cu] line per masked capture with mode, capture, counts,
//       reasons and app ids; the doctor line names the mask capture.
//   [X] x11-bridge: the kept path is unchanged (no `shown`), an allowlist
//       without a window refuses; an empty allowlist keeps --mask-all.
//
// CU_EXECUTOR points at another executor source, CDB_CU_PATCH_BIN at another
// compiled patch, CDB_BUNDLE_DIR at an extract (default tmp/app.asar.contents).
// Without the extract the dispatcher sections SKIP. No child process is
// spawned by the executor (the bridges are in-process fakes); the patch binary
// runs synchronously; temp dirs are removed on exit and on signals.
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, rmSync, accessSync, constants } from "node:fs";
import * as realFs from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..", "..");
const SKIP_EXIT = 3;
const EXEC = process.env.CU_EXECUTOR || path.join(repo, "js", "cu_linux_executor.js");
const CONSENT = path.join(repo, "js", "cu_consent.js");
const DISPLAY_TARGET = path.join(repo, "js", "cu_display_target.js");
const PATCH_BIN = process.env.CDB_CU_PATCH_BIN || path.join(repo, "patches", "linux", "fix_computer_use_linux");
const BUILD_DIR = path.join(process.env.CDB_BUNDLE_DIR || path.join(repo, "tmp", "app.asar.contents"), ".vite", "build");
const nodeRequire = createRequire(import.meta.url);
const ORIG_ENV = { ...process.env }; // makeRig rewrites PATH and the XDG vars
const J = JSON.stringify;
const esc = (x) => x.replace(/[$]/g, "\\$");

const tmpDirs = [];
function cleanup() { for (const d of tmpDirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} } }
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { cleanup(); process.exit(130); });
function scratchDir(tag) { const d = mkdtempSync(path.join(os.tmpdir(), "cdb-cu-mask-report-" + tag + "-")); tmpDirs.push(d); return d; }

let pass = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { pass++; console.log("  PASS " + label); }
  else { failures.push(label); console.log("  FAIL " + label + (detail !== undefined ? " -> " + String(detail).slice(0, 600) : "")); }
}
console.debug = () => {};

// ── a desktop with real entries ────────────────────────────────────────────
const TMP = scratchDir("desk");
const HOME = path.join(TMP, "home");
mkdirSync(HOME, { recursive: true });
const APPS = path.join(TMP, "share", "applications");
mkdirSync(APPS, { recursive: true });
const HDR = "[Desktop Entry]\nType=Application\n";
const ENTRIES = {
  firefox: "Name=Firefox\nExec=firefox %u\n",
  foot: "Name=Foot\nExec=foot\n",
  "org.gnome.Nautilus": "Name=Files\nExec=nautilus --new-window %U\n",
  signal: "Name=Signal\nExec=signal-desktop %U\n",
  chromium: "Name=Chromium\nExec=chromium %U\nStartupWMClass=chromium\n",
  "org.example.NotRunning": "Name=Not Running\nExec=notrunning\n",
  "org.example.Extra1": "Name=Extra One\nExec=extra1\n",
  "org.example.Extra2": "Name=Extra Two\nExec=extra2\n",
  "org.example.Extra3": "Name=Extra Three\nExec=extra3\n",
  "org.example.Extra4": "Name=Extra Four\nExec=extra4\n",
  "com.anthropic.Claude": "Name=Claude\nExec=claude-desktop %U\nStartupWMClass=com.anthropic.Claude\n",
};
for (const [id, body] of Object.entries(ENTRIES)) writeFileSync(path.join(APPS, id + ".desktop"), HDR + body);
// Omarchy's web-app and TUI entries (issue #329, see test-cu-app-ids.mjs [13])
// and the launcher the web apps call.
const BIN = path.join(TMP, "bin");
mkdirSync(BIN, { recursive: true });
for (const n of ["foot", "chromium", "xdg-terminal-exec"]) { writeFileSync(path.join(BIN, n), "#!/bin/sh\nexit 0\n"); realFs.chmodSync(path.join(BIN, n), 0o755); }
writeFileSync(path.join(BIN, "omarchy-launch-webapp"), "#!/bin/bash\nbrowser_exec=chromium\nexec setsid uwsm-app -- $browser_exec --app=\"$1\" \"${@:2}\"\n");
realFs.chmodSync(path.join(BIN, "omarchy-launch-webapp"), 0o755);
writeFileSync(path.join(APPS, "YouTube.desktop"), HDR + "Name=YouTube\nExec=omarchy-launch-webapp https://youtube.com/\nIcon=youtube\n");
writeFileSync(path.join(APPS, "Disk Usage.desktop"), HDR + "Name=Disk Usage\nExec=xdg-terminal-exec --app-id=TUI.float -e bash -c \"dua i /\"\nIcon=disk-usage\n");
// /proc of the fake app processes (pid -> exe, cmdline).
const FOOT = path.join(BIN, "foot"), CHR = path.join(BIN, "chromium");
const PROC = {
  2012: { exe: FOOT, cmdline: [FOOT] },
  2016: { exe: CHR, cmdline: [CHR] },
  2021: { exe: FOOT, cmdline: [FOOT, "--app-id=TUI.float", "-e", "bash", "-c", "dua i /"] },
  2022: { exe: CHR, cmdline: [CHR, "--app=https://youtube.com/"] },
};
// Only this harness's desktop is visible to the executor.
const noEnt = () => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; };
const deskFs = new Proxy(realFs, {
  get(t, p) {
    if (p === "readdirSync") return (d, ...r) => (String(d).startsWith(TMP) ? t.readdirSync(d, ...r) : noEnt());
    if (p === "readlinkSync") return (f, ...r) => { const m = /^\/proc\/(\d+)\/exe$/.exec(String(f)); if (m) return PROC[m[1]] ? PROC[m[1]].exe : noEnt(); if (/^\/proc\//.test(String(f))) noEnt(); return t.readlinkSync(f, ...r); };
    if (p === "readFileSync") return (f, ...r) => { const m = /^\/proc\/(\d+)\/cmdline$/.exec(String(f)); if (m) return PROC[m[1]] ? PROC[m[1]].cmdline.join("\0") + "\0" : noEnt(); if (/^\/proc\//.test(String(f))) noEnt(); return t.readFileSync(f, ...r); };
    return t[p];
  },
});

// ── the bundle and upstream's dispatcher ───────────────────────────────────
const SPLIT_RE = /\n\/\*__CDB_SPLIT__([^*\n]+?)__\*\/\n/;
function splitParts(blob) {
  const pieces = blob.split(SPLIT_RE);
  const names = ["index.js"], bodies = [pieces[0]];
  for (let i = 1; i < pieces.length; i += 2) { names.push(pieces[i]); bodies.push(pieces[i + 1]); }
  return { names, bodies };
}
function exportTarget(body, alias) {
  const all = [...body.matchAll(new RegExp("Object\\.defineProperty\\(exports,([\"`])" + esc(alias) + "\\1,\\{enumerable:!0,get:function\\(\\)\\{return ([\\w$]+)\\}\\}\\)", "g"))];
  return all.length === 1 ? all[0][2] : null;
}
function requiredChunk(body, ns) {
  const all = [...body.matchAll(new RegExp("(?<![\\w$.])" + esc(ns) + "=require\\(([\"'`])\\./([^\"'`]+)\\1\\)", "g"))];
  return all.length === 1 ? all[0][2] : null;
}
const DISPATCH_RE = /async function ([\w$]+)\(([\w$]+),[\w$]+,[\w$]+,[\w$]+\)\{let\{logger:[\w$]+,serverName:[\w$]+\}=\2,[\w$]+=[\w$]+\([\w$]+\);if\(\2\.isDisabled\(\)\)/;
const SCREEN_REF_RE = /\{bundleId:([\w$]+)\.([\w$]+),displayName:"Screen"\}/;
const DENIED_RE = /this\.isUserDenied=([\w$]+)\.([\w$]+)\(/;
const SCREEN = "com.anthropic.cu.screen";

let bundle = null;
if (existsSync(path.join(BUILD_DIR, "index.js"))) {
  const chunks = readdirSync(BUILD_DIR).filter((d) => /^index.*\.chunk-.*\.js$/.test(d)).sort();
  let blob = readFileSync(path.join(BUILD_DIR, "index.js"), "utf8");
  for (const c of chunks) blob += "\n/*__CDB_SPLIT__" + c + "__*/\n" + readFileSync(path.join(BUILD_DIR, c), "utf8");
  bundle = { blob, parts: splitParts(blob) };
} else {
  console.log("\n  SKIP dispatcher sections: no extract under tmp/app.asar.contents/ (set CDB_BUNDLE_DIR to point at one)");
}
function dispatcherIn(parts) {
  const i = parts.bodies.findIndex((b) => b.includes("no app is frontmost (focus anomaly)") && b.includes("The click would land on the desktop shell"));
  if (i < 0) return null;
  const body = parts.bodies[i];
  const fm = DISPATCH_RE.exec(body), sm = SCREEN_REF_RE.exec(body), dm = DENIED_RE.exec(body);
  return { name: parts.names[i], body, fn: fm && fm[1], nsName: sm && sm[1], nsFile: sm && requiredChunk(body, sm[1]), screenAlias: sm && sm[2], deniedNs: dm && dm[1], deniedAlias: dm && dm[2] };
}
function loadDispatcher(disp) {
  const electronStub = { app: { getName: () => "Claude" }, BrowserWindow: { getFocusedWindow: () => null }, screen: {} };
  const src = disp.body.replace(/\/\/# sourceMappingURL=.*$/m, "") + "\n;globalThis.__cdbT329={dispatch:" + disp.fn + "};";
  const denied = (ids) => (id) => Array.isArray(ids) && ids.includes(id);
  const nsCache = new Map();
  const ns = (file) => {
    if (nsCache.has(file)) return nsCache.get(file);
    const known = {};
    if (file === disp.nsFile) known[disp.screenAlias] = SCREEN;
    if (requiredChunk(disp.body, disp.deniedNs) === file) known[disp.deniedAlias] = denied;
    const p = new Proxy(known, { get(t, k) { if (k in t) return t[k]; if (typeof k === "symbol") return undefined; return () => null; } });
    nsCache.set(file, p);
    return p;
  };
  const req = (id) => {
    if (id === "electron") return electronStub;
    if (id.startsWith("node:")) return nodeRequire(id);
    if (id.startsWith("./")) return ns(id.slice(2));
    throw new Error("dispatcher require " + id);
  };
  const mod = { exports: {} };
  new Function("require", "exports", "module", src)(req, mod.exports, mod);
  const Grants = Object.values(mod.exports).find((v) => typeof v === "function" && /kind="explicit"/.test(String(v)));
  const rank = Object.values(mod.exports).find((v) => v && typeof v === "object" && v.read === 0 && v.click === 1 && v.full === 2);
  return { dispatch: globalThis.__cdbT329.dispatch, Grants, rank };
}

// ── [P] sub-patch 5c ───────────────────────────────────────────────────────
let D0 = null, D5 = null; // pristine / patched dispatchers
if (bundle) {
  const d0 = dispatcherIn(bundle.parts);
  ok(!!d0 && !!d0.fn, "upstream's dispatcher chunk and dispatch function found", d0 && d0.name);
  if (d0 && d0.fn) D0 = loadDispatcher(d0);
  let binMissing = false;
  try { accessSync(PATCH_BIN, constants.X_OK); } catch { binMissing = true; }
  if (binMissing) console.log(`\n  SKIP [P]/[N]: ${PATCH_BIN} is not compiled (run: make -C patches linux/fix_computer_use_linux)`);
  else {
    console.log("\n[P] sub-patch 5c: the masked capture's note next to the image");
    const scratch = scratchDir("patch");
    const run = (blob, name) => { const f = path.join(scratch, name); writeFileSync(f, blob); const r = spawnSync(PATCH_BIN, [f], { encoding: "utf8" }); return { status: r.status, out: String(r.stdout || "") + String(r.stderr || ""), file: f }; };
    ok(!bundle.blob.includes("__cdbCuShotNote"), "pristine bundle has no __cdbCuShotNote");
    const r1 = run(bundle.blob, "staged.js");
    const exp = /\[PASS\] (\d+)\/(\d+) sub-patches applied/.exec(r1.out);
    ok(r1.status === 0 && !!exp && exp[1] === exp[2], "patch run exits 0 with every sub-patch applied", r1.out.split("\n").filter((l) => /FAIL|PASS|Error/.test(l)).join(" | "));
    ok(/\[OK\] 5c mask note: screenshot \(2 returns\) and zoom answer with globalThis\.__cdbCuShotNote's note for their image on Linux/.test(r1.out), "5c reported [OK] (2 screenshot returns, 1 zoom)");
    const patched = readFileSync(r1.file, "utf8");
    const r2 = spawnSync(PATCH_BIN, [r1.file], { encoding: "utf8" });
    ok(r2.status === 0 && /already present \(idempotent, no change\)/.test(String(r2.stdout)) && readFileSync(r1.file, "utf8") === patched, "second run: idempotent, byte-identical");
    const after = splitParts(patched);
    const d5 = dispatcherIn(after);
    ok(!!d5 && d5.name === (d0 && d0.name), "the patched dispatcher is the same chunk", d5 && d5.name);
    if (d5) {
      ok((d5.body.match(/globalThis\.__cdbCuShotNote\?\.\(/g) || []).length === 3, "3 note sites, all in the dispatcher chunk");
      const f = path.join(scratch, d5.name);
      writeFileSync(f, d5.body);
      let good = true;
      try { execFileSync("node", ["--check", f], { stdio: "pipe" }); } catch { good = false; }
      ok(good, "node --check " + d5.name);
      D5 = loadDispatcher(d5);
    }
    // A moved anchor is a [FAIL], never a [PASS].
    const r3 = run(bundle.blob.replace(/\{content:\[\{type:"image",data:\(await ([\w$]+)\.executor\.zoom\(/, '{content:[{type:"image",data:(await $1.executor.zoomRegion('), "zoom_moved.js");
    ok(r3.status !== 0 && /\[FAIL\] 5c zoom return/.test(r3.out) && !/\[PASS\]/.test(r3.out), "bundle whose zoom return moved: [FAIL] 5c, no [PASS]", r3.out.split("\n").filter((l) => /5c|PASS/.test(l)).join(" | "));
    const r4 = run(bundle.blob.replaceAll('"No applications are granted for this session. Call request_access first."', '"Nothing is granted yet. Call request_access first."'), "grant_moved.js");
    ok(r4.status !== 0 && /\[FAIL\] 5c screenshot returns are not in the handler/.test(r4.out) && !/\[PASS\]/.test(r4.out), "bundle whose screenshot handler moved: [FAIL] 5c, no [PASS]", r4.out.split("\n").filter((l) => /5c|PASS/.test(l)).join(" | "));
    const r5 = run(patched.replace(/\.\.\.\(process\.platform==="linux"&&globalThis\.__cdbCuShotNote\?\.\(__cdbZ\.base64\)\|\|\[\]\),/, ""), "half.js");
    ok(r5.status !== 0 && /half-patched input: .*missing: 5c zoom mask note/.test(r5.out), "bundle without 5c's zoom note: refused as half-patched", r5.out.split("\n").filter((l) => /FAIL/.test(l)).join(" | "));
    // Review 6: the second return must follow the helper that calls executor.screenshot().
    const r6 = run(bundle.blob.replace(/(async function [\w$]+\([\w$,]+\)\{let [\w$]+=await [\w$]+\.)screenshot(\(\{allowedBundleIds:)/, "$1capture$2"), "helper_moved.js");
    ok(r6.status !== 0 && /\[FAIL\] 5c screenshot returns are not in the handler/.test(r6.out) && !/\[PASS\]/.test(r6.out), "bundle whose screenshot() helper moved: [FAIL] 5c, no [PASS]", r6.out.split("\n").filter((l) => /5c|PASS/.test(l)).join(" | "));
    // 5d: teach_step keeps a refused screenshot's text.
    ok(/\[OK\] 5d teach-step: a refused screenshot \([\w$]+\) keeps its text after the step results on Linux/.test(r1.out), "5d reported [OK]");
    const r7 = run(bundle.blob.replace(/return ([\w$]+)\.isError\?([\w$]+)\(([\w$]+)\):\{content:\[\{type:"text",text:JSON\.stringify\(\3\)\},\.\.\.\1\.content\],screenshot:\1\.screenshot\}\}/, "return $1.isError?$2($3,void 0):{content:[{type:\"text\",text:JSON.stringify($3)},...$1.content],screenshot:$1.screenshot}}"), "teach_moved.js");
    ok(r7.status !== 0 && /\[FAIL\] 5d teach-step screenshot answer/.test(r7.out) && !/\[PASS\]/.test(r7.out), "bundle whose teach-step answer moved: [FAIL] 5d, no [PASS]", r7.out.split("\n").filter((l) => /5d|PASS/.test(l)).join(" | "));
  }
}

// ── our executor on a Hyprland session with a fake wlroots-bridge ──────────
const R = (x, y, width, height) => ({ x, y, width, height });
const PNG = "QUJD"; // what the fake bridge returns as the image
const DISPLAYS = [{ id: 21, label: "DP-1", bounds: R(0, 0, 1920, 1080), size: { width: 1920, height: 1080 }, workArea: R(0, 0, 1920, 1080), scaleFactor: 1, nativeOrigin: { x: 0, y: 0 } }];
const SCREENS = [{ id: "DP-1", name: "DP-1", geometry: R(0, 0, 1920, 1080), scale: 1, is_primary: true, is_shared: true }];
const base = { window_role: null, window_type: "normal", is_dock: false, is_desktop: false, is_visible: true, is_minimized: false, is_normal_window: true, is_dialog: false, transient: false, transient_for: null, stacking_order: 0, is_active: false, exclude_from_capture: false, keep_above: false };
const ww = (id, appId, title, g, extra = {}) => ({ ...base, id: String(id), title, geometry: g, pid: 2000 + id, desktop_file_name: appId, resource_class: appId, resource_name: null, output: "DP-1", ...extra });
const WINS = [
  ww(11, "firefox", "Secret page - Mozilla Firefox", R(0, 0, 960, 1080), { stacking_order: 1 }),
  ww(12, "foot", "ssh prod", R(800, 0, 1120, 1080), { stacking_order: 5, is_active: true }),
  ww(13, "com.anthropic.Claude", "Claude main window", R(1200, 100, 600, 600), { pid: process.pid, stacking_order: 3 }),
  ww(14, "org.gnome.Nautilus", "Downloads folder", R(0, 0, 800, 600), { is_visible: false }),
  ww(15, "signal", "Chat with Bob", R(0, 0, 800, 600), { is_visible: false, is_minimized: true }),
  ww(16, "chromium", "Some site - Chromium", R(100, 100, 800, 600), { stacking_order: 2 }),
];
const HYPR_DOCTOR = { contract: 1, bridge: "wlroots-bridge", version: "0.3.0", backend: "wlroots", session_match: true, backend_reachable: true, backend_error: null, session_supported: false, restore_token_present: false, restore_token_path: null, daemon_running: false, session_socket: null, compositor: "hyprland", window_geometry: true, screenshot_mask: true, screenshot_mask_gaps: ["popups_outside_window"], screenshot_mask_mode: "toplevel", screenshot_mask_protocol: "ext-image-copy-capture-v1" };
const keepIds = (args) => { const k = []; for (let i = 0; i < args.length; i++) if (args[i] === "--keep-window") k.push(args[i + 1]); return k; };
// A wlroots-bridge masked zoom answer. per[id] overrides each kept entry;
// o.capture / o.regions / o.legacy (no shown fields) shape the report.
function wlReport(args, wins, per = {}, o = {}) {
  const keep = keepIds(args);
  const all = args.includes("--mask-all");
  const kept = keep.map((id) => {
    const w = wins.find((v) => v.id === id);
    const e = { id, appId: w.desktop_file_name, title: w.title, visible: w.is_visible !== false };
    if (!o.legacy) { e.shown = e.visible; if (!e.shown) e.reason = w.is_minimized ? "minimized" : "other_workspace"; e.coveredBy = []; }
    return { ...e, ...(per[id] || {}) };
  });
  const regions = o.regions !== undefined ? o.regions : kept.some((k) => k.shown !== false && k.visible !== false) ? [R(0, 0, 100, 100)] : [];
  const mask = { mode: all ? "all" : "keep", kept, regions };
  if (o.capture !== undefined) mask.capture = o.capture; else if (!o.legacy) mask.capture = "toplevel";
  return { base64: PNG, width: 1280, height: 720, mask };
}

const ENV_KEYS = ["SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE", "NIRI_SOCKET", "COWORK_SCREENSHOT_CMD", "X11_BRIDGE_BIN", "WLROOTS_BRIDGE_BIN", "GNOME_PORTAL_BRIDGE_BIN", "KWIN_PORTAL_BRIDGE_BIN", "YDOTOOL_SOCKET", "WAYLAND_DISPLAY", "DISPLAY", "CHROME_DESKTOP", "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE", "XDG_RUNTIME_DIR", "XDG_DATA_HOME", "XDG_DATA_DIRS", "CDB_CU_DEBUG"];
const baseGlobals = new Set(Object.keys(globalThis));
function resetWorld() {
  for (const k of Object.keys(globalThis)) if (!baseGlobals.has(k)) delete globalThis[k];
  for (const k of ENV_KEYS) delete process.env[k];
}
// session: "hypr" (wlroots-bridge) | "x11" (x11-bridge).
// zoom(args) -> report object | Error; windows: list or () => list.
function makeRig({ session = "hypr", windows = WINS, doctor, zoom }) {
  resetWorld();
  const rig = { calls: [], diag: [] };
  const x11 = session === "x11";
  const env = x11 ? { XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "XFCE", DISPLAY: ":0" } : { XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "Hyprland", WAYLAND_DISPLAY: "wayland-1", HYPRLAND_INSTANCE_SIGNATURE: "abc" };
  Object.assign(process.env, env, { PATH: BIN, HOME, XDG_DATA_HOME: path.join(TMP, "nohome"), XDG_DATA_DIRS: path.join(TMP, "share"), XDG_RUNTIME_DIR: TMP, CHROME_DESKTOP: "com.anthropic.Claude.desktop" });
  const doc = doctor || (x11 ? { contract: 1, bridge: "x11-bridge", version: "0.1.0", backend: "x11", session_match: true, backend_reachable: true, backend_error: null, session_supported: false, restore_token_present: false, restore_token_path: null, daemon_running: false, session_socket: null, capabilities: { screenshot_mask: true, screenshot_mask_ignore: true, compositing: true } } : HYPR_DOCTOR);
  const list = () => (typeof windows === "function" ? windows() : windows);
  const reply = (b, args) => {
    switch (args[0]) {
      case "doctor": return J(doc);
      case "windows": return J(list());
      case "screens": return J(SCREENS);
      case "frontmost-app": { const w = list().find((v) => v.is_active); return J(w ? { bundleId: w.desktop_file_name || w.resource_class, displayName: w.title } : null); }
      case "app-under-point": return "null";
      case "zoom": {
        if (!zoom) throw Object.assign(new Error("zoom not stubbed"), { status: 1 });
        const z = zoom(args, list());
        if (z instanceof Error) throw z;
        return J(z);
      }
      default: return J({ ok: true });
    }
  };
  const known = new Set([x11 ? "x11-bridge" : "wlroots-bridge"]);
  const cp = {
    execFileSync(bin, args) { const b = path.basename(String(bin)); if (b === "systemd-detect-virt") return "none\n"; if (!known.has(b)) throw Object.assign(new Error("not found: " + b), { status: 127 }); rig.calls.push(b + " " + args.join(" ")); return reply(b, args); },
    execSync() { throw new Error("no shell"); },
    spawnSync() { return { status: 1, stdout: "", stderr: "" }; },
    execFile(bin, args, opts, cb) { const c = typeof opts === "function" ? opts : cb; const b = path.basename(String(bin)); let out, err = null; if (!known.has(b)) err = Object.assign(new Error("not found: " + b), { code: "ENOENT" }); else { rig.calls.push(b + " " + args.join(" ")); try { out = reply(b, args); } catch (e) { err = e; } } setTimeout(() => c(err, out || "", err ? String(err.message) : ""), 0); return { on() {}, kill() {} }; },
    spawn() { rig.calls.push("SPAWN"); return { on() {}, unref() {}, stdout: { on() {} }, stderr: { on() {} }, kill() {}, pid: 0 }; },
  };
  const electron = {
    app: { commandLine: { getSwitchValue: () => "" }, getPath: () => path.join(TMP, "ud"), getName: () => "Claude" },
    screen: { getAllDisplays: () => DISPLAYS, getPrimaryDisplay: () => DISPLAYS[0], getCursorScreenPoint: () => ({ x: 10, y: 10 }), getDisplayNearestPoint: () => DISPLAYS[0], getDisplayMatching: () => DISPLAYS[0] },
    desktopCapturer: { getSources: async () => { rig.calls.push("desktopCapturer"); return []; } },
    clipboard: { readText: () => "", writeText: () => {} },
    nativeImage: {},
    BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  };
  const req = (id) => { const m = { child_process: cp, electron, path, os, fs: deskFs, crypto: nodeRequire("node:crypto") }[id]; if (!m) throw new Error("unexpected require " + id); return m; };
  globalThis.__cdbDiag = (m) => rig.diag.push(String(m));
  globalThis.__cuKwinMode = false;
  globalThis[x11 ? "__cuX11BridgeBin" : "__cuWlrootsBridgeBin"] = x11 ? "/res/x11-bridge" : "/res/wlroots-bridge";
  globalThis.__cdbCuDialogOpen = () => false;
  new Function("process", readFileSync(DISPLAY_TARGET, "utf8"))(process);
  new Function("require", "process", readFileSync(EXEC, "utf8"))(req, process);
  new Function("process", readFileSync(CONSENT, "utf8"))(process);
  rig.ex = globalThis.__linuxExecutor;
  rig.zooms = () => rig.calls.filter((c) => / zoom /.test(c));
  return rig;
}
async function settle() { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); }

// Upstream's dispatcher over a cloud session context.
function cloudSession(D, rig, grants, gates = {}, extraCtx = {}) {
  const st = { selected: 0, lastShot: undefined };
  const adapter = {
    serverName: "computer-use", executor: rig.ex, isDisabled: () => false,
    logger: { silly() {}, debug() {}, info() {}, warn() {}, error() {} },
    ensureOsPermissions: async () => ({ granted: true }),
    getSubGates: () => ({ pixelValidation: false, clipboardPasteMultiline: true, mouseAnimation: false, hideBeforeAction: false, autoTargetDisplay: true, clipboardGuard: false, maskFailClosed: true, adaptiveResolution: true, ...gates }),
    cropRawPatch: () => null,
  };
  const ctx = () => ({ allowedApps: grants.slice(), grants: new D.Grants(grants.slice(), []), grantFlags: {}, userDeniedBundleIds: [], coordinateMode: "pixels", selectedDisplayId: st.selected, lastScreenshot: st.lastShot, onResolvedDisplayUpdated: (d) => { st.selected = d; }, onDisplayPinned: () => {}, displayPinnedByModel: false, ...extraCtx });
  return {
    async call(tool, input) {
      const r = await D.dispatch(adapter, tool, input, ctx());
      if (r.screenshot) { const { base64, ...dims } = r.screenshot; st.lastShot = { ...dims, base64: "" }; }
      const blocks = r.content || [];
      return { isError: !!r.isError, text: blocks.filter((b) => b.type === "text").map((b) => b.text).join(" | "), images: blocks.filter((b) => b.type === "image").length, blocks };
    },
  };
}
const grant = (bundleId, displayName) => ({ bundleId, displayName, grantedAt: 1000, tier: "full" });
const G = { firefox: grant("firefox", "Firefox"), files: grant("org.gnome.Nautilus", "Files"), signal: grant("signal", "Signal"), none: grant("org.example.NotRunning", "Not Running"), claude: grant("com.anthropic.Claude", "Claude") };
const shotLines = (rig) => rig.diag.filter((l) => l.startsWith("[claude-cu] screenshot: "));
// Model texts of a failed masked capture (no ids; the detail is in the log line).
const TXT_FAIL = "Screenshot not taken: the screen capture could not hide the apps that are not allowed, so nothing was captured. Take the screenshot again; if it keeps failing, ask the user.";
const TXT_SHIFT = "Screenshot not taken: the windows on the screen changed while it was being taken. Take the screenshot again.";
const said = (rig, t) => String(t || "") + " || " + rig.diag.join(" | ");
const settleP = async (p) => { try { return { v: await p }; } catch (e) { return { e }; } };
// The executor's note handoff (an executor without it hands out nothing).
const shotNote = (b) => (typeof globalThis.__cdbCuShotNote === "function" ? globalThis.__cdbCuShotNote(b) : []);
const show = (r) => (r.isError ? "ERROR " : "") + r.images + " image(s): " + r.text.slice(0, 400);

const NOT_TAKEN = /^Screenshot not taken: no window of the approved apps can be shown, so the image would be the grey mask alone\. /;
// What the model must never see: a title of any window.
const TITLES = WINS.map((w) => w.title);
const noTitle = (t) => !TITLES.some((x) => t.includes(x));

// ── [R] refusals through upstream's pristine dispatcher ────────────────────
const CASES = [
  {
    key: "a-legacy", label: "#329 (a): older bridge, output capture, the cut left nothing (regions [])",
    grants: [G.firefox], zoom: (a, w) => wlReport(a, w, {}, { legacy: true, regions: [] }),
    want: /"Firefox" is covered by something else on the screen - try open_application to bring it forward; if it stays covered, ask the user to move it out of the way\./,
    log: /not taken via wlroots-bridge \(mask keep, capture output, kept 1 window\(s\), shown 0, not shown: firefox \(covered\)\)/,
  },
  {
    key: "a-layer", label: "output capture, new bridge: covered by a full-output layer",
    grants: [G.firefox], zoom: (a, w) => wlReport(a, w, { 11: { shown: false, reason: "covered", coveredBy: ["layer:omarchy-notifications"] } }, { capture: "output", regions: [] }),
    want: /"Firefox" is covered by a desktop layer \("omarchy-notifications"\) - wait until it closes and take a screenshot again, or ask the user to close it\./,
    log: /not taken via wlroots-bridge \(mask keep, capture output, kept 1 window\(s\), shown 0, not shown: firefox \(covered by layer:omarchy-notifications\)\)/,
  },
  {
    key: "ws-min", label: "toplevel: one app on another workspace, one minimized",
    grants: [G.files, G.signal], zoom: (a, w) => wlReport(a, w),
    want: /"Files" is on another workspace - try open_application to bring it forward; if it stays hidden, ask the user to switch to that workspace\. "Signal" is minimized - try open_application to bring it forward; if it stays hidden, ask the user to restore its window\./,
    log: /not taken via wlroots-bridge \(mask keep, capture toplevel, kept 2 window\(s\), shown 0, not shown: org\.gnome\.Nautilus \(other_workspace\), signal \(minimized\)\)/,
  },
  {
    key: "failed", label: "toplevel: capture failed / other monitor / no reason",
    grants: [G.firefox, G.files, G.signal], zoom: (a, w) => wlReport(a, w, { 11: { shown: false, reason: "capture_failed" }, 14: { reason: "other_output" }, 15: { reason: undefined } }),
    want: /"Firefox" could not be captured - take the screenshot again, and ask the user if it keeps failing\. "Files" is on another monitor - use switch_display to capture that monitor\. "Signal" is minimized - try open_application to bring it forward; if it stays hidden, ask the user to restore its window\./,
  },
  {
    key: "b-nowin", label: "#329 (b): an approved app with no window - nothing captured",
    grants: [G.none], zoom: () => new Error("must not capture"),
    want: /"Not Running" has no open window - if it was just opened, wait a moment and take the screenshot again; otherwise open it with open_application, or ask the user to open it\./,
    log: /not taken via wlroots-bridge \(mask keep, kept 0 window\(s\), shown 0, not shown: org\.example\.NotRunning \(no_window\)\)/,
    noZoom: true,
  },
  {
    key: "claude-only", label: "only Claude itself approved - nothing captured",
    grants: [G.claude], zoom: () => new Error("must not capture"),
    exact: "Screenshot not taken: the only approved app is Claude itself, and Claude's own windows are never shown. Call request_access for the app to work in.",
    noZoom: true,
  },
];
if (D0) {
  console.log("\n[R] nothing approved is shown: the reason as the tool's error text, no image (upstream's pristine dispatcher)");
  for (const c of CASES) {
    for (const [path_, gates] of [["resolvePrepareCapture", {}], ["screenshot()", { autoTargetDisplay: false }]]) {
      try {
        const rig = makeRig({ zoom: c.zoom });
        await rig.ex.capabilitiesAsync(); await settle();
        rig.diag.length = 0; rig.calls.length = 0;
        const s = cloudSession(D0, rig, c.grants, gates);
        const r = await s.call("screenshot", {});
        const t = path_ === "screenshot()" ? r.text.replace(/^Error: /, "") : r.text;
        const good = c.exact ? t === c.exact : NOT_TAKEN.test(t) && c.want.test(t);
        ok(r.isError && r.images === 0 && good && noTitle(r.text), `${c.label} [${path_}]: error text, no image`, show(r));
        if (path_ === "resolvePrepareCapture") {
          console.log("      model: " + r.text);
          ok(!c.noZoom || rig.zooms().length === 0, `${c.label}: ${c.noZoom ? "no capture asked of the bridge" : "one capture"}`, J(rig.zooms()));
          const sl = shotLines(rig);
          ok(sl.length === 1 && (!c.log || c.log.test(sl[0])), `${c.label}: one [claude-cu] screenshot line with mode, capture, counts and reasons`, J(sl));
        }
      } catch (e) { ok(false, `${c.label} [${path_}] ran`, e && e.stack); }
    }
  }
  // zoom and computer_batch go through the same capture.
  try {
    let nothing = false;
    const rig = makeRig({ zoom: (a, w) => (nothing ? wlReport(a, w, { 11: { shown: false, reason: "covered", coveredBy: ["foot"] } }, { regions: [] }) : wlReport(a, w)) });
    await rig.ex.capabilitiesAsync(); await settle();
    const s = cloudSession(D0, rig, [G.firefox]);
    const r0 = await s.call("screenshot", {});
    ok(!r0.isError && r0.images === 1, "firefox shown: the screenshot is an image", show(r0));
    nothing = true;
    const z = await s.call("zoom", { region: [0, 0, 400, 300] });
    ok(z.isError && z.images === 0 && /^Tool "zoom" failed: Screenshot not taken: no window of the approved apps can be shown/.test(z.text) && /"Firefox" is covered by "Foot" - try open_application to bring it forward; if it stays covered, ask the user to move it out of the way\./.test(z.text), "zoom with nothing approved shown: error text naming the cover, no image", show(z));
    console.log("      model: " + z.text);
    const b = await s.call("computer_batch", { actions: [{ action: "screenshot" }] });
    ok(b.isError && b.images === 0 && /Screenshot not taken: no window of the approved apps can be shown/.test(b.text), "computer_batch [screenshot] with nothing approved shown: stops with the text, no image", show(b));
  } catch (e) { ok(false, "zoom / batch scenario ran", e && e.stack); }
  // Nothing granted: upstream refuses before it captures (unchanged).
  try {
    const rig = makeRig({ zoom: (a, w) => wlReport(a, w) });
    const s = cloudSession(D0, rig, []);
    const r = await s.call("screenshot", {});
    ok(r.isError && /No applications are granted for this session/.test(r.text) && rig.zooms().length === 0, "no grant at all: upstream's own refusal, no capture", show(r));
  } catch (e) { ok(false, "no-grant scenario ran", e && e.stack); }
}

// ── [N] notes through the patched dispatcher ───────────────────────────────
if (D5 && D0) {
  console.log("\n[N] some approved windows shown: the image plus the note (patched dispatcher)");
  const partial = (a, w) => wlReport(a, w, { 11: { coveredBy: ["foot", "layer:waybar", "com.anthropic.Claude"] } });
  const NOTE_TOP = "\"Firefox\" is shown whole. \"Foot\" and one of Claude's own windows are left out of this image but are in front of part of \"Firefox\" on the screen: a click on that part is refused.";
  const NOT_IN = "Not in this image: \"Signal\" is minimized - try open_application to bring it forward; if it stays hidden, ask the user to restore its window. \"Not Running\" has no open window - if it was just opened, wait a moment and take the screenshot again; otherwise open it with open_application, or ask the user to open it.";
  for (const [path_, gates] of [["resolvePrepareCapture", {}], ["screenshot()", { autoTargetDisplay: false }]]) {
    try {
      const rig = makeRig({ zoom: partial });
      await rig.ex.capabilitiesAsync(); await settle();
      rig.diag.length = 0;
      const s = cloudSession(D5, rig, [G.firefox, G.signal, G.none], gates);
      const r = await s.call("screenshot", {});
      const ours = r.blocks.filter((b) => b.type === "text" && (b.text.includes(NOTE_TOP) || b.text.startsWith("Not in this image")));
      const imgAt = r.blocks.findIndex((b) => b.type === "image");
      const noteAt = r.blocks.findIndex((b) => b.type === "text" && b.text.includes(NOTE_TOP));
      ok(!r.isError && r.images === 1 && ours.length === 1 && ours[0].text === NOTE_TOP + " " + NOT_IN && noteAt === imgAt - 1 && noTitle(r.text), `[${path_}] image + one note right before it: the cover of the shown window, and the approved apps not shown`, show(r));
      if (path_ === "resolvePrepareCapture") {
        console.log("      model: " + r.text);
        const sl = shotLines(rig);
        ok(sl.length === 1 && /captured via wlroots-bridge \(mask keep, capture toplevel, kept 2 window\(s\), shown 1, not shown: signal \(minimized\), org\.example\.NotRunning \(no_window\), covered: firefox by foot\+layer:waybar\+com\.anthropic\.Claude/.test(sl[0]), "one [claude-cu] line: counts, not shown with reasons, covered with what", J(sl));
        ok(J(shotNote(PNG)) === "[]", "the note is handed out once");
        const r2 = await cloudSession(D0, rig, [G.firefox, G.signal, G.none]).call("screenshot", {});
        ok(!r2.isError && r2.images === 1 && !r2.text.includes("Not in this image") && !r2.text.includes("is shown whole"), "pristine dispatcher: image without the note (why 5c exists)", show(r2));
      }
    } catch (e) { ok(false, `[${path_}] partial scenario ran`, e && e.stack); }
  }
  try {
    const rig = makeRig({ zoom: (a, w) => wlReport(a, w, { 11: { coveredBy: ["foot"] } }, { capture: "output" }) });
    await rig.ex.capabilitiesAsync(); await settle();
    const s = cloudSession(D5, rig, [G.firefox]);
    const r = await s.call("screenshot", {});
    ok(!r.isError && r.images === 1 && r.text.includes("Part of \"Firefox\" is covered on the screen by \"Foot\"; that part is painted over in this image.") && !r.text.includes("Not in this image"), "output capture: the covered part is painted over (wording), nothing missing", show(r));
    const z = await s.call("zoom", { region: [0, 0, 400, 300] });
    ok(!z.isError && z.images === 1 && z.blocks[0].type === "text" && z.blocks[0].text === "Part of \"Firefox\" is covered on the screen by \"Foot\"; that part is painted over in this image.", "zoom: the same note, before the image", show(z));
    const rig2 = makeRig({ zoom: (a, w) => wlReport(a, w) });
    await rig2.ex.capabilitiesAsync(); await settle();
    const r2 = await cloudSession(D5, rig2, [G.firefox]).call("screenshot", {});
    ok(!r2.isError && r2.images === 1 && r2.blocks.filter((b) => b.type === "text" && /shown whole|painted over|Not in this image/.test(b.text)).length === 0, "everything approved shown, nothing over it: no note", show(r2));
  } catch (e) { ok(false, "output / zoom note scenario ran", e && e.stack); }
  try {
    const rig = makeRig({ zoom: (a, w) => wlReport(a, w, { 11: { coveredBy: ["foot"] } }) });
    await rig.ex.capabilitiesAsync(); await settle();
    const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox"], preferredDisplayId: 0 });
    ok(J(shotNote("OTHER")) === "[]", "the note is not handed out for another image");
    ok(J(shotNote(r.base64)).includes("is shown whole"), "... and still is for its own");
    // Another capture in between (upstream's live preview / pixel check) does
    // not take the note away; more than 8 unclaimed notes drop the oldest.
    let n = 0;
    const rig3 = makeRig({ zoom: (a, w) => ({ ...wlReport(a, w, { 11: { coveredBy: ["foot"] } }), base64: "IMG" + ++n }) });
    const rA = await rig3.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox"], preferredDisplayId: 0 });
    const rB = await rig3.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox"], preferredDisplayId: 0 });
    ok(rA.base64 !== rB.base64 && J(shotNote(rA.base64)).includes("is shown whole") && J(shotNote(rB.base64)).includes("is shown whole"), "capture A, capture B, A's note: still A's (and B's for B)", J([rA.base64, rB.base64]));
    const many = [];
    for (let i = 0; i < 9; i++) many.push((await rig3.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox"], preferredDisplayId: 0 })).base64);
    ok(J(shotNote(many[0])) === "[]" && J(shotNote(many[8])).includes("is shown whole"), "at most 8 unclaimed notes: the oldest is dropped");
  } catch (e) { ok(false, "note handoff scenario ran", e && e.stack); }
}

// ── [teach] teach_step keeps a refused screenshot's text (5d) ──────────────
if (D5 && D0) {
  console.log("\n[teach] teach_step: a refused screenshot's text follows the step results (patched); upstream drops it");
  const nothing = (a, w) => wlReport(a, w, { 11: { shown: false, reason: "covered", coveredBy: ["foot"] } }, { regions: [] });
  for (const [D, patched] of [[D5, true], [D0, false]]) {
    try {
      const rig = makeRig({ zoom: nothing });
      await rig.ex.capabilitiesAsync(); await settle();
      const s = cloudSession(D, rig, [G.firefox], {}, { onTeachStep: async () => ({ action: "next" }) });
      const r = await s.call("teach_step", { explanation: "Look at the window", next_preview: "Then click", actions: [{ action: "cursor_position" }] });
      const has = /Screenshot not taken: no window of the approved apps can be shown/.test(r.text);
      ok(r.images === 0 && /"executed":1/.test(r.text) && has === patched, patched ? "patched: step results, then the refusal text, no image" : "pristine: the step results only (the limit 5d lifts)", show(r));
      if (patched) console.log("      model: " + r.text);
    } catch (e) { ok(false, "teach_step scenario ran", e && e.stack); }
  }
}

// ── [K] kept[].pid and mask.children (toplevel capture, Hyprland) ──────────
console.log("\n[K] kept[].pid and mask.children are checked against the kept windows");
{
  const kid = (k, extra = {}) => ({ ...k, pid: 2011, ...extra });
  const child = (o = {}) => ({ address: "0x55fb66b46420", pid: 2011, parent: "11", rect: R(23, 292, 258, 172), ...o });
  const rep = (kept, children, skipped) => (a, w) => { const r = wlReport(a, w); r.mask.kept = r.mask.kept.map((k) => kid(k, kept)); if (children !== undefined) r.mask.children = children; if (skipped !== undefined) r.mask.childrenSkipped = skipped; return r; };
  for (const [label, zoom, re] of [
    ["kept pid not a number", rep({ pid: "2011" }), /has a pid that is not a number/],
    ["children not a list", rep({}, {}), /its children are not a list/],
    ["a child without a rect", rep({}, [child({ rect: null })]), /a child entry is malformed/],
    ["a child of a window that was not asked for", rep({}, [child({ parent: "16" })]), /it drew a child of window 16, which is not a shown kept window/],
    ["a child of a kept window that is not shown", (a, w) => { const r = rep({}, [child()])(a, w); r.mask.kept[0].shown = false; r.mask.kept[0].reason = "covered"; r.mask.regions = []; return r; }, /it drew a child of window 11, which is not a shown kept window/],
    ["a child whose pid is not its parent's", rep({}, [child({ pid: 4242 })]), /whose pid does not match that window's/],
    ["a child while the kept window has no pid (older bridge)", rep({ pid: null }, [child()]), /whose pid does not match that window's/],
    ["childrenSkipped not a number", rep({}, [], "1"), /its childrenSkipped is not a number/],
  ]) {
    const rig = makeRig({ zoom });
    const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox"], preferredDisplayId: 0 });
    ok(r.base64 === "" && (r.captureError === TXT_FAIL || r.captureError === TXT_SHIFT) && re.test(said(rig, r.captureError)), label + ": discarded (plain text, the detail in the log)", said(rig, r.captureError));
  }
  const rig = makeRig({ zoom: rep({}, [child()], 1) });
  const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox"], preferredDisplayId: 0 });
  ok(r.base64 === PNG && /, children 1 \(1 skipped\)/.test(shotLines(rig).join("")), "a child of the shown kept window with its pid: the image, counted in the log line", J([r.captureError, shotLines(rig)]));
  const rig2 = makeRig({ zoom: rep({ pid: null }) });
  const r2 = await rig2.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox"], preferredDisplayId: 0 });
  ok(r2.base64 === PNG, "no children, no pid (older bridge): the image as before", r2.captureError);
}

// ── [T] Omarchy web app / TUI grants (app identity, js "Web apps") ─────────
if (D0) {
  console.log("\n[T] an Omarchy web app / TUI grant keeps its own window; when it cannot be told apart, the text names the app that has it");
  const ytW = ww(21, "chrome-youtube.com__-Default", "Watch later - YouTube", R(0, 0, 900, 900), { pid: 2022 });
  const duaW = ww(22, "TUI.float", "dua i /", R(900, 0, 900, 900), { pid: 2021 });
  for (const [label, wins, grants, check, zf] of [
    ["YouTube granted: its --app window is kept, the browser's own window is not", [...WINS, ytW], [grant("YouTube", "YouTube")], (r, rig) => !r.isError && r.images === 1 && /--keep-window 21$/.test(rig.zooms()[0] || "")],
    // Terminal apps never own a window (see js "Terminal apps"): the class is
    // shared and nothing proves at capture time which terminal is which.
    ["Disk Usage granted, its TUI.float window: never kept, the text names the terminal", [...WINS, duaW], [grant("Disk Usage", "Disk Usage")],
      (r, rig) => r.isError && r.images === 0 && rig.zooms().length === 0 && r.text.endsWith("\"Disk Usage\" has no window of its own on screen - a window that may be it belongs to \"Foot\" here; to work in it, request access to \"Foot\" (that covers every window of \"Foot\").")],
    // Review B1: dua (22) and btop (23, its own terminal process) share TUI.float;
    // the bridge's ids shifted, kept 22 is btop at capture time. btop must never reach the model.
    ["review B1: a shifted wlroots id with two TUI.float terminals: nothing kept, no image", [...WINS, duaW, ww(23, "TUI.float", "btop", R(0, 0, 500, 500), { pid: 2023 })], [grant("Disk Usage", "Disk Usage")],
      (r, rig) => r.isError && r.images === 0 && rig.zooms().length === 0, (a, w) => { const r = wlReport(a, w); r.mask.kept = r.mask.kept.map((k) => ({ ...k, title: "btop" })); return r; }],
    ["a shifted wlroots id naming another site's app window: discarded", [...WINS, ytW], [grant("YouTube", "YouTube")],
      (r, rig) => r.isError && r.images === 0 && r.text === TXT_SHIFT && rig.zooms().length === 2 && /is not a window of an allowed app any more/.test(said(rig)), (a, w) => { const r = wlReport(a, w); r.mask.kept = r.mask.kept.map((k) => ({ ...k, appId: "chrome-x.com__-Default", title: "x" })); return r; }],
    ["Disk Usage granted, two TUI.float windows of one terminal process: refused, the text names the terminal", [...WINS, duaW, ww(23, "TUI.float", "btop", R(0, 0, 500, 500), { pid: 2021 })], [grant("Disk Usage", "Disk Usage")],
      (r, rig) => r.isError && r.images === 0 && rig.zooms().length === 0 && r.text.endsWith("\"Disk Usage\" has no window of its own on screen - a window that may be it belongs to \"Foot\" here; to work in it, request access to \"Foot\" (that covers every window of \"Foot\").")],
    ["YouTube granted, its window's class does not fit the URL: refused, the text names the browser", [...WINS, ww(24, "chrome-youtube.com_feed-Default", "Feed - YouTube", R(0, 0, 900, 900), { pid: 2022 })], [grant("YouTube", "YouTube")],
      (r, rig) => r.isError && r.images === 0 && rig.zooms().length === 0 && r.text.endsWith("\"YouTube\" has no window of its own on screen - a window that may be it belongs to \"Chromium\" here; to work in it, request access to \"Chromium\" (that covers every window of \"Chromium\").") && noTitle(r.text) && !r.text.includes("Feed - YouTube")],
  ]) {
    try {
      const rig = makeRig({ windows: wins, zoom: zf || ((a, w) => wlReport(a, w)) });
      await rig.ex.capabilitiesAsync(); await settle();
      const r = await cloudSession(D0, rig, grants).call("screenshot", {});
      ok(check(r, rig), label, show(r) + " | " + J(rig.zooms()));
      if (r.isError) console.log("      model: " + r.text);
    } catch (e) { ok(false, label + " ran", e && e.stack); }
  }
}

// ── [F] real wlroots-bridge reports (Omarchy VM, Hyprland 0.56.2, scale 1) ─
// The `mask` objects as the issue-#329 bridge printed them (ids / app ids
// mapped onto this harness's Firefox window): output capture under a popup,
// the older bridge under a popup, toplevel under a popup and fullscreen under
// the bar (layer entries only), another workspace.
if (D5) {
  console.log("\n[F] real bridge reports through the patched dispatcher");
  const real = (m) => (a, w) => { const k = keepIds(a)[0]; const v = w.find((x) => x.id === k); return { base64: PNG, width: 1280, height: 720, mask: { ...m, kept: m.kept.map((e) => ({ ...e, id: k, appId: v.desktop_file_name, title: v.title })) } }; };
  for (const [label, m, want] of [
    ["s1-c2-popover-out (output, cut left nothing)", { mode: "keep", capture: "output", kept: [{ id: "x", appId: "t1a", title: "KEPT-A", visible: true, shown: false, reason: "covered", coveredBy: ["layer:omarchy-notifications"] }], regions: [] }, (r) => r.isError && r.images === 0 && r.text.endsWith("\"Firefox\" is covered by a desktop layer (\"omarchy-notifications\") - wait until it closes and take a screenshot again, or ask the user to close it.")],
    ["s1-c2-popover-old (older bridge, regions [])", { mode: "keep", kept: [{ id: "x", appId: "t1a", title: "KEPT-A", visible: true }], regions: [] }, (r) => r.isError && r.images === 0 && /"Firefox" is covered by something else on the screen/.test(r.text)],
    ["s1-c2-popover-ext (toplevel, a layer meets the window)", { mode: "keep", capture: "toplevel", kept: [{ id: "x", appId: "t1a", title: "KEPT-A", visible: true, shown: true, coveredBy: ["layer:omarchy-notifications"] }], regions: [R(967, 560, 941, 508)] }, (r) => !r.isError && r.images === 1 && !/shown whole|painted over|Not in this image/.test(r.text)],
    ["s1-c7-fullscreen-ext (toplevel, the bar meets a fullscreen window)", { mode: "keep", capture: "toplevel", kept: [{ id: "x", appId: "t1a", title: "KEPT-A", visible: true, shown: true, coveredBy: ["layer:omarchy-bar"] }], regions: [R(0, 0, 1920, 1080)] }, (r) => !r.isError && r.images === 1 && !/shown whole|painted over|Not in this image/.test(r.text)],
    ["s1-c5-floatover-ext (toplevel, another window in front)", { mode: "keep", capture: "toplevel", kept: [{ id: "x", appId: "t1a", title: "KEPT-A", visible: true, shown: true, coveredBy: ["foot"] }], regions: [R(967, 560, 941, 508)] }, (r) => !r.isError && r.images === 1 && r.text.includes("\"Firefox\" is shown whole. \"Foot\" is left out of this image but is in front of part of \"Firefox\" on the screen: a click on that part is refused.")],
    ["s1-c9-onlyother-ext (toplevel, other workspace)", { mode: "keep", capture: "toplevel", kept: [{ id: "x", appId: "t1a", title: "KEPT-A", visible: false, shown: false, reason: "other_workspace", coveredBy: [] }], regions: [] }, (r) => r.isError && r.images === 0 && r.text.endsWith("\"Firefox\" is on another workspace - try open_application to bring it forward; if it stays hidden, ask the user to switch to that workspace.")],
    ["toplevel covered (hidden tab, the window drawn instead named)", { mode: "keep", capture: "toplevel", kept: [{ id: "x", appId: "t1a", title: "KEPT-A", visible: true, shown: false, reason: "covered", coveredBy: ["foot"] }], regions: [] }, (r) => r.isError && r.images === 0 && r.text.endsWith("\"Firefox\" is covered by \"Foot\" - try open_application to bring it forward; if it stays covered, ask the user to move it out of the way.")],
  ]) {
    try {
      const rig = makeRig({ zoom: real(m) });
      await rig.ex.capabilitiesAsync(); await settle();
      const r = await cloudSession(D5, rig, [G.firefox]).call("screenshot", {});
      ok(want(r), label, show(r));
    } catch (e) { ok(false, label + " ran", e && e.stack); }
  }
}

// ── [V] the bridge report is validated, fail closed ────────────────────────
console.log("\n[V] the bridge report: every new field checked by type, the image discarded otherwise");
const WINS2 = [...WINS, ww(17, "firefox", "Second - Mozilla Firefox", R(960, 0, 960, 1080), { stacking_order: 4 })];
for (const [label, wins, zoom, re] of [
  ["a shown entry for a window that was not asked for", WINS, (a, w) => { const r = wlReport(a, w); r.mask.kept = [{ id: "16", appId: "chromium", title: "x", visible: true, shown: true, coveredBy: [] }]; return r; }, /kept window 16 \(chromium\) is not a window of an allowed app any more - the image was discarded/],
  ["shown is not a boolean", WINS, (a, w) => wlReport(a, w, { 11: { shown: "yes" } }), /kept window 11 has no shown flag/],
  ["shown on one entry, missing on another", WINS2, (a, w) => wlReport(a, w, { 17: { shown: undefined } }), /kept window 17 has no shown flag/],
  ["coveredBy is a string", WINS, (a, w) => wlReport(a, w, { 11: { coveredBy: "foot" } }), /has a coveredBy that is not a list of strings/],
  ["coveredBy holds a number", WINS, (a, w) => wlReport(a, w, { 11: { coveredBy: [1] } }), /has a coveredBy that is not a list of strings/],
  ["reason is a number", WINS, (a, w) => wlReport(a, w, { 11: { shown: false, reason: 5 } }), /has a reason that is not a string/],
  ["unknown capture kind", WINS, (a, w) => wlReport(a, w, {}, { capture: "window" }), /unknown capture kind "window"/],
  ["shown while reported not visible", WINS, (a, w) => wlReport(a, w, { 11: { visible: false } }), /it showed window 11, which it reported not visible/],
  ["shown but no region", WINS, (a, w) => wlReport(a, w, {}, { regions: [] }), /it showed 1 window\(s\) but reported no region/],
  ["regions not a list", WINS, (a, w) => wlReport(a, w, {}, { regions: "all" }), /its regions are not a list/],
  ["older bridge without regions", WINS, (a, w) => { const r = wlReport(a, w, {}, { legacy: true }); delete r.mask.regions; return r; }, /it reported neither shown windows nor regions/],
  ["the same window twice", WINS2, (a, w) => { const r = wlReport(a, w); r.mask.kept[1] = { ...r.mask.kept[0] }; return r; }, /it reported window 11 twice/],
]) {
  try {
    const rig = makeRig({ windows: wins, zoom });
    const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox"], preferredDisplayId: 0 });
    ok(r.base64 === "" && (r.captureError === TXT_FAIL || r.captureError === TXT_SHIFT) && re.test(said(rig, r.captureError)) && !rig.calls.includes("desktopCapturer"), label + ": discarded, no other capture tier (plain text, the detail in the log)", said(rig, r.captureError));
  } catch (e) { ok(false, label + " ran", e && e.stack); }
}
{
  // mask.capture missing = output; shown missing everywhere (older bridge) and regions given = visible ones shown.
  const rig = makeRig({ zoom: (a, w) => wlReport(a, w, {}, { legacy: true }) });
  const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox"], preferredDisplayId: 0 });
  ok(r.base64 === PNG && r.captureError === undefined && /capture output, kept 1 window\(s\), shown 1\b/.test(shotLines(rig).join("")), "older bridge (no shown, no capture) with regions: the image, read as output capture", J([r.captureError, shotLines(rig)]));
  const rig2 = makeRig({ zoom: (a, w) => wlReport(a, w, {}, { capture: null }) });
  const r2 = await rig2.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox"], preferredDisplayId: 0 });
  ok(r2.base64 === PNG && /capture output/.test(shotLines(rig2).join("")), "mask.capture null = output", J(shotLines(rig2)));
}

// ── [S] a report that disagrees with the window list is retried once ──────
console.log("\n[S] ids shifted between `windows` and the capture: one retry with a fresh window list");
{
  const wrong = (a, w) => { const r = wlReport(a, w); r.mask.kept = r.mask.kept.map((k) => ({ ...k, appId: "com.anthropic.Claude", title: "Claude" })); return r; };
  let n = 0;
  const rig = makeRig({ zoom: (a, w) => (++n === 1 ? wrong(a, w) : wlReport(a, w)) });
  const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox"], preferredDisplayId: 0 });
  const wl = rig.calls.filter((c) => / windows$/.test(c)).length;
  ok(r.base64 === PNG && r.captureError === undefined && rig.zooms().length === 2 && wl === 2, "first report names Claude's window for the asked id, second is right: the image, after a fresh window list and a second capture", J([r.captureError, rig.zooms().length, wl]));
  ok(shotLines(rig).some((l) => /not taken via wlroots-bridge \(mask: kept window 11 \(com\.anthropic\.Claude\) is not a window of an allowed app any more - the image was discarded\) - the report disagrees with the window list: listing the windows again and capturing once more$/.test(l)), "the first attempt is logged with its detail", J(shotLines(rig)));
  const rig2 = makeRig({ zoom: wrong });
  const r2 = await rig2.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox"], preferredDisplayId: 0 });
  ok(r2.base64 === "" && r2.captureError === TXT_SHIFT && rig2.zooms().length === 2 && !/\d{4,}|com\.|bridge/.test(r2.captureError), "wrong twice: the plain text, no image, no ids, two captures", J([r2.captureError, rig2.zooms().length]));
  ok(shotLines(rig2).some((l) => / - again on the second attempt$/.test(l)), "the second failure is logged", J(shotLines(rig2)));
  const rig3 = makeRig({ zoom: (a, w) => wlReport(a, w, { 11: { shown: "yes" } }) });
  const r3 = await rig3.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox"], preferredDisplayId: 0 });
  ok(r3.captureError === TXT_FAIL && rig3.zooms().length === 1, "a malformed report is not retried", J([r3.captureError, rig3.zooms().length]));
  if (D0) {
    let m = 0;
    const rig4 = makeRig({ zoom: (a, w) => (++m === 1 ? wrong(a, w) : wlReport(a, w)) });
    await rig4.ex.capabilitiesAsync(); await settle();
    const s4 = await cloudSession(D0, rig4, [G.firefox]).call("screenshot", {});
    ok(!s4.isError && s4.images === 1 && rig4.zooms().length === 2, "through upstream's dispatcher: one screenshot call, the retried image", show(s4));
    const rig5 = makeRig({ zoom: wrong });
    await rig5.ex.capabilitiesAsync(); await settle();
    const s5 = await cloudSession(D0, rig5, [G.firefox]).call("screenshot", {});
    ok(s5.isError && s5.images === 0 && s5.text === TXT_SHIFT, "through upstream's dispatcher, wrong twice: the plain text", show(s5));
  }
}

// ── [G] upstream's "Entire screen" pseudo-grant is not an app ──────────────
if (D5) {
  console.log("\n[G] com.anthropic.cu.screen is left out of rows, notes and refusals");
  const SCR = { bundleId: "com.anthropic.cu.screen", displayName: "Entire screen", grantedAt: 1000, tier: "read" };
  {
    const rig = makeRig({ zoom: (a, w) => wlReport(a, w) });
    await rig.ex.capabilitiesAsync(); await settle();
    const r = await cloudSession(D5, rig, [G.firefox, SCR]).call("screenshot", {});
    ok(!r.isError && r.images === 1 && !/cu\.screen|Entire screen|Not in this image/.test(r.text), "Firefox + the pseudo-grant: the image, no row for the pseudo-grant", show(r));
  }
  {
    const rig = makeRig({ zoom: (a, w) => wlReport(a, w) });
    await rig.ex.capabilitiesAsync(); await settle();
    const r = await cloudSession(D5, rig, [G.signal, SCR]).call("screenshot", {});
    ok(r.isError && r.images === 0 && r.text.endsWith("\"Signal\" is minimized - try open_application to bring it forward; if it stays hidden, ask the user to restore its window.") && !/cu\.screen/.test(r.text), "Signal (minimized) + the pseudo-grant: the refusal names Signal only", show(r));
  }
  {
    const rig = makeRig({ zoom: (a, w) => wlReport(a, w) });
    const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["com.anthropic.cu.screen"], preferredDisplayId: 0 });
    ok(r.base64 === PNG && /--mask-all$/.test(rig.zooms()[0] || ""), "only the pseudo-grant: --mask-all, as before (no app was named)", J([r.captureError, rig.zooms()]));
  }
}

// ── [W] review fixes before the commit (S3, S4, F2, F7) ────────────────────
console.log("\n[W] capture-time pid, cover names, zoom outside the shown windows, at most 5 rows");
{
  // S3: same app id, another process at capture time: the ids moved.
  const rig = makeRig({ zoom: (a, w) => wlReport(a, w, { 11: { pid: 4242 } }) });
  const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox"], preferredDisplayId: 0 });
  ok(r.base64 === "" && r.captureError === TXT_SHIFT && rig.zooms().length === 2 && /kept window 11 has pid 4242 at capture, 2011 in the window list/.test(said(rig)), "S3: kept[].pid differs from the listed window's: discarded as shifted, retried once", said(rig, r.captureError));
  const rigOk = makeRig({ zoom: (a, w) => wlReport(a, w, { 11: { pid: 2011 } }) });
  const rOk = await rigOk.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox"], preferredDisplayId: 0 });
  ok(rOk.base64 === PNG, "S3: the same pid: the image", rOk.captureError);
  // S4: a cover that is a Chromium app class: named by the app that owns the
  // listed window, withheld when nothing has an entry - never the site's host.
  const WA = "chrome-web.whatsapp.com__-Default";
  const rig2 = makeRig({ zoom: (a, w) => wlReport(a, w, { 11: { coveredBy: [WA] } }) });
  const r2 = await rig2.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox"], preferredDisplayId: 0 });
  const n2 = J(shotNote(r2.base64));
  ok(n2.includes("\\\"(name withheld)\\\" is left out of this image") && !/whatsapp|chrome-/.test(n2), "S4: a Chromium app class with no window listed and no entry: \"(name withheld)\"", n2);
  const rig3 = makeRig({ windows: [...WINS, ww(30, WA, "Chat - WhatsApp", R(500, 0, 900, 900), { pid: 2016 })], zoom: (a, w) => wlReport(a, w, { 11: { coveredBy: [WA] } }) });
  const r3 = await rig3.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox"], preferredDisplayId: 0 });
  const n3 = J(shotNote(r3.base64));
  ok(n3.includes("\\\"Chromium\\\" is left out of this image") && !/whatsapp|chrome-/.test(n3), "S4: the listed window of that class runs Chromium: \"Chromium\", as upstream's hidden-apps note names it", n3);
  // F2: a zoom that meets none of the shown windows (shown is per output).
  const rig4 = makeRig({ zoom: (a, w) => wlReport(a, w) });
  const z4 = await settleP(rig4.ex.zoom({ x: 1500, y: 100, w: 200, h: 200 }, ["firefox"], 0));
  ok(z4.e && /^Screenshot not taken: no window of the approved apps can be shown/.test(z4.e.message) && /"Firefox" is not in the zoomed area - zoom on a part of the last screenshot where it is\./.test(z4.e.message), "F2: wlroots zoom outside the shown window: refused, not in the zoomed area", z4.e ? z4.e.message : "image");
  const z5 = await settleP(rig4.ex.zoom({ x: 100, y: 100, w: 200, h: 200 }, ["firefox"], 0));
  ok(!z5.e && z5.v.base64 === PNG, "F2: a zoom on the shown window: the image", z5.e && z5.e.message);
  // F7: at most 5 apps in "Not in this image".
  const rig5 = makeRig({ zoom: (a, w) => wlReport(a, w) });
  const many = ["firefox", "signal", "org.gnome.Nautilus", "org.example.NotRunning", "org.example.Extra1", "org.example.Extra2", "org.example.Extra3", "org.example.Extra4"];
  const r5 = await rig5.ex.resolvePrepareCapture({ allowedBundleIds: many, preferredDisplayId: 0 });
  const n5 = (shotNote(r5.base64)[0] || {}).text || "";
  ok(r5.base64 === PNG && n5.startsWith("Not in this image: ") && (n5.match(/" (is|has) /g) || []).length === 5 && n5.endsWith(" And 2 more approved apps.") && !n5.includes("Extra Three"), "F7: 7 approved apps missing: 5 named, then \"And 2 more approved apps.\"", n5);
}

// ── [L] the doctor line ────────────────────────────────────────────────────
console.log("\n[L] the doctor line names how masked captures are made");
{
  const rig = makeRig({ zoom: (a, w) => wlReport(a, w) });
  await rig.ex.capabilitiesAsync(); await settle();
  ok(rig.diag.some((l) => /\[claude-cu\] wlroots-bridge capabilities: screenshot mask yes \(not covered: popups_outside_window\), window geometry yes, mask capture toplevel \(ext-image-copy-capture-v1\)$/.test(l)), "capabilities line: mask capture toplevel (ext-image-copy-capture-v1)", J(rig.diag));
  const rig2 = makeRig({ doctor: { ...HYPR_DOCTOR, screenshot_mask_mode: undefined, screenshot_mask_protocol: undefined }, zoom: (a, w) => wlReport(a, w) });
  await rig2.ex.capabilitiesAsync(); await settle();
  ok(rig2.diag.some((l) => /window geometry yes$/.test(l)), "older doctor: the line as before", J(rig2.diag));
}

// ── [X] x11-bridge and the empty allowlist ─────────────────────────────────
console.log("\n[X] x11-bridge unchanged; an allowlist without a window refuses; an empty one keeps --mask-all");
{
  const xw = (id, cls, g, extra = {}) => ({ ...base, id: String(id), title: cls + " secret", geometry: g, pid: 3000 + id, desktop_file_name: null, resource_class: cls, resource_name: cls.toLowerCase(), output: "DP-1", ...extra });
  const XW = [xw(101, "firefox", R(0, 0, 900, 900)), xw(102, "foot", R(500, 0, 900, 900))];
  const xReply = (a) => { const k = keepIds(a); return { base64: PNG, width: 1280, height: 720, mask: { mode: a.includes("--mask-all") ? "all" : "keep", fill: "#1E1E1E", kept: k, kept_hidden: [], kept_missing: [], auto_kept: [], masked: [{ id: "102" }], ignored: [], ignored_missing: [], ignored_refused: [] } }; };
  const rig = makeRig({ session: "x11", windows: XW, zoom: xReply });
  const r = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox"], preferredDisplayId: 0 });
  ok(r.base64 === PNG && J(r.hidden) === J(["foot"]) && J(shotNote(PNG)) === "[]", "x11 kept path: the image, hidden apps, no note", J([r.captureError, r.hidden]));
  ok(/^\[claude-cu\] screenshot: captured via x11-bridge \(mask keep, kept 1 window\(s\), masked apps foot\)$/.test(shotLines(rig).join("")), "x11 log line as before", J(shotLines(rig)));
  rig.calls.length = 0; rig.diag.length = 0;
  const r2 = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["org.example.NotRunning"], preferredDisplayId: 0 });
  ok(r2.base64 === "" && NOT_TAKEN.test(r2.captureError || "") && rig.zooms().length === 0, "x11, approved app without a window: refused with the reason, nothing captured (was --mask-all)", r2.captureError);
  rig.calls.length = 0;
  const r3 = await rig.ex.resolvePrepareCapture({ allowedBundleIds: [], preferredDisplayId: 0 });
  ok(r3.base64 === PNG && /--mask-all$/.test(rig.zooms()[0] || ""), "x11, empty allowlist: --mask-all as before", J(rig.zooms()));
  const rw = makeRig({ zoom: (a, w) => wlReport(a, w) });
  const r4 = await rw.ex.resolvePrepareCapture({ allowedBundleIds: [], preferredDisplayId: 0 });
  ok(r4.base64 === PNG && /--mask-all$/.test(rw.zooms()[0] || ""), "wlroots, empty allowlist: --mask-all as before", J(rw.zooms()));
  // x11-bridge reports which asked-for ids have pixels (kept), are viewable
  // without a pixel here (kept_hidden) or are not viewable (kept_missing).
  const XW2 = [xw(101, "firefox", R(0, 0, 900, 900), { stacking_order: 1 }), xw(102, "foot", R(500, 0, 900, 900), { stacking_order: 5 }), xw(103, "signal", R(0, 0, 400, 400), { is_minimized: true, is_visible: false }), xw(104, "org.gnome.Nautilus", R(0, 0, 400, 400), { is_visible: false }), xw(105, "chromium", R(5000, 0, 400, 400))];
  const xRep = (o) => (a) => { const k = keepIds(a); return { base64: PNG, width: 1280, height: 720, mask: { mode: "keep", fill: "#1E1E1E", kept: k.filter((id) => (o.kept || []).includes(id)), kept_hidden: k.filter((id) => (o.hidden || []).includes(id)).concat(o.extraHidden || []), kept_missing: k.filter((id) => (o.missing || []).includes(id)), auto_kept: [], masked: [{ id: "102" }], ignored: [], ignored_missing: [], ignored_refused: [] } }; };
  const rx1 = makeRig({ session: "x11", windows: XW2, zoom: xRep({ hidden: ["101", "105"], missing: ["103", "104"] }) });
  const x1 = await rx1.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox", "signal", "org.gnome.Nautilus", "chromium"], preferredDisplayId: 0 });
  ok(x1.base64 === "" && x1.captureError === "Screenshot not taken: no window of the approved apps can be shown, so the image would be the grey mask alone. \"Firefox\" is covered by \"Foot\" - try open_application to bring it forward; if it stays covered, ask the user to move it out of the way. \"Signal\" is minimized - try open_application to bring it forward; if it stays hidden, ask the user to restore its window. \"Files\" is on another workspace - try open_application to bring it forward; if it stays hidden, ask the user to switch to that workspace. \"Chromium\" is on another monitor - use switch_display to capture that monitor.", "x11, nothing kept has a pixel (was the grey image): refused, reasons from kept_hidden / kept_missing", x1.captureError);
  ok(/not taken via x11-bridge \(mask keep, kept 4 window\(s\), shown 0, not shown: firefox \(covered by foot\), signal \(minimized\), org\.gnome\.Nautilus \(other_workspace\), chromium \(other_output\)/.test(shotLines(rx1).join("")), "x11 refusal: one log line with the reasons", J(shotLines(rx1)));
  const rx2 = makeRig({ session: "x11", windows: XW2, zoom: xRep({ kept: ["101"], missing: ["103"] }) });
  const x2 = await rx2.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox", "signal"], preferredDisplayId: 0 });
  ok(x2.base64 === PNG && J(shotNote(PNG)) === J([{ type: "text", text: "Not in this image: \"Signal\" is minimized - try open_application to bring it forward; if it stays hidden, ask the user to restore its window." }]), "x11, one approved app shown: the image, the note names the one missing", J([x2.captureError, shotNote(PNG)]));
  const rx3 = makeRig({ session: "x11", windows: XW2, zoom: xRep({ kept: ["101"], extraHidden: ["102"] }) });
  const x3 = await rx3.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox"], preferredDisplayId: 0 });
  ok(x3.base64 === "" && x3.captureError === TXT_SHIFT && /it reported window 102, which was not asked for/.test(said(rx3, x3.captureError)), "x11, kept_hidden names a window that was not asked for: discarded", x3.captureError);
  // S5: no asked-for window has pixels but its own menu does (auto_kept): the app is in the image.
  const xRepA = (o) => (a) => { const z = xRep(o)(a); z.mask.auto_kept = o.auto || []; return z; };
  const rx4 = makeRig({ session: "x11", windows: XW2, zoom: xRepA({ hidden: ["101"], auto: ["77777"] }) });
  const x4 = await rx4.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox"], preferredDisplayId: 0 });
  ok(x4.base64 === PNG && x4.captureError === undefined && J(shotNote(PNG)) === "[]", "S5: x11 kept [] but auto_kept (the app's menu past its window): the image, no note", J([x4.captureError, shotNote(PNG)]));
  const rx5 = makeRig({ session: "x11", windows: XW2, zoom: (a) => { const z = xRep({ kept: ["101"] })(a); z.mask.auto_kept = "77777"; return z; } });
  const x5 = await rx5.ex.resolvePrepareCapture({ allowedBundleIds: ["firefox"], preferredDisplayId: 0 });
  ok(x5.base64 === "" && x5.captureError === TXT_FAIL, "S5: auto_kept not a list: discarded", x5.captureError);
  // S6: on the captured monitor but outside a zoom -> "not in the zoomed area";
  // on no captured monitor -> "on another monitor" (the chromium case above).
  const rx6 = makeRig({ session: "x11", windows: XW2, zoom: xRep({ hidden: ["101"] }) });
  const x6 = await settleP(rx6.ex.zoom({ x: 1500, y: 950, w: 200, h: 100 }, ["firefox"], 0));
  ok(x6.e && /"Firefox" is not in the zoomed area - zoom on a part of the last screenshot where it is\.$/.test(x6.e.message), "S6: x11 zoom on the right monitor away from the window: not in the zoomed area", x6.e ? x6.e.message : "image");
}

// ── [C] scripts/check-bridge-contract.sh --wlroots-caps ────────────────────
console.log("\n[C] the bridge contract check fails on a wlroots-bridge without the mask report");
{
  const PY = (spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8", env: ORIG_ENV }).stdout || "").trim();
  if (!PY) console.log("  SKIP python3 not found");
  else {
    const checker = path.join(repo, "scripts", "check-bridge-contract.sh");
    const d = scratchDir("contract");
    // A doctor as wlroots-bridge prints it without a compositor; extra = the
    // #329 keys; report = a string the binary carries for its zoom report.
    const stub = (dir, extra, report) => {
      mkdirSync(dir, { recursive: true });
      const f = path.join(dir, "wlroots-bridge");
      writeFileSync(f, `#!/bin/sh
# ${report}
case "$1" in
  --version) echo "wlroots-bridge 0.3.0" ;;
  doctor) printf '%s\\n' '{"contract":1,"bridge":"wlroots-bridge","version":"0.3.0","backend":"wlroots","session_match":false,"backend_reachable":false,"backend_error":"WAYLAND_DISPLAY is not set","session_supported":false,"restore_token_present":false,"restore_token_path":null,"daemon_running":false,"session_socket":null,"window_geometry":false,"screenshot_mask":false,"screenshot_mask_gaps":[]${extra}}' ;;
  session-end) echo '{"ok":true,"ended":false,"daemon":"none"}' ;;
  forget-session) echo '{"ok":true,"ended":false,"daemon":"none","token_removed":false,"token_path":null}' ;;
  screens|windows|session-start|pointer-move) for a in "$@"; do [ "$a" = --help ] && exit 0; done; exit 1 ;;
  *) echo "error: unrecognized subcommand '$1'" >&2; exit 2 ;;
esac
`, { mode: 0o755 });
      return f;
    };
    const runC = (...a) => spawnSync("bash", [checker, ...a], { encoding: "utf8", timeout: 60000, env: ORIG_ENV });
    const cur = stub(path.join(d, "cur"), ',"screenshot_mask_mode":null,"screenshot_mask_protocol":null', "coveredBy");
    const old = stub(path.join(d, "old"), "", "kept");
    const half = stub(path.join(d, "half"), ',"screenshot_mask_mode":null,"screenshot_mask_protocol":null', "kept");
    const bad = stub(path.join(d, "bad"), ',"screenshot_mask_mode":"window","screenshot_mask_protocol":null', "coveredBy");
    const topNoProto = stub(path.join(d, "tnp"), ',"screenshot_mask_mode":"toplevel","screenshot_mask_protocol":null', "coveredBy");
    let r = runC("--wlroots-caps", cur);
    ok(r.status === 0 && /2 passed, 0 failed/.test(r.stdout), "--wlroots-caps on a current wlroots-bridge (keys null without a compositor): exit 0", r.stdout);
    r = runC("--wlroots-caps", old);
    ok(r.status === 1 && /^FAIL wlroots-bridge: doctor mask mode - screenshot_mask_mode is missing/m.test(r.stdout) && /^FAIL wlroots-bridge: masked zoom report - the binary has no coveredBy/m.test(r.stdout), "--wlroots-caps on an older wlroots-bridge: exit 1, both named", r.stdout);
    r = runC("--wlroots-caps", half);
    ok(r.status === 1 && /no coveredBy/.test(r.stdout), "doctor keys without the per-window report: exit 1", r.stdout);
    r = runC("--wlroots-caps", bad);
    ok(r.status === 1 && /screenshot_mask_mode must be "toplevel", "output" or null/.test(r.stdout), "an unknown mask mode: exit 1", r.stdout);
    r = runC("--wlroots-caps", topNoProto);
    ok(r.status === 1 && /needs a screenshot_mask_protocol/.test(r.stdout), "toplevel without a protocol: exit 1", r.stdout);
    r = runC(path.join(d, "old"));
    ok(r.status === 1 && /^FAIL wlroots-bridge: doctor mask mode/m.test(r.stdout), "the directory check runs it for wlroots-bridge too", r.stdout.split("\n").filter((l) => /FAIL|bridge\(s\)/.test(l)).join(" | "));
    r = runC(path.join(d, "cur"));
    ok(r.status === 0 && /1 bridge\(s\): \d+ passed, 0 failed/.test(r.stdout), "... and passes a current one", r.stdout.split("\n").filter((l) => /FAIL|bridge\(s\)/.test(l)).join(" | "));
  }
}

resetWorld();
console.log(`\n${pass} passed, ${failures.length} failed${bundle ? "" : " (dispatcher sections skipped)"}`);
if (failures.length) { for (const f of failures) console.log("  - " + f); process.exit(1); }
process.exit(bundle ? 0 : SKIP_EXIT);
