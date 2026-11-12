#!/usr/bin/env node
/*
 * test-theme-dom-ready-scope.mjs - which pages does the theme engine paint? (GitHub #284)
 *
 * patches/core/add_feature_custom_themes.nim hooks app "web-contents-created" and, on
 * every "dom-ready", injects the active theme's sheet. It used to do that for EVERY
 * webContents except devtools, localhost dev servers and the picker page, so the Code
 * tab's browser pane (an arbitrary third-party site) came up wearing the user's theme.
 * The hook now themes a page only when its URL is one of the app's own documents:
 *   - origin https://claude.ai, https://preview.claude.ai, https://claude.com,
 *     https://preview.claude.com (the 1P main view)
 *   - app://localhost (3P; its opaque origin "null" is normalised to protocol + host)
 *   - a file: URL inside app.asar/.vite/renderer/ (Quick Entry, find-in-page, buddy, ...)
 *
 * The engine really runs (electron shimmed, fake webContents recording insertCSS and
 * executeJavaScript). For each URL the suite fires web-contents-created + dom-ready with
 * a theme active and checks two independent signals: insertCSS was called, and the
 * engine logged "Injected CSS+JS into <url>". It then switches the theme live through
 * __cdbThemes.apply() and checks that the switch reaches exactly the themed pages.
 *
 * Control: the same engine with the hook's guard swapped back to the old skip list
 * (string substitution on the built module, the two lines quoted from git history).
 * It must theme https://github.com/ - proof that the fixture reproduces #284 and that
 * the guard, not something incidental, is what fixes it.
 *
 * Usage: node scripts/tests/core/test-theme-dom-ready-scope.mjs   (exit 3 = SKIP, 1 = FAIL)
 */
import { installEngine, mkWc, settle, reporter, runSuite } from "../lib/theme-engine-harness.mjs";

const V = (bg) => ({ "--bg-000": bg, "--accent-brand": "0 100% 50%" });
const CONFIG = {
  activeTheme: "harness-a",
  themeWatch: false,
  themes: {
    "harness-a": { name: "Harness A", light: V("0 0% 99%"), dark: V("0 0% 3%") },
    "harness-b": { name: "Harness B", light: V("0 0% 95%"), dark: V("0 0% 7%") },
  },
};

const ASAR = "file:///usr/lib/claude-desktop/resources/app.asar/.vite/renderer/";
const THEMED = [
  "https://claude.ai/new",
  "https://preview.claude.ai/x",
  "https://claude.com/",
  "https://preview.claude.com/",
  "app://localhost/new",
  "app://localhost/setup-desktop-3p",
  ASAR + "main_window/index.html",
  ASAR + "quick_window/quick-window.html",
  ASAR + "find_in_page/find-in-page.html",
  ASAR + "buddy_window/buddy.html",
  // AppImage: the same tree under a FUSE mount point
  "file:///tmp/.mount_X/usr/lib/claude-desktop/resources/app.asar/.vite/renderer/main_window/index.html",
];
const NOT_THEMED = [
  "https://github.com/",
  "https://sso.example.com/realms/x/protocol/openid-connect/auth",
  "http://localhost:3000/",
  "http://127.0.0.1:5173/",
  "https://localhost/",
  "devtools://devtools/bundled/x.html",
  "cowork-file://preview/test.pdf",
  "about:blank",
  "data:text/html,hi",
  "file:///home/x/page.html",
  "file:///home/x/.config/Claude/cdb-theme-picker/picker.html",
  "https://claude.ai.evil.com/",
  "https://support.claude.com/",
  "app://localhost:1234/",
  "",
];

// NEW_GUARD is the hook's current guard; OLD_GUARD is its form before #284, quoted from
// git history (add_feature_custom_themes.nim). The control swaps one for the other.
const NEW_GUARD =
  "var pop=!__cdb_themable(url)&&__cdb_popoutChild(wc,url);\n" +
  "if(!pop&&!__cdb_themable(url)){__cdb_wcKeys.delete(wc);return}";
const OLD_GUARD =
  'var pop=false;\nif(url.indexOf("devtools://")===0)return;\n' +
  'if(url.indexOf("http://localhost")===0||url.indexOf("http://127.0.0.1")===0||url.indexOf("https://localhost")===0)return;';

const injectedLog = (diag, url) => diag.some((m) => m === "[CustomThemes] Injected CSS+JS into " + url);

