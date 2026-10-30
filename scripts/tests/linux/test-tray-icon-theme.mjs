#!/usr/bin/env node
// Tray glyph: upstream's theme-following choice, plus an "always white" switch.
//
// WHY THIS EXISTS
// ---------------
// Upstream picks the Linux tray glyph in one helper:
//   e||<de>()==="gnome"||u.nativeTheme.shouldUseDarkColors?"TrayIconLinux-Dark.png":"TrayIconLinux.png"
// (white on GNOME, in dark mode and on the crash-retry fallback; black in light
// mode). patches/linux/fix_tray_icon_theme.nim keeps that choice and only puts
// the Community switch `trayIconAlwaysWhite` in front of it, through
// globalThis.__cdbTrayAlwaysWhite() (defined by js/extra_settings_main.js).
// It also publishes upstream's crash-contained tray update (the wrapper that
// tries the update function and retries it with the fallback) as
// globalThis.__cdbTrayRefresh, so flipping the switch applies live (#305).
//
//   [A] the compiled patch on the verbatim 4.4212.0 shapes: applies once,
//       idempotent, node --check, fails loud on a moved anchor
//   [B] the selector truth table: switch off (and helper missing) == upstream
//       for every input; switch on == white on Linux
//   [C] the refresh hook drives the real (fixture) wrapper and update
//       function: flipping the switch re-sets the image, and an update that
//       throws mid-create is cleaned up and retried with the fallback
//   [D] the same on the real extract under tmp/app.asar.contents (SKIPPED
//       when there is none; set CDB_BUNDLE_DIR to point at one)
//   [E] the Extra settings half: cdb-tray:read / cdb-tray:set, the .jsonc lock,
//       the helper, the refresh call, and the bridge methods
//
// CDB_TRAY_PATCH_BIN runs [A]-[D] against another build of the patch.
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  readdirSync,
  existsSync,
  accessSync,
  chmodSync,
  constants,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PATCH_BIN =
  process.env.CDB_TRAY_PATCH_BIN || join(ROOT, "patches", "linux", "fix_tray_icon_theme");
const EXTRA_BIN = join(ROOT, "patches", "core", "add_feature_extra_settings");
const BUILD_DIR = join(
  process.env.CDB_BUNDLE_DIR || join(ROOT, "tmp", "app.asar.contents"),
  ".vite",
  "build"
);
const SKIP_EXIT = 3;
const WHITE = "TrayIconLinux-Dark.png";
const BLACK = "TrayIconLinux.png";

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

// Verbatim from the 4.4212.0 bundle: the selector, the tray update function
// (its tray-creation tail trimmed after setToolTip) and the crash-containment
// wrapper that calls it - which is what the hook must call.
const SELECTOR =
  'function wto(e){switch("png"){case"ico":return!e&&u.nativeTheme.shouldUseDarkColors?"Tray-Win32-Dark.ico":"Tray-Win32.ico";case"template-image":return"TrayIconTemplate.png";case"png":return e||NO()==="gnome"||u.nativeTheme.shouldUseDarkColors?"TrayIconLinux-Dark.png":"TrayIconLinux.png"}}';
const UPDATE =
  'function Tto(e){if(!u.app.isReady())return;let t=$b("menuBarEnabled"),r=n.default.join(wJ(),wto(e));if(!t){Y9&&!Y9.isDestroyed()&&(Q9=[],$9=!1,Y9.destroy()),Y9=null,X9=null,VUi();return}if(Y9&&!Y9.isDestroyed()){r!==X9&&(Y9.setImage(aeo()??u.nativeImage.createFromPath(r)),X9=r);return}Q9=[],$9=!1;let i=!_to;Y9=new u.Tray(u.nativeImage.createFromPath(r)),Y9.setToolTip(u.app.getName()),X9=r,_to=!0}';
const WRAPPER =
  "function xto(){let e=Error.stackTraceLimit;Error.stackTraceLimit=50;let t=Y9;try{Tto(!1)}catch(e){Sto(e);try{Y9&&Y9!==t&&!Y9.isDestroyed()&&(Y9.destroy(),Y9=null,X9=null),Tto(!0)}catch{if(Y9&&Y9!==t){try{Y9.isDestroyed()||Y9.destroy()}catch{}Y9=null,X9=null}}}finally{Error.stackTraceLimit=e}}";
