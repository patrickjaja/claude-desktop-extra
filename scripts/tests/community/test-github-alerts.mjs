#!/usr/bin/env node
/*
 * test-github-alerts.mjs - the "GitHub alert callouts" and "Alert icons"
 * community switches (patches/community/add_feature_github_alerts.nim ->
 * js/github_alerts_main.js + js/github_alerts_page.js + js/github_alerts.css).
 *
 * Runs the real main module with electron shimmed and a temporary userData dir.
 * Checks the two config keys and their .jsonc precedence (the feature off by
 * default, icons off by default, .jsonc wins per key, an unparsable file means
 * off rather than a throw), that a claude.ai page gets the stylesheet and the
 * page script, that a disabled install injects nothing, and that the refresh
 * hook re-runs the page in open windows. Then runs the compiled patch on a
 * bundle-head fixture (marker, idempotency, syntax).
 *
 * Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import Module from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MODULE_PATH = join(ROOT, "js/github_alerts_main.js");
const PATCH_BIN = join(ROOT, "patches", "community", "add_feature_github_alerts");
const MARKER = "/*__CDB_GITHUB_ALERTS__*/";
const SKIP_EXIT = 3;

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };

if (!existsSync(MODULE_PATH)) {
  console.log("  FAIL js/github_alerts_main.js is missing");
  process.exit(1);
}

// Loads the module once (the module guards itself on globalThis), with a fake
// electron app whose created-webContents handler and page calls are recorded.
function load(dir) {
  const created = [];
  const appHandlers = {};
  const electron = {
    app: {
      getPath: () => dir,
      on: (ev, fn) => { appHandlers[ev] = fn; },
      whenReady: () => Promise.resolve()
    },
    webContents: { getAllWebContents: () => created }
  };
  const sandbox = {
    require: (m) => (m === "electron" ? electron : Module.createRequire(import.meta.url)(m)),
    process: { platform: "linux", env: {}, pid: process.pid },
    console, setTimeout, clearTimeout
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(readFileSync(MODULE_PATH, "utf8"), ctx);
  return { created, appHandlers, sandbox };
}

// A page whose every webContents call is recorded. domReady() fires the hook the
// module registered on the created webContents.
function page(url) {
  const rec = { css: [], js: [], removed: [] };
  const wcHandlers = {};
  const wc = {
    getURL: () => url,
    isDestroyed: () => false,
    on: (ev, fn) => { wcHandlers[ev] = fn; },
    insertCSS: (css) => { rec.css.push(css); return Promise.resolve("cdb-css-key"); },
    removeInsertedCSS: (key) => { rec.removed.push(key); return Promise.resolve(); },
    executeJavaScript: (src) => { rec.js.push(src); return Promise.resolve(); }
  };
  rec.wc = wc;
  rec.domReady = () => wcHandlers["dom-ready"] && wcHandlers["dom-ready"]();
  return rec;
}

function boot(dir) {
  const t = load(dir);
  t.onCreated = (p) => {
    t.created.push(p.wc);
    t.appHandlers["web-contents-created"]({}, p.wc);
  };
  return t;
}

const once = (t, url) => {
  const p = page(url);
  t.onCreated(p);
  p.domReady();
  return p;
};

const wait = () => new Promise((r) => setTimeout(r, 0));

console.log("\nA. Off by default, and a non-browser page is never touched");
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-gha-"));
  const t = boot(dir);
  const p = once(t, "https://claude.ai/chat");
  await wait();
  ok(p.js.length === 0 && p.css.length === 0, "no config: nothing injected");
  const q = once(t, "https://example.com/");
  await wait();
  ok(q.js.length === 0 && q.css.length === 0, "a non-claude.ai page is skipped");
  rmSync(dir, { recursive: true });
}

console.log("\nB. Enabled from the .json, icons off by default");
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-gha-"));
  writeFileSync(join(dir, "claude-desktop-extra.json"), '{"githubAlerts": true}\n');
  const t = boot(dir);
  const p = once(t, "https://claude.ai/chat");
  await wait();
  // The module is loaded unpatched here, so the stylesheet is still its
  // placeholder. Section F proves the compiled patch embeds the real file.
  ok(p.css.length === 1 && /__CDB_GH_ALERTS_CSS__/.test(p.css[0]), "the stylesheet is inserted");
  ok(p.js.length === 1 && /__CDB_GH_ALERTS_OPTS/.test(p.js[0]), "the page script is run with its options");
  ok(/"enabled":true/.test(p.js[0]) && /"icons":false/.test(p.js[0]), "enabled:true, icons:false: " + p.js[0].slice(0, 70));
  rmSync(dir, { recursive: true });
}

