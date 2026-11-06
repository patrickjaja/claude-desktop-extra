#!/usr/bin/env node
/*
 * test-window-transparency.mjs - main-process half of the transparent window.
 * Runs the real js/window_transparency.js with electron shimmed and a temporary
 * profile dir: which keys win, native titlebar opt-out, the IPC handlers, which
 * claude.ai webContents get the see-through CSS (main window only), and the
 * transparency slider's live stylesheet swap, locks, validation and the legacy
 * windowOpacity / CLAUDE_WINDOW_OPACITY compatibility.
 */
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import Module from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };

function load(dir, env = {}, native = false) {
  const handlers = {}, events = {}, windows = [];
  const electron = {
    app: { getPath: () => dir, on: (e, f) => { events[e] = f; } },
    BrowserWindow: { getAllWindows: () => windows.slice() },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    nativeTheme: { shouldUseDarkColors: true }
  };
  const sandbox = { require: (m) => (m === "electron" ? electron : Module.createRequire(import.meta.url)(m)),
    process: { platform: "linux", env }, console, setTimeout, __cdbNativeTb: () => native };
  sandbox.globalThis = sandbox;
  { const __c = vm.createContext(sandbox);
    vm.runInContext(readFileSync(new URL("../../../js/sender_guard.js", import.meta.url), "utf8"), __c);
    vm.runInContext(readFileSync(join(ROOT, "js/window_transparency.js"), "utf8"), __c); }
  return { handlers, events, windows, sandbox };
}
const sender = { sender: { getURL: () => "https://claude.ai/x", isDestroyed: () => false } };

