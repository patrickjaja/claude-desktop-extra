#!/usr/bin/env node
// Computer Use on a background display (issue #300): selection, env overlay
// and fail-closed gates in js/cu_linux_executor.js (+ the setting reader in
// js/cu_mode_preamble.js and the gate in js/cu_handler_injection.js).
//
// Settings -> Extra -> Cowork (Linux) -> "Computer Use on a background display"
// stores computerUseBackgroundDisplay = {enabled, kind: "x11"|"wlroots",
// display, env?} in <userData>/claude-desktop-extra.jsonc (wins) or .json.
// When it is on, Computer Use acts on that display only:
//   - only the target's bridge runs (x11-bridge for x11, wlroots-bridge for
//     wlroots), whatever the desktop session is;
//   - every bridge spawn gets the overlay env (target display var set, the
//     other one unset, GDK_BACKEND / QT_QPA_PLATFORM cleared, XDG_SESSION_TYPE
//     matching, the env map applied);
//   - nothing falls back to the user's desktop: no ydotool, spectacle,
//     desktopCapturer, GNOME portal session, Electron clipboard;
//   - an invalid setting, a missing bridge or a display that does not answer
//     `screens` refuses every tool call; teach mode is refused;
//   - the setting is latched per CU lock; the preamble forces the regular
//     executor (no kwin mode).
// Switch off / key absent: the same bridge as before, and no spawn gets an
// `env` option at all (inherit, as before).
//
// CU_EXECUTOR / CU_PREAMBLE / CU_KWIN_EXECUTOR=<file> run the checks against other copies.
// Exit codes follow the repo convention: 0 = PASS, other = FAIL.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EXECUTOR = process.env.CU_EXECUTOR || path.join(ROOT, "js", "cu_linux_executor.js");
const SRC = readFileSync(EXECUTOR, "utf8");
// Section 8c compares against a committed golden, cu-path-baseline.json: the
// spawns of origin/master's executor while upstream's PATH narrowing is not in
// effect. Regenerate it (only when that base changes on purpose) with
//   git show origin/master:js/cu_linux_executor.js > /tmp/base.js
//   CU_EXECUTOR=/tmp/base.js node scripts/tests/linux/test-cu-target-session.mjs --record
const GOLDEN = path.join(ROOT, "scripts", "tests", "linux", "cu-path-baseline.json");
const RECORD = process.argv.includes("--record");
const PREAMBLE = readFileSync(process.env.CU_PREAMBLE || path.join(ROOT, "js", "cu_mode_preamble.js"), "utf8");
// Read now: makeRig() replaces process.env.
const KWIN_EXECUTOR = process.env.CU_KWIN_EXECUTOR || path.join(ROOT, "js", "executor_linux.js");
const HANDLER = readFileSync(path.join(ROOT, "js", "cu_handler_injection.js"), "utf8").trim();

let pass = 0, fail = 0;
// A clock offset: the executor shares one settings check per 200 ms, so a test
// that changes the files and calls again advances time first (tick()).
let NOW_OFF = 0;
const RAW_NOW = Date.now.bind(Date);
Date.now = () => RAW_NOW() + NOW_OFF;
const tick = () => { NOW_OFF += 1000; };
function check(cond, label, extra) {
  if (cond) { pass++; console.log("  PASS " + label); return; }
  const x = extra === undefined ? "" : String(extra);
  fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + (x.length > 1500 ? x.slice(0, 1500) + "..." : x) : ""));
}
async function settle(p) { try { return { v: await p }; } catch (e) { return { e }; } }

const DISPLAYS = [{ id: 1, label: "one", bounds: { x: 0, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, nativeOrigin: { x: 0, y: 0 } }];
const SCREENS = [{ name: "SCREEN", id: "SCREEN", geometry: { x: 0, y: 0, width: 1920, height: 1080 }, is_primary: true }];
const HOSTS = {
  x11: { XDG_CURRENT_DESKTOP: "XFCE", XDG_SESSION_TYPE: "x11", DISPLAY: ":0" },
  wlroots: { XDG_CURRENT_DESKTOP: "sway", XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":0", SWAYSOCK: "/run/user/1000/sway.sock" },
  gnome: { XDG_CURRENT_DESKTOP: "ubuntu:GNOME", XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
  // KDE Wayland served by the regular executor (KWin < 6.6): ydotool + spectacle installed.
  kde: { XDG_CURRENT_DESKTOP: "KDE", XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }
};
const HOST_BRIDGE = { x11: "x11-bridge", wlroots: "wlroots-bridge", gnome: "gnome-portal-bridge", kde: "x11-bridge" };
const BASE_ENV = { HOME: "/home/u", PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: "/run/user/1000", GDK_BACKEND: "wayland", QT_QPA_PLATFORM: "wayland", KEEP_ME: "1" };

// The setting reader (+ the own-display identity check when present), spliced
// out of the preamble and run against the rig's files.
const readerSrc = PREAMBLE.match(/(?:if\(!globalThis\.__cuTargetIdentity\)[\s\S]*?\n  \};\n)?(?:  \/\/[^\n]*\n)*  if\(!globalThis\.__cuTargetRead\)globalThis\.__cuTargetRead=function\(\)\{[\s\S]*?\n  \};\n(?:(?:  \/\/[^\n]*\n)*  if\(!globalThis\.__cuTargetSig\)\{[\s\S]*?\n  \}\n)?/);
// Wayland sockets in the stub fs (inode per socket) and symlinked dirs: the
// aliases /var/run -> /run and /proc/self/root/ -> / resolve like the kernel.
const SOCKETS = { "/run/user/1000/wayland-0": 10, "/run/user/1000/wayland-1": 11, "/run/user/1000/wayland-7": 17, "/run/user/1000/wayland-9": 19, "/tmp/cutest/alias-own": 11, "/tmp/cutest/rt/wayland-9": 11 };
// /proc/<pid>/stat of the stub process tree: 4243 is a child of the launched 4242.
const PROCS = { 4243: "4243 (weird app) S 4242 4243 4242 0 -1" };
// LINKS: symlinked dirs (link path -> absolute target), set per rig (opts.links);
// LINK_UIDS: their owners (opts.linkUids, default root).
let LINKS = {}, LINK_UIDS = {};
const realpath = (p) => { let s = String(p); s = s.replace(/^\/proc\/self\/root\//, "/").replace(/^\/var\/run\//, "/run/"); if (s === "/tmp/cutest/link-to-own") s = "/run/user/1000/wayland-0"; for (let n = 0, hit = true; hit && n < 10; n++) { hit = false; for (const [a, b] of Object.entries(LINKS)) { if (s === a || s.startsWith(a + "/")) { s = b + s.slice(a.length); hit = true; break; } } } return s; };
// Directory owners for upstream's trust rule (lstat uid 0 + W_OK fails with
// EACCES/EROFS), ancestors included. ro: "EROFS" (read-only mount) or
// "EACCES"; null = writable by us. opts.dirs adds or overrides entries.
const DIRS = {
  "/": { uid: 0, ro: "EACCES" }, "/usr": { uid: 0, ro: "EACCES" }, "/usr/bin": { uid: 0, ro: "EACCES" }, "/bin": { uid: 0, ro: "EACCES" },
  "/usr/local": { uid: 0, ro: "EACCES" }, "/usr/local/bin": { uid: 0, ro: "EACCES" }, "/nix": { uid: 0, ro: "EACCES" }, "/nix/store": { uid: 0, ro: "EROFS" },
  "/home": { uid: 0, ro: "EACCES" }, "/home/u": { uid: 1000, ro: null }, "/home/u/.local": { uid: 1000, ro: null }, "/home/u/.local/bin": { uid: 1000, ro: null }
};

// files: {"name": text}; host: key of HOSTS; opts.screens(bin) -> array | Error.
function makeRig(host, files = {}, opts = {}) {
  const spawns = [], diag = [], dc = [], clip = [], screenCalls = [], stdin = [];
  // state.windows(launched) -> the bridge `windows` list; launched = an app
  // was spawned. state.clipErr: stderr of a failing clipboard read.
  const state = { reads: 0, stats: 0, files, screens: opts.screens || (() => SCREENS), zoomFail: opts.zoomFail || false, windows: opts.windows || (() => []), launched: false, clipErr: null, throwScreen: false, ydotoold: opts.ydotoold !== false };
  const reply = (bin, args) => {
    const b = path.basename(String(bin)), sub = args[0];
    if (/^(xclip|xsel|wl-paste)$/.test(b)) { if (state.clipErr) { const e = new Error("Command failed: " + b); e.code = 1; e.stderr = state.clipErr; throw e; } if (state.clipLag > 0) { state.clipLag--; return "old"; } return state.clipVal !== undefined ? state.clipVal : "clip:" + b; }
    // A target that went away: every bridge call fails the way a dead X server / compositor does.
    if (state.dead && /-bridge$/.test(b)) { const e = new Error("Command failed: " + b + " " + args.join(" ") + "\nError: cannot connect to the display"); e.code = 1; throw e; }
    if (sub === "cursor-position") return JSON.stringify({ x: 11, y: 22 });
    if (sub === "screens") { const s = state.screens(b); if (s instanceof Error) throw s; return JSON.stringify(s); }
    if (sub === "zoom") { if (state.zoomFail) { const e = new Error("Command failed: zoom\nError: capture failed"); e.code = 1; throw e; } return JSON.stringify({ base64: "AA:" + b, width: 100, height: 50 }); }
    if (sub === "windows") { const w = state.windows(state.launched); if (w instanceof Error) throw w; return JSON.stringify(w); }
    if (sub === "frontmost-app") return "null";
    return "{}";
  };
  const rec = (kind, bin, args, o) => spawns.push({ kind, bin: path.basename(String(bin)), raw: String(bin), args: (args || []).join(" "), opts: o || {} });
  const cp = {
    execFileSync(bin, args, o) {
      const b = path.basename(String(bin));
      if (b === "systemd-detect-virt") return "none\n";
      rec("sync", bin, args, o);
      if (b === "pgrep") { if (!state.ydotoold) { const e = new Error("Command failed: pgrep"); e.status = 1; throw e; } return "1\n"; }
      if (b === "ydotool" || b === "spectacle" || b === "convert") return "";
      return reply(bin, args);
    },
    execSync(c, o) { rec("execSync", c, [], o); return ""; },
    spawnSync(b, a, o) { rec("spawnSync", b, a, o); return { status: 1 }; },
    execFile(bin, args, o, cb) {
      rec("async", bin, args, o);
      setTimeout(() => { let out; try { out = reply(bin, args); } catch (e) { cb(e, "", String(e.stderr || e.message)); return; } cb(null, out, ""); }, 0);
    },
    spawn(b, a, o) {
      rec("spawn", b, a, o);
      const bn = path.basename(String(b));
      if (bn !== "xclip" && bn !== "xsel" && bn !== "wl-copy") state.launched = true;
      const c = new EventEmitter();
      c.unref = () => {}; c.kill = () => {}; c.pid = 4242;
      c.stdin = { on() {}, end: (t) => { stdin.push(bn + ":" + t); state.clipVal = String(t); setImmediate(() => c.emit("exit", 0, null)); } };
      setImmediate(() => c.emit("spawn"));
      return c;
    }
  };
  const electron = {
    app: { getPath: () => "/ud", commandLine: { getSwitchValue: () => "" } },
    // throwScreen: target-mode assertions - any use of the user's screen is recorded and throws.
    screen: new Proxy({ getAllDisplays: () => opts.displays || DISPLAYS, getPrimaryDisplay: () => (opts.displays || DISPLAYS)[0], getCursorScreenPoint: () => ({ x: 7, y: 7 }) }, {
      get(t, k) { const f = t[k]; return typeof f !== "function" ? f : (...a) => { if (state.throwScreen || state.recordScreen) screenCalls.push(String(k)); if (state.throwScreen) { throw new Error("electron.screen." + String(k) + " used in target mode"); } return f(...a); }; }
    }),
    desktopCapturer: { getSources: async (o) => { dc.push(o); return []; } },
    clipboard: { readText: async () => { clip.push("read"); return "host"; }, writeText: async (t) => { clip.push("write:" + t); } },
    nativeImage: {}
  };
  const installed = new Set(["/usr/bin/ydotool", "/usr/bin/spectacle", "/usr/bin/convert", "/res/wlroots-bridge", "/res/x11-bridge",
    "/usr/bin/setsid", "/usr/bin/gedit", "/usr/bin/gio", "/usr/bin/gtk-launch", "/usr/bin/kioclient6", "/usr/bin/exo-open", "/usr/bin/xdg-open", ...(opts.installed || [])]);
  for (const p of opts.uninstalled || []) installed.delete(p);
  const APPS = { "gedit.desktop": "[Desktop Entry]\nType=Application\nName=Gedit\nExec=gedit %U\n", "top.desktop": "[Desktop Entry]\nType=Application\nName=Top\nExec=top\nTerminal=true\n", ...(opts.apps || {}) };
  LINKS = opts.links || {}; LINK_UIDS = opts.linkUids || {};
  const dirs = { ...DIRS, ...(opts.dirs || {}) };
  const enoent = (p) => { const e = new Error("ENOENT: " + p); e.code = "ENOENT"; return e; };
  const fsStub = {
    constants: { X_OK: 1, W_OK: 2 },
    readFileSync: (p) => { if (path.dirname(String(p)) === "/ud") state.reads++; if (/^\/proc\/\d+\/stat$/.test(String(p))) { const pid = +String(p).split("/")[2]; if (pid in PROCS) return PROCS[pid]; const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; } const n = path.basename(String(p)); if (String(p).startsWith("/usr/share/applications/") && n in APPS) return APPS[n]; if (n in state.files) { const f = state.files[n]; if (f instanceof Error) throw f; return f; } if (path.dirname(String(p)) === "/ud") { const e = new Error("ENOENT: " + p); e.code = "ENOENT"; throw e; } return Buffer.alloc(0); },
    existsSync: (p) => { const s = String(p); if (path.dirname(s) === "/ud") return path.basename(s) in state.files; return s.endsWith("/gnome-portal-bridge/session.sock") || s.endsWith(".ydotool_socket"); },
    writeFileSync() {}, unlinkSync() {}, renameSync() {},
    accessSync(p, mode) {
      if (mode === 2) { const d = dirs[String(p)]; if (!d) throw enoent(p); if (d.ro) { const e = new Error(d.ro + ": " + p); e.code = d.ro; throw e; } return; }
      if (!installed.has(String(p)) && !installed.has(realpath(p)) && !(String(p).endsWith(".ydotool_socket") && state.ydotoold)) throw new Error("ENOENT");
    },
    lstatSync(p) {
      const k = String(p);
      if (k in LINKS) return { uid: k in LINK_UIDS ? LINK_UIDS[k] : 0, isDirectory: () => false, isSymbolicLink: () => true };
      const d = dirs[k]; if (d) return { uid: d.uid, isDirectory: () => true, isSymbolicLink: () => false };
      if (installed.has(k)) return { uid: 0, isDirectory: () => false, isSymbolicLink: () => false };
      throw enoent(p);
    },
    readlinkSync(p) { if (String(p) in LINKS) return LINKS[String(p)]; const e = new Error("EINVAL: " + p); e.code = "EINVAL"; throw e; },
    realpathSync(p) { const r = realpath(p); if (!dirs[r] && !installed.has(r)) throw enoent(p); return r; },
    readdirSync: (d) => String(d) === "/usr/share/applications" ? Object.keys(APPS) : [],
    // Settings files: a content-derived signature (ino/size/mtime stand-ins), so
    // writing a file changes what the executor's stat sees.
    promises: { stat: async (p) => fsStub.statSync(p) },
    statSync(p) {
      if (path.dirname(String(p)) === "/ud") {
        const n = path.basename(String(p));
        if (!(n in state.files)) { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; }
        const f = state.files[n], t = f instanceof Error ? f.message : String(f);
        let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
        state.stats++;
        return { ino: 7, size: t.length, mtimeMs: h, isSocket: () => false, isDirectory: () => false };
      }
      const r = realpath(p);
      if (r in SOCKETS) return { dev: 1, ino: SOCKETS[r], isSocket: () => true, isDirectory: () => false };
      if (r === "/tmp/cutest/plainfile") return { dev: 1, ino: 99, isSocket: () => false, isDirectory: () => false };
      if (installed.has(r)) return { dev: 1, ino: 50, isSocket: () => false, isDirectory: () => false };
      const e = new Error("ENOENT: " + r); e.code = "ENOENT"; throw e;
    }
  };
  const requireStub = (id) => ({ child_process: cp, electron, path, os, fs: fsStub })[id] || (() => { throw new Error("unexpected require " + id); })();
  globalThis.__cdbDiag = (m) => { diag.push(String(m)); if (process.env.CU_TEST_DEBUG) console.log("    DIAG " + m); };
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, BASE_ENV, HOSTS[host], opts.env || {});
  process.resourcesPath = "/res";
  delete globalThis.__cuX11BridgeBin; delete globalThis.__cuWlrootsBridgeBin; delete globalThis.__cuGnomeBridgeBin;
  delete globalThis.__cuTargetRead; delete globalThis.__cuTargetIdentity; delete globalThis.__cuTgtJsoncDiag; delete globalThis.__cuTargetSig; delete globalThis.__cuTargetSigSync; globalThis.__cuBridgeFail = {};
  globalThis.__cuKwinMode = false;
  // What the preamble resolves on each host (x11-bridge on every session).
  globalThis.__cuX11BridgeBin = "/res/x11-bridge";
  if (host === "wlroots") globalThis.__cuWlrootsBridgeBin = "/res/wlroots-bridge";
  if (host === "gnome") globalThis.__cuGnomeBridgeBin = "/res/gnome-portal-bridge";
  if (readerSrc) new Function("_rp", "_rfs", "require", "process", readerSrc[0])(path, fsStub, requireStub, process);
  new Function("require", "process", opts.src || SRC)(requireStub, process);
  const ex = globalThis.__linuxExecutor;
  const reset = () => { spawns.length = 0; diag.length = 0; dc.length = 0; clip.length = 0; screenCalls.length = 0; stdin.length = 0; state.launched = false; };
  return { ex, spawns, diag, dc, clip, state, reset, screenCalls, stdin };
}

const cfg = (v) => JSON.stringify({ computerUseBackgroundDisplay: v });
const bins = (r) => [...new Set(r.spawns.map((s) => s.bin))].sort();
const noEnvKey = (r) => r.spawns.every((s) => !Object.prototype.hasOwnProperty.call(s.opts, "env"));
async function drive(ex) {
  // A representative tool mix: capture, input, enumeration.
  const out = {};
  out.shot = await settle(ex.screenshot({ displayId: 0 }));
  out.zoom = await settle(ex.zoom({ x: 10, y: 10, w: 100, h: 50 }, 1, 0));
  out.click = await settle(ex.click(100, 100, "left", 1));
  out.key = await settle(ex.key("ctrl+c", 1));
  out.type = await settle(ex.type("abc", { viaClipboard: false }));
  out.scroll = await settle(ex.scroll(100, 100, 0, 3));
  out.apps = await settle(ex.listRunningApps());
  out.front = await settle(ex.getFrontmostApp());
  return out;
}

// ---------------------------------------------------------------- 1. switch off
for (const host of Object.keys(HOSTS)) {
  for (const [label, files] of [["key absent", {}], ["enabled:false", { "claude-desktop-extra.json": cfg({ enabled: false, kind: "x11", display: ":99" }) }]]) {
    console.log(`\n[off: ${host}, ${label}]`);
    const r = makeRig(host, files);
    r.reset();
    await r.ex.__setLockHeld(true);
    const o = await drive(r.ex);
    const want = HOST_BRIDGE[host];
    const used = bins(r).filter((b) => /-bridge$/.test(b));
    check(used.length === 1 && used[0] === want, `only the desktop's bridge (${want})`, JSON.stringify(bins(r)));
    check(noEnvKey(r), "no spawn carries an env option", JSON.stringify(r.spawns.filter((s) => "env" in s.opts).map((s) => s.bin + " " + s.args)));
    if (host === "gnome") check(r.spawns.some((s) => s.args === "session-start"), "GNOME lock still starts the portal session");
    if (host === "kde") check(r.spawns.some((s) => s.bin === "pgrep" || s.bin === "ydotool"), "KDE (regular executor) still probes ydotool");
    check(!o.shot.e && !o.click.e, "screenshot and click work", o.shot.e ? o.shot.e.message : o.click.e && o.click.e.message);
    const tc = typeof r.ex.__targetCheck === "function" ? await r.ex.__targetCheck("screenshot") : null;
    check(tc === null, "no refusal when off");
    check(!r.diag.some((d) => /target=/.test(d)), "no target diagnostics when off");
  }
}

// -------------------------------------------------------- 2. enabled, x11 target
for (const host of Object.keys(HOSTS)) {
  for (const target of [{ kind: "x11", display: ":99", env: { XAUTHORITY: "/tmp/xa" } }, { kind: "wlroots", display: "wayland-9" }]) {
    console.log(`\n[target ${target.kind} ${target.display} on ${host}]`);
    const r = makeRig(host, { "claude-desktop-extra.jsonc": "// mine\n{\n  \"computerUseBackgroundDisplay\": " + JSON.stringify({ enabled: true, ...target }) + ", // trailing\n}\n" }, { env: { COWORK_SCREENSHOT_CMD: "" } });
    const tb = target.kind === "x11" ? "x11-bridge" : "wlroots-bridge";
    r.reset();
    await r.ex.__setLockHeld(true);
    check(r.spawns.length >= 1 && r.spawns[0].bin === tb && r.spawns[0].args === "screens", "lock acquire checks the display with `screens`", JSON.stringify(r.spawns.map((s) => s.bin + " " + s.args)));
    const o = await drive(r.ex);
    check(bins(r).length === 1 && bins(r)[0] === tb, `only ${tb} runs`, JSON.stringify(bins(r)));
    check(!o.shot.e && o.shot.v && o.shot.v.base64 === "AA:" + tb, "screenshot comes from the target bridge", o.shot.e ? o.shot.e.message : JSON.stringify(o.shot.v));
    for (const k of ["click", "key", "type", "scroll"]) check(!o[k].e, k + " goes through", o[k].e && o[k].e.message);
    // Exact overlay.
    const own = target.kind === "x11" ? "DISPLAY" : "WAYLAND_DISPLAY", other = target.kind === "x11" ? "WAYLAND_DISPLAY" : "DISPLAY";
    const want = { ...BASE_ENV, ...HOSTS[host], COWORK_SCREENSHOT_CMD: "", ...(target.env || {}) };
    delete want.GDK_BACKEND; delete want.QT_QPA_PLATFORM; delete want[other]; delete want.SWAYSOCK;
    // The toolkit pins (live-measured, T4 review HIGH): x11 -> X11 everywhere +
    // an empty WAYLAND_SOCKET (no libwayland fallback to wayland-0); wlroots ->
    // Electron's ozone hint.
    Object.assign(want, target.kind === "x11"
      ? { GDK_BACKEND: "x11", QT_QPA_PLATFORM: "xcb", SDL_VIDEODRIVER: "x11", ELECTRON_OZONE_PLATFORM_HINT: "x11", MOZ_ENABLE_WAYLAND: "0", WAYLAND_SOCKET: "" }
      : { ELECTRON_OZONE_PLATFORM_HINT: "wayland" });
    want[own] = target.display; want.XDG_SESSION_TYPE = target.kind === "x11" ? "x11" : "wayland";
    const envs = r.spawns.map((s) => s.opts.env);
    check(envs.length > 0 && envs.every((e) => e && JSON.stringify(Object.entries(e).sort()) === JSON.stringify(Object.entries(want).sort())), "every spawn carries exactly the overlay env", JSON.stringify(envs.find((e) => !e || JSON.stringify(Object.entries(e).sort()) !== JSON.stringify(Object.entries(want).sort()))));
    check(!r.spawns.some((s) => /^(ydotool|pgrep|spectacle|convert|gnome-portal-bridge)$/.test(s.bin)), "no ydotool / spectacle / GNOME portal spawn");
    // Capture failure: no desktop tier behind the bridge.
    r.state.zoomFail = true; r.reset();
    const f = await settle(r.ex.screenshot({ displayId: 0 }));
    check(f.e && /background display/.test(f.e.message), "a failed capture fails, naming the background display", f.e ? f.e.message : "resolved");
    check(r.dc.length === 0 && !r.spawns.some((s) => /spectacle|convert/.test(s.bin)) && r.spawns.every((s) => s.bin === tb), "no desktopCapturer / spectacle / other bridge after it", JSON.stringify({ dc: r.dc.length, bins: bins(r) }));
    r.state.zoomFail = false;
    // Clipboard: the Electron (desktop) clipboard is never touched.
    r.reset();
    const rc = await settle(r.ex.readClipboard()), wc = await settle(r.ex.writeClipboard("x")), tc = await settle(r.ex.type("x", { viaClipboard: true }));
    check(rc.e && wc.e && tc.e && r.clip.length === 0, "clipboard tools refused, desktop clipboard untouched", JSON.stringify(r.clip));
    // GNOME task boundary / default display never reach the portal.
    r.reset();
    await r.ex.__cuTaskBoundary(null, "renderer", null);
    const dd = await r.ex.__defaultDisplayId();
    check(r.spawns.length === 0 && dd === null, "task boundary / default display: no portal call", JSON.stringify(r.spawns.map((s) => s.bin + " " + s.args)));
    // COWORK_SCREENSHOT_CMD runs with the overlay.
    process.env.COWORK_SCREENSHOT_CMD = "true {FILE}";
    r.reset();
    await settle(r.ex.screenshot({ displayId: 0 }));
    const cw = r.spawns.find((s) => s.kind === "execSync");
    check(cw && cw.opts.env && cw.opts.env[own] === target.display && !(other in cw.opts.env), "COWORK_SCREENSHOT_CMD gets the overlay env", JSON.stringify(cw && cw.opts));
    process.env.COWORK_SCREENSHOT_CMD = "";
    const td = typeof r.ex.__targetCheck === "function" ? await r.ex.__targetCheck("teach_step") : null;
    check(typeof td === "string" && /Teach mode is not available/.test(td), "teach refused by the executor gate", String(td));
    if (host === "gnome") check(!r.spawns.some((s) => s.args === "session-start"), "GNOME: no portal session-start");
  }
}

console.log("\n[wlroots target with env.DISPLAY keeps it]");
{
  const r = makeRig("x11", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "wlroots", display: "/run/user/1000/wayland-7", env: { DISPLAY: ":7" } }) });
  r.reset();
  await r.ex.__setLockHeld(true);
  await settle(r.ex.click(1, 1, "left", 1));
  const e = r.spawns.length && r.spawns[r.spawns.length - 1].opts.env;
  check(e && e.DISPLAY === ":7" && e.WAYLAND_DISPLAY === "/run/user/1000/wayland-7" && e.XDG_SESSION_TYPE === "wayland", "env map DISPLAY survives, socket path display set", JSON.stringify(e && { D: e.DISPLAY, W: e.WAYLAND_DISPLAY, T: e.XDG_SESSION_TYPE }));
  check(bins(r).join() === "wlroots-bridge", "bundled wlroots-bridge resolved on an X11 desktop", JSON.stringify(bins(r)));
}

