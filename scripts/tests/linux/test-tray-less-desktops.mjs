#!/usr/bin/env node
// Tray-less desktops: a hidden (--startup) launch needs a tray host.
//
// WHY THIS EXISTS
// ---------------
// A `--startup` (autostart) launch creates the main window hidden and relies
// on the tray icon to bring it back. On a Wayland session without an
// org.kde.StatusNotifierWatcher on the session bus (vanilla GNOME without the
// AppIndicator extension, sway/niri without a tray-capable bar) Electron's
// Tray has nowhere to go, so an autostart launch shows nothing at all.
// (Closing the window on such a desktop is upstream's own business: its close
// handler quits when no tray icon is shown, and the patch leaves it alone.)
//
// patches/linux/fix_tray_less_desktops.nim injects js/tray_host_probe.js:
//
//   - a watcher on the bus (or any doubt)  -> upstream behavior, unchanged
//   - Wayland and NO watcher               -> a hidden launch shows the window
//   - X11 and no watcher                   -> unchanged: Electron falls back to
//     an XEmbed GtkStatusIcon there, which an XEmbed tray can host, and we
//     cannot see that tray from the bus
//   - a hidden launch with the tray switched off in settings -> shown, since
//     no tray icon exists in that case either
//
// Part [A] pins that truth table against the real module source with
// child_process/process shimmed. Part [B] runs the compiled patch on the
// upstream shapes (copied from the 2.26454.0 bundle) and drives the patched
// window creation and the (untouched) upstream close handler.
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  accessSync,
  constants,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PATCH_BIN = join(ROOT, "patches", "linux", "fix_tray_less_desktops");
const MODULE_SRC = readFileSync(join(ROOT, "js", "tray_host_probe.js"), "utf8");
const SKIP_EXIT = 3;

