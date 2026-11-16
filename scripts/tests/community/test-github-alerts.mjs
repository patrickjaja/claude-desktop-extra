#!/usr/bin/env node
/*
 * test-github-alerts.mjs - the "GitHub alert callouts" and "Alert icons"
 * community switches (patches/community/add_feature_github_alerts.nim ->
 * js/github_alerts_main.js + js/github_alerts_page.js + js/github_alerts.css).
 *
 * Runs the real main module with electron shimmed and a temporary userData dir
 * (1P claude.ai / claude.com + 3P app://localhost routing, .jsonc precedence,
 * rapid ON -> OFF insertCSS race, __cdbDiag log lines, teardown refresh), then
 * runs the compiled patch on a bundle-head fixture, drives a headless Chromium
 * DOM & computed-style suite against the real page script + stylesheet, and
 * validates the compiled patch against a pristine tmp/app.asar.contents
 * extract when present.
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
import { findChromium, dumpDom, readProbe } from "../lib/theme-engine-harness.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MODULE_PATH = join(ROOT, "js/github_alerts_main.js");
const PAGE_PATH = join(ROOT, "js/github_alerts_page.js");
const CSS_PATH = join(ROOT, "js/github_alerts.css");
const PATCH_BIN = join(ROOT, "patches", "community", "add_feature_github_alerts");
const PRISTINE = join(ROOT, "tmp", "app.asar.contents", ".vite", "build", "index.js");
const MARKER = "/*__CDB_GITHUB_ALERTS__*/";
const SKIP_EXIT = 3;

let pass = 0, fail = 0;
const skippedTools = [];
const ok = (c, n) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };

if (!existsSync(MODULE_PATH) || !existsSync(PAGE_PATH) || !existsSync(CSS_PATH)) {
  console.log("  FAIL js/github_alerts_* asset(s) missing");
  process.exit(1);
}

// Loads the module once (the module guards itself on globalThis), with a fake
// electron app whose created-webContents handler and page calls are recorded.
function load(dir, opts = {}) {
  const created = [];
  const appHandlers = {};
  const diags = [];
  let readyResolve;
  const readyPromise = opts.deferReady ? new Promise((r) => { readyResolve = r; }) : Promise.resolve();
  const electron = {
    app: {
      getPath: () => { if (dir === null) throw new Error("no userData"); return dir; },
      on: (ev, fn) => { appHandlers[ev] = fn; },
      whenReady: () => readyPromise
    },
    webContents: { getAllWebContents: () => created }
  };
  const sandbox = {
    require: (m) => (m === "electron" ? electron : Module.createRequire(import.meta.url)(m)),
    process: { platform: "linux", env: {}, pid: process.pid },
    console, setTimeout, clearTimeout
  };
  if (opts.diag) sandbox.__cdbDiag = (line) => diags.push(String(line));
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(readFileSync(MODULE_PATH, "utf8"), ctx);
  return { created, appHandlers, sandbox, diags, readyResolve };
}

// A page whose every webContents call is recorded. domReady() fires the hook the
// module registered on the created webContents.
function page(url, opts = {}) {
  const rec = { css: [], js: [], removed: [], pendingCss: [] };
  const wcHandlers = {};
  let keyN = 0;
  const wc = {
    getURL: () => url,
    isDestroyed: () => false,
    on: (ev, fn) => { wcHandlers[ev] = fn; },
    insertCSS: (css) => {
      rec.css.push(css);
      const key = "cdb-css-key-" + (++keyN);
      if (opts.deferCss) {
        return new Promise((res) => rec.pendingCss.push(() => res(key)));
      }
      return Promise.resolve(key);
    },
    removeInsertedCSS: (key) => { rec.removed.push(key); return Promise.resolve(); },
    executeJavaScript: (src) => { rec.js.push(src); return Promise.resolve(); }
  };
  rec.wc = wc;
  rec.setURL = (u) => { url = u; };
  rec.domReady = () => wcHandlers["dom-ready"] && wcHandlers["dom-ready"]();
  rec.flushCss = (idx) => {
    if (idx === undefined) {
      const all = rec.pendingCss.splice(0);
      all.forEach((f) => f());
    } else if (rec.pendingCss[idx]) {
      const f = rec.pendingCss[idx];
      rec.pendingCss[idx] = null;
      f();
    }
  };
  return rec;
}

