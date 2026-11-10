#!/usr/bin/env node
// Computer Use app identity on Linux: ONE canonical id per app across every
// executor method (js/cu_linux_executor.js "App identity").
//
// Upstream's Computer Use dispatch (cloud Cowork / Dispatch, kwin mode, and
// later Code sessions through its approval dialog) resolves request_access
// names against listInstalledApps (+ listRunningApps), stores the grant under
// that bundleId, and then compares getFrontmostApp / appUnderPoint /
// listRunningApps / findWindowDisplays / resolvePrepareCapture ids against it
// by exact equality. The regular executor used to mix desktop-file ids, exe
// basenames, icon names and WM_CLASS strings, so a granted app never matched
// its own windows.
//
// Covered, with each bridge's real window JSON:
//   [1] listInstalledApps: canonical = desktop file id, Name row last, alias
//       rows (exe, snap/reverse-DNS tail, icon, words) only when unambiguous;
//       upstream's request_access resolver (Oi, mirrored) on "google chrome",
//       "Mousepad", "firefox", "chrome", "gnome-text-editor", "Terminal"
//   [2] x11-bridge: listRunningApps aliases - Chrome WM_CLASS Google-chrome vs
//       desktop id google-chrome, Mousepad, terminals, generic Electron class
//       (process cmdline), no class at all (/proc exe /opt/google/chrome/chrome),
//       transient dialog, unknown app, Claude itself (host id)
//   [3] x11-bridge: getFrontmostApp / appUnderPoint, raw command ids refined
//   [4] grant -> window matcher (__cdbCuWindowOwns) and findWindowDisplays with
//       canonical grants (flatpak org.mozilla.firefox vs WM_CLASS firefox)
//   [5] flatpak + snap Firefox, native Firefox precedence
//   [6] wlroots-bridge (app_id, no geometry): frontmost from the activated
//       toplevel only, appUnderPoint null, hitTest none
//   [7] gnome-portal-bridge (Introspect): same ids, appUnderPoint null
//   [8] XWayland (uncovered Wayland + x11-bridge): frontmost/appUnderPoint null
//   [9] background X display (Xvfb target): native hit test, target env
//   [10] kwin-portal-bridge (js/executor_linux.js): bridge ids pass through,
//        our index is not consulted in kwin mode
//   [11] capabilitiesNow per backend; static capabilities unchanged but for
//        hostBundleId
//   [12] named profile with its own identity (CHROME_DESKTOP=
//        com.anthropic.Claude-work.desktop): own pid and -work windows are the
//        host, the default profile's com.anthropic.Claude window is not
//
// Exit codes follow the repo convention: 0 = PASS, other = FAIL.
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, rmSync } from "node:fs";
import * as realFs from "node:fs";
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
const J = (v) => JSON.stringify(v);
console.debug = () => {};

// ── a desktop with real files ──────────────────────────────────────────────
const TMP = mkdtempSync(path.join(os.tmpdir(), "cdb-cu-appids-"));
process.on("exit", () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });
const HOME = path.join(TMP, "home"), BIN = path.join(TMP, "bin"), OPT = path.join(TMP, "opt");
function exe(f) { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, "#!/bin/sh\nexit 0\n"); chmodSync(f, 0o755); }
mkdirSync(HOME, { recursive: true });
for (const n of ["setsid", "env", "flatpak", "mousepad", "gnome-text-editor", "gnome-terminal", "xfce4-terminal", "konsole", "firefox", "claude-desktop", "slack"]) exe(path.join(BIN, n));
// Debian's google-chrome-stable is a symlink into /opt/google/chrome.
exe(path.join(OPT, "google/chrome/google-chrome")); exe(path.join(OPT, "google/chrome/chrome"));
symlinkSync(path.join(OPT, "google/chrome/google-chrome"), path.join(BIN, "google-chrome-stable"));
// An Electron runtime shared by apps: the interpreter never aliases, the asar does.
exe(path.join(OPT, "electron37/electron"));
symlinkSync(path.join(OPT, "electron37/electron"), path.join(BIN, "electron37"));
mkdirSync(path.join(OPT, "myapp"), { recursive: true }); writeFileSync(path.join(OPT, "myapp/app.asar"), "");
exe(path.join(OPT, "snapbin/firefox"));

const HDR = "[Desktop Entry]\nType=Application\n";
const sub = (s) => s.replace(/@BIN@/g, BIN).replace(/@OPT@/g, OPT);
function dataDir(name, entries) {
  const apps = path.join(TMP, name, "applications");
  mkdirSync(apps, { recursive: true });
  for (const [id, body] of Object.entries(entries)) writeFileSync(path.join(apps, id + ".desktop"), sub(HDR + body));
  return path.join(TMP, name);
}
const DESKTOP = {
  "google-chrome": "Name=Google Chrome\nExec=@BIN@/google-chrome-stable %U\nStartupWMClass=Google-chrome\nIcon=google-chrome\n",
  "com.google.Chrome": "Name=Google Chrome\nExec=@BIN@/google-chrome-stable %U\nStartupWMClass=google-chrome\nIcon=google-chrome\nNoDisplay=true\n",
  "chrome-abc-Profile_1": "Name=YouTube\nExec=@OPT@/google/chrome/google-chrome --profile-directory=Profile\\s1 --app-id=abc\nStartupWMClass=crx_abc\nIcon=chrome-abc-Profile_1\n",
  "org.xfce.mousepad": "Name=Mousepad\nExec=mousepad %U\nIcon=org.xfce.mousepad\n",
  "org.gnome.TextEditor": "Name=Text Editor\nExec=gnome-text-editor %U\nIcon=org.gnome.TextEditor\nDBusActivatable=true\n",
  "org.gnome.Terminal": "Name=Terminal\nExec=gnome-terminal\nIcon=org.gnome.Terminal\n",
  "xfce4-terminal": "Name=Xfce Terminal\nExec=xfce4-terminal\nIcon=org.xfce.terminal\n",
  "org.kde.konsole": "Name=Konsole\nExec=konsole\nIcon=utilities-terminal\n",
  "slack": "Name=Slack\nExec=@BIN@/slack %U\nStartupWMClass=Slack\n",
  "electron37": "Name=Electron 37\nExec=electron37 %u\nIcon=electron37\n",
  "myapp": "Name=My Electron App\nExec=@BIN@/electron37 @OPT@/myapp/app.asar %U\n",
  "com.anthropic.Claude": "Name=Claude\nExec=claude-desktop %U\nIcon=claude-desktop\nStartupWMClass=com.anthropic.Claude\n",
  "org.example.hidden": "Name=Slack\nExec=@BIN@/mousepad --hidden-helper\nNoDisplay=true\n",
  "org.mozilla.firefox": "Name=Firefox\nExec=flatpak run --branch=stable --arch=x86_64 --command=firefox --file-forwarding org.mozilla.firefox @@u %u @@\nStartupWMClass=firefox\nIcon=org.mozilla.firefox\n"
};
const SYS = dataDir("sys", DESKTOP);