// ------------------------------------------------------- 3. refusal (fail closed)
const DOWN = "Computer Use is set to the background display :99, which is not running. Start it, or turn off Settings -> Extra -> Cowork (Linux) -> Computer Use on a background display.";
for (const [label, files, screens, rx] of [
  ["display down (screens fails)", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "x11", display: ":99" }) }, () => new Error("Command failed: x11-bridge screens\nError: cannot open display :99"), null],
  ["display answers no monitors", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "x11", display: ":99" }) }, () => [], null],
  ["invalid kind", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "weston", display: ":99" }) }, () => SCREENS, /setting is invalid: kind/],
  ["env sets PATH", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "x11", display: ":99", env: { PATH: "/evil" } }) }, () => SCREENS, /setting is invalid: env may not set PATH/],
  ["env sets LD_PRELOAD", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "x11", display: ":99", env: { LD_PRELOAD: "/x.so" } }) }, () => SCREENS, /env may not set LD_PRELOAD/],
  ["own desktop display", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "x11", display: ":0" }) }, () => SCREENS, /your own desktop/],
  ["broken display string", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "x11", display: "localhost:99" }) }, () => SCREENS, /not a valid x11 display/]
]) {
  for (const host of ["gnome", "kde"]) {
    console.log(`\n[refuse: ${label} on ${host}]`);
    const r = makeRig(host, files, { screens });
    r.reset();
    await r.ex.__setLockHeld(true);
    const tc = typeof r.ex.__targetCheck === "function" ? await r.ex.__targetCheck("screenshot") : null;
    check(rx ? rx.test(tc || "") : tc === DOWN, "tool calls get the refusal text", String(tc));
    const before = r.spawns.length;
    const o = await drive(r.ex);
    check(["shot", "zoom", "click", "key", "type", "scroll"].every((k) => o[k].e), "executor methods throw instead of acting", JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.e ? "err" : "ok"]))));
    check(r.spawns.length === before && r.dc.length === 0 && r.clip.length === 0, "no spawn, no desktopCapturer, no clipboard after the refusal", JSON.stringify(r.spawns.slice(before).map((s) => s.bin + " " + s.args)));
    check(!r.spawns.some((s) => /gnome-portal-bridge|ydotool|pgrep|spectacle/.test(s.bin)), "never the desktop's backends");
    check(r.diag.some((d) => /\[claude-cu\] diagnostics: target=/.test(d)), "diagnostics: target= line logged");
  }
}