function boot(dir, opts) {
  const t = load(dir, opts);
  t.onCreated = (p) => {
    t.created.push(p.wc);
    t.appHandlers["web-contents-created"]({}, p.wc);
  };
  return t;
}

const once = (t, url, opts) => {
  const p = page(url, opts);
  t.onCreated(p);
  p.domReady();
  return p;
};

const wait = () => new Promise((r) => setTimeout(r, 0));

console.log("\nA. Off by default, and non-chat pages are never touched");
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-gha-"));
  const t = boot(dir, { diag: true });
  const p = once(t, "https://claude.ai/chat");
  await wait();
  ok(p.js.length === 0 && p.css.length === 0, "no config: nothing injected");
  ok(t.diags.some((d) => d === "[github-alerts] installed (main); githubAlerts=false, githubAlertIcons=false"),
    "startup diagnostic queued and flushed through __cdbDiag");
  const q = once(t, "https://example.com/");
  await wait();
  ok(q.js.length === 0 && q.css.length === 0, "a non-claude.ai page is skipped");
  // getPath throwing falls back to both off (including icons:false)
  const bad = boot(null, { diag: true });
  await wait();
  ok(bad.diags.some((d) => d === "[github-alerts] installed (main); githubAlerts=false, githubAlertIcons=false"),
    "getPath failure falls back to githubAlerts=false, githubAlertIcons=false");
  rmSync(dir, { recursive: true });
}

console.log("\nB. Enabled from .json (1P + 3P app://localhost), icons off by default");
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-gha-"));
  writeFileSync(join(dir, "claude-desktop-extra.json"), '{"githubAlerts": true}\n');
  const t = boot(dir, { diag: true });
  const p = once(t, "https://claude.ai/chat");
  const p3 = once(t, "app://localhost/chat");
  const pRoot = once(t, "app://localhost/");
  const pSetup = once(t, "app://localhost/setup-desktop-3p");
  const pSetupSlash = once(t, "app://localhost//setup-desktop-3p");
  const pSetupQuery = once(t, "app://localhost/setup-desktop-3p?step=2");
  const pBadPort = once(t, "app://localhost:1234/chat");
  const pHttp = once(t, "http://claude.ai/chat");
  await wait();
  // The module is loaded unpatched here, so the stylesheet is still its
  // placeholder. Section G proves the compiled patch embeds the real file.
  ok(p.css.length === 1 && /__CDB_GH_ALERTS_CSS__/.test(p.css[0]), "the stylesheet is inserted on 1P");
  ok(p.js.length === 1 && /__CDB_GH_ALERTS_OPTS/.test(p.js[0]), "the page script is run with its options");
  ok(/"enabled":true/.test(p.js[0]) && /"icons":false/.test(p.js[0]), "enabled:true, icons:false: " + p.js[0].slice(0, 70));
  ok(p3.css.length === 1 && p3.js.length === 1, "3P app://localhost/chat is injected");
  ok(pRoot.css.length === 1 && pRoot.js.length === 1, "3P app://localhost/ is injected");
  ok(pSetup.css.length === 0 && pSetup.js.length === 0, "3P /setup-desktop-3p is skipped");
  ok(pSetupSlash.css.length === 0 && pSetupSlash.js.length === 0, "3P //setup-desktop-3p is skipped");
  ok(pSetupQuery.css.length === 0 && pSetupQuery.js.length === 0, "3P /setup-desktop-3p?step=2 is skipped");
  ok(pBadPort.css.length === 0 && pBadPort.js.length === 0, "app://localhost:1234 is skipped");
  ok(pHttp.css.length === 0 && pHttp.js.length === 0, "non-https http://claude.ai is skipped");
  rmSync(dir, { recursive: true });
}

