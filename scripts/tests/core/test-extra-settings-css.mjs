#!/usr/bin/env node
/*
 * test-extra-settings-css.mjs - pins how the Extra settings area gets its
 * stylesheet into a page, i.e. the `dom-ready` hook at the end of
 * js/extra_settings_main.js (injected by patches/core/add_feature_extra_settings.nim).
 *
 * Why this exists: Electron's insertCSS is scoped to the document that is live
 * when it runs, not to the webContents. The hook used to remember every
 * webContents it had ever styled in a WeakSet and insert the sheet only the
 * first time that webContents fired dom-ready. That looks correct and passes
 * every patch check, but it breaks for real users: the main window's first
 * dom-ready is the local file:// shell page, the first https one is usually the
 * SSO /login page, and the sign-in round trip then replaces the document. The
 * new document carries no stylesheet, the WeakSet permanently blocks a
 * re-insert, and the Extra settings panel renders completely unstyled - an
 * unreadable wall of unformatted controls - for the rest of the process. The
 * only way back was restarting the app and not signing in.
 *
 * So the sheet must be re-inserted on EVERY dom-ready, with the key from the
 * previous (now gone) document dropped first so sheets cannot stack. That is
 * what this harness asserts, together with the URL guards that keep the sheet
 * and the page script off the local shell page, devtools and localhost.
 *
 * The code under test is the REAL patch output: the compiled patch binary is
 * run over a file holding nothing but `"use strict";`, which leaves a
 * standalone CommonJS module with our IIFE and nothing else. electron is
 * shimmed, and the webContents is a recorder.
 *
 * Usage: node scripts/tests/core/test-extra-settings-css.mjs   (exit 3 = SKIP, 1 = FAIL)
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PATCH_BIN = join(ROOT, "patches", "core", "add_feature_extra_settings");
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

/** Run the real patch binary over a bare "use strict"; file -> our IIFE as a module. */
function buildModule() {
  if (!existsSync(PATCH_BIN)) {
    try {
      execFileSync("make", ["-C", join(ROOT, "patches"), "core/add_feature_extra_settings"], { stdio: "ignore" });
    } catch {}
  }
  if (!existsSync(PATCH_BIN)) {
    console.error("SKIP: patches/core/add_feature_extra_settings is not compiled " +
      "(run: make -C patches core/add_feature_extra_settings)");
    process.exit(SKIP_EXIT);
  }
  try { chmodSync(PATCH_BIN, 0o755); } catch {}
  const dir = mkdtempSync(join(tmpdir(), "cdb-css-mod-"));
  const mod = join(dir, "extra.cjs");
  writeFileSync(mod, '"use strict";\n');
  execFileSync(PATCH_BIN, [mod], { stdio: "ignore" });
  const src = readFileSync(mod, "utf8");
  if (!src.includes("web-contents-created")) {
    console.error("FAIL: the patch output carries no web-contents-created hook");
    process.exit(1);
  }
  return mod;
}

const MODULE = buildModule();

/**
 * Load the IIFE with electron shimmed, and hand back the listener it registered
 * for "web-contents-created" plus the diagnostics sink __cdbEx_log writes to.
 */
function install() {
  const base = mkdtempSync(join(tmpdir(), "cdb-css-"));
  const userData = join(base, "Claude");
  mkdirSync(userData, { recursive: true });

  let onCreated = null;
  const Module = require2("module");
  const fakeElectron = {
    app: {
      getPath: () => userData,
      on: (ev, fn) => { if (ev === "web-contents-created") onCreated = fn; },
      relaunch: () => {},
      exit: () => {}
    },
    ipcMain: { handle: () => {}, removeHandler: () => {} },
    shell: { openPath: () => Promise.resolve(""), showItemInFolder: () => {} }
  };
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    return req === "electron" ? fakeElectron : orig.call(this, req, ...rest);
  };
  const diag = [];
  globalThis.__cdbDiag = (m) => diag.push(m);
  try {
    delete require2.cache[require2.resolve(MODULE)];
    require2(MODULE);
  } finally {
    Module._load = orig;
  }
  if (typeof onCreated !== "function") {
    console.error("FAIL: the IIFE registered no web-contents-created listener");
    process.exit(1);
  }
  return { onCreated, diag, userData };
}

