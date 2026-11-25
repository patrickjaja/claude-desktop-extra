#!/usr/bin/env node
// Artifact Apps ("Install as app" Beta) Linux compatibility verification suite.
//
// Tests:
//   1. js/artifact_apps_linux.js runtime (CLI argv parsing, 60s launch queue,
//      second-instance routing, XDG .desktop + hicolor PNG creation & escaping,
//      per-profile isolation, CHROME_DESKTOP / app.setDesktopName swap+restore,
//      .desktop reconciliation, free-name resolution, icon updates, uninstall,
//      and badge counts), plus desktop-file-validate when available.
//   2. js/artifact_app_window_preload.js preload in mocked top-frame and child
//      subframe contexts (hostcaps, host-tools port forwarding, bare 'c' key
//      suppression, drag-region overlay, eIPC reporting, manifest declaration
//      ordering, all 3 permission tiers, stream lifecycle, error unwrapping).
//   3. Compiled Nim patch binaries (fix_artifact_apps_pre_linux and
//      fix_artifact_apps_linux) on synthetic upstream shapes AND on a full
//      v6.28899.6 extract when available locally.
//
// Exit codes: 0 = PASS, 3 = SKIP, other = FAIL.

import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RUNTIME_PATH = join(ROOT, "js", "artifact_apps_linux.js");
const PRELOAD_PATH = join(ROOT, "js", "artifact_app_window_preload.js");
const PRE_BIN = join(ROOT, "patches", "linux", "fix_artifact_apps_pre_linux");
const MAIN_BIN = join(ROOT, "patches", "linux", "fix_artifact_apps_linux");

const scratch = mkdtempSync(join(process.env.CDB_TEST_TMP || tmpdir(), "cdb-artifact-apps-test-"));
process.on("exit", () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {}
});