// Own display (spec ruling "T8 review, SEVERITY 1"): never probed or driven,
// whatever spelling or alias names it.
const OWN = /your own desktop|not a valid x11 display/;
for (const [label, host, target, extraEnv, rx] of [
  [":00 (leading zero, X11 desktop :0)", "x11", { kind: "x11", display: ":00" }, {}, /not a valid x11 display/],
  [":098 (leading zero)", "x11", { kind: "x11", display: ":098" }, {}, /not a valid x11 display/],
  [":0 vs DISPLAY=unix:0.0", "x11", { kind: "x11", display: ":0" }, { DISPLAY: "unix:0.0" }, /your own desktop/],
  [":10 vs DISPLAY=localhost:10.0", "x11", { kind: "x11", display: ":10" }, { DISPLAY: "localhost:10.0" }, /your own desktop/],
  [":0 = XWayland of a Wayland desktop", "wlroots", { kind: "x11", display: ":0" }, {}, /your own desktop/],
  ["/var/run alias of the own socket", "wlroots", { kind: "wlroots", display: "/var/run/user/1000/wayland-1" }, {}, /your own desktop/],
  ["/proc/self/root alias of the own socket", "wlroots", { kind: "wlroots", display: "/proc/self/root/run/user/1000/wayland-1" }, {}, /your own desktop/],
  ["symlink to the own socket", "gnome", { kind: "wlroots", display: "/tmp/cutest/link-to-own" }, {}, /your own desktop/],
  ["hard link (same inode) of the own socket", "wlroots", { kind: "wlroots", display: "/tmp/cutest/alias-own" }, {}, /your own desktop/],
  ["own socket name with XDG_RUNTIME_DIR unset", "wlroots", { kind: "wlroots", display: "/run/user/1000/wayland-1" }, { XDG_RUNTIME_DIR: "" }, /cannot tell whether|your own desktop/],
  ["not a socket", "x11", { kind: "wlroots", display: "/tmp/cutest/plainfile" }, {}, /not a Wayland socket/],
  ["env map XDG_RUNTIME_DIR: wayland-9 there aliases the own socket", "wlroots", { kind: "wlroots", display: "wayland-9", env: { XDG_RUNTIME_DIR: "/tmp/cutest/rt" } }, {}, /your own desktop/],
  ["path over 255 chars", "x11", { kind: "wlroots", display: "/" + "a".repeat(260) }, {}, /not a valid wlroots display/]
]) {
  console.log(`\n[own display: ${label}]`);
  const r = makeRig(host, { "claude-desktop-extra.json": cfg({ enabled: true, ...target }) }, { env: extraEnv });
  r.reset();
  await r.ex.__setLockHeld(true);
  const tc = typeof r.ex.__targetCheck === "function" ? await r.ex.__targetCheck("screenshot") : null;
  check(rx.test(tc || ""), "refused as invalid", String(tc));
  const o = await drive(r.ex);
  check(r.spawns.length === 0 && ["shot", "click", "key"].every((k) => o[k].e), "never probed, captured or driven", JSON.stringify(r.spawns.map((s) => s.bin + " " + s.args)));
}
console.log("\n[wlroots socket missing at the lock = not running, no spawn; then up]");
{
  const r = makeRig("x11", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "wlroots", display: "wayland-5" }) });
  r.reset();
  await r.ex.__setLockHeld(true);
  const a = r.ex.__targetCheck ? await r.ex.__targetCheck("screenshot") : null;
  check(/background display wayland-5, which is not running/.test(a || "") && r.spawns.length === 0, "not running, nothing spawned", JSON.stringify({ a, n: r.spawns.length }));
  SOCKETS["/run/user/1000/wayland-5"] = 15;
  const b = r.ex.__targetCheck ? await r.ex.__targetCheck("screenshot") : "n/a";
  check(b === null && r.spawns.some((s) => s.args === "screens" && s.bin === "wlroots-bridge"), "socket appears: checked and used", JSON.stringify({ b, s: r.spawns.map((x) => x.bin + " " + x.args) }));
  delete SOCKETS["/run/user/1000/wayland-5"];
}

console.log("\n[refuse, then the display comes up within the same lock]");
{
  let up = false;
  const r = makeRig("x11", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "x11", display: ":99" }) }, { screens: () => up ? SCREENS : new Error("cannot open display") });
  await r.ex.__setLockHeld(true);
  const a = r.ex.__targetCheck ? await r.ex.__targetCheck("screenshot") : null;
  up = true;
  const b = r.ex.__targetCheck ? await r.ex.__targetCheck("screenshot") : "n/a";
  r.reset();
  const s = await settle(r.ex.screenshot({ displayId: 0 }));
  check(a === DOWN && b === null && !s.e, "refused while down, works once it answers", JSON.stringify({ a, b, e: s.e && s.e.message }));
}

// ------------------------------------------------------- 4. latch + file rules
console.log("\n[latched per tool call; .jsonc wins per key]");
{
  const files = { "claude-desktop-extra.json": cfg({ enabled: true, kind: "x11", display: ":99" }) };
  const r = makeRig("wlroots", files);
  await r.ex.__setLockHeld(true);
  r.reset();
  await settle(r.ex.click(1, 1, "left", 1));
  check(bins(r).join() === "x11-bridge", "target latched", JSON.stringify(bins(r)));
  files["claude-desktop-extra.json"] = cfg({ enabled: false });
  tick(); r.reset();
  const mid = await settle(r.ex.click(1, 1, "left", 1));
  check(mid.e && /setting changed during this action/.test(mid.e.message) && r.spawns.length === 0, "a change seen by an executor call (no gate): that call is refused, nothing driven", JSON.stringify({ e: mid.e && mid.e.message, s: bins(r) }));
  tick(); r.reset();
  await settle(r.ex.click(1, 1, "left", 1));
  check(bins(r).join() === "wlroots-bridge" && noEnvKey(r), "and the following call is on the new setting", JSON.stringify(bins(r)));
  await r.ex.__setLockHeld(false);
  await r.ex.__setLockHeld(true);
  r.reset();
  await settle(r.ex.click(1, 1, "left", 1));
  check(bins(r).join() === "wlroots-bridge" && noEnvKey(r), "the next lock is back on the desktop, no env option", JSON.stringify(r.spawns.map((s) => s.bin)));
  files["claude-desktop-extra.json"] = cfg({ enabled: true, kind: "x11", display: ":99" });
  files["claude-desktop-extra.jsonc"] = "{ \"computerUseBackgroundDisplay\": { \"enabled\": false } }";
  await r.ex.__setLockHeld(true);
  r.reset();
  await settle(r.ex.click(1, 1, "left", 1));
  check(bins(r).join() === "wlroots-bridge", ".jsonc enabled:false beats .json enabled:true", JSON.stringify(bins(r)));
  files["claude-desktop-extra.jsonc"] = "{ /* nothing here */ \"other\": 1 }";
  await r.ex.__setLockHeld(true);
  r.reset();
  await settle(r.ex.click(1, 1, "left", 1));
  check(bins(r).join() === "x11-bridge", ".jsonc without the key: .json applies", JSON.stringify(bins(r)));
}

// --------------------------------------------------------------- 5. the handler
console.log("\n[handler: refusal + teach]");
{
  let src = HANDLER.replace("__SELF__", "__self").split("__MAKE_DISPATCH__").join("__mk()").split("__STATE__").join("__state")
    .split("__TOOL_NAME__").join("__tool").split("__INPUT__").join("__input").split("__SESSION__").join("__session");
  src = src.replace('if(process.platform==="linux"){', 'if(process.platform==="linux"&&!globalThis.__cuKwinMode){');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction("process", "require", "__self", "__mk", "__state", "__tool", "__input", "__session", src + "\nreturn {fell:true};");
  let forwarded = 0, hidden = 0;
  const mk = () => async () => { forwarded++; return { content: [] }; };
  const req = (id) => id === "electron" ? { BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, setIgnoreMouseEvents: () => { hidden++; } }] } } : null;
  const call = (tool, input = {}) => fn({ platform: "linux", env: process.env }, req, {}, mk, {}, tool, input, {});

  const r1 = makeRig("x11", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "x11", display: ":99" }) });
  await r1.ex.__setLockHeld(true);
  forwarded = 0; hidden = 0;
  const t = await call("request_teach_access", { apps: [] });
  check(t.isError && /Teach mode is not available/.test(t.content[0].text) && forwarded === 0, "teach refused in target mode, never forwarded", JSON.stringify(t));
  const c = await call("left_click", { coordinate: [5, 5] });
  check(!c.isError && hidden === 0, "actions do not make the desktop's windows click-through", JSON.stringify({ c, hidden }));

  makeRig("x11", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "x11", display: ":99" }) }, { screens: () => new Error("down") });
  await globalThis.__linuxExecutor.__setLockHeld(true);
  const s = await call("screenshot", {});
  const ra = await call("request_access", { apps: ["x"] });
  check(s.isError && s.content[0].text === DOWN && ra.isError, "every tool (screenshot, request_access) returns the not-running text", JSON.stringify({ s, ra }));

  makeRig("x11", {});
  await globalThis.__linuxExecutor.__setLockHeld(true);
  forwarded = 0; hidden = 0;
  await call("teach_step", {});
  const c2 = await call("left_click", { coordinate: [5, 5] });
  check(forwarded === 1 && !c2.isError && hidden > 0, "switch off: teach forwarded, click-through unchanged", JSON.stringify({ forwarded, hidden }));
}

// ----------------------------------------- 7. T5 geometry + cursor (target)
const HOST_HIDPI = [{ id: 7, label: "host", bounds: { x: 0, y: 0, width: 2048, height: 1152 }, size: { width: 2048, height: 1152 }, workArea: { x: 0, y: 0, width: 2048, height: 1152 }, scaleFactor: 1.25, nativeOrigin: { x: 0, y: 0 } }];
const T_SCREENS = [{ name: "T1", id: "T1", geometry: { x: 0, y: 0, width: 1280, height: 800 }, scale: 1, is_primary: true }, { name: "T2", id: "T2", geometry: { x: 1280, y: 0, width: 800, height: 600 }, scale: 1 }];
const zoomArgs = (r) => r.spawns.filter((x) => /^zoom /.test(x.args)).map((x) => x.args);
for (const target of [{ kind: "x11", display: ":99" }, { kind: "wlroots", display: "wayland-9" }]) {
  for (const host of ["x11", "gnome"]) {
    console.log(`\n[T5 geometry: ${target.kind} target 1280x800@1 on a ${host} desktop 2560x1440@1.25]`);
    const r = makeRig(host, { "claude-desktop-extra.json": cfg({ enabled: true, ...target }) }, { displays: HOST_HIDPI, screens: () => T_SCREENS });
    // Recorded, not thrown: a code path that asks Electron gets the desktop's
    // HiDPI answer and maps wrong, which the checks below see.
    const T5 = () => { r.state.recordScreen = true; };
    T5();
    await r.ex.__setLockHeld(true);
    if (r.ex.__targetCheck) await settle(r.ex.__targetCheck("screenshot"));
    const ds = (await settle(r.ex.listDisplays())).v || [];
    check(ds.length === 2 && ds[0].width === 1280 && ds[0].height === 800 && ds[0].scaleFactor === 1 && ds[0].isPrimary && ds[1].originX === 1280 && ds[1].label === "T2", "listDisplays = the target's monitors", JSON.stringify(ds));
    const sz = (await settle(r.ex.getDisplaySize(1))).v || {};
    check(sz.width === 800 && sz.height === 600 && sz.originX === 1280, "getDisplaySize(1) = target T2", JSON.stringify(sz));
    r.reset(); T5();
    const sh = await settle(r.ex.screenshot({ displayId: 0 }));
    check(!sh.e && sh.v && sh.v.displayWidth === 1280 && sh.v.displayHeight === 800 && JSON.stringify(zoomArgs(r)) === JSON.stringify(["zoom --x 0 --y 0 --w 1280 --h 800 --display T1"]), "screenshot captures T1 in target coordinates", sh.e ? sh.e.message : JSON.stringify({ v: sh.v && [sh.v.displayWidth, sh.v.displayHeight], z: zoomArgs(r) }));
    r.reset(); T5();
    await settle(r.ex.screenshot({ displayId: 1 }));
    check(JSON.stringify(zoomArgs(r)) === JSON.stringify(["zoom --x 0 --y 0 --w 800 --h 600 --display T2"]), "screenshot of display 1 captures T2", JSON.stringify(zoomArgs(r)));
    r.reset(); T5();
    await settle(r.ex.zoom({ x: 1300, y: 20, w: 200, h: 100 }, 1, null));
    check(JSON.stringify(zoomArgs(r)) === JSON.stringify(["zoom --x 20 --y 20 --w 200 --h 100 --display T2"]) && r.screenCalls.length === 0, "zoom maps a region on T2 from the target's monitors (no host scale, no Electron screen)", JSON.stringify({ z: zoomArgs(r), sc: r.screenCalls }));
    r.reset(); T5();
    await settle(r.ex.click(640, 400, "left", 1));
    const clicked = r.spawns.some((x) => /^pointer-click --x 640 --y 400 /.test(x.args));
    const cp = await settle(r.ex.getCursorPosition());
    const want = target.kind === "x11" ? { x: 11, y: 22 } : { x: 640, y: 400 };
    check(clicked && !cp.e && cp.v.x === want.x && cp.v.y === want.y, "click at target 640,400, then cursor_position " + (target.kind === "x11" ? "from x11-bridge cursor-position" : "= last commanded position"), JSON.stringify({ clicked, cp }));
    await settle(r.ex.moveMouse(100, 50));
    r.reset(); T5();
    await settle(r.ex.drag(undefined, { x: 300, y: 200 }));
    check(r.spawns.some((x) => /^pointer-drag --from-x 100 --from-y 50 --to-x 300 --to-y 200$/.test(x.args)), "drag without start starts at the last commanded position", JSON.stringify(r.spawns.map((x) => x.args)));
    check(r.screenCalls.length === 0, "Electron screen / cursor never used", JSON.stringify(r.screenCalls));
    r.state.recordScreen = false;
  }
}
console.log("\n[T5 off: geometry from Electron, unchanged]");
{
  const r = makeRig("x11", {}, { displays: HOST_HIDPI });
  const ds = await r.ex.listDisplays();
  check(ds.length === 1 && ds[0].width === 2048 && ds[0].scaleFactor === 1.25, "listDisplays = the desktop's (pin)", JSON.stringify(ds));
  const cp = await r.ex.getCursorPosition();
  check(cp.x === 7 && cp.y === 7, "cursor from getCursorScreenPoint (pin)", JSON.stringify(cp));
}
// Display auto-target (js/cu_display_target.js) on a background display: the
// window list and the monitors are the TARGET's, so the pick can only ever be
// one of the target's monitors - never the user's desktop.
{
  const nreq = (id) => ({ child_process: { execFileSync() { throw new Error("no"); } }, fs: { existsSync: () => false }, path, electron: { app: { getPath() { throw new Error("no"); } } } })[id];
  if (!globalThis.__cdbCuWindowOwns) new Function("require", "process", readFileSync(path.join(ROOT, "js", "cu_ax_tools.js"), "utf8"))(nreq, process);
  if (!globalThis.__cdbCuDisplayTarget) new Function("process", readFileSync(path.join(ROOT, "js", "cu_display_target.js"), "utf8"))(process);
}
const tgtWin = (x, y, w, h, extra = {}) => ({ id: "0x" + x, title: "Chrome", geometry: { x, y, width: w, height: h }, pid: 1, desktop_file_name: null, resource_class: "Google-chrome", resource_name: "google-chrome", is_dock: false, is_desktop: false, is_visible: true, is_minimized: false, output: null, stacking_order: 0, is_active: true, exclude_from_capture: false, ...extra });
for (const [label, target, screens, wins, wantZoom, wantDiag] of [
  ["x11 target, Chrome on its second monitor T2", { kind: "x11", display: ":99" }, T_SCREENS, [tgtWin(1300, 10, 600, 400)], "zoom --x 0 --y 0 --w 800 --h 600 --display T2", /display auto-target: apps=google-chrome -> T2 \(preferred T1\)/],
  ["x11 target with one monitor: unchanged", { kind: "x11", display: ":99" }, SCREENS, [tgtWin(10, 10, 600, 400)], "zoom --x 0 --y 0 --w 1920 --h 1080 --display SCREEN", /kept SCREEN \(only one display\)/],
  ["wlroots target (no window positions): unchanged", { kind: "wlroots", display: "wayland-9" }, T_SCREENS, [tgtWin(0, 0, 0, 0, { desktop_file_name: "google-chrome", resource_class: "google-chrome", resource_name: null })], "zoom --x 0 --y 0 --w 1280 --h 800 --display T1", /kept T1 \(wlroots-bridge reports no window positions\)/],
]) {
  console.log(`\n[T5 auto-target: ${label}]`);
  // The user's desktop has two monitors; Chrome there must not matter.
  const desk = [DISPLAYS[0], { ...DISPLAYS[0], id: 2, label: "two", bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, nativeOrigin: { x: 1920, y: 0 } }];
  const r = makeRig("x11", { "claude-desktop-extra.json": cfg({ enabled: true, ...target }) }, { displays: desk, screens: () => screens, windows: () => wins });
  await r.ex.__setLockHeld(true);
  if (r.ex.__targetCheck) await settle(r.ex.__targetCheck("screenshot"));
  r.reset(); r.state.recordScreen = true;
  const res = await settle(r.ex.resolvePrepareCapture({ allowedBundleIds: ["google-chrome"], autoResolve: true, doHide: false }));
  check(!res.e && JSON.stringify(zoomArgs(r)) === JSON.stringify([wantZoom]), "captures " + wantZoom.split("--display ")[1], res.e ? res.e.message : JSON.stringify(zoomArgs(r)));
  check(r.diag.some((m) => wantDiag.test(m)), "logs the resolution", JSON.stringify(r.diag.filter((m) => /auto-target/.test(m))));
  check(r.screenCalls.length === 0, "Electron screen never used", JSON.stringify(r.screenCalls));
  check(r.spawns.filter((x) => /^(windows|zoom)/.test(x.args)).every((x) => x.opts.env && (x.opts.env.DISPLAY === ":99" || x.opts.env.WAYLAND_DISPLAY === "wayland-9")), "window list and capture go to the background display", JSON.stringify(r.spawns.map((x) => [x.args, x.opts.env && (x.opts.env.DISPLAY || x.opts.env.WAYLAND_DISPLAY)])));
  r.state.recordScreen = false;
}
console.log("\n[T5 hotplug on the target: monitors follow the re-enumeration]");
{
  let list = T_SCREENS;
  const r = makeRig("x11", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "x11", display: ":99" }) }, { screens: () => list });
  await r.ex.__setLockHeld(true);
  if (r.ex.__targetCheck) await settle(r.ex.__targetCheck("screenshot"));
  list = [{ name: "N1", id: "N1", geometry: { x: 0, y: 0, width: 1024, height: 768 }, scale: 1, is_primary: true }];
  await r.ex.__setLockHeld(false);
  await r.ex.__setLockHeld(true);
  const ds = await r.ex.listDisplays();
  check(ds.length === 1 && ds[0].label === "N1" && ds[0].width === 1024, "a new lock re-reads the target's monitors", JSON.stringify(ds));
}