/** A fake webContents whose URL can change, so navigation away can be simulated. */
function mkNavWc(url, opts) {
  const wc = mkWc(url, opts);
  wc.url = url;
  wc.getURL = () => wc.url;
  return wc;
}

function open(appEvents, url, opts) {
  const wc = mkNavWc(url, opts);
  appEvents["web-contents-created"]({}, wc);
  wc.fire("dom-ready");
  return wc;
}

await runSuite(async () => {
  const r = reporter("Theme engine: dom-ready injection is scoped to the app's own pages (#284)");

  // ------------------------------------------------------------------ [1] patched engine
  const { themes: T, appEvents, diag } = installEngine({ config: CONFIG });
  r.ok(T.active() === "harness-a", "engine booted with the harness theme active", T.active());
  const wcs = new Map();
  for (const url of [...THEMED, ...NOT_THEMED]) wcs.set(url, open(appEvents, url));
  await settle();

  r.section("[1] app pages get the theme at dom-ready");
  for (const url of THEMED) {
    const wc = wcs.get(url);
    r.ok(wc.css.length === 1 && injectedLog(diag, url), "themed: " + url,
      "insertCSS x" + wc.css.length + ", log " + injectedLog(diag, url));
  }

  r.section("[2] everything else is left alone");
  for (const url of NOT_THEMED) {
    const wc = wcs.get(url);
    r.ok(wc.css.length === 0 && wc.js.length === 0 && !injectedLog(diag, url),
      "not themed: " + (url === "" ? '"" (empty URL)' : url),
      "insertCSS x" + wc.css.length + ", executeJavaScript x" + wc.js.length + ", log " + injectedLog(diag, url));
  }

  r.section("[3] a live switch reaches the themed pages and only those");
  const before = new Map([...wcs].map(([u, wc]) => [u, wc.css.length]));
  const res = T.apply("harness-b");
  await settle();
  r.ok(!res || res.ok !== false, "apply(harness-b) succeeded", res && JSON.stringify(res));
  for (const url of THEMED) {
    const wc = wcs.get(url);
    r.ok(wc.css.length > before.get(url) && wc.removedKeys.length >= 1,
      "re-styled on switch: " + url, "insertCSS x" + wc.css.length + ", removed " + wc.removedKeys.length);
  }
  const reached = NOT_THEMED.filter((u) => wcs.get(u).css.length || wcs.get(u).js.length || wcs.get(u).win.bg.length);
  r.ok(reached.length === 0, "no skipped page is touched by the switch (css, js or window background)",
    reached.join(", "));

  // A page opened AFTER the switch picks up the current theme, and a third-party one still does not.
  const late = open(appEvents, "https://claude.ai/late");
  const lateGh = open(appEvents, "https://github.com/late");
  await settle();
  r.ok(late.css.length === 1 && late.css[0] === wcs.get(THEMED[0]).sheet(),
    "a claude.ai page opened after the switch gets the current sheet");
  r.ok(lateGh.css.length === 0, "a github.com page opened after the switch gets nothing");

  r.section("[4] a themed webContents that navigates to a third-party site");
  // The guard runs per dom-ready, so the new document gets no sheet, and insertCSS is
  // per-document, so the old sheet went with the old page. The guard also drops the
  // webContents from the engine's live set, so a later theme switch must not reach it.
  const nav = open(appEvents, "https://claude.ai/nav");
  await settle();
  r.ok(nav.css.length === 1, "the claude.ai document is themed first", "insertCSS x" + nav.css.length);
  nav.url = "https://github.com/login";
  nav.fire("dom-ready");
  await settle();
  const snap = () => [nav.css.length, nav.js.length, nav.win.bg.length].join("/");
  const atNav = snap();
  r.ok(nav.css.length === 1, "the third-party document is not themed at its dom-ready", "insertCSS x" + nav.css.length);
  T.apply("harness-a");
  await settle();
  r.ok(snap() === atNav,
    "a live switch does not reach it (no insertCSS, executeJavaScript or setBackgroundColor)",
    "css/js/bg " + atNav + " -> " + snap());
  // Navigating back to the app's own page puts it back under the engine.
  nav.url = "https://claude.ai/back";
  nav.fire("dom-ready");
  await settle();
  const back = nav.css.length;
  r.ok(back === 2, "back on claude.ai it is themed again at dom-ready", "insertCSS x" + back);
  T.apply("harness-b");
  await settle();
  r.ok(nav.css.length === 3, "and a live switch reaches it again", "insertCSS x" + nav.css.length);

  // ------------------------------------------------------------------ [6] popout children
  // A popped-out Code session is a window.open("about:blank") child of the main view
  // (GitHub #331). It is themed only when the opener is a main frame on an app origin.
  r.section("[6] a popout child of the main view is themed, followed live and painted");
  const POP = [
    ["1P", "https://claude.ai/new"],
    ["3P", "app://localhost/new"],
  ];
  for (const [label, openerUrl] of POP) {
    const e = installEngine({ config: CONFIG });
    const pop = open(e.appEvents, "about:blank", { opener: { url: openerUrl, parent: null } });
    const stranger = open(e.appEvents, "about:blank", { opener: null });
    await settle();
    const logged = e.diag.some((m) => m.indexOf("Injected CSS+JS into about:blank") >= 0 &&
      m.indexOf("popout") >= 0);
    r.ok(pop.css.length === 1, label + ": popout child gets the active sheet at dom-ready", "insertCSS x" + pop.css.length);
    r.ok(pop.js.some((s) => s.indexOf("var __CDB_SPINNER_SPEC=") === 0), label + ": popout child gets the spinner payload");
    r.ok(logged, label + ": the log line names it a popout child", e.diag.join(" | "));
    const origin = openerUrl.startsWith("app:") ? "app://localhost" : "https://claude.ai";
    const line = e.diag.find((m) => m.indexOf("Injected CSS+JS into about:blank") >= 0) || "";
    r.ok(line.indexOf(origin) >= 0 && line.indexOf(openerUrl) < 0,
      label + ": the log line names the opener origin, not the full opener URL", line);
    r.ok(pop.win.bg[pop.win.bg.length - 1] === "#fcfcfc",
      label + ": popout window background is painted with the theme color", JSON.stringify(pop.win.bg));
    r.ok(stranger.css.length === 0 && stranger.win.bg.length === 0, label + ": about:blank without an opener stays untouched");
    const n = pop.css.length;
    e.themes.apply("harness-b");
    await settle();
    r.ok(pop.css.length === n + 1 && pop.removedKeys.length >= 1 && pop.sheet() !== pop.css[0],
      label + ": live switch re-styles the popout child", "insertCSS x" + pop.css.length);
    r.ok(stranger.css.length === 0 && stranger.win.bg.length === 0, label + ": ...and still not the opener-less about:blank");
    const rm = pop.removedKeys.length;
    e.themes.apply(null);
    await settle();
    r.ok(pop.removedKeys.length > rm, label + ": clearing the theme removes the popout's sheet", "removed " + pop.removedKeys.length);
    e.themes.apply("harness-a");
    await settle();
    const nn = pop.css.length;
    e.nativeTheme.shouldUseDarkColors = true;
    e.nativeTheme.emit("updated");
    await new Promise((res) => setTimeout(res, 400));
    r.ok(pop.css.length > nn, label + ": a nativeTheme flip re-styles the popout child", "insertCSS x" + nn + " -> " + pop.css.length);
  }

  r.section("[7] about:blank that is not a popout child of an app main frame stays stock");
  const bgN = (wc) => (wc.win ? wc.win.bg.length : 0);
  const VALID = { url: "https://claude.ai/new", parent: null };
  const REFUSED = [
    ["no opener (null)", "about:blank", { opener: null }],
    ["opener getter throws", "about:blank", { openerThrows: true }],
    ["third-party opener", "about:blank", { opener: { url: "https://github.com/", parent: null } }],
    ["subframe opener on a non-app origin", "about:blank",
      { opener: { url: "https://x.frame.claudeusercontent.com/", parent: {} } }],
    ["subframe opener with a themable URL", "about:blank", { opener: { url: "https://claude.ai/new", parent: {} } }],
    ["opener url empty", "about:blank", { opener: { url: "", parent: null } }],
    ["opener url about:blank", "about:blank", { opener: { url: "about:blank", parent: null } }],
    ["opener url not a string", "about:blank", { opener: { url: undefined, parent: null } }],
    ["opener parent undefined", "about:blank", { opener: { url: "https://claude.ai/new" } }],
    ["type webview", "about:blank", { opener: VALID, type: "webview" }],
    ["type backgroundPage", "about:blank", { opener: VALID, type: "backgroundPage" }],
    ["getType throws", "about:blank", { opener: VALID, typeThrows: true }],
    ["empty child URL", "", { opener: VALID }],
    ["view-hosted (fromWebContents returns the host window)", "about:blank", { opener: VALID, hosted: true }],
    ["fromWebContents returns null", "about:blank", { opener: VALID, noWindow: true }],
  ];
  {
    const e = installEngine({ config: CONFIG });
    const made = REFUSED.map(([label, url, opts]) => [label, open(e.appEvents, url, opts)]);
    await settle();
    for (const [label, wc] of made) {
      r.ok(wc.css.length === 0 && wc.js.length === 0 && bgN(wc) === 0, "refused at dom-ready: " + label,
        "css " + wc.css.length + ", js " + wc.js.length + ", bg " + bgN(wc));
    }
    e.themes.apply("harness-b");
    await settle();
    for (const [label, wc] of made) {
      r.ok(wc.css.length === 0 && wc.js.length === 0 && bgN(wc) === 0, "untouched by a live switch: " + label,
        "css " + wc.css.length + ", js " + wc.js.length + ", bg " + bgN(wc));
    }
  }

  r.section("[8] a themed popout child that navigates to a third-party site is untracked");
  {
    const e = installEngine({ config: CONFIG });
    const pop = open(e.appEvents, "about:blank", { opener: VALID });
    await settle();
    r.ok(pop.css.length === 1, "the popout child is themed first", "insertCSS x" + pop.css.length);
    pop.url = "https://github.com/";
    pop.fire("dom-ready");
    await settle();
    const snapP = () => [pop.css.length, pop.js.length, pop.win.bg.length].join("/");
    const at = snapP();
    e.themes.apply("harness-b");
    await settle();
    r.ok(snapP() === at, "a live switch no longer reaches it", "css/js/bg " + at + " -> " + snapP());
  }

  r.section("[9] tracking is decided at dom-ready only (did-start-navigation never untracks)");
  {
    for (const shape of ["details", "positional"]) {
      const e = installEngine({ config: CONFIG });
      const nav = (wc, url) => shape === "details"
        ? wc.fire("did-start-navigation", { url, isSameDocument: false, isMainFrame: true })
        : wc.fire("did-start-navigation", {}, url, false, true);
      const view = open(e.appEvents, "https://claude.ai/new");
      const pop = open(e.appEvents, "about:blank", { opener: VALID });
      await settle();
      // upstream blocks the external navigation (it opens the system browser), so no new dom-ready follows
      nav(view, "https://github.com/x");
      nav(pop, "https://github.com/x");
      const v0 = view.css.length, p0 = pop.css.length, vr = view.removedKeys.length, pr = pop.removedKeys.length;
      e.themes.apply("harness-b");
      await settle();
      r.ok(view.css.length === v0 + 1 && view.removedKeys.length > vr,
        shape + ": a main view that saw a blocked external navigation still gets a live switch",
        "insertCSS x" + v0 + " -> " + view.css.length);
      r.ok(pop.css.length === p0 + 1 && pop.removedKeys.length > pr,
        shape + ": ...and so does a popout", "insertCSS x" + p0 + " -> " + pop.css.length);
      const vr2 = view.removedKeys.length, pr2 = pop.removedKeys.length;
      e.themes.apply(null);
      await settle();
      r.ok(view.removedKeys.length > vr2 && pop.removedKeys.length > pr2,
        shape + ": clearing the theme removes both sheets");
    }
    // a late insertCSS resolve for a wc that dom-ready untracked in the meantime
    const e = installEngine({ config: CONFIG });
    const held = open(e.appEvents, "about:blank", { opener: VALID, deferInsert: true });
    // the dom-ready insert is still pending when the document turns out to be third-party
    held.url = "https://idp.example/";
    held.fire("dom-ready");
    const rmBefore = held.removedKeys.length, cssBefore = held.css.length;
    held.flushInserts();
    await settle();
    r.ok(held.removedKeys.length === rmBefore, "the late key is dropped, removeInsertedCSS is not called for it",
      "removed " + rmBefore + " -> " + held.removedKeys.length);
    e.themes.apply("harness-b");
    await settle();
    held.flushInserts();
    await settle();
    r.ok(held.css.length === cssBefore && held.js.length === 1, "and it is not re-tracked: a later switch does not touch it",
      "insertCSS x" + cssBefore + " -> " + held.css.length);
  }

  r.section("[10] opener on an app origin only: a file: renderer-page opener is refused");
  {
    const e = installEngine({ config: CONFIG });
    const filePop = open(e.appEvents, "about:blank", { opener: { url: ASAR + "main_window/index.html", parent: null } });
    const appPop = open(e.appEvents, "about:blank", { opener: { url: "app://localhost/new", parent: null } });
    await settle();
    r.ok(filePop.css.length === 0 && filePop.js.length === 0 && filePop.win.bg.length === 0,
      "a file: opener is not themed or painted at dom-ready");
    e.themes.apply("harness-b");
    await settle();
    r.ok(filePop.css.length === 0 && filePop.js.length === 0 && filePop.win.bg.length === 0,
      "and a live switch does not reach it");
    r.ok(appPop.css.length >= 1, "an app://localhost opener is still themed");
  }

  r.section("[11] no-theme invariant: a never-themed popout window is not painted by a flip");
  {
    const e = installEngine({ config: { themes: CONFIG.themes, themeWatch: false } });
    const flip = async (dark) => {
      e.nativeTheme.shouldUseDarkColors = dark;
      e.nativeTheme.emit("updated");
      await new Promise((res) => setTimeout(res, 400));
    };
    const pop = open(e.appEvents, "about:blank", { opener: VALID });
    pop.win.ov = []; pop.win.setTitleBarOverlay = (o) => pop.win.ov.push(o);
    const shell = open(e.appEvents, ASAR + "main_window/index.html");
    await settle();
    r.ok(e.themes.active() == null, "no theme is active");
    await flip(true);
    r.ok(pop.win.bg.length === 0 && pop.win.ov.length === 0, "flip with no theme: the popout window is not painted",
      "bg " + pop.win.bg.length + ", overlay " + pop.win.ov.length);
    r.ok(shell.win.bg.length >= 1, "...while the main_window shell still gets its stock paint", "bg " + shell.win.bg.length);
    // upstream's own overlay push passes through unchanged with no theme
    pop.win.setTitleBarOverlay({ color: "#151515", symbolColor: "#c2c0b6", height: 36 });
    await flip(false);
    e.themes.apply("harness-a");
    await settle();
    const nTheme = pop.win.bg.length;
    r.ok(nTheme >= 1 && pop.win.bg[nTheme - 1] === "#fcfcfc", "a theme paints the popout (light variant bg)",
      JSON.stringify(pop.win.bg));
    r.ok(pop.win.ov.length >= 2, "with a theme the popout's caption overlay is recolored", JSON.stringify(pop.win.ov));
    pop.win.setTitleBarOverlay({ color: "#151515", symbolColor: "#c2c0b6", height: 36 });
    const lastOv = pop.win.ov[pop.win.ov.length - 1];
    r.ok(lastOv.color !== "#151515" && lastOv.height === 36, "an upstream push is recolored while a theme is active", JSON.stringify(lastOv));
    const bg1 = pop.win.bg.length;
    e.themes.apply(null);
    await settle();
    r.ok(pop.win.bg.length === bg1 + 1 && pop.win.bg[bg1] === "#fcfcfb", "clearing the theme repaints the popout to stock once",
      JSON.stringify(pop.win.bg.slice(bg1)));
    await flip(true);
    r.ok(pop.win.bg.length > bg1 + 1 && pop.win.bg[pop.win.bg.length - 1] === "#151515",
      "later flips keep it in step with stock", JSON.stringify(pop.win.bg.slice(bg1)));
    // after clearing, an upstream push passes through unchanged
    pop.win.setTitleBarOverlay({ color: "#fcfcfb", symbolColor: "#3d3d3a", height: 36 });
    const lo = pop.win.ov[pop.win.ov.length - 1];
    r.ok(JSON.stringify(lo) === JSON.stringify({ color: "#fcfcfb", symbolColor: "#3d3d3a", height: 36 }),
      "with the theme cleared an upstream push passes through unchanged", JSON.stringify(lo));
  }

  // ------------------------------------------------------------------ [5] control
  r.section("[5] control: the old skip list (devtools / localhost / picker only)");
  const old = installEngine({
    config: CONFIG,
    transform: (src) => src.split(NEW_GUARD).join(OLD_GUARD),
  });
  const oldGh = open(old.appEvents, "https://github.com/");
  const oldLocal = open(old.appEvents, "http://localhost:3000/");
  const oldMain = open(old.appEvents, "https://claude.ai/new");
  await settle();
  r.ok(oldGh.css.length === 1 && injectedLog(old.diag, "https://github.com/"),
    "the old guard themes https://github.com/ (#284 reproduced)");
  r.ok(oldLocal.css.length === 0, "the old guard skips http://localhost:3000/ (control engine is sane)");
  r.ok(oldMain.css.length === 1, "the old guard themes https://claude.ai/new (control engine is sane)");

  r.done();
});