let pass = 0;
const failures = [];
function check(label, cond, detail = "") {
  if (cond) {
    console.log(`  PASS ${label}`);
    pass++;
  } else {
    console.log(`  FAIL ${label}${detail ? " — " + detail : ""}`);
    failures.push(label);
  }
}
function checkEq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(label, ok, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
const section = (t) => console.log("\n" + t);

function makeFakeImage(tag = "v1") {
  const buf = (sz) => Buffer.from(`PNG-${tag}-${sz}x${sz}`);
  return {
    isEmpty: () => false,
    resize: ({ width }) => ({
      toPNG: () => buf(width),
    }),
    toPNG: () => buf(256),
  };
}

// ---------------------------------------------------------------------------
// 1. Runtime unit tests (js/artifact_apps_linux.js)
// ---------------------------------------------------------------------------
section("1. js/artifact_apps_linux.js runtime");

const runtimeSrc = readFileSync(RUNTIME_PATH, "utf8");
const ID_A = "0123456789abcdef0123456789abcdef";
const ID_B = "fedcba9876543210fedcba9876543210";
const UUID_A = "11111111-2222-3333-4444-555555555555";

function loadRuntime(envObj, argv = ["claude-desktop"]) {
  const ctx = vm.createContext({
    require: (id) => {
      if (id === "electron") {
        return {
          nativeImage: {
            createFromPath: (p) =>
              existsSync(p)
                ? {
                    _iconPath: p,
                    isEmpty: () => false,
                  }
                : null,
          },
        };
      }
      throw new Error(`Unexpected require in test: ${id}`);
    },
    process: {
      pid: process.pid,
      argv,
      env: envObj,
      platform: "linux",
    },
    Buffer,
    console,
    Date,
    setTimeout,
    clearTimeout,
    globalThis: {},
  });
  const nodeRequire = createRequire(import.meta.url);
  ctx.globalThis = ctx;
  ctx.require = (id) => {
    if (id.startsWith("node:")) return nodeRequire(id);
    if (id === "electron") {
      return {
        nativeImage: {
          createFromPath: (p) =>
            existsSync(p) ? { _iconPath: p, isEmpty: () => false } : null,
        },
      };
    }
    throw new Error(`Unexpected require: ${id}`);
  };
  vm.runInContext(runtimeSrc, ctx, { filename: RUNTIME_PATH });
  return ctx.__cdbArtifactApps;
}

const fakeHome = join(scratch, "home1");
const xdgData1 = join(fakeHome, ".local", "share");
const userData1 = join(scratch, "userData1");
mkdirSync(fakeHome, { recursive: true });
mkdirSync(userData1, { recursive: true });

const env1 = {
  HOME: fakeHome,
  XDG_DATA_HOME: xdgData1,
  CLAUDE_LAUNCHER: "/opt/Claude Desktop/bin/claude-launcher",
};
const rt = loadRuntime(env1, ["claude-desktop", `--artifact-app=${ID_A}`]);

check("marker present", rt && rt.marker === "__cdb_artifact_apps_linux_v1__");
const genId1 = rt.newInstallId();
const genId2 = rt.newInstallId();
check("newInstallId generates 32-char hex", /^[0-9a-f]{32}$/.test(genId1) && /^[0-9a-f]{32}$/.test(genId2) && genId1 !== genId2);
checkEq("parseInstallId valid", rt.parseInstallId(["claude", `--artifact-app=${ID_A}`]), ID_A);
checkEq("parseInstallId uppercase rejected", rt.parseInstallId([`--artifact-app=${ID_A.toUpperCase()}`]), undefined);
checkEq("parseInstallId stops at --", rt.parseInstallId(["claude", "--", `--artifact-app=${ID_A}`]), undefined);
checkEq("isLaunchArgv true", rt.isLaunchArgv(["claude", `--artifact-app=${ID_A}`]), true);
checkEq("isLaunchArgv false", rt.isLaunchArgv(["claude", "--foo"]), false);

checkEq("escapeDesktopExecArg quotes spaces", rt.escapeDesktopExecArg("/opt/Claude Desktop/bin"), '"/opt/Claude Desktop/bin"');

const deps1 = {
  env: env1,
  os: { homedir: () => fakeHome },
  child_process: { execFile: () => ({ unref() {} }) }, // prevent touching host desktop cache
};

const installed = await rt.installDesktopEntry(
  {
    installId: ID_A,
    artifactUuid: UUID_A,
    name: "Pomodoro Timer\nPro",
    image: makeFakeImage("v1"),
    userDataDir: userData1,
  },
  deps1
);

checkEq("installed desktopFile name", installed.desktopFile, `com.anthropic.Claude.artifact-${ID_A}.desktop`);
check("installed .desktop file exists", existsSync(installed.desktopPath));
const desktopBody = readFileSync(installed.desktopPath, "utf8");
check("Exec quotes launcher with spaces", desktopBody.includes('Exec="/opt/Claude Desktop/bin/claude-launcher" --artifact-app=' + ID_A));
check("Name sanitized newlines", desktopBody.includes("Name=Pomodoro Timer Pro\n"));
check("StartupWMClass matches desktopId", desktopBody.includes(`StartupWMClass=com.anthropic.Claude.artifact-${ID_A}\n`));
check("256x256 icon written", existsSync(join(xdgData1, "icons", "hicolor", "256x256", "apps", `com.anthropic.Claude.artifact-${ID_A}.png`)));
check("512x512 icon written", existsSync(join(xdgData1, "icons", "hicolor", "512x512", "apps", `com.anthropic.Claude.artifact-${ID_A}.png`)));
check("local icon written", existsSync(installed.iconPath));

const hasValidate = spawnSync("sh", ["-c", "command -v desktop-file-validate"], { encoding: "utf8" }).status === 0;
if (hasValidate) {
  const valRes = spawnSync("desktop-file-validate", [installed.desktopPath], { encoding: "utf8" });
  check("desktop-file-validate passes", valRes.status === 0, valRes.stderr || valRes.stdout);
} else {
  console.log("  INFO desktop-file-validate not installed; skipped optional validator");
}

// Multi-profile isolation + APPIMAGE fallback
const envWork = {
  HOME: fakeHome,
  XDG_DATA_HOME: xdgData1,
  APPIMAGE: "/home/user/Apps/Claude.AppImage",
  CLAUDE_PROFILE: "work",
};
const depsWork = { env: envWork, os: { homedir: () => fakeHome }, child_process: { execFile: () => ({ unref() {} }) } };
const workInstalled = await rt.installDesktopEntry(
  { installId: ID_B, artifactUuid: UUID_A, name: "Work App", image: null, userDataDir: userData1 },
  depsWork
);
checkEq("profile desktopFile name", workInstalled.desktopFile, `com.anthropic.Claude-work.artifact-${ID_B}.desktop`);
const workBody = readFileSync(workInstalled.desktopPath, "utf8");
check("profile Exec includes --profile=work", workBody.includes("Exec=/home/user/Apps/Claude.AppImage --profile=work --artifact-app=" + ID_B));
check("no image falls back to Icon=claude-desktop", workBody.includes("Icon=claude-desktop\n"));

// createWindow CHROME_DESKTOP swap + restore (including throw and unset)
const origDesktopLog = [];
const desktopCalls = [];
class FakeBW {
  constructor(opts) {
    desktopCalls.push({ chromeDesktop: env1.CHROME_DESKTOP, iconPath: opts.icon && opts.icon._iconPath });
    if (opts._shouldThrow) throw new Error("boom");
    this.opts = opts;
  }
}
const fakeApp = {
  getPath: () => userData1,
  setDesktopName: (n) => origDesktopLog.push(n),
};
env1.CHROME_DESKTOP = "com.anthropic.Claude.desktop";
rt.createWindow(FakeBW, fakeApp, { width: 400 }, { installId: ID_A, desktopFile: installed.desktopFile }, deps1);
checkEq("createWindow sets per-app CHROME_DESKTOP during ctor", desktopCalls[0].chromeDesktop, installed.desktopFile);
check("createWindow attaches local PNG icon", desktopCalls[0].iconPath === installed.iconPath);
checkEq("createWindow restores CHROME_DESKTOP after ctor", env1.CHROME_DESKTOP, "com.anthropic.Claude.desktop");
checkEq("createWindow setDesktopName sequence", origDesktopLog, [installed.desktopFile, "com.anthropic.Claude.desktop"]);

// Unset CHROME_DESKTOP initially + constructor throws
delete env1.CHROME_DESKTOP;
let threw = false;
try {
  rt.createWindow(FakeBW, fakeApp, { _shouldThrow: true }, { installId: ID_A, desktopFile: installed.desktopFile }, deps1);
} catch {
  threw = true;
}
check("createWindow rethrows constructor error", threw);
check("createWindow deletes CHROME_DESKTOP on finally when previously unset", !("CHROME_DESKTOP" in env1));

// Missing .desktop file skips swap
const callsBeforeMissing = origDesktopLog.length;
rt.createWindow(FakeBW, fakeApp, { width: 200 }, { installId: "ffffffffffffffffffffffffffffffff", desktopFile: "missing.desktop" }, deps1);
checkEq("missing .desktop skips setDesktopName", origDesktopLog.length, callsBeforeMissing);

// listExistingAppNames & findFreeName
const names = await rt.listExistingAppNames({ env: { ...env1, XDG_DATA_DIRS: "" }, os: { homedir: () => fakeHome } });
check("listExistingAppNames includes Pomodoro Timer Pro", names.includes("Pomodoro Timer Pro"));
const free1 = await rt.findFreeName("Pomodoro Timer Pro", [], { env: { ...env1, XDG_DATA_DIRS: "" }, os: { homedir: () => fakeHome } });
checkEq("findFreeName increments when colliding", free1, "Pomodoro Timer Pro 2");

// updateAppIcon (updated, then unchanged no-op)
let setIconCalled = 0;
const openWinMock = { isDestroyed: () => false, setIcon: () => setIconCalled++ };
const updated1 = await rt.updateAppIcon(
  { installId: ID_A, desktopFile: installed.desktopFile, image: makeFakeImage("v2"), userDataDir: userData1, openWindow: openWinMock },
  deps1
);
checkEq("updateAppIcon returns true on new icon", updated1, true);
checkEq("updateAppIcon calls openWindow.setIcon", setIconCalled, 1);
const updated2 = await rt.updateAppIcon(
  { installId: ID_A, desktopFile: installed.desktopFile, image: makeFakeImage("v2"), userDataDir: userData1, openWindow: openWinMock },
  deps1
);
checkEq("updateAppIcon returns false when PNG unchanged", updated2, false);

// reconcileRecords: rename, deleted, Hidden=true
writeFileSync(installed.desktopPath, desktopBody.replace("Name=Pomodoro Timer Pro", "Name=Renamed Timer"));
writeFileSync(workInstalled.desktopPath, workBody + "Hidden=true\n");
const recA = { installId: ID_A, artifactUuid: UUID_A, name: "Pomodoro Timer Pro", desktopFile: installed.desktopFile };
const recB = { installId: ID_B, artifactUuid: UUID_A, name: "Work App", desktopFile: workInstalled.desktopFile };
const recMissing = { installId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", artifactUuid: UUID_A, name: "Gone", desktopFile: "gone.desktop" };
const recRes = await rt.reconcileRecords([recA, recB, recMissing], deps1);
checkEq("reconcileRecords kept count", recRes.kept.length, 1);
checkEq("reconcileRecords detected rename", recRes.kept[0].name, "Renamed Timer");
checkEq("reconcileRecords removed Hidden+missing", recRes.removed.map((r) => r.installId), [ID_B, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
checkEq("reconcileRecords changed=true", recRes.changed, true);

// desktopEntryPath & uninstallDesktopEntry
checkEq("desktopEntryPath finds existing file", rt.desktopEntryPath(recA, deps1), installed.desktopPath);
const unres = await rt.uninstallDesktopEntry(recA, userData1, deps1);
checkEq("uninstallDesktopEntry existed=true", unres.existed, true);
check("uninstallDesktopEntry removes .desktop", !existsSync(installed.desktopPath));
check("uninstallDesktopEntry removes local icon", !existsSync(installed.iconPath));
const unres2 = await rt.uninstallDesktopEntry(recA, userData1, deps1);
checkEq("uninstallDesktopEntry idempotent when already gone", unres2.existed, false);

// queueLaunch, openFromCommandLine, drainQueuedOnReady, handleSecondInstance, setBadge
const openedRecords = [];
let hooksEnabled = true;
let markCount = 0;
rt.registerHooks({
  isEnabled: () => hooksEnabled,
  findByInstallId: (id) => (id === ID_A ? recA : undefined),
  openRecord: (rec) => {
    openedRecords.push(rec.installId);
    return true;
  },
  markLaunched: () => {
    markCount++;
  },
});
checkEq("handleSecondInstance passes normal args", rt.handleSecondInstance(["claude", "--toggle"]), false);
let blockedCount = 0;
hooksEnabled = false;
checkEq(
  "handleSecondInstance intercepts --artifact-app and calls onOrgBlocked when disabled",
  rt.handleSecondInstance(["claude", `--artifact-app=${ID_A}`], () => ({ openFromCommandLine: rt.openFromCommandLine }), null, () => blockedCount++),
  true
);
checkEq("onOrgBlocked invoked", blockedCount, 1);
hooksEnabled = true;
checkEq("drainQueuedOnReady opens process.argv launch once", rt.drainQueuedOnReady(), 1);
checkEq("openedRecords holds ID_A", openedRecords, [ID_A]);
checkEq("markLaunched called once", markCount, 1);

const badgeCalls = [];
const badgeApp = { setBadgeCount: (n) => badgeCalls.push(n) };
checkEq("setBadge numeric string", rt.setBadge(badgeApp, "7"), true);
checkEq("setBadge empty clears", rt.setBadge(badgeApp, ""), true);
checkEq("setBadge non-numeric returns false", rt.setBadge(badgeApp, "dot"), false);
checkEq("setBadgeCount calls", badgeCalls, [7, 0]);

// ---------------------------------------------------------------------------
// 2. Preload unit tests (js/artifact_app_window_preload.js)
// ---------------------------------------------------------------------------
section("2. js/artifact_app_window_preload.js preload");

const preloadSrc = readFileSync(PRELOAD_PATH, "utf8");

function makeEventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent(ev) {
      for (const fn of [...(listeners.get(ev.type) || [])]) {
        fn(ev);
        if (ev._stoppedImmediate) break;
      }
    },
  };
}

function makeFakeElement(tag) {
  return {
    tagName: tag.toUpperCase(),
    style: { cssText: "" },
    children: [],
    isConnected: tag === "html",
    attributes: new Map(),
    setAttribute(k, v) { this.attributes.set(k, String(v)); },
    getAttribute(k) { return this.attributes.get(k) ?? null; },
    replaceChildren(...kids) { this.children = kids; },
    append(...kids) {
      for (const k of kids) k.isConnected = true;
      this.children.push(...kids);
    },
    remove() { this.isConnected = false; },
    getBoundingClientRect: () => ({ left: 10, top: 20, right: 410, bottom: 320, width: 400, height: 300 }),
  };
}

function runPreload({ isTop }) {
  const exposed = {};
  const ipcListeners = new Map();
  const ipcSent = [];
  const ipcInvoked = [];
  const winPosted = [];
  const reportNodes = [];
  const iframeEl = makeFakeElement("iframe");
  let manifestText = JSON.stringify({ permissions: { fs: true } });
  const observers = [];

  class FakeMutationObserver {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }

  const rootEl = makeFakeElement("html");
  const docTarget = makeEventTarget();
  const doc = {
    ...docTarget,
    readyState: "complete",
    documentElement: rootEl,
    styleSheets: [],
    adoptedStyleSheets: [],
    createElement: makeFakeElement,
    querySelector: (sel) => {
      if (sel.includes("claude-artifacts-manifest")) return { textContent: manifestText };
      if (sel === "iframe#frame-content") return iframeEl;
      if (sel.startsWith("[data-frame-report]")) return reportNodes.find((n) => !n.closed) || null;
      return null;
    },
    querySelectorAll: () => [],
  };

  const winTarget = makeEventTarget();
  const win = {
    ...winTarget,
    isSecureContext: true,
    location: { origin: "https://claude.ai" },
    document: doc,
    innerWidth: 800,
    innerHeight: 600,
    getComputedStyle: () => ({ getPropertyValue: () => "", visibility: "visible" }),
    postMessage: (data, origin, transfer) => winPosted.push({ data, origin, transfer }),
  };
  win.self = win;
  const topWin = isTop ? win : { topFlag: true };
  win.top = topWin;
  win.parent = topWin;

  const ipcRenderer = {
    send: (ch, ...args) => ipcSent.push({ ch, args }),
    invoke: async (ch, ...args) => {
      ipcInvoked.push({ ch, args });
      if (ch === "artifact-app:node-apis-call") {
        const [{ module, method, args: mArgs }] = args;
        if (module === "fs" && method === "readFile" && mArgs[0] === "/missing") {
          return { ok: false, error: { code: "ENOENT", message: "missing" } };
        }
        if (module === "os" && method === "info") {
          return { ok: true, value: { release: "6.12", hostname: "linux-box", homedir: "/home/u", tmpdir: "/tmp", username: "u", cpus: [], totalmem: 1024, uptime: 99 } };
        }
        if (module === "globalShortcut" && method === "register") return { ok: true, value: true };
        if ((module === "childProcess" || module === "pty") && method === "spawn") return { ok: true, value: { pid: 4242 } };
        return { ok: true, value: `${module}.${method}` };
      }
      return undefined;
    },
    on: (ch, fn) => {
      if (!ipcListeners.has(ch)) ipcListeners.set(ch, new Set());
      ipcListeners.get(ch).add(fn);
    },
    removeListener: (ch, fn) => ipcListeners.get(ch)?.delete(fn),
  };

  const ctx = vm.createContext({
    require: (id) => {
      if (id === "electron") {
        return {
          contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } },
          ipcRenderer,
        };
      }
      throw new Error("module not found");
    },
    window: win,
    document: doc,
    MutationObserver: FakeMutationObserver,
    crypto: { getRandomValues: (arr) => ((arr[0] = 0x12ab34cd), arr) },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    CSSStyleRule: function CSSStyleRule() {},
    HTMLStyleElement: function HTMLStyleElement() {},
    HTMLLinkElement: function HTMLLinkElement() {},
    console,
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 2,
    Map,
    Set,
    Promise,
    Error,
    TypeError,
    Object,
    Array,
  });
  vm.runInContext(preloadSrc, ctx, { filename: PRELOAD_PATH });
  return { exposed, ipcListeners, ipcSent, ipcInvoked, win, winPosted, rootEl, reportNodes, observers };
}