{
  const dir = mkdtempSync(join(tmpdir(), "cdb-wt-"));
  let t = load(dir);
  ok(JSON.stringify(t.sandbox.__cdbWinTransExtra()) === "{}", "off by default: no extra options");
  const r0 = await t.handlers["cdb-wt:pref-read"](sender);
  ok(r0.ok && r0.enabled === false, "pref-read defaults to off");
  ok(r0.nativeTitlebar === false, "pref-read reports nativeTitlebar false");
  const s = await t.handlers["cdb-wt:pref-set"](sender, true);
  ok(s.ok && s.enabled === true, "pref-set turns it on");
  t = load(dir);
  const x = t.sandbox.__cdbWinTransExtra();
  ok(x.transparent === true && x.backgroundColor === "#00000000", "on: transparent + clear background");
  rmSync(dir, { recursive: true });
}
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-wt-"));
  writeFileSync(join(dir, "claude-desktop-extra.json"), '{"windowTransparency": true}');
  const n = load(dir, {}, true);
  ok(JSON.stringify(n.sandbox.__cdbWinTransExtra()) === "{}", "native titlebar: transparency skipped");
  const rn = await n.handlers["cdb-wt:pref-read"](sender);
  ok(rn.ok && rn.enabled === true && rn.nativeTitlebar === true, "pref-read reports nativeTitlebar true");
  const e = load(dir, { CLAUDE_WINDOW_TRANSPARENCY: "0" });
  ok(JSON.stringify(e.sandbox.__cdbWinTransExtra()) === "{}", "env 0 forces it off");
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"), '{"windowTransparency": false}');
  const l = load(dir);
  const r = await l.handlers["cdb-wt:pref-set"](sender, true);
  ok(r.ok === false, "jsonc lock refuses pref-set");
  const bad = await l.handlers["cdb-wt:pref-set"]({ sender: { getURL: () => "https://evil.example", isDestroyed: () => false } }, true);
  ok(bad.ok === false, "foreign origin rejected");
  rmSync(dir, { recursive: true });
}
{
  // The sender guard is exact-origin. 3P mode serves the SPA from
  // app://localhost, whose parsed origin is the opaque "null", so it has to be
  // normalised before the compare - and nothing near it may slip through.
  const dir = mkdtempSync(join(tmpdir(), "cdb-wt-"));
  const t = load(dir);
  const from = (u, parent = null) => ({ sender: { getURL: () => u, isDestroyed: () => false }, senderFrame: { parent } });
  for (const u of ["https://claude.ai/x", "https://preview.claude.ai/x", "https://claude.com/",
                   "https://preview.claude.com/x", "app://localhost/", "app://localhost/new?x=1"]) {
    ok((await t.handlers["cdb-wt:pref-read"](from(u))).ok === true, "sender " + u + " accepted");
  }
  for (const u of ["https://evil.example/", "app://localhost.evil/", "app://localhost:1234/", "app://other/",
                   "file:///home/u/x.html", "http://localhost:3000/", "http://claude.ai/", "not a url"]) {
    ok((await t.handlers["cdb-wt:pref-read"](from(u))).ok === false, "sender " + u + " rejected");
  }
  ok((await t.handlers["cdb-wt:pref-read"](from("app://localhost/", {}))).ok === false,
     "an app://localhost subframe is rejected");
  rmSync(dir, { recursive: true });
}
{
  // Fake webContents / views / windows: only what the dom-ready handler and
  // the browser-window-created hook touch.
  const fakeWc = (url) => {
    const h = {};
    const wc = { css: 0, cssText: [], on: (e, f) => { h[e] = f; }, getURL: () => url, isDestroyed: () => false,
      insertCSS: (c) => { wc.css++; wc.cssText.push(c); return Promise.resolve(); }, fire: (e) => h[e] && h[e]() };
    return wc;
  };
  const view = (wc, children = []) => ({ webContents: wc, children });
  const win = (wc, contentView) => ({ isDestroyed: () => false, webContents: wc, contentView,
    setBackgroundColor() {}, setSize() {} });

  const dir = mkdtempSync(join(tmpdir(), "cdb-wt-"));
  writeFileSync(join(dir, "claude-desktop-extra.json"), '{"windowTransparency": true}');
  const t = load(dir);
  t.sandbox.__cdbWinTransExtra();
  // The insert runs on the webContents' own promise chain, so give it a tick.
  const created = async (wc) => {
    t.events["web-contents-created"](null, wc); wc.fire("dom-ready");
    await new Promise((r) => setTimeout(r, 5));
    return wc.css;
  };

  const mainView = fakeWc("https://claude.ai/new");
  const mainWin = win(fakeWc("file:///x/renderer/main_window/index.html"), view(null, [view(mainView)]));
  t.events["browser-window-created"](null, mainWin);
  const popWc = fakeWc("https://claude.ai/chat/1");
  const popWin = win(popWc, view(popWc));
  const codeWc = fakeWc("https://claude.ai/code");
  const codeWin = win(fakeWc("file:///x/other.html"), view(null, [view(null, [view(codeWc)])]));
  t.windows.push(mainWin, popWin, codeWin);

  ok(await created(mainView) === 1, "main window's claude.ai child view gets the CSS");
  ok(await created(popWc) === 0, "another window's own claude.ai webContents does not");
  ok(await created(codeWc) === 0, "a claude.ai view nested in another window's contentView does not");
  ok(await created(fakeWc("https://claude.ai/new")) === 1, "an unattached claude.ai webContents still gets it");
  rmSync(dir, { recursive: true });

  // The CSS itself, rendered by a real browser: a design-system Dialog card
  // (.bg-surface-2.rounded-card + data-cds=Dialog, e.g. Settings) stays solid
  // while the Claude Code content card with the same two classes still takes the
  // window alpha. Skipped when no chromium is installed, like the DOM harnesses.
  const css = mainView.cssText.join("\n");
  ok(/\[data-cds=Dialog\]\.bg-surface-2\{background-color:var\(--cds-surface-2\)!important\}/.test(css),
     "the claude.ai CSS carries the solid-dialog rule");
  let chromium = null;
  for (const c of ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"]) {
    try { chromium = execFileSync("/bin/sh", ["-c", "command -v " + c], { encoding: "utf8" }).trim() || null; } catch {}
    if (chromium) break;
  }
  if (!chromium) {
    console.log("  skip no chromium: the rendered check of the dialog card");
  } else {
    const d = mkdtempSync(join(tmpdir(), "cdb-wt-css-"));
    const f = join(d, "t.html");
    writeFileSync(f, `<!doctype html><meta charset="utf-8"><style>
:root{--cds-surface-0:#111;--cds-surface-1:#1a1a19;--cds-surface-2:#262624;--cds-surface-3:#333;--cds-page-bg:#111;--bg-200:0 0% 10%}
</style><style>${css}</style>
<div id="dlg" data-cds="Dialog" class="bg-surface-2 rounded-card"></div>
<div id="card" class="bg-surface-2 rounded-card"></div>
<div id="ground" class="bg-surface-1" data-sim-native-ground><div id="frame" class="dframe-root">
<aside id="side" class="dframe-sidebar"></aside>
<main class="dframe-content"><div id="page" class="bg-surface-1"></div>
<div id="panel" class="rounded-card bg-surface-2" data-surface="panel" style="background:#1a1a19">
<div id="term" class="group/terminal" style="background-color:rgb(26,26,25)"><div id="xterm" class="xterm-scrollable-element" style="background-color:rgb(26,26,25)"></div></div>
<div id="code" data-cds="CodeView" style="background-color:#1a1a19"></div>
<div id="cm" class="cm-editor" style="background-color:#1a1a19"><div id="gut" class="cm-gutters" style="background-color:#1a1a19"></div></div></div>
<div id="fdlg" data-cds="Dialog" class="bg-surface-2 rounded-card"></div></main></div></div>
<pre id="o"></pre>
<script>var r={};["dlg","card","ground","frame","side","page","panel","term","xterm","code","cm","gut","fdlg"].forEach(function(k){r[k]=getComputedStyle(document.getElementById(k)).backgroundColor});r.body=getComputedStyle(document.body).backgroundColor;o.textContent="CDB-BEGIN"+JSON.stringify(r)+"CDB-END"</script>`);
    const dump = execFileSync(chromium, ["--headless", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=2000",
      "--dump-dom", "file://" + f], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const m = /CDB-BEGIN(\{.*?\})CDB-END/.exec(dump.replace(/&quot;/g, '"'));
    const got = m ? JSON.parse(m[1]) : {};
    ok(/^rgb\(38, 38, 36\)$/.test(got.dlg || ""), "a Dialog card renders solid surface-2 (" + got.dlg + ")");
    ok(!!got.card && !/^rgb\(/.test(got.card), "the same classes without data-cds=Dialog still fade (" + got.card + ")");
    // In the app frame only .dframe-root carries the alpha: the wrappers above it
    // (body, the bg-surface-1 ground) and the sidebar, page surfaces, Code-tab
    // panel cards, terminal and CodeView inside it stay clear, so nothing stacks.
    const clear = (v) => v === "rgba(0, 0, 0, 0)";
    ok(!!got.frame && !clear(got.frame) && !/^rgb\(/.test(got.frame), "the frame root carries the alpha (" + got.frame + ")");
    const stacked = ["body", "ground", "side", "page", "panel", "term", "xterm", "code", "cm", "gut"].filter((k) => !clear(got[k]));
    ok(stacked.length === 0, "nothing above or inside the frame adds a second layer" + (stacked.length ? ": " + stacked.map((k) => k + "=" + got[k]).join(", ") : ""));
    ok(/^rgb\(38, 38, 36\)$/.test(got.fdlg || ""), "a Dialog inside the frame stays solid (" + got.fdlg + ")");
    rmSync(d, { recursive: true });
  }
}

// --- the transparency slider: pref-read fields, preview/set, locks, validation,
// and the live stylesheet swap on the main window's claude.ai view. The level
// is 1 - alpha: level 0.2 renders alpha 0.8.
{
  const read = (t) => t.handlers["cdb-wt:pref-read"](sender);
  const json = (dir) => JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8"));

  const dir = mkdtempSync(join(tmpdir(), "cdb-wt-"));
  writeFileSync(join(dir, "claude-desktop-extra.json"), '{"windowTransparency": true, "theme": "mario"}');
  const t = load(dir);
  const r0 = await read(t);
  ok(r0.level === 0.2 && r0.levelSource === "default" && r0.levelLocked === false && r0.levelEnvForced === false,
     "pref-read reports level 0.2 from the default, unlocked: " + JSON.stringify(r0));
  ok(r0.opacity === undefined && r0.opacitySource === undefined, "pref-read no longer carries opacity fields");

  // Not built yet (active null): set still saves, preview writes nothing.
  const p0 = await t.handlers["cdb-wt:level-preview"](sender, 0.5);
  ok(p0.ok && p0.live === 0, "preview before the window is transparent restyles nothing");
  ok(json(dir).windowTransparencyLevel === undefined, "preview does not write");
  const s0 = await t.handlers["cdb-wt:level-set"](sender, 0.45);
  const j0 = json(dir);
  ok(s0.ok && j0.windowTransparencyLevel === 0.45, "set writes windowTransparencyLevel to the .json");
  ok(j0.windowTransparency === true && j0.theme === "mario", "set preserves the other keys: " + JSON.stringify(j0));
  const r1 = await read(t);
  ok(r1.level === 0.45 && r1.levelSource === "json" && r1.levelSetBy === "windowTransparencyLevel",
     "pref-read reflects the saved level and its source");

  // Validation: non-numbers refused, out-of-range numbers clamped to 0..0.9.
  for (const bad of ["0.5", NaN, Infinity, null, undefined, {}, true]) {
    const r = await t.handlers["cdb-wt:level-set"](sender, bad);
    ok(r.ok === false, "set refuses " + String(bad));
  }
  ok(json(dir).windowTransparencyLevel === 0.45, "a refused set leaves the file alone");
  const lo = await t.handlers["cdb-wt:level-set"](sender, -3);
  ok(lo.ok && lo.level === 0 && json(dir).windowTransparencyLevel === 0, "below 0 clamps to 0");
  const hi = await t.handlers["cdb-wt:level-set"](sender, 0.97);
  ok(hi.ok && hi.level === 0.9 && json(dir).windowTransparencyLevel === 0.9, "above 0.9 clamps to 0.9");
  const evil = { sender: { getURL: () => "https://evil.example", isDestroyed: () => false } };
  ok((await t.handlers["cdb-wt:level-set"](evil, 0.5)).ok === false, "set: foreign origin rejected");
  ok((await t.handlers["cdb-wt:level-preview"](evil, 0.5)).ok === false, "preview: foreign origin rejected");
  ok(t.handlers["cdb-wt:opacity-set"] === undefined && t.handlers["cdb-wt:opacity-preview"] === undefined,
     "the old opacity channels are gone");
  await t.handlers["cdb-wt:level-set"](sender, 0.2);

  // Live swap. Build the window transparent, style the main view, then move
  // the slider: every swap must insert the new alpha and remove the old key.
  const live = load(dir);
  live.sandbox.__cdbWinTransExtra();
  const mk = (url) => {
    const h = {}, sheets = new Map();
    let n = 0;
    const wc = { sheets, removed: [], on: (e, f) => { h[e] = f; }, once: (e, f) => { h[e] = f; },
      getURL: () => url, isDestroyed: () => false,
      insertCSS: (c) => { const k = "k" + (++n); sheets.set(k, c); return Promise.resolve(k); },
      removeInsertedCSS: (k) => { wc.removed.push(k); sheets.delete(k); return Promise.resolve(); },
      fire: (e) => h[e] && h[e]() };
    return wc;
  };
  const alphaOf = (css) => { const m = /\.dframe-root\{background-color:color-mix\(in srgb,var\(--cds-page-bg\) (\d+)%/.exec(css); return m ? Number(m[1]) / 100 : null; };
  const view = mk("https://claude.ai/new");
  live.events["web-contents-created"](null, view);
  view.fire("dom-ready");
  await new Promise((r) => setTimeout(r, 10));
  ok(view.sheets.size === 1 && alphaOf([...view.sheets.values()][0]) === 0.8, "dom-ready inserts alpha 0.8 for level 0.2");
  const first = [...view.sheets.keys()][0];

  const pv = await live.handlers["cdb-wt:level-preview"](sender, 0.6);
  ok(pv.ok && pv.live === 1, "preview restyles the one styled webContents: " + JSON.stringify(pv));
  ok(view.removed.includes(first), "the old stylesheet key is removed");
  ok(view.sheets.size === 1 && alphaOf([...view.sheets.values()][0]) === 0.4, "and level 0.6 renders alpha 0.4");
  ok(json(dir).windowTransparencyLevel === 0.2, "preview still does not write");

  // A burst of previews ends on the last value with exactly one sheet left.
  await Promise.all([0.7, 0.65, 0.55].map((l) => live.handlers["cdb-wt:level-preview"](sender, l)));
  ok(view.sheets.size === 1 && alphaOf([...view.sheets.values()][0]) === 0.45,
     "a burst of previews leaves one sheet with the last alpha");

  const st = await live.handlers["cdb-wt:level-set"](sender, 0.35);
  ok(st.ok && st.live === 1 && json(dir).windowTransparencyLevel === 0.35, "set persists and applies live");
  ok(view.sheets.size === 1 && alphaOf([...view.sheets.values()][0]) === 0.65, "the live sheet carries the saved alpha");
  await live.handlers["cdb-wt:level-preview"](sender, 0.9);
  ok(alphaOf([...view.sheets.values()][0]) === 0.1, "the top level 0.9 renders the minimum alpha 0.1");
  await live.handlers["cdb-wt:level-preview"](sender, 0);
  ok(alphaOf([...view.sheets.values()][0]) === 1, "level 0 renders a solid alpha 1");

  // A navigation is a new document: a fresh insert replaces the stored key, and
  // the next swap removes THAT key.
  view.fire("dom-ready");
  await new Promise((r) => setTimeout(r, 10));
  const navKey = [...view.sheets.keys()].pop();
  await live.handlers["cdb-wt:level-preview"](sender, 0.1);
  ok(view.removed[view.removed.length - 1] === navKey, "after a navigation the swap removes the new document's key");

  // Destroyed webContents are dropped, not restyled.
  view.isDestroyed = () => true;
  view.fire("destroyed");
  const pd = await live.handlers["cdb-wt:level-preview"](sender, 0.5);
  ok(pd.ok && pd.live === 0, "a destroyed webContents is no longer restyled");

  // Locks: a .jsonc windowTransparencyLevel and the env variable both refuse.
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"), '{\n  // mine\n  "windowTransparencyLevel": 0.3\n}');
  const jl = load(dir);
  const rj = await read(jl);
  ok(rj.level === 0.3 && rj.levelSource === "jsonc-locked" && rj.levelLocked === true && rj.levelEnvForced === false,
     "pref-read reports the .jsonc lock: " + JSON.stringify(rj));
  const sj = await jl.handlers["cdb-wt:level-set"](sender, 0.7);
  ok(sj.ok === false && /windowTransparencyLevel is set in claude-desktop-extra\.jsonc/.test(sj.error),
     "jsonc-locked refuses set: " + sj.error);
  ok((await jl.handlers["cdb-wt:level-preview"](sender, 0.7)).ok === false, "jsonc-locked refuses preview");
  ok(json(dir).windowTransparencyLevel === 0.35, "a refused set leaves the .json alone");
  const el = load(dir, { CLAUDE_WINDOW_TRANSPARENCY_LEVEL: "0.65" });
  const re = await read(el);
  ok(re.level === 0.65 && re.levelSource === "env" && re.levelEnvForced === true &&
     re.levelSetBy === "CLAUDE_WINDOW_TRANSPARENCY_LEVEL", "env wins over .jsonc and is reported: " + JSON.stringify(re));
  const se = await el.handlers["cdb-wt:level-set"](sender, 0.7);
  ok(se.ok === false && /CLAUDE_WINDOW_TRANSPARENCY_LEVEL/.test(se.error), "env-forced refuses set: " + se.error);
  const junk = load(dir, { CLAUDE_WINDOW_TRANSPARENCY_LEVEL: "abc" });
  const rk = await read(junk);
  ok(rk.levelSource === "jsonc-locked" && rk.level === 0.3, "a non-numeric env value falls through to the files");
  const ce = await read(load(dir, { CLAUDE_WINDOW_TRANSPARENCY_LEVEL: "5" }));
  ok(ce.level === 0.9, "an env level above 0.9 clamps to 0.9");
  rmSync(dir, { recursive: true });
}

// --- the previous release's opacity key and env are still read, as 1 - x.
{
  const read = (t) => t.handlers["cdb-wt:pref-read"](sender);
  const jsonPath = (dir) => join(dir, "claude-desktop-extra.json");
  const json = (dir) => JSON.parse(readFileSync(jsonPath(dir), "utf8"));
  const dir = mkdtempSync(join(tmpdir(), "cdb-wt-"));

  // Legacy .json key: converted, unlocked, named.
  writeFileSync(jsonPath(dir), '{"windowTransparency": true, "windowOpacity": 0.55, "theme": "mario"}');
  let t = load(dir);
  let r = await read(t);
  ok(r.level === 0.45 && r.levelSource === "json" && r.levelSetBy === "windowOpacity" && r.levelLocked === false,
     "a legacy .json windowOpacity 0.55 reads as level 0.45: " + JSON.stringify(r));
  ok(Math.abs((1 - r.level) - 0.55) < 1e-9, "and keeps the same alpha");
  writeFileSync(jsonPath(dir), '{"windowOpacity": 0.02}');
  ok((await read(load(dir))).level === 0.9, "a legacy opacity below 0.1 still ends at the minimum alpha (level 0.9)");
  writeFileSync(jsonPath(dir), '{"windowOpacity": 3}');
  ok((await read(load(dir))).level === 0, "a legacy opacity above 1 ends solid (level 0)");

  // The new key wins over the legacy one in the same file.
  writeFileSync(jsonPath(dir), '{"windowOpacity": 0.55, "windowTransparencyLevel": 0.1}');
  r = await read(load(dir));
  ok(r.level === 0.1 && r.levelSetBy === "windowTransparencyLevel", "in one file the new key wins over windowOpacity");

  // Migration: a save writes the new key and drops windowOpacity, other keys kept.
  writeFileSync(jsonPath(dir), '{"windowTransparency": true, "windowOpacity": 0.55, "theme": "mario"}');
  t = load(dir);
  const s = await t.handlers["cdb-wt:level-set"](sender, 0.3);
  const j = json(dir);
  ok(s.ok && j.windowTransparencyLevel === 0.3 && !("windowOpacity" in j),
     "set writes windowTransparencyLevel and removes windowOpacity: " + JSON.stringify(j));
  ok(j.windowTransparency === true && j.theme === "mario", "the migration keeps the other keys");
  ok(!existsSync(jsonPath(dir) + ".cdb-tmp"), "no temp file is left behind");

  // A .json that cannot be parsed is not touched.
  writeFileSync(jsonPath(dir), '{"windowOpacity": 0.5,,, nope');
  const bad = await load(dir).handlers["cdb-wt:level-set"](sender, 0.3);
  ok(bad.ok === false && readFileSync(jsonPath(dir), "utf8") === '{"windowOpacity": 0.5,,, nope',
     "an unparseable .json is refused and left as it was");
  writeFileSync(jsonPath(dir), '{"windowTransparencyLevel": 0.3}');

  // Legacy .jsonc key: still locks, and the refusal names windowOpacity.
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"), '{\n  // mine\n  "windowOpacity": 0.7\n}');
  t = load(dir);
  r = await read(t);
  ok(r.level === 0.3 && r.levelSource === "jsonc-locked" && r.levelLocked === true && r.levelSetBy === "windowOpacity",
     "a legacy .jsonc windowOpacity 0.7 locks at level 0.3 over the .json: " + JSON.stringify(r));
  const sj = await t.handlers["cdb-wt:level-set"](sender, 0.5);
  ok(sj.ok === false && /^windowOpacity is set in claude-desktop-extra\.jsonc/.test(sj.error),
     "the legacy .jsonc lock names windowOpacity: " + sj.error);
  ok(json(dir).windowTransparencyLevel === 0.3, "and leaves the .json alone");
  // ...but a new-key .jsonc wins over a legacy key in the same .jsonc.
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"), '{"windowOpacity": 0.7, "windowTransparencyLevel": 0.15}');
  r = await read(load(dir));
  ok(r.level === 0.15 && r.levelSetBy === "windowTransparencyLevel", "the new key wins inside the .jsonc too");

  // Legacy env: above the files, below the new env.
  r = await read(load(dir, { CLAUDE_WINDOW_OPACITY: "0.35" }));
  ok(r.level === 0.65 && r.levelSource === "env" && r.levelEnvForced === true && r.levelSetBy === "CLAUDE_WINDOW_OPACITY",
     "CLAUDE_WINDOW_OPACITY 0.35 reads as level 0.65 over the files: " + JSON.stringify(r));
  const se = await load(dir, { CLAUDE_WINDOW_OPACITY: "0.35" }).handlers["cdb-wt:level-set"](sender, 0.5);
  ok(se.ok === false && /^CLAUDE_WINDOW_OPACITY is set/.test(se.error), "the legacy env refusal names it: " + se.error);
  r = await read(load(dir, { CLAUDE_WINDOW_OPACITY: "0.35", CLAUDE_WINDOW_TRANSPARENCY_LEVEL: "0.5" }));
  ok(r.level === 0.5 && r.levelSetBy === "CLAUDE_WINDOW_TRANSPARENCY_LEVEL", "the new env wins over the legacy env");
  r = await read(load(dir, { CLAUDE_WINDOW_OPACITY: "junk" }));
  ok(r.levelSource === "jsonc-locked", "a non-numeric legacy env falls through to the files");
  rmSync(dir, { recursive: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
