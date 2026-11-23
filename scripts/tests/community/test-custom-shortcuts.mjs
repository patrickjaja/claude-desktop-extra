#!/usr/bin/env node
/*
 * test-custom-shortcuts.mjs - end-to-end tests for Custom Shortcuts (issues
 * #350 and #352):
 *   1. patches/community/add_feature_custom_shortcuts (apply, idempotent, guard)
 *   2. patches/core/fix_quick_entry_cli_toggle (shortcut:<slug> socket + argv)
 *   3. js/custom_shortcuts_main.js (config, .jsonc locks, accelerator parser,
 *      QWERTZ/non-Latin/AltGr matching, recording lock, globalShortcut lifecycle,
 *      Wayland portal probe, sender guard)
 *   4. js/custom_shortcuts_page.js in headless Chromium (Read Aloud hydrated /
 *      deferred / streaming / playing, Voice Mode OR / qR / xR / /code guard,
 *      New Voice Chat /new + mistap settle, [data-keyboard-shortcut-input] sync)
 *
 * Usage: node scripts/tests/community/test-custom-shortcuts.mjs   (0=PASS, 1=FAIL, 3=SKIP)
 */
import {
  readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync,
  existsSync, chmodSync, accessSync, constants, symlinkSync
} from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import http from "node:http";
import net from "node:net";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PATCH_CS = join(ROOT, "patches", "community", "add_feature_custom_shortcuts");
const PATCH_QE = join(ROOT, "patches", "core", "fix_quick_entry_cli_toggle");
const SENDER_GUARD_JS = join(ROOT, "js", "sender_guard.js");
const PAGE_JS_PATH = join(ROOT, "js", "custom_shortcuts_page.js");
const SKIP_EXIT = 3;

const require2 = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  PASS " + label + (extra ? "  -> " + extra : "")); return; }
  fail++;
  console.error("  FAIL " + label + (extra ? "  -> " + extra : ""));
}
function section(title) { console.log("\n" + title); }

const cleanupDirs = [];
function tempDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(d);
  return d;
}

function findChromium() {
  for (const c of ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"]) {
    try {
      const p = execFileSync("/bin/sh", ["-c", "command -v " + c], { encoding: "utf8" }).trim();
      if (p) return p;
    } catch {}
  }
  return null;
}

// --- 1. Patch binary apply + idempotency + syntax check --------------------
section("1. add_feature_custom_shortcuts patch binary");
for (const bin of [PATCH_CS, PATCH_QE]) {
  try { accessSync(bin, constants.X_OK); } catch {
    console.error("SKIP: compiled patch binary missing: " + bin);
    process.exit(SKIP_EXIT);
  }
}

const csModDir = tempDir("cdb-cs-mod-");
const csModFile = join(csModDir, "bundle.cjs");
{
  const seed = '"use strict";\nconst __upstreamDemo = 1;\n';
  writeFileSync(csModFile, seed, "utf8");
  const r1 = spawnSync(PATCH_CS, [csModFile], { encoding: "utf8" });
  ok(r1.status === 0, "add_feature_custom_shortcuts applies cleanly to bundle");
  const out1 = readFileSync(csModFile, "utf8");
  ok(out1.includes("/*__CDB_CUSTOM_SHORTCUTS__*/") &&
     out1.includes('"cdb-shortcuts:pref-read"') &&
     out1.includes('globalThis.__cdbCustomShortcuts = Object.freeze('),
     "injected output contains required positive markers");
  const nc = spawnSync(process.execPath, ["--check", csModFile], { encoding: "utf8" });
  ok(nc.status === 0, "patched bundle passes node --check");

  const r2 = spawnSync(PATCH_CS, [csModFile], { encoding: "utf8" });
  ok(r2.status === 0 && readFileSync(csModFile, "utf8") === out1,
     "second patch run is cleanly idempotent");

  const partial = join(csModDir, "partial.cjs");
  writeFileSync(partial, '"use strict";const m="/*__CDB_CUSTOM_SHORTCUTS__*/";', "utf8");
  const r3 = spawnSync(PATCH_CS, [partial], { encoding: "utf8" });
  ok(r3.status !== 0, "partial injection is rejected (exit " + r3.status + ")");
}

