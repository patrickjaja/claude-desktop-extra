#!/usr/bin/env node
// Focus-follows-mouse: the app must not raise itself when it gains focus.
//
// WHY THIS EXISTS
// ---------------
// Upstream moves keyboard focus into the window's WebContentsView from the
// window's `focus` event. On Linux, Electron's webContents.focus() first calls
// Widget::Activate() on the owner window, which the window manager treats as a
// raise request (xdg_activation on Wayland, _NET_ACTIVE_WINDOW on X11). Under
// focus-follows-mouse the WM focuses the window on pointer entry without
// raising it, and the app then raised itself on every hover
// (anthropics/claude-code#75905).
//
// Since v6.28899.2 upstream routes every focus handler through one helper,
// `kv(win, contents)`, that already skips the call when the window is not
// active or the contents already hold focus. patches/linux/
// fix_focus_follows_mouse_raise.nim routes that helper's remaining call
// (window active, contents not focused yet) and the main window's direct focus
// call through __cdbFocusNoRaise(win, contents), which re-checks after the
// activation settles, and focuses the view once after its first load while the
// window is still inactive, so the first hover after launch has a focused view
// to restore. This harness runs the compiled patch on the upstream shapes
// (copied from the 6.28899.2 bundle), then fires `focus` on mock windows and
// records which webContents.focus() calls reach Electron.
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
const PATCH_BIN = join(ROOT, "patches", "linux", "fix_focus_follows_mouse_raise");
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

// Upstream shapes from 6.28899.2, trimmed; the two anchors are verbatim:
//   1. the shared focus-handler helper `kv`
//   2. the main window's focus function `re` (re(!0) from f.on("focus"), re()
//      at startup): `e?kv(f,i):i.focus(),`
// The pop-out's handler calls kv like upstream's artifact pop-up does.
const FIXTURE = `"use strict";
var To=!1;
function kv(e,t){!e.isFocused()||t.isFocused()||t.focus()}
function mkMain(f,x){let re=(e=!1)=>{let t=x.webContents;if(!t||t.isDestroyed())return;let n=To?f.webContents:void 0,i=n??t;e?kv(f,i):i.focus(),__ev.push("rest")};f.on("focus",(()=>{re(!0)}));return re}
function mkPopout(s,n){s.on("focus",(()=>{n.isDestroyed()||kv(s,n)}))}
`;

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

// A mock webContents; focus() is what would reach Widget::Activate on Linux.
function mkContents(name, ev, focused) {
  const once = {};
  const c = {
    focused,
    isDestroyed: () => false,
    isFocused: () => c.focused,
    focus: () => { c.focused = true; ev.push("focus:" + name); },
    once(n, f) { (once[n] ||= []).push(f); return c; },
    emit(n) { const fs = once[n] || []; once[n] = []; for (const f of fs) f(); },
  };
  return c;
}

function mkWindow(name, ev, focused) {
  const handlers = {};
  const w = {
    focused,
    visible: true,
    webContents: mkContents(name + "-own", ev, false),
    isDestroyed: () => false,
    isFocused: () => w.focused,
    isVisible: () => w.visible,
    on(n, f) { (handlers[n] ||= []).push(f); return w; },
    emit(n) { for (const f of handlers[n] || []) f(); },
  };
  return w;
}

// Load the (patched) fixture with mock windows. `opts.win` / `opts.view` are
// the window's and the view's focus state at the moment `focus` fires.
function boot(src, platform, opts) {
  const ev = [];
  const logs = [];
  const timers = [];
  const sandbox = {
    __ev: ev,
    process: { platform },
    setTimeout: (f) => { timers.push(f); return timers.length; },
    __cdbDiag: (m) => logs.push(m),
  };
  vm.runInNewContext(src, vm.createContext(sandbox));
  if (opts.to) vm.runInContext("To=!0", sandbox);
  const win = mkWindow("main", ev, opts.win);
  const view = mkContents("view", ev, opts.view);
  const pop = mkWindow("popout", ev, opts.win);
  const popView = mkContents("popview", ev, opts.view);
  const y = sandbox.mkMain(win, { webContents: view });
  sandbox.mkPopout(pop, popView);
  const flush = () => { while (timers.length) timers.shift()(); };
  return { ev, logs, win, view, pop, popView, flush, y };
}

const scratch = mkdtempSync(join(tmpdir(), "cdb-focus-no-raise-"));
try {
  accessSync(PATCH_BIN, constants.X_OK);
} catch {
  console.error(
    "SKIP: patches/linux/fix_focus_follows_mouse_raise is not compiled " +
      "(run: make -C patches linux/fix_focus_follows_mouse_raise)"
  );
  rmSync(scratch, { recursive: true, force: true });
  process.exit(SKIP_EXIT);
}