// Top frame tests
const topEnv = runPreload({ isTop: true });
check("top frame exposes claudeDesktopArtifactPane", Boolean(topEnv.exposed.claudeDesktopArtifactPane));
check("top frame hostcaps includes device-geolocation", topEnv.exposed.claudeDesktopArtifactPane.hostcaps.includes("device-geolocation"));
check("top frame does NOT expose __claudeDesktop", !("__claudeDesktop" in topEnv.exposed));

topEnv.win.dispatchEvent({
  type: "message",
  source: topEnv.win,
  origin: "https://claude.ai",
  data: { __frame_host: true, kind: "hello", v: 1 },
});
checkEq("host-tools hello forwarded via ipcRenderer.send", topEnv.ipcSent[0]?.ch, "claude-page:host-tools-hello");

const fakePort = { id: "port1" };
for (const fn of topEnv.ipcListeners.get("claude-page:host-tools-port") || []) {
  fn({ ports: [fakePort] });
}
checkEq("host-tools port transferred to window", topEnv.winPosted[0]?.transfer, [fakePort]);

const evBareC = { type: "keydown", key: "c", metaKey: false, ctrlKey: false, altKey: false, _stoppedImmediate: false, stopImmediatePropagation() { this._stoppedImmediate = true; } };
topEnv.win.dispatchEvent(evBareC);
check("top frame blocks bare 'c' keydown", evBareC._stoppedImmediate === true);
const evCtrlC = { type: "keydown", key: "c", metaKey: false, ctrlKey: true, altKey: false, _stoppedImmediate: false, stopImmediatePropagation() { this._stoppedImmediate = true; } };
topEnv.win.dispatchEvent(evCtrlC);
check("top frame allows Ctrl+c", evCtrlC._stoppedImmediate === false);

