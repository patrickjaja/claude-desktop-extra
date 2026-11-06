#!/usr/bin/env node
/*
 * test-cowork-device-icon-web.mjs - the Cowork device icon in the claude.ai
 * chat header (patches/linux/fix_cowork_device_icon_web.nim,
 * js/cowork_device_icon_web_main.js + js/cowork_device_icon_web_page.js).
 *
 * WHY THIS EXISTS
 * ---------------
 * Upstream shows a device icon in a chat's title row only for a chat linked to
 * a computer, or for a session that runs on this one. A desktop without a
 * device key is never linked, so its chats show nothing and nothing says why.
 * The page script fills exactly that gap and must never put a second icon
 * next to upstream's. The anchors are remote claude.ai code
 * (baseline/COWORK_HEADER_ICON_ANCHORS.md), so the fixtures below are built
 * from the live 4.23118.0 measurements recorded there.
 *
 * [main]  the main module, as the compiled patch embeds it (JS-side
 *         replacement when the binary is not built): injects only into https
 *         claude.ai / claude.com, never app://localhost, re-inserts its CSS per
 *         document, nothing off Linux; the patch is idempotent.
 * [page]  headless Chromium, one iframe per scenario: bound -> upstream icon
 *         untouched + one "Linux details" row; local -> row with the VM
 *         readiness line; slot -> nothing; keyless -> X icon; keyed unbound ->
 *         amber icon; upstream indicator appearing later removes ours; never
 *         two icons; popover keyboard/outside-click; clicks call
 *         __cdbExtraOpen("cu", <section>); anchor misses warn once; 3P and
 *         non-main views install nothing; the pure state table.
 *
 * Usage: node scripts/tests/linux/test-cowork-device-icon-web.mjs [--keep]
 * Exit: 0 PASS, 1 FAIL, 3 SKIP (no chromium).
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { ROOT, Skip, findChromium, dumpDom, readProbe, reporter, runSuite } from "../lib/theme-engine-harness.mjs";

const KEEP = process.argv.includes("--keep");
const MAIN_JS = readFileSync(join(ROOT, "js/cowork_device_icon_web_main.js"), "utf8");
const PAGE_JS = readFileSync(join(ROOT, "js/cowork_device_icon_web_page.js"), "utf8");
const BIN = join(ROOT, "patches/linux/fix_cowork_device_icon_web");

await runSuite(async () => {
  const r = reporter("Cowork device icon (1P chat header)");
  const out = mkdtempSync(join(tmpdir(), "cdb-cowork-icon-"));

  // ---------------------------------------------------------------- [main]
  r.section("[main] injection host filter and the patch");
  r.ok(/^[\x00-\x7f]*$/.test(PAGE_JS), "the page module is ASCII (the patch embeds it as a JS string)");
  let bundle;
  const staged = join(out, "index.js");
  writeFileSync(staged, '"use strict";var upstream=1;\n');
  if (existsSync(BIN)) {
    execFileSync(BIN, [staged], { stdio: "ignore" });
    const once = readFileSync(staged, "utf8");
    execFileSync(BIN, [staged], { stdio: "ignore" });
    bundle = readFileSync(staged, "utf8");
    r.ok(once === bundle, "a second run is byte-identical (idempotent)");
    r.ok(bundle.split("/*__CDB_COWORK_ICON_WEB__*/").length === 2, "one marker");
    r.ok(bundle.startsWith('"use strict";' + MAIN_JS.slice(0, 40)) && bundle.endsWith("var upstream=1;\n"),
      "injected right after the prologue, upstream code kept after it");
    let checked = true;
    try { execFileSync(process.execPath, ["--check", staged], { stdio: "ignore" }); } catch { checked = false; }
    r.ok(checked, "node --check passes on the patched file");
  } else {
    r.note("patch binary not built: embedding the page source in JS instead (run make in patches/ for the real one)");
    const esc = PAGE_JS.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "");
    bundle = '"use strict";' + MAIN_JS.replace('"__CDB_COWORK_ICON_WEB_PAGE_SRC__"', '"' + esc + '"') + "var upstream=1;\n";
  }

  function runMain(platform) {
    const handlers = {};
    const all = [];
    let ons = 0;
    const ctx = {
      process: { platform },
      require: (m) => {
        if (m === "electron") return { app: { on: (ev, fn) => { ons++; handlers[ev] = fn; } }, webContents: { getAllWebContents: () => all } };
        if (m === "url") return { URL };
        throw new Error("unexpected require " + m);
      },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(bundle, ctx);
    function wc(url) {
      const w = { url, ev: {}, js: [], css: [], removed: [], destroyed: false, n: 0 };
      w.getURL = () => w.url;
      w.isDestroyed = () => w.destroyed;
      w.on = (ev, fn) => { w.ev[ev] = fn; };
      w.executeJavaScript = (src) => { w.js.push(src); return Promise.resolve(); };
      w.insertCSS = (css) => { w.css.push(css); return Promise.resolve("key" + (++w.n)); };
      w.removeInsertedCSS = (k) => { w.removed.push(k); return Promise.resolve(); };
      all.push(w);
      if (handlers["web-contents-created"]) handlers["web-contents-created"]({}, w);
      return w;
    }
    return { ctx, handlers, wc, ons: () => ons };
  }
  const tick = () => new Promise((res) => setImmediate(res));

  const m = runMain("linux");
  r.ok(typeof m.handlers["web-contents-created"] === "function", "registers one web-contents-created handler on Linux");
  const good = ["https://claude.ai/chat/abc", "https://claude.ai/new", "https://a.claude.ai/x", "https://claude.com/chat/1"];
  const bad = ["app://localhost/", "app://localhost/chat/abc", "http://claude.ai/chat/abc", "https://claude.ai.evil.com/",
    "https://evilclaude.ai/", "file:///chat/abc", "about:blank", "not a url"];
  let goodOk = true;
  for (const u of good) {
    const w = m.wc(u); w.ev["dom-ready"]();
    if (w.js.length !== 1 || w.js[0] !== PAGE_JS || w.css.length !== 1) goodOk = false;
  }
  r.ok(goodOk, "claude.ai / claude.com (https): the exact page source runs once per dom-ready, with the stylesheet");
  let badOk = true;
  for (const u of bad) {
    const w = m.wc(u); w.ev["dom-ready"]();
    if (w.js.length || w.css.length) badOk = false;
  }
  r.ok(badOk, "app://localhost (3P), http, look-alike hosts and non-web URLs: nothing injected");
  const w2 = m.wc("https://claude.ai/chat/abc");
  w2.ev["dom-ready"](); await tick(); w2.ev["dom-ready"](); await tick();
  r.ok(w2.css.length === 2 && w2.removed.length === 1 && w2.removed[0] === "key1",
    "a new document drops the previous sheet key before inserting again", JSON.stringify(w2.removed));
  const css = w2.css[0];
  r.ok(/\.cdb-cowork-icon\{/.test(css) && /\.cdb-cowork-icon-pop\{/.test(css) && /var\(--cds-fill-danger/.test(css) &&
    /var\(--cds-fill-warning/.test(css), "the sheet styles the icon, badges and popover with --cds-* tokens");
  const before = w2.js.length;
  m.ctx.__cdbCoworkIconWebRefresh();
  r.ok(w2.js.length === before + 1 && w2.css.length === 2, "the refresh hook re-runs the page script without another sheet");
  const destroyed = m.wc("https://claude.ai/chat/z"); destroyed.destroyed = true; destroyed.ev["dom-ready"]();
  r.ok(destroyed.js.length === 0, "a destroyed webContents is skipped");
  vm.runInContext(bundle, m.ctx);
  r.ok(m.ctx.__cdbCoworkIconWebMain === true && m.ons() === 1, "the main guard makes a second evaluation a no-op", m.ons());
  for (const p of ["win32", "darwin"]) {
    const off = runMain(p);
    r.ok(!off.handlers["web-contents-created"] && off.ctx.__cdbCoworkIconWebMain === undefined, "nothing registered on " + p);
  }

  // ---------------------------------------------------------------- [page]
  r.section("[page] headless Chromium scenarios");
  const chromium = findChromium();
  if (!chromium) throw new Skip("no chromium/chrome on this machine");
  const sheetFromMain = css;

  const page = `<!doctype html>
<meta charset="utf-8">
<body>
<pre id="out"></pre>
<script>
var SRC = ${JSON.stringify(PAGE_JS)};
var CSS = ${JSON.stringify(sheetFromMain)};
var lines = [];
function ok(c, label, extra) { lines.push((c ? "PASS " : "FAIL ") + label + (extra !== undefined && !c ? "  -> " + extra : "")); }
function done() { document.getElementById("out").textContent = lines.join("\\n"); }

// One iframe per scenario: a fresh window, so the install guard and the
// observer are the real ones each time. The script runs with "location"
// shadowed (a file:// page cannot pushState to /chat/...).
function frame(html, next) {
  var f = document.createElement("iframe");
  f.style.width = "900px"; f.style.height = "500px";
  f.srcdoc = "<!doctype html><meta charset=utf-8><style>" + CSS + "</style><body>" + html + "</body>";
  f.onload = function () { next(f.contentWindow); };
  document.body.appendChild(f);
}
function setup(w, o) {
  o = o || {};
  var t = { warns: [], diags: [], opens: [], icon: 0, settings: 0, listeners: [], loc: { protocol: o.protocol || "https:", pathname: o.path || "/chat/c1" } };
  w.console.warn = function (m) { t.warns.push(String(m)); };
  if (o.bridge !== false) {
    w.cdbExtra = {
      diag: function (m) { t.diags.push(String(m)); return Promise.resolve({ ok: true }); },
      cuStatusIcon: function () { t.icon++; return Promise.resolve(o.vm || { ok: true, mode: "1p", tpm: "ok", vm: { now: "ok", tools: "ok", running: false }, line: "Local VM ready" }); },
      extraOpenSettings: function () { t.settings++; return Promise.resolve({ ok: true }); }
    };
  }
  if (o.device !== undefined) {
    t.dev = o.device;
    t.syncReads = 0;
    w["claude.web"] = { WindowState: { deviceLinkStore: {
      getStateSync: function () { t.syncReads++; return t.dev; },
      onStateChange: o.noSubscribe ? undefined : function (fn) { t.listeners.push(fn); return function () {}; }
    } } };
  }
  if (o.deeplink !== false) w.__cdbExtraOpen = function (k, s) { t.opens.push(k + "/" + s); if (o.deeplink === "throw") throw new Error("x"); return o.deeplink !== "refuse"; };
  t.run = function () { (new w.Function("location", SRC))(t.loc); };
  t.push = function (v) { t.dev = v; t.listeners.forEach(function (fn) { fn(v); }); };
  t.w = w; t.d = w.document;
  t.icons = function () { return t.d.querySelectorAll("button.cdb-cowork-icon"); };
  t.mutate = function () { t.d.body.appendChild(t.d.createElement("i")); };
  return t;
}
function fib(el, props, parent) { el["__reactFiber$test"] = { memoizedProps: props, return: parent || null }; }
function seat(id) { return { memoizedProps: { children: [] }, return: { memoizedProps: { sessionTitle: "T", isChatSession: true, scheduledTaskId: null, sessionId: id }, return: null } }; }
// Title row per the live measurement: title, then the trailing span.ms-1 slot.
function header(trailing, withSlot) {
  return '<main><div data-testid="session-title-split" class="flex min-w-0 items-center" id="split">' +
    '<span class="truncate">A chat title</span>' + (withSlot === false ? "" : '<span class="ms-1" id="trail">' + (trailing || "") + "</span>") + "</div></main>";
}
var LINK = '<button type="button" data-cds="Button" data-cds-ghost="" class="ghost icon" aria-label="jajapc, Connected" data-testid="cowork-computer-link-indicator" data-status="connected"><span data-cds="Icon"></span></button>';
var LOCAL = '<button type="button" data-cds="Button" data-cds-ghost="" class="ghost icon" aria-label="Only on this computer" data-testid="cowork-local-session-indicator"><span data-cds="Icon"></span></button>';
var SLOT = '<span aria-hidden="true" class="inline-flex h-control w-control shrink-0" data-testid="cowork-computer-link-indicator-slot"></span>';
function portal(inner) {
  return '<div data-base-ui-portal=""><div data-cds-portal=""><div role="presentation">' +
    '<div data-cds="PreviewCard" role="group" aria-labelledby="pt" id="card">' + inner + "</div></div></div></div>";
}
var LINK_CARD = '<div class="flex flex-col p-1"><div class="flex flex-col gap-0.5 px-md py-sm"><span id="pt" class="truncate text-body">jajapc</span>' +
  '<span data-testid="cowork-computer-link-status">Connected</span><span data-testid="cowork-computer-link-status-detail" class="text-footnote text-muted-as-secondary">detail</span></div>' +
  '<div class="flex flex-col" id="actions"><div aria-hidden="true" class="my-1 h-px bg-border"></div>' +
  '<button type="button" data-cds="Button" data-cds-ghost="" class="w-full justify-start" data-testid="cowork-computer-link-manage" id="manage"><span data-cds="Icon" class="ico">\ue001</span><span class="truncate">Manage devices</span></button></div></div>';
var LOCAL_CARD = '<div class="flex flex-col p-1" id="col"><div class="flex flex-col gap-0.5 px-md py-sm"><span class="text-body font-medium text-primary">Only on this computer</span>' +
  '<span class="text-footnote text-muted-as-secondary">Runs here</span></div></div>';
function addPortal(t, html) { var d = t.d.createElement("div"); d.innerHTML = html; var n = d.firstChild; t.d.body.appendChild(n); return n; }
function waitFor(cond, next, tries) {
  tries = tries === undefined ? 60 : tries;
  if (cond() || tries <= 0) { next(); return; }
  setTimeout(function () { waitFor(cond, next, tries - 1); }, 25);
}
function settle(next) { waitFor(function () { return false; }, next, 6); }
function key(t, k) { t.d.dispatchEvent(new t.w.KeyboardEvent("keydown", { key: k, bubbles: true })); }
function down(t, el) { el.dispatchEvent(new t.w.PointerEvent("pointerdown", { bubbles: true })); }
function count(arr, re) { return arr.filter(function (s) { return re.test(s); }).length; }

var steps = [];
function step(fn) { steps.push(fn); }
function next() { var s = steps.shift(); if (s) s(next); else done(); }

// ---- state table ---------------------------------------------------------
step(function (go) {
  frame("", function (w) {
    var t = setup(w, { device: { connected: true, idSource: "keyed" } });
    t.run();
    var S = w.__cdbCoworkIconState;
    ok(typeof S === "function", "state: window.__cdbCoworkIconState is exposed");
    var K = { connected: true, idSource: "keyed" };
    var rows = [
      [{ upstream: "indicator", cloud: true, device: null }, "details-row"],
      [{ upstream: "indicator", cloud: false, device: K }, "details-row"],
      [{ upstream: "slot", cloud: true, device: null }, "none"],
      [{ upstream: "none", cloud: true, device: null }, "neutral"],
      [{ upstream: "none", cloud: true, device: { connected: true, idSource: "keyless" } }, "keyless"],
      [{ upstream: "none", cloud: true, device: { connected: false, idSource: "none" } }, "keyless"],
      [{ upstream: "none", cloud: true, device: { connected: true } }, "neutral"],
      [{ upstream: "none", cloud: true, device: { connected: true, idSource: "attested" } }, "neutral"],
      [{ upstream: "none", cloud: true, device: { connected: false, idSource: null } }, "neutral"],
      [{ upstream: "none", cloud: true, device: K }, "keyed-unbound"],
      [{ upstream: "none", cloud: true, device: { connected: false, idSource: "keyed" } }, "keyed-unbound"],
      [{ upstream: "none", cloud: false, device: null }, "local"],
      [null, "none"], [{ upstream: "weird", cloud: true }, "none"]
    ];
    var bad = rows.filter(function (row) { return S(row[0]) !== row[1]; });
    ok(bad.length === 0, "state: the C5 table (" + rows.length + " rows)", JSON.stringify(bad));
    go();
  });
});

// ---- bound chat: upstream icon untouched + one details row ----------------
step(function (go) {
  frame(header(LINK), function (w) {
    var t = setup(w, { device: { connected: true, idSource: "keyed" } });
    fib(t.d.getElementById("split"), {}, seat("c1").return);
    var trail = t.d.getElementById("trail"), before = trail.innerHTML;
    t.run();
    settle(function () {
      ok(t.icons().length === 0, "bound: no icon of ours next to upstream's indicator");
      ok(trail.innerHTML === before, "bound: upstream's trailing slot is unchanged");
      t.d.querySelector('[data-testid="cowork-computer-link-indicator"]').setAttribute("data-popup-open", "");
      var p = addPortal(t, portal(LINK_CARD));
      waitFor(function () { var m = t.d.querySelector(".cdb-cowork-icon-mode"); return m && /\\(ready\\)$/.test(m.textContent); }, function () {
        var rows = t.d.querySelectorAll(".cdb-cowork-icon-row");
        var manage = t.d.getElementById("manage");
        ok(rows.length === 1, "bound: one details row in the popover", rows.length);
        ok(rows[0] && manage.nextSibling === rows[0], "bound: the row sits right after Manage devices");
        var b = rows[0] && rows[0].querySelector("button");
        ok(b && b.textContent === "Linux details", "bound: the row button says Linux details", b && b.textContent);
        ok(b && b.getAttribute("data-cds") === "Button" && b.hasAttribute("data-cds-ghost") && /w-full justify-start/.test(b.className),
          "bound: the button is a clone of upstream's ghost button", b && b.className);
        ok(b && !b.hasAttribute("data-testid"), "bound: the clone carries no upstream test id");
        ok(b && b.querySelector('[data-cds="Icon"]') && b.querySelector('[data-cds="Icon"]').textContent === "" && b.querySelector("span.truncate").textContent === "Linux details",
          "bound: the label goes into span.truncate, the icon span keeps its place (text cleared)");
        ok(manage.textContent === "\ue001Manage devices" && t.d.querySelectorAll('[data-testid="cowork-computer-link-manage"]').length === 1,
          "bound: upstream's manage button is untouched");
        ok(rows[0].getAttribute("data-cdb-cowork-icon") === "details", "bound: row is marked data-cdb-cowork-icon=details");
        var ml = t.d.querySelector(".cdb-cowork-icon-mode");
        var det = t.d.querySelector('[data-testid="cowork-computer-link-status-detail"]');
        ok(ml && ml.textContent === "Runs in the cloud - files and commands on jajapc run in its local Cowork VM (ready)", "bound: mode line names the computer and its local VM state", ml && ml.textContent);
        ok(ml && det.nextSibling === ml && !t.d.getElementById("actions").contains(ml),
          "bound: the mode line sits in the status block right after the status detail, above the divider");
        ok(ml && /text-footnote text-muted-as-secondary/.test(ml.className), "bound: the mode line borrows the status-detail classes", ml && ml.className);
        ok(t.d.querySelectorAll(".cdb-cowork-icon-mode").length === 1 && rows[0].children.length === 1 && rows[0].firstChild === b,
          "bound: exactly one mode line; the row holds only the cloned Linux details button");
        b.click();
        ok(t.opens.join() === "cu/cloud", "bound: Linux details -> __cdbExtraOpen(cu, cloud)", t.opens.join());
        t.mutate(); t.mutate();
        settle(function () {
          ok(t.d.querySelectorAll(".cdb-cowork-icon-row").length === 1 && t.d.querySelectorAll(".cdb-cowork-icon-mode").length === 1, "bound: rescans add no second row or line");
          ok(t.icons().length === 0, "bound: still no icon of ours");
          ok(t.warns.length === 0, "bound: no warnings", t.warns.join(" | "));
          p.remove();
          go();
        });
      });
    });
  });
});

// ---- local session: row with readiness line --------------------------------
step(function (go) {
  frame(header(LOCAL), function (w) {
    var t = setup(w, { path: "/cowork/local_abc", device: { connected: true, idSource: "keyless" } });
    fib(t.d.getElementById("split"), {}, seat("local_abc").return);
    t.run();
    settle(function () {
      ok(t.icons().length === 0, "local: no icon of ours next to upstream's local indicator (even keyless)");
      t.d.querySelector('[data-testid="cowork-local-session-indicator"]').setAttribute("data-popup-open", "");
      addPortal(t, portal(LOCAL_CARD));
      waitFor(function () { var l = t.d.querySelector(".cdb-cowork-icon-line"); return l && l.textContent === "Runs in the local VM on this computer - ready"; }, function () {
        var rows = t.d.querySelectorAll(".cdb-cowork-icon-row");
        ok(rows.length === 1, "local: one details row", rows.length);
        ok(rows[0] && rows[0].parentNode === t.d.getElementById("col") && rows[0].firstChild.className === "my-1 h-px bg-border",
          "local: the row (divider + button) goes last into the card's padded column");
        var line = t.d.querySelector(".cdb-cowork-icon-line");
        ok(line && line.parentNode === t.d.getElementById("col").firstChild && line.previousElementSibling.textContent === "Runs here" &&
          /text-footnote text-muted-as-secondary/.test(line.className), "local: the mode line sits in the title block after upstream's detail, same classes");
        ok(line && line.textContent === "Runs in the local VM on this computer - ready", "local: one merged mode + readiness line from cuStatusIcon()", line && line.textContent);
        ok(t.d.querySelectorAll(".cdb-cowork-icon-line").length === 1, "local: no second line");
        ok(t.icon === 1, "local: cuStatusIcon called once per open", t.icon);
        var b = rows[0] && rows[0].querySelector("button");
        ok(b && b.textContent === "Linux details", "local: Linux details button");
        b.click();
        ok(t.opens.join() === "cu/local", "local: Linux details -> __cdbExtraOpen(cu, local)", t.opens.join());
        t.mutate();
        settle(function () {
          ok(t.d.querySelectorAll(".cdb-cowork-icon-row").length === 1 && t.icon === 1, "local: rescans add nothing and do not re-read");
          go();
        });
      });
    });
  });
});

// ---- upstream placeholder slot: nothing ------------------------------------
step(function (go) {
  frame(header(SLOT), function (w) {
    var t = setup(w, { device: { connected: true, idSource: "keyless" } });
    fib(t.d.getElementById("split"), {}, seat("c1").return);
    t.run();
    settle(function () {
      ok(t.icons().length === 0, "slot: nothing rendered while upstream shows its placeholder");
      go();
    });
  });
});

// ---- keyless: X icon in our own slot, popover keyboard + outside click ----
step(function (go) {
  frame(header("", false), function (w) {
    var t = setup(w, { device: { connected: true, idSource: "keyless" } });
    var split = t.d.getElementById("split");
    fib(split, {}, seat("c2").return);
    t.run();
    var b = t.icons()[0];
    ok(t.icons().length === 1, "keyless: one icon", t.icons().length);
    ok(b && b.getAttribute("data-cdb-cowork-icon") === "keyless", "keyless: X variant");
    ok(b && b.parentNode.classList.contains("cdb-cowork-icon-slot") && b.parentNode.classList.contains("ms-1") && split.lastChild === b.parentNode,
      "keyless: no upstream slot -> our own span.ms-1 as the row's last child");
    ok(b && b.querySelector(".cdb-cowork-icon-badge svg"), "keyless: the badge draws an X");
    ok(b && /no device key/.test(b.getAttribute("aria-label")) && b.getAttribute("aria-expanded") === "false" && b.getAttribute("aria-haspopup") === "dialog",
      "keyless: aria-label, aria-expanded=false, aria-haspopup=dialog");
    var cs = w.getComputedStyle(b.querySelector(".cdb-cowork-icon-badge"));
    ok(cs.display === "block", "keyless: the main sheet shows the badge", cs.display);
    ok(b.getBoundingClientRect().width >= 20 && b.getBoundingClientRect().width <= 48, "keyless: icon button has control size", b.getBoundingClientRect().width);
    b.click();
    var pop = t.d.querySelector(".cdb-cowork-icon-pop");
    ok(pop && pop.getAttribute("role") === "dialog" && pop.getAttribute("aria-labelledby"), "keyless: click opens a labelled role=dialog popover");
    ok(pop && pop.querySelector(".cdb-cowork-icon-pop-title").textContent === "No device key", "keyless: title No device key");
    ok(pop && pop.querySelector(".cdb-cowork-icon-pop-mode").textContent === "Runs in the cloud" &&
      pop.querySelector(".cdb-cowork-icon-pop-mode").nextSibling.textContent === "Cloud tasks can't use Computer Use (screen and input) on this computer. Files and commands still work.",
      "keyless: Runs in the cloud, then only Computer Use is lost");
    ok(pop && !/can't use it|not connected/i.test(pop.textContent), "keyless: no claim that the computer is unusable");
    ok(pop && pop.lastChild.tagName === "BUTTON", "keyless: the action comes last");
    ok(b.getAttribute("aria-expanded") === "true" && b.getAttribute("aria-controls") === (pop && pop.id), "keyless: aria-expanded=true + aria-controls");
    var act = pop && pop.querySelector("button");
    ok(act && act.textContent === "Set up" && t.d.activeElement === act, "keyless: focus moves to Set up");
    key(t, "Escape");
    ok(!t.d.querySelector(".cdb-cowork-icon-pop") && b.getAttribute("aria-expanded") === "false", "keyless: Escape closes");
    ok(t.d.activeElement === b, "keyless: focus returns to the icon");
    b.click();
    down(t, t.d.body);
    ok(!t.d.querySelector(".cdb-cowork-icon-pop"), "keyless: an outside pointerdown closes");
    b.click(); b.click();
    ok(!t.d.querySelector(".cdb-cowork-icon-pop"), "keyless: a second click on the icon toggles it closed");
    b.click();
    down(t, t.d.querySelector(".cdb-cowork-icon-pop"));
    ok(t.d.querySelectorAll(".cdb-cowork-icon-pop").length === 1, "keyless: a pointerdown inside keeps it open");
    t.d.querySelector(".cdb-cowork-icon-pop button").click();
    ok(t.opens.join() === "cu/cloud", "keyless: Set up -> __cdbExtraOpen(cu, cloud)", t.opens.join());
    ok(!t.d.querySelector(".cdb-cowork-icon-pop"), "keyless: the deep link closes the popover");
    t.run(); // main re-runs the page script (refresh hook / second dom-ready)
    t.mutate(); t.mutate();
    settle(function () {
      ok(t.icons().length === 1 && t.d.querySelectorAll(".cdb-cowork-icon-slot").length === 1, "keyless: a re-run and rescans keep exactly one icon");
      ok(t.syncReads === 1 && t.listeners.length === 1, "keyless: one sync read + one onStateChange subscription", t.syncReads + "/" + t.listeners.length);
      ok(t.warns.length === 0 && t.diags.length === 0, "keyless: no warnings", t.warns.join(" | "));
      t.loc.pathname = "/new"; t.mutate();
      waitFor(function () { return t.icons().length === 0; }, function () {
        ok(t.icons().length === 0 && !t.d.querySelector(".cdb-cowork-icon-slot"), "keyless: leaving the chat route removes the icon and our slot");
        t.loc.pathname = "/epitaxy/x"; t.mutate();
        settle(function () {
          ok(t.icons().length === 0, "keyless: a Code route gets nothing");
          go();
        });
      });
    });
  });
});

// ---- keyed, unbound: amber; store updates; upstream appears later ---------
step(function (go) {
  frame(header(""), function (w) {
    var t = setup(w, { path: "/chat/c3", device: { connected: true, idSource: "keyed" } });
    fib(t.d.getElementById("split"), {}, seat("c3").return);
    t.run();
    var trail = t.d.getElementById("trail");
    var b = t.icons()[0];
    ok(t.icons().length === 1 && b.getAttribute("data-cdb-cowork-icon") === "keyed-unbound", "keyed: amber variant");
    ok(b.parentNode === trail && !t.d.querySelector(".cdb-cowork-icon-slot"), "keyed: inside upstream's span.ms-1, no own slot");
    ok(w.getComputedStyle(b.querySelector(".cdb-cowork-icon-badge")).display === "block" && !b.querySelector(".cdb-cowork-icon-badge svg"),
      "keyed: a plain dot badge");
    b.click();
    var pop = t.d.querySelector(".cdb-cowork-icon-pop");
    ok(pop && /Not connected to this chat/.test(pop.textContent) && /device key/.test(pop.textContent), "keyed: popover says not connected to this chat");
    ok(pop && pop.querySelector(".cdb-cowork-icon-pop-mode").textContent === "Runs in the cloud", "keyed: Runs in the cloud line");
    pop.querySelector("button").click();
    ok(t.opens.join() === "cu/cloud", "keyed: Linux details -> __cdbExtraOpen(cu, cloud)", t.opens.join());
    t.push({ connected: true, idSource: "keyless" });
    waitFor(function () { return t.icons()[0] && t.icons()[0].getAttribute("data-cdb-cowork-icon") === "keyless"; }, function () {
      ok(t.icons().length === 1 && t.icons()[0].getAttribute("data-cdb-cowork-icon") === "keyless", "keyed: a store update re-renders (keyless)");
      ok(t.icons()[0] === b, "keyed: the same button is reused");
      var ind = t.d.createElement("div"); ind.innerHTML = LINK; trail.appendChild(ind.firstChild);
      waitFor(function () { return t.icons().length === 0; }, function () {
        ok(t.icons().length === 0, "upstream indicator appears -> ours is removed");
        ok(t.d.querySelectorAll('[data-testid="cowork-computer-link-indicator"]').length === 1, "upstream's indicator stays");
        trail.removeChild(trail.querySelector('[data-testid="cowork-computer-link-indicator"]'));
        waitFor(function () { return t.icons().length === 1; }, function () {
          ok(t.icons().length === 1, "upstream indicator removed -> ours is back (one)");
          var slot = t.d.createElement("div"); slot.innerHTML = SLOT; trail.appendChild(slot.firstChild);
          waitFor(function () { return t.icons().length === 0; }, function () {
            ok(t.icons().length === 0, "upstream slot appears -> ours is removed");
            go();
          });
        });
      });
    });
  });
});

// ---- no subscription: one sync read per session ----------------------------
step(function (go) {
  frame(header(""), function (w) {
    var t = setup(w, { device: { connected: true, idSource: "keyed" }, noSubscribe: true });
    fib(t.d.getElementById("split"), {}, seat("c4").return);
    t.run(); t.mutate(); t.mutate();
    settle(function () {
      ok(t.icons().length === 1 && t.syncReads === 1, "no onStateChange: one sync read for the session, not per scan", t.syncReads);
      go();
    });
  });
});

// ---- anchor misses: one warn each -------------------------------------------
step(function (go) {
  frame(header("", false), function (w) {
    var t = setup(w, { path: "/cowork/local_q" }); // no device store, no fiber
    t.run(); t.mutate(); t.mutate(); t.mutate();
    settle(function () {
      ok(t.icons().length === 1 && t.icons()[0].getAttribute("data-cdb-cowork-icon") === "local",
        "fallback: a local session without upstream's indicator gets the local icon (URL id)");
      ok(count(t.warns, /^\\[cdb-cowork-icon\\] no-seat: /) === 1, "anchor miss: no-seat warned once across rescans", t.warns.join(" | "));
      ok(count(t.diags, /^\\[cdb-cowork-icon\\] no-seat: /) === 1, "anchor miss: and one diag line");
      t.icons()[0].click();
      waitFor(function () { var p = t.d.querySelector(".cdb-cowork-icon-pop-text"); return p && p.textContent === "Runs in the local VM on this computer - ready"; }, function () {
        var p = t.d.querySelector(".cdb-cowork-icon-pop");
        ok(p && /Runs on this computer \\(local VM\\)/.test(p.textContent) && p.querySelectorAll(".cdb-cowork-icon-pop-text").length === 1, "fallback: local popover with one merged mode + readiness line");
        p.querySelector("button").click();
        ok(t.opens.join() === "cu/local", "fallback: Linux details -> __cdbExtraOpen(cu, local)", t.opens.join());
        t.loc.pathname = "/chat/c9"; t.mutate();
        waitFor(function () { return t.icons()[0] && t.icons()[0].getAttribute("data-cdb-cowork-icon") === "neutral"; }, function () {
          ok(t.icons().length === 1 && t.icons()[0].getAttribute("data-cdb-cowork-icon") === "neutral", "no device store: neutral, no warning icon");
          ok(count(t.warns, /no-device-store/) === 1, "anchor miss: no-device-store warned once", t.warns.join(" | "));
          go();
        });
      });
    });
  });
});

step(function (go) {
  frame("<main id=m></main>", function (w) {
    var t = setup(w, { path: "/chat/c5", device: { connected: true, idSource: "keyless" } });
    t.run();
    var n = 0;
    (function burst() {
      if (n++ < 34) { t.mutate(); setTimeout(burst, 60); return; }
      settle(function () {
        ok(count(t.warns, /no-header/) === 1, "anchor miss: no-header once after repeated scans without a title row", t.warns.join(" | "));
        ok(t.icons().length === 0, "no title row: nothing rendered");
        go();
      });
    })();
  });
});

step(function (go) {
  frame(header("", false), function (w) {
    var t = setup(w, { device: { connected: true, idSource: "keyless" }, deeplink: false });
    fib(t.d.getElementById("split"), {}, { memoizedProps: { sessionTitle: "T", sessionId: 7 }, return: null });
    t.run();
    t.icons()[0].click();
    t.d.querySelector(".cdb-cowork-icon-pop button").click();
    settle(function () {
      ok(count(t.warns, /no-deeplink/) === 1 && t.settings === 1, "no __cdbExtraOpen: warns once and asks main for settings", t.warns.join(" | "));
      ok(count(t.warns, /no-session/) === 1, "anchor miss: a non-string sessionId warns no-session", t.warns.join(" | "));
      go();
    });
  });
});

step(function (go) {
  frame(header(LOCAL), function (w) {
    var t = setup(w, { path: "/cowork/local_r", device: { connected: true, idSource: "keyed" } });
    fib(t.d.getElementById("split"), {}, seat("local_r").return);
    t.run();
    t.d.querySelector('[data-testid="cowork-local-session-indicator"]').setAttribute("data-popup-open", "");
    t.mutate();
    settle(function () {
      ok(count(t.warns, /no-popup/) === 1, "anchor miss: an open indicator without any PreviewCard warns no-popup once", t.warns.join(" | "));
      go();
    });
  });
});

// ---- neutral: key state unknown -> plain laptop, no claim -------------------
step(function (go) {
  frame(header(""), function (w) {
    var t = setup(w, { path: "/chat/n1", device: { connected: false, appStartedMs: 1 } });
    fib(t.d.getElementById("split"), {}, seat("n1").return);
    t.run();
    var b = t.icons()[0];
    ok(t.icons().length === 1 && b.getAttribute("data-cdb-cowork-icon") === "neutral", "neutral: no idSource -> neutral icon");
    ok(w.getComputedStyle(b.querySelector(".cdb-cowork-icon-badge")).display === "none", "neutral: no badge");
    b.click();
    var pop = t.d.querySelector(".cdb-cowork-icon-pop");
    ok(pop && pop.querySelectorAll(".cdb-cowork-icon-pop-text").length === 1 && pop.querySelector(".cdb-cowork-icon-pop-mode").textContent === "Runs in the cloud" &&
      !/device key|Not connected/.test(pop.textContent), "neutral: only the Runs in the cloud line, no claim", pop && pop.textContent);
    ok(pop && pop.querySelector("button").textContent === "Linux details", "neutral: Linux details only");
    pop.querySelector("button").click();
    ok(t.opens.join() === "cu/cloud", "neutral: Linux details -> __cdbExtraOpen(cu, cloud)", t.opens.join());
    t.push({ connected: true, idSource: "keyless" });
    waitFor(function () { return t.icons()[0].getAttribute("data-cdb-cowork-icon") === "keyless"; }, function () {
      ok(t.icons()[0].getAttribute("data-cdb-cowork-icon") === "keyless", "neutral: an explicit keyless answer turns it into the X");
      go();
    });
  });
});

// ---- a renamed upstream indicator in the trailing slot: never two icons ----
step(function (go) {
  frame(header('<button type="button" data-cds="Button" aria-label="x" data-testid="cowork-renamed-indicator"></button>'), function (w) {
    var t = setup(w, { device: { connected: true, idSource: "keyless" } });
    fib(t.d.getElementById("split"), {}, seat("c8").return);
    t.run();
    settle(function () {
      ok(t.icons().length === 0, "fail safe: any upstream button in span.ms-1 counts as its indicator");
      go();
    });
  });
});

// ---- popover a11y: describedby, focusout, reposition on scroll -------------
step(function (go) {
  frame('<div style="height:2000px">' + header("") + "</div>", function (w) {
    var t = setup(w, { device: { connected: true, idSource: "keyless" } });
    fib(t.d.getElementById("split"), {}, seat("c10").return);
    var out = t.d.createElement("button"); out.textContent = "elsewhere"; t.d.body.appendChild(out);
    t.run();
    var b = t.icons()[0];
    b.click();
    var pop = t.d.querySelector(".cdb-cowork-icon-pop");
    var ids = pop ? pop.getAttribute("aria-describedby").split(" ") : [];
    ok(ids.length === 2 && /Runs in the cloud/.test(t.d.getElementById(ids[0]).textContent) && /Computer Use/.test(t.d.getElementById(ids[1]).textContent),
      "a11y: aria-describedby names the mode and text lines");
    var top0 = pop.style.top;
    w.scrollTo(0, 300); w.dispatchEvent(new w.Event("scroll"));
    ok(pop.style.top !== top0, "scroll: the popover follows the icon", top0 + " -> " + pop.style.top);
    out.focus();
    ok(!t.d.querySelector(".cdb-cowork-icon-pop"), "focusout: focus leaving the popover closes it");
    go();
  });
});

// ---- deep link refused / throwing: settings still open ----------------------
step(function (go) {
  frame(header("", false), function (w) {
    var t = setup(w, { device: { connected: true, idSource: "keyless" }, deeplink: "refuse" });
    fib(t.d.getElementById("split"), {}, seat("c11").return);
    t.run();
    t.icons()[0].click();
    t.d.querySelector(".cdb-cowork-icon-pop button").click();
    settle(function () {
      ok(t.settings === 1 && count(t.warns, /deeplink-refused/) === 1 && count(t.warns, /no-deeplink/) === 0,
        "refused deep link: asks main for settings, warns deeplink-refused", t.warns.join(" | "));
      frame(header("", false), function (w2) {
        var t2 = setup(w2, { device: { connected: true, idSource: "keyless" }, deeplink: "throw" });
        fib(t2.d.getElementById("split"), {}, seat("c12").return);
        t2.run();
        t2.icons()[0].click();
        t2.d.querySelector(".cdb-cowork-icon-pop button").click();
        settle(function () {
          ok(t2.settings === 1 && count(t2.warns, /deeplink-error/) === 1 && count(t2.warns, /deeplink-refused|no-deeplink/) === 0,
            "throwing deep link: asks main for settings, warns deeplink-error", t2.warns.join(" | "));
          go();
        });
      });
    });
  });
});

// ---- local readiness: running / not available, name fallback ---------------
step(function (go) {
  frame(header(LOCAL), function (w) {
    var t = setup(w, { path: "/cowork/local_s", device: { connected: true, idSource: "keyed" },
      vm: { ok: true, mode: "1p", vm: { now: "ok", tools: "ok", running: true }, line: "Local VM ready - running" } });
    fib(t.d.getElementById("split"), {}, seat("local_s").return);
    t.run();
    t.d.querySelector('[data-testid="cowork-local-session-indicator"]').setAttribute("data-popup-open", "");
    addPortal(t, portal(LOCAL_CARD));
    waitFor(function () { var l = t.d.querySelector(".cdb-cowork-icon-line"); return l && /running$/.test(l.textContent); }, function () {
      ok(t.d.querySelector(".cdb-cowork-icon-line").textContent === "Runs in the local VM on this computer - running", "local: running");
      frame(header(LOCAL), function (w2) {
        var t2 = setup(w2, { path: "/cowork/local_u", device: { connected: true, idSource: "keyed" },
          vm: { ok: true, mode: "1p", vm: { now: "no_permission", tools: "ok", running: false }, line: "Local VM unavailable: no access to /dev/kvm or /dev/vhost-vsock" } });
        fib(t2.d.getElementById("split"), {}, seat("local_u").return);
        t2.run();
        t2.d.querySelector('[data-testid="cowork-local-session-indicator"]').setAttribute("data-popup-open", "");
        addPortal(t2, portal(LOCAL_CARD));
        waitFor(function () { var l = t2.d.querySelector(".cdb-cowork-icon-line"); return l && /not available/.test(l.textContent); }, function () {
          ok(t2.d.querySelector(".cdb-cowork-icon-line").textContent ===
            "Runs in the local VM on this computer - not available (no access to /dev/kvm or /dev/vhost-vsock)", "local: not available, with main's reason");
          frame(header(LINK), function (w3) {
            var t3 = setup(w3, { device: { connected: true, idSource: "keyed" } });
            fib(t3.d.getElementById("split"), {}, seat("c13").return);
            t3.run();
            t3.d.querySelector('[data-testid="cowork-computer-link-indicator"]').setAttribute("data-popup-open", "");
            addPortal(t3, portal(LINK_CARD.replace('id="pt" ', 'id="other" ')));
            waitFor(function () { var m = t3.d.querySelector(".cdb-cowork-icon-mode"); return m && /\\)$/.test(m.textContent); }, function () {
              ok(t3.d.querySelector(".cdb-cowork-icon-mode").textContent === "Runs in the cloud - files and commands on jajapc run in its local Cowork VM (ready)",
                "bound: computer name from the indicator aria-label when the title id does not resolve");
              var NA = { ok: true, mode: "1p", vm: { now: "missing", tools: "unknown", running: null }, line: "Local VM unavailable: /dev/kvm is missing (virtualization off in the firmware?)" };
              frame(header(LINK), function (w4) {
                var t4 = setup(w4, { device: { connected: true, idSource: "keyed" }, vm: NA });
                fib(t4.d.getElementById("split"), {}, seat("c14").return);
                t4.run();
                t4.d.querySelector('[data-testid="cowork-computer-link-indicator"]').setAttribute("data-popup-open", "");
                addPortal(t4, portal(LINK_CARD));
                waitFor(function () { var m = t4.d.querySelector(".cdb-cowork-icon-mode"); return m && /not available/.test(m.textContent); }, function () {
                  ok(t4.d.querySelector(".cdb-cowork-icon-mode").textContent ===
                    "Runs in the cloud - jajapc is linked, but its local Cowork VM is not available (/dev/kvm is missing (virtualization off in the firmware?))",
                    "bound: VM not available -> says so with main's reason");
                  frame(header(LINK), function (w5) {
                    var t5 = setup(w5, { device: { connected: true, idSource: "keyed" },
                      vm: { ok: true, mode: "1p", vm: { now: "ok", tools: "ok", running: true }, line: "Local VM ready - running" } });
                    fib(t5.d.getElementById("split"), {}, seat("c15").return);
                    t5.run();
                    t5.d.querySelector('[data-testid="cowork-computer-link-indicator"]').setAttribute("data-popup-open", "");
                    addPortal(t5, portal(LINK_CARD));
                    waitFor(function () { var m = t5.d.querySelector(".cdb-cowork-icon-mode"); return m && /\\(running\\)$/.test(m.textContent); }, function () {
                      ok(t5.d.querySelector(".cdb-cowork-icon-mode").textContent === "Runs in the cloud - files and commands on jajapc run in its local Cowork VM (running)",
                        "bound: VM running");
                      go();
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
});

// ---- 3P and non-main views install nothing ---------------------------------
step(function (go) {
  frame(header("", false), function (w) {
    var t = setup(w, { protocol: "app:", device: { connected: true, idSource: "keyless" } });
    fib(t.d.getElementById("split"), {}, seat("c6").return);
    t.run();
    ok(!w.__cdbCoworkIconInstalled && t.icons().length === 0, "3P (app://localhost): nothing installed");
    frame(header("", false), function (w2) {
      var t2 = setup(w2, { bridge: false, device: { connected: true, idSource: "keyless" } });
      fib(t2.d.getElementById("split"), {}, seat("c7").return);
      t2.run();
      ok(!w2.__cdbCoworkIconInstalled && t2.icons().length === 0, "no cdbExtra bridge (not the main view): nothing installed");
      go();
    });
  });
});

window.addEventListener("load", function () { next(); });
</script>
`;
  const pagePath = join(out, "cowork-icon.html");
  writeFileSync(pagePath, page);
  const dom = dumpDom(chromium, pagePath, ["--virtual-time-budget=60000"]);
  const lines = readProbe(dom, "out");
  if (!lines || lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
    r.ok(false, "the page wrote its results");
    console.log(dom.slice(0, 2000));
  } else r.lines(lines);
  if (KEEP) r.note("files kept in " + out);
  else rmSync(out, { recursive: true, force: true });
  r.done();
});