console.log("\nC. Icons on, and the .jsonc wins per key");
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-gha-"));
  writeFileSync(join(dir, "claude-desktop-extra.json"), '{"githubAlerts": true}\n');
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"), '// comment\n{"githubAlertIcons": true,}\n');
  const t = boot(dir, { diag: true });
  const p = once(t, "https://claude.ai/chat");
  await wait();
  ok(p.js.length === 1 && /"icons":true/.test(p.js[0]), "jsonc turns icons on (and a trailing comma parses)");

  writeFileSync(join(dir, "claude-desktop-extra.json"), '{"githubAlerts": true}\n');
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"), '{"githubAlerts": false}\n');
  const t2 = boot(dir, { diag: true });
  const p2 = once(t2, "https://claude.ai/chat");
  await wait();
  ok(p2.js.length === 0 && p2.css.length === 0, "jsonc false wins over json true: nothing injected");
  rmSync(dir, { recursive: true });
}

console.log("\nD. An unparsable config means off, not a crash");
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-gha-"));
  writeFileSync(join(dir, "claude-desktop-extra.json"), "{not json");
  const t = boot(dir, { diag: true });
  let threw = false;
  let p;
  try { p = once(t, "https://claude.ai/chat"); } catch { threw = true; }
  await wait();
  ok(!threw && p && p.js.length === 0, "invalid JSON: off and no throw");
  rmSync(dir, { recursive: true });
}

console.log("\nE. Turning it off tears open pages down & cancels stale insertCSS resolves");
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-gha-"));
  writeFileSync(join(dir, "claude-desktop-extra.json"), '{"githubAlerts": true}\n');
  const t = boot(dir, { diag: true });
  const p = once(t, "https://claude.ai/chat");
  await wait();
  ok(p.js.length === 1, "enabled page injected");
  writeFileSync(join(dir, "claude-desktop-extra.json"), '{"githubAlerts": false}\n');
  t.sandbox.globalThis.__cdbGithubAlertsRefresh();
  await wait();
  ok(p.js.length === 2 && /"enabled":false/.test(p.js[1]), "refresh after off sends the teardown run");
  ok(p.removed.length === 1, "the inserted stylesheet is dropped");
  ok(t.diags.some((d) => d === "[github-alerts] refresh: githubAlerts=false, githubAlertIcons=false"),
    "refresh logs current flag state through __cdbDiag");

  // Rapid ON -> OFF async insertCSS race
  writeFileSync(join(dir, "claude-desktop-extra.json"), '{"githubAlerts": true}\n');
  const racePage = once(t, "https://claude.ai/chat-race", { deferCss: true });
  writeFileSync(join(dir, "claude-desktop-extra.json"), '{"githubAlerts": false}\n');
  t.sandbox.globalThis.__cdbGithubAlertsRefresh();
  ok(racePage.removed.length === 0, "before delayed insertCSS resolves, no key removed yet");
  racePage.flushCss(0);
  await wait();
  ok(racePage.removed.length === 1 && racePage.removed[0] === "cdb-css-key-1",
    "delayed ON insertCSS resolving after OFF immediately calls removeInsertedCSS");

  // Rapid ON -> OFF -> ON race: first stale key dropped, second kept until OFF
  writeFileSync(join(dir, "claude-desktop-extra.json"), '{"githubAlerts": true}\n');
  t.sandbox.globalThis.__cdbGithubAlertsRefresh(); // gen 3, key-2 pending
  writeFileSync(join(dir, "claude-desktop-extra.json"), '{"githubAlerts": false}\n');
  t.sandbox.globalThis.__cdbGithubAlertsRefresh(); // gen 4
  writeFileSync(join(dir, "claude-desktop-extra.json"), '{"githubAlerts": true}\n');
  t.sandbox.globalThis.__cdbGithubAlertsRefresh(); // gen 5, key-3 pending
  racePage.flushCss(1); // resolve key-2 (gen 3 !== 5)
  racePage.flushCss(2); // resolve key-3 (gen 5 === 5)
  await wait();
  ok(racePage.removed.join(",") === "cdb-css-key-1,cdb-css-key-2",
    "stale ON key-2 is immediately dropped while current ON key-3 is retained");
  writeFileSync(join(dir, "claude-desktop-extra.json"), '{"githubAlerts": false}\n');
  t.sandbox.globalThis.__cdbGithubAlertsRefresh();
  await wait();
  ok(racePage.removed.join(",") === "cdb-css-key-1,cdb-css-key-2,cdb-css-key-3",
    "turning OFF later drops the retained key-3");

  // Navigating an injected tab away to a non-matching origin drops its stylesheet
  writeFileSync(join(dir, "claude-desktop-extra.json"), '{"githubAlerts": true}\n');
  const navPage = once(t, "https://claude.ai/chat-nav");
  await wait();
  navPage.setURL("https://sso.example.com/login");
  navPage.domReady();
  await wait();
  ok(navPage.removed.length === 1 && navPage.removed[0] === "cdb-css-key-1",
    "navigating away from claude.ai drops previously inserted CSS");

  rmSync(dir, { recursive: true });
}

