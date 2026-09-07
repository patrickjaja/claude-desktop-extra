/*
 * theme-engine-harness.mjs - shared plumbing for the theme/spinner test suites
 * (core/test-spinner-main.mjs, core/test-spinner-dom.mjs, core/test-theme-scope.mjs,
 * core/test-theme-inherit-reload.mjs, community/test-picker-gaming.mjs).
 *
 * The theme engine is a JS IIFE that patches/core/add_feature_custom_themes.nim PREPENDS to
 * the main bundle, so the only faithful way to test it is to run the real compiled patch
 * and execute what it produced. That is what buildInjectedModule() does: it applies the
 * patch binary to a file containing nothing but `"use strict";`, which leaves a
 * standalone CommonJS module holding the engine and nothing else.
 *
 * No npm dependency: electron is shimmed with a plain object, and the DOM suites drive
 * a headless Chromium that is already on the machine. Every suite is deterministic -
 * fixtures are defined in the suites, and the assertions that DO look at bundled data
 * read it from js/*.json rather than hardcoding today's contents.
 *
 * Exit code 3 means SKIP (a tool this suite needs is not installed);
 * scripts/validate-patches.sh treats it as SKIP rather than FAIL.
 */
import { readFileSync, writeFileSync, mkdtempSync, existsSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { unescapeHtml } from "./unescape-html.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const SKIP_EXIT = 3;
const PATCH_BIN = join(ROOT, "patches", "core", "add_feature_custom_themes");

export class Skip extends Error {}

/** Run the real patch binary over a bare "use strict"; file -> the engine as a module. */
export function buildInjectedModule() {
  if (!existsSync(PATCH_BIN)) {
    // Not compiled yet: try, but never make installing a toolchain this suite's problem.
    try {
      execFileSync("make", ["-C", join(ROOT, "patches"), "core/add_feature_custom_themes"],
        { stdio: "ignore" });
    } catch {}
  }
  if (!existsSync(PATCH_BIN)) {
    throw new Skip("patches/core/add_feature_custom_themes is not compiled " +
      "(run: make -C patches core/add_feature_custom_themes)");
  }
  try { chmodSync(PATCH_BIN, 0o755); } catch {}
  const dir = mkdtempSync(join(tmpdir(), "cdb-engine-"));
  const mod = join(dir, "engine.cjs");
  writeFileSync(mod, '"use strict";\n');
  execFileSync(PATCH_BIN, [mod], { stdio: "ignore" });
  const src = readFileSync(mod, "utf8");
  if (!src.includes("globalThis.__cdbThemes=")) {
    throw new Error("the patch did not inject the theme engine into the stub module");
  }
  return mod;
}

/**
 * Load the engine with electron shimmed. `config` (an object) is written to
 * claude-desktop-extra.jsonc in a fresh userData dir BEFORE the engine boots, which is
 * how the engine sees themes and an activeTheme. `files` ({ "<relative path>": text })
 * seeds further files under userData first - claude-desktop-extra.json, themes.d/*.json
 * - so the loader's precedence and the themes.d/ reader can be exercised from boot.
 */
export function installEngine({ config, files } = {}) {
  const require2 = createRequire(import.meta.url);
  const fs = require2("fs"), os = require2("os"), path = require2("path");
  const Module = require2("module");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cdb-userdata-"));
  for (const rel of Object.keys(files || {})) {
    const abs = path.join(userData, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, files[rel]);
  }
  if (config) {
    fs.writeFileSync(path.join(userData, "claude-desktop-extra.jsonc"),
      JSON.stringify(config, null, 2));
  }
  const appEvents = {};
  const fakeElectron = { app: { getPath: () => userData, on: (e, f) => (appEvents[e] = f) } };
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    return req === "electron" ? fakeElectron : orig.call(this, req, ...rest);
  };
  const diag = [];
  globalThis.__cdbDiag = (m) => diag.push(m);
  try {
    require2(buildInjectedModule());
  } finally {
    Module._load = orig;
  }
  return { themes: globalThis.__cdbThemes, appEvents, diag, userData };
}