/** Let the promise chains inside the hook (insertCSS/executeJavaScript) settle. */
async function settle() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

/**
 * A webContents that records everything the hook does to it. insertCSS hands
 * back a fresh key per call, exactly like Electron's does, so a stacked sheet
 * is visible as a key that was never removed.
 */
function makeWebContents(inst, tag) {
  let keySeq = 0;
  const rec = {
    tag,
    url: "about:blank",
    inserted: [],   // the css argument of every insertCSS call
    keys: [],       // the key each of those resolved with
    removed: [],    // every key handed to removeInsertedCSS
    executed: [],   // the source of every executeJavaScript call
    rejectInsertOnce: false,
    handlers: {}
  };
  const wc = {
    getURL: () => rec.url,
    isDestroyed: () => false,
    insertCSS: (css) => {
      rec.inserted.push(css);
      if (rec.rejectInsertOnce) {
        rec.rejectInsertOnce = false;
        return Promise.reject(new Error("no document to insert into"));
      }
      const k = String(++keySeq) + tag;
      rec.keys.push(k);
      return Promise.resolve(k);
    },
    removeInsertedCSS: (k) => { rec.removed.push(k); return Promise.resolve(); },
    executeJavaScript: (src) => { rec.executed.push(src); return Promise.resolve("installed"); },
    on: (ev, fn) => { (rec.handlers[ev] = rec.handlers[ev] || []).push(fn); }
  };
  rec.wc = wc;
  inst.onCreated({}, wc);
  rec.domReady = async (url) => {
    rec.url = url;
    for (const fn of rec.handlers["dom-ready"] || []) fn();
    await settle();
  };
  return rec;
}

// --- [1] the regression: a full navigation must get the sheet back ----------
section("[1] the sheet is re-inserted on every dom-ready, not only the first");
{
  const inst = install();
  const wc = makeWebContents(inst, "a");

  await wc.domReady("https://claude.ai/login?returnTo=%2Fnew");
  ok(wc.inserted.length === 1, "the login page gets the stylesheet", String(wc.inserted.length));
  ok(wc.removed.length === 0, "with nothing to remove yet", JSON.stringify(wc.removed));

  // The SSO round trip: same webContents, brand new document.
  await wc.domReady("https://claude.ai/new");
  ok(wc.inserted.length === 2,
     "and so does the page the login navigates to - THIS is the regression",
     wc.inserted.length + " insertCSS call(s)");
  ok(wc.inserted[0] === wc.inserted[1], "both times with the very same stylesheet");
  ok(wc.inserted[0].includes(".cdbx-panel"),
     "which is the real panel stylesheet, not an empty placeholder",
     wc.inserted[0].length + " bytes");
}

// --- [2] the old key is dropped, so sheets cannot stack ---------------------
section("[2] the previous document's sheet is dropped before the new one goes in");
{
  const inst = install();
  const wc = makeWebContents(inst, "a");

  await wc.domReady("https://claude.ai/login");
  ok(wc.removed.length === 0, "the first insert removes nothing");
  const firstKey = wc.keys[0];

  await wc.domReady("https://claude.ai/new");
  ok(wc.removed.length === 1, "the second insert removes exactly one sheet",
     JSON.stringify(wc.removed));
  ok(wc.removed[0] === firstKey, "namely the key the first insertCSS resolved with",
     wc.removed[0] + " vs " + firstKey);

  await wc.domReady("https://claude.ai/chat/x");
  ok(wc.removed.length === 2 && wc.removed[1] === wc.keys[1],
     "and a third navigation drops the second key, never an older one",
     JSON.stringify(wc.removed));
  ok(wc.inserted.length === 3, "with one insert per navigation throughout");
}