const FIXTURE =
  '"use strict";\nvar Y9=null,X9=null,Q9=[],$9=!1,_to=!1;function Sto(){}function VUi(){}' +
  SELECTOR + UPDATE + "function vto(){}" + WRAPPER + "\n";

function runPatch(file, bin = PATCH_BIN) {
  try {
    const out = execFileSync(bin, [file], { encoding: "utf8", stdio: "pipe" });
    return { status: 0, out };
  } catch (e) {
    return {
      status: typeof e.status === "number" ? e.status : -1,
      out: String(e.stdout || "") + String(e.stderr || ""),
    };
  }
}

function patchString(src, scratch, name) {
  const file = join(scratch, name);
  writeFileSync(file, src);
  const r = runPatch(file);
  return { ...r, text: readFileSync(file, "utf8") };
}

// The selector function out of a (patched or pristine) bundle text, with the
// two free names it uses (electron alias, desktop-environment function).
function extractSelector(text) {
  const m =
    /function ([\w$]+)\(([\w$]+)\)\{switch\([^)]*\)\{case["`]ico["`][\s\S]*?["`]TrayIconLinux\.png["`]\)?\}\}/.exec(
      text
    );
  if (!m) return null;
  const src = m[0];
  const electron = /([\w$]+)\.nativeTheme\.shouldUseDarkColors/.exec(src)[1];
  const de = /([\w$]+)\(\)===["`]gnome["`]/.exec(src)[1];
  return { name: m[1], src, electron, de };
}

// Evaluate the selector with a stubbed nativeTheme / desktop / switch.
// helper: undefined = no __cdbTrayAlwaysWhite at all.
function pick(sel, { fallback, desktop, dark, helper, platform = "linux" }) {
  const ctx = {
    process: { platform },
    [sel.electron]: { nativeTheme: { shouldUseDarkColors: dark } },
    [sel.de]: () => desktop,
  };
  if (helper !== undefined) ctx.__cdbTrayAlwaysWhite = () => helper;
  vm.createContext(ctx);
  vm.runInContext(sel.src, ctx);
  return vm.runInContext(`${sel.name}(${JSON.stringify(fallback)})`, ctx);
}

const upstream = ({ fallback, desktop, dark }) =>
  fallback || desktop === "gnome" || dark ? WHITE : BLACK;

function matrix() {
  const out = [];
  for (const fallback of [false, true])
    for (const desktop of ["gnome", "kde"])
      for (const dark of [true, false]) out.push({ fallback, desktop, dark });
  return out;
}
const tag = (c) => `fallback=${c.fallback} ${c.desktop} ${c.dark ? "dark" : "light"}`;

// [B] on one patched text: the full truth table.
function truthTable(text, label) {
  const sel = extractSelector(text);
  check(`${label}: selector found`, !!sel, true);
  if (!sel) return;
  for (const c of matrix()) {
    check(`${label}: switch off, ${tag(c)}`, pick(sel, { ...c, helper: false }), upstream(c));
  }
  for (const c of matrix()) {
    check(`${label}: helper missing, ${tag(c)}`, pick(sel, { ...c, helper: undefined }), upstream(c));
  }
  for (const c of matrix()) {
    check(`${label}: switch on, ${tag(c)}`, pick(sel, { ...c, helper: true }), WHITE);
  }
  const c = { fallback: false, desktop: "kde", dark: false };
  check(`${label}: not Linux, switch on -> upstream`, pick(sel, { ...c, helper: true, platform: "win32" }), upstream(c));
}

// [C]/[D] the hook statement: exactly one, declared right before the update
// function, calling the zero-arg wrapper that tries update(!1) and retries
// update(!0); the update function resolves the selector's file and guards
// setImage on it. Returns {wrapper, update}.
const esc = (n) => n.replace(/\$/g, "\\$");
function hookShape(text, selectorName, label) {
  const all = [...text.matchAll(/globalThis\.__cdbTrayRefresh=/g)].length;
  check(`${label}: exactly one __cdbTrayRefresh assignment`, all, 1);
  const m =
    /globalThis\.__cdbTrayRefresh=function\(\)\{return ([\w$]+)\(\)\};function ([\w$]+)\(([\w$]+)\)\{/.exec(
      text
    );
  check(`${label}: hook calls a zero-arg function, placed before a declaration`, !!m, true);
  if (!m) return null;
  const [, wrapper, update, param] = m;
  const body = text.slice(m.index + m[0].length, m.index + m[0].length + 1200);
  const j = new RegExp(
    `([\\w$]+)=[\\w$]+(?:\\.[\\w$]+)*\\.join\\([\\w$]+\\(\\),${esc(selectorName)}\\(${esc(param)}\\)\\)`
  ).exec(body);
  check(`${label}: ${update} resolves its path via ${selectorName}(${param})`, !!j, true);
  if (j) {
    check(
      `${label}: ${update} only re-sets the image when ${j[1]} changed`,
      new RegExp(`${esc(j[1])}!==[\\w$]+&&\\(?[\\w$]+\\.setImage\\(`).test(body),
      true
    );
  }
  const w = new RegExp(`function ${esc(wrapper)}\\(\\)\\{[^{}]*try\\{${esc(update)}\\(!1\\)\\}catch\\(`).exec(text);
  check(`${label}: ${wrapper} is the wrapper that tries ${update}(!1)`, !!w, true);
  if (w) {
    const rest = text.slice(w.index + w[0].length, w.index + w[0].length + 600);
    check(`${label}: ${wrapper} retries ${update}(!0)`, rest.includes(`${update}(!0)`), true);
  }
  // The statement itself, evaluated: it calls the wrapper with no argument.
  const calls = [];
  const ctx = vm.createContext({ [wrapper]: (...a) => calls.push(a) });
  vm.runInContext(`globalThis.__cdbTrayRefresh=function(){return ${wrapper}()};`, ctx);
  check(`${label}: hook is a function`, typeof ctx.__cdbTrayRefresh, "function");
  ctx.__cdbTrayRefresh();
  check(`${label}: hook calls ${wrapper}()`, JSON.stringify(calls), "[[]]");
  return { wrapper, update };
}

// Boot the patched fixture with a mock Electron and drive the real wrapper and
// update function through the hook. state: desktop, dark, white (the switch),
// menuBar (upstream's menuBarEnabled), toolTipThrows (setToolTip throws once,
// i.e. the update fails mid-create after the Tray exists).
function bootFixture(text, state) {
  const images = [];
  const trays = [];
  class Tray {
    constructor(img) { this.img = img; this.dead = false; trays.push(this); images.push(["new", img]); }
    isDestroyed() { return this.dead; }
    setImage(img) { this.img = img; images.push(["set", img]); }
    setToolTip() {
      if (state.toolTipThrows) { state.toolTipThrows = false; throw new Error("tray host went away"); }
    }
    destroy() { this.dead = true; images.push(["destroy", this.img]); }
  }
  const ctx = {
    process: { platform: "linux" },
    u: {
      app: { isReady: () => true, getName: () => "Claude" },
      nativeTheme: { get shouldUseDarkColors() { return state.dark; } },
      nativeImage: { createFromPath: (p) => p },
      Tray,
    },
    NO: () => state.desktop,
    $b: () => state.menuBar !== false,
    wJ: () => "/res",
    aeo: () => null,
    n: { default: { join: (a, b) => a + "/" + b } },
    __cdbTrayAlwaysWhite: () => state.white,
  };
  vm.createContext(ctx);
  vm.runInContext(text + "\n;xto();", ctx);
  return { ctx, images, trays };
}

const scratch = mkdtempSync(join(tmpdir(), "cdb-tray-theme-"));
try {
  accessSync(PATCH_BIN, constants.X_OK);
} catch {
  console.error(
    `SKIP: ${PATCH_BIN} is not compiled (run: make -C patches linux/fix_tray_icon_theme)`
  );
  rmSync(scratch, { recursive: true, force: true });
  process.exit(SKIP_EXIT);
}

try {
  section("[A0] the compiled patch applies to the 4.4212.0 shapes");
  const r1 = patchString(FIXTURE, scratch, "fixture.js");
  check("first run exits 0", r1.status, 0);
  check("no [FAIL] line", /\[FAIL\]/.test(r1.out), false);
  check("names reported", /__cdbTrayRefresh -> xto \(update Tto, selector wto\)/.test(r1.out), true);
  const patched = r1.text;
  check("patched output changed", patched !== FIXTURE, true);
  check(
    "png case asks the switch first, upstream stays the else branch",
    patched.includes(
      'case"png":return process.platform==="linux"&&globalThis.__cdbTrayAlwaysWhite?.()?"TrayIconLinux-Dark.png":(e||NO()==="gnome"||u.nativeTheme.shouldUseDarkColors?"TrayIconLinux-Dark.png":"TrayIconLinux.png")}}'
    ),
    true
  );
  let syntaxOk = true;
  try {
    execFileSync("node", ["--check", join(scratch, "fixture.js")], { stdio: "pipe" });
  } catch {
    syntaxOk = false;
  }
  check("patched fixture passes node --check", syntaxOk, true);

  section("[A1] idempotency: a second run changes nothing and exits 0");
  const r2 = runPatch(join(scratch, "fixture.js"));
  check("second run exits 0", r2.status, 0);
  check("second run reports both sub-patches present", (r2.out.match(/already present/g) || []).length, 2);
  check("second run leaves the file byte-identical", readFileSync(join(scratch, "fixture.js"), "utf8"), patched);

  section("[A2] a moved anchor fails loud");
  {
    const noUpdate = patchString('"use strict";' + SELECTOR + "function vto(){}", scratch, "no-update.js");
    check("no update function: exit 1", noUpdate.status, 1);
    check("no update function: says why", /\[FAIL\] tray refresh hook: 0 functions/.test(noUpdate.out), true);
    const noGuard = patchString(
      '"use strict";' + SELECTOR + UPDATE.replace("r!==X9&&", "") + WRAPPER,
      scratch,
      "no-guard.js"
    );
    check("update function without the setImage guard: exit 1", noGuard.status, 1);
    // The guard is looked for in the update function's own body only.
    const guardElsewhere = patchString(
      '"use strict";' + SELECTOR + UPDATE.replace("r!==X9&&", "") +
        "function zzz(){let r;r!==X9&&(Y9.setImage(r))}" + WRAPPER,
      scratch,
      "guard-elsewhere.js"
    );
    check("setImage guard only in a neighbour: exit 1", guardElsewhere.status, 1);
    check("setImage guard only in a neighbour: says why", /has no `r!==\.\.\.&&\.\.\.setImage\(` in its body/.test(guardElsewhere.out), true);
    const noWrapper = patchString('"use strict";' + SELECTOR + UPDATE, scratch, "no-wrapper.js");
    check("no crash-containment wrapper: exit 1", noWrapper.status, 1);
    check("no crash-containment wrapper: says why", /0 crash-containment wrappers/.test(noWrapper.out), true);
    const noRetry = patchString(
      '"use strict";' + SELECTOR + UPDATE + WRAPPER.replace("Tto(!0)", "Sto(e)"),
      scratch,
      "no-retry.js"
    );
    check("wrapper without the Tto(!0) retry: exit 1", noRetry.status, 1);
    const twoWrappers = patchString(
      '"use strict";' + SELECTOR + UPDATE + WRAPPER + WRAPPER.replace("function xto", "function xtp"),
      scratch,
      "two-wrappers.js"
    );
    check("two wrappers: exit 1", twoWrappers.status, 1);
    const exprPos = patchString('"use strict";' + SELECTOR + "var Q=" + UPDATE + ";" + WRAPPER, scratch, "expr.js");
    check("update function in expression position: exit 1", exprPos.status, 1);
    check("expression position: says why", /`=` before function Tto -- not a statement position/.test(exprPos.out), true);
    const atStart = patchString(UPDATE + SELECTOR + WRAPPER, scratch, "at-start.js");
    check("update function at the start of the file: exit 0", atStart.status, 0);
    const noSel = patchString('"use strict";' + UPDATE, scratch, "no-selector.js");
    check("no selector: exit 1", noSel.status, 1);
    check("no selector: no [OK] for the selector", /\[OK\] tray icon selector/.test(noSel.out), false);
    const twice = patchString('"use strict";' + SELECTOR + UPDATE + SELECTOR.replace("wto", "wtp"), scratch, "two.js");
    check("two selectors: exit 1", twice.status, 1);
  }

  section("[B] selector truth table on the patched fixture");
  {
    const pristine = extractSelector(FIXTURE);
    for (const c of matrix()) {
      check(`pristine upstream table, ${tag(c)}`, pick(pristine, { ...c, helper: undefined }), upstream(c));
    }
    truthTable(patched, "fixture");
  }

  section("[C] the refresh hook on the fixture");
  {
    const names = hookShape(patched, "wto", "fixture");
    check("fixture: hook calls the wrapper, not the raw update function", names && names.wrapper, "xto");
    check("fixture: hook sits before the update function", names && names.update, "Tto");
    const state = { desktop: "kde", dark: false, white: false };
    const { ctx, images } = bootFixture(patched, state);
    check("tray built with upstream's light-mode glyph", JSON.stringify(images), JSON.stringify([["new", "/res/" + BLACK]]));
    check("fixture: the booted bundle publishes the hook", typeof ctx.__cdbTrayRefresh, "function");
    // Without the hook the rest of this section has nothing to drive.
    if (typeof ctx.__cdbTrayRefresh !== "function") ctx.__cdbTrayRefresh = () => {};
    ctx.__cdbTrayRefresh();
    check("refresh with nothing changed does not re-set the image", images.length, 1);
    state.white = true;
    ctx.__cdbTrayRefresh();
    check("switch on + refresh -> white glyph", JSON.stringify(images[1]), JSON.stringify(["set", "/res/" + WHITE]));
    state.white = false;
    state.dark = true;
    ctx.__cdbTrayRefresh();
    check("switch off in dark mode stays white (upstream), no re-set", images.length, 2);
    state.dark = false;
    ctx.__cdbTrayRefresh();
    check("switch off in light mode -> black again", JSON.stringify(images[2]), JSON.stringify(["set", "/res/" + BLACK]));
  }
  {
    // The menu bar was off at boot (no tray), comes on, and the update throws
    // after the Tray exists. Through the wrapper the half-built tray is
    // destroyed and the update retried with the fallback (white) - a raw call
    // of the update function would leave the broken tray and throw.
    const state = { desktop: "kde", dark: false, white: false, menuBar: false };
    const { ctx, trays } = bootFixture(patched, state);
    check("menu bar off at boot: no tray", trays.length, 0);
    if (typeof ctx.__cdbTrayRefresh !== "function") ctx.__cdbTrayRefresh = () => {};
    state.menuBar = true;
    state.toolTipThrows = true;
    let threw = false;
    try { ctx.__cdbTrayRefresh(); } catch { threw = true; }
    check("crash mid-create: the refresh does not throw", threw, false);
    check("crash mid-create: the half-built tray is destroyed", trays.length > 0 && trays[0].dead, true);
    check("crash mid-create: a second tray is built", trays.length, 2);
    check(
      "crash mid-create: it is live, current, and on the fallback (white) glyph",
      trays.length === 2 && !trays[1].dead && ctx.Y9 === trays[1] && trays[1].img === "/res/" + WHITE,
      true
    );
  }

  section("[D] the real extract");
  {
    let chunk = null;
    if (existsSync(BUILD_DIR)) {
      for (const f of readdirSync(BUILD_DIR)) {
        if (!/^index.*\.js$/.test(f)) continue;
        const t = readFileSync(join(BUILD_DIR, f), "utf8");
        if (t.includes("TrayIconLinux-Dark.png")) { chunk = { f, t }; break; }
      }
    }
    if (!chunk) {
      console.log(`  SKIP no extract with the tray selector under ${BUILD_DIR}`);
    } else if (chunk.t.includes("__cdbTray")) {
      console.log(`  SKIP ${chunk.f} is already patched - re-extract a pristine bundle`);
    } else {
      const r = patchString(chunk.t, scratch, chunk.f);
      check(`${chunk.f}: patch exits 0`, r.status, 0);
      let ok = true;
      try {
        execFileSync("node", ["--check", join(scratch, chunk.f)], { stdio: "pipe" });
      } catch {
        ok = false;
      }
      check(`${chunk.f}: node --check`, ok, true);
      const pristine = extractSelector(chunk.t);
      check("extract: pristine selector found", !!pristine, true);
      if (pristine) {
        for (const c of matrix()) {
          check(`extract: pristine == upstream table, ${tag(c)}`, pick(pristine, { ...c, helper: undefined }), upstream(c));
        }
      }
      truthTable(r.text, "extract");
      const sel = extractSelector(r.text);
      if (sel) hookShape(r.text, sel.name, "extract");
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// ---------------------------------------------------------------- [E]
section("[E] Extra settings: trayIconAlwaysWhite read / write / lock");
{
  const require2 = createRequire(import.meta.url);
  let extraOk = true;
  try {
    accessSync(EXTRA_BIN, constants.X_OK);
  } catch {
    extraOk = false;
  }
  if (!extraOk) {
    console.log("  FAIL patches/core/add_feature_extra_settings is not compiled (run: make -C patches)");
    failures.push("extra settings binary missing");
  } else {
    const dir = mkdtempSync(join(tmpdir(), "cdb-tray-extra-"));
    const mod = join(dir, "extra.cjs");
    // The relaunch stand-in is what the settings patch's second sub-patch needs
    // (see test-deployment-main.mjs); never called here.
    writeFileSync(
      mod,
      '"use strict";\nfunction FHa(e=[]){let t=G().type==="3p"&&ou()==="1p"?[...e,j$t]:e;a.app.isPackaged?Mj(!0,t):fj(t)}\n'
    );
    try { chmodSync(EXTRA_BIN, 0o755); } catch {}
    execFileSync(EXTRA_BIN, [mod], { stdio: "ignore" });

    const userData = join(dir, "Claude");
    mkdirSync(userData, { recursive: true });
    const json = join(userData, "claude-desktop-extra.json");
    const jsonc = join(userData, "claude-desktop-extra.jsonc");
    const handlers = {};
    const Module = require2("module");
    const fakeElectron = {
      app: { getPath: () => userData, on: () => {}, once: () => {}, relaunch: () => {}, exit: () => {} },
      ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, removeHandler: () => {} },
      shell: { openPath: () => Promise.resolve(""), showItemInFolder: () => {} },
    };
    const orig = Module._load;
    Module._load = function (req, ...rest) {
      return req === "electron" ? fakeElectron : orig.call(this, req, ...rest);
    };
    const diag = [];
    globalThis.__cdbDiag = (m) => diag.push(m);
    delete globalThis.__cdbTrayRefresh;
    delete globalThis.__cdbTrayAlwaysWhite;
    try {
      require2(mod);
    } finally {
      Module._load = orig;
    }
    const ev = {
      sender: { isDestroyed: () => false, getURL: () => "https://claude.ai/settings" },
      senderFrame: { parent: null },
    };
    const call = async (ch, ...a) => handlers[ch](ev, ...a);
    const readJson = () => JSON.parse(readFileSync(json, "utf8"));

    check("helper installed on Linux", typeof globalThis.__cdbTrayAlwaysWhite, "function");
    check("clean profile: helper says off", globalThis.__cdbTrayAlwaysWhite(), false);
    check("both channels registered", !!handlers["cdb-tray:read"] && !!handlers["cdb-tray:set"], true);

    let r = await call("cdb-tray:read");
    check("without the tray patch: read refuses", r.ok === false && /not installed/.test(r.error), true);
    r = await call("cdb-tray:set", true);
    check("without the tray patch: set refuses and writes nothing", r.ok === false && !existsSync(json), true);

    let refreshes = 0;
    globalThis.__cdbTrayRefresh = () => { refreshes++; };
    r = await call("cdb-tray:read");
    check("read: off by default, not locked", JSON.stringify([r.ok, r.enabled, r.lockedByJsonc]), "[true,false,null]");

    writeFileSync(json, JSON.stringify({ activeTheme: "nord" }, null, 2));
    r = await call("cdb-tray:set", true);
    check("set(true): ok", r.ok, true);
    check("set(true): writes the key, keeps the others", JSON.stringify(readJson()), '{"activeTheme":"nord","trayIconAlwaysWhite":true}');
    check("set(true): refreshes the tray once", refreshes, 1);
    check("set(true): reports the refresh", r.refreshed, true);
    check("set(true): helper now says on", globalThis.__cdbTrayAlwaysWhite(), true);
    r = await call("cdb-tray:read");
    check("read after set(true)", JSON.stringify([r.enabled, r.lockedByJsonc]), "[true,null]");

    r = await call("cdb-tray:set", false);
    check("set(false): removes the key (off = absent)", JSON.stringify(readJson()), '{"activeTheme":"nord"}');
    check("set(false): refreshes again", refreshes, 2);
    check("set(false): helper says off", globalThis.__cdbTrayAlwaysWhite(), false);

    r = await call("cdb-tray:set", "yes");
    check("non-boolean refused", r.ok === false && /boolean/.test(r.error), true);
    check("non-boolean: no refresh", refreshes, 2);

    globalThis.__cdbTrayRefresh = () => { throw new Error("tray gone"); };
    r = await call("cdb-tray:set", true);
    check("refresh throwing: setting still saved", JSON.stringify([r.ok, r.refreshed, readJson().trayIconAlwaysWhite]), "[true,false,true]");
    globalThis.__cdbTrayRefresh = () => { refreshes++; };

    // The .jsonc is human-owned and wins: comments and a trailing comma included.
    writeFileSync(jsonc, '{\n  // hand-edited\n  "trayIconAlwaysWhite": false,\n}\n');
    check(".jsonc false beats .json true: helper off", globalThis.__cdbTrayAlwaysWhite(), false);
    r = await call("cdb-tray:read");
    check(".jsonc: read reports the file's value, locked", JSON.stringify([r.enabled, r.lockedByJsonc]), "[false,true]");
    const before = readFileSync(json, "utf8");
    r = await call("cdb-tray:set", true);
    check(".jsonc: set refused as locked", r.ok === false && r.lockedByJsonc === true, true);
    check(".jsonc: .json untouched, no refresh", readFileSync(json, "utf8") === before && refreshes === 2, true);
    writeFileSync(jsonc, '{ "trayIconAlwaysWhite": true }');
    check(".jsonc true: helper on even with .json off", (writeFileSync(json, "{}"), globalThis.__cdbTrayAlwaysWhite()), true);
    writeFileSync(jsonc, '{ "trayIconAlwaysWhite": "yes" }');
    r = await call("cdb-tray:read");
    check("a non-boolean in the .jsonc does not lock", JSON.stringify([r.enabled, r.lockedByJsonc]), "[false,null]");

    rmSync(dir, { recursive: true, force: true });
    delete globalThis.__cdbTrayRefresh;
    delete globalThis.__cdbTrayAlwaysWhite;
  }

  // The bridge: two fixed methods, a boolean only.
  const calls = [];
  let api = null;
  vm.runInNewContext(readFileSync(join(ROOT, "js", "extra_settings_bridge.js"), "utf8"), vm.createContext({
    require: () => ({
      contextBridge: { exposeInMainWorld: (_n, a) => { api = a; } },
      ipcRenderer: { invoke: (...a) => { calls.push(a); return Promise.resolve({ ok: true }); } },
    }),
  }));
  api.trayIconRead();
  api.trayIconSet("yes");
  api.trayIconSet(true);
  check("bridge: fixed channels, boolean only", JSON.stringify(calls), '[["cdb-tray:read"],["cdb-tray:set",false],["cdb-tray:set",true]]');

  // The page row: wired to those methods, in the Community list, plain dashes.
  const page = readFileSync(join(ROOT, "js", "extra_settings_page.js"), "utf8");
  const row = /function renderTrayIconRow\(panel\) \{[\s\S]*?\n {2}\}\n/.exec(page);
  check("page: renderTrayIconRow exists", !!row, true);
  if (row) {
    check("page: row reads/writes the bridge methods", /read: "trayIconRead",\s*write: "trayIconSet"/.test(row[0]), true);
    check("page: section Tray, title as specified", /section: "Tray",\s*title: "Always use the white tray icon"/.test(row[0]), true);
    check("page: no em-dash in the row", row[0].includes("—"), false);
  }
  check("page: row is in FEATURE_ROWS", /var FEATURE_ROWS = \[[^\]]*renderTrayIconRow/.test(page), true);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