console.log("\nF. The two rows and their bridge methods are wired");
{
  const pageSrc = readFileSync(join(ROOT, "js/extra_settings_page.js"), "utf8");
  const bridge = readFileSync(join(ROOT, "js/extra_settings_bridge.js"), "utf8");
  const main = readFileSync(join(ROOT, "js/extra_settings_main.js"), "utf8");
  ok(/var FEATURE_GROUPS = [\s\S]*?renderGithubAlertsRow[\s\S]*?renderGithubAlertIconsRow/.test(pageSrc),
    "both rows are listed in FEATURE_GROUPS");
  ok(/"cdb-github-alerts:read"[\s\S]*?"cdb-alert-icons:set"/.test(main), "all four handlers exist");
  ok(/githubAlertsRead[\s\S]*?githubAlertIconsSet/.test(bridge), "the bridge exposes both pairs");
  ok(/cdb-github-alerts:[\s\S]*?Linux only|GitHub alert callouts are Linux only/.test(main),
    "non-Linux answers a refusal that the rows hide on");
}

let patchBinOk = false;
console.log("\nG. Compiled patch on a bundle-head fixture");
try {
  accessSync(PATCH_BIN, constants.X_OK);
  patchBinOk = true;
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
  skippedTools.push("patch-bin");
}

