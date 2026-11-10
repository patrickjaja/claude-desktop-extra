#!/usr/bin/env node
// Quick Entry app_id: the previous desktop name is restored right after the
// Quick Entry window is constructed.
//
// WHY THIS EXISTS
// ---------------
// patches/linux/fix_quick_entry_app_id.nim gives the Quick Entry window its
// own Wayland app_id / X11 WM_CLASS (`claude-quick-entry`) by switching
// CHROME_DESKTOP (+ app.setDesktopName) while its BrowserWindow is
// constructed. An earlier version switched it back in the window's
// `ready-to-show` handler, which never fires for the transparent Quick Entry
// window on native Wayland: every window created afterwards inherited
// `claude-quick-entry`, in every profile. The fix restores exactly the value
// that was active before (the package.json name, or a per-profile name set at
// startup) as soon as the constructor returns, also when it throws.
//
// This harness runs the compiled patch on a fixture with the upstream shape of
// the Quick Entry constructor site (`X||(X=new E.BrowserWindow({titleBarStyle:
// "hidden",...}),X.loadFile(...),...)`), checks marker / idempotency / legacy
// rejection / syntax, then EXECUTES the patched snippet in a vm with a fake
// Electron whose BrowserWindow records the desktop name it was constructed
// with and never emits `ready-to-show` (native Wayland behaviour).
//
// QE_PATCH_BIN=<binary> runs the same checks against another build of the
// patch (used to prove the harness fails on the ready-to-show version).
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import { readFileSync, writeFileSync, mkdtempSync, rmSync, accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PATCH_BIN = process.env.QE_PATCH_BIN || join(ROOT, "patches", "linux", "fix_quick_entry_app_id");
const SKIP_EXIT = 3;
const QE = "claude-quick-entry.desktop";

let pass = 0;
const failures = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  PASS ${label} -> ${JSON.stringify(actual)}`);
    pass++;
    return;
  }
  console.log(`  FAIL ${label} -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  failures.push(label);
}
const section = (t) => console.log("\n" + t);

try {
  accessSync(PATCH_BIN, constants.X_OK);
} catch {
  console.log(`SKIP: patch binary not compiled: ${PATCH_BIN} (cd patches && make)`);
  process.exit(SKIP_EXIT);
}

// Upstream shape (v4.23118.1, names as minified there): the lazily evaluated
// constructor chain inside the Quick Entry show function. `__val` captures the
// value of the `X||(...)` expression so a change to it or to the short-circuit
// is visible.
const FIXTURE = [
  `"use strict";`,
  `var WY=null,AEi=null;`,
  `globalThis.__qeShow=function(){`,
  `globalThis.__val=(WY||(WY=new u.BrowserWindow({titleBarStyle:"hidden",skipTaskbar:!0,transparent:!0,frame:!1,`,
  `show:!1,width:606,height:470,webPreferences:{preload:n.default.join(u.app.getAppPath(),".vite/build/quickWindow.js"),`,
  `additionalArguments:[qJ()]}}),WY.loadFile(n.default.join(u.app.getAppPath(),".vite/renderer/quick_window/quick-window.html")),`,
  `WY.on("closed",(()=>{WY=null})),WY.on("ready-to-show",(()=>{})),AEi="chain-end"));`,
  `return WY};`,
  `globalThis.__plainWindow=function(){return new u.BrowserWindow({width:10})};`,
].join("");

