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
  const handlers = {}, events = {}, windows = [], listeners = {};
  // Every listener of an event runs, in registration order: the module hooks
  // web-contents-created more than once.
  const on = (e, f) => {
    (listeners[e] ||= []).push(f);
    events[e] = (...a) => { for (const g of listeners[e]) g(...a); };
  };
  const electron = {
    app: { getPath: () => dir, on },
    BrowserWindow: { getAllWindows: () => windows.slice() },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    nativeTheme: { shouldUseDarkColors: true }
  };
  const sandbox = { require: (m) => (m === "electron" ? electron : Module.createRequire(import.meta.url)(m)),
    process: { platform: "linux", env }, console, setTimeout, clearTimeout, __cdbNativeTb: () => native };
  sandbox.globalThis = sandbox;
  { const __c = vm.createContext(sandbox);
    vm.runInContext(readFileSync(new URL("../../../js/sender_guard.js", import.meta.url), "utf8"), __c);
    vm.runInContext(readFileSync(join(ROOT, "js/window_transparency.js"), "utf8"), __c); }
  return { handlers, events, windows, sandbox };
}
const J = JSON.stringify;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const sender = { sender: { getURL: () => "https://claude.ai/x", isDestroyed: () => false } };

{
  const dir = mkdtempSync(join(tmpdir(), "cdb-wt-"));
  let t = load(dir);
  ok(t.sandbox.__cdbWinTransActive() === false, "active observer: false before any window asked");
  ok(JSON.stringify(t.sandbox.__cdbWinTransExtra()) === "{}", "off by default: no extra options");
  ok(t.sandbox.__cdbWinTransActive() === false, "active observer: false with the switch off");
  const r0 = await t.handlers["cdb-wt:pref-read"](sender);
  ok(r0.ok && r0.enabled === false, "pref-read defaults to off");
  ok(r0.nativeTitlebar === false, "pref-read reports nativeTitlebar false");
  const s = await t.handlers["cdb-wt:pref-set"](sender, true);
  ok(s.ok && s.enabled === true, "pref-set turns it on");
  t = load(dir);
  const x = t.sandbox.__cdbWinTransExtra();
  ok(x.transparent === true && x.backgroundColor === "#00000000", "on: transparent + clear background");
  ok(t.sandbox.__cdbWinTransActive() === true, "active observer: true once the window was built transparent");
  rmSync(dir, { recursive: true });
}
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-wt-"));
  writeFileSync(join(dir, "claude-desktop-extra.json"), '{"windowTransparency": true}');
  const n = load(dir, {}, true);
  ok(JSON.stringify(n.sandbox.__cdbWinTransExtra()) === "{}", "native titlebar: transparency skipped");
  ok(n.sandbox.__cdbWinTransActive() === false, "active observer: false when the native titlebar skipped transparency");
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
[data-tiles-line] .tiles-shell{background:var(--tile-shell-ground,transparent)}
[data-cds=Toolbar]>[data-cds-part=toolbar-ground],[data-cds=Page] [data-cds-part=page-header-ground]{--_toolbar-ground-fill:100%;background-color:color-mix(in srgb,var(--cds-page-bg) var(--_toolbar-ground-fill),transparent)}
.shadow-panel-md,.shadow-panel-lg,.shadow-popover,.shadow-panel-sm,.shadow-card-ring{box-shadow:0 0 0 1px #000}
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
<div id="fdlg" data-cds="Dialog" class="bg-surface-2 rounded-card"></div>
<div data-tiles-line style="--tile-shell-ground:#111"><div id="tiles" class="tiles-shell"><div id="corner" style="background:var(--tile-shell-ground)"></div></div></div>
<div data-cds="Toolbar"><div id="tground" data-cds-part="toolbar-ground"></div></div>
<div data-cds="Page"><div id="hground" data-cds-part="page-header-ground"></div></div>
<div id="elev" class="bg-surface-1 rounded-card border shadow-panel-md"></div>
<div id="elev2" class="bg-surface-2 rounded-card shadow-panel-lg"></div>
<div id="elev3" class="bg-surface-1 shadow-popover"></div>
<div id="flow" class="bg-surface-1 rounded-card shadow-panel-sm"></div>
<div id="ring" class="bg-surface-1 rounded-card shadow-card-ring"></div>
<div id="pane" class="cds-pane-ground bg-surface-2"></div>
<div id="fpane" class="cds-pane-ground bg-surface-2 shadow-panel-md"></div>
<iframe id="ifr" srcdoc="<body>no background</body>"></iframe><iframe id="ifw" class="bg-white"></iframe></main></div></div>
<div class="epitaxy-root"><div id="pframe" class="dframe-root"><div id="pcontent" class="dframe-content" data-sim-native-ground>
<div id="pground" class="epitaxy-root bg-surface-1" data-sim-native-ground data-popout-ground><div id="pcard" class="bg-surface-2 rounded-card"></div>
<iframe id="pifr" srcdoc="<body>no background</body>"></iframe></div>
<div data-tiles-line style="--tile-shell-ground:#111"><div id="ptiles" class="tiles-shell"><div id="pcorner" style="background:var(--tile-shell-ground)"></div></div></div></div></div></div>
<div data-tiles-line style="--tile-shell-ground:#111"><div id="otiles" class="tiles-shell"></div></div>
<div class="dframe-root" id="mframe"><div data-tiles-line style="--tile-shell-ground:#111"><div id="mtiles" class="tiles-shell is-moving"></div></div></div>
<pre id="o"></pre>
<script>var r={};["dlg","card","ground","frame","side","page","panel","term","xterm","code","cm","gut","fdlg","ifr","ifw","pframe","pcontent","pground","pcard","pifr","tiles","corner","ptiles","pcorner","otiles","mtiles","tground","hground","elev","elev2","elev3","flow","ring","pane","fpane"].forEach(function(k){r[k]=getComputedStyle(document.getElementById(k)).backgroundColor});r.body=getComputedStyle(document.body).backgroundColor;o.textContent="CDB-BEGIN"+JSON.stringify(r)+"CDB-END"</script>`);
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
    const stacked = ["body", "ground", "side", "page", "panel", "term", "xterm", "code", "cm", "gut", "tiles", "corner", "flow", "ring", "pane"].filter((k) => !clear(got[k]));
    ok(stacked.length === 0, "nothing above or inside the frame adds a second layer" + (stacked.length ? ": " + stacked.map((k) => k + "=" + got[k]).join(", ") : ""));
    ok(/^rgb\(38, 38, 36\)$/.test(got.fdlg || ""), "a Dialog inside the frame stays solid (" + got.fdlg + ")");
    // Embedded documents get an opaque backing (the page has no background of its own).
    ok(got.ifr === "rgb(26, 26, 25)", "an iframe in the frame gets an opaque surface-1 backing (" + got.ifr + ")");
    ok(got.ifw === "rgba(0, 0, 0, 0)", "an iframe with its own bg-* utility is left to it (" + got.ifw + ")");
    // A pop-out's tree (ion-dist 5.1231.2: PopoutFrame .dframe-root > .dframe-content >
    // the code-session ground .bg-surface-1[data-popout-ground]) keeps one alpha layer.
    ok(!!got.pframe && !clear(got.pframe) && !/^rgb\(/.test(got.pframe), "a pop-out's frame root carries the alpha (" + got.pframe + ")");
    const pstacked = ["pcontent", "pground", "pcard", "ptiles", "pcorner"].filter((k) => !clear(got[k]));
    ok(pstacked.length === 0, "nothing inside a pop-out's frame adds a second layer" + (pstacked.length ? ": " + pstacked.map((k) => k + "=" + got[k]).join(", ") : ""));
    ok(got.pifr === "rgb(26, 26, 25)", "an iframe in a pop-out gets the opaque backing (" + got.pifr + ")");
    // The Code view's tiles (.tiles-shell, painted with --tile-shell-ground) go clear on the frame's layer...
    ok(clear(got.tiles) && clear(got.corner), "the Code view's .tiles-shell and what paints with its ground are clear in the frame (" + got.tiles + ", " + got.corner + ")");
    ok(clear(got.ptiles) && clear(got.pcorner), "and in a pop-out's frame (" + got.ptiles + ", " + got.pcorner + ")");
    // ...but only there: outside a .dframe-root nothing would be behind them.
    // Elevated cards stay solid; in-flow cards (also with a shadow) and the docked rail go clear.
    ok(got.elev === "rgb(26, 26, 25)" && got.elev3 === "rgb(26, 26, 25)", "an elevated bg-surface-1 card (shadow-panel-md / shadow-popover) is opaque (" + got.elev + ", " + got.elev3 + ")");
    ok(got.elev2 === "rgb(38, 38, 36)", "an elevated bg-surface-2 card (shadow-panel-lg) is opaque (" + got.elev2 + ")");
    ok(clear(got.flow) && clear(got.ring) && clear(got.page), "in-flow bg-surface-1 cards (also with shadow-panel-sm or shadow-card-ring) stay clear (" + got.flow + ", " + got.ring + ")");
    ok(clear(got.pane), "the docked session rail (.cds-pane-ground.bg-surface-2) is clear (" + got.pane + ")");
    ok(got.fpane === "rgb(38, 38, 36)", "a floating .cds-pane-ground (elevated) stays opaque (" + got.fpane + ")");
    // The header grounds carry the page colour at the window alpha, the same mix as the frame layer.
    ok(!!got.tground && !clear(got.tground) && !/^rgb\(/.test(got.tground) && got.tground === got.frame && got.hground === got.frame,
       "the toolbar and page-header grounds are the page colour at the window alpha, not clear and not opaque (" + got.tground + ", " + got.hground + " vs frame " + got.frame + ")");
    ok(got.otiles === "rgb(17, 17, 17)", "a .tiles-shell outside any frame keeps its ground (" + got.otiles + ")");
    ok(!!got.mtiles && !clear(got.mtiles) && !/^rgb\(/.test(got.mtiles), "a moving .tiles-shell is not cleared: it carries the page colour at the window alpha (" + got.mtiles + ")");
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
// --- pop-out windows: __cdbWinTransPopout (the options of upstream's window
// manager), the paint guards on the created window, and the see-through CSS
// of its about:blank document.
const OPAQUE = { width: 600, frame: false, titleBarStyle: "hidden", titleBarOverlay: { color: "#262624", height: 36 },
  transparent: false, webPreferences: { sandbox: true }, show: false };
const FRAMED = { width: 600, frame: true, transparent: false, webPreferences: { sandbox: true }, show: false };
// A webContents: several listeners per event, a main frame, insertCSS keys.
function mkWc(url, frameUrl = url, opener = null) {
  const h = {}, sheets = new Map();
  let n = 0, cur = url;
  const wc = { sheets, removed: [], inserted: 0, destroyed: false, opener, count: (e) => (h[e] || []).length,
    on: (e, f) => { (h[e] ||= []).push(f); }, once: (e, f) => { (h[e] ||= []).push(f); },
    getURL: () => cur, isDestroyed: () => wc.destroyed, navigate: (u) => { cur = u; },
    mainFrame: { url: frameUrl, parent: null },
    insertCSS: (c) => { wc.inserted++; const k = "k" + (++n); sheets.set(k, c); return Promise.resolve(k); },
    removeInsertedCSS: (k) => { wc.removed.push(k); sheets.delete(k); return Promise.resolve(); },
    fire: (e, ...a) => { for (const f of h[e] || []) f(...a); } };
  return wc;
}
const vw = (wc, children = []) => ({ webContents: wc, children });
// A BrowserWindow that records what reaches the real setters.
function mkWin(wc, contentView) {
  const w = { painted: [], overlays: [], webContents: wc, contentView, isDestroyed: () => false, setSize() {},
    setBackgroundColor(c) { w.painted.push(c); }, setTitleBarOverlay(o) { w.overlays.push(o); } };
  return w;
}
// A transparent main window whose contentView holds `view` (a claude.ai page).
function popRig(json = '{"windowTransparency": true}', env = {}, native = false, viewUrl = "https://claude.ai/new") {
  const dir = mkdtempSync(join(tmpdir(), "cdb-wt-"));
  writeFileSync(join(dir, "claude-desktop-extra.json"), json);
  const t = load(dir, env, native);
  t.sandbox.__cdbWinTransExtra();
  const shell = mkWc("file:///x/renderer/main_window/index.html");
  const view = mkWc(viewUrl);
  const main = mkWin(shell, vw(null, [vw(view)]));
  t.events["browser-window-created"](null, main);
  t.windows.push(main);
  for (const wc of [shell, view]) t.events["web-contents-created"](null, wc);
  return { t, dir, shell, view, main, P: t.sandbox.__cdbWinTransPopout };
}
// What Electron does with the handler's answer: build the window, emit
// did-create-window on the opener, then the child's about:blank dom-ready.
function openPopout(r, opener, name, opts) {
  const child = mkWc("about:blank", "about:blank", { url: opener.mainFrame.url, parent: null });
  r.t.events["web-contents-created"](null, child);
  const win = mkWin(child, vw(child));
  r.t.windows.push(win);
  opener.fire("did-create-window", win, { frameName: name, url: "about:blank", options: opts });
  child.fire("dom-ready");
  return { child, win };
}
{
  // Switch off: identity, nothing wrapped, no CSS.
  const off = popRig("{}");
  ok(off.t.sandbox.__cdbWinTransActive() === false, "pop-outs, switch off: the main window is not transparent");
  ok(off.P(off.view, "w1", OPAQUE) === OPAQUE, "switch off: the pop-out options come back by identity");
  ok(off.P(off.view, "w2", FRAMED) === FRAMED, "switch off: framed options too");
  const o1 = openPopout(off, off.view, "w1", OPAQUE);
  o1.win.setBackgroundColor("#262624");
  await tick();
  ok(o1.win.painted.length === 1 && o1.win.overlays.length === 0, "switch off: the pop-out window is not wrapped");
  ok(o1.child.inserted === 0, "switch off: the pop-out document gets no CSS");
  rmSync(off.dir, { recursive: true });

  // Native titlebar skipped the main window: pop-outs stay opaque too.
  const nat = popRig('{"windowTransparency": true}', {}, true);
  ok(nat.t.sandbox.__cdbWinTransActive() === false, "native titlebar: the main window is not transparent");
  ok(nat.P(nat.view, "w1", OPAQUE) === OPAQUE, "native titlebar: pop-out options by identity");
  ok(nat.P(nat.view, "w2", FRAMED) === FRAMED, "native titlebar: os-frame pop-out options by identity");
  rmSync(nat.dir, { recursive: true });
  const envOff = popRig('{"windowTransparency": true}', { CLAUDE_WINDOW_TRANSPARENCY: "0" });
  ok(envOff.P(envOff.view, "w1", OPAQUE) === OPAQUE, "CLAUDE_WINDOW_TRANSPARENCY=0: pop-out options by identity");
  rmSync(envOff.dir, { recursive: true });
}
{
  const r = popRig();
  const before = JSON.stringify(OPAQUE);
  const x = r.P(r.view, "w1", OPAQUE);
  ok(x !== OPAQUE && x.transparent === true && x.backgroundColor === "#00000000",
     "switch on: a pop-out of the main view gets transparent + #00000000");
  ok(JSON.stringify(OPAQUE) === before, "the input options are not mutated");
  ok(x.width === 600 && x.titleBarStyle === "hidden" && x.show === false && x.webPreferences === OPAQUE.webPreferences,
     "every other key is kept");
  const fr = r.P(r.view, "w2", FRAMED);
  ok(fr !== FRAMED && fr.transparent === true && fr.backgroundColor === "#00000000" && fr.frame === true,
     "an os-frame pop-out (frame:true, no titleBarStyle) is made transparent too");

  // Untouched: wrong opener, wrong origin, file:, bad or throwing input.
  const other = mkWc("https://claude.ai/code");
  r.t.windows.push(mkWin(other, vw(other)));
  ok(r.P(other, "w3", OPAQUE) === OPAQUE, "an opener in another window: identity");
  ok(r.P(mkWc("https://claude.ai/new"), "w3", OPAQUE) === OPAQUE, "an opener in no window: identity");
  ok(r.P(r.shell, "w3", OPAQUE) === OPAQUE, "the main window's own shell page (file:): identity");
  r.view.mainFrame.url = "https://evil.example/";
  ok(r.P(r.view, "w3", OPAQUE) === OPAQUE, "the main view's main frame on a foreign origin: identity");
  r.view.mainFrame.url = "file:///x/renderer/main_window/index.html";
  ok(r.P(r.view, "w3", OPAQUE) === OPAQUE, "the main view's main frame on file:: identity");
  r.view.mainFrame.url = "https://claude.ai/new";
  ok(r.P(r.view, "", OPAQUE) === OPAQUE && r.P(r.view, undefined, OPAQUE) === OPAQUE, "no window id: identity");
  ok(r.P(null, "w3", OPAQUE) === OPAQUE && r.P(undefined, "w3", OPAQUE) === OPAQUE, "no opener: identity");
  ok(r.P(r.view, "w3", null) === null && r.P(r.view, "w3", undefined) === undefined, "no options: returned as they came");
  const shown = { show: true, frame: false };
  ok(r.P(r.view, "w3", shown) === shown, "options without the manager's show:false: identity");
  const boom = { isDestroyed() { throw new Error("boom"); } };
  ok(r.P(boom, "w3", OPAQUE) === OPAQUE, "a throwing opener: identity");
  const trap = { show: false, get frame() { throw new Error("boom"); } };
  ok(r.P(r.view, "w3", trap) === trap, "options that throw while copied: identity");
  r.view.destroyed = true;
  ok(r.P(r.view, "w3", OPAQUE) === OPAQUE, "a destroyed opener: identity");
  r.view.destroyed = false;
  rmSync(r.dir, { recursive: true });
}
{
  // Paint guards and CSS on the created window.
  const r = popRig();
  const opts = r.P(r.view, "w1", OPAQUE);
  const { child, win } = openPopout(r, r.view, "w1", opts);
  await tick();
  win.setBackgroundColor("#262624");
  ok(win.painted.length === 0, "the transparent pop-out's setBackgroundColor is a no-op");
  ok(win.overlays.length === 1 && win.overlays[0].color === "#00000000", "its overlay was reset to #00000000 at creation");
  win.setTitleBarOverlay({ color: "#262624", symbolColor: "#fff", height: 36 });
  ok(win.overlays[1].color === "#00000000" && win.overlays[1].symbolColor === "#fff", "an upstream overlay push ends at #00000000");
  // The theme engine wraps setTitleBarOverlay later, on top (__cdb_paintOverlay).
  const inner = win.setTitleBarOverlay;
  win.setTitleBarOverlay = function (o) { const t = { ...o, color: "#ff0000", symbolColor: "#00ff00" }; return inner.call(win, t); };
  win.setTitleBarOverlay({ color: "#262624", height: 36 });
  ok(win.overlays[2].color === "#00000000" && win.overlays[2].symbolColor === "#00ff00",
     "with a theme wrapper stacked on top the overlay still ends at #00000000");
  ok(child.inserted === 1 && /data-cds=Dialog/.test([...child.sheets.values()][0]),
     "the pop-out's about:blank document gets the see-through CSS once");
  child.fire("dom-ready");
  await tick();
  ok(child.inserted === 2, "a new about:blank document of the pop-out is styled afresh");

  // The slider re-styles the pop-out together with the main view.
  r.view.fire("dom-ready");
  await tick();
  const sender = { sender: { getURL: () => "https://claude.ai/x", isDestroyed: () => false } };
  const pv = await r.t.handlers["cdb-wt:level-preview"](sender, 0.6);
  const alphaOf = (css) => { const m = /\.dframe-root\{background-color:color-mix\(in srgb,var\(--cds-page-bg\) (\d+)%/.exec(css); return m ? Number(m[1]) / 100 : null; };
  ok(pv.ok && pv.live === 2, "a slider preview re-styles the main view and the pop-out: " + JSON.stringify(pv));
  ok(alphaOf([...child.sheets.values()].pop()) === 0.4, "the pop-out carries the new alpha");

  // The pop-out navigates to another site: never styled again, dropped from the live set.
  child.navigate("https://example.com/");
  const n0 = child.inserted;
  await r.t.handlers["cdb-wt:level-preview"](sender, 0.3);
  ok(child.inserted === n0, "a pop-out that left about:blank is not re-styled by the slider");
  child.fire("dom-ready");
  await tick();
  const pv2 = await r.t.handlers["cdb-wt:level-preview"](sender, 0.5);
  ok(child.inserted === n0 && pv2.live === 1, "nor at its next dom-ready; only the main view stays live");

  // A destroyed pop-out leaves the live set.
  const p2 = openPopout(r, r.view, "w2", r.P(r.view, "w2", FRAMED));
  await tick();
  ok(p2.child.inserted === 1, "a framed pop-out's document is styled too");
  p2.child.destroyed = true;
  p2.child.fire("destroyed");
  const pv3 = await r.t.handlers["cdb-wt:level-preview"](sender, 0.4);
  ok(pv3.live === 1, "a destroyed pop-out is no longer re-styled");

  // Windows we did not mark: no guards, no CSS.
  const u = openPopout(r, r.view, "w-unmarked", OPAQUE);
  await tick();
  u.win.setBackgroundColor("#262624");
  ok(u.win.painted.length === 1 && u.child.inserted === 0, "an about:blank window we did not mark: no guards, no CSS");
  const other = mkWc("https://claude.ai/code");
  r.t.events["web-contents-created"](null, other);
  r.P(r.view, "w3", OPAQUE);
  const x = openPopout(r, other, "w3", opts);
  await tick();
  ok(x.child.inserted === 0 && x.win.overlays.length === 0, "a window another opener created under a marked name: untouched");
  // Marked, but the created window is not what we asked for (not transparent,
  // or its opener frame is not a main frame on an app origin).
  r.P(r.view, "w4", OPAQUE);
  const y = openPopout(r, r.view, "w4", OPAQUE);
  await tick();
  ok(y.child.inserted === 0 && y.win.overlays.length === 0, "a created window without transparent:true: untouched");
  const o5 = r.P(r.view, "w5", OPAQUE);
  const c5 = mkWc("about:blank", "about:blank", { url: "https://claude.ai/new", parent: {} });
  r.t.events["web-contents-created"](null, c5);
  const w5 = mkWin(c5, vw(c5));
  r.view.fire("did-create-window", w5, { frameName: "w5", url: "about:blank", options: o5 });
  c5.fire("dom-ready");
  await tick();
  ok(c5.inserted === 0 && w5.overlays.length === 0, "a window opened by a subframe: untouched");
  rmSync(r.dir, { recursive: true });
}
{
  // The CSS keeps one alpha layer in a pop-out (its React tree is rooted at
  // .dframe-root like the main window's), and an iframe never shows the
  // desktop through.
  const r = popRig();
  r.view.fire("dom-ready");
  await tick();
  const css = [...r.view.sheets.values()][0] || "";
  ok(/html iframe:not\(\[class\*=bg-\]\),html webview:not\(\[class\*=bg-\]\)\{background-color:var\(--cds-surface-1,Canvas\)!important\}/.test(css),
     "the CSS gives iframes and webviews without a bg-* utility an opaque backing");
  ok(/html \.dframe-root \.cds-pane-ground\{background:transparent!important\}/.test(css), "the CSS clears the docked .cds-pane-ground inside the frame");
  ok(/html \.dframe-root \.rounded-composer\.bg-surface-1:not\(#_\)\{background-color:var\(--cds-surface-1\)!important\}/.test(css), "the CSS keeps notice cards in the composer stack solid");
  ok(/html \.dframe-root \.cdb-tabs-bar\{background:transparent!important\}/.test(css), "the CSS clears our panel-tabs bar inside the frame");
  ok(/html \.dframe-root \.bg-surface-1:is\(\.shadow-panel-md,\.shadow-panel-lg,\.shadow-popover\):not\(#_\)\{background-color:var\(--cds-surface-1\)!important\}/.test(css) &&
     !/shadow-panel-sm/.test(css.replace(/\/\*[\s\S]*?\*\//g, "")), "the CSS makes elevated cards solid again, and shadow-panel-sm is not one of them");
  ok(/\[data-cds-part=toolbar-ground\],html \.dframe-root \[data-cds=Page\] \[data-cds-part=page-header-ground\]\{--_toolbar-ground-fill:80%!important;background-color:color-mix\(in srgb,var\(--cds-page-bg\) 80%,transparent\)!important\}/.test(css),
     "the header grounds take the page colour at the window alpha (80% at level 0.2)");
  ok(!/data-popout-ground/.test(css), "the CSS has no pop-out-only layer rule (pop-outs are rooted at .dframe-root)");
  ok(/html \.dframe-root \.tiles-shell:not\(\.is-moving\)\{--tile-shell-ground:transparent!important;background:transparent!important\}/.test(css),
     "the CSS clears the Code view's .tiles-shell inside the frame, scoped to tiles that are not moving");
  ok(!/\.tiles-shell\{--tile-shell-ground:transparent/.test(css), "no unscoped .tiles-shell clear is left (a moving tile is not cleared)");
  ok(/html \.dframe-root \.tiles-shell\.is-moving\{background-color:color-mix\(in srgb,var\(--cds-page-bg\) \d+%,transparent\)!important\}/.test(css),
     "a moving tile takes the page colour at the window alpha");
  rmSync(r.dir, { recursive: true });
}

// --- __cdbWinTransPopoutFramed: pop-outs get the window manager's frame exactly
// when the main window is transparent. Upstream evaluates its features object
// (which fix_native_frame reaches this through) on every call, possibly before
// the main window is built, so the answer asked first must be the decision
// the window's options hook later follows.
{
  const cases = [
    ["switch off", "{}", {}, false, false],
    ["on", '{"windowTransparency": true}', {}, false, true],
    ["native titlebar", '{"windowTransparency": true}', {}, true, false],
    ["env 0 over the switch", '{"windowTransparency": true}', { CLAUDE_WINDOW_TRANSPARENCY: "0" }, false, false],
    ["env 1", "{}", { CLAUDE_WINDOW_TRANSPARENCY: "1" }, false, true],
  ];
  for (const [label, json, env, native, want] of cases) {
    for (const first of ["framed", "options"]) {
      const dir = mkdtempSync(join(tmpdir(), "cdb-wt-"));
      writeFileSync(join(dir, "claude-desktop-extra.json"), json);
      const t = load(dir, env, native);
      const F = t.sandbox.__cdbWinTransPopoutFramed;
      ok(typeof F === "function", label + ": the reader is defined");
      let before, opts;
      if (first === "framed") { before = F(); opts = t.sandbox.__cdbWinTransExtra(); }
      else { opts = t.sandbox.__cdbWinTransExtra(); before = F(); }
      const built = opts.transparent === true;
      ok(before === want && built === want && F() === want && t.sandbox.__cdbWinTransActive() === want,
         label + " (asked " + first + " first): framed=" + before + ", built transparent=" + built + ", framed after=" + F() + " - one decision");
      // The window was constructed from that decision: the hook marks the main window.
      if (want) {
        const shell = { isDestroyed: () => false, webContents: { getURL: () => "file:///x/renderer/main_window/index.html" }, contentView: { children: [] }, setBackgroundColor() {}, setSize() {} };
        t.events["browser-window-created"](null, shell);
        shell.setBackgroundColor("#262624");
      }
      rmSync(dir, { recursive: true });
    }
  }
  // A throwing native-titlebar reader must not split the two answers.
  const dir = mkdtempSync(join(tmpdir(), "cdb-wt-"));
  writeFileSync(join(dir, "claude-desktop-extra.json"), '{"windowTransparency": true}');
  const t = load(dir, {}, false);
  t.sandbox.__cdbNativeTb = () => { throw new Error("boom"); };
  const fr = t.sandbox.__cdbWinTransPopoutFramed();
  ok(fr === (t.sandbox.__cdbWinTransExtra().transparent === true) && fr === t.sandbox.__cdbWinTransPopoutFramed(),
     "a failing native-titlebar reader (read as not native): the framed answer and the window are one decision");
  rmSync(dir, { recursive: true });
}

// --- review round: refusal reason, first overlay push of a pop-out, expiry of
// pending opens, a pop-out that leaves our pages, and a navigated main view.
{
  // The refusal for a main window that is not transparent says so, once (kills
  // a removed `active !== true` check: the text would name another reason).
  for (const [label, json, native] of [["switch off", "{}", false], ["native titlebar", '{"windowTransparency": true}', true]]) {
    const r = popRig(json, {}, native);
    const lines = [];
    r.t.sandbox.__cdbDiag = (l) => lines.push(l);
    r.P(r.view, "a1", OPAQUE); r.P(r.view, "a2", OPAQUE);
    const told = lines.filter((l) => /pop-outs stay opaque: the main window is not transparent$/.test(l));
    ok(told.length === 1 && !lines.some((l) => /left opaque/.test(l)), label + ": the pop-out refusal names the main window, once (" + lines.length + " lines)");
    rmSync(r.dir, { recursive: true });
  }
}
{
  // The first overlay push of a pop-out comes from its own options; the main
  // window keeps its fixed push.
  const r = popRig();
  ok(r.main.overlays.length === 1 && J(r.main.overlays[0]) === J({ color: "#00000000", symbolColor: "#fff", height: 36 }),
     "the main window's first overlay push is unchanged: " + J(r.main.overlays[0]));
  const OWN = { ...OPAQUE, titleBarOverlay: { color: "#262624", symbolColor: "#abcdef", height: 44 } };
  const a = openPopout(r, r.view, "o1", r.P(r.view, "o1", OWN));
  ok(a.win.overlays.length === 1 && J(a.win.overlays[0]) === J({ color: "#00000000", symbolColor: "#abcdef", height: 44 }),
     "a pop-out's first overlay push keeps its own symbolColor and height, only the colour is forced: " + J(a.win.overlays[0]));
  ok(OWN.titleBarOverlay.color === "#262624", "and the options object is not mutated");
  const b = openPopout(r, r.view, "o2", r.P(r.view, "o2", FRAMED));
  ok(b.win.overlays.length === 0, "an OS-framed pop-out (no titleBarOverlay) gets no initial overlay push");
  b.win.setTitleBarOverlay({ color: "#262624" });
  ok(b.win.overlays.length === 1 && b.win.overlays[0].color === "#00000000", "but its later overlay pushes are still forced clear");
  rmSync(r.dir, { recursive: true });
}
{
  // A pending open that never produces a window.
  const r = popRig();
  const timers = [];
  r.t.sandbox.setTimeout = (f, ms) => { const tm = { f, ms, unrefd: false, cleared: false, unref() { tm.unrefd = true; return tm; } }; timers.push(tm); return tm; };
  r.t.sandbox.clearTimeout = (tm) => { tm.cleared = true; };
  const o = r.P(r.view, "e1", OPAQUE);
  const tm = timers.find((x) => x.ms === 10000);
  ok(!!tm && tm.unrefd, "a pending open expires after 10 s on an unref'd timer");
  tm.f();
  const e = openPopout(r, r.view, "e1", o);
  await tick();
  ok(e.child.inserted === 0 && e.win.overlays.length === 0, "an expired pending entry never marks a window");
  // Taken in time: the timer is cleared.
  const o2 = r.P(r.view, "e2", OPAQUE);
  const tm2 = timers.filter((x) => x.ms === 10000).pop();
  const e2 = openPopout(r, r.view, "e2", o2);
  await tick();
  ok(tm2.cleared && e2.child.inserted === 1, "a window created in time marks it and clears the timer");
  // The opener is destroyed first.
  const o3 = r.P(r.view, "e3", OPAQUE);
  const tm3 = timers.filter((x) => x.ms === 10000).pop();
  r.view.destroyed = true;
  r.view.fire("destroyed");
  r.view.destroyed = false;
  const e3 = openPopout(r, r.view, "e3", o3);
  await tick();
  ok(tm3.cleared && e3.child.inserted === 0 && e3.win.overlays.length === 0,
     "pending entries of a destroyed opener are dropped (timer cleared, nothing marked)");
  rmSync(r.dir, { recursive: true });
}
{
  // A pop-out that navigates to another site is handed back to upstream's painting, opaque.
  const sender = { sender: { getURL: () => "https://claude.ai/x", isDestroyed: () => false } };
  const r = popRig();
  r.view.fire("dom-ready");
  const { child, win } = openPopout(r, r.view, "n1", r.P(r.view, "n1", OPAQUE));
  await tick();
  ok(child.inserted === 1 && win.painted.length === 0, "before the navigation: styled, background guarded");
  const lines = [];
  r.t.sandbox.__cdbDiag = (l) => lines.push(l);
  child.navigate("https://example.com/page?x=1");
  child.fire("dom-ready");
  await tick();
  ok(win.painted.length === 1 && win.painted[0] === "#151515", "a pop-out that left about:blank is painted opaque (" + J(win.painted) + ")");
  ok(lines.filter((l) => /pop-out left the app/.test(l)).length === 1 && !lines.some((l) => /x=1/.test(l)), "with one log line, without the query");
  win.setBackgroundColor("#262624");
  ok(win.painted.length === 2 && win.painted[1] === "#262624", "its setBackgroundColor reaches the real window again");
  win.setTitleBarOverlay({ color: "#262624", height: 44 });
  ok(win.overlays[win.overlays.length - 1].color === "#262624", "and so does its overlay colour");
  const n0 = child.inserted, painted = win.painted.length;
  const pv = await r.t.handlers["cdb-wt:level-preview"](sender, 0.6);
  child.navigate("about:blank");
  child.fire("dom-ready");
  await tick();
  ok(child.inserted === n0 && win.painted.length === painted && pv.live === 1,
     "later slider changes and an about:blank document do not touch it again");
  // Another page of the app is still ours.
  const r2 = popRig();
  const q = openPopout(r2, r2.view, "n2", r2.P(r2.view, "n2", OPAQUE));
  await tick();
  q.child.navigate("https://claude.ai/chat/2");
  q.child.fire("dom-ready");
  await tick();
  ok(q.win.painted.length === 1 && q.win.painted[0] === "#151515" && q.child.inserted === 1,
     "a pop-out that navigates to an app page is not styled either, so it is painted opaque too");
  rmSync(r.dir, { recursive: true });
  rmSync(r2.dir, { recursive: true });
}
{
  // An about:blank document of a window we did not mark is not tracked at all
  // (kills a removed popouts.has in the dom-ready branch).
  const r = popRig();
  const u = openPopout(r, r.view, "unmarked", OPAQUE);
  await tick();
  ok(u.child.count("destroyed") === 0 && u.child.inserted === 0, "an unmarked about:blank document is neither styled nor tracked");
  // Navigating away drops the entry (kills a removed styled.delete): the page
  // comes back without a dom-ready, a slider move must not insert into it.
  const sender = { sender: { getURL: () => "https://claude.ai/x", isDestroyed: () => false } };
  r.view.fire("dom-ready");
  await tick();
  const n0 = r.view.inserted;
  r.view.navigate("https://evil.example/");
  r.view.fire("dom-ready");
  await tick();
  r.view.navigate("https://claude.ai/new");
  await r.t.handlers["cdb-wt:level-preview"](sender, 0.6);
  ok(r.view.inserted === n0 && r.view.removed.length === 0, "a main view that navigated away is dropped from the live set");
  rmSync(r.dir, { recursive: true });
}

// --- sub-patch C on a fixture shaped like upstream's window manager.
{
  const BIN = join(ROOT, "patches", "community", "add_feature_window_transparency");
  if (!existsSync(BIN)) {
    try { execFileSync("make", ["-C", join(ROOT, "patches"), "community/add_feature_window_transparency"], { stdio: "ignore" }); } catch {}
  }
  if (!existsSync(BIN)) {
    console.log("  skip patches/community/add_feature_window_transparency is not compiled: the fixture checks");
  } else {
    const MAIN = "function mk(){return{backgroundColor:fQn({signedIn:c}),opacity:1,icon:z}}\n";
    const MGR = "/*FX-BEGIN*/class M{constructor(){this.pendingWindows=new Map;this.config={devWarnings:!1}}" +
      "getDefaultWindowOptions(){return{width:800,webPreferences:{sandbox:!0}}}" +
      "buildConstructorOptions(e,n){return{transparent:e.transparent??!1,frame:e.frame??!0,titleBarStyle:e.titleBarStyle}}" +
      "attach(e,n){e.setWindowOpenHandler((t=>{let{frameName:r,url:i}=t,a=this.pendingWindows.get(r);if(i===\"about:blank\"&&a){" +
      "if(a.ownerWebContentsId!==e.id)return this.config.devWarnings&&p(`window.open for \"${r}\" denied \\u2014 registration owned by a different WebContents.`),{action:\"deny\"};" +
      "let t=this.buildConstructorOptions(a.props,e),n=this.getDefaultWindowOptions();" +
      "return{action:\"allow\",overrideBrowserWindowOptions:{...n,...t,webPreferences:{...n.webPreferences,nodeIntegration:!1,contextIsolation:!0,sandbox:n.webPreferences?.sandbox??!0},show:!1}}}" +
      "return n?.fallbackWindowOpenHandler?n.fallbackWindowOpenHandler(t):{action:\"deny\"}}))}}/*FX-END*/\n";
    const d = mkdtempSync(join(tmpdir(), "cdb-wt-fx-"));
    const run = (src) => {
      const f = join(d, "index.js");
      writeFileSync(f, src);
      let code = 0, out = "";
      try { out = execFileSync(BIN, [f], { encoding: "utf8" }); } catch (e) { code = e.status; out = String(e.stdout || ""); }
      return { code, out, text: readFileSync(f, "utf8") };
    };
    const good = run('"use strict";' + MAIN + MGR);
    ok(good.code === 0 && /\[OK\] pop-out window options: wrapped/.test(good.out), "fixture: the pop-out sub-patch applies");
    const wraps = good.text.split("overrideBrowserWindowOptions:(globalThis.__cdbWinTransPopout||function(w,f,o){return o})(e,r,{...n,...t,").length - 1;
    ok(wraps === 1, "fixture: the literal is wrapped exactly once, with the opener and the frame name");
    const again = run(good.text);
    ok(again.code === 0 && again.text === good.text && /already present \(idempotent\)/.test(again.out),
       "fixture: a second run is idempotent and says so");

    // Run the patched handler: only the about:blank allow branch reaches the hook.
    const fx = good.text.slice(good.text.indexOf("/*FX-BEGIN*/"), good.text.indexOf("/*FX-END*/"));
    const calls = [];
    const ctx = vm.createContext({ globalThis: null });
    ctx.globalThis = ctx;
    ctx.__cdbWinTransPopout = (w, f, o) => { calls.push([w, f, o]); return { ...o, transparent: true }; };
    vm.runInContext(fx + ";globalThis.M=M;", ctx);
    const mgr = new ctx.M();
    let handler = null;
    const owner = { id: 7, setWindowOpenHandler: (h) => { handler = h; } };
    const createWin = { action: "allow", createWindow: () => null, overrideBrowserWindowOptions: {} };
    mgr.attach(owner, { fallbackWindowOpenHandler: () => createWin });
    mgr.pendingWindows.set("pop1", { ownerWebContentsId: 7, props: { titleBarStyle: "hidden" } });
    mgr.pendingWindows.set("theirs", { ownerWebContentsId: 8, props: {} });
    const res = handler({ frameName: "pop1", url: "about:blank" });
    ok(calls.length === 1 && calls[0][0] === owner && calls[0][1] === "pop1" && calls[0][2].show === false &&
       calls[0][2].transparent === false, "patched handler: the hook gets (opener, frame name, upstream's options)");
    ok(res.action === "allow" && res.overrideBrowserWindowOptions.transparent === true, "patched handler: the hook's answer is used");
    ok(handler({ frameName: "pop1", url: "https://x.example/" }) === createWin && calls.length === 1,
       "patched handler: a non-about:blank open (fallback with createWindow) never reaches the hook");
    ok(handler({ frameName: "theirs", url: "about:blank" }).action === "deny" && calls.length === 1,
       "patched handler: a registration owned by another webContents is denied without the hook");
    ok(handler({ frameName: "nobody", url: "about:blank" }) === createWin && calls.length === 1,
       "patched handler: an unregistered id never reaches the hook");
    delete ctx.__cdbWinTransPopout;
    const plain = handler({ frameName: "pop1", url: "about:blank" });
    ok(plain.overrideBrowserWindowOptions.transparent === false && plain.overrideBrowserWindowOptions.show === false,
       "patched handler: without the module the options are upstream's");

    // Shapes the sub-patch must refuse loudly instead of passing silently.
    const absent = run('"use strict";' + MAIN + "class M{}\n");
    ok(absent.code !== 0 && /matched 0\/1/.test(absent.out), "fixture without the window manager: the patch fails");
    const twice = run('"use strict";' + MAIN + MGR + MGR);
    ok(twice.code !== 0 && /matched 2\/1/.test(twice.out), "fixture with two matching handlers: the patch fails");
    const skew = run('"use strict";' + MAIN + MGR.replace("buildConstructorOptions(a.props,e)", "buildConstructorOptions(a.props,x)"));
    ok(skew.code !== 0 && /do not line up/.test(skew.out), "fixture whose opener does not line up: the patch fails");
    const shadowDefaults = run('"use strict";' + MAIN + MGR.replace("n=this.getDefaultWindowOptions()", "r=this.getDefaultWindowOptions()").replace("{...n,...t,", "{...r,...t,"));
    ok(shadowDefaults.code !== 0 && /shadows the frame name or the opener/.test(shadowDefaults.out),
       "fixture whose defaults variable shadows the frame name: the patch fails");
    const shadowCtor = run('"use strict";' + MAIN + MGR.replace("let t=this.buildConstructorOptions", "let r=this.buildConstructorOptions").replace("...n,...t,", "...n,...r,"));
    ok(shadowCtor.code !== 0 && /shadows the frame name or the opener/.test(shadowCtor.out),
       "fixture whose constructor-options variable shadows the frame name: the patch fails");
    const shadowOpener = run('"use strict";' + MAIN + MGR.replace("let t=this.buildConstructorOptions", "let e=this.buildConstructorOptions").replace("...n,...t,", "...n,...e,"));
    ok(shadowOpener.code !== 0 && /shadows the frame name or the opener/.test(shadowOpener.out),
       "fixture whose constructor-options variable shadows the opener: the patch fails");
    const shadowDefOpener = run('"use strict";' + MAIN + MGR.replace("n=this.getDefaultWindowOptions()", "e=this.getDefaultWindowOptions()").replace("{...n,...t,", "{...e,...t,"));
    ok(shadowDefOpener.code !== 0 && /shadows the frame name or the opener/.test(shadowDefOpener.out),
       "fixture whose defaults variable shadows the opener: the patch fails");
    const half = run(good.text.replace("...globalThis.__cdbWinTransExtra(),", ""));
    ok(half.code !== 0 && /half-patched/.test(half.out), "a half-patched bundle fails instead of passing");
    rmSync(d, { recursive: true });
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