// --------------------------------------------- 8. T6 launch into the target
// The openApp poll waits 500 ms per round: run those timers on a fake clock.
const realST = globalThis.setTimeout, realNow = Date.now;
let clock = 0;
function fakeClock(on) {
  if (on) { clock = 0; Date.now = () => realNow() + clock; globalThis.setTimeout = (f, ms, ...a) => { if (ms === 500) { clock += 500; ms = 0; } return realST(f, ms, ...a); }; }
  else { Date.now = realNow; globalThis.setTimeout = realST; }
}
const GEDIT_WIN = { id: "0x400001", resource_class: "gedit", resource_name: "gedit", title: "Untitled - Gedit" };
const HANDOFF = "Gedit did not show a window on the Computer Use display within 15 s. It may still be starting, or it is already running on the user's desktop and opened there. Take a screenshot to check; if it is not there, ask the user to close it on their desktop.";
for (const target of [{ kind: "x11", display: ":99", env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/b" } }, { kind: "wlroots", display: "wayland-9" }]) {
  const tb = target.kind === "x11" ? "x11-bridge" : "wlroots-bridge";
  console.log(`\n[T6 openApp on a ${target.kind} target]`);
  fakeClock(true);
  try {
    const r = makeRig("gnome", { "claude-desktop-extra.json": cfg({ enabled: true, ...target }) }, { windows: (launched) => launched ? [GEDIT_WIN] : [] });
    await r.ex.__setLockHeld(true);
    r.reset(); r.state.throwScreen = true;
    const o = await settle(r.ex.openApp("gedit"));
    const launch = r.spawns.filter((x) => x.kind === "spawn");
    check(!o.e && o.v.action === "launched" && launch.length === 1 && launch[0].bin === "setsid" && launch[0].args === "gedit" && launch[0].opts.env && launch[0].opts.env[target.kind === "x11" ? "DISPLAY" : "WAYLAND_DISPLAY"] === target.display && (target.kind === "x11" ? !("WAYLAND_DISPLAY" in launch[0].opts.env) && launch[0].opts.env.DBUS_SESSION_BUS_ADDRESS === "unix:path=/tmp/b" : !("DISPLAY" in launch[0].opts.env)), "new window on the target -> launched, via a direct Exec spawn in the target env", JSON.stringify({ o: o.e ? o.e.message : o.v, l: launch.map((x) => [x.bin, x.args, x.opts.env && { D: x.opts.env.DISPLAY, W: x.opts.env.WAYLAND_DISPLAY }]) }));
    const wl = r.spawns.filter((x) => x.args === "windows");
    check(wl.length >= 2 && wl.every((x) => x.kind === "async" && x.bin === tb) && !r.spawns.some((x) => x.kind === "execSync" || x.kind === "spawnSync"), "target windows polled async through " + tb + ", no blocking sleep", JSON.stringify(r.spawns.map((x) => x.kind + " " + x.bin + " " + x.args)));
    // Handoff: the window never appears on the target.
    r.state.windows = () => [];
    r.reset();
    const h = await settle(r.ex.openApp("gedit"));
    check(h.e && h.e.message === HANDOFF, "no new window -> the handoff message", h.e ? h.e.message : JSON.stringify(h.v));
    // An already-open window of another app does not count as new.
    r.state.windows = () => [{ id: "0x1", resource_class: "xterm", title: "xterm" }];
    r.reset();
    const h2 = await settle(r.ex.openApp("gedit"));
    check(h2.e && h2.e.message === HANDOFF, "a window that was there before is not new", h2.e ? h2.e.message : JSON.stringify(h2.v));
    // Terminal app / URL: no desktop launcher tier, no xdg-open.
    r.reset();
    const t = await settle(r.ex.openApp("Top"));
    const u = await settle(r.ex.openApp("https://example.com/x"));
    check(t.e && /background display/.test(t.e.message) && u.e && /xdg-open would open it on the user's desktop/.test(u.e.message), "Terminal=true and URL refused on the target", JSON.stringify([t.e && t.e.message, u.e && u.e.message]));
    check(!r.spawns.some((x) => /^(gio|gtk-launch|kioclient6|exo-open|xdg-open|xdg-terminal-exec|x-terminal-emulator)$/.test(x.bin) || /^(xdg-open)/.test(x.args)), "no gio / gtk-launch / kioclient / exo-open / xdg-open / terminal tier", JSON.stringify(r.spawns.map((x) => x.bin + " " + x.args)));
  } finally { fakeClock(false); }
}
console.log("\n[T6 off: launch path unchanged]");
fakeClock(true);
try {
  const r = makeRig("x11", {}, { windows: (launched) => launched ? [GEDIT_WIN] : [] });
  r.reset();
  const o = await settle(r.ex.openApp("gedit"));
  const launch = r.spawns.filter((x) => x.kind === "spawn");
  check(!o.e && o.v.action === "launched" && launch.length === 1 && !("env" in launch[0].opts), "desktop launch: inherited env, window found (pin, same as before)", JSON.stringify({ o: o.v || o.e.message, l: launch.map((x) => x.bin + " " + x.args) }));
  check(!r.spawns.some((x) => x.kind === "execSync"), "the poll no longer blocks on `sleep 0.5`", JSON.stringify(r.spawns.filter((x) => x.kind === "execSync").map((x) => x.bin)));
} finally { fakeClock(false); }

// ------------------------------- 8b. T6 launch: the started PATH, not upstream's narrowed one
// Upstream narrows process.env.PATH at startup to root-owned system dirs, keeps
// the launch PATH in CLAUDE_DESKTOP_STARTED_PATH and the narrowed one in
// CLAUDE_DESKTOP_NARROWED_PATH. An app installed only in a per-user profile
// (NixOS home-manager, ~/.nix-profile, ~/.local/bin) must still launch on the
// target: looked up on, and spawned with, the started PATH (relative entries
// dropped, the narrowed dirs appended).
// The narrowed list exactly as upstream builds it (index.pre.js), /usr/local
// included (root-owned, read-only here).
const NARROWED = "/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin:/snap/bin:/run/current-system/sw/bin:/run/current-system/profile/bin";
// The env upstream leaves: PATH = narrowed, both variables set.
const narrowedEnv = (started) => ({ PATH: NARROWED, CLAUDE_DESKTOP_NARROWED_PATH: NARROWED, CLAUDE_DESKTOP_STARTED_PATH: started });
const appPath = (started) => [...new Set((started + ":" + NARROWED).split(":").filter((d) => d.startsWith("/")))].join(":");
const USER_GEDIT = "/home/u/.nix-profile/bin/gedit";
for (const [label, extraEnv, wantPath] of [
  ["started PATH present", narrowedEnv("/home/u/.nix-profile/bin:rel/bin:/usr/bin"), "/home/u/.nix-profile/bin:/usr/bin:/usr/local/bin:/usr/local/sbin:/bin:/usr/sbin:/sbin:/snap/bin:/run/current-system/sw/bin:/run/current-system/profile/bin"],
  ["no started PATH (upstream without narrowing)", {}, null]
]) {
  console.log(`\n[T6 started PATH: ${label}]`);
  fakeClock(true);
  try {
    const r = makeRig("gnome", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "wlroots", display: "wayland-9" }) }, { env: extraEnv, installed: [USER_GEDIT], uninstalled: ["/usr/bin/gedit"], windows: (launched) => launched ? [GEDIT_WIN] : [] });
    await r.ex.__setLockHeld(true);
    r.reset();
    const o = await settle(r.ex.openApp("gedit"));
    const launch = r.spawns.filter((x) => x.kind === "spawn");
    if (wantPath) {
      check(!o.e && o.v.action === "launched" && launch.length === 1 && launch[0].args === "gedit" && launch[0].opts.env && launch[0].opts.env.PATH === wantPath, "per-user app found and spawned with the started PATH", JSON.stringify({ o: o.e ? o.e.message : o.v, l: launch.map((x) => [x.bin, x.args, x.opts.env && x.opts.env.PATH]) }));
      check(process.env.PATH === NARROWED, "our own process.env.PATH is untouched", process.env.PATH);
    } else {
      check(o.e && /gedit: command not found/.test(o.e.message) && launch.length === 0, "PATH left as inherited: the per-user app is not found (same as before)", JSON.stringify({ e: o.e && o.e.message, l: launch.map((x) => x.bin) }));
    }
  } finally { fakeClock(false); }
}
// Our own helpers never come from a user-writable dir, whatever the started
// PATH says: setsid and the clipboard tools are looked up on the TOOL PATH
// (narrowed dirs, then started dirs that pass upstream's trust rule) and
// spawned by absolute path; the app itself gets the APP PATH.
const PLANT = ["/home/u/.local/bin/setsid", "/home/u/.local/bin/wl-copy", "/home/u/.local/bin/wl-paste", "/home/u/.local/bin/xclip"];
const STARTED_U = "/home/u/.local/bin:/home/u/.nix-profile/bin:/usr/local/bin:/usr/bin:/bin";
for (const target of [{ kind: "wlroots", display: "wayland-9" }, { kind: "x11", display: ":99" }]) {
  console.log(`\n[PATH (1): planted helpers in ~/.local/bin are not chosen - ${target.kind} target]`);
  fakeClock(true);
  try {
    const r = makeRig("gnome", { "claude-desktop-extra.json": cfg({ enabled: true, ...target }) }, { env: narrowedEnv(STARTED_U), installed: [USER_GEDIT, ...PLANT, "/usr/bin/wl-copy", "/usr/bin/wl-paste", "/usr/bin/xclip"], uninstalled: ["/usr/bin/gedit"], windows: (launched) => launched ? [GEDIT_WIN] : [] });
    await r.ex.__setLockHeld(true);
    r.reset();
    const o = await settle(r.ex.openApp("gedit"));
    const launch = r.spawns.filter((x) => x.kind === "spawn");
    check(!o.e && launch.length === 1 && launch[0].raw === "/usr/bin/setsid" && launch[0].args === "gedit" && launch[0].opts.env.PATH === appPath(STARTED_U), "setsid from /usr/bin by absolute path; the app gets the APP PATH", JSON.stringify({ e: o.e && o.e.message, l: launch.map((x) => [x.raw, x.args, x.opts.env && x.opts.env.PATH]) }));
    r.reset();
    const w = await settle(r.ex.writeClipboard("hi")), rd = await settle(r.ex.readClipboard());
    const cl = r.spawns.filter((x) => /^(wl-copy|wl-paste|xclip)$/.test(x.bin));
    const want = target.kind === "x11" ? ["/usr/bin/xclip", "/usr/bin/xclip"] : ["/usr/bin/wl-copy", "/usr/bin/wl-paste"];
    check(!w.e && !rd.e && JSON.stringify(cl.map((x) => x.raw)) === JSON.stringify(want) && cl.every((x) => x.opts.env.PATH === NARROWED), "clipboard tools from /usr/bin by absolute path, TOOL PATH in their env", JSON.stringify({ e: (w.e || rd.e || {}).message, cl: cl.map((x) => [x.raw, x.opts.env && x.opts.env.PATH]) }));
    await settle(r.ex.click(5, 5, "left", 1));
    const br = r.spawns.filter((x) => /-bridge$/.test(x.bin));
    check(br.length > 0 && br.every((x) => x.opts.env.PATH === NARROWED), "the bridge gets the TOOL PATH, never the APP PATH", JSON.stringify(br.map((x) => x.opts.env && x.opts.env.PATH)));
    check(!r.spawns.some((x) => x.raw.startsWith("/home/")), "nothing under /home is ever executed", JSON.stringify(r.spawns.map((x) => x.raw)));
  } finally { fakeClock(false); }
}
console.log("\n[PATH (2): a helper only in a user-writable dir reads as missing]");
{
  const r = makeRig("gnome", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "wlroots", display: "wayland-9" }) }, { env: narrowedEnv(STARTED_U), installed: PLANT });
  await r.ex.__setLockHeld(true);
  r.reset();
  const w = await settle(r.ex.writeClipboard("x")), w2 = await settle(r.ex.writeClipboard("y"));
  check(w.e && /install the wl-clipboard package/.test(w.e.message) && /found wl-copy in \/home\/u\/\.local\/bin - a user-writable folder, which Computer Use ignores/.test(w.e.message) && w2.e, "refused as missing; the message names the ignored user-writable copy", w.e ? w.e.message : "resolved");
  check(!r.spawns.some((x) => x.bin === "wl-copy"), "the planted wl-copy is never spawned", JSON.stringify(r.spawns.map((x) => x.raw)));
  check(r.diag.filter((d) => /tools: wl-copy found only in \/home\/u\/\.local\/bin, a user-writable folder - ignored/.test(d)).length === 1, "one diagnostics line per tool, not per call", JSON.stringify(r.diag.filter((d) => /tools:/.test(d))));
}
console.log("\n[PATH (3): a helper in a trusted started dir is found, by its real path]");
{
  // Upstream's rule on the started-PATH entry AS WRITTEN: every directory on
  // the way and every symlink hop (owned by root, in a dir that passes) must be
  // root's and read-only for us; tools come from the real dir.
  //   /etc/profiles/per-user/u        root's link -> /nix/store/cccc-user-env   trusted
  //   /run/current-system             root's link -> /nix/store/dddd-system     trusted
  //   /usr/local (Bazzite)            root's link in /usr -> /var/usrlocal      trusted
  //   /nix/store/aaaa-wl-clipboard/bin plain store dir (our NixOS wrapper)      trusted
  //   /home/u/.nix-profile            the user's link (in the user's home)      not trusted
  //   /home/u/rootlink                root's link, but in the user's home       not trusted
  //   /home/u/rootbin                 root-owned dir under a writable parent    not trusted
  //   /srv/open/bin                   root-owned but writable                   not trusted
  // A narrowed PATH of /usr/bin:/bin only, so every entry above is judged.
  const STORE = "/nix/store/aaaa-wl-clipboard/bin", UENV = "/nix/store/cccc-user-env", SYS = "/nix/store/dddd-system";
  const ro = (u = 0, r = "EACCES") => ({ uid: u, ro: r });
  const dirs = { "/etc": ro(), "/etc/profiles": ro(), "/etc/profiles/per-user": ro(), "/run": ro(), "/var": ro(), "/var/usrlocal": ro(), "/var/usrlocal/bin": ro(),
    [STORE]: ro(0, "EROFS"), "/nix/store/aaaa-wl-clipboard": ro(0, "EROFS"), [UENV]: ro(0, "EROFS"), [UENV + "/bin"]: ro(0, "EROFS"), [SYS]: ro(0, "EROFS"), [SYS + "/sw"]: ro(0, "EROFS"), [SYS + "/sw/bin"]: ro(0, "EROFS"),
    "/nix/store/eeee-profile": ro(0, "EROFS"), "/nix/store/eeee-profile/bin": ro(0, "EROFS"),
    "/home/u/rootbin": ro(), "/srv": ro(), "/srv/open": ro(), "/srv/open/bin": ro(0, null) };
  dirs["/usr/local"] = undefined;
  const links = { "/etc/profiles/per-user/u": UENV, "/run/current-system": SYS, "/usr/local": "/var/usrlocal", "/home/u/.nix-profile": "/nix/store/eeee-profile", "/home/u/rootlink": "/nix/store/eeee-profile" };
  const linkUids = { "/home/u/.nix-profile": 1000 };
  const ENTRIES = ["/etc/profiles/per-user/u/bin", "/run/current-system/sw/bin", "/usr/local/bin", STORE, "/home/u/.nix-profile/bin", "/home/u/rootlink/bin", "/home/u/rootbin", "/srv/open/bin"];
  const N2 = "/usr/bin:/bin";
  const env = { PATH: N2, CLAUDE_DESKTOP_NARROWED_PATH: N2, CLAUDE_DESKTOP_STARTED_PATH: ENTRIES.join(":") };
  const inst = [STORE + "/wl-copy", UENV + "/bin/wl-paste", "/nix/store/eeee-profile/bin/wl-copy", "/nix/store/eeee-profile/bin/wl-paste", "/home/u/rootbin/wl-copy", "/srv/open/bin/wl-copy"];
  const r = makeRig("gnome", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "wlroots", display: "wayland-9" }) }, { env, installed: inst, links, linkUids, dirs });
  await r.ex.__setLockHeld(true);
  r.reset();
  await settle(r.ex.click(5, 5, "left", 1));
  const br = r.spawns.find((x) => /-bridge$/.test(x.bin));
  const want = [N2, UENV + "/bin", SYS + "/sw/bin", "/var/usrlocal/bin", STORE].join(":");
  check(br && br.opts.env.PATH === want, "TOOL PATH = narrowed, then per-user (/etc/profiles), system profile, Bazzite /usr/local, store dir - by real path; never ~/.nix-profile, a root link in the home dir, a dir under a writable parent or a writable dir", br && br.opts.env.PATH);
  r.reset();
  const w = await settle(r.ex.writeClipboard("z")), rd = await settle(r.ex.readClipboard());
  const cl = r.spawns.filter((x) => /^wl-(copy|paste)$/.test(x.bin)).map((x) => x.raw);
  check(!w.e && !rd.e && JSON.stringify(cl) === JSON.stringify([STORE + "/wl-copy", UENV + "/bin/wl-paste"]), "clipboard tools spawned by their real path (store dir; per-user profile via root's link)", JSON.stringify({ e: (w.e || rd.e || {}).message, cl }));
  check(r.diag.some((d) => d === "[claude-cu] tools: wl-copy -> " + STORE + "/wl-copy (a root-owned read-only folder on the PATH Claude Desktop was started with)") && r.diag.some((d) => d.includes("tools: wl-paste -> " + UENV + "/bin/wl-paste")), "one line names the trusted started dir taken", JSON.stringify(r.diag.filter((d) => /tools:/.test(d))));
  // root repoints the per-user link into the user's home: a fresh lookup (the
  // clipboard tools look up fresh) walks the chain again and drops it.
  links["/etc/profiles/per-user/u"] = "/home/u/evil"; dirs["/home/u/evil"] = ro(1000, null); dirs["/home/u/evil/bin"] = ro(1000, null);
  inst.push("/home/u/evil/bin/wl-paste");
  r.reset();
  const rd2 = await settle(r.ex.readClipboard());
  check(rd2.e && /install the wl-clipboard package/.test(rd2.e.message) && !r.spawns.some((x) => x.raw.startsWith("/home/")), "a link repointed into the home dir is seen by the next fresh lookup: wl-paste is missing, nothing under /home runs", rd2.e ? rd2.e.message.slice(0, 200) : "resolved");
}
console.log("\n[PATH (3b): ~/.nix-profile/bin alone is user-managed - not used for tools]");
{
  const dirs = { "/nix/store/eeee-profile": { uid: 0, ro: "EROFS" }, "/nix/store/eeee-profile/bin": { uid: 0, ro: "EROFS" } };
  for (const [label, linkUids] of [["the user's own link", { "/home/u/.nix-profile": 1000 }], ["a root-owned link in the user's home", {}]]) {
    const r = makeRig("gnome", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "wlroots", display: "wayland-9" }) }, { env: narrowedEnv("/home/u/.nix-profile/bin:/usr/bin"), installed: ["/nix/store/eeee-profile/bin/wl-copy"], links: { "/home/u/.nix-profile": "/nix/store/eeee-profile" }, linkUids, dirs });
    await r.ex.__setLockHeld(true);
    r.reset();
    const w = await settle(r.ex.writeClipboard("q"));
    check(w.e && /found wl-copy in \/home\/u\/\.nix-profile\/bin/.test(w.e.message) && !r.spawns.some((x) => x.bin === "wl-copy"), label + ": wl-copy reads as missing, named as ignored", w.e ? w.e.message.slice(0, 160) : "resolved");
  }
}
console.log("\n[PATH (3c): R1 - a bare-name fallback never meets a wider PATH]");
fakeClock(true);
try {
  // xdg-open only in ~/.local/bin; setsid in /usr/bin (narrowed) or nowhere
  // but ~/.local/bin. URL opening must not run anything under /home.
  for (const [label, uninst] of [["setsid in the narrowed dir, xdg-open only in ~/.local/bin", ["/usr/bin/xdg-open"]], ["setsid and xdg-open only in ~/.local/bin", ["/usr/bin/xdg-open", "/usr/bin/setsid"]]]) {
    const r = makeRig("x11", {}, { env: narrowedEnv(STARTED_U), installed: [...PLANT, "/home/u/.local/bin/xdg-open"], uninstalled: uninst });
    r.reset();
    await settle(r.ex.openApp("https://example.com/"));
    const sp = r.spawns.filter((x) => x.kind === "spawn");
    check(sp.length === 1 && sp[0].raw === "setsid" && sp[0].args === "xdg-open https://example.com/" && !("env" in sp[0].opts), label + ": bare names with the inherited (narrowed) env, as before narrowing existed", JSON.stringify(sp.map((x) => [x.raw, x.args, x.opts.env && x.opts.env.PATH])));
    check(!r.spawns.some((x) => x.raw.startsWith("/home/")), label + ": nothing under /home is spawned", JSON.stringify(r.spawns.map((x) => x.raw)));
  }
  // The same with a per-user app: the APP PATH only reaches the app's own spawn.
  const r = makeRig("x11", {}, { env: narrowedEnv(STARTED_U), installed: [USER_GEDIT, ...PLANT], uninstalled: ["/usr/bin/gedit", "/usr/bin/setsid"], windows: (launched) => launched ? [GEDIT_WIN] : [] });
  r.reset();
  await settle(r.ex.openApp("gedit"));
  const sp = r.spawns.filter((x) => x.kind === "spawn");
  check(sp.length === 1 && sp[0].raw === "gedit" && sp[0].opts.env.PATH === appPath(STARTED_U), "no system setsid: the app itself is spawned (its own name, APP PATH); the planted setsid is not", JSON.stringify(sp.map((x) => [x.raw, x.args])));
} finally { fakeClock(false); }
console.log("\n[PATH (4): desktop mode - per-user app via the APP PATH, helpers by absolute path]");
fakeClock(true);
try {
  const r = makeRig("x11", {}, { env: narrowedEnv(STARTED_U), installed: [USER_GEDIT, ...PLANT], uninstalled: ["/usr/bin/gedit"], windows: (launched) => launched ? [GEDIT_WIN] : [] });
  r.reset();
  const o = await settle(r.ex.openApp("gedit"));
  const launch = r.spawns.filter((x) => x.kind === "spawn");
  check(!o.e && launch.length === 1 && launch[0].raw === "/usr/bin/setsid" && launch[0].args === "gedit" && launch[0].opts.env && launch[0].opts.env.PATH === appPath(STARTED_U) && launch[0].opts.env.DISPLAY === ":0", "direct spawn: /usr/bin/setsid, the app on the APP PATH, the desktop env otherwise", JSON.stringify({ e: o.e && o.e.message, l: launch.map((x) => [x.raw, x.args, x.opts.env && x.opts.env.PATH]) }));
  check(r.diag.filter((d) => d === "[claude-cu] openApp: gedit -> " + USER_GEDIT + " (found on the PATH Claude Desktop was started with, not on the narrowed one)").length === 1, "one line says the app came from the started PATH", JSON.stringify(r.diag.filter((d) => /openApp/.test(d))));
  r.reset();
  await settle(r.ex.openApp("https://example.com/"));
  const xo = r.spawns.find((x) => x.kind === "spawn");
  check(xo && xo.raw === "/usr/bin/setsid" && xo.args === "/usr/bin/xdg-open https://example.com/" && xo.opts.env.PATH === NARROWED, "URL: setsid + xdg-open by absolute path, with the TOOL PATH (xdg-open picks helpers by name), not the APP PATH", JSON.stringify(xo && [xo.raw, xo.args, xo.opts.env && xo.opts.env.PATH]));
} finally { fakeClock(false); }
console.log("\n[PATH (6): a PATH change between calls (upstream's flag) is picked up]");
fakeClock(true);
try {
  const r = makeRig("x11", {}, { env: narrowedEnv(STARTED_U), installed: [USER_GEDIT, ...PLANT], uninstalled: ["/usr/bin/gedit"], windows: (launched) => launched ? [GEDIT_WIN] : [] });
  const one = async () => { r.reset(); const o = await settle(r.ex.openApp("gedit")); const l = r.spawns.find((x) => x.kind === "spawn"); return { e: o.e && o.e.message, raw: l && l.raw, env: l ? ("env" in l.opts ? l.opts.env.PATH : "(inherit)") : null }; };
  const a = await one();
  process.env.PATH = STARTED_U; // flag off: upstream restores the started PATH
  const b = await one();
  process.env.PATH = NARROWED; // flag on again
  const c = await one();
  check(a.raw === "/usr/bin/setsid" && a.env === appPath(STARTED_U), "narrowed: absolute setsid, APP PATH", JSON.stringify(a));
  check(b.raw === "setsid" && b.env === "(inherit)" && !b.e, "restored: as before narrowing - bare setsid (the PATH is the user's own again), inherited env", JSON.stringify(b));
  check(c.raw === "/usr/bin/setsid" && c.env === appPath(STARTED_U), "narrowed again: back to the absolute path", JSON.stringify(c));
} finally { fakeClock(false); }
console.log("\n[PATH (7): the app index follows the lookup PATH]");
{
  const apps = { "tryapp.desktop": "[Desktop Entry]\nType=Application\nName=Tryapp\nExec=tryapp\nTryExec=tryapp\n" };
  const r = makeRig("x11", {}, { env: { PATH: NARROWED, CLAUDE_DESKTOP_NARROWED_PATH: NARROWED }, installed: ["/home/u/.nix-profile/bin/tryapp"], apps });
  const ids = globalThis.__cdbCuAppIds;
  const before = ids.resolveName("Tryapp");
  process.env.CLAUDE_DESKTOP_STARTED_PATH = "/home/u/.nix-profile/bin:/usr/bin";
  const after = ids.resolveName("Tryapp");
  delete process.env.CLAUDE_DESKTOP_STARTED_PATH;
  const again = ids.resolveName("Tryapp");
  check(before === null && after && after.bundleId === "tryapp" && again === null, "TryExec on a per-user dir: hidden without the started PATH, listed once it is there, hidden again - within the cache TTL", JSON.stringify({ before, after, again }));
}
console.log("\n[T6 started PATH: off -> desktop launch unchanged]");
fakeClock(true);
try {
  const r = makeRig("x11", {}, { env: { CLAUDE_DESKTOP_STARTED_PATH: "/home/u/.nix-profile/bin:/usr/bin" }, windows: (launched) => launched ? [GEDIT_WIN] : [] });
  r.reset();
  const o = await settle(r.ex.openApp("gedit"));
  const launch = r.spawns.filter((x) => x.kind === "spawn");
  check(!o.e && launch.length === 1 && !("env" in launch[0].opts), "no target: inherited env, no PATH override", JSON.stringify({ o: o.v || o.e.message, l: launch.map((x) => [x.bin, x.args, x.opts.env]) }));
} finally { fakeClock(false); }