console.log("\nC. Icons on, and the .jsonc wins per key");
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-gha-"));
  writeFileSync(join(dir, "claude-desktop-extra.json"), '{"githubAlerts": true}\n');
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"), '// comment\n{"githubAlertIcons": true,}\n');
  const t = boot(dir);
  const p = once(t, "https://claude.ai/chat");
  await wait();
  ok(p.js.length === 1 && /"icons":true/.test(p.js[0]), "jsonc turns icons on (and a trailing comma parses)");

  writeFileSync(join(dir, "claude-desktop-extra.json"), '{"githubAlerts": true}\n');
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"), '{"githubAlerts": false}\n');
  const t2 = boot(dir);
  const p2 = once(t2, "https://claude.ai/chat");
  await wait();
  ok(p2.js.length === 0 && p2.css.length === 0, "jsonc false wins over json true: nothing injected");
  rmSync(dir, { recursive: true });
}

console.log("\nD. An unparsable config means off, not a crash");
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-gha-"));
  writeFileSync(join(dir, "claude-desktop-extra.json"), "{not json");
  const t = boot(dir);
  let threw = false;
  let p;
  try { p = once(t, "https://claude.ai/chat"); } catch { threw = true; }
  await wait();
  ok(!threw && p && p.js.length === 0, "invalid JSON: off and no throw");
  rmSync(dir, { recursive: true });
}

console.log("\nE. Turning it off tears the open pages down");
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-gha-"));
  writeFileSync(join(dir, "claude-desktop-extra.json"), '{"githubAlerts": true}\n');
  const t = boot(dir);
  const p = once(t, "https://claude.ai/chat");
  await wait();
  ok(p.js.length === 1, "enabled page injected");
  writeFileSync(join(dir, "claude-desktop-extra.json"), '{"githubAlerts": false}\n');
  t.sandbox.globalThis.__cdbGithubAlertsRefresh();
  await wait();
  ok(p.js.length === 2 && /"enabled":false/.test(p.js[1]), "refresh after off sends the teardown run");
  ok(p.removed.length === 1, "the inserted stylesheet is dropped");
  rmSync(dir, { recursive: true });
}

console.log("\nF. The two rows and their bridge methods are wired");
{
  const page = readFileSync(join(ROOT, "js/extra_settings_page.js"), "utf8");
  const bridge = readFileSync(join(ROOT, "js/extra_settings_bridge.js"), "utf8");
  const main = readFileSync(join(ROOT, "js/extra_settings_main.js"), "utf8");
  ok(/var FEATURE_GROUPS = [\s\S]*?renderGithubAlertsRow[\s\S]*?renderGithubAlertIconsRow/.test(page),
    "both rows are listed in FEATURE_GROUPS");
  ok(/"cdb-github-alerts:read"[\s\S]*?"cdb-alert-icons:set"/.test(main), "all four handlers exist");
  ok(/githubAlertsRead[\s\S]*?githubAlertIconsSet/.test(bridge), "the bridge exposes both pairs");
  ok(/cdb-github-alerts:[\s\S]*?Linux only|GitHub alert callouts are Linux only/.test(main),
    "non-Linux answers a refusal that the rows hide on");
}

console.log("\nG. Compiled patch on a bundle-head fixture");
try {
  accessSync(PATCH_BIN, constants.X_OK);
  const dir = mkdtempSync(join(tmpdir(), "cdb-gha-"));
  const fixture = join(dir, "index.js");
  writeFileSync(fixture, `"use strict";var upstream=1;`);
  const run = () => spawnSync(PATCH_BIN, [fixture], { encoding: "utf8" });
  ok(run().status === 0, "first run exits 0");
  const patched = readFileSync(fixture, "utf8");
  ok(patched.startsWith(`"use strict";`), "bundle still starts with the strict directive");
  ok(patched.split(MARKER).length - 1 === 1, "marker present once");
  ok(/cdb-alert-host/.test(patched) && /__CDB_GH_ALERTS_OPTS/.test(patched), "page script and stylesheet are embedded");
  ok(spawnSync(process.execPath, ["--check", fixture]).status === 0, "patched bundle passes node --check");
  ok(run().status === 0 && readFileSync(fixture, "utf8") === patched, "second run is idempotent");
  rmSync(dir, { recursive: true });
} catch {
  console.log("  SKIP patch binary not compiled: " + PATCH_BIN + " (cd patches && make)");
  if (fail === 0) { console.log(`\n${pass} passed, 0 failed (patch part skipped)`); process.exit(SKIP_EXIT); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