// drag overlay & eIPC header/access
for (const fn of topEnv.ipcListeners.get("artifact-app:drag-regions") || []) {
  fn(null, [{ x: 10, y: 10, width: 100, height: 30, drag: true }]);
}
checkEq("drag overlay child count", topEnv.rootEl.children[0]?.children.length, 1);
check("drag overlay sets app-region:drag", topEnv.rootEl.children[0]?.children[0]?.style.cssText.includes("app-region:drag"));

topEnv.win.dispatchEvent({
  type: "message",
  source: topEnv.win,
  origin: "https://claude.ai",
  data: { __frame_chrome_state: true, uuid: UUID_A, state: "header", v: 2, title: "Demo App", about: { author: { kind: "human", name: "Pat" } } },
});
await new Promise((r) => setTimeout(r, 10));
check("eIPC reportAbout invoked", topEnv.ipcInvoked.some((c) => c.ch.endsWith("ArtifactAppPage_$_reportAbout") && c.args[0] === UUID_A));

// Subframe tests (all 3 tiers + declare ordering)
const subEnv = runPreload({ isTop: false });
check("subframe exposes __claudeDesktop", Boolean(subEnv.exposed.__claudeDesktop));
check("subframe exposes claudeArtifacts alias", subEnv.exposed.claudeArtifacts === subEnv.exposed.__claudeDesktop);
const api = subEnv.exposed.__claudeDesktop;
check("subframe window omits setDraggableRegions", !("setDraggableRegions" in api.window));
check("subframe os.hostname works", (await api.os.hostname()) === "linux-box");
checkEq(
  "permissions.declare runs BEFORE queued fs.readFile",
  subEnv.ipcInvoked.slice(0, 2).map((c) => `${c.args[0].module}.${c.args[0].method}`),
  ["permissions.declare", "os.info"]
);
await api.fs.readFile("/tmp/test");
let missingErr = "";
try {
  await api.fs.readFile("/missing");
} catch (err) {
  missingErr = err.message;
}
checkEq("serialized error unwrapped", missingErr, "ENOENT: missing");