// ---------------- 8c. PATH (5): no narrowing in effect = origin/master, byte for byte
// The same scenarios run here and were recorded from origin/master's executor
// (GOLDEN): every spawn's kind, command as given, args, cwd, other options and
// env (the display / PATH keys verbatim, the whole env as a hash) must match.
// Host-independent: the rig's env is synthetic, the capture temp file is
// normalized.
async function pathTrace(host, files, env) {
  fakeClock(true);
  try {
    const r = makeRig(host, files, { env, installed: ["/usr/bin/xclip", "/usr/bin/wl-copy", "/usr/bin/wl-paste"], windows: (launched) => launched ? [GEDIT_WIN] : [] });
    await r.ex.__setLockHeld(true);
    if (r.ex.__targetCheck) await settle(r.ex.__targetCheck("screenshot"));
    r.reset();
    const out = [];
    for (const f of [() => r.ex.openApp("gedit"), () => r.ex.openApp("Top"), () => r.ex.openApp("https://example.com/"), () => r.ex.writeClipboard("t"), () => r.ex.readClipboard(), () => r.ex.click(3, 3, "left", 1), () => r.ex.screenshot({ displayId: 0 })]) {
      const o = await settle(f()); out.push(o.e ? "E:" + o.e.message : JSON.stringify(o.v));
    }
    process.env.COWORK_SCREENSHOT_CMD = "true {FILE}";
    await settle(r.ex.screenshot({ displayId: 0 }));
    delete process.env.COWORK_SCREENSHOT_CMD;
    const norm = (v) => String(v).split(os.tmpdir()).join("$TMP").replace(/claude-cu-\d+-[a-z0-9]+\.png/g, "claude-cu-X.png");
    const envSum = (e) => { if (!e) return null; const o = {}; for (const k of ["PATH", "DISPLAY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "XDG_SESSION_TYPE", "GDK_BACKEND"]) if (k in e) o[k] = e[k]; o.hash = createHash("sha256").update(JSON.stringify(Object.entries(e).sort())).digest("hex").slice(0, 16); return o; };
    return { out: out.map(norm), spawns: r.spawns.map((x) => [x.kind, norm(x.raw), norm(x.args), x.opts.cwd || null, Object.keys(x.opts).filter((k) => k !== "env" && k !== "cwd").sort().map((k) => k + "=" + JSON.stringify(x.opts[k])).join(","), envSum(x.opts.env)]) };
  } finally { fakeClock(false); }
}
{
  const golden = RECORD ? {} : JSON.parse(readFileSync(GOLDEN, "utf8"));
  for (const [label, env] of [["variables absent", {}], ["started PATH restored by upstream's flag", { PATH: "/home/u/.local/bin:/usr/bin:/bin", CLAUDE_DESKTOP_STARTED_PATH: "/home/u/.local/bin:/usr/bin:/bin", CLAUDE_DESKTOP_NARROWED_PATH: "/usr/bin:/bin" }]]) {
    for (const [mode, host, files] of [["desktop", "x11", {}], ["x11 target", "gnome", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "x11", display: ":99" }) }], ["wlroots target", "x11", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "wlroots", display: "wayland-9" }) }]]) {
      const key = label + " / " + mode, t = await pathTrace(host, files, env);
      if (RECORD) { golden[key] = t; continue; }
      console.log(`\n[PATH (5): ${key}: identical to origin/master]`);
      const g = golden[key], a = JSON.stringify(g), b = JSON.stringify(t);
      check(g && a === b && t.spawns.length > 0, "same spawns, argv, cwd and env", a === b ? undefined : (() => { if (!g) return "no golden entry"; if (JSON.stringify(g.out) !== JSON.stringify(t.out)) return "results differ: " + JSON.stringify([g.out, t.out]); const i = g.spawns.findIndex((x, k) => JSON.stringify(x) !== JSON.stringify(t.spawns[k])); return "spawn " + i + " of " + g.spawns.length + "/" + t.spawns.length + "\n  golden " + JSON.stringify(g.spawns[i]) + "\n  ours   " + JSON.stringify(t.spawns[i]); })());
    }
  }
  if (RECORD) { writeFileSync(GOLDEN, "{\n" + Object.entries(golden).map(([k, v]) => JSON.stringify(k) + ": {\"out\": " + JSON.stringify(v.out) + ", \"spawns\": [\n  " + v.spawns.map((x) => JSON.stringify(x)).join(",\n  ") + "]}").join(",\n") + "\n}\n"); console.log("\nrecorded " + GOLDEN); }
}