// /proc of the fake app processes (pid -> exe, cmdline).
const PROC = {
  5001: { exe: path.join(OPT, "electron37/electron"), cmdline: [path.join(OPT, "electron37/electron"), path.join(OPT, "myapp/app.asar"), "--no-sandbox"] },
  5002: { exe: path.join(OPT, "google/chrome/chrome"), cmdline: [path.join(OPT, "google/chrome/chrome")] },
  5003: { exe: path.join(OPT, "electron37/electron"), cmdline: [path.join(OPT, "electron37/electron"), "/somewhere/else.asar"] }
};
const procFs = new Proxy(realFs, {
  get(t, p) {
    // Only this harness's desktop: the host's /var/lib/flatpak, /var/lib/snapd ... stay invisible.
    if (p === "readdirSync") return (d, ...r) => { if (!String(d).startsWith(TMP)) { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; } return t.readdirSync(d, ...r); };
    if (p === "readlinkSync") return (f, ...r) => { const m = /^\/proc\/(\d+)\/exe$/.exec(String(f)); if (m) { if (PROC[m[1]]) return PROC[m[1]].exe; const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; } return t.readlinkSync(f, ...r); };
    if (p === "readFileSync") return (f, ...r) => { const m = /^\/proc\/(\d+)\/cmdline$/.exec(String(f)); if (m) { if (PROC[m[1]]) return PROC[m[1]].cmdline.join("\0") + "\0"; const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; } return t.readFileSync(f, ...r); };
    return t[p];
  }
});

// ── window shapes, per bridge (same as test-cu-display-auto-target.mjs) ────
const R = (x, y, width, height) => ({ x, y, width, height });
const base = { pid: 0, window_role: null, window_type: "normal", is_dock: false, is_desktop: false, is_visible: true, is_minimized: false, is_normal_window: true, is_dialog: false, transient: false, transient_for: null, stacking_order: 0, is_active: false, exclude_from_capture: false, keep_above: false, output: null };
let wid = 100;
// x11-bridge (src/wm.rs): WM_CLASS class/instance, _GTK_APPLICATION_ID / _KDE_NET_WM_DESKTOP_FILE as desktop_file_name, _NET_WM_PID.
const x11Win = (cls, inst, g, extra = {}) => ({ ...base, id: String(++wid), title: (cls || "untitled") + " - window", geometry: g, desktop_file_name: null, resource_class: cls, resource_name: inst, ...extra });
// wlroots-bridge: app_id in desktop_file_name + resource_class, no geometry, no pid.
const wlrWin = (appId, extra = {}) => ({ ...base, id: String(++wid), title: appId + " title", geometry: R(0, 0, 0, 0), desktop_file_name: appId, resource_class: appId, resource_name: null, ...extra });
// gnome-portal-bridge (Introspect): wm-class + sandboxed-app-id/app id with .desktop, size only.
const gnomeWin = (appId, wmClass, extra = {}) => ({ ...base, id: String(++wid), title: appId + " title", geometry: R(0, 0, 800, 600), desktop_file_name: appId + ".desktop", resource_class: wmClass, resource_name: wmClass && wmClass.toLowerCase(), ...extra });
// kwin-portal-bridge (src/kwin.rs): desktopFileName, resourceClass lowercased by KWin.
const kwinWin = (dfn, cls, g, output, extra = {}) => ({ ...base, id: "{" + (++wid) + "}", title: dfn + " title", geometry: g, desktop_file_name: dfn, resource_class: cls, resource_name: cls, output, ...extra });

// ── shared runtime: the matcher + display-target helper, as Patch 1 injects ──
const nreq = (id) => ({ child_process: { execFileSync() { throw new Error("no"); } }, fs: { existsSync: () => false }, path, electron: { app: { getPath() { throw new Error("no"); } } } })[id];
new Function("require", "process", read("cu_ax_tools.js"))(nreq, process);
new Function("process", read("cu_display_target.js"))(process);