// --- 2. fix_quick_entry_cli_toggle shortcut:<slug> socket & argv -----------
section("2. fix_quick_entry_cli_toggle shortcut socket & second-instance");
{
  const qeDir = tempDir("cdb-cs-qe-");
  const qeFile = join(qeDir, "qe.js");
  const body = "V&&!V.isDestroyed()&&V.isFullScreen()?(V.focus(),UEa(V)):m8o()";
  const second = 'app.on("second-instance",((e,t,n)=>{go(t)}));';
  writeFileSync(qeFile, `$Ro(g7.QUICK_ENTRY,(()=>{${body}}),xyi);${second}`, "utf8");
  const r1 = spawnSync(PATCH_QE, [qeFile], { encoding: "utf8" });
  ok(r1.status === 0, "fix_quick_entry_cli_toggle applies cleanly");
  const out = readFileSync(qeFile, "utf8");
  ok(spawnSync(process.execPath, ["--check", qeFile], { encoding: "utf8" }).status === 0,
     "patched QE fixture passes node --check");
  const r2 = spawnSync(PATCH_QE, [qeFile], { encoding: "utf8" });
  ok(r2.status === 0 && readFileSync(qeFile, "utf8") === out,
     "QE patch second run is idempotent");

  let secondInstanceCb = null;
  let serverConnectionCb = null;
  let serverOpts = null;
  const sockListeners = [];
  const triggerCalls = [];
  const fakeNet = {
    createServer: (opts, cb) => {
      if (typeof opts === "function") {
        cb = opts;
        opts = {};
      }
      serverOpts = opts;
      serverConnectionCb = cb;
      return {
        on: () => {},
        listen: (_p, fn) => { if (fn) fn(); },
        unref: () => {}
      };
    }
  };
  const fakeFs = {
    unlinkSync: () => {},
    chmodSync: () => {}
  };
  const ctx = vm.createContext({
    globalThis: undefined,
    process: { argv: [], env: { XDG_RUNTIME_DIR: qeDir }, platform: "linux", getuid: () => 1000 },
    Buffer,
    Promise,
    setTimeout: (fn) => { sockListeners.push(fn); return sockListeners.length; },
    clearTimeout: () => {},
    require: (m) => (m === "net" ? fakeNet : m === "fs" ? fakeFs : {}),
    console,
    V: null, UEa() {}, m8o() {}, xyi() {},
    app: { on: (ev, cb) => { if (ev === "second-instance") secondInstanceCb = cb; } },
    go() {},
    g7: { QUICK_ENTRY: "QE" },
    $Ro: () => {},
    __cdbCustomShortcuts: {
      trigger: (slug, src) => {
        triggerCalls.push([slug, src]);
        return Promise.resolve({ ok: true, action: slug, source: src });
      }
    }
  });
  ctx.globalThis = ctx;
  vm.runInContext(out, ctx);
  for (const fn of sockListeners) { try { fn(); } catch {} }

  ok(typeof serverConnectionCb === "function" && typeof secondInstanceCb === "function",
     "captured unix socket server and second-instance callback");
  ok(Boolean(serverOpts && serverOpts.allowHalfOpen === true),
     "QE unix socket server enables allowHalfOpen for async shortcut:* replies");

  if (serverConnectionCb) {
    let reply = "";
    const connHandlers = {};
    const fakeConn = {
      setEncoding: () => {},
      on: (ev, fn) => { connHandlers[ev] = fn; },
      end: (chunk) => { if (chunk) reply += String(chunk); },
      destroy: () => {}
    };
    serverConnectionCb(fakeConn);
    connHandlers.data(Buffer.from("shortcut:read-aloud\n", "utf8"));
    await new Promise((r) => setTimeout(r, 20));
    ok(reply.includes('"ok":true') &&
       triggerCalls.some((c) => c[0] === "read-aloud" && c[1] === "socket"),
       "socket command shortcut:read-aloud dispatches to __cdbCustomShortcuts.trigger and writes JSON reply");
  }

  if (secondInstanceCb) {
    secondInstanceCb({}, ["claude-desktop", "--trigger-shortcut=new-voice-chat"], "/tmp");
    secondInstanceCb({}, ["claude-desktop", "--trigger-shortcut", "voice-mode"], "/tmp");
    await new Promise((r) => setTimeout(r, 20));
    ok(triggerCalls.some((c) => c[0] === "new-voice-chat" && c[1] === "second-instance") &&
       triggerCalls.some((c) => c[0] === "voice-mode" && c[1] === "second-instance"),
       "second-instance handles both --trigger-shortcut=slug and --trigger-shortcut slug");
  }

  // Real node:net Unix socket half-close roundtrip: client writes command and
  // immediately closes write side (SHUT_WR / client.end()) while trigger()
  // resolves asynchronously 25ms later.
  {
    const realSockDir = tempDir("cdb-cs-realsock-");
    const realServers = [];
    const listeningPromises = [];
    const realNetWrapper = {
      createServer: (...args) => {
        const srv = net.createServer(...args);
        realServers.push(srv);
        const origListen = srv.listen.bind(srv);
        srv.listen = (...largs) => {
          listeningPromises.push(new Promise((res) => srv.once("listening", res)));
          return origListen(...largs);
        };
        return srv;
      }
    };
    const realCtx = vm.createContext({
      globalThis: undefined,
      process: { argv: [], env: { XDG_RUNTIME_DIR: realSockDir }, platform: "linux", getuid: () => process.getuid() },
      Buffer,
      Promise,
      setTimeout,
      clearTimeout,
      require: (m) => (m === "net" ? realNetWrapper : require2(m)),
      console,
      V: null, UEa() {}, m8o() {}, xyi() {},
      app: { on: () => {} },
      go() {},
      g7: { QUICK_ENTRY: "QE" },
      $Ro: () => {},
      __cdbCustomShortcuts: {
        trigger: (slug, src) =>
          new Promise((resolve) => setTimeout(() => resolve({ ok: true, action: slug, source: src }), 25))
      }
    });
    realCtx.globalThis = realCtx;
    vm.runInContext(out, realCtx);
    await Promise.all(listeningPromises);
    const sockPath = join(realSockDir, "claude-desktop-qe.sock");
    let sockReply = "";
    try {
      sockReply = await new Promise((resolve, reject) => {
        const chunks = [];
        const timer = setTimeout(() => reject(new Error("real socket half-close timeout")), 3000);
        const client = net.createConnection(sockPath, () => {
          client.end("shortcut:read-aloud\n");
        });
        client.on("data", (d) => chunks.push(String(d)));
        client.on("end", () => {
          clearTimeout(timer);
          resolve(chunks.join(""));
        });
        client.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    } finally {
      for (const s of realServers) {
        try { await new Promise((r) => s.close(r)); } catch {}
      }
    }
    ok(sockReply.trim() === '{"ok":true,"action":"read-aloud","source":"socket"}',
       "real Unix socket receives async JSON reply after client half-close (allowHalfOpen)",
       sockReply.trim());
  }
}

// --- 3. main-process module sandbox tests ---------------------------------
section("3. custom_shortcuts_main.js runtime, persistence, layouts, portals & security");

function loadMainHarness(opts = {}) {
  const base = tempDir("cdb-cs-run-");
  const userData = join(base, "Claude");
  const binDir = join(base, "bin");
  mkdirSync(userData, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  const busctlPath = join(binDir, "busctl");
  if (opts.portalVersion && opts.portalVersion > 0) {
    writeFileSync(busctlPath, `#!/bin/sh\necho "u ${opts.portalVersion}"\n`, "utf8");
  } else {
    writeFileSync(busctlPath, "#!/bin/sh\nexit 1\n", "utf8");
  }
  chmodSync(busctlPath, 0o755);

  // Emit sender guard + custom shortcuts into one bundle file so IPC auth runs end-to-end.
  const bundlePath = join(base, "main.cjs");
  writeFileSync(bundlePath, '"use strict";\n' + readFileSync(SENDER_GUARD_JS, "utf8") + "\n", "utf8");
  execFileSync(PATCH_CS, [bundlePath], { stdio: "ignore" });

  if (opts.seedJson) writeFileSync(join(userData, "claude-desktop-extra.json"), JSON.stringify(opts.seedJson, null, 2));
  if (opts.seedJsonc) writeFileSync(join(userData, "claude-desktop-extra.jsonc"), opts.seedJsonc);

  const ipcHandlers = {};
  const appListeners = {};
  const registeredGlobals = new Map();
  const unregisterLog = [];
  const execJsCalls = [];
  const navCalls = [];
  let winFocusCalls = 0;

  const wcHandlers = {};
  const fakeWc = {
    id: 101,
    isDestroyed: () => false,
    getURL: () => opts.pageUrl || "https://claude.ai/chat/123",
    on: (ev, fn) => {
      if (!wcHandlers[ev]) wcHandlers[ev] = [];
      wcHandlers[ev].push(fn);
    },
    executeJavaScript: (code) => {
      execJsCalls.push(code);
      if (code.includes("window.__cdbCustomShortcuts")) {
        return Promise.resolve({ ok: true, action: "mocked" });
      }
      return Promise.resolve("custom-shortcuts: installed");
    },
    focus: () => {}
  };
  const fakeWin = {
    isDestroyed: () => false,
    isFocused: () => true,
    isMinimized: () => false,
    isVisible: () => true,
    restore: () => {},
    show: () => {},
    focus: () => { winFocusCalls++; }
  };

  const fakeElectron = {
    app: {
      getPath: (k) => (k === "userData" ? userData : base),
      on: (ev, fn) => {
        if (!appListeners[ev]) appListeners[ev] = [];
        appListeners[ev].push(fn);
      },
      whenReady: () => Promise.resolve()
    },
    ipcMain: {
      handle: (ch, fn) => { ipcHandlers[ch] = fn; },
      removeHandler: (ch) => { delete ipcHandlers[ch]; }
    },
    BrowserWindow: {
      fromWebContents: () => fakeWin
    },
    webContents: {
      getAllWebContents: () => [fakeWc]
    },
    globalShortcut: {
      isRegistered: (acc) => registeredGlobals.has(acc),
      register: (acc, cb) => {
        if (opts.failGlobalRegister) return false;
        registeredGlobals.set(acc, cb);
        return true;
      },
      unregister: (acc) => {
        unregisterLog.push(acc);
        registeredGlobals.delete(acc);
      }
    }
  };

  // Preserve custom env during test
  const prevEnv = {
    XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
    DISPLAY: process.env.DISPLAY,
    XDG_CURRENT_DESKTOP: process.env.XDG_CURRENT_DESKTOP,
    PATH: process.env.PATH,
    CLAUDE_USE_XWAYLAND: process.env.CLAUDE_USE_XWAYLAND
  };
  process.env.XDG_SESSION_TYPE = opts.sessionType ?? "x11";
  process.env.WAYLAND_DISPLAY = opts.waylandDisplay ?? "";
  process.env.DISPLAY = opts.display ?? ":0";
  process.env.XDG_CURRENT_DESKTOP = opts.desktop ?? "XFCE";
  process.env.CLAUDE_USE_XWAYLAND = opts.useXwayland ?? "";
  process.env.PATH = binDir + ":" + (prevEnv.PATH || "");

  delete globalThis.__cdbCustomShortcutsMain;
  delete globalThis.__cdbCustomShortcuts;
  delete globalThis.__cdbSenderGuard;
  globalThis.__cdbToolPath = { which: (name) => (name === "busctl" ? busctlPath : null) };
  globalThis.__cdbNavigation = {
    getDispatcher: () => ({ dispatchNavigate: (p) => navCalls.push(p) })
  };

  const Module = require2("module");
  const origLoad = Module._load;
  Module._load = function (req, ...rest) {
    if (req === "electron") return fakeElectron;
    return origLoad.call(this, req, ...rest);
  };
  try {
    delete require2.cache[bundlePath];
    require2(bundlePath);
  } finally {
    Module._load = origLoad;
  }

  // Trigger web-contents-created + dom-ready and flush async whenReady/portal probe.
  for (const fn of appListeners["web-contents-created"] || []) fn({}, fakeWc);
  for (const fn of wcHandlers["dom-ready"] || []) fn();

  async function flush() {
    await new Promise((r) => setTimeout(r, 60));
  }

  function restoreEnv() {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete globalThis.__cdbToolPath;
    delete globalThis.__cdbNavigation;
    delete globalThis.__cdbCustomShortcutsMain;
    delete globalThis.__cdbCustomShortcuts;
    delete globalThis.__cdbSenderGuard;
  }

  const trustedEv = (url = "https://claude.ai/chat/123") => ({
    sender: {
      isDestroyed: () => false,
      getURL: () => url,
      mainFrame: { url }
    },
    senderFrame: { url }
  });
  const untrustedEv = (url = "https://evil.example/") => ({
    sender: {
      isDestroyed: () => false,
      getURL: () => url,
      mainFrame: { url }
    },
    senderFrame: { url }
  });

  function fireBeforeInput(input) {
    let prevented = false;
    const ev = { preventDefault: () => { prevented = true; } };
    for (const fn of wcHandlers["before-input-event"] || []) fn(ev, input);
    return prevented;
  }

  return {
    userData,
    ipcHandlers,
    registeredGlobals,
    unregisterLog,
    execJsCalls,
    navCalls,
    winFocusCalls: () => winFocusCalls,
    trustedEv,
    untrustedEv,
    fireBeforeInput,
    flush,
    restoreEnv,
    api: globalThis.__cdbCustomShortcuts
  };
}

{
  // Seed unrelated string values containing ",}" / ",]" to verify stripComments never corrupts them.
  const seedPayload = { unrelated: "keep me ,} and ,] intact", customModels: { note: "a ,} b" } };
  const h = loadMainHarness({ sessionType: "x11", desktop: "XFCE", seedJson: seedPayload });
  await h.flush();

  const st0 = h.ipcHandlers["cdb-shortcuts:pref-read"](h.trustedEv());
  ok(st0.ok === true && st0.enabled === false && st0.enabledLocked === false &&
     st0.lockedByJsonc === false && st0.actions.length === 4 &&
     st0.actions.some((a) => a.id === "sendNow" && a.slug === "send-now") &&
     st0.actions.every((a) => a.accelerator === "" && a.scope === "app") &&
     st0.session.sessionType === "x11",
     "default state is off, 4 unbound app-scoped actions (including sendNow), X11 detected");

  ok(h.execJsCalls.length === 0,
     "opt-in gating: dom-ready does NOT inject page script while customShortcuts is disabled");
  const offTrig = await h.api.trigger("voiceMode", "socket");
  ok(!offTrig.ok && /disabled/i.test(offTrig.error || ""),
     "opt-in gating: trigger refuses cleanly while disabled");

  const denied = h.ipcHandlers["cdb-shortcuts:pref-read"](h.untrustedEv());
  ok(denied.ok === false && /untrusted/i.test(denied.error),
     "sender guard blocks untrusted origin IPC calls");

  const protoBind = h.ipcHandlers["cdb-shortcuts:bind"](h.trustedEv(), "toString", "Ctrl+Shift+Z");
  const protoScope = h.ipcHandlers["cdb-shortcuts:scope"](h.trustedEv(), "constructor", "global");
  const protoTrig = await h.api.trigger("toString", "socket");
  ok(!protoBind.ok && !protoScope.ok && !protoTrig.ok,
     "prototype keys (toString, constructor) are rejected on bind, scope, and trigger");

  const badRes = h.ipcHandlers["cdb-shortcuts:bind"](h.trustedEv(), "voiceMode", "Ctrl+C");
  const badAltGr = h.ipcHandlers["cdb-shortcuts:bind"](h.trustedEv(), "voiceMode", "AltGr+V");
  const badBare = h.ipcHandlers["cdb-shortcuts:bind"](h.trustedEv(), "voiceMode", "V");
  const badShift = h.ipcHandlers["cdb-shortcuts:bind"](h.trustedEv(), "voiceMode", "Shift+V");
  ok(!badRes.ok && !badAltGr.ok && !badBare.ok && !badShift.ok,
     "rejects reserved (Ctrl+C), AltGr, unmodified, and Shift-only shortcuts");

  const bound = h.ipcHandlers["cdb-shortcuts:bind"](h.trustedEv(), "voiceMode", "commandorcontrol+shift+v");
  ok(bound.ok && bound.enabled === true &&
     bound.actions[0].accelerator === "Ctrl+Shift+V",
     "bind normalizes commandorcontrol+shift+v -> Ctrl+Shift+V and enables shortcuts on first bind");
  ok(h.execJsCalls.length >= 1,
     "enabling shortcuts via bind injects page helper into already-open webContents");

  const dup = h.ipcHandlers["cdb-shortcuts:bind"](h.trustedEv(), "readAloud", "Ctrl+Shift+V");
  ok(!dup.ok && /already assigned/i.test(dup.error),
     "duplicate chord across two actions is rejected");

  const diskCfg = JSON.parse(readFileSync(join(h.userData, "claude-desktop-extra.json"), "utf8"));
  ok(diskCfg.customShortcuts && diskCfg.customShortcuts.enabled === true &&
     diskCfg.customShortcuts.bindings.voiceMode.accelerator === "Ctrl+Shift+V" &&
     diskCfg.unrelated === seedPayload.unrelated &&
     diskCfg.customModels.note === seedPayload.customModels.note &&
     !existsSync(join(h.userData, "claude-desktop-extra.json.cdb-bak")),
     "persist keeps unrelated ',}'/',]' JSON string values intact with no spurious .cdb-bak");

  // Scope Global -> registers Electron globalShortcut; recording pauses it; disabling unregisters.
  h.ipcHandlers["cdb-shortcuts:scope"](h.trustedEv(), "voiceMode", "global");
  ok(h.registeredGlobals.has("Control+Shift+V"),
     "Global scope registers Control+Shift+V via Electron globalShortcut");
  h.ipcHandlers["cdb-shortcuts:recording"](h.trustedEv(), true);
  ok(!h.registeredGlobals.has("Control+Shift+V"),
     "recording(true) temporarily pauses active global shortcuts");
  h.ipcHandlers["cdb-shortcuts:recording"](h.trustedEv(), false);
  ok(h.registeredGlobals.has("Control+Shift+V"),
     "recording(false) re-arms active global shortcuts");
  h.ipcHandlers["cdb-shortcuts:pref-set"](h.trustedEv(), false);
  ok(!h.registeredGlobals.has("Control+Shift+V") && h.unregisterLog.includes("Control+Shift+V"),
     "disabling master switch unregisters owned global shortcuts");
  h.ipcHandlers["cdb-shortcuts:pref-set"](h.trustedEv(), true);
  ok(h.registeredGlobals.has("Control+Shift+V"),
     "re-enabling restores global shortcut registration");

  // Layout-aware before-input-event matching + cross-layout punctuation/Numpad safety + recording suppression
  h.ipcHandlers["cdb-shortcuts:bind"](h.trustedEv(), "readAloud", "Ctrl+Alt+Z");
  h.ipcHandlers["cdb-shortcuts:bind"](h.trustedEv(), "newVoiceChat", "Ctrl+Shift+1");
  const execBefore = h.execJsCalls.length;
  const hitV = h.fireBeforeInput({ type: "keyDown", control: true, shift: true, key: "v", code: "KeyV" });
  // QWERTZ 'de': physical KeyY produces 'z'!
  const hitZde = h.fireBeforeInput({ type: "keyDown", control: true, alt: true, key: "z", code: "KeyY" });
  const missYde = h.fireBeforeInput({ type: "keyDown", control: true, alt: true, key: "y", code: "KeyZ" });
  const hitShiftDigit = h.fireBeforeInput({ type: "keyDown", control: true, shift: true, key: "!", code: "Digit1" });
  const missNumpadDigit = h.fireBeforeInput({ type: "keyDown", control: true, shift: true, key: "1", code: "Numpad1" });
  const missRepeat = h.fireBeforeInput({ type: "keyDown", control: true, shift: true, key: "v", code: "KeyV", isAutoRepeat: true });
  const missAltGr = h.fireBeforeInput({ type: "keyDown", control: true, alt: true, key: "AltGraph", modifiers: ["altgr"] });
  // QWERTZ '-' sits on physical Slash key: must NOT match a Ctrl+Alt+/ binding!
  const parsedSlash = h.api._parseAccelerator("Ctrl+Alt+/");
  const missQwertzDashAsSlash = h.api._matchesInput(parsedSlash, { type: "keyDown", control: true, alt: true, key: "-", code: "Slash" });
  const hitShiftedMinus = h.api._matchesInput(h.api._parseAccelerator("Ctrl+Shift+-"), { type: "keyDown", control: true, shift: true, key: "_", code: "Minus" });
  ok(hitV && hitZde && !missYde && hitShiftDigit && !missNumpadDigit &&
     !missRepeat && !missAltGr && !missQwertzDashAsSlash && hitShiftedMinus,
     "before-input-event matches US/QWERTZ/shifted-digit, ignores repeat/AltGr/Numpad1 and avoids cross-layout punctuation collisions");

  // Non-Latin XKB fallback (e.g. Russian keyboard active on Ctrl+Shift+V -> key='в', code='KeyV')
  const hitCyrillic = h.fireBeforeInput({ type: "keyDown", control: true, shift: true, key: "в", code: "KeyV" });
  ok(hitCyrillic, "non-Latin active XKB group falls back to physical Key* code");

  // Recording lock suppresses firing
  h.ipcHandlers["cdb-shortcuts:recording"](h.trustedEv(), true);
  const blockedWhileRec = h.fireBeforeInput({ type: "keyDown", control: true, shift: true, key: "v", code: "KeyV" });
  h.ipcHandlers["cdb-shortcuts:recording"](h.trustedEv(), false);
  const resumedAfterRec = h.fireBeforeInput({ type: "keyDown", control: true, shift: true, key: "v", code: "KeyV" });
  ok(!blockedWhileRec && resumedAfterRec, "recording(true) suppresses shortcut trigger; recording(false) resumes");

  // Triggering newVoiceChat from /chat/123 calls __cdbNavigation.dispatchNavigate("/new") + focuses window from socket
  await h.api.trigger("newVoiceChat", "socket");
  ok(h.navCalls.includes("/new") && h.winFocusCalls() >= 1 && h.execJsCalls.length > execBefore,
     "newVoiceChat dispatches /new navigation and focuses window when triggered externally");

  // Bind sendNow to Alt+Enter (normalized -> Alt+Return), match Enter & NumpadEnter, and verify socket trigger does not steal window focus
  const bindSendNow = h.ipcHandlers["cdb-shortcuts:bind"](h.trustedEv(), "sendNow", "alt+enter");
  const sendNowRow = bindSendNow.actions && bindSendNow.actions.find((a) => a.id === "sendNow");
  const hitSendEnter = h.fireBeforeInput({ type: "keyDown", alt: true, key: "Enter", code: "Enter" });
  const hitSendNumpad = h.fireBeforeInput({ type: "keyDown", alt: true, key: "Enter", code: "NumpadEnter" });
  const focusBeforeSend = h.winFocusCalls();
  const execBeforeSend = h.execJsCalls.length;
  const sockSend = await h.api.trigger("send-now", "socket");
  ok(bindSendNow.ok && sendNowRow && sendNowRow.accelerator === "Alt+Return" &&
     hitSendEnter && hitSendNumpad &&
     sockSend.ok && h.execJsCalls.length > execBeforeSend &&
     h.execJsCalls[h.execJsCalls.length - 1].includes('"sendNow"') &&
     h.winFocusCalls() === focusBeforeSend,
     "sendNow binds Alt+Enter -> Alt+Return, matches Enter/NumpadEnter, and triggers via send-now slug without stealing focus");

  // Reset prunes customShortcuts cleanly when off
  h.ipcHandlers["cdb-shortcuts:reset"](h.trustedEv());
  h.ipcHandlers["cdb-shortcuts:pref-set"](h.trustedEv(), false);
  const cleanDisk = JSON.parse(readFileSync(join(h.userData, "claude-desktop-extra.json"), "utf8"));
  ok(!("customShortcuts" in cleanDisk), "reset + off prunes default customShortcuts key cleanly from json");
  h.restoreEnv();
}

// .jsonc per-binding vs switch lock + Wayland wlroots no-portal session test + .jsonc conflict precedence
{
  const hw = loadMainHarness({
    sessionType: "wayland",
    waylandDisplay: "wayland-1",
    desktop: "sway",
    portalVersion: 0,
    seedJson: { customShortcuts: { bindings: { newVoiceChat: { accelerator: "Ctrl+Shift+V", scope: "app" } } } },
    seedJsonc: '{\n  // lock shorthand binding; .jsonc wins duplicate Ctrl+Shift+V over .json newVoiceChat\n  "customShortcuts": { "bindings": { "voiceMode": "Ctrl+Shift+V", "readAloud": { "accelerator": "F9", "scope": "global" } } }\n}\n'
  });
  await hw.flush();
  const st = hw.ipcHandlers["cdb-shortcuts:pref-read"](hw.trustedEv());
  ok(st.session.isWayland === true && st.session.family === "sway" &&
     st.session.portalProbed === true && st.session.portalAvailable === false &&
     st.session.globalSupported === false,
     "Wayland sway session without GlobalShortcuts portal sets globalSupported=false and skips globalShortcut");
  ok(st.enabledLocked === false && st.lockedByJsonc === false &&
     st.actions[0].locked === true && st.actions[0].accelerator === "Ctrl+Shift+V" &&
     st.actions[1].accelerator === "" &&
     st.actions[2].locked === true && st.actions[2].accelerator === "F9" &&
     st.actions[1].locked === false,
     ".jsonc per-binding lock wins duplicate chords over .json, leaves master switch unlocked and normalizes shorthand strings");
  const canFlip = hw.ipcHandlers["cdb-shortcuts:pref-set"](hw.trustedEv(), true);
  ok(canFlip.ok && canFlip.enabled === true &&
     !hw.registeredGlobals.has("F9") &&
     canFlip.actions[2].globalStatus && canFlip.actions[2].globalStatus.reason === "no-portal",
     "enabling shortcuts on Wayland without portal skips electron.globalShortcut and reports reason=no-portal");
  const blockedLockedBind = hw.ipcHandlers["cdb-shortcuts:bind"](hw.trustedEv(), "voiceMode", "Ctrl+Shift+M");
  ok(!blockedLockedBind.ok && /jsonc/i.test(blockedLockedBind.error),
     "refuses overwriting a .jsonc-locked binding via UI IPC");
  hw.restoreEnv();
}

// --- 4. Headless Chromium DOM harness for js/custom_shortcuts_page.js -------
section("4. custom_shortcuts_page.js headless Chromium DOM scenarios");
const CHROMIUM = findChromium();
if (!CHROMIUM) {
  console.log("  SKIP: no chromium binary on PATH (page DOM suite skipped)");
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const pageJsSource = readFileSync(PAGE_JS_PATH, "utf8");
const pageTmp = tempDir("cdb-cs-page-");
writeFileSync(join(pageTmp, "custom_shortcuts_page.js"), pageJsSource, "utf8");

function buildScenarioHtml(scriptBody) {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Custom Shortcuts Test</title></head>
<body>
<div id="root"></div>
<script>
window.__recCalls = [];
window.__diagLines = [];
window.cdbExtra = {
  diag: function (s) { window.__diagLines.push(String(s)); },
  customShortcutsRecording: function (v) { window.__recCalls.push(v === true); return Promise.resolve({ ok: true }); }
};
</script>
<script src="/custom_shortcuts_page.js"></script>
<script>
window.__testOut = null;
(async function () {
  const results = {};
  function tOk(c, name) { results[name] = !!c; }
  ${scriptBody}
  window.__testOut = results;
  const pre = document.createElement("pre");
  pre.id = "__out";
  pre.textContent = JSON.stringify(results);
  document.body.appendChild(pre);
})().catch(function (err) {
  const pre = document.createElement("pre");
  pre.id = "__out";
  pre.textContent = JSON.stringify({ __error: (err && err.stack) || String(err) });
  document.body.appendChild(pre);
});
</script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  if (req.url === "/custom_shortcuts_page.js") {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end(pageJsSource);
    return;
  }
  const f = join(pageTmp, req.url.replace(/^\/+/, ""));
  if (existsSync(f)) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(readFileSync(f));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = "http://127.0.0.1:" + server.address().port;

async function runChromeScenario(name, html, budgetMs = 2500) {
  const file = name + ".html";
  writeFileSync(join(pageTmp, file), html, "utf8");
  const args = [
    "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage",
    "--disable-background-networking", "--disable-sync",
    "--disable-component-update", "--disable-default-apps",
    "--disable-client-side-phishing-detection", "--metrics-recording-only",
    "--window-size=1000,700", "--virtual-time-budget=" + budgetMs, "--dump-dom",
    baseUrl + "/" + file
  ];
  const dom = await new Promise((resolve, reject) => {
    const child = spawn(CHROMIUM, args, { stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error("chromium timed out for scenario " + name));
    }, Math.max(budgetMs + 8000, 12000));
    child.stdout.on("data", (d) => chunks.push(d));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = Buffer.concat(chunks).toString("utf8");
      if (code !== 0 && !out.includes('id="__out"')) {
        reject(new Error("chromium exited " + code + " for scenario " + name));
        return;
      }
      resolve(out);
    });
  });
  const m = /<pre id="__out">([\s\S]*?)<\/pre>/.exec(dom);
  if (!m) throw new Error("scenario " + name + " produced no #__out");
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
}

try {
  // Preflight Chromium
  let chromeOk = false;
  try {
    const pf = await runChromeScenario("preflight", '<!doctype html><html><body><pre id="__out">{"pf":true}</pre></body></html>', 1200);
    chromeOk = !!pf.pf;
  } catch {}
  if (!chromeOk) {
    console.log("  SKIP: headless Chromium failed preflight here");
    server.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }

  // Scenario A: Read Aloud (hydrated completed, ignores streaming, toggles playing, deferred hydrate preserves focus)
  const resA = await runChromeScenario("read-aloud", buildScenarioHtml(`
    const root = document.getElementById("root");
    root.innerHTML = \`
      <textarea id="composer"></textarea>
      <div data-testid="assistant-message" data-is-streaming="false">
        <div data-cds="MessageActions">
          <button id="b1" data-testid="action-bar-read-aloud" data-state="idle">Read aloud</button>
        </div>
      </div>
      <div data-testid="assistant-message" data-is-streaming="true"></div>
    \`;
    let b1Clicks = 0;
    document.getElementById("b1").addEventListener("click", () => { b1Clicks++; document.getElementById("b1").setAttribute("data-state", "playing"); });
    const r1 = await window.__cdbCustomShortcuts.trigger("readAloud");
    tOk(r1.ok && b1Clicks === 1, "readAloud_skips_streaming_clicks_latest_completed");

    // Toggle active playing reply immediately
    const r2 = await window.__cdbCustomShortcuts.trigger("readAloud");
    tOk(r2.ok && r2.detail === "toggled-active:playing" && b1Clicks === 2, "readAloud_toggles_playing_button");

    // Deferred action bar hydration on newer sibling turn preserves focus on #composer
    // and never leaks upward to an older sibling turn's Read Aloud button.
    root.innerHTML = \`
      <textarea id="composer"></textarea>
      <div data-testid="assistant-message" data-is-streaming="false">
        <div data-cds="MessageActions">
          <button id="bOld" data-testid="action-bar-read-aloud" data-state="idle">Read aloud older</button>
        </div>
      </div>
      <div data-testid="assistant-message" data-is-streaming="false">
        <div id="defWrap" data-cds="MessageActions" data-deferred="true">
          <button id="sr" class="sr-only">Show message actions</button>
        </div>
      </div>
    \`;
    const comp = document.getElementById("composer");
    comp.focus();
    let oldClicks = 0, defClicks = 0;
    document.getElementById("bOld").addEventListener("click", () => { oldClicks++; });
    document.getElementById("sr").addEventListener("click", () => {
      document.getElementById("defWrap").innerHTML = '<button id="b2" data-testid="action-bar-read-aloud" data-state="idle">Read aloud</button>';
      document.getElementById("b2").addEventListener("click", () => { defClicks++; });
    });
    const r3 = await window.__cdbCustomShortcuts.trigger("readAloud");
    tOk(r3.ok && r3.detail === "clicked-after-hydrate" && oldClicks === 0 && defClicks === 1 && document.activeElement === comp,
        "readAloud_hydrates_deferred_preserving_focus_no_sibling_leak");
  `), 2500);
  ok(!resA.__error, "Read Aloud headless scenarios ran without error");
  for (const [k, v] of Object.entries(resA)) {
    if (k !== "__error") ok(v === true, "Read Aloud: " + k);
  }

  // Scenario A2: Code tab (epitaxy) - upstream portals the NEWEST turn's message
  // actions out of its assistant-message into [data-testid="transcript-tail-actions"]
  // below the transcript rows, after any turn box / approval / question card in the
  // tail (issue #359). DOM mirrors the live 6.28899.6 Code tab skeleton.
  const resA2 = await runChromeScenario("read-aloud-code-tail", buildScenarioHtml(`
    const root = document.getElementById("root");
    const CARD = '<div data-inline-approval-slot><div data-turn-box><div data-turn-next><p>recap</p>' +
      '<span data-turn-dismiss><button aria-label="Dismiss"></button></span><p>Turn on Auto-fix?</p>' +
      '<div role="group" aria-label="Suggested next actions" data-approval-card-root>' +
      '<button aria-keyshortcuts="Control+Enter">Yes, Auto-fix</button><button>No, I will watch</button></div></div></div></div>';
    function codeTab(opts) {
      root.innerHTML = \`
        <textarea id="composer"></textarea>
        <div data-testid="epitaxy-virtual-transcript"><div role="feed" aria-label="Chat messages">
          <div data-testid="transcript-sizer">
            <div data-testid="transcript-rows">
              <div data-testid="transcript-row" data-perf-row="assistant"><div role="article"><div data-transcript-row>
                <div data-cds="AssistantMessage" data-testid="assistant-message" data-turn-key="msg_old" data-is-streaming="false">
                  <h3>Claude responded</h3><div>older reply</div>
                  <div><div data-cds="MessageActions" data-testid="message-actions">
                    <button aria-label="Copy"></button>
                    <button id="raOld" data-testid="epitaxy-read-aloud" aria-label="Read aloud"></button>
                  </div></div>
                </div></div></div></div>
              <div data-testid="transcript-row" data-perf-row="assistant" data-last-message="true"><div role="article"><div data-transcript-row>
                <div data-cds="AssistantMessage" data-testid="assistant-message" data-turn-key="\${opts.newKey === undefined ? "msg_new" : opts.newKey}" data-is-streaming="\${opts.streaming ? "true" : "false"}">
                  <h3>Claude responded</h3><div>newest reply</div>
                </div></div></div></div>
            </div>
            <div data-testid="transcript-after-rows"><div data-transcript-tail>
              <div data-testid="transcript-trailing-slot" data-transcript-cards>\${opts.trailing || ""}</div>
              <div><div id="tailTurn" data-transcript-tail-turn>
                <div data-testid="transcript-tail-slot">\${opts.card ? CARD : ""}</div>
                <div data-testid="transcript-tail-actions" data-transcript-last-row-controls>
                  <div data-cds="AssistantMessage"><div>\${opts.actions}</div></div>
                </div>
              </div></div>
            </div></div>
          </div>
        </div></div>\`;
    }
    const BAR = '<div data-cds="MessageActions" data-testid="message-actions"><button aria-label="Copy"></button>' +
      '<button id="raNew" data-testid="epitaxy-read-aloud" aria-label="Read aloud"></button></div>';
    // Fake React fibers mirroring the live 6.28899.6 tree: Copy -> ... -> turn renderer {turn:{key}};
    // Read Aloud -> SpeakAction {playing,label} -> {messageUuid: entryId, text} -> {turn:{key}}.
    // opts.stale: the button's chain keeps a stale SpeakAction; only its alternate tracks the DOM.
    function wireNew(opts) {
      const b = document.getElementById("raNew");
      const copy = b.parentElement.querySelector('[aria-label="Copy"]');
      const speak = { memoizedProps: { playing: false, label: "Read aloud" }, alternate: null };
      if (opts && opts.stale) speak.alternate = { memoizedProps: { playing: false, label: "Read aloud" } };
      if (opts) {
        const turnR = { memoizedProps: { turn: { key: opts.turnKey } }, return: null };
        const wrap = { memoizedProps: { messageUuid: opts.entryId, text: () => "x" }, return: turnR };
        speak.return = wrap;
        b.__reactFiber$test = { memoizedProps: { "aria-label": "Read aloud" }, return: speak };
        if (copy) copy.__reactFiber$test = { memoizedProps: { "aria-label": "Copy" }, return: { memoizedProps: { onClick: () => {} }, return: turnR } };
      }
      let clicks = 0;
      b.addEventListener("click", () => {
        clicks++;
        const playing = b.getAttribute("aria-label") !== "Pause";
        const label = playing ? "Pause" : "Resume";
        b.setAttribute("aria-label", label);
        if (opts && opts.stale) speak.alternate.memoizedProps = { playing: playing, label: label };
        else speak.memoizedProps = { playing: playing, label: label };
      });
      return () => clicks;
    }
    const OWN = { turnKey: "msg_new", entryId: "msg_new" };
    function wireOld() {
      let c = 0;
      document.getElementById("raOld").addEventListener("click", () => { c++; });
      return () => c;
    }

    // 1. Tail outlet without a card (every Code tab reply).
    codeTab({ actions: BAR });
    let nNew = wireNew(OWN), nOld = wireOld();
    const r1 = await window.__cdbCustomShortcuts.trigger("readAloud");
    tOk(r1.ok && /^clicked:/.test(r1.detail) && nNew() === 1 && nOld() === 0, "code_tail_outlet_without_card_clicks_newest");

    // 2. Same with the Auto-fix turn box (issue #359 screenshot) and an approval card in the trailing slot.
    codeTab({ actions: BAR, card: true, trailing: '<div data-inline-approval-slot><div data-approval-cluster-host></div></div>' });
    nNew = wireNew(OWN); nOld = wireOld();
    const r2 = await window.__cdbCustomShortcuts.trigger("readAloud");
    tOk(r2.ok && nNew() === 1 && nOld() === 0, "code_tail_outlet_with_turn_box_card_clicks_newest");

    // 3. Second press toggles the playing Code tab button (no data-state; fiber playing + label).
    const st = window.__cdbCustomShortcuts.state();
    const r3 = await window.__cdbCustomShortcuts.trigger("readAloud");
    tOk(st.readAloudPlaying === 1 && r3.ok && r3.detail === "toggled-active:playing" && nNew() === 2 && nOld() === 0,
        "code_tail_outlet_second_press_toggles_playing");

    // 4. No sibling leak: tail outlet owned by another turn (fiber key mismatch) is never clicked,
    //    and the older inline button is never used for the newest reply.
    codeTab({ actions: BAR, card: true });
    nNew = wireNew({ turnKey: "msg_someone_else", entryId: "entry_someone_else" }); nOld = wireOld();
    const r4 = await window.__cdbCustomShortcuts.trigger("readAloud");
    tOk(!r4.ok && r4.reason === "missing-button" && nNew() === 0 && nOld() === 0, "code_tail_outlet_foreign_owner_never_leaks");

    // 5. Without fiber data the outlet belongs to the newest assistant-message only.
    codeTab({ actions: BAR, card: true });
    nNew = wireNew(null); nOld = wireOld();
    const r5 = await window.__cdbCustomShortcuts.trigger("readAloud");
    tOk(r5.ok && nNew() === 1 && nOld() === 0, "code_tail_outlet_dom_rule_newest_only");

    // 6. Streaming newest reply with an empty outlet keeps the streaming rule: falls back to the
    //    latest COMPLETED reply (the older one, whose actions are inline again).
    codeTab({ actions: "", streaming: true });
    nOld = wireOld();
    const r6 = await window.__cdbCustomShortcuts.trigger("readAloud");
    tOk(r6.ok && nOld() === 1, "code_tail_outlet_streaming_rule_kept");

    // 7. Deferred actions inside the outlet hydrate (pointerenter on the tail turn) preserving focus.
    codeTab({ card: true, actions: '<div id="defTail" data-cds="MessageActions" data-testid="message-actions" data-deferred="true"><button id="srT" class="sr-only">Show message actions</button></div>' });
    nOld = wireOld();
    const comp = document.getElementById("composer");
    comp.focus();
    let tailEnter = 0, defClicks = 0;
    document.getElementById("tailTurn").addEventListener("pointerenter", () => { tailEnter++; });
    const srT = document.getElementById("srT");
    srT.__reactFiber$test = { memoizedProps: {}, return: { memoizedProps: { turn: { key: "msg_new" } }, return: null } };
    srT.addEventListener("click", () => {
      document.getElementById("defTail").removeAttribute("data-deferred");
      document.getElementById("defTail").innerHTML = '<button id="raH" data-testid="epitaxy-read-aloud" aria-label="Read aloud"></button>';
      document.getElementById("raH").addEventListener("click", () => { defClicks++; });
    });
    const r7 = await window.__cdbCustomShortcuts.trigger("readAloud");
    tOk(r7.ok && r7.detail === "clicked-after-hydrate" && defClicks === 1 && nOld() === 0 && tailEnter >= 1 &&
        document.activeElement === comp, "code_tail_outlet_deferred_hydrates_no_leak");

    // 8. Ownership by turn.key when the Read Aloud wrapper's messageUuid (entry id) differs.
    codeTab({ actions: BAR, card: true });
    nNew = wireNew({ turnKey: "msg_new", entryId: "entry_1" }); nOld = wireOld();
    const r8 = await window.__cdbCustomShortcuts.trigger("readAloud");
    tOk(r8.ok && nNew() === 1 && nOld() === 0, "code_tail_outlet_owned_by_turn_key_when_entry_id_differs");

    // 9. Both fiber keys foreign -> never clicked.
    codeTab({ actions: BAR, card: true });
    nNew = wireNew({ turnKey: "msg_x", entryId: "entry_x" }); nOld = wireOld();
    const r9 = await window.__cdbCustomShortcuts.trigger("readAloud");
    tOk(!r9.ok && r9.reason === "missing-button" && nNew() === 0 && nOld() === 0, "code_tail_outlet_both_keys_foreign_never_clicked");

    // 10. Known fiber owner but the reply has no data-turn-key -> refuse, no position fallback.
    codeTab({ actions: BAR, newKey: "" });
    nNew = wireNew(OWN); nOld = wireOld();
    const r10 = await window.__cdbCustomShortcuts.trigger("readAloud");
    tOk(!r10.ok && r10.reason === "missing-button" && nNew() === 0 && nOld() === 0, "code_tail_outlet_known_owner_without_turn_key_refuses");

    // 11. Stale current fiber: only the alternate carries {playing:true, label:"Pause"} -> second press toggles.
    codeTab({ actions: BAR });
    nNew = wireNew({ turnKey: "msg_new", entryId: "msg_new", stale: true }); nOld = wireOld();
    const r11a = await window.__cdbCustomShortcuts.trigger("readAloud");
    const r11b = await window.__cdbCustomShortcuts.trigger("readAloud");
    tOk(r11a.ok && r11b.ok && r11b.detail === "toggled-active:playing" && nNew() === 2 && nOld() === 0,
        "code_read_aloud_state_from_alternate_fiber");

    // 12. A general action bar whose fiber has {messageUuid, text: fn, onFork} but no Read Aloud is not a match.
    root.innerHTML = '<div data-testid="assistant-message" data-turn-key="m1" data-is-streaming="false">' +
      '<div data-cds="MessageActions" data-testid="message-actions"><button id="cp" aria-label="Copy"></button>' +
      '<button id="fk" aria-label="Fork from here"></button></div></div>';
    let cpClicks = 0, fkClicks = 0;
    const barFiber = { memoizedProps: { messageUuid: "m1", text: () => "x", onFork: () => {} }, return: null };
    document.getElementById("cp").__reactFiber$test = { memoizedProps: {}, return: barFiber };
    document.getElementById("fk").__reactFiber$test = { memoizedProps: {}, return: barFiber };
    document.getElementById("cp").addEventListener("click", () => { cpClicks++; });
    document.getElementById("fk").addEventListener("click", () => { fkClicks++; });
    const r12 = await window.__cdbCustomShortcuts.trigger("readAloud");
    tOk(!r12.ok && r12.reason === "missing-button" && cpClicks === 0 && fkClicks === 0,
        "read_aloud_fiber_fallback_ignores_general_action_bar");

    // 13. Streaming is per turn: a 2-row streaming turn (only its first row carries data-is-streaming)
    //     after a completed reply -> the completed reply is read, nothing of the streaming turn is clicked.
    const LIVE = '<div data-testid="assistant-message" data-turn-key="msg_live" data-is-streaming="true"><div>item 1</div></div>' +
      '<div data-testid="assistant-message" data-turn-key="msg_live"><div>item 2</div>' +
      '<div data-cds="MessageActions"><button id="liveCopy" aria-label="Copy"></button></div></div>';
    root.innerHTML = '<div data-testid="epitaxy-virtual-transcript"><div role="feed">' +
      '<div data-testid="assistant-message" data-turn-key="msg_old" data-is-streaming="false">' +
      '<div data-cds="MessageActions" data-testid="message-actions"><button id="raOld2" data-testid="epitaxy-read-aloud" aria-label="Read aloud"></button></div></div>' +
      LIVE + '<div data-testid="transcript-tail-actions" data-transcript-last-row-controls></div></div></div>';
    let old2 = 0, liveCopy = 0;
    document.getElementById("raOld2").addEventListener("click", () => { old2++; });
    document.getElementById("liveCopy").addEventListener("click", () => { liveCopy++; });
    const r13 = await window.__cdbCustomShortcuts.trigger("readAloud");
    tOk(r13.ok && old2 === 1 && liveCopy === 0, "streaming_multi_row_turn_falls_back_to_previous_reply");

    // 14. Only the streaming multi-row turn -> "Wait for Claude to finish responding".
    root.innerHTML = '<div data-testid="epitaxy-virtual-transcript"><div role="feed">' + LIVE + '</div></div>';
    liveCopy = 0;
    document.getElementById("liveCopy").addEventListener("click", () => { liveCopy++; });
    const r14 = await window.__cdbCustomShortcuts.trigger("readAloud");
    tOk(!r14.ok && r14.reason === "streaming" && liveCopy === 0, "streaming_multi_row_turn_only_waits");
  `), 3000);
  ok(!resA2.__error, "Read Aloud Code tab scenarios ran without error", resA2.__error);
  for (const [k, v] of Object.entries(resA2)) {
    if (k !== "__error") ok(v === true, "Read Aloud (Code tab): " + k);
  }

  // Scenario B: Voice Mode (OR direct, qR active fiber onEnd, xR Phone item, /code guard, Settings close, recorder focusin)
  const resB = await runChromeScenario("voice-mode", buildScenarioHtml(`
    const root = document.getElementById("root");
    root.innerHTML = \`
      <div role="dialog"><div class="cdbx-item"></div><button id="closeDlg" aria-label="Close"></button></div>
      <button id="vbtn" aria-label="Use voice mode" style="width:40px;height:40px;">Voice</button>
    \`;
    let dlgClosed = 0, vClicks = 0;
    document.getElementById("closeDlg").addEventListener("click", () => { dlgClosed++; document.querySelector('[role="dialog"]').remove(); });
    document.getElementById("vbtn").addEventListener("click", () => { vClicks++; });
    const r1 = await window.__cdbCustomShortcuts.trigger("voiceMode");
    tOk(r1.ok && r1.detail === "started" && dlgClosed === 1 && vClicks === 1, "voiceMode_closes_settings_and_clicks_OR");

    // Active qR voice bar stops via fiber onEnd
    root.innerHTML = '<button id="stopVoice" style="width:60px;height:32px;">Stop</button>';
    const sb = document.getElementById("stopVoice");
    let ended = 0;
    sb.__reactFiber$test = { return: { memoizedProps: { state: "active", onEnd: () => { ended++; } }, return: null } };
    const r2 = await window.__cdbCustomShortcuts.trigger("voiceMode");
    tOk(r2.ok && r2.detail === "stopped" && ended === 1, "voiceMode_stops_active_qR_fiber");

    // xR split button carrying Phone menu item triggers handleStartVoice
    root.innerHTML = '<button id="micSplit" style="width:36px;height:36px;">Mic</button>';
    const ms = document.getElementById("micSplit");
    let phoneStarted = 0;
    ms.__reactFiber$test = {
      return: {
        memoizedProps: {
          onPrimaryClick: () => {},
          items: [{ props: { icon: "Phone", onClick: () => { phoneStarted++; } } }]
        },
        return: null
      }
    };
    const r3 = await window.__cdbCustomShortcuts.trigger("voiceMode");
    tOk(r3.ok && r3.detail === "started" && phoneStarted === 1, "voiceMode_starts_from_xR_Phone_item");

    // Unsupported /code route refuses gracefully with toast notice
    history.pushState({}, "", "/code/session-1");
    root.innerHTML = '<button id="vbtn2" aria-label="Use voice mode" style="width:40px;height:40px;">Voice</button>';
    const r4 = await window.__cdbCustomShortcuts.trigger("voiceMode");
    tOk(!r4.ok && r4.reason === "unsupported-route" && !!document.querySelector(".cdb-sc-toast"),
        "voiceMode_refuses_on_code_route_with_toast");

    // Recording input focusin / focusout notifies cdbExtra
    history.pushState({}, "", "/chat/1");
    const recEl = document.createElement("div");
    recEl.setAttribute("tabindex", "0");
    recEl.setAttribute("data-keyboard-shortcut-input", "");
    document.body.appendChild(recEl);
    recEl.focus();
    await new Promise((r) => setTimeout(r, 20));
    recEl.blur();
    await new Promise((r) => setTimeout(r, 20));
    tOk(window.__recCalls[0] === true && window.__recCalls[1] === false,
        "recorder_focusin_focusout_syncs_recording_flag");
  `), 2500);
  ok(!resB.__error, "Voice Mode headless scenarios ran without error");
  for (const [k, v] of Object.entries(resB)) {
    if (k !== "__error") ok(v === true, "Voice Mode: " + k);
  }

  // Scenario C: newVoiceChat navigation + ER 400ms mistap settle + retry
  const resC = await runChromeScenario("new-voice-chat", buildScenarioHtml(`
    history.pushState({}, "", "/chat/existing");
    const root = document.getElementById("root");
    root.innerHTML = '<a id="newLink" href="/new" style="display:inline-block;width:60px;height:20px;">New chat</a>';
    let mistapActive = true;
    let startAttempts = 0;
    document.getElementById("newLink").addEventListener("click", (e) => {
      e.preventDefault();
      history.pushState({}, "", "/new");
      root.innerHTML = '<button id="vbtn" aria-label="Use voice mode" style="width:40px;height:40px;">Voice</button>';
      document.getElementById("vbtn").addEventListener("click", () => {
        startAttempts++;
        if (!mistapActive) {
          root.innerHTML = '<div id="bar"><button id="stop" style="width:40px;height:30px;">Stop</button><button aria-label="Turn off microphone"></button></div>';
        }
      });
      setTimeout(() => { mistapActive = false; }, 120);
    });
    const r = await window.__cdbCustomShortcuts.trigger("newVoiceChat", { navigatedByMain: false });
    tOk(r.ok && location.pathname === "/new" && startAttempts >= 1 && !!document.getElementById("stop"),
        "newVoiceChat_navigates_and_retries_after_mistap_settle");
  `), 3000);
  ok(!resC.__error, "New Voice Chat headless scenario ran without error");
  for (const [k, v] of Object.entries(resC)) {
    if (k !== "__error") ok(v === true, "New Voice Chat: " + k);
  }

  // Scenario D: Send Now (primary testid on /code preserving composer focus, newest visible,
  // busy/disabled guards without fallback leak, fiber fallback without clicking sibling Remove,
  // label fallback with "Send N now" + <kbd> ignoring Settings dialog, and empty state)
  const resD = await runChromeScenario("send-now", buildScenarioHtml(`
    history.pushState({}, "", "/code/session-42");
    const root = document.getElementById("root");
    root.innerHTML = \`
      <textarea id="composer"></textarea>
      <button id="hiddenSn" data-testid="awaiting-turn-send-now" style="display:none;width:80px;height:24px;">Send now</button>
      <button id="oldSn" data-testid="awaiting-turn-send-now" style="width:80px;height:24px;">Send now</button>
      <button id="newSn" data-testid="awaiting-turn-send-now" style="width:80px;height:24px;">Send 2 now</button>
    \`;
    const comp = document.getElementById("composer");
    comp.focus();
    let hiddenClicks = 0, oldClicks = 0, newClicks = 0;
    document.getElementById("hiddenSn").addEventListener("click", () => { hiddenClicks++; });
    document.getElementById("oldSn").addEventListener("click", () => { oldClicks++; });
    document.getElementById("newSn").addEventListener("click", () => { newClicks++; });
    const stBefore = window.__cdbCustomShortcuts.state();
    const r1 = await window.__cdbCustomShortcuts.trigger("sendNow");
    tOk(stBefore.sendNowButtons === 3 && stBefore.sendNowAvailable === true &&
        r1.ok && r1.detail === "clicked:testid" &&
        hiddenClicks === 0 && oldClicks === 0 && newClicks === 1 &&
        document.activeElement === comp,
        "sendNow_clicks_newest_visible_testid_preserving_composer_focus");

    // Busy button refuses cleanly without double-clicking or falling through to unrelated buttons
    root.innerHTML = \`
      <button id="busySn" data-testid="awaiting-turn-send-now" aria-busy="true" disabled style="width:80px;height:24px;">Send now</button>
      <button id="otherSn" style="width:80px;height:24px;">Send now</button>
    \`;
    let busyClicks = 0, otherClicks = 0;
    document.getElementById("busySn").addEventListener("click", () => { busyClicks++; });
    document.getElementById("otherSn").addEventListener("click", () => { otherClicks++; });
    const r2 = await window.__cdbCustomShortcuts.trigger("sendNow");
    tOk(!r2.ok && r2.reason === "busy" && busyClicks === 0 && otherClicks === 0 &&
        !!document.querySelector(".cdb-sc-toast"),
        "sendNow_reports_busy_without_double_click_or_fallback_leak");

    // Fiber fallback when data-testid moved: skips sibling Remove button sharing parent onSendNow fiber
    root.innerHTML = \`
      <button id="snFiber" data-press-renders-now="true" style="width:80px;height:24px;">Jetzt senden</button>
      <button id="removeSibling" aria-label="Remove queued message" style="width:24px;height:24px;">X</button>
    \`;
    const snFiber = document.getElementById("snFiber");
    const remBtn = document.getElementById("removeSibling");
    const sharedParentFiber = { memoizedProps: { onSendNow: () => {} }, return: null };
    snFiber.__reactFiber$test = { return: sharedParentFiber };
    remBtn.__reactFiber$test = { return: sharedParentFiber };
    let fiberClicks = 0, remClicks = 0;
    snFiber.addEventListener("click", () => { fiberClicks++; });
    remBtn.addEventListener("click", () => { remClicks++; });
    const r3 = await window.__cdbCustomShortcuts.trigger("sendNow");
    tOk(r3.ok && r3.detail === "clicked:fiber" && fiberClicks === 1 && remClicks === 0 &&
        window.__diagLines.some((l) => l.includes("send-now-fiber-fallback")),
        "sendNow_fiber_fallback_requires_marker_and_never_clicks_sibling_remove");

    // Label fallback handles "Send 3 now" + <kbd> shortcut hint and ignores Settings dialog buttons
    root.innerHTML = \`
      <div role="dialog"><div class="cdbx-item"></div><button id="dlgSn" style="width:80px;height:24px;">Send now</button></div>
      <button id="lblSn" style="width:120px;height:24px;">Send 3 now<kbd>Ctrl+↵</kbd></button>
    \`;
    let dlgClicks = 0, lblClicks = 0;
    document.getElementById("dlgSn").addEventListener("click", () => { dlgClicks++; });
    document.getElementById("lblSn").addEventListener("click", () => { lblClicks++; });
    const r4 = await window.__cdbCustomShortcuts.trigger("sendNow");
    tOk(r4.ok && r4.detail === "clicked:label" && dlgClicks === 0 && lblClicks === 1 &&
        window.__diagLines.some((l) => l.includes("send-now-label-fallback")),
        "sendNow_label_fallback_strips_kbd_and_ignores_settings_dialog");

    // Empty state shows toast and returns no-queued-message
    root.innerHTML = '<div>No queued messages</div>';
    const r5 = await window.__cdbCustomShortcuts.trigger("sendNow");
    tOk(!r5.ok && r5.reason === "no-queued-message" && !window.__cdbCustomShortcuts.state().sendNowAvailable,
        "sendNow_reports_no_queued_message_when_absent");
  `), 2500);
  ok(!resD.__error, "Send Now headless scenarios ran without error");
  for (const [k, v] of Object.entries(resD)) {
    if (k !== "__error") ok(v === true, "Send Now: " + k);
  }
} finally {
  server.close();
  for (const d of cleanupDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