try {
  section("[A0] the compiled patch applies to the upstream shapes");
  const file = join(scratch, "index.js");
  writeFileSync(file, FIXTURE);
  const r1 = runPatch(file);
  check("first run exits 0", r1.status, 0);
  check("no [FAIL] line", /\[FAIL\]/.test(r1.out), false);
  const patched = readFileSync(file, "utf8");
  check("main focus function rewritten",
    patched.includes("e?kv(f,i):__cdbFocusNoRaise(f,i),"), true);
  check("shared focus-handler helper rewritten",
    patched.includes("function kv(e,t){!e.isFocused()||t.isFocused()||__cdbFocusNoRaise(e,t)}"), true);
  execFileSync("node", ["--check", file]);
  check("patched fixture passes node --check", true, true);

  section("[A1] idempotency: a second run changes nothing and exits 0");
  const r2 = runPatch(file);
  check("second run exits 0", r2.status, 0);
  check("second run leaves the file byte-identical", readFileSync(file, "utf8") === patched, true);

  section("[A2] a moved anchor fails loud");
  {
    const moved = join(scratch, "moved.js");
    writeFileSync(moved, FIXTURE.replace("t.isFocused()||t.focus()", "t.focus()"));
    const r = runPatch(moved);
    check("missing focus-handler helper exits non-zero", r.status !== 0, true);
    check("missing focus-handler helper prints [FAIL]", /\[FAIL\]/.test(r.out), true);
  }
  {
    const mismatch = join(scratch, "mismatch.js");
    writeFileSync(mismatch, FIXTURE.replace("e?kv(f,i):i.focus()", "e?kv(f,i):x.focus()"));
    const r = runPatch(mismatch);
    check("main focus function with a different view name exits non-zero", r.status !== 0, true);
  }

  section("[B0] unpatched upstream, Linux: focus without raise re-activates the window");
  {
    const { ev, win, flush } = boot(FIXTURE, "linux", { win: true, view: false });
    win.emit("focus");
    flush();
    check("webContents.focus() reaches Electron at once", ev.join(","), "focus:view,rest");
  }
  {
    const { ev, win, flush } = boot(FIXTURE, "linux", { win: true, view: true });
    win.emit("focus");
    flush();
    check("upstream already skips an already focused view", ev.join(","), "rest");
  }

  section("[B1] patched, Linux: window already active, view already focused -> no call");
  {
    const { ev, win, pop, logs, flush } = boot(patched, "linux", { win: true, view: true });
    win.emit("focus");
    pop.emit("focus");
    flush();
    check("no webContents.focus() call", ev.join(","), "rest");
    check("upstream's helper skipped it (our helper not reached)", logs.length, 0);
  }

  section("[B2] patched, Linux: window not active -> upstream's helper skips the focus event");
  {
    const { ev, win, pop, flush } = boot(patched, "linux", { win: false, view: false });
    win.emit("focus");
    pop.emit("focus");
    flush();
    check("no call from either focus handler", ev.join(","), "rest");
  }
  {
    const { ev, win, flush } = boot(patched, "linux", { win: true, view: false, to: true });
    win.emit("focus");
    flush();
    check("flag set: the window's own webContents is re-checked, then focused", ev.join(","), "rest,focus:main-own");
  }

  section("[B3] patched, Linux: window active, view not focused -> re-check after activation");
  {
    const { ev, win, view, flush } = boot(patched, "linux", { win: true, view: false });
    win.emit("focus");
    check("nothing called synchronously", ev.join(","), "rest");
    view.focused = true; // Chromium restored the last focused view
    flush();
    check("restored view: still no call", ev.join(","), "rest");
  }
  {
    const { ev, win, logs, flush } = boot(patched, "linux", { win: true, view: false });
    win.emit("focus");
    flush();
    check("unrestored view: one stock call", ev.join(","), "rest,focus:view");
    check("fallback is logged", logs.some((l) => /\[focus-no-raise\] fallback:/.test(l)), true);
  }
  {
    const { ev, win, flush } = boot(patched, "linux", { win: true, view: false });
    win.emit("focus");
    win.focused = false; // focus moved on before the re-check
    flush();
    check("window lost focus meanwhile: no call", ev.join(","), "rest");
  }

  section("[B5] patched, Linux: startup pre-focus while the window is still inactive");
  {
    // Upstream calls the focus function at window creation, before the view has
    // loaded; the window maps without focus (KWin denies the launch activation).
    const { ev, win, view, logs, flush, y } = boot(patched, "linux", { win: false, view: false });
    y();
    view.focused = false; // nothing loaded yet: the stock call stored no focus
    view.emit("did-finish-load");
    flush();
    check("creation call + one pre-focus after the first load", ev.join(","), "focus:view,rest,focus:view");
    check("pre-focus is logged", logs.some((l) => /\[focus-no-raise\] prefocus/.test(l)), true);
    win.focused = true; // first focus-follows-mouse activation
    win.emit("focus");
    flush();
    check("first hover after launch: no further call", ev.join(","), "focus:view,rest,focus:view,rest");
  }
  {
    const { ev, win, view, flush, y } = boot(patched, "linux", { win: false, view: false });
    y();
    view.focused = false;
    win.focused = true; // hovered while loading: the window was active once
    win.emit("focus");
    flush();
    win.focused = false;
    view.emit("did-finish-load");
    flush();
    check("window was active before the load: no pre-focus",
      ev.filter((e) => e === "focus:view").length, 2);
  }
  {
    const { ev, win, view, flush, y } = boot(patched, "linux", { win: false, view: false });
    y();
    win.visible = false; // hidden launch into the tray
    view.emit("did-finish-load");
    flush();
    check("hidden window: no pre-focus", ev.join(","), "focus:view,rest");
  }
  {
    const { ev, view, flush, y } = boot(patched, "linux", { win: false, view: false });
    y();
    y();
    view.emit("did-finish-load");
    view.emit("did-finish-load");
    flush();
    check("pre-focus runs once", ev.filter((e) => e === "focus:view").length, 3);
  }

  section("[B4] patched, other platforms: stock behaviour");
  {
    const { ev, win, pop, flush } = boot(patched, "darwin", { win: true, view: false });
    win.emit("focus");
    pop.emit("focus");
    flush();
    check("darwin keeps both calls, synchronously", ev.join(","), "focus:view,rest,focus:popview");
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