/** A webContents that records every insertCSS / executeJavaScript it is handed. */
export function mkWc(url = "https://claude.ai/new") {
  const ev = {};
  let keyN = 0;
  const wc = {
    css: [], js: [], removedKeys: [], destroyed: false,
    getURL: () => url,
    on: (e, fn) => { ev[e] = fn; },
    once: (e, fn) => { ev[e] = fn; },
    isDestroyed: () => wc.destroyed,
    insertCSS: (c) => { wc.css.push(c); return Promise.resolve("k" + ++keyN); },
    removeInsertedCSS: (k) => { wc.removedKeys.push(k); return Promise.resolve(); },
    executeJavaScript: (s) => { wc.js.push(s); return Promise.resolve(); },
    fire: (e) => ev[e] && ev[e](),
    sheet: () => wc.css[wc.css.length - 1],
  };
  return wc;
}

/** The main process pushes "var __CDB_SPINNER_SPEC=<json>;\n<injector>" - read the spec back. */
export function lastSpinnerPayload(wc) {
  return wc.js.filter((s) => s.indexOf("var __CDB_SPINNER_SPEC=") === 0).pop();
}
export function pushedSpec(wc) {
  const p = lastSpinnerPayload(wc);
  if (!p) return undefined;
  const m = /^var __CDB_SPINNER_SPEC=([\s\S]*?);\n/.exec(p);
  return m ? JSON.parse(m[1]) : undefined;
}

/** Let the engine's insertCSS/executeJavaScript promises settle. */
export const settle = () => new Promise((r) => setTimeout(r, 25));

export function readJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
}

export function findChromium() {
  for (const c of ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"]) {
    try {
      const p = execFileSync("/bin/sh", ["-c", "command -v " + c], { encoding: "utf8" }).trim();
      if (p) return p;
    } catch {}
  }
  return null;
}

/**
 * Load a page in headless Chromium and return its dumped DOM. Virtual time keeps the
 * async steps (rAF-debounced observer sweeps, promise chains) deterministic instead of
 * racing the dump.
 */
export function dumpDom(chromium, pagePath, extraArgs = []) {
  return execFileSync(chromium, [
    "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--virtual-time-budget=5000", ...extraArgs, "--dump-dom", "file://" + pagePath,
  ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}

/** Pull the PASS/FAIL lines a page wrote into <pre id="..."> back out of the dumped DOM. */
export function readProbe(dom, id) {
  const m = new RegExp('<pre id="' + id + '"[^>]*>([\\s\\S]*?)</pre>').exec(dom);
  if (!m) return null;
  return unescapeHtml(m[1]).trim().split("\n");
}

/** Console reporter shared by all three suites. */
export function reporter(title) {
  let fails = 0, checks = 0;
  console.log(title);
  return {
    ok(cond, label, extra) {
      checks++;
      if (!cond) fails++;
      console.log((cond ? "  PASS " : "  FAIL ") + label + (extra ? "  -> " + extra : ""));
    },
    note(msg) { console.log("  note  " + msg); },
    section(msg) { console.log("\n" + msg); },
    /** Report the page's own lines (DOM suites) as our results. */
    lines(list) {
      for (const l of list) {
        checks++;
        if (l.startsWith("FAIL")) fails++;
        console.log("  " + l);
      }
    },
    done() {
      console.log("\n" + (fails === 0
        ? "ALL " + checks + " CHECKS PASSED"
        : fails + "/" + checks + " CHECK(S) FAILED"));
      process.exit(fails === 0 ? 0 : 1);
    },
  };
}

/** Wrap a suite so a missing tool exits SKIP instead of FAIL. */
export async function runSuite(fn) {
  try {
    await fn();
  } catch (e) {
    if (e instanceof Skip) {
      console.log("  SKIP  " + e.message);
      process.exit(SKIP_EXIT);
    }
    throw e;
  }
}