const proc = api.childProcess.spawn("echo", ["hi"]);
checkEq("childProcess.spawn resolves pid", await proc.pid, 4242);
const stdoutChunks = [];
proc.stdout.on("data", (d) => stdoutChunks.push(d));
const exitCodes = [];
proc.on("exit", (code) => exitCodes.push(code));
const spawnedId = subEnv.ipcInvoked.find((c) => c.args[0].module === "childProcess" && c.args[0].method === "spawn").args[0].args[0];
for (const fn of subEnv.ipcListeners.get("artifact-app:node-apis-event") || []) {
  fn(null, { id: spawnedId, event: "stdout", payload: "hi\n" });
  fn(null, { id: spawnedId, event: "exit", payload: { code: 0, signal: null } });
}
checkEq("childProcess stdout event delivered", stdoutChunks, ["hi\n"]);
checkEq("childProcess exit event delivered", exitCodes, [0]);

const term = api.pty.spawn("/bin/sh", []);
checkEq("pty.spawn resolves pid", await term.pid, 4242);
let menuClicked = "";
await api.Menu.setApplicationMenu([{ label: "Act", click: (info) => { menuClicked = info.triggered; } }]);
const menuCall = subEnv.ipcInvoked.find((c) => c.args[0].module === "Menu" && c.args[0].method === "setApplicationMenu");
for (const fn of subEnv.ipcListeners.get("artifact-app:node-apis-event") || []) {
  fn(null, { id: menuCall.args[0].args[0], event: "click", payload: { item: "c1", triggered: "yes" } });
}
checkEq("Menu click callback dispatched", menuClicked, "yes");
checkEq("app.dock.setProgress resolves false", await api.app.dock.setProgress(0.5), false);
check("globalShortcut.register returns true", (await api.globalShortcut.register("CommandOrControl+Shift+A", () => {})) === true);
check("tray.set reachable", typeof api.tray.set === "function" && typeof api.tray.remove === "function");