console.log("\nH. Headless Chromium DOM & computed-style suite");
{
  const chromium = findChromium();
  if (!chromium) {
    console.log("  SKIP no chromium/chrome on this machine");
    skippedTools.push("chromium");
  } else {
    const pageJs = readFileSync(PAGE_PATH, "utf8");
    const pageCss = readFileSync(CSS_PATH, "utf8");
    const dir = mkdtempSync(join(tmpdir(), "cdb-gha-dom-"));
    const htmlPath = join(dir, "alerts.html");
    const html = `<!doctype html>
<meta charset="utf-8">
<style>
  blockquote { border-left: 2px solid #ccc; padding-left: 1rem; margin: 1rem 0; }
  p { margin: 0.5rem 0; line-height: 1.5; }
  ul { margin: 0.5rem 0; padding-left: 1.5rem; }
  pre { margin: 0.5rem 0; padding: 0.5rem; background: rgb(240, 242, 245); }
  ${pageCss}
  .font-claude-response blockquote { font-style: italic; }
</style>
<body>
  <div class="font-claude-response">
    <blockquote id="merged">
      <p>[!NOTE]\nFirst body.</p>
      <p>Second para of note.</p>
      <p>[!WARNING]\nWatch out.</p>
    </blockquote>
  </div>

  <blockquote id="stream-bq"><p id="stream-p">[!NOTE]</p></blockquote>
  <blockquote id="midbr-bq"><p id="midbr-p">[!TIP]\nLine 1<br id="mid-br">Line 2</p></blockquote>

  <div contenteditable="true" id="ex-ce">
    <div class="ProseMirror" id="ex-pm">
      <blockquote id="bq-pm"><p>[!NOTE]<br>Composer quote</p></blockquote>
    </div>
    <blockquote id="bq-ce"><p>[!TIP] Editable quote</p></blockquote>
  </div>
  <div class="epitaxy-document-prose">
    <blockquote id="bq-doc"><p>[!NOTE] Doc prose</p></blockquote>
  </div>
  <blockquote data-alert="note" id="bq-native"><p>[!NOTE] Native alert</p></blockquote>
  <blockquote data-reply-quote-block="1" id="bq-reply"><p>[!NOTE] Reply quote</p></blockquote>
  <blockquote id="bq-code"><p><code>[!NOTE]</code> inline code</p></blockquote>

  <blockquote id="bq-pre-plain">
    <p id="pre-plain">Plain quote before alert</p>
    <p id="pre-alert">[!NOTE]\nAlert after plain quote</p>
  </blockquote>

  <blockquote id="bq-cont">
    <p id="cont-head">[!IMPORTANT]\nRead this:</p>
    <ul id="cont-ul"><li>Item 1</li></ul>
    <pre id="cont-pre"><code>x = 1</code></pre>
    <blockquote id="cont-nested"><p>Nested quote</p></blockquote>
  </blockquote>

  <blockquote id="bq-reuse"><p id="p-reuse">[!NOTE]\nOriginal</p></blockquote>
  <blockquote id="bq-change"><p id="p-change">[!WARNING]\nInitial</p></blockquote>
  <blockquote id="bq-comment"><p id="p-comment"><!-- ssr -->[!CAUTION]\nCareful.</p></blockquote>

  <pre id="out"></pre>
<script>
var PAGE_SRC = ${JSON.stringify(pageJs)};
var lines = [];
function ok(c, name, extra) {
  lines.push((c ? "PASS " : "FAIL ") + name + (extra !== undefined ? " -> " + extra : ""));
}
function push(opts) {
  window.__CDB_GH_ALERTS_OPTS = opts;
  (new Function(PAGE_SRC))();
}
function nonTitleText(el) {
  var out = "";
  for (var i = 0; i < el.childNodes.length; i++) {
    var n = el.childNodes[i];
    if (n.nodeType === 8) continue;
    if (n.nodeType === 1 && n.classList && n.classList.contains("cdb-alert-title")) continue;
    out += n.textContent || "";
  }
  return out;
}

window.requestAnimationFrame = function (fn) { return window.setTimeout(fn, 16); };

function step0() {
  // 1. Merged adjacent alerts with icons:false
  push({ enabled: true, icons: false });
  var merged = document.getElementById("merged");
  var mp = merged.querySelectorAll("p");
  ok(merged.classList.contains("cdb-alert-host"), "H1: merged blockquote has cdb-alert-host");
  ok(mp[0].classList.contains("cdb-alert-head") && mp[0].classList.contains("cdb-alert-note") &&
     mp[0].classList.contains("cdb-alert-first") && !mp[0].classList.contains("cdb-alert-last"),
     "H1: first alert head classed as NOTE head+first");
  ok(nonTitleText(mp[0]) === "First body.", "H1: marker stripped from first head: " + JSON.stringify(nonTitleText(mp[0])));
  ok(mp[1].classList.contains("cdb-alert-seg") && mp[1].classList.contains("cdb-alert-note") &&
     mp[1].classList.contains("cdb-alert-last") && !mp[1].classList.contains("cdb-alert-head"),
     "H1: continuation paragraph belongs to NOTE run");
  ok(mp[2].classList.contains("cdb-alert-head") && mp[2].classList.contains("cdb-alert-warning") &&
     mp[2].classList.contains("cdb-alert-only"),
     "H1: second alert head starts its own WARNING run");
  ok(getComputedStyle(mp[0], "::before").content === '"Note"',
     "H1: icons:false renders ::before label Note: " + getComputedStyle(mp[0], "::before").content);
  ok(getComputedStyle(mp[2], "::before").content === '"Warning"',
     "H1: icons:false renders ::before label Warning: " + getComputedStyle(mp[2], "::before").content);
  ok(parseFloat(getComputedStyle(mp[2]).marginTop) > 0,
     "H1: second merged alert head keeps positive top margin: " + getComputedStyle(mp[2]).marginTop);
  ok(!merged.querySelector(".cdb-alert-title"), "H1: no .cdb-alert-title when icons:false");
  ok(getComputedStyle(mp[0]).fontStyle === "normal",
     "H1: font-style: normal overrides .font-claude-response blockquote italic rule");

  // Switch icons:true
  push({ enabled: true, icons: true });
  ok(!!mp[0].querySelector(".cdb-alert-title svg.cdb-alert-ico") &&
     mp[0].querySelector(".cdb-alert-name").textContent === "Note",
     "H1: icons:true adds inline SVG title Note");
  ok(!!mp[2].querySelector(".cdb-alert-title svg.cdb-alert-ico") &&
     mp[2].querySelector(".cdb-alert-name").textContent === "Warning",
     "H1: icons:true adds inline SVG title Warning");
  ok(getComputedStyle(mp[0], "::before").content === "none",
     "H1: icons:true disables ::before pseudo-label");

  // Live toggle icons:true -> false -> true
  push({ enabled: true, icons: false });
  ok(!merged.querySelector(".cdb-alert-title") &&
     getComputedStyle(mp[0], "::before").content === '"Note"',
     "H1: live toggle icons:true -> false removes SVG title and restores ::before");
  push({ enabled: true, icons: true });
  ok(!!mp[0].querySelector(".cdb-alert-title svg.cdb-alert-ico"),
     "H1: live toggle back to icons:true restores SVG title");

  // 2. Streaming Token 1 state + mid-paragraph <br>
  var streamP = document.getElementById("stream-p");
  ok(streamP.classList.contains("cdb-alert-head-empty") &&
     getComputedStyle(streamP).lineHeight === "0px" &&
     !!streamP.querySelector(".cdb-alert-title"),
     "H2: Token 1 (<p>[!NOTE]</p>) gets cdb-alert-head-empty (line-height: 0) and title");
  var midBr = document.getElementById("mid-br");
  ok(!midBr.classList.contains("cdb-alert-lead-br") &&
     getComputedStyle(midBr).display !== "none",
     "H2: mid-paragraph <br> stays visible");

  // 4. Exclusions + leading plain quote before alert
  var excludedIds = ["bq-pm", "bq-ce", "bq-doc", "bq-native", "bq-reply", "bq-code"];
  for (var i = 0; i < excludedIds.length; i++) {
    var ex = document.getElementById(excludedIds[i]);
    ok(!ex.classList.contains("cdb-alert-host") &&
       !ex.querySelector(".cdb-alert-title") &&
       !ex.querySelector("[data-cdb-alert-type]") &&
       ex.textContent.indexOf("[!") >= 0,
       "H4: excluded blockquote untouched: " + excludedIds[i]);
  }
  var prePlain = document.getElementById("pre-plain");
  var preAlert = document.getElementById("pre-alert");
  ok(!prePlain.classList.contains("cdb-alert-seg") &&
     getComputedStyle(prePlain).borderLeftWidth === "2px",
     "H4: ungrouped leading paragraph keeps 2px quote border: " + getComputedStyle(prePlain).borderLeftWidth);
  ok(preAlert.classList.contains("cdb-alert-head") && preAlert.classList.contains("cdb-alert-first") &&
     parseFloat(getComputedStyle(preAlert).marginTop) > 0,
     "H4: alert following plain quote keeps positive top margin: " + getComputedStyle(preAlert).marginTop);

  // 5a. Continuation ul, pre, nested blockquote
  var contHead = document.getElementById("cont-head");
  var contUl = document.getElementById("cont-ul");
  var contPre = document.getElementById("cont-pre");
  var contNested = document.getElementById("cont-nested");
  ok(contUl.classList.contains("cdb-alert-seg") && getComputedStyle(contUl).borderLeftWidth === "3px" &&
     parseFloat(getComputedStyle(contUl).paddingLeft) > parseFloat(getComputedStyle(contHead).paddingLeft),
     "H5: continuation <ul> keeps 3px border-left and extra list indentation");
  ok(contPre.classList.contains("cdb-alert-seg") &&
     getComputedStyle(contPre).borderLeftWidth === "3px" &&
     getComputedStyle(contPre).backgroundColor === "rgb(240, 242, 245)",
     "H5: continuation <pre> keeps 3px border-left and preserves background: " + getComputedStyle(contPre).backgroundColor);
  window.__cdbGhAlerts.sweep();
  ok(contNested.classList.contains("cdb-alert-seg") && !contNested.classList.contains("cdb-alert-host") &&
     getComputedStyle(contNested).borderLeftWidth === "3px",
     "H5: nested <blockquote> keeps outer .cdb-alert-seg across sweeps");

  var pComment = document.getElementById("p-comment");
  ok(pComment.getAttribute("data-cdb-alert-type") === "caution" &&
     nonTitleText(pComment) === "Careful.",
     "H5: leading HTML comment node before [!CAUTION] upgrades cleanly");

  window.__cdbLogs = [];
  window.__cdbOrigLog = console.log;
  console.log = function () {
    window.__cdbLogs.push(Array.prototype.join.call(arguments, " "));
    if (window.__cdbOrigLog) window.__cdbOrigLog.apply(console, arguments);
  };

  var probeDiv = document.createElement("div");
  probeDiv.textContent = "unrelated";
  document.body.appendChild(probeDiv);
  probeDiv.firstChild.nodeValue = "changed";

  // Trigger Token 2 streaming update, React node reuse, and type change
  streamP.childNodes[1].nodeValue = "[!NOTE]";
  var leadBr = document.createElement("br");
  leadBr.id = "stream-lead-br";
  streamP.appendChild(leadBr);
  streamP.appendChild(document.createTextNode("The migration runs nightly."));

  var pReuse = document.getElementById("p-reuse");
  pReuse.childNodes[1].nodeValue = "Plain quote";

  var pChange = document.getElementById("p-change");
  pChange.childNodes[1].nodeValue = "[!TIP]\\nUpdated";

  window.setTimeout(step1, 60);
}

function step1() {
  console.log = window.__cdbOrigLog;
  ok(window.__cdbLogs.indexOf("[cdb-gh-alerts] upgraded 2 blockquote(s)") !== -1 &&
     window.__cdbLogs.length === 1,
     "H2: non-blockquote body mutation skips full-document blockquote rescan: " + JSON.stringify(window.__cdbLogs));

  // Verify H2 Token 2
  var streamP = document.getElementById("stream-p");
  var leadBr = document.getElementById("stream-lead-br");
  ok(streamP.querySelectorAll(".cdb-alert-title").length === 1,
     "H2: Token 2 keeps single .cdb-alert-title");
  ok(nonTitleText(streamP) === "The migration runs nightly.",
     "H2: Token 2 re-strips [!NOTE] despite .cdb-alert-title at firstChild: " + JSON.stringify(nonTitleText(streamP)));
  ok(leadBr.classList.contains("cdb-alert-lead-br") && getComputedStyle(leadBr).display === "none",
     "H2: Token 2 hides leading <br> via .cdb-alert-lead-br");
  ok(!streamP.classList.contains("cdb-alert-head-empty") &&
     parseFloat(getComputedStyle(streamP).lineHeight) > 0,
     "H2: Token 2 clears cdb-alert-head-empty (line-height=" + getComputedStyle(streamP).lineHeight + ")");

  // Verify H5 React node reuse -> plain quote
  var bqReuse = document.getElementById("bq-reuse");
  var pReuse = document.getElementById("p-reuse");
  ok(!bqReuse.classList.contains("cdb-alert-host") &&
     !pReuse.classList.contains("cdb-alert-seg") &&
     !pReuse.hasAttribute("data-cdb-alert-type") &&
     !pReuse.hasAttribute("data-cdb-alert-raw") &&
     !pReuse.querySelector(".cdb-alert-title") &&
     pReuse.textContent === "Plain quote",
     "H5: React node reuse clears stale alert attributes, classes and title");

  // Verify H5 React type change WARNING -> TIP
  var pChange = document.getElementById("p-change");
  var titleChange = pChange.querySelector(".cdb-alert-title");
  ok(pChange.getAttribute("data-cdb-alert-type") === "tip" &&
     pChange.classList.contains("cdb-alert-tip") &&
     !pChange.classList.contains("cdb-alert-warning") &&
     !!titleChange && titleChange.getAttribute("data-cdb-icon") === "tip" &&
     pChange.querySelector(".cdb-alert-name").textContent === "Tip" &&
     nonTitleText(pChange) === "Updated",
     "H5: type change updates attributes, classes and SVG title to Tip");

  // 3. Live teardown restores literal markers verbatim
  push({ enabled: false, icons: true });
  var merged = document.getElementById("merged");
  var mp = merged.querySelectorAll("p");
  ok(!merged.classList.contains("cdb-alert-host") &&
     !merged.querySelector(".cdb-alert-title") &&
     !merged.querySelector("[data-cdb-alert-type]") &&
     !merged.querySelector("[data-cdb-alert-raw]") &&
     !merged.querySelector(".cdb-alert-seg"),
     "H3: teardown strips all alert classes, titles and data attributes");
  ok(mp[0].textContent === "[!NOTE]\\nFirst body." &&
     mp[2].textContent === "[!WARNING]\\nWatch out.",
     "H3: teardown restores literal [!NOTE] and [!WARNING] markers verbatim: " +
     JSON.stringify([mp[0].textContent, mp[2].textContent]));
  ok(streamP.textContent === "[!NOTE]The migration runs nightly." &&
     !leadBr.classList.contains("cdb-alert-lead-br"),
     "H3: teardown restores streaming [!NOTE] and clears cdb-alert-lead-br");
  ok(!document.getElementById("bq-pm").textContent.indexOf("[!NOTE]") &&
     document.getElementById("bq-pm").textContent.indexOf("[!NOTE]") === 0,
     "H3: teardown leaves excluded ProseMirror content intact");
  var pComment = document.getElementById("p-comment");
  ok(pComment.firstChild && pComment.firstChild.nodeType === 8 &&
     pComment.textContent === "[!CAUTION]\\nCareful.",
     "H3: teardown restores [!CAUTION] after leading comment node without losing comment");

  // Re-enabling re-upgrades cleanly
  push({ enabled: true, icons: true });
  ok(merged.classList.contains("cdb-alert-host") &&
     mp[0].querySelector(".cdb-alert-name").textContent === "Note" &&
     nonTitleText(mp[0]) === "First body." &&
     mp[2].querySelector(".cdb-alert-name").textContent === "Warning" &&
     nonTitleText(mp[2]) === "Watch out." &&
     leadBr.classList.contains("cdb-alert-lead-br") &&
     !document.getElementById("bq-pm").classList.contains("cdb-alert-host"),
     "H3: re-enabling after teardown re-upgrades cleanly");

  document.getElementById("out").textContent = lines.join("\\n");
}

step0();
</script>
</body>`;
    writeFileSync(htmlPath, html, "utf8");
    const dom = dumpDom(chromium, htmlPath);
    const probeLines = readProbe(dom, "out");
    if (!probeLines) {
      ok(false, "Chromium DOM suite wrote results into #out");
    } else {
      for (const l of probeLines) {
        ok(l.startsWith("PASS "), l.replace(/^(PASS|FAIL)\s+/, ""));
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\nI. Pristine tmp/app.asar.contents bundle check");
{
  if (!patchBinOk) {
    console.log("  SKIP patch binary not compiled");
  } else if (!existsSync(PRISTINE) || /__cdb/.test(readFileSync(PRISTINE, "utf8"))) {
    console.log("  SKIP tmp/app.asar.contents/.vite/build/index.js missing or already patched");
  } else {
    const dir = mkdtempSync(join(tmpdir(), "cdb-gha-pristine-"));
    const copy = join(dir, "index.js");
    writeFileSync(copy, readFileSync(PRISTINE));
    const r1 = spawnSync(PATCH_BIN, [copy], { encoding: "utf8" });
    ok(r1.status === 0, "pristine bundle: first patch run exits 0");
    const after1 = readFileSync(copy, "utf8");
    ok(after1.split(MARKER).length - 1 === 1, "pristine bundle: marker present once");
    const r2 = spawnSync(PATCH_BIN, [copy], { encoding: "utf8" });
    ok(r2.status === 0 && readFileSync(copy, "utf8") === after1, "pristine bundle: second run is idempotent");
    ok(spawnSync(process.execPath, ["--check", copy]).status === 0, "pristine bundle: passes node --check");
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
if (skippedTools.length > 0) process.exit(SKIP_EXIT);
process.exit(0);