// -------------------------------------------------- 9. T7 target clipboard
for (const [label, target, inst, wbin, wargs, rbin, rargs] of [
  ["x11 + xclip", { kind: "x11", display: ":99" }, ["/usr/bin/xclip", "/usr/bin/xsel"], "xclip", "-selection clipboard -in", "xclip", "-selection clipboard -out"],
  ["x11 + xsel only", { kind: "x11", display: ":99" }, ["/usr/bin/xsel"], "xsel", "--clipboard --input", "xsel", "--clipboard --output"],
  ["wlroots + wl-clipboard", { kind: "wlroots", display: "wayland-9" }, ["/usr/bin/wl-copy", "/usr/bin/wl-paste"], "wl-copy", "", "wl-paste", "--no-newline --type text"]
]) {
  console.log(`\n[T7 clipboard: ${label}]`);
  const r = makeRig("gnome", { "claude-desktop-extra.json": cfg({ enabled: true, ...target }) }, { installed: inst });
  await r.ex.__setLockHeld(true);
  r.reset();
  const w = await settle(r.ex.writeClipboard("hello"));
  const ws = r.spawns.find((x) => x.kind === "spawn");
  const own = target.kind === "x11" ? "DISPLAY" : "WAYLAND_DISPLAY";
  check(!w.e && r.clip.length === 0 && ws && ws.bin === wbin && ws.args === wargs && r.stdin[0] === wbin + ":hello" && ws.opts.env && ws.opts.env[own] === target.display, `write via ${wbin} in the target env, Electron clipboard untouched`, JSON.stringify({ e: w.e && w.e.message, ws: ws && [ws.bin, ws.args], stdin: r.stdin }));
  const rd = await settle(r.ex.readClipboard());
  const rs = r.spawns.find((x) => x.bin === rbin && x.kind === "async");
  check(!rd.e && rd.v === "hello" && rs && rs.args === rargs && rs.opts.env[own] === target.display && rs.opts.timeout > 0, `read via ${rbin}, async with a timeout`, JSON.stringify({ e: rd.e && rd.e.message, v: rd.v, rs: rs && rs.args }));
  r.reset();
  const ty = await settle(r.ex.type("pasted", { viaClipboard: true }));
  check(!ty.e && r.stdin[0] === wbin + ":pasted" && r.spawns.some((x) => x.args === "key-sequence --keys ctrl+v" && x.opts.env), "type via clipboard: target clipboard + ctrl+v", JSON.stringify({ e: ty.e && ty.e.message, s: r.spawns.map((x) => x.bin + " " + x.args) }));
  r.state.clipErr = target.kind === "x11" ? "Error: target STRING not available" : "No suitable type of content copied";
  const em = await settle(r.ex.readClipboard());
  check(!em.e && em.v === "", "an empty selection reads as empty text", JSON.stringify(em.e ? em.e.message : em.v));
  check(r.clip.length === 0 && !r.spawns.some((x) => x.kind.startsWith("sync") && /xclip|xsel|wl-/.test(x.bin)) && r.spawns.some((x) => x.bin === rbin), "no sync spawn, Electron clipboard never touched", JSON.stringify(r.clip));
}
for (const target of [{ kind: "x11", display: ":99" }, { kind: "wlroots", display: "wayland-9" }]) {
  console.log(`\n[T7 clipboard: ${target.kind} target without a tool]`);
  const r = makeRig("x11", { "claude-desktop-extra.json": cfg({ enabled: true, ...target }) });
  await r.ex.__setLockHeld(true);
  r.reset();
  const rd = await settle(r.ex.readClipboard()), wr = await settle(r.ex.writeClipboard("x"));
  const rx = target.kind === "x11" ? /install the xclip package/ : /install the wl-clipboard package/;
  check(rd.e && wr.e && rx.test(rd.e.message) && rx.test(wr.e.message) && r.clip.length === 0, "refused, naming the package", JSON.stringify([rd.e && rd.e.message]));
}
console.log("\n[T7 off: Electron clipboard as before]");
{
  const r = makeRig("x11", {}, { installed: ["/usr/bin/xclip"] });
  r.reset();
  const rd = await r.ex.readClipboard(); await r.ex.writeClipboard("y");
  check(rd === "host" && r.clip.join() === "read,write:y" && r.spawns.length === 0, "desktop clipboard via Electron, no tool spawned (pin, same as before)", JSON.stringify({ rd, clip: r.clip }));
}

// ------------------------------------------------ 10. T4 review follow-ups
console.log("\n[broken .jsonc: fail closed only when its text names the key]");
{
  const r = makeRig("wlroots", { "claude-desktop-extra.jsonc": "{ \"computerUseBackgroundDisplay\": { \"enabled\": true, \"kind\": \"x11\", \"display\": \":99\" ", "claude-desktop-extra.json": cfg({ enabled: false }) });
  r.reset();
  await r.ex.__setLockHeld(true);
  const tc = r.ex.__targetCheck ? await r.ex.__targetCheck("screenshot") : null;
  const o = await settle(r.ex.click(1, 1, "left", 1));
  check(/claude-desktop-extra\.jsonc cannot be parsed/.test(tc || "") && o.e && r.spawns.length === 0 && r.diag.some((d) => /diagnostics: target=invalid \(claude-desktop-extra\.jsonc cannot be parsed/.test(d)), "unparseable .jsonc naming the key: refused, nothing driven, diagnostics line", JSON.stringify({ tc, n: r.spawns.length }));
}
// The switch-off path, byte for byte, against a rig with no config at all.
async function offTrace(files) {
  const r = makeRig("wlroots", files);
  const loadDiag = r.diag.slice();
  r.reset();
  await r.ex.__setLockHeld(true);
  await drive(r.ex);
  return { r, loadDiag, trace: JSON.stringify(r.spawns.map((x) => [x.kind, x.bin, x.args, Object.keys(x.opts).sort()])) };
}
const OFF = (await offTrace({})).trace;
for (const [label, files, diagRx] of [
  ["unparseable .jsonc without the key", { "claude-desktop-extra.jsonc": "{ \"panelTabs\": true, oops }" }, /claude-desktop-extra\.jsonc does not parse .* does not mention computerUseBackgroundDisplay/],
  ["a .jsonc that is not an object", { "claude-desktop-extra.jsonc": "[1,2]" }, /does not parse \(not a JSON object\)/],
  ["unreadable .jsonc (EACCES)", { "claude-desktop-extra.jsonc": Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }) }, /claude-desktop-extra\.jsonc cannot be read \(EACCES\)/],
  ["a broken .json (no .jsonc)", { "claude-desktop-extra.json": "{ broken" }, null]
]) {
  const { r, trace, loadDiag } = await offTrace(files);
  const tc = r.ex.__targetCheck ? await r.ex.__targetCheck("screenshot") : null;
  const dl = loadDiag.concat(r.diag);
  check(trace === OFF && noEnvKey(r) && tc === null, label + ": the switch-off path, identical spawns, no env key", trace === OFF ? String(tc) : trace.slice(0, 300));
  if (diagRx) check(dl.filter((d) => diagRx.test(d)).length === 1, label + ": one diagnostics line", JSON.stringify(dl));
}
{
  // The skipped .jsonc leaves the .json in charge, as before.
  const r = makeRig("wlroots", { "claude-desktop-extra.jsonc": "{ oops", "claude-desktop-extra.json": cfg({ enabled: true, kind: "x11", display: ":99" }) });
  await r.ex.__setLockHeld(true);
  r.reset();
  await settle(r.ex.click(1, 1, "left", 1));
  check(bins(r).join() === "x11-bridge", "unparseable .jsonc without the key: the .json still applies", JSON.stringify(bins(r)));
}

console.log("\n[T4 review MED/LOW: the env map and DISPLAY spellings obey the own-display rule]");
for (const [label, host, target, extraEnv, rx] of [
  ["x11 target, env WAYLAND_DISPLAY = own socket", "wlroots", { kind: "x11", display: ":99", env: { WAYLAND_DISPLAY: "wayland-1" } }, {}, /env WAYLAND_DISPLAY wayland-1 is your own desktop/],
  ["x11 target, env WAYLAND_DISPLAY aliasing own via env XDG_RUNTIME_DIR", "wlroots", { kind: "x11", display: ":99", env: { WAYLAND_DISPLAY: "wayland-9", XDG_RUNTIME_DIR: "/tmp/cutest/rt" } }, {}, /env WAYLAND_DISPLAY wayland-9 is your own desktop/],
  ["wlroots target, env DISPLAY = own :0", "x11", { kind: "wlroots", display: "wayland-9", env: { DISPLAY: ":0" } }, {}, /env DISPLAY :0 is your own desktop/],
  ["wlroots target, env DISPLAY unix:0.0", "x11", { kind: "wlroots", display: "wayland-9", env: { DISPLAY: "unix:0.0" } }, {}, /env DISPLAY unix:0\.0 is your own desktop/],
  ["own DISPLAY [::1]:0", "x11", { kind: "x11", display: ":0" }, { DISPLAY: "[::1]:0" }, /your own desktop/],
  ["own DISPLAY ::1:0", "x11", { kind: "x11", display: ":0" }, { DISPLAY: "::1:0" }, /your own desktop/],
  ["own DISPLAY host::0 (DECnet)", "x11", { kind: "x11", display: ":0" }, { DISPLAY: "host::0" }, /your own desktop/]
]) {
  const r = makeRig(host, { "claude-desktop-extra.json": cfg({ enabled: true, ...target }) }, { env: extraEnv });
  r.reset();
  await r.ex.__setLockHeld(true);
  const tc = r.ex.__targetCheck ? await r.ex.__targetCheck("screenshot") : null;
  await drive(r.ex);
  check(rx.test(tc || "") && r.spawns.length === 0, label + ": refused, never driven", JSON.stringify({ tc, s: r.spawns.map((x) => x.bin + " " + x.args) }));
}
{
  const r = makeRig("x11", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "wlroots", display: "wayland-9", env: { DISPLAY: ":5" } }) });
  await r.ex.__setLockHeld(true);
  check((r.ex.__targetCheck ? await r.ex.__targetCheck("screenshot") : "x") === null, "an env DISPLAY that is not the desktop's is allowed");
}

console.log("\n[default wayland-0 socket next to an x11 target: no libwayland fallback]");
for (const [label, env, wantSock] of [["no env map", {}, ""], ["env map sets WAYLAND_DISPLAY", { WAYLAND_DISPLAY: "/run/user/1000/wayland-7" }, undefined]]) {
  const r = makeRig("gnome", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "x11", display: ":99", env }) });
  await r.ex.__setLockHeld(true);
  r.reset();
  await settle(r.ex.click(5, 5, "left", 1));
  const e = r.spawns.length ? r.spawns[r.spawns.length - 1].opts.env || {} : {};
  check(e.WAYLAND_SOCKET === wantSock && e.GDK_BACKEND === "x11" && e.QT_QPA_PLATFORM === "xcb" && e.MOZ_ENABLE_WAYLAND === "0" && (wantSock === "" ? !("WAYLAND_DISPLAY" in e) : e.WAYLAND_DISPLAY === env.WAYLAND_DISPLAY), label + ": WAYLAND_SOCKET " + JSON.stringify(wantSock) + ", toolkits on X11", JSON.stringify({ WS: e.WAYLAND_SOCKET, WD: e.WAYLAND_DISPLAY, G: e.GDK_BACKEND }));
}
{
  const r = makeRig("x11", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "wlroots", display: "wayland-0" }) });
  await r.ex.__setLockHeld(true);
  const tc = r.ex.__targetCheck ? await r.ex.__targetCheck("screenshot") : "x";
  r.reset();
  await settle(r.ex.click(5, 5, "left", 1));
  const e = r.spawns.length ? r.spawns[0].opts.env || {} : {};
  check(tc === null && e.WAYLAND_DISPLAY === "wayland-0" && !("DISPLAY" in e) && e.ELECTRON_OZONE_PLATFORM_HINT === "wayland", "wlroots target wayland-0 on an X11 desktop: used, DISPLAY unset, Electron on Wayland", JSON.stringify({ tc, W: e.WAYLAND_DISPLAY, D: e.DISPLAY }));
}

console.log("\n[GNOME session from a desktop lock ends at target acquire, in the desktop env]");
{
  const files = {};
  const r = makeRig("gnome", files);
  await r.ex.__setLockHeld(true);
  check(r.spawns.some((x) => x.args === "session-start"), "desktop lock: portal session started");
  files["claude-desktop-extra.json"] = cfg({ enabled: true, kind: "x11", display: ":99" });
  r.reset();
  await r.ex.__setLockHeld(true);
  const end = r.spawns.find((x) => x.args === "session-end");
  check(end && end.bin === "gnome-portal-bridge" && !("env" in end.opts) && !r.spawns.some((x) => x.args === "session-start") && r.spawns.some((x) => x.bin === "x11-bridge" && x.args === "screens"), "target acquire: session-end (no overlay env), no new session, target checked", JSON.stringify(r.spawns.map((x) => x.bin + " " + x.args + ("env" in x.opts ? " +env" : ""))));
}

console.log("\n[after the lock is released the target stays latched]");
{
  const r = makeRig("wlroots", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "x11", display: ":99" }) });
  await r.ex.__setLockHeld(true);
  await r.ex.__setLockHeld(false);
  r.reset();
  await settle(r.ex.click(5, 5, "left", 1));
  check(bins(r).join() === "x11-bridge" && r.spawns.every((x) => x.opts.env && x.opts.env.DISPLAY === ":99"), "a call after release still goes to the target, never the desktop", JSON.stringify(r.spawns.map((x) => x.bin)));
}