// ---------------------------------------------------------------------------
// 3. Patch binary checks (synthetic + full bundle if present locally)
// ---------------------------------------------------------------------------
section("3. Compiled patch binaries");

let preBinOk = false;
let mainBinOk = false;
try { accessSync(PRE_BIN, constants.X_OK); preBinOk = true; } catch {}
try { accessSync(MAIN_BIN, constants.X_OK); mainBinOk = true; } catch {}

if (preBinOk) {
  const preFixture = join(scratch, "pre.fixture.js");
  writeFileSync(
    preFixture,
    `var XQt="--artifact-app-launch",ZQt=e=>e===XQt,e$t=!1,t$t=new Set,n$t;function r$t(){}var Xue={launchArg:XQt,isLaunch:e=>!1,active:()=>e$t,bornHiddenReason:()=>e$t?"appifact":void 0,enter:r$t,other:1};`
  );
  const rPre1 = spawnSync(PRE_BIN, [preFixture], { encoding: "utf8" });
  check("fix_artifact_apps_pre_linux applies to synthetic fixture", rPre1.status === 0);
  const patchedPre = readFileSync(preFixture, "utf8");
  const rPre2 = spawnSync(PRE_BIN, [preFixture], { encoding: "utf8" });
  check("fix_artifact_apps_pre_linux idempotent", rPre2.status === 0 && readFileSync(preFixture, "utf8") === patchedPre);
  check("patched index.pre fixture valid JS", spawnSync("node", ["--check", preFixture]).status === 0);
  const preCtx = vm.createContext({});
  vm.runInContext(patchedPre, preCtx);
  check("patched Xue.isLaunch recognizes --artifact-app=<id>", preCtx.Xue.isLaunch(["claude", `--artifact-app=${ID_A}`]) === true);
  check("patched Xue.isLaunch ignores after --", preCtx.Xue.isLaunch(["claude", "--", `--artifact-app=${ID_A}`]) === false);
  preCtx.Xue.enter();
  check("patched Xue.enter activates bornHiddenReason=appifact", preCtx.Xue.active() === true && preCtx.Xue.bornHiddenReason() === "appifact");
} else {
  console.log("  INFO fix_artifact_apps_pre_linux binary not compiled; skipping binary test");
}