function makeEnv(prior) {
  const env = {};
  if (prior !== undefined) env.CHROME_DESKTOP = prior;
  const log = { constructedWith: [], setDesktopName: [], diag: [] };
  let throwNext = false;
  let throwOnRestore = false;
  class FakeBrowserWindow {
    constructor(opts) {
      log.constructedWith.push(env.CHROME_DESKTOP);
      if (throwNext) {
        throwNext = false;
        throw new Error("ctor boom");
      }
      this.opts = opts;
      this.handlers = {};
    }
    loadFile() {}
    on(ev, fn) { (this.handlers[ev] ||= []).push(fn); return this; }
    // Native Wayland: ready-to-show never fires for the transparent window.
    once(ev, fn) { return this.on(ev, fn); }
  }
  const app = {
    getAppPath: () => "/opt/app",
    // Electron's setDesktopName writes CHROME_DESKTOP (browser_linux.cc).
    setDesktopName(name) {
      log.setDesktopName.push(name);
      if (throwOnRestore && name !== "claude-quick-entry.desktop") throw new Error("setDesktopName boom");
      env.CHROME_DESKTOP = name;
    },
  };
  const ctx = {
    u: { BrowserWindow: FakeBrowserWindow, app },
    n: { default: { join: (...p) => p.join("/") } },
    qJ: () => "--x",
    process: { env, platform: "linux" },
    require: () => ({ desktopName: "com.anthropic.Claude" }),
    console: { log: () => {} },
    __cdbDiag: (m) => log.diag.push(String(m)),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  return { ctx, env, log, FakeBrowserWindow, armThrow: () => { throwNext = true; }, armRestoreThrow: () => { throwOnRestore = true; } };
}

const work = mkdtempSync(join(tmpdir(), "cdb-qe-appid-"));
try {
  section("patch application");
  const fixture = join(work, "index.js");
  writeFileSync(fixture, FIXTURE);
  const run = (f = fixture) => spawnSync(PATCH_BIN, [f], { encoding: "utf8" });
  let r = run();
  check("first run exits 0", r.status, 0);
  const patched = readFileSync(fixture, "utf8");
  check("restore marker present once", patched.split("__cdbQePrevDesktop=process.env.CHROME_DESKTOP").length - 1, 1);
  check("ready-to-show reset gone", /once\(\s*["`]ready-to-show/.test(patched), false);
  check("no package.json read", patched.includes("package.json"), false);
  check("no profile-suffix logic", patched.includes("CLAUDE_PROFILE"), false);
  let syntaxOk = true;
  try { new vm.Script(patched); } catch { syntaxOk = false; }
  check("patched fixture parses", syntaxOk, true);
  r = run();
  check("second run exits 0", r.status, 0);
  check("second run is a no-op", readFileSync(fixture, "utf8") === patched, true);
  check("second run reports idempotent", /already present/.test(r.stdout), true);

  const legacy = join(work, "legacy.js");
  writeFileSync(legacy, FIXTURE + `;try{}catch(__qeAppIdReadErr){}`);
  check("legacy ready-to-show shape rejected", run(legacy).status, 1);
  const noAnchor = join(work, "noanchor.js");
  writeFileSync(noAnchor, `var WY=null;WY||(WY=new u.BrowserWindow({width:1}));`);
  check("missing anchor fails", run(noAnchor).status, 1);

  // Pristine run for value comparison.
  const pristine = makeEnv("com.anthropic.Claude.desktop");
  vm.runInContext(FIXTURE, pristine.ctx);
  pristine.ctx.__qeShow();
  const pristineVal1 = pristine.ctx.__val;
  pristine.ctx.__qeShow();
  const pristineVal2IsWin = pristine.ctx.__val instanceof pristine.FakeBrowserWindow;

  for (const prior of ["com.anthropic.Claude.desktop", "com.anthropic.Claude-foo.desktop"]) {
    section(`behaviour, prior CHROME_DESKTOP = ${prior}`);
    const t = makeEnv(prior);
    vm.runInContext(patched, t.ctx);
    const win = t.ctx.__qeShow();
    check("Quick Entry constructed with claude-quick-entry", t.log.constructedWith, [QE]);
    check("setDesktopName switched then restored", t.log.setDesktopName, [QE, prior]);
    check("CHROME_DESKTOP restored after constructor", t.env.CHROME_DESKTOP, prior);
    check("window is the real BrowserWindow", win instanceof t.FakeBrowserWindow, true);
    check("options passed through", win.opts.titleBarStyle, "hidden");
    check("expression value unchanged", t.ctx.__val, pristineVal1);
    t.ctx.__plainWindow();
    check("later window gets the prior id", t.log.constructedWith[1], prior);
    const again = t.ctx.__qeShow();
    check("second call does not re-create", t.log.constructedWith.length, 2);
    check("second call returns the same window", again === win, true);
    check("short-circuit value is the window", t.ctx.__val instanceof t.FakeBrowserWindow, pristineVal2IsWin);
    check("CHROME_DESKTOP still prior", t.env.CHROME_DESKTOP, prior);
  }

  section("behaviour, constructor throws");
  {
    const t = makeEnv("com.anthropic.Claude-foo.desktop");
    vm.runInContext(patched, t.ctx);
    t.armThrow();
    let threw = null;
    try { t.ctx.__qeShow(); } catch (e) { threw = e.message; }
    check("constructor error propagates", threw, "ctor boom");
    check("CHROME_DESKTOP restored after throw", t.env.CHROME_DESKTOP, "com.anthropic.Claude-foo.desktop");
    check("window var stays null", vm.runInContext("WY", t.ctx), null);
    t.ctx.__qeShow();
    check("next call constructs again with claude-quick-entry", t.log.constructedWith, [QE, QE]);
    check("CHROME_DESKTOP restored after retry", t.env.CHROME_DESKTOP, "com.anthropic.Claude-foo.desktop");
  }

  section("behaviour, setDesktopName throws during restore");
  {
    const t = makeEnv("com.anthropic.Claude-foo.desktop");
    vm.runInContext(patched, t.ctx);
    t.armRestoreThrow();
    let threw = null;
    let win = null;
    try { win = t.ctx.__qeShow(); } catch (e) { threw = e.message; }
    check("restore error does not escape", threw, null);
    check("window still created", win instanceof t.FakeBrowserWindow, true);
    check("CHROME_DESKTOP at prior value", t.env.CHROME_DESKTOP, "com.anthropic.Claude-foo.desktop");
    check("restore failure logged", t.log.diag.some((l) => l.includes("app_id restore failed")), true);
  }

  section("behaviour, CHROME_DESKTOP unset before");
  {
    const t = makeEnv(undefined);
    vm.runInContext(patched, t.ctx);
    t.ctx.__qeShow();
    check("Quick Entry constructed with claude-quick-entry", t.log.constructedWith, [QE]);
    check("CHROME_DESKTOP unset again", Object.prototype.hasOwnProperty.call(t.env, "CHROME_DESKTOP"), false);
    check("setDesktopName not called with a missing value", t.log.setDesktopName, [QE]);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("FAILED: " + failures.join("; "));
  process.exit(1);
}
console.log("PASS");