// --- [3] the URL guards -----------------------------------------------------
section("[3] non-remote pages are left alone");
{
  for (const url of ["file:///usr/lib/claude-desktop/resources/app.asar/index.html",
                     "about:blank",
                     "devtools://devtools/bundled/devtools_app.html",
                     "http://localhost:1234/",
                     "http://127.0.0.1:5173/index.html",
                     "chrome-extension://abc/page.html"]) {
    const inst = install();
    const wc = makeWebContents(inst, "a");
    await wc.domReady(url);
    ok(wc.inserted.length === 0 && wc.executed.length === 0,
       "no stylesheet and no page script for " + url,
       wc.inserted.length + " css / " + wc.executed.length + " script");
  }

  // The real main window: the local shell page first, the remote page after.
  const inst = install();
  const wc = makeWebContents(inst, "a");
  await wc.domReady("file:///usr/lib/claude-desktop/resources/app.asar/index.html");
  await wc.domReady("https://claude.ai/login");
  ok(wc.inserted.length === 1 && wc.removed.length === 0,
     "a skipped file:// page does not consume the first insert, nor leave a key behind",
     wc.inserted.length + " css / " + wc.removed.length + " removed");
}

// --- [4] the page script runs on every load too -----------------------------
section("[4] the page script is re-run per navigation, like the stylesheet");
{
  const inst = install();
  const wc = makeWebContents(inst, "a");
  await wc.domReady("https://claude.ai/login");
  await wc.domReady("https://claude.ai/new");
  ok(wc.executed.length === 2, "executeJavaScript ran for both loads", String(wc.executed.length));
  ok(wc.executed[0] === wc.executed[1], "with identical source");
  ok(wc.executed[0].length > 100, "which is the real page script",
     wc.executed[0].length + " bytes");
}

// --- [5] a rejected insert is reported, not swallowed -----------------------
section("[5] a failed insertCSS reaches the diagnostics log");
{
  const inst = install();
  const wc = makeWebContents(inst, "a");
  wc.rejectInsertOnce = true;
  await wc.domReady("https://claude.ai/login");
  const line = inst.diag.find((m) => String(m).includes("insertCSS rejected"));
  ok(!!line, "the rejection is logged", line || inst.diag.join(" | "));
  ok(!!line && line.includes("no document to insert into"),
     "carrying the reason, so a real failure can be diagnosed from the log file");

  // A failed insert stores no key, so the next navigation must not try to
  // remove one - that would be a removeInsertedCSS on a key that never existed.
  await wc.domReady("https://claude.ai/new");
  ok(wc.removed.length === 0, "and leaves no phantom key behind for the next load",
     JSON.stringify(wc.removed));
  ok(wc.inserted.length === 2, "while the next navigation still gets its sheet");
}

// --- [6] one webContents never touches another's sheet ----------------------
section("[6] every webContents keeps its own sheet");
{
  const inst = install();
  const a = makeWebContents(inst, "a");
  const b = makeWebContents(inst, "b");

  await a.domReady("https://claude.ai/new");
  await b.domReady("https://claude.ai/settings");
  ok(b.inserted.length === 1, "a second webContents gets its own first insert");
  ok(b.removed.length === 0, "and removes nothing on it", JSON.stringify(b.removed));
  ok(a.removed.length === 0, "nor does anything get removed from the first one");

  await b.domReady("https://claude.ai/recents");
  ok(b.removed.length === 1 && b.removed[0] === b.keys[0],
     "its own second load drops its own key", JSON.stringify(b.removed));
  ok(a.keys.indexOf(b.removed[0]) < 0, "which is never the other webContents' key",
     b.removed[0] + " not in " + JSON.stringify(a.keys));
  ok(a.removed.length === 0, "and the first webContents is still untouched");
}

console.log("\n" + (fail ? `${pass} passed, ${fail} FAILED` : `ALL ${pass} CHECKS PASSED`));
process.exit(fail ? 1 : 0);