const patchNimSrc = readFileSync(join(ROOT, "patches", "linux", "fix_artifact_apps_linux.nim"), "utf8");
check("patch uses findUnique and removes cross-chunk dxU/dxC/djsElectron and _gb race",
  patchNimSrc.includes("proc findUnique(") &&
  !patchNimSrc.includes("dxU") &&
  !patchNimSrc.includes("dxC") &&
  !patchNimSrc.includes("djsElectron") &&
  !patchNimSrc.includes("._gb") &&
  patchNimSrc.includes("try{let _id=globalThis.__cdbArtifactApps.newInstallId()") &&
  patchNimSrc.includes("[artifactApps] linux install failed")
);

const localExtract = [
  join(ROOT, "tmp", "app.asar.contents-6.28899.6"),
  join(ROOT, "tmp", "app.asar.contents"),
].find((d) => existsSync(join(d, ".vite", "build", "index.pre.js")) && existsSync(join(d, ".vite", "build", "index.js")));

if (preBinOk && mainBinOk && localExtract) {
  const pyCheck = `
import re, subprocess, sys, tempfile
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(join(ROOT, "scripts"))})
import apply_patches as ap

src = Path(${JSON.stringify(localExtract)}) / ".vite" / "build"
with tempfile.TemporaryDirectory() as td:
    td_p = Path(td)
    pre_copy = td_p / "index.pre.js"
    pre_copy.write_bytes((src / "index.pre.js").read_bytes())
    subprocess.run([${JSON.stringify(PRE_BIN)}, str(pre_copy)], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(["node", "--check", str(pre_copy)], check=True, stdout=subprocess.DEVNULL)

    parts = ap.chunk_parts(src / "index.js")
    staged = td_p / "staged.js"
    staged.write_bytes(ap.concat_parts(parts))
    subprocess.run([${JSON.stringify(MAIN_BIN)}, str(staged)], check=True, stdout=subprocess.DEVNULL)
    b1 = staged.read_bytes()
    subprocess.run([${JSON.stringify(MAIN_BIN)}, str(staged)], check=True, stdout=subprocess.DEVNULL)
    assert staged.read_bytes() == b1, "not idempotent"

    pieces = ap.MARKER_RE.split(b1)
    contents = pieces[0::2]
    names = [n.decode() for n in pieces[1::2]]
    assert len(contents) == len(parts) and names == [p.name for p in parts[1:]], "chunk split mismatch"
    assert ap.check_cross_part_identifiers(contents, [parts[0].name] + names), "cross-part ident check failed"
    by_name = dict(zip([parts[0].name] + names, contents))
    dx = next((v.decode("utf-8", "replace") for k, v in by_name.items() if b"desktop_artifact_app_installed" in v), "")
    dq = next((v.decode("utf-8", "replace") for k, v in by_name.items() if b"2701212339" in v and b"artifact-shell:transport-port" in v), "")
    assert "try{let _id=globalThis.__cdbArtifactApps.newInstallId()" in dx, "Sl missing try-scoped newInstallId"
    assert "(0,E.randomBytes)" not in dx and "randomBytes" not in dx.split("installDesktopEntry")[0][-160:], "unexpected randomBytes in Sl"
    assert "globalThis.__cdbArtifactApps._gb" not in dq, "B1/B2 _gb startup race still present"
    assert re.search(r"globalThis\\.__cdbArtifactApps\\._tier1=\\(\\)=>[\\w$]+\\(1\\)&&[\\w$]+\\([\\w$]+\\)\\)", dq), "B2 direct _tier1 check missing"
    for p, c in zip(parts, contents):
        if c != p.read_bytes():
            chk = td_p / f"chk_{p.name}"
            chk.write_bytes(c)
            sc = subprocess.run(["node", "--check", str(chk)], capture_output=True, text=True)
            assert sc.returncode == 0, f"node --check failed for {p.name}: {sc.stderr}"
print("FULL_BUNDLE_OK")
`;
  const rFull = spawnSync("python3", ["-c", pyCheck], { encoding: "utf8", timeout: 60000 });
  check("full local v6 bundle patches + idempotency + syntax pass", rFull.status === 0 && rFull.stdout.includes("FULL_BUNDLE_OK"), rFull.stderr || rFull.stdout);
} else {
  console.log("  INFO no local extracted bundle in tmp/; skipping full-bundle patch check (CI runs this in build step)");
}

section(`Summary: ${pass} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("Failed checks:", failures.join(", "));
  process.exit(1);
}
process.exit(0);