console.log("\n[drag / holdKey / mouseDown / moveMouse on the target]");
for (const target of [{ kind: "x11", display: ":99" }, { kind: "wlroots", display: "wayland-9" }]) {
  const tb = target.kind === "x11" ? "x11-bridge" : "wlroots-bridge";
  const r = makeRig("kde", { "claude-desktop-extra.json": cfg({ enabled: true, ...target }) });
  await r.ex.__setLockHeld(true);
  r.reset(); r.state.throwScreen = true;
  const res = [await settle(r.ex.moveMouse(10, 20)), await settle(r.ex.mouseDown()), await settle(r.ex.mouseUp()), await settle(r.ex.drag({ x: 1, y: 2 }, { x: 3, y: 4 })), await settle(r.ex.holdKey("shift", 0.1))];
  const subs = r.spawns.map((x) => x.args.split(" ")[0]);
  check(res.every((x) => !x.e) && bins(r).join() === tb && r.spawns.every((x) => x.opts.env) && ["pointer-move", "left-mouse-down", "left-mouse-up", "pointer-drag", "hold-key"].every((c) => subs.includes(c)) && r.screenCalls.length === 0, target.kind + ": every input through " + tb + " with the overlay, no ydotool", JSON.stringify({ e: res.filter((x) => x.e).map((x) => x.e.message), b: bins(r), subs }));
}

console.log("\n[kwin mode: switch turned on while running -> restart hint, nothing on the desktop]");
{
  const KW = readFileSync(KWIN_EXECUTOR, "utf8")
    .replace("import { execFile as execFileCb, spawnSync } from 'node:child_process'", "const { execFile: execFileCb, spawnSync } = __cp")
    .replace("import { screen as electronScreen } from 'electron'", "const electronScreen = { getAllDisplays: () => [], getPrimaryDisplay: () => ({}) }")
    .replace("import { promisify } from 'node:util'", "const { promisify } = __util")
    .replace(/^export /gm, "");
  const kcalls = [];
  const kcp = { execFile(bin, args, opts, cb) { if (typeof opts === "function") cb = opts; kcalls.push((args || []).join(" ")); setImmediate(() => cb(null, { stdout: args[0] === "screens" ? JSON.stringify(SCREENS) : "{}", stderr: "" })); }, spawnSync() { return { status: 0 }; } };
  const util = await import("node:util");
  globalThis.__cdbDiag = () => {};
  globalThis.__cuKwinBridgeBin = "/res/kwin-portal-bridge";
  let on = true;
  globalThis.__cuTargetRead = () => on ? { kind: "x11", display: ":99", env: {} } : null;
  const mod = new Function("__cp", "__util", KW + "\nreturn { createLinuxExecutor };")(kcp, util.default || util);
  const kx = mod.createLinuxExecutor({ hostBundleId: "com.anthropic.claude" });
  await kx.__setLockHeld(true);
  const shot = await settle(kx.screenshot({ displayId: 0 }));
  const clk = await settle(kx.click(5, 5, "left", 1));
  check(kcalls.length === 0 && shot.e && /takes effect on KDE Plasma after Claude restarts/.test(shot.e.message) && clk.e && /after Claude restarts/.test(clk.e.message), "lock refused: no session-start, no command, the model reads the restart hint", JSON.stringify({ kcalls, s: shot.e && shot.e.message, c: clk.e && clk.e.message }));
  await kx.__setLockHeld(false);
  on = false;
  await kx.__setLockHeld(true);
  check(kcalls.includes("session-start"), "switch off again: the next lock starts the portal session as before", JSON.stringify(kcalls));
  await kx.__setLockHeld(false);
  delete globalThis.__cuTargetRead;
}

// ------------------------------------------- 11. T10 / T5-T7 review fixes
console.log("\n[T10 HIGH: the target dies mid-lock]");
for (const target of [{ kind: "x11", display: ":99" }, { kind: "wlroots", display: "wayland-9" }]) {
  fakeClock(true);
  try {
    const r = makeRig("gnome", { "claude-desktop-extra.json": cfg({ enabled: true, ...target }) }, { windows: (l) => l ? [GEDIT_WIN] : [] });
    await r.ex.__setLockHeld(true);
    r.state.dead = true;
    r.reset();
    const o = await settle(r.ex.openApp("gedit"));
    const DOWN_T = "Computer Use is set to the background display " + target.display + ", which is not running. Start it, or turn off Settings -> Extra -> Cowork (Linux) -> Computer Use on a background display.";
    check(o.e && o.e.message === DOWN_T && !r.spawns.some((x) => x.kind === "spawn"), target.kind + ": openApp refuses and never spawns the app", JSON.stringify({ e: o.e && o.e.message, v: o.v, sp: r.spawns.filter((x) => x.kind === "spawn").map((x) => x.bin + " " + x.args) }));
    const c1 = r.ex.__targetAfterError ? await r.ex.__targetAfterError(new Error("x")) : null;
    const c2 = r.ex.__targetCheck ? await r.ex.__targetCheck("left_click") : null;
    check(c1 === DOWN_T && c2 === DOWN_T, target.kind + ": a failed action re-checks the display; following calls get the refusal", JSON.stringify({ c1, c2 }));
    r.state.dead = false;
    const c3 = r.ex.__targetCheck ? await r.ex.__targetCheck("left_click") : "x";
    check(c3 === null, target.kind + ": answers again -> calls go through", String(c3));
  } finally { fakeClock(false); }
}
{
  // Through the handler: the raw bridge error becomes the refusal.
  let src = HANDLER.replace("__SELF__", "__self").split("__MAKE_DISPATCH__").join("__mk()").split("__STATE__").join("__state")
    .split("__TOOL_NAME__").join("__tool").split("__INPUT__").join("__input").split("__SESSION__").join("__session");
  src = src.replace('if(process.platform==="linux"){', 'if(process.platform==="linux"&&!globalThis.__cuKwinMode){');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction("process", "require", "__self", "__mk", "__state", "__tool", "__input", "__session", src + "\nreturn {fell:true};");
  const req = () => ({ BrowserWindow: { getAllWindows: () => [] } });
  const call = (tool, input = {}) => fn({ platform: "linux", env: process.env }, req, {}, () => async () => ({}), {}, tool, input, {});
  const r = makeRig("x11", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "x11", display: ":99" }) });
  await r.ex.__setLockHeld(true);
  r.state.dead = true;
  const a = await call("left_click", { coordinate: [3, 3] });
  const b = await call("screenshot", {});
  check(a.isError && a.content[0].text === DOWN && b.isError && b.content[0].text === DOWN, "handler: click / screenshot on a dead target return the not-running text, not the bridge error", JSON.stringify([a.content[0].text, b.content[0].text]));
  const off = makeRig("x11", {});
  off.state.dead = true;
  const c = await call("left_click", { coordinate: [3, 3] });
  check(c.isError && /^Error: /.test(c.content[0].text), "switch off: the bridge error is reported as before", JSON.stringify(c));
}

console.log("\n[T5-T7 review MED: launch budget and credit]");
fakeClock(true);
try {
  const late = makeRig("x11", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "x11", display: ":99" }) }, { windows: (l) => l && clock >= 9000 ? [GEDIT_WIN] : [] });
  await late.ex.__setLockHeld(true);
  clock = 0;
  const o = await settle(late.ex.openApp("gedit"));
  check(!o.e && o.v.action === "launched", "a window after 9 s (budget 15 s) -> launched", o.e ? o.e.message : JSON.stringify(o.v));

  const XTERM = { id: "0x9", resource_class: "xterm", title: "xterm" };
  const noise = makeRig("x11", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "x11", display: ":99" }) }, { windows: (l) => !l ? [] : clock >= 6000 ? [XTERM, GEDIT_WIN] : [XTERM] });
  await noise.ex.__setLockHeld(true);
  clock = 0; noise.reset();
  const n = await settle(noise.ex.openApp("gedit"));
  check(!n.e && n.v.action === "launched" && noise.spawns.some((x) => x.args === "activate-window --window 0x400001") && !noise.spawns.some((x) => x.args === "activate-window --window 0x9"), "an unrelated new window is not credited; the app's own is", JSON.stringify({ v: n.v, e: n.e && n.e.message }));
  const only = makeRig("x11", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "x11", display: ":99" }) }, { windows: (l) => l ? [XTERM] : [] });
  await only.ex.__setLockHeld(true);
  clock = 0;
  const on = await settle(only.ex.openApp("gedit"));
  check(on.e && on.e.message === HANDOFF, "only an unrelated new window -> the 15 s message", on.e ? on.e.message : JSON.stringify(on.v));
  const kid = makeRig("x11", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "x11", display: ":99" }) }, { windows: (l) => l ? [{ id: "0x77", resource_class: "weird", title: "Weird", pid: 4243 }] : [] });
  await kid.ex.__setLockHeld(true);
  clock = 0;
  const k = await settle(kid.ex.openApp("gedit"));
  check(!k.e && k.v.action === "launched", "a window whose pid is in the launched process tree is credited", k.e ? k.e.message : JSON.stringify(k.v));

  console.log("\n[T5-T7 review LOW: a target that cannot list windows]");
  const nl = makeRig("x11", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "x11", display: ":99" }) }, { windows: () => new Error("Command failed: windows\nError: EWMH query failed") });
  await nl.ex.__setLockHeld(true);
  nl.reset();
  const w = await settle(nl.ex.openApp("gedit"));
  check(!w.e && w.v.action === "launch_attempted" && /cannot be verified/.test(w.v.note || "") && nl.spawns.some((x) => x.kind === "spawn" && x.args === "gedit"), "screens fine, windows failing -> launched, launch_attempted (never \"opened\")", JSON.stringify(w.e ? w.e.message : w.v));
} finally { fakeClock(false); }

console.log("\n[fractional-scale wlroots target]");
{
  const FR = [{ name: "HEADLESS-1", id: "HEADLESS-1", geometry: { x: 0, y: 0, width: 1280, height: 800 }, scale: 1.5, is_primary: true }];
  const r = makeRig("x11", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "wlroots", display: "wayland-9" }) }, { screens: () => FR, displays: HOST_HIDPI });
  r.state.recordScreen = true;
  await r.ex.__setLockHeld(true);
  const ds = (await settle(r.ex.listDisplays())).v || [];
  r.reset(); r.state.recordScreen = true;
  await settle(r.ex.screenshot({ displayId: 0 }));
  await settle(r.ex.zoom({ x: 101, y: 51, w: 200, h: 100 }, 1, null));
  await settle(r.ex.click(640, 400, "left", 1));
  check(ds.length === 1 && ds[0].scaleFactor === 1.5 && ds[0].width === 1280 && JSON.stringify(zoomArgs(r)) === JSON.stringify(["zoom --x 0 --y 0 --w 1280 --h 800 --display HEADLESS-1", "zoom --x 101 --y 51 --w 200 --h 100 --display HEADLESS-1"]) && r.spawns.some((x) => /^pointer-click --x 640 --y 400 /.test(x.args)) && r.screenCalls.length === 0, "scale 1.5: logical geometry in, logical regions and points out", JSON.stringify({ ds, z: zoomArgs(r), sc: r.screenCalls }));
}

console.log("\n[listDisplays before the first lock]");
{
  const r = makeRig("gnome", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "x11", display: ":99" }) }, { screens: () => T_SCREENS, displays: HOST_HIDPI });
  r.state.recordScreen = true;
  const ds = (await settle(r.ex.listDisplays())).v || [];
  check(ds.length === 2 && ds[0].label === "T1" && r.spawns.some((x) => x.args === "screens" && x.bin === "x11-bridge") && r.screenCalls.length === 0, "no lock yet: the target's monitors, primed on demand", JSON.stringify({ ds: ds.map((d) => d.label), sc: r.screenCalls }));
}

console.log("\n[xsel: read back until it owns the selection]");
{
  const r = makeRig("gnome", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "x11", display: ":99" }) }, { installed: ["/usr/bin/xsel"] });
  await r.ex.__setLockHeld(true);
  r.reset(); r.state.clipLag = 3;
  const w = await settle(r.ex.writeClipboard("new"));
  const reads = r.spawns.filter((x) => x.bin === "xsel" && x.args === "--clipboard --output").length;
  check(!w.e && reads === 4, "write returns after the read-back sees the text (3 stale reads, then it)", JSON.stringify({ e: w.e && w.e.message, reads }));
  r.reset(); r.state.clipLag = 1000;
  const f = await settle(r.ex.writeClipboard("never"));
  check(f.e && /xsel did not take the clipboard/.test(f.e.message) && r.spawns.filter((x) => x.args === "--clipboard --output").length === 20, "bounded: 20 reads, then an error", JSON.stringify(f.e && f.e.message));
  r.state.clipLag = 0;
}

console.log("\n[handler state is dropped when the target changes]");
{
  const files = { "claude-desktop-extra.json": cfg({ enabled: true, kind: "x11", display: ":99" }) };
  const r = makeRig("x11", files);
  globalThis.__cuLastShot = { imgW: 1 }; globalThis.__cuPinnedDisplay = 1;
  await r.ex.__setLockHeld(true);
  const same = globalThis.__cuLastShot !== null;
  files["claude-desktop-extra.json"] = cfg({ enabled: true, kind: "x11", display: ":98" });
  globalThis.__cuLastShot = { imgW: 1 }; globalThis.__cuPinnedDisplay = 1;
  await r.ex.__setLockHeld(true);
  const moved = globalThis.__cuLastShot === null && globalThis.__cuPinnedDisplay === undefined;
  globalThis.__cuLastShot = { imgW: 1 }; globalThis.__cuPinnedDisplay = 1;
  files["claude-desktop-extra.json"] = cfg({ enabled: false });
  await r.ex.__setLockHeld(true);
  const toOff = globalThis.__cuLastShot === null && globalThis.__cuPinnedDisplay === undefined;
  globalThis.__cuLastShot = { imgW: 1 };
  await r.ex.__setLockHeld(true);
  const offOff = globalThis.__cuLastShot !== null;
  check(same && moved && toOff && offOff, "same target keeps it; another display or on->off drops it; off->off untouched", JSON.stringify({ same, moved, toOff, offOff }));
  globalThis.__cuLastShot = null; globalThis.__cuPinnedDisplay = undefined;
}

// ------------------------------------------------ 12. final review LOWs
console.log("\n[final review LOW-1: the desktop compositor's IPC sockets never reach the target]");
for (const [label, env, keep] of [["no env map", {}, null], ["env map sets SWAYSOCK", { SWAYSOCK: "/tmp/cutest/target-sway.sock" }, "SWAYSOCK"]]) {
  for (const kind of ["x11", "wlroots"]) {
    const r = makeRig("wlroots", { "claude-desktop-extra.json": cfg({ enabled: true, kind, display: kind === "x11" ? ":99" : "wayland-9", env }) }, { env: { I3SOCK: "/run/user/1000/i3.sock", HYPRLAND_INSTANCE_SIGNATURE: "abc", NIRI_SOCKET: "/run/user/1000/niri.sock" } });
    await r.ex.__setLockHeld(true);
    r.reset();
    await settle(r.ex.click(5, 5, "left", 1));
    const e = r.spawns.length ? r.spawns[0].opts.env || {} : null;
    for (const v of ["SWAYSOCK", "I3SOCK", "HYPRLAND_INSTANCE_SIGNATURE", "NIRI_SOCKET"]) {
      const ok = e && (v === keep ? e[v] === env[v] : !(v in e));
      check(ok, `${kind} target, ${label}: ${v} ${v === keep ? "from the env map" : "removed"}`, JSON.stringify(e && e[v]));
    }
  }
}
console.log("\n[final review LOW-3: an invalid target stays refused as invalid]");
{
  const r = makeRig("x11", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "weston", display: ":99" }) });
  await r.ex.__setLockHeld(true);
  r.reset();
  const o = await settle(r.ex.openApp("gedit"));
  const tc = r.ex.__targetCheck ? await r.ex.__targetCheck("open_application") : null;
  check(o.e && /setting is invalid: kind/.test(o.e.message) && !/not running/.test(o.e.message) && /setting is invalid: kind/.test(tc || "") && r.spawns.length === 0, "openApp on an invalid target: the invalid text, not \"not running\", nothing spawned", JSON.stringify({ e: o.e && o.e.message, tc }));
}