let pass = 0;
const failures = [];
function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS ${label} -> ${JSON.stringify(actual)}`);
    pass++;
    return;
  }
  console.log(
    `  FAIL ${label} -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`
  );
  failures.push(label);
}
const section = (t) => console.log("\n" + t);
const tick = () => new Promise((r) => setTimeout(r, 40));

// ---------------------------------------------------------------- shims
// `bus` maps a tool name to what it does: "true"/"false" = answers
// NameHasOwner, "enoent" = not installed, "fail" = installed but cannot reach
// the bus. Replies are the real output formats of each tool.
const REPLIES = {
  busctl: { true: "b true\n", false: "b false\n" },
  "dbus-send": {
    true: 'method return time=1 sender=org.freedesktop.DBus -> destination=:1.9 serial=3 reply_serial=2\n   boolean true\n',
    false: 'method return time=1 sender=org.freedesktop.DBus -> destination=:1.9 serial=3 reply_serial=2\n   boolean false\n',
  },
  gdbus: { true: "(true,)\n", false: "(false,)\n" },
};

function makeEnv({ bus = {}, env = {} }) {
  const calls = [];
  const diag = [];
  const cp = {
    execFile(bin, args, opts, cb) {
      calls.push({ bin, args });
      const mode = bus[bin] || "enoent";
      setTimeout(() => {
        if (mode === "enoent") {
          const e = new Error("spawn " + bin + " ENOENT");
          e.code = "ENOENT";
          cb(e, "", "");
        } else if (mode === "fail") {
          const e = new Error("Command failed: " + bin);
          e.code = 1;
          cb(e, "", "Failed to connect to bus");
        } else {
          cb(null, REPLIES[bin][mode], "");
        }
      }, 1);
    },
    execFileSync() {
      throw new Error("the probe must never block the main process");
    },
    spawnSync() {
      throw new Error("the probe must never block the main process");
    },
  };
  const require = (n) => {
    if (n === "child_process") return cp;
    throw new Error("unexpected require: " + n);
  };
  const g = { __cdbDiag: (s) => diag.push(s) };
  const proc = { platform: "linux", env };
  return { require, process: proc, globalThis: g, calls, diag };
}

function loadModule(ctx) {
  const fn = new Function(
    "require",
    "process",
    "globalThis",
    "setTimeout",
    `return (${MODULE_SRC});`
  );
  return fn(ctx.require, ctx.process, ctx.globalThis, setTimeout);
}

const WAYLAND = { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" };
const X11 = { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" };

async function partA() {
  section("[A1] Wayland WITH a StatusNotifierWatcher: upstream behavior");
  {
    const ctx = makeEnv({ bus: { busctl: "true" }, env: WAYLAND });
    const m = loadModule(ctx);
    check("before the probe settles, state is pending", m.state(), "pending");
    check("no close-handler hook is exported (upstream owns close)", "quitOnClose" in m, false);
    let shown = 0;
    m.startup(false, () => shown++, () => true);
    await tick();
    check("hidden --startup launch stays hidden", shown, 0);
    check("state is present", m.state(), "present");
    check("first probe is busctl", ctx.calls[0].bin, "busctl");
    check(
      "probe asks NameHasOwner for the watcher",
      ctx.calls[0].args.includes("NameHasOwner") &&
        ctx.calls[0].args.includes("org.kde.StatusNotifierWatcher"),
      true
    );
    check(
      "no absolute tool paths",
      ctx.calls.every((c) => !c.bin.includes("/")),
      true
    );
  }

  section("[A2] Wayland WITHOUT a watcher: hidden launch shows");
  {
    const ctx = makeEnv({ bus: { busctl: "false" }, env: WAYLAND });
    const m = loadModule(ctx);
    let shown = 0;
    m.startup(false, () => shown++, () => true);
    await tick();
    check("state is absent", m.state(), "absent");
    check("hidden --startup launch is shown once", shown, 1);
    check(
      "decision is logged via __cdbDiag",
      ctx.diag.some((l) => /\[tray-host\]/.test(l) && /absent/.test(l)),
      true
    );
    check(
      "the show is logged",
      ctx.diag.some((l) => /showing the main window/.test(l)),
      true
    );
  }
  {
    const ctx = makeEnv({ bus: { busctl: "false" }, env: WAYLAND });
    const m = loadModule(ctx);
    let shown = 0;
    m.startup(true, () => shown++, () => true);
    await tick();
    check("a visible launch is never re-shown", shown, 0);
  }

  section("[A3] tool fallback order busctl -> dbus-send -> gdbus");
  {
    const ctx = makeEnv({ bus: { busctl: "enoent", "dbus-send": "false" }, env: WAYLAND });
    const m = loadModule(ctx);
    m.startup(true, () => {}, () => true);
    await tick();
    check("dbus-send answers when busctl is missing", m.state(), "absent");
    check("order", ctx.calls.map((c) => c.bin).join(","), "busctl,dbus-send");
  }
  {
    const ctx = makeEnv({
      bus: { busctl: "fail", "dbus-send": "enoent", gdbus: "true" },
      env: WAYLAND,
    });
    const m = loadModule(ctx);
    m.startup(true, () => {}, () => true);
    await tick();
    check("gdbus answers when busctl cannot reach the bus", m.state(), "present");
    check("order", ctx.calls.map((c) => c.bin).join(","), "busctl,dbus-send,gdbus");
  }
  {
    const ctx = makeEnv({ bus: {}, env: WAYLAND });
    const m = loadModule(ctx);
    let shown = 0;
    m.startup(false, () => shown++, () => true);
    await tick();
    check("no tool at all -> unknown", m.state(), "unknown");
    check("unknown keeps a hidden launch hidden", shown, 0);
  }

  section("[A4] X11 without a watcher: unchanged (XEmbed fallback)");
  {
    const ctx = makeEnv({ bus: { busctl: "false" }, env: X11 });
    const m = loadModule(ctx);
    let shown = 0;
    m.startup(false, () => shown++, () => true);
    await tick();
    check("X11 state is absent", m.state(), "absent");
    check("X11 hidden launch stays hidden", shown, 0);
  }

  section("[A5] hidden launch with the tray switched off in settings");
  {
    const ctx = makeEnv({ bus: { busctl: "true" }, env: WAYLAND });
    const m = loadModule(ctx);
    let shown = 0;
    m.startup(false, () => shown++, () => false);
    await tick();
    check("shown even with a watcher present", shown, 1);
  }

  section("[A6] one probe per process");
  {
    const ctx = makeEnv({ bus: { busctl: "false" }, env: WAYLAND });
    const a = loadModule(ctx);
    const b = loadModule(ctx);
    await tick();
    check("second evaluation reuses the first instance", a === b, true);
    check("busctl ran once", ctx.calls.filter((c) => c.bin === "busctl").length, 1);
  }
}

// ---------------------------------------------------------------- part B
// The upstream shapes the patch targets, copied from the 2.26454.0 bundle
// (index.chunk-*.js, main window creation `ULa`, tray-host check `Yfr`).
// Identifiers are upstream's; the patch captures them by wildcard. Upstream
// code between the sites is trimmed, but the three sites are verbatim:
//   1. `show:i&&!0,backgroundColor:` in the BrowserWindow options
//   2. `_ma(l,{showMainWindow:ZJ})` right after the deferred-show setup
//   3. the close handler's "tray is disabled" branch (read-only anchor for
//      the settings reader) followed by upstream's own no-tray-host quit
// `__yfr` stands in for upstream's own tray-host verdict (Yfr).
const FIXTURE = `"use strict";
var ko;function $v(k){return __cfg[k]}function $A(){return!1}function QA(){__ev.push("quit")}function eqr(){__ev.push("quit-no-tray")}function ibi(){}function A8(){}function HF(){return"#000"}var P={info:s=>__ev.push("info:"+s)};
async function Yfr(){return __yfr}
function hCe(e){return ko=__makeWin(e),ko}function Lo(){__ev.push("Lo")}function _ma(l,o){}function mCe(){}
function ZJ(){let e=ko;!e||e.isDestroyed()||(e.isMinimized()?(e.restore(),e.focus()):e.isVisible()?e.focus():(Lo(),e.show()))}
var ULa=e=>{let r=!1,i=(__notStartup()||!1)&&!r;let l=hCe({x:e.x,y:e.y,width:e.width,height:e.height,minWidth:600,minHeight:400,titleBarStyle:"hidden",titleBarOverlay:!0,show:i&&!0,backgroundColor:HF(),opacity:1});let d=()=>{},f=!1;i?d():f=!0,f&&mCe(l,(()=>{f=!1,d()})),_ma(l,{showMainWindow:ZJ});l.on("close",(e=>{if($A())return;if(!$v("menuBarEnabled")){P.info("Quitting app on main window close since tray is disabled"),QA();return}e.preventDefault();let t=()=>{ibi(),A8(l,!0),l.hide()},n=()=>{l.isFullScreen()?(l.once("leave-full-screen",t),l.setFullScreen(!1)):t()};Yfr().then((e=>{l.isDestroyed()||(e.status==="unsupported"?(P.info("Quitting app on main window close since this desktop shows no tray icon"),eqr()):n())}))}))};
`;
const CLOSE_SITE = FIXTURE.slice(FIXTURE.indexOf('l.on("close"'));

function runPatch(file) {
  try {
    const out = execFileSync(PATCH_BIN, [file], { encoding: "utf8", stdio: "pipe" });
    return { status: 0, out };
  } catch (e) {
    return {
      status: typeof e.status === "number" ? e.status : -1,
      out: String(e.stdout || "") + String(e.stderr || ""),
    };
  }
}

function makeWin(opts, ev) {
  const handlers = {};
  const w = {
    visible: !!opts.show,
    on(n, f) { (handlers[n] ||= []).push(f); },
    once(n, f) { (handlers[n] ||= []).push(f); },
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => w.visible,
    isFullScreen: () => false,
    focus: () => ev.push("focus"),
    restore: () => {},
    show: () => { w.visible = true; ev.push("show"); },
    hide: () => { w.visible = false; ev.push("hide"); },
    close() {
      let prevented = false;
      for (const f of handlers.close || []) f({ preventDefault: () => { prevented = true; } });
      ev.push(prevented ? "close-prevented" : "close-allowed");
    },
  };
  return w;
}

async function drive(src, { bus, env, startup, menuBarEnabled = true, trayHost = "supported" }) {
  const ctx = makeEnv({ bus, env });
  const ev = [];
  const sandbox = {
    require: ctx.require,
    process: ctx.process,
    __cdbDiag: (s) => ctx.diag.push(s),
    __cfg: { menuBarEnabled },
    __yfr: { status: trayHost },
    __ev: ev,
    __notStartup: () => !startup,
    __makeWin: (o) => makeWin(o, ev),
    setTimeout,
    console,
  };
  vm.runInNewContext(src + "\n;ULa({x:0,y:0,width:800,height:600});", vm.createContext(sandbox));
  await tick();
  const win = sandbox.ko;
  const shownAfterLaunch = win.visible;
  win.visible = true;
  win.close();
  await tick();
  return { ev, shownAfterLaunch, diag: ctx.diag };
}

async function partB() {
  const scratch = mkdtempSync(join(tmpdir(), "cdb-tray-less-"));
  try {
    section("[B0] the compiled patch applies to the upstream shapes");
    const file = join(scratch, "index.js");
    writeFileSync(file, FIXTURE);
    const r1 = runPatch(file);
    check("first run exits 0", r1.status, 0);
    check("no [FAIL] line", /\[FAIL\]/.test(r1.out), false);
    const patched = readFileSync(file, "utf8");
    check("patched output changed", patched !== FIXTURE, true);
    execFileSync("node", ["--check", file]);
    check("patched fixture passes node --check", true, true);

    section("[B1] idempotency: a second run changes nothing and exits 0");
    const r2 = runPatch(file);
    check("second run exits 0", r2.status, 0);
    check("second run leaves the file byte-identical", readFileSync(file, "utf8"), patched);

    section("[B2] only the startup hook is injected; upstream close is untouched");
    check("patched output keeps upstream's close handler verbatim", patched.includes(CLOSE_SITE), true);
    check("no old close-handler injection (quitOnClose)", patched.includes("quitOnClose"), false);
    check("no old close-handler injection (||marker)", patched.includes("||/*__cdb_tray_host_v1__*/"), false);
    check("exactly one injection marker", patched.split("/*__cdb_tray_host_v1__*/").length - 1, 1);

    section("[B3] broken inputs fail loud");
    {
      const dup = join(scratch, "dup.js");
      const reg = "{showMainWindow:ZJ})";
      const hs = patched.indexOf(reg) + reg.length;
      const tail = '("menuBarEnabled"))';
      const he = patched.indexOf(tail, hs) + tail.length;
      const hook = patched.slice(hs, he);
      check("hook found in patched output", hook.startsWith(",/*__cdb_tray_host_v1__*/("), true);
      writeFileSync(dup, patched.replace(reg, reg + hook));
      check("duplicated hook -> exit 1", runPatch(dup).status, 1);
    }
    {
      const stale = join(scratch, "stale.js");
      writeFileSync(
        stale,
        patched.replace(
          'if(!$v("menuBarEnabled"))',
          'if(!$v("menuBarEnabled")||/*__cdb_tray_host_v1__*/globalThis.__cdbTrayHost?.quitOnClose?.()===true)'
        )
      );
      check("stray marker (old close injection) -> exit 1", runPatch(stale).status, 1);
    }
    {
      const moved = join(scratch, "moved.js");
      writeFileSync(moved, FIXTURE.replace("tray is disabled", "tray is off"));
      check("settings-reader anchor gone -> exit 1", runPatch(moved).status, 1);
    }
    {
      const moved = join(scratch, "moved2.js");
      writeFileSync(moved, FIXTURE.replace("{showMainWindow:ZJ}", "{showMain:ZJ}"));
      check("showMainWindow anchor gone -> exit 1", runPatch(moved).status, 1);
    }

    section("[B4] Wayland WITHOUT a watcher (upstream Yfr: unsupported)");
    {
      const r = await drive(patched, {
        bus: { busctl: "false" },
        env: WAYLAND,
        startup: true,
        trayHost: "unsupported",
      });
      check("--startup launch ends up visible", r.shownAfterLaunch, true);
      check("shown through upstream's showMainWindow (Lo then show)", r.ev.slice(0, 2).join(","), "Lo,show");
      check("close quits via upstream's no-tray-host branch", r.ev.includes("quit-no-tray"), true);
      check("close is not turned into a hide", r.ev.includes("hide"), false);
    }

    section("[B5] Wayland WITH a watcher");
    {
      const r = await drive(patched, { bus: { busctl: "true" }, env: WAYLAND, startup: true });
      check("--startup launch stays hidden (upstream)", r.shownAfterLaunch, false);
      check("close hides (upstream)", r.ev.includes("hide"), true);
      check("close does not quit", r.ev.some((e) => e.startsWith("quit")), false);
      check("close is prevented (upstream)", r.ev.includes("close-prevented"), true);
    }

    section("[B6] tray disabled in settings: upstream quit branch untouched");
    {
      const r = await drive(patched, {
        bus: { busctl: "true" },
        env: WAYLAND,
        startup: true,
        menuBarEnabled: false,
      });
      check("--startup launch with tray off is shown", r.shownAfterLaunch, true);
      check("close quits via upstream's branch", r.ev.includes("quit"), true);
    }

    section("[B7] the unpatched upstream shape really has the defect");
    {
      const r = await drive(FIXTURE, {
        bus: { busctl: "false" },
        env: WAYLAND,
        startup: true,
        trayHost: "unsupported",
      });
      check("upstream: --startup stays hidden with no tray host", r.shownAfterLaunch, false);
    }

    section("[B8] v2.31226.0 close handler: preventDefault() moved into the condition");
    {
      // Since 2.31226.0 the close handler reads
      //   if(e.preventDefault(),!Yv("menuBarEnabled")){...tray is disabled...;return}
      // instead of testing the setting first and calling preventDefault() after.
      const OLD_CLOSE = 'if(!$v("menuBarEnabled")){P.info("Quitting app on main window close since tray is disabled"),QA();return}e.preventDefault();';
      const NEW_CLOSE = 'if(e.preventDefault(),!$v("menuBarEnabled")){P.info("Quitting app on main window close since tray is disabled"),QA();return}';
      check("fixture carries the 2.26454 close shape", FIXTURE.includes(OLD_CLOSE), true);
      const v31226 = FIXTURE.replace(OLD_CLOSE, NEW_CLOSE);
      const file2 = join(scratch, "v31226.js");
      writeFileSync(file2, v31226);
      const r = runPatch(file2);
      check("new shape: patch exits 0", r.status, 0);
      check("new shape: settings reader still captured", /settings \$v\)/.test(r.out), true);
      const patched2 = readFileSync(file2, "utf8");
      check("new shape: close handler left verbatim", patched2.includes(NEW_CLOSE), true);
      check("new shape: second run byte-identical", runPatch(file2).status === 0 && readFileSync(file2, "utf8") === patched2, true);
      const d = await drive(patched2, {
        bus: { busctl: "false" },
        env: WAYLAND,
        startup: true,
        trayHost: "unsupported",
      });
      check("new shape: --startup launch with no tray host ends up visible", d.shownAfterLaunch, true);
    }

    section("[B9] v6.28899.2 close handler: `&&!jv.active()` spares upstream's hidden appifact mode");
    {
      // Since 6.28899.2:
      //   i=(P9s()||!1)&&!r&&!jv?.active();  ...
      //   if(e.preventDefault(),!jf("menuBarEnabled")&&!jv.active()){...tray is disabled...}
      const OLD_CLOSE = 'if(!$v("menuBarEnabled")){P.info("Quitting app on main window close since tray is disabled"),QA();return}e.preventDefault();';
      const NEW_CLOSE = 'if(e.preventDefault(),!$v("menuBarEnabled")&&!jv.active()){P.info("Quitting app on main window close since tray is disabled"),QA();return}';
      const OLD_GATE = "i=(__notStartup()||!1)&&!r;";
      check("fixture carries the 2.26454 gate", FIXTURE.includes(OLD_GATE), true);
      const v6 = (appifact) =>
        `var jv={active:()=>${appifact}};` +
        FIXTURE.replace(OLD_CLOSE, NEW_CLOSE).replace(OLD_GATE, "i=(__notStartup()||!1)&&!r&&!jv?.active();");
      const file3 = join(scratch, "v6.js");
      writeFileSync(file3, v6("__APPIFACT__"));
      const r = runPatch(file3);
      check("v6: patch exits 0", r.status, 0);
      check("v6: gate joined with the appifact predicate", /gate i\|\|jv\.active\(\), show ZJ, settings \$v\)/.test(r.out), true);
      const patched3 = readFileSync(file3, "utf8");
      check("v6: close handler left verbatim", patched3.includes(NEW_CLOSE), true);
      check("v6: hook passes i||jv.active()", patched3.includes(".startup(i||jv.active(),ZJ,()=>$v(\"menuBarEnabled\"))"), true);
      check("v6: second run byte-identical", runPatch(file3).status === 0 && readFileSync(file3, "utf8") === patched3, true);
      const plain = await drive(patched3.replace("__APPIFACT__", "!1"), {
        bus: { busctl: "false" },
        env: WAYLAND,
        startup: true,
        trayHost: "unsupported",
      });
      check("v6: --startup launch with no tray host ends up visible", plain.shownAfterLaunch, true);
      const off = await drive(patched3.replace("__APPIFACT__", "!1"), {
        bus: { busctl: "true" },
        env: WAYLAND,
        startup: true,
        menuBarEnabled: false,
      });
      check("v6: --startup launch with the tray switched off ends up visible", off.shownAfterLaunch, true);
      const appifact = await drive(patched3.replace("__APPIFACT__", "!0"), {
        bus: { busctl: "false" },
        env: WAYLAND,
        startup: false,
        menuBarEnabled: false,
        trayHost: "unsupported",
      });
      check("v6: appifact launch (meant to run hidden) is never shown by the hook", appifact.shownAfterLaunch, false);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  accessSync(PATCH_BIN, constants.X_OK);
} catch {
  console.error(
    "SKIP: patches/linux/fix_tray_less_desktops is not compiled " +
      "(run: make -C patches linux/fix_tray_less_desktops)"
  );
  process.exit(SKIP_EXIT);
}

await partA();
await partB();

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