// ── regular executor rig ───────────────────────────────────────────────────
// bridge: {windows, front, hit(x,y)} answered for every bridge binary.
function makeRig({ session = "x11", desktop = "XFCE", bridges = { x11: true }, data = [SYS], br = {}, displays }) {
  const calls = [], spawns = [], diag = [];
  const reply = (args) => {
    const s = args[0];
    if (s === "windows") return J(typeof br.windows === "function" ? br.windows() : (br.windows || []));
    if (s === "frontmost-app") return J(br.front === undefined ? null : br.front);
    if (s === "app-under-point") return J(br.hit ? br.hit(+args[2], +args[4]) : null);
    if (s === "zoom" || s === "screenshot") return J({ base64: "AA", width: 100, height: 50 });
    if (s === "screens") return J(br.screens || [{ id: "screen", name: "screen", geometry: R(0, 0, 1920, 1080), scale: 1, is_primary: true }]);
    return "{}";
  };
  const known = new Set(["x11-bridge", "wlroots-bridge", "gnome-portal-bridge"]);
  const cp = {
    execFileSync(bin, args, opts) {
      const b = path.basename(String(bin));
      if (!known.has(b)) throw new Error("not found: " + b);
      calls.push(b + " " + args.join(" ")); spawns.push({ bin: b, args: args.join(" "), opts: opts || {} });
      return reply(args);
    },
    execSync() { throw new Error("nope"); },
    spawnSync() { return { status: 1 }; },
    execFile(bin, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      const b = path.basename(String(bin));
      if (!known.has(b)) { setImmediate(() => cb(new Error("not found"), "", "")); return; }
      calls.push(b + " " + args.join(" ")); spawns.push({ bin: b, args: args.join(" "), opts: opts || {} });
      setImmediate(() => cb(null, reply(args), ""));
    },
    spawn() { return { on() {}, unref() {} }; }
  };
  const ds = displays || [{ id: 1, label: "D", bounds: R(0, 0, 1920, 1080), size: { width: 1920, height: 1080 }, workArea: R(0, 0, 1920, 1080), scaleFactor: 1, nativeOrigin: { x: 0, y: 0 } }];
  const electron = {
    app: { commandLine: { getSwitchValue: () => "" }, getPath: () => path.join(TMP, "ud") },
    screen: { getAllDisplays: () => ds, getPrimaryDisplay: () => ds[0], getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    desktopCapturer: { getSources: async () => [] },
    clipboard: { readText: () => "", writeText: () => {} },
    nativeImage: {}
  };
  const req = (id) => ({ child_process: cp, electron, path, os, fs: procFs })[id] || (() => { throw new Error("unexpected require " + id); })();
  globalThis.__cdbDiag = (m) => diag.push(String(m));
  delete globalThis.__cuX11BridgeBin; delete globalThis.__cuGnomeBridgeBin; delete globalThis.__cuWlrootsBridgeBin;
  delete globalThis.__cuTargetRead; delete globalThis.__cuTargetSig; delete globalThis.__cuTargetSigSync; delete globalThis.__cuTargetIdentity;
  if (bridges.x11) globalThis.__cuX11BridgeBin = "/res/x11-bridge";
  if (bridges.wlroots) globalThis.__cuWlrootsBridgeBin = "/res/wlroots-bridge";
  if (bridges.gnome) globalThis.__cuGnomeBridgeBin = "/res/gnome-portal-bridge";
  globalThis.__cuKwinMode = false;
  for (const k of ["SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE", "NIRI_SOCKET", "COWORK_SCREENSHOT_CMD", "X11_BRIDGE_BIN", "WLROOTS_BRIDGE_BIN", "GNOME_PORTAL_BRIDGE_BIN", "YDOTOOL_SOCKET", "XDG_DATA_HOME"]) delete process.env[k];
  Object.assign(process.env, { HOME, USER: "tester", PATH: BIN, XDG_CURRENT_DESKTOP: desktop, XDG_SESSION_TYPE: session, XDG_RUNTIME_DIR: TMP, XDG_DATA_HOME: path.join(TMP, "nohome"), XDG_DATA_DIRS: data.join(":"), CHROME_DESKTOP: "com.anthropic.Claude.desktop" });
  if (session === "wayland") process.env.WAYLAND_DISPLAY = "wayland-0"; else delete process.env.WAYLAND_DISPLAY;
  if (desktop === "sway") process.env.SWAYSOCK = "/run/user/1000/sway.sock";
  new Function("require", "process", read("cu_linux_executor.js"))(req, process);
  const ex = globalThis.__linuxExecutor;
  diag.length = 0; calls.length = 0; spawns.length = 0;
  return { ex, calls, spawns, diag, ids: globalThis.__cdbCuAppIds };
}

// upstream's request_access resolver (chunk xVVa_yqD `Oi`, v4.4212.0):
// exact bundleId, else displayName (lowercased, last row wins), else a
// running app by lowercased bundleId / its last path segment.
function upstreamResolve(names, installed, running = []) {
  const c = new Map(), s = new Map(), l = new Map(), u = new Map();
  for (const e of installed) { c.set(e.bundleId, e); s.set(e.displayName.toLowerCase(), e); }
  for (const e of running) { l.set(e.bundleId.toLowerCase(), e); const t = e.bundleId.split(/[\\/]/).pop(); if (t) u.set(t.toLowerCase(), e); }
  return names.map((t) => {
    const a = t.toLowerCase();
    let o = c.get(t) ?? s.get(a);
    if (!o) { const n = a.split(/[\\/]/).pop() ?? a, r = l.get(a) ?? u.get(a) ?? u.get(n); if (r) o = { bundleId: r.bundleId, displayName: r.displayName }; }
    return o ? o.bundleId : null;
  });
}

// ── [1] listInstalledApps + request_access names ───────────────────────────
console.log("\n[1] listInstalledApps: one canonical id per app (desktop file id)");
{
  const rig = makeRig({});
  const apps = await rig.ex.listInstalledApps();
  const ids = [...new Set(apps.map((a) => a.bundleId))].sort();
  const rows = (id) => apps.filter((a) => a.bundleId === id).map((a) => a.displayName);
  ok(J(ids) === J(Object.keys(DESKTOP).filter((k) => k !== "com.google.Chrome").sort()), "bundleIds are the desktop file ids; the NoDisplay duplicate com.google.Chrome is folded into google-chrome", J(ids));
  ok(rows("google-chrome").includes("com.google.Chrome") && rig.ids.canon("com.google.Chrome") === "google-chrome", "com.google.Chrome is an alias of google-chrome", J(rows("google-chrome")));
  ok(rows("google-chrome").at(-1) === "Google Chrome", "the Name row is last for its id", J(rows("google-chrome")));
  ok(rows("google-chrome").includes("google-chrome-stable") && rows("google-chrome").includes("Chrome"), "Chrome alias rows: exe google-chrome-stable, word Chrome", J(rows("google-chrome")));
  ok(J(rows("org.xfce.mousepad")) === J(["org.xfce.mousepad", "Mousepad"]), "org.xfce.mousepad: its id row and Name row (exe mousepad = the Name, case-insensitive)", J(rows("org.xfce.mousepad")));
  ok(rows("org.gnome.TextEditor").includes("gnome-text-editor"), "org.gnome.TextEditor has gnome-text-editor", J(rows("org.gnome.TextEditor")));
  ok(!rows("myapp").includes("electron37") && !apps.some((a) => a.bundleId !== "electron37" && a.displayName === "electron37"), "an interpreter (electron37) is never another app's alias", J(rows("myapp")));
  ok(!rows("xfce4-terminal").includes("Terminal") && !rows("org.gnome.Terminal").includes("Xfce"), "Name words that another entry's Name owns are not aliases", J([rows("xfce4-terminal"), rows("org.gnome.Terminal")]));
  const names = ["google chrome", "Google Chrome", "Mousepad", "firefox", "Firefox", "chrome", "gnome-text-editor", "Text Editor", "Terminal", "Xfce Terminal", "konsole", "Slack", "Claude", "org.mozilla.firefox", "nope-app"];
  const got = upstreamResolve(names, apps);
  const want = ["google-chrome", "google-chrome", "org.xfce.mousepad", "org.mozilla.firefox", "org.mozilla.firefox", "google-chrome", "org.gnome.TextEditor", "org.gnome.TextEditor", "org.gnome.Terminal", "xfce4-terminal", "org.kde.konsole", "slack", "com.anthropic.Claude", "org.mozilla.firefox", null];
  ok(J(got) === J(want), "upstream's resolver: names -> canonical ids", J(names.map((n, i) => n + "=" + got[i])));
  const iND = apps.findIndex((a) => a.bundleId === "org.example.hidden"), iV = apps.findIndex((a) => a.bundleId === "slack");
  ok(iND >= 0 && iND < iV, "an unrelated NoDisplay entry sharing a Name is listed before the visible app (upstream keeps the last row)", iND + " < " + iV);
  ok(J(rig.ex.resolveApp("google chrome")) === J({ bundleId: "google-chrome", displayName: "Google Chrome", path: path.join(SYS, "applications/google-chrome.desktop") }), "resolveApp(name) -> {bundleId, displayName, path}", J(rig.ex.resolveApp("google chrome")));
  ok(rig.ex.resolveApp("nope-app") === null, "resolveApp: unknown -> null");
  const al = rig.ex.appAliases("org.gnome.Terminal");
  ok(al.includes("gnome-terminal") && al.includes("org.gnome.Terminal") && al.some((a) => a.endsWith("/bin/gnome-terminal")), "appAliases: desktop id, exe name, exe path", J(al));
}

// ── [2] x11-bridge listRunningApps ─────────────────────────────────────────
console.log("\n[2] x11-bridge: listRunningApps maps every alias to the canonical id");
const chromeW = x11Win("Google-chrome", "google-chrome", R(0, 0, 900, 700), { pid: 4000, stacking_order: 1 });
const mousepadW = x11Win("Mousepad", "mousepad", R(950, 0, 500, 400), { pid: 4001, stacking_order: 2 });
const gtermW = x11Win("Gnome-terminal", "gnome-terminal-server", R(0, 700, 800, 300), { pid: 4002, stacking_order: 3 });
const xtermW = x11Win("Xfce4-terminal", "xfce4-terminal", R(1000, 500, 600, 400), { pid: 4003, stacking_order: 4 });
const konsoleW = x11Win("konsole", "konsole", R(1500, 0, 400, 300), { pid: 4004, stacking_order: 5, desktop_file_name: "org.kde.konsole" });
const electronW = x11Win("Electron", "electron", R(100, 100, 300, 300), { pid: 5001, stacking_order: 6 });
const otherElectronW = x11Win("Electron", "electron", R(1200, 100, 300, 300), { pid: 5003, stacking_order: 7 });
const nakedChromeW = x11Win(null, null, R(1600, 600, 200, 200), { pid: 5002, stacking_order: 8 });
const dialogW = x11Win("Zenity", "zenity", R(960, 10, 200, 100), { pid: 4999, stacking_order: 9, transient: true, transient_for: { id: mousepadW.id, desktop_file_name: null, resource_class: "Mousepad", resource_name: "mousepad" } });
const claudeW = x11Win("com.anthropic.Claude", "com.anthropic.Claude", R(400, 400, 600, 400), { pid: process.pid, stacking_order: 10 });
const quickEntryW = x11Win("claude-quick-entry", "claude-quick-entry", R(500, 50, 400, 60), { pid: process.pid, stacking_order: 11 });
const slackW = x11Win("Slack", "slack", R(10, 10, 100, 100), { pid: 4005, stacking_order: 0, is_minimized: true, is_visible: false });
const unknownW = x11Win("Foo-unknown", "foo-unknown", R(1800, 900, 100, 100), { pid: 4006, stacking_order: 12 });
const X11WINS = [chromeW, mousepadW, gtermW, xtermW, konsoleW, electronW, otherElectronW, nakedChromeW, dialogW, claudeW, quickEntryW, slackW, unknownW];
{
  const rig = makeRig({ br: { windows: X11WINS } });
  const running = await rig.ex.listRunningApps();
  const ids = running.map((a) => a.bundleId);
  ok(J(ids) === J(["google-chrome", "org.xfce.mousepad", "org.gnome.Terminal", "xfce4-terminal", "org.kde.konsole", "myapp", "Electron", "com.anthropic.Claude", "Foo-unknown"]), "ids: WM_CLASS / desktop file / process / transient parent -> canonical; unknown keeps its WM_CLASS", J(ids));
  const by = Object.fromEntries(running.map((a) => [a.bundleId, a.displayName]));
  ok(by["google-chrome"] === "Google Chrome" && by["org.xfce.mousepad"] === "Mousepad" && by["Foo-unknown"] === "Foo-unknown - window", "displayName: the app's Name when known, else the window title", J(by));
  const r = rig.ids.resolveWindow;
  ok(r(nakedChromeW).bundleId === "google-chrome", "no WM_CLASS, /proc exe /opt/google/chrome/chrome -> google-chrome (exe dir; visible + plain launcher beat NoDisplay and the web app)", J(r(nakedChromeW)));
  ok(r(electronW).bundleId === "myapp" && r(otherElectronW).bundleId === "Electron", "generic Electron class: the asar on the command line names the app; an unknown asar keeps the class", J([r(electronW), r(otherElectronW)]));
  ok(r(dialogW).bundleId === "org.xfce.mousepad", "an unknown transient dialog belongs to its parent's app", J(r(dialogW)));
  ok(r(quickEntryW).bundleId === "com.anthropic.Claude" && r(quickEntryW).host === true, "Claude's own windows (our pid) are the host id, Quick Entry included", J(r(quickEntryW)));
  ok(rig.ex.capabilities.hostBundleId === "com.anthropic.Claude", "capabilities.hostBundleId is Claude's canonical id", rig.ex.capabilities.hostBundleId);
  ok(r(x11Win("crx_abc", "crx_abc", R(0, 0, 1, 1))).bundleId === "chrome-abc-Profile_1", "a Chrome web app window (crx_abc) is its own app, not Chrome");
  ok(!ids.includes("slack"), "minimized windows are not running apps");
  ok(J(rig.ids.windowIds(["google-chrome", "org.xfce.mousepad"], X11WINS)) === J([chromeW.id, mousepadW.id, nakedChromeW.id, dialogW.id]), "windowIds: the bridge window ids (--keep-window) of the canonical ids, transient dialog included", J(rig.ids.windowIds(["google-chrome", "org.xfce.mousepad"], X11WINS)));
  rig.calls.length = 0;
  ok(typeof rig.ex.__unhideApps === "function" && (await rig.ex.__unhideApps(["google-chrome"])) === undefined && rig.calls.length === 0, "__unhideApps: present, a no-op (nothing hidden, no bridge call)");
}

// ── [3] x11-bridge frontmost / appUnderPoint ───────────────────────────────
console.log("\n[3] x11-bridge: getFrontmostApp / appUnderPoint in the same ids");
{
  const rig = makeRig({ br: { windows: X11WINS.map((w) => w === mousepadW ? { ...w, is_active: true } : w) } });
  ok(J(await rig.ex.getFrontmostApp()) === J({ bundleId: "org.xfce.mousepad", displayName: "Mousepad" }), "frontmost: the active window -> org.xfce.mousepad", J(await rig.ex.getFrontmostApp()));
  ok(!rig.calls.some((c) => c.includes("frontmost-app")), "frontmost from the window list needs no frontmost-app call", J(rig.calls));
  const running = await rig.ex.listRunningApps();
  ok(running.some((a) => a.bundleId === "org.xfce.mousepad"), "and listRunningApps reports the same id");
}
{
  // No _NET_ACTIVE_WINDOW (WM without EWMH): x11-bridge's GetInputFocus answer, raw.
  const rig = makeRig({ br: { windows: X11WINS, front: { bundleId: "Mousepad", displayName: "Untitled 1 - Mousepad" } } });
  ok(J(await rig.ex.getFrontmostApp()) === J({ bundleId: "org.xfce.mousepad", displayName: "Mousepad" }), "no active window: frontmost-app raw Mousepad -> org.xfce.mousepad", J(await rig.ex.getFrontmostApp()));
  const rig2 = makeRig({ br: { windows: [chromeW, electronW], front: { bundleId: "Electron", displayName: "My App" } } });
  const f2 = await rig2.ex.getFrontmostApp();
  ok(f2 && f2.bundleId === "myapp", "raw generic class: refined through the window list -> myapp (process tier)", J(f2));
  const rig3 = makeRig({ br: { windows: [], front: null } });
  ok(await rig3.ex.getFrontmostApp() === null, "nothing focused -> null");
}
{
  const hit = (x, y) => { const w = [...X11WINS].filter((w) => w.is_visible && !w.is_minimized && x >= w.geometry.x && x < w.geometry.x + w.geometry.width && y >= w.geometry.y && y < w.geometry.y + w.geometry.height).sort((a, b) => b.stacking_order - a.stacking_order)[0]; return w ? { bundleId: w.resource_class || w.id, displayName: w.title } : null; };
  const rig = makeRig({ br: { windows: X11WINS, hit } });
  const a = await rig.ex.appUnderPoint(10, 10);
  ok(J(a) === J({ bundleId: "google-chrome", displayName: "Google Chrome" }), "appUnderPoint over Chrome -> google-chrome", J(a));
  ok(rig.calls.at(-1) === "x11-bridge app-under-point --x 10 --y 10" && !rig.calls.some((c) => c.endsWith(" windows")), "a known raw id needs no window list", J(rig.calls));
  const b = await rig.ex.appUnderPoint(150, 150);
  ok(b && b.bundleId === "myapp", "over the generic-Electron window -> myapp (refined by the point and the window list)", J(b));
  const c = await rig.ex.appUnderPoint(1250, 150);
  ok(c && c.bundleId === "Electron", "over the other Electron app -> its raw class, as listRunningApps has it", J(c));
  const d = await rig.ex.appUnderPoint(450, 450);
  ok(d && d.bundleId === rig.ex.capabilities.hostBundleId, "over Claude -> the host id", J(d));
  ok(await rig.ex.appUnderPoint(1919, 1079) === null, "over the bare desktop -> null");
  const caps = rig.ex.capabilitiesNow();
  ok(caps.hitTest === "native" && caps.frontmost === "native" && caps.backend === "x11-bridge" && caps.windowList === "full" && caps.windowPositions === true && caps.screenshotFiltering === "none", "capabilitiesNow on X11", J(caps));
  ok(!("hitTest" in rig.ex.capabilities) && rig.ex.capabilities.screenshotFiltering === "none" && rig.ex.capabilities.platform === "linux", "static capabilities: still no hitTest key", J(rig.ex.capabilities));
}

// ── [4] grant -> window matcher, findWindowDisplays ────────────────────────
console.log("\n[4] canonical grants own their windows (matcher + findWindowDisplays)");
{
  const DUAL = [{ id: 1, label: "A", bounds: R(0, 0, 1920, 1080), size: { width: 1920, height: 1080 }, workArea: R(0, 0, 1920, 1080), scaleFactor: 1, nativeOrigin: { x: 0, y: 0 } }, { id: 2, label: "B", bounds: R(1920, 0, 1920, 1080), size: { width: 1920, height: 1080 }, workArea: R(1920, 0, 1920, 1080), scaleFactor: 1, nativeOrigin: { x: 1920, y: 0 } }];
  const ffX11 = x11Win("firefox", "Navigator", R(2000, 100, 1200, 800), { pid: 4100 });
  const mpX11 = x11Win("Mousepad", "mousepad", R(100, 100, 500, 400), { pid: 4101 });
  const rig = makeRig({ displays: DUAL, br: { windows: [ffX11, mpX11, nakedChromeW] } });
  const own = globalThis.__cdbCuWindowOwns;
  ok(own("org.mozilla.firefox", ffX11), "grant org.mozilla.firefox owns WM_CLASS firefox (flatpak StartupWMClass)");
  ok(own("org.xfce.mousepad", mpX11), "grant org.xfce.mousepad owns WM_CLASS Mousepad (reverse-DNS grant, X11 class)");
  ok(own("google-chrome", nakedChromeW) && !own("chrome-abc-Profile_1", nakedChromeW), "google-chrome owns a class-less Chrome window via /proc; the web app does not");
  ok(!own("org.evil.firefox", ffX11) && !own("org.xfce.mousepad", ffX11), "other ids do not match");
  ok(own("Google Chrome", chromeW), "a grant by Name (regular mode's auto-grant strings) still matches");
  const wd = await rig.ex.findWindowDisplays(["org.mozilla.firefox", "org.xfce.mousepad", "google-chrome"]);
  ok(J(wd) === J([{ bundleId: "org.mozilla.firefox", displayIds: [1] }, { bundleId: "org.xfce.mousepad", displayIds: [0] }, { bundleId: "google-chrome", displayIds: [0] }]), "findWindowDisplays with canonical ids", J(wd));
  const cap = await rig.ex.resolvePrepareCapture({ allowedBundleIds: ["org.mozilla.firefox"], preferredDisplayId: 0, autoResolve: true });
  ok(cap.displayId === 1, "resolvePrepareCapture auto-targets the flatpak Firefox display", cap.displayId);
  globalThis.__cuKwinMode = true;
  ok(!own("org.mozilla.firefox", ffX11), "kwin mode: our index is not consulted (the kwin bridge owns its ids)");
  globalThis.__cuKwinMode = false;
}

// ── [5] flatpak / snap / native Firefox ────────────────────────────────────
console.log("\n[5] Firefox: native beats flatpak's StartupWMClass; snap id firefox_firefox");
{
  const NAT = dataDir("nat", { firefox: "Name=Firefox\nExec=firefox %u\nStartupWMClass=firefox\nIcon=firefox\n" });
  const rig = makeRig({ data: [NAT, SYS], br: { windows: [x11Win("firefox", "Navigator", R(0, 0, 10, 10)), wlrWin("org.mozilla.firefox")] } });
  const r = rig.ids.resolveWindow;
  ok(r(x11Win("firefox", "Navigator", R(0, 0, 10, 10))).bundleId === "firefox", "WM_CLASS firefox -> the native firefox (desktop id beats a StartupWMClass)");
  ok(r(wlrWin("org.mozilla.firefox")).bundleId === "org.mozilla.firefox", "Wayland app_id org.mozilla.firefox -> the flatpak");
  const apps = await rig.ex.listInstalledApps();
  ok(J(upstreamResolve(["firefox", "org.mozilla.firefox"], apps)) === J(["firefox", "org.mozilla.firefox"]), "request_access: firefox -> native, the flatpak id -> flatpak");
  const SNAP = dataDir("snap", { firefox_firefox: "Name=Firefox Web Browser\nExec=env BAMF_DESKTOP_FILE_HINT=/var/lib/snapd/desktop/applications/firefox_firefox.desktop @OPT@/snapbin/firefox %u\nIcon=/snap/firefox/current/default256.png\n" });
  const rs = makeRig({ data: [SNAP] });
  ok(rs.ids.resolveWindow(x11Win("firefox", "Navigator", R(0, 0, 1, 1))).bundleId === "firefox_firefox", "snap: X11 class firefox -> firefox_firefox");
  ok(rs.ids.resolveWindow(wlrWin("firefox_firefox")).bundleId === "firefox_firefox", "snap: Wayland app_id firefox_firefox -> itself");
  ok(J(upstreamResolve(["firefox", "Firefox Web Browser"], await rs.ex.listInstalledApps())) === J(["firefox_firefox", "firefox_firefox"]), "snap: request_access firefox -> firefox_firefox");
}

// ── [6] wlroots-bridge ─────────────────────────────────────────────────────
console.log("\n[6] wlroots-bridge: app_id ids, frontmost only from the activated toplevel, no hit test");
{
  const wins = [wlrWin("google-chrome"), wlrWin("org.xfce.mousepad", { is_active: true }), wlrWin("org.gnome.TextEditor"), wlrWin("foot")];
  const rig = makeRig({ session: "wayland", desktop: "sway", bridges: { wlroots: true }, br: { windows: wins, front: { bundleId: "google-chrome", displayName: "first" } } });
  ok(J((await rig.ex.listRunningApps()).map((a) => a.bundleId)) === J(["google-chrome", "org.xfce.mousepad", "org.gnome.TextEditor", "foot"]), "listRunningApps: app_ids, unknown foot kept");
  ok((await rig.ex.getFrontmostApp()).bundleId === "org.xfce.mousepad", "frontmost: the activated toplevel");
  const rig2 = makeRig({ session: "wayland", desktop: "sway", bridges: { wlroots: true }, br: { windows: wins.map((w) => ({ ...w, is_active: false })), front: { bundleId: "google-chrome", displayName: "first" } } });
  ok(await rig2.ex.getFrontmostApp() === null && !rig2.calls.some((c) => c.includes("frontmost-app")), "no activated toplevel (ext-foreign-toplevel-list): null, never wlroots-bridge's first-toplevel guess", J(rig2.calls));
  ok(await rig.ex.appUnderPoint(10, 10) === null && !rig.calls.some((c) => c.includes("app-under-point")), "appUnderPoint: null without asking the bridge");
  const caps = rig.ex.capabilitiesNow();
  ok(caps.hitTest === "none" && caps.frontmost === "native" && caps.backend === "wlroots-bridge" && caps.windowPositions === false, "capabilitiesNow on wlroots", J(caps));
}

// ── [7] gnome-portal-bridge ────────────────────────────────────────────────
console.log("\n[7] gnome-portal-bridge (Introspect): same ids, no hit test");
{
  const wins = [gnomeWin("org.gnome.TextEditor", "gnome-text-editor"), gnomeWin("org.gnome.Terminal", "Gnome-terminal", { is_active: true }), gnomeWin("google-chrome", "Google-chrome"), gnomeWin("com.anthropic.Claude", "com.anthropic.Claude", { pid: process.pid })];
  const rig = makeRig({ session: "wayland", desktop: "GNOME", bridges: { gnome: true }, br: { windows: wins } });
  ok(J((await rig.ex.listRunningApps()).map((a) => a.bundleId)) === J(["org.gnome.TextEditor", "org.gnome.Terminal", "google-chrome", "com.anthropic.Claude"]), "listRunningApps: .desktop app ids -> canonical");
  ok((await rig.ex.getFrontmostApp()).bundleId === "org.gnome.Terminal", "frontmost: Introspect has-focus");
  ok(await rig.ex.appUnderPoint(10, 10) === null && !rig.calls.some((c) => c.includes("app-under-point")), "appUnderPoint: null (no global window origin on GNOME)");
  ok(!rig.calls.some((c) => / session-start/.test(c)), "enumeration never opens a portal session", J(rig.calls));
  const rigE = makeRig({ session: "wayland", desktop: "GNOME", bridges: { gnome: true }, br: { windows: [] } });
  ok(await rigE.ex.getFrontmostApp() === null && J(await rigE.ex.listRunningApps()) === "[]", "Introspect restricted ([]): frontmost null, no running apps");
  const caps = rig.ex.capabilitiesNow();
  ok(caps.hitTest === "none" && caps.backend === "gnome-portal-bridge" && caps.windowList === "best-effort", "capabilitiesNow on GNOME", J(caps));
}

// ── [8] XWayland ───────────────────────────────────────────────────────────
console.log("\n[8] XWayland (uncovered Wayland, x11-bridge): X clients listed, focus and hit test unknown");
{
  const rig = makeRig({ session: "wayland", desktop: "COSMIC", br: { windows: [{ ...chromeW, is_active: true }], hit: () => ({ bundleId: "Google-chrome", displayName: "x" }), front: { bundleId: "Google-chrome", displayName: "x" } } });
  ok(J((await rig.ex.listRunningApps()).map((a) => a.bundleId)) === J(["google-chrome"]), "listRunningApps: the X clients");
  ok(await rig.ex.getFrontmostApp() === null && await rig.ex.appUnderPoint(10, 10) === null, "frontmost / appUnderPoint: null (a native Wayland window may be on top)");
  ok(!rig.calls.some((c) => /frontmost-app|app-under-point/.test(c)), "and the bridge is not asked", J(rig.calls));
  const caps = rig.ex.capabilitiesNow();
  ok(caps.hitTest === "none" && caps.frontmost === "none" && caps.windowList === "partial" && caps.backend === "x11-bridge (XWayland)", "capabilitiesNow on XWayland", J(caps));
  const rn = makeRig({ session: "wayland", desktop: "COSMIC", bridges: {} });
  const cn = rn.ex.capabilitiesNow();
  ok(cn.backend === "none" && cn.hitTest === "none" && J(await rn.ex.listRunningApps()) === "[]" && await rn.ex.getFrontmostApp() === null, "no bridge, no ydotool: nothing known", J(cn));
}

// ── [9] background X display (Xvfb) ────────────────────────────────────────
console.log("\n[9] background X display: native hit test on the target, with its env");
{
  const hit = () => ({ bundleId: "Mousepad", displayName: "Untitled" });
  const rig = makeRig({ session: "wayland", desktop: "GNOME", bridges: { x11: true, gnome: true }, br: { windows: [{ ...mousepadW, is_active: true }], hit, screens: [{ id: "screen", name: "screen", geometry: R(0, 0, 1280, 800), scale: 1, is_primary: true }] } });
  globalThis.__cuTargetRead = () => ({ kind: "x11", display: ":99", env: {} });
  await rig.ex.__setLockHeld(true);
  rig.calls.length = 0; rig.spawns.length = 0;
  ok(J(await rig.ex.appUnderPoint(10, 10)) === J({ bundleId: "org.xfce.mousepad", displayName: "Mousepad" }), "appUnderPoint on :99 -> org.xfce.mousepad");
  ok((await rig.ex.getFrontmostApp()).bundleId === "org.xfce.mousepad", "frontmost on :99");
  ok(rig.spawns.length > 0 && rig.spawns.every((s) => s.bin === "x11-bridge" && s.opts.env && s.opts.env.DISPLAY === ":99"), "only x11-bridge, every spawn with DISPLAY=:99", J(rig.spawns.map((s) => [s.bin, s.args, s.opts.env && s.opts.env.DISPLAY])));
  const caps = rig.ex.capabilitiesNow();
  ok(caps.hitTest === "native" && caps.backend === "x11-bridge (background display :99)" && caps.windowPositions === true, "capabilitiesNow on the target", J(caps));
  await rig.ex.__setLockHeld(false);
  delete globalThis.__cuTargetRead;
}

// ── [10] kwin mode ─────────────────────────────────────────────────────────
console.log("\n[10] kwin-portal-bridge (executor_linux.js): the bridge's ids pass through");
{
  const screens = [{ id: "DP-1", name: "DP-1", geometry: R(0, 0, 1920, 1080), scale: 1, is_primary: true, is_active: true }];
  const windows = [kwinWin("org.kde.konsole", "konsole", R(0, 0, 800, 600), "DP-1", { is_active: true, pid: 77 }), kwinWin("google-chrome", "google-chrome", R(900, 0, 800, 600), "DP-1")];
  const argv = [];
  const reply = (s) => s === "screens" ? J(screens) : s === "windows" ? J(windows) : s === "frontmost-app" ? J({ bundleId: "org.kde.konsole", displayName: "Konsole" }) : s === "app-under-point" ? J({ bundleId: "google-chrome", displayName: "Google Chrome" }) : "{}";
  const cpStub = { execFile(bin, args, opts, cb) { if (typeof opts === "function") cb = opts; argv.push((args || []).join(" ")); setImmediate(() => cb(null, { stdout: reply((args || [])[0]), stderr: "" })); }, spawnSync() { return { status: 0 }; } };
  const src = read("executor_linux.js")
    .replace("import { execFile as execFileCb, spawnSync } from 'node:child_process'", "const { execFile: execFileCb, spawnSync } = __cp")
    .replace("import { screen as electronScreen } from 'electron'", "const electronScreen = { getAllDisplays: () => [], getPrimaryDisplay: () => ({}) }")
    .replace("import { promisify } from 'node:util'", "const { promisify } = __util")
    .replace(/^export /gm, "");
  if (/^import /m.test(src)) throw new Error("executor_linux.js imports changed - update this splice");
  globalThis.__cuKwinBridgeBin = "/res/kwin-portal-bridge";
  globalThis.__cuKwinMode = true;
  const mod = new Function("__cp", "__util", src + "\nreturn { createLinuxExecutor };")(cpStub, util);
  const kx = mod.createLinuxExecutor({ hostBundleId: "com.anthropic.claude" });
  ok(J((await kx.listRunningApps()).map((a) => a.bundleId)) === J(["org.kde.konsole", "google-chrome"]), "listRunningApps: desktopFileName ids");
  ok((await kx.getFrontmostApp()).bundleId === "org.kde.konsole" && (await kx.appUnderPoint(950, 10)).bundleId === "google-chrome", "frontmost / appUnderPoint: the bridge's canonical ids");
  ok(kx.capabilities.hostBundleId === "com.anthropic.claude" && kx.capabilities.screenshotFiltering === "native", "kwin capabilities unchanged", J(kx.capabilities));
  globalThis.__cuKwinMode = false;
}

// ── [12] named profile with its own window identity (issue #319) ──────────
// patches/core/fix_profile_app_identity switches CHROME_DESKTOP to
// <base>-<profile>.desktop when that .desktop exists; _hostId() reads it live.
// Host test = _isHostWin's rule via the exported pieces: our pid (resolveWindow
// .host) or the window's canonical id equal to hostId() (owns(hostId, w)).
console.log("\n[12] named profile: CHROME_DESKTOP=com.anthropic.Claude-work.desktop");
{
  const PROF = dataDir("prof", { "com.anthropic.Claude-work": "Name=Claude (work)\nExec=claude-desktop --profile=work %U\nIcon=claude-desktop\nStartupWMClass=com.anthropic.Claude-work\n" });
  const ownW = x11Win("com.anthropic.Claude-work", "com.anthropic.Claude-work", R(400, 400, 600, 400), { pid: process.pid });
  const ownQeW = x11Win("claude-quick-entry", "claude-quick-entry", R(500, 50, 400, 60), { pid: process.pid });
  const defaultInstW = x11Win("com.anthropic.Claude", "com.anthropic.Claude", R(0, 0, 600, 400), { pid: 6100 });
  const workOtherPidW = x11Win("com.anthropic.Claude-work", "com.anthropic.Claude-work", R(0, 0, 600, 400), { pid: 6101 });
  for (const [label, data] of [["profile .desktop indexed", [SYS, PROF]], ["profile .desktop not in the index", [SYS]]]) {
    const rig = makeRig({ data, br: { windows: [ownW, ownQeW, defaultInstW, workOtherPidW] } });
    process.env.CHROME_DESKTOP = "com.anthropic.Claude-work.desktop";
    const host = (w) => { const r = rig.ids.resolveWindow(w); return !!(r && (r.host || rig.ids.owns(rig.ids.hostId(), w))); };
    ok(rig.ids.hostId() === "com.anthropic.Claude-work" && rig.ex.capabilities.hostBundleId === "com.anthropic.Claude-work", label + ": hostId / capabilities.hostBundleId follow CHROME_DESKTOP", J([rig.ids.hostId(), rig.ex.capabilities.hostBundleId]));
    ok(host(ownW) && host(ownQeW) && rig.ids.resolveWindow(ownQeW).bundleId === "com.anthropic.Claude-work", label + ": the instance's own windows (our pid) are the host, Quick Entry included", J([rig.ids.resolveWindow(ownW), rig.ids.resolveWindow(ownQeW)]));
    ok(!host(defaultInstW) && rig.ids.resolveWindow(defaultInstW).bundleId === "com.anthropic.Claude", label + ": a com.anthropic.Claude window of another pid (the default profile) is NOT the host", J(rig.ids.resolveWindow(defaultInstW)));
    ok(host(workOtherPidW), label + ": a com.anthropic.Claude-work window is the host", J(rig.ids.resolveWindow(workOtherPidW)));
    process.env.CHROME_DESKTOP = "com.anthropic.Claude.desktop";
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