// ---------------------------- 13. BLOCKER: no lock hook (upstream acquireApp)
// Upstream's app-scoped lock never reaches __setLockHeld: the setting must be
// picked up by the next tool call on its own.
{
  let src = HANDLER.replace("__SELF__", "__self").split("__MAKE_DISPATCH__").join("__mk()").split("__STATE__").join("__state")
    .split("__TOOL_NAME__").join("__tool").split("__INPUT__").join("__input").split("__SESSION__").join("__session");
  src = src.replace('if(process.platform==="linux"){', 'if(process.platform==="linux"&&!globalThis.__cuKwinMode){');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction("process", "require", "__self", "__mk", "__state", "__tool", "__input", "__session", src + "\nreturn {fell:true};");
  const req = () => ({ BrowserWindow: { getAllWindows: () => [] } });
  const call = (tool, input = {}) => fn({ platform: "linux", env: process.env }, req, {}, () => async () => ({}), {}, tool, input, {});

  console.log("\n[BLOCKER: switch turned on after startup, no lock hook -> the next tool call hits the target]");
  {
    const files = {};
    const r = makeRig("x11", files, { windows: (l) => l ? [GEDIT_WIN] : [] });
    // A tool call on the desktop first (the session started with the switch off).
    tick(); r.reset();
    await call("left_click", { coordinate: [3, 3] });
    check(bins(r).join() === "x11-bridge" && noEnvKey(r), "before: the desktop, no env option");
    files["claude-desktop-extra.json"] = cfg({ enabled: true, kind: "x11", display: ":98" });
    tick(); r.reset();
    const c = await call("left_click", { coordinate: [3, 3] });
    check(!c.isError && r.spawns.length > 0 && r.spawns.every((x) => x.opts.env && x.opts.env.DISPLAY === ":98") && r.diag.some((d) => /diagnostics: target=x11 :98/.test(d)), "after: every spawn on :98, target= line logged", JSON.stringify({ c, s: r.spawns.map((x) => x.bin + " " + x.args + " " + (x.opts.env && x.opts.env.DISPLAY)) }));
    fakeClock(true);
    try {
      tick(); r.reset();
      const o = await call("open_application", { app: "gedit" });
      const sp = r.spawns.filter((x) => x.kind === "spawn");
      check(!o.isError && sp.length === 1 && sp[0].opts.env && sp[0].opts.env.DISPLAY === ":98", "open_application launches with the target env (not the desktop's DISPLAY)", JSON.stringify({ o, sp: sp.map((x) => [x.args, x.opts.env && x.opts.env.DISPLAY]) }));
    } finally { fakeClock(false); }
    // Outside the handler gate a change refuses that one call, then the latch holds.
    files["claude-desktop-extra.json"] = cfg({ enabled: true, kind: "x11", display: ":97" });
    tick(); r.reset();
    const a1 = await settle(r.ex.listRunningApps());
    check(a1.e && /setting changed during this action/.test(a1.e.message) && r.spawns.every((x) => x.args === "screens" && x.opts.env && x.opts.env.DISPLAY === ":97"), "listRunningApps (no handler) right after a change: refused, only the new target checked", JSON.stringify({ e: a1.e && a1.e.message, s: r.spawns.map((x) => x.args) }));
    tick(); r.reset();
    const apps = await settle(r.ex.listRunningApps());
    check(!apps.e && r.spawns.length && r.spawns.every((x) => x.bin === "x11-bridge" && x.opts.env && x.opts.env.DISPLAY === ":97"), "the next listRunningApps enumerates the new target", JSON.stringify(r.spawns.map((x) => x.args)));
    files["claude-desktop-extra.json"] = cfg({ enabled: false });
    tick(); r.reset();
    const d = await call("left_click", { coordinate: [3, 3] });
    check(!d.isError && bins(r).join() === "x11-bridge" && noEnvKey(r) && r.diag.some((x) => /target=off/.test(x)), "switched off mid-session: back on the default path at the next call", JSON.stringify(r.spawns.map((x) => x.args)));
    delete files["claude-desktop-extra.json"];
    files["claude-desktop-extra.json"] = cfg({ enabled: true, kind: "x11", display: ":98" });
    tick(); await call("left_click", { coordinate: [3, 3] });
    delete files["claude-desktop-extra.json"];
    tick(); r.reset();
    await call("left_click", { coordinate: [3, 3] });
    check(noEnvKey(r) && bins(r).join() === "x11-bridge", "key removed: default path at the next call", JSON.stringify(r.spawns.map((x) => x.args)));
  }

  console.log("\n[BLOCKER: switch turned on later, target down -> refusal, no desktop capture]");
  {
    const files = {};
    const r = makeRig("x11", files, { screens: (b) => new Error("Command failed: " + b + " screens\nError: cannot open display :98") });
    tick(); await call("left_click", { coordinate: [3, 3] });
    files["claude-desktop-extra.json"] = cfg({ enabled: true, kind: "x11", display: ":98" });
    tick(); r.reset();
    const sh = await call("screenshot", {});
    const DOWN98 = DOWN.replace(":99", ":98");
    check(sh.isError && sh.content[0].text === DOWN98 && !r.spawns.some((x) => /^zoom/.test(x.args)) && r.dc.length === 0, "the first tool call after turning it on: not-running refusal, no capture of the desktop", JSON.stringify({ t: sh.content && sh.content[0].text, s: r.spawns.map((x) => x.args) }));
    tick(); r.reset();
    const c = await call("left_click", { coordinate: [3, 3] });
    check(c.isError && c.content[0].text === DOWN98 && r.spawns.every((x) => x.args === "screens"), "and every following tool", JSON.stringify({ t: c.content && c.content[0].text, s: r.spawns.map((x) => x.args) }));
  }

  console.log("\n[latch review MED: a save within 200 ms of the previous check, no tick]");
  {
    const files = {};
    const r = makeRig("x11", files, {});
    tick(); await call("cursor_position", {});
    files["claude-desktop-extra.json"] = cfg({ enabled: true, kind: "x11", display: ":98" });
    r.reset();
    const c = await call("left_click", { coordinate: [3, 3] });
    check(r.spawns.length > 0 && r.spawns.every((x) => x.opts.env && x.opts.env.DISPLAY === ":98"), "the next tool call goes to the target, not the desktop", JSON.stringify(r.spawns.map((x) => x.bin + " " + x.args + " env=" + (x.opts.env && x.opts.env.DISPLAY))));
  }

  console.log("\n[latch review LOW: the setting flips in the middle of a computer_batch]");
  for (const [label, from, to] of [["target -> off", cfg({ enabled: true, kind: "x11", display: ":98" }), cfg({ enabled: false })], ["off -> target", cfg({ enabled: false }), cfg({ enabled: true, kind: "x11", display: ":98" })]]) {
    const files = { "claude-desktop-extra.json": from };
    const r = makeRig("x11", files, {});
    let n = 0;
    const self = { handleToolCall: async (st, tool, input) => { if (n++ === 1) files["claude-desktop-extra.json"] = to; return fn({ platform: "linux", env: process.env }, req, self, () => async () => ({}), {}, tool, input, {}); } };
    const bcall = (input) => fn({ platform: "linux", env: process.env }, req, self, () => async () => ({}), {}, "computer_batch", input, {});
    tick(); await bcall({ actions: [{ action: "cursor_position" }] });
    n = 0; tick(); r.reset();
    const b = await bcall({ actions: [{ action: "left_click", coordinate: [3, 3] }, { action: "type", text: "secret" }, { action: "key", text: "Return" }] });
    const txt = (b.content || []).map((x) => x.text || "").join("\n");
    const typed = r.spawns.some((x) => /^type /.test(x.args)), keyed = r.spawns.some((x) => /^key-sequence /.test(x.args));
    const firstEnv = r.spawns.filter((x) => /^pointer-/.test(x.args)).map((x) => x.opts.env ? x.opts.env.DISPLAY : "desktop");
    check(b.isError && /setting changed during this action/.test(txt) && !typed && !keyed && firstEnv.length > 0 && firstEnv.every((d) => d === firstEnv[0]), label + ": the first action runs on the latched display, the rest is refused, nothing typed anywhere", JSON.stringify({ txt: txt.slice(0, 300), s: r.spawns.map((x) => x.args + " " + (x.opts.env ? x.opts.env.DISPLAY : "desktop")) }));
    tick(); r.reset();
    await bcall({ actions: [{ action: "left_click", coordinate: [3, 3] }] });
    const now = r.spawns.map((x) => x.opts.env ? x.opts.env.DISPLAY : "desktop");
    check(now.length > 0 && now.every((d) => d === (label === "target -> off" ? "desktop" : ":98")), label + ": the next batch runs on the new setting", JSON.stringify(now));
  }

  console.log("\n[default path, files unchanged: no re-read, at most two stats per tool call]");
  {
    const r = makeRig("gnome", { "claude-desktop-extra.json": cfg({ enabled: false, kind: "x11", display: ":99" }) });
    const reads0 = r.state.reads;
    r.state.stats = 0;
    for (let i = 0; i < 5; i++) { tick(); await call("left_click", { coordinate: [3, 3] }); }
    check(r.state.reads === reads0 && r.state.stats <= 10, "5 tool calls: 0 reads, " + r.state.stats + " stats (<= 2 per call)", JSON.stringify({ reads: r.state.reads - reads0, stats: r.state.stats }));
  }

  console.log("\n[kwin mode: switch turned on without a lock hook]");
  {
    const KW = readFileSync(KWIN_EXECUTOR, "utf8")
      .replace("import { execFile as execFileCb, spawnSync } from 'node:child_process'", "const { execFile: execFileCb, spawnSync } = __cp")
      .replace("import { screen as electronScreen } from 'electron'", "const electronScreen = { getAllDisplays: () => [], getPrimaryDisplay: () => ({}) }")
      .replace("import { promisify } from 'node:util'", "const { promisify } = __util")
      .replace(/^export /gm, "");
    const kcalls = [];
    const kcp = { execFile(bin, args, opts, cb) { if (typeof opts === "function") cb = opts; kcalls.push((args || []).join(" ")); setImmediate(() => cb(null, { stdout: args[0] === "screens" ? JSON.stringify(SCREENS) : "{}", stderr: "" })); }, spawnSync() { return { status: 0 }; } };
    const util = await import("node:util");
    globalThis.__cdbDiag = () => {};
    globalThis.__cuKwinBridgeBin = "/res/kwin-portal-bridge";
    let on = false, sig = "a";
    globalThis.__cuTargetRead = () => on ? { kind: "x11", display: ":99", env: {} } : null;
    globalThis.__cuTargetSig = async () => sig; globalThis.__cuTargetSigSync = () => sig;
    const mod = new Function("__cp", "__util", KW + "\nreturn { createLinuxExecutor };")(kcp, util.default || util);
    const kx = mod.createLinuxExecutor({ hostBundleId: "com.anthropic.claude" });
    await kx.__setLockHeld(true);
    on = true; sig = "b"; kcalls.length = 0;
    const shot = await settle(kx.screenshot({ displayId: 0 }));
    check(shot.e && /after Claude restarts/.test(shot.e.message) && !kcalls.some((c) => /^(screenshot|zoom)/.test(c)), "the next command after the flip is refused with the restart hint", JSON.stringify({ e: shot.e && shot.e.message, kcalls }));
    await kx.__setLockHeld(false);
    delete globalThis.__cuTargetRead; delete globalThis.__cuTargetSig; delete globalThis.__cuTargetSigSync;
  }
}

// ------------------------------------------------- 6. preamble: no kwin mode
console.log("\n[preamble: a background display forces the regular executor]");
for (const [label, files, wantKwin] of [["off", {}, true], ["on", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "x11", display: ":99" }) }, false], ["on but invalid", { "claude-desktop-extra.json": cfg({ enabled: true, kind: "nope" }) }, false]]) {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, BASE_ENV, HOSTS.kde);
  process.resourcesPath = "/res";
  delete globalThis.__cuTargetRead; delete globalThis.__cuTargetIdentity; delete globalThis.__cuKwinBridgeBin; globalThis.__cuBridgeProbeCache = {}; globalThis.__cuBridgeFail = {};
  const spawned = [];
  const child = () => ({ stderr: { on() {} }, on(ev, cb) { if (ev === "close") setTimeout(() => cb(0, null), 0); }, kill() {} });
  const cp = { spawn: (b, a) => { spawned.push(path.basename(b) + " " + a.join(" ")); return child(); }, execFile: (b, a, o, cb) => { spawned.push(b + " " + a.join(" ")); setTimeout(() => cb(null, "kwin 6.6.0\n"), 0); } };
  const fsP = { constants: { X_OK: 1 }, accessSync: () => {}, existsSync: (p) => path.basename(String(p)) in files, readFileSync: (p) => { const n = path.basename(String(p)); if (n in files) return files[n]; const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; } };
  const reqP = (id) => ({ fs: fsP, path, child_process: cp, electron: { app: { getPath: () => "/ud" } } })[id];
  globalThis.__cdbDiag = () => {};
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction("require", "process", PREAMBLE)(reqP, process);
  check(globalThis.__cuKwinMode === wantKwin, `KDE 6.6 + kwin-portal-bridge, setting ${label}: kwin mode ${wantKwin}`, String(globalThis.__cuKwinMode));
  if (!wantKwin) check(!spawned.some((s) => /kwin/.test(s)), "no kwin probe spawned", JSON.stringify(spawned));
}

// ---------------- ydotoold started while the app runs (KDE Wayland, regular executor)
// A false ydotool check is re-checked after MISS_TTL_MS (5 s), only when a
// caller asks; a true one is kept.
{
  console.log("\n[ydotool: daemon started after a failed check is picked up after 5 s, then kept]");
  const r = makeRig("kde", {}, { ydotoold: false });
  await r.ex.__setLockHeld(true);
  // No reset between calls: pgrep counts are deltas, the log count is the total.
  let seen = 0;
  const pgTotal = () => r.spawns.filter((s) => s.bin === "pgrep").length;
  const via = async () => { const from = r.spawns.length, p0 = pgTotal(); const o = await settle(r.ex.click(100, 100, "left", 1)); const sp = r.spawns.slice(from); const v = o.e ? "E:" + o.e.message : sp.some((s) => s.bin === "ydotool") ? "ydotool" : sp.some((s) => s.bin === "x11-bridge") ? "x11-bridge" : JSON.stringify(sp.map((s) => s.bin)); seen = p0; return v; };
  const pg = () => pgTotal() - seen;
  const logs = () => r.diag.filter((l) => l.includes("ydotoold not running")).length;
  const a = await via(), aPg = pgTotal();
  r.state.ydotoold = true;
  NOW_OFF += 4000;
  const b = await via(), bPg = pg();
  NOW_OFF += 1000;
  const c = await via(), cPg = pg();
  r.state.ydotoold = false;
  NOW_OFF += 3600000;
  const d = await via(), dPg = pg();
  check(a === "x11-bridge" && aPg >= 1, "no ydotoold: x11-bridge fallback after a pgrep check", JSON.stringify({ a, aPg }));
  check(b === "x11-bridge" && bPg === 0, "daemon up, within 5 s: still the fallback, no new pgrep", JSON.stringify({ b, bPg }));
  check(c === "ydotool" && cPg === 1, "after 5 s: re-checked once on the next call, ydotool used", JSON.stringify({ c, cPg }));
  check(d === "ydotool" && dPg === 0, "a true result is kept (no pgrep an hour later, daemon gone)", JSON.stringify({ d, dPg }));
  check(logs() === 1, "'ydotoold not running' logged once, not on every re-check", logs());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
