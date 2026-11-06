#!/usr/bin/env node
/*
 * test-diff-views-expand-dom.mjs - headless-Chromium DOM tests for the
 * expand/collapse-all button injected into the Code tab's diff panel
 * (js/diff_views_expand.js, mounted by js/diff_views_page.js, both delivered by
 * patches/community/add_feature_diff_views.nim).
 *
 * The diff panel is REMOTE claude.ai markup, so a clean patch run says nothing
 * about this feature working. What CAN be pinned is that the module derives
 * everything from the DOM it is given: the button lands left of the trailing
 * control cluster, it is a stripped clone of the close control, it reads
 * upstream's own aria-expanded rather than any class name, it never clicks a
 * header whose patch has not loaded, it collapses bottom-up, and sticky mode
 * never re-expands a file the user closed.
 *
 * The fixtures reproduce the real shapes recorded in
 * docs/superpowers/specs/2026-08-01-diff-expand-collapse-all-design.md, taken
 * from a live 1.24012.9 install: the chrome row is a breadcrumb plus a trailing
 * run of icon controls ending in .epitaxy-pane-close-control, and each file is a
 * button.epitaxy-panel-subheader whose aria-expanded is ABSENT until its patch
 * loads. The fixture headers toggle their own aria-expanded on click, exactly as
 * upstream's local useState does, and record the click order.
 *
 * No npm dependency: each scenario is a generated HTML file run through
 * `chromium --headless --dump-dom`, and the assertions are read back out of the
 * dumped DOM.
 *
 * THREE THINGS THIS SUITE DELIBERATELY DOES NOT ASSERT VIA THE DOM, because the
 * DOM end state is identical whether or not they happen - only a call count can
 * tell the two apart, so each has a transparent-passthrough spy installed in the
 * page template BEFORE the module is evaluated (never a hook in the shipped JS):
 * the 16 ms coalescing schedule (`__sched16`), `MutationObserver.disconnect()`
 * (`__disconnects`), and the `[cdb-dv]` diagnostics themselves (`__diag`).
 *
 * A scenario may report `SKIP` for a branch it could not exercise here (the
 * icon-font glyph path needs a real Anthropicons woff2 from `tmp/extract*`,
 * which CI does not have). Skips are printed in full and counted in the summary:
 * a run that silently shrank its assertion count would otherwise look exactly
 * like one that exercised everything.
 *
 * Usage: node scripts/tests/community/test-diff-views-expand-dom.mjs [--keep] [--chromium PATH]
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, globSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unescapeHtml } from "../lib/unescape-html.mjs";
import { openIonDist } from "../lib/ion-dist.mjs";
import vm from "node:vm";
import Module from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EXPAND_JS = readFileSync(join(ROOT, "js/diff_views_expand.js"), "utf8");
const PAGE_JS = readFileSync(join(ROOT, "js/diff_views_page.js"), "utf8");

const argv = process.argv.slice(2);
const KEEP = argv.includes("--keep");
const CHROMIUM = (() => {
  const i = argv.indexOf("--chromium");
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  for (const c of ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"]) {
    try {
      const p = execFileSync("/bin/sh", ["-c", "command -v " + c], { encoding: "utf8" }).trim();
      if (p) return p;
    } catch {}
  }
  return null;
})();

// --- fixtures --------------------------------------------------------------
// `state` is one of "true" | "false" | null. null means "patch not loaded":
// upstream omits aria-expanded AND disables the button, which is the case our
// expand-all must skip rather than click.
function header(id, state) {
  const aria = state === null ? "" : ` aria-expanded="${state}"`;
  const dis = state === null ? " disabled" : "";
  const panel = state === "true" ? `<div class="epitaxy-diff-panel">patch body</div>` : "";
  return `<div data-file-wrapper="${id}">
    <button type="button" id="${id}" class="epitaxy-panel-subheader sticky top-0 z-[4] w-full select-none text-left"${aria}${dis}>
      <span aria-hidden="true" class="flex items-center justify-center size-[16px] shrink-0 text-t5">
        <svg width="16" height="16" viewBox="0 0 16 16"><path d="M3.47 5.47a.75.75 0 0 1 1.06 0L8 8.94l3.47-3.47a.75.75 0 1 1 1.06 1.06l-4 4a.75.75 0 0 1-1.06 0l-4-4a.75.75 0 0 1 0-1.06" fill="currentColor"/></svg>
      </span>
      <span class="min-w-0 truncate text-body text-t7">${id}.ts</span>
    </button>${panel}
  </div>`;
}

// The chrome row: a breadcrumb, then the trailing run of icon controls. The
// close control is LAST, the fullscreen control immediately before it - that
// contiguous run is what controlClusterStart() walks back over.
// `extra` is markup appended after the file list - used only by FIXTURES.empty
// to give the panel a genuine diff-view marker (see below) while the id on the
// breadcrumb span lets order() (the DOM test driver) name it "crumb" instead
// of falling back to its bare tag name, the same way it already names the
// fullscreen/close controls by their ids.
function fixture(headers, extra) {
  return `
<div class="epitaxy-view-panel" id="view">
  <div class="chromerow" id="row">
    <span class="crumb" id="crumb">master -> feature/x</span>
    <button type="button" id="fullscreen" class="epitaxy-pane-expand-control" aria-label="Expand"><svg viewBox="0 0 16 16"><path d="M1 1h6"/></svg></button>
    <button type="button" id="close" class="epitaxy-pane-close-control shrink-0 text-t5" aria-label="Close" title="Close panel" data-state="closed" onclick="window.__closed=(window.__closed||0)+1"><svg viewBox="0 0 16 16"><path d="M2 2l12 12"/></svg></button>
  </div>
  <div class="filelist" id="filelist">${headers.join("")}</div>${extra || ""}
</div>`;
}

const FIXTURES = {
  // 3 loaded+collapsed, 2 not loaded: the large-diff case.
  mixed: fixture([header("f1", "false"), header("f2", "false"), header("f3", "false"),
                  header("f4", null), header("f5", null)]),
  // everything open: the collapse-all case.
  open: fixture([header("f1", "true"), header("f2", "true"), header("f3", "true"), header("f4", "true")]),
  // No FILE headers at all, but still a genuine diff-view surface: the
  // vendored diff-viewer library's own container (".diffs-container", one of
  // VIEW_MARKERS) persists even when the file list is empty. This is
  // deliberately NOT the scope-emptied fallback case (qualifiesAsEmptyDiffView
  // in js/diff_views_page.js) - that gate stays OFF in Working tree mode by
  // design, so a fixture with zero markers at all would never qualify as a
  // view and nothing would install, which is a different (already-covered)
  // behavior than "a real diff panel that happens to show 0 files".
  empty: fixture([], '<div class="diffs-container"></div>'),
  // headers exist but none exposes aria-expanded: nothing has loaded (or the
  // upstream attribute contract changed).
  nostate: fixture([header("f1", null), header("f2", null)]),
  // The in-app browser panel as an EMPTY "New tab": a real .epitaxy-view-panel
  // with a chrome row and close control, ZERO diff markers, and - crucially - no
  // iframe/webview yet, so the negative surface check cannot tell it from an
  // emptied diff. Measured live 2026-08-21 (Claude Desktop 1.32352.1): with
  // Branch changes applied, exactly this shape carried our dropdown
  // (wrapperTileId=preview, hasDiffMarkers=false, nonDiffSurface=false,
  // ourDropdown=true). The only honest discriminator is the React fiber's
  // memoizedProps.tileId, which the "leak" scenario wires the same way the live
  // page carries it (observed at hops 3-5 above the view-panel node).
  browser: `
<div class="epitaxy-view-panel" id="view">
  <div class="chromerow" id="row">
    <span class="crumb" id="crumb">New tab</span>
    <button type="button" id="close" class="epitaxy-pane-close-control shrink-0 text-t5" aria-label="Close" title="Close panel"><svg viewBox="0 0 16 16"><path d="M2 2l12 12"/></svg></button>
  </div>
  <div class="browserbody" id="browserbody"></div>
</div>`
};

// --- the in-page test driver ----------------------------------------------

const DRIVER = String.raw`
var results = [];
function ok(cond, msg) { results.push((cond ? "PASS " : "FAIL ") + msg); }
// A branch that could not be exercised in THIS environment. Reported loudly by
// the runner and counted in its summary, so a scenario can never quietly shrink
// its assertion count depending on what happens to be installed.
function skip(msg) { results.push("SKIP " + msg); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function row() { return document.getElementById("row"); }
function toggle() { return document.querySelector(".cdb-dv-toggle"); }
function select() { return document.querySelector(".cdb-dv-select"); }
function order() {
  return Array.prototype.map.call(row().children, function (c) {
    if (c.classList.contains("cdb-dv-select")) return "select";
    if (c.classList.contains("cdb-dv-toggle")) return "toggle";
    return c.id || c.tagName.toLowerCase();
  }).join(",");
}
function ariaOf(id) { return document.getElementById(id).getAttribute("aria-expanded"); }
async function tick(n) { for (var i = 0; i < (n || 3); i++) await sleep(40); }
`;

// Per-scenario assertion bodies are appended as a `run()` function.
const RUNS = {
  placement: String.raw`
async function run() {
  ok(!!toggle(), "the toggle button is injected");
  ok(order() === "crumb,select,toggle,fullscreen,close",
     "order is breadcrumb, select, toggle, then the control cluster: " + order());
  var t = toggle();
  ok(!t.classList.contains("epitaxy-pane-close-control"),
     "the clone does NOT keep the close-control class (it would be re-discovered as a close control)");
  ok(t.classList.contains("shrink-0") && t.classList.contains("text-t5"),
     "the clone keeps upstream's styling classes");
  ok(t.getAttribute("aria-label") === null, "the clone drops upstream's aria-label");
  ok(!!t.title, "and has a title of its own: " + t.title);
  ok(!t.hasAttribute("data-state"), "inherited interaction state is stripped");
  ok(t.getAttribute("type") === "button", "the clone is an explicit type=button");
  ok(t.querySelector("svg") !== null, "an icon is painted (SVG until the font is proven)");
  ok(t.querySelectorAll("svg").length === 1, "exactly one icon node, not upstream's glyph plus ours");
  ok(!t.hasAttribute("disabled"), "with 3 expandable files the button is enabled");

  // cloneNode DOES carry inline handlers over. The fixture's close control has
  // an onclick (upstream's has none today, but nothing stops one appearing), and
  // our clone must not close the panel on top of expanding it.
  ok(!t.hasAttribute("onclick"), "an inherited inline onclick is stripped from the clone");
  window.__closed = 0;
  t.click();
  await tick();
  ok(window.__closed === 0, "so pressing our button does not also run the close handler");

  // MANDATORY install diagnostic (spec section 4). It is the only line a renamed
  // button.epitaxy-panel-subheader would produce - see the empty scenario.
  var inst = window.__diag.filter(function (d) { return /expand-all installed: headers=/.test(d); });
  ok(inst.length === 1, "exactly one install diagnostic: " + (inst[0] || "(none)"));
  ok(/headers=5 expandable=3 expanded=0 pending=2 icon=/.test(inst[0] || ""),
     "and it reports the real counts and the icon source: " + inst[0]);
}`,
  empty: String.raw`
async function run() {
  ok(!!toggle(), "the button installs even with no files, so the row does not reflow later");
  ok(toggle().hasAttribute("disabled"), "with 0 headers the button is disabled");
  ok(/no files/.test(toggle().title), "the title says why: " + toggle().title);
  // WHY THIS LINE MATTERS: if a claude.ai redeploy renames the header selector,
  // classify() returns total=0 and maybeLogStuck() short-circuits, so a panel
  // FULL of files would show a disabled button claiming "no files in this diff"
  // with nothing in the log. headers=0 is the only evidence there would be.
  ok(window.__diag.filter(function (d) {
       return /expand-all installed: headers=0 expandable=0 expanded=0 pending=0/.test(d);
     }).length === 1,
     "the install diagnostic reports headers=0 - the only signal a renamed header " +
     "selector would leave in the log");
}`,
  reactive: String.raw`
async function run() {
  ok(!toggle().hasAttribute("disabled"), "starts enabled with 3 expandable files");
  ok(/Expand all files/.test(toggle().title), "starts as expand-all: " + toggle().title);
  ok(/2 file\(s\) not loaded yet/.test(toggle().title),
     "the title reports the pending files honestly: " + toggle().title);

  // Someone else - the user, or upstream's scroll-target effect - opens a file.
  window.__sched16 = 0;   // zero out any settle-phase scheduling before measuring
  document.getElementById("f1").setAttribute("aria-expanded", "true");
  await tick();
  ok(/Collapse all files/.test(toggle().title),
     "an externally expanded file flips the direction to collapse: " + toggle().title);
  ok(window.__clicks.length === 0, "flipping direction clicked nothing");
  ok(window.__sched16 === 1,
     "the observer schedules exactly ONE recompute for this transition - it does not " +
     "re-trigger itself off its own repaint of the button (sched16=" + window.__sched16 + ")");

  // ...and closes it again.
  document.getElementById("f1").setAttribute("aria-expanded", "false");
  await tick();
  ok(/Expand all files/.test(toggle().title), "closing it flips back to expand");
  ok(window.__clicks.length === 0, "still nothing clicked - the observer is not armed");
}`,
  nostate: String.raw`
async function run() {
  ok(!!toggle(), "the button installs");
  ok(toggle().hasAttribute("disabled"),
     "headers with no aria-expanded are not actionable, so the button is disabled");
  window.__load("f1");
  await tick();
  ok(!toggle().hasAttribute("disabled"),
     "the button re-enables as soon as a header exposes aria-expanded");
  ok(/Expand all files/.test(toggle().title), "and reads as expand-all: " + toggle().title);
}`,
  expand: String.raw`
async function run() {
  toggle().click();
  await tick();
  ok(window.__clicks.join(",") === "f1,f2,f3",
     "only the 3 loaded+collapsed headers were clicked, in DOM order: " + window.__clicks.join(","));
  ok(ariaOf("f1") === "true" && ariaOf("f2") === "true" && ariaOf("f3") === "true",
     "all three are now expanded");
  ok(document.getElementById("f4").hasAttribute("disabled"),
     "the not-loaded header was never touched");
  ok(toggle().getAttribute("data-cdb-dv-armed") === "1", "sticky mode is armed");
  ok(/Collapse all files/.test(toggle().title),
     "the direction is now collapse: " + toggle().title);
  ok(/also stops auto-expanding/.test(toggle().title), "the tooltip says the press also disarms");
}`,
  sticky: String.raw`
async function run() {
  toggle().click();                       // expand + arm
  await tick();
  window.__clicks.length = 0;

  // A patch arrives for a file that was below the viewport.
  window.__load("f4");
  await tick();
  ok(window.__clicks.join(",") === "f4", "a newly loaded file is auto-expanded while armed");
  ok(ariaOf("f4") === "true", "and it really is open");

  // The user closes one by hand. Sticky must NOT undo that.
  window.__clicks.length = 0;
  document.getElementById("f2").click();
  await tick();
  ok(ariaOf("f2") === "false", "the user's collapse stuck");
  ok(window.__clicks.join(",") === "f2",
     "only the user's own click is recorded - sticky did not re-expand it: " + window.__clicks.join(","));

  // A file the user never touched still auto-expands.
  window.__clicks.length = 0;
  window.__load("f5");
  await tick();
  ok(window.__clicks.join(",") === "f5", "an untouched newly loaded file still auto-expands");

  // A brand-new header appended to the list (a remount / a mode's new file list).
  window.__clicks.length = 0;
  var host = document.getElementById("filelist");
  var wrap = document.createElement("div");
  var b = document.createElement("button");
  b.type = "button";
  b.id = "f6";
  b.className = "epitaxy-panel-subheader";
  b.setAttribute("aria-expanded", "false");
  b.addEventListener("click", function () {
    window.__clicks.push("f6");
    b.setAttribute("aria-expanded", b.getAttribute("aria-expanded") === "true" ? "false" : "true");
  });
  wrap.appendChild(b);
  host.appendChild(wrap);
  await tick();
  ok(window.__clicks.join(",") === "f6", "a newly mounted header is auto-expanded");
}`,
  // Sticky can outlive the last open file: 'armed' is only cleared by a collapse
  // press, a scope change or destroy(). Close every file by hand and the button
  // flips to EXPAND while still armed - and the tooltip then tells the user to
  // "click Collapse to stop", a Collapse the button no longer offers. refresh()
  // auto-disarms instead, once, on the transition.
  autodisarm: String.raw`
async function run() {
  toggle().click();                        // expand f1..f3 + arm
  await tick();
  ok(toggle().getAttribute("data-cdb-dv-armed") === "1", "armed");
  ok(/Collapse all files/.test(toggle().title) && /also stops auto-expanding/.test(toggle().title),
     "while something is open the armed tooltip really does offer a Collapse: " + toggle().title);

  // The user closes all three by hand, one at a time.
  window.__clicks.length = 0;
  var ids = ["f1", "f2", "f3"];
  for (var i = 0; i < ids.length; i++) {
    document.getElementById(ids[i]).click();
    await tick();
  }
  ok(window.__clicks.join(",") === "f1,f2,f3",
     "sticky re-expanded none of them: " + window.__clicks.join(","));
  ok(!toggle().hasAttribute("data-cdb-dv-armed"),
     "with nothing left open the button auto-disarms");
  ok(/^Expand all files/.test(toggle().title), "the direction is expand: " + toggle().title);
  ok(!/click Collapse to stop/.test(toggle().title),
     "and the tooltip no longer points at a Collapse that does not exist: " + toggle().title);

  // ONE line for the transition, never one per tick.
  function disarmLines() {
    return window.__diag.filter(function (d) { return /nothing is open any more/.test(d); });
  }
  ok(disarmLines().length === 1, "the transition is logged exactly once: " + disarmLines().length);
  document.getElementById("filelist").appendChild(document.createElement("span"));
  await tick(6);
  ok(disarmLines().length === 1,
     "and later ticks do not repeat it: " + disarmLines().length);

  // Really disarmed: a patch landing now must not be dumped open.
  window.__clicks.length = 0;
  window.__load("f4");
  await tick();
  ok(window.__clicks.length === 0, "a newly loaded file is no longer auto-expanded");
}`,
  // The case the `handled` WeakSet actually exists for, and the one the spec
  // calls the most important invariant to preserve: a header WE never clicked,
  // observed open by refresh() alone, then closed by the user. Deleting
  // refresh()'s `handled.add(st.expanded[i])` loop leaves every other scenario
  // green, because everywhere else the header was marked by our own clickExpand.
  seenopen: String.raw`
async function run() {
  toggle().click();                       // expand what is loaded + arm
  await tick();
  ok(toggle().getAttribute("data-cdb-dv-armed") === "1", "sticky mode is armed");

  // A header that mounts ALREADY OPEN - what upstream's own scroll-target effect
  // does. We never click it, so the only thing that can ever mark it "seen open"
  // is refresh() reading its aria-expanded.
  var wrap = document.createElement("div");
  var b = document.createElement("button");
  b.type = "button";
  b.id = "f7";
  b.className = "epitaxy-panel-subheader";
  b.setAttribute("aria-expanded", "true");
  b.addEventListener("click", function () {
    window.__clicks.push("f7");
    b.setAttribute("aria-expanded", b.getAttribute("aria-expanded") === "true" ? "false" : "true");
  });
  wrap.appendChild(b);
  document.getElementById("filelist").appendChild(wrap);
  window.__clicks.length = 0;
  await tick(5);
  ok(ariaOf("f7") === "true", "it mounted open and nothing touched it");
  ok(window.__clicks.join(",") === "",
     "sticky did not click an already-open header: " + window.__clicks.join(","));

  // The user closes it by hand. It is now expandable, armed sticky is still on,
  // and we never clicked it - only the "seen open" mark keeps it shut.
  b.click();
  await tick(5);
  ok(ariaOf("f7") === "false", "the user's collapse stuck");
  ok(window.__clicks.join(",") === "f7",
     "armed sticky did NOT re-expand a header it never opened itself: " + window.__clicks.join(","));
  ok(toggle().getAttribute("data-cdb-dv-armed") === "1",
     "and sticky is still armed - other files are open, so nothing disarmed it");
}`,
  collapse: String.raw`
async function run() {
  ok(/Collapse all files/.test(toggle().title), "four open files read as collapse-all");
  toggle().click();
  await tick();
  ok(window.__clicks.join(",") === "f4,f3,f2,f1",
     "collapsed BOTTOM-UP so the viewport lands on the top file: " + window.__clicks.join(","));
  ok(ariaOf("f1") === "false" && ariaOf("f4") === "false", "all four are collapsed");
  ok(/Expand all files/.test(toggle().title), "the direction flips back to expand");

  // ARM IT FIRST. This fixture starts with everything open and nothing armed, so
  // the disarm assertion below used to assert the absence of an attribute that
  // was never set - it could not fail. Press once to expand+arm, then collapse.
  window.__clicks.length = 0;
  toggle().click();
  await tick();
  ok(toggle().getAttribute("data-cdb-dv-armed") === "1",
     "pressing expand on the now-collapsed list arms sticky mode");
  var diagBefore = window.__diag.length;
  toggle().click();
  await tick(5);
  ok(!toggle().hasAttribute("data-cdb-dv-armed"), "collapsing disarms sticky mode");
  // ...and it is the PRESS that disarmed, not refresh()'s safety net. Without
  // this the assertion above would still pass with 'armed = false' deleted from
  // the collapse branch, because the safety net (armed + nothing open) would
  // clear the flag one tick later instead.
  ok(window.__diag.slice(diagBefore).filter(function (d) {
       return /nothing is open any more/.test(d);
     }).length === 0,
     "the collapse press disarmed directly - the auto-disarm safety net never fired");

  // Nothing may creep back in: sticky is off, so a freshly loaded file stays shut.
  window.__clicks.length = 0;
  document.getElementById("f1").setAttribute("aria-expanded", "false");
  await tick();
  ok(window.__clicks.length === 0, "with sticky off nothing is auto-expanded");
}`,
  icon: String.raw`
async function run() {
  var t = toggle();
  ok(t.childNodes.length === 1, "exactly one icon node");
  var kid = t.firstChild;
  var isSvg = kid.namespaceURI === "http://www.w3.org/2000/svg";
  var isGlyph = kid.nodeName.toLowerCase() === "span";
  ok(isSvg || isGlyph, "the icon is either our SVG or the icon-font span");
  if (isGlyph) {
    ok(kid.className.indexOf("ico") >= 0, "the glyph span carries upstream's .ico class");
    ok(/Anthropicons/.test(kid.style.fontFamily),
       "and sets the family INLINE too, so a renamed .ico cannot blank it");
    ok(kid.textContent.codePointAt(0) === 0xe02c,
       "expand-all paints CaretUpDown: U+" + kid.textContent.codePointAt(0).toString(16));
  } else {
    ok(kid.querySelectorAll("polyline").length === 2,
       "the fallback draws two carets, so a missing glyph is still VISIBLE");
    skip("the icon-FONT branch was not exercised: no Anthropicons woff2 was supplied " +
         "(tmp/extract*/usr/lib/claude-desktop/resources/ion-dist.asar, assets/v1/*.woff2), or the " +
         "in-page probe rejected it. NOT verified: that U+E02C/U+E028 really draw ink, that " +
         "the glyph span keeps upstream's .ico class, and that the font-family is also set " +
         "INLINE. Extract the official .deb into tmp/extract to exercise it.");
  }
  // Whatever the source, the icon must follow the direction.
  document.getElementById("f1").setAttribute("aria-expanded", "true");
  await tick();
  var k2 = toggle().firstChild;
  if (k2.nodeName.toLowerCase() === "span") {
    ok(k2.textContent.codePointAt(0) === 0xe028,
       "collapse-all paints CaretDownUp: U+" + k2.textContent.codePointAt(0).toString(16));
  } else {
    ok(k2.getAttribute("data-cdb-dir") === "collapse" ||
       k2.querySelector("polyline").getAttribute("points") === "6,4 12,10 18,4",
       "the fallback repaints for the collapse direction");
  }
}`,
  nofont: String.raw`
async function run() {
  await sleep(400);   // give any probe time to resolve and fail
  var kid = toggle().firstChild;
  ok(kid.namespaceURI === "http://www.w3.org/2000/svg",
     "with no icon font available the button keeps the SVG - never an empty box");
  ok(kid.querySelectorAll("polyline").length === 2, "and the SVG really has the carets");
}`,
  lifecycle: String.raw`
async function run() {
  toggle().click();                                   // arm
  await tick();
  ok(toggle().getAttribute("data-cdb-dv-armed") === "1", "armed");

  // Switching diff scope must disarm: the file list is about to be wholly
  // replaced, and a large branch diff must not be dumped open unasked.
  select().value = "branch";
  select().dispatchEvent(new Event("change", { bubbles: true }));
  await tick(6);
  ok(!toggle().hasAttribute("data-cdb-dv-armed"), "a diff-scope change disarms sticky mode");
  window.__clicks.length = 0;
  window.__load("f4");
  await tick();
  ok(window.__clicks.length === 0, "and nothing is auto-expanded afterwards");

  // A DOM mutation storm must not grow a second button.
  for (var i = 0; i < 5; i++) {
    document.getElementById("filelist").appendChild(document.createElement("span"));
    await sleep(60);
  }
  await tick(8);
  ok(document.querySelectorAll(".cdb-dv-toggle").length === 1,
     "still exactly one button after repeated sweeps: " +
     document.querySelectorAll(".cdb-dv-toggle").length);
  ok(document.querySelectorAll(".cdb-dv-select").length === 1, "and exactly one dropdown");
}`,
  // The ORDINARY unmount path. pruneInstalls() in js/diff_views_page.js used to
  // drop the record and nothing else, leaving an armed instance observing a view
  // it no longer has a button on: it went on clicking headers open as their
  // patches landed, with nothing on screen able to stop it and no reinstall
  // coming, because the close control it mounts beside left with the row.
  prune: String.raw`
async function run() {
  toggle().click();                        // arm
  await tick();
  ok(toggle().getAttribute("data-cdb-dv-armed") === "1", "armed");

  var before = window.__disconnects;
  var row = document.getElementById("row");
  row.parentNode.removeChild(row);         // the chrome row unmounts
  ok(!document.querySelector(".cdb-dv-toggle"), "the button left with the row");

  await sleep(900);                        // let the debounced sweep prune
  ok(window.__disconnects >= before + 1,
     "the prune path tore the expand half down (" + before + " -> " + window.__disconnects + ")");

  window.__clicks.length = 0;
  window.__load("f4");
  await tick(6);
  ok(window.__clicks.length === 0,
     "a leaked armed instance would have clicked the new patch open: " + window.__clicks.join(","));
}`,
  // pruneInstalls() used to only clear the expand half (destroy the button,
  // reset the row's __cdbDv/__cdbDvUi flags) and leave the injected <select> in
  // the DOM. That is harmless for a genuine unmount (the row itself is gone
  // with it), but a detach is not always permanent: React can pull a row out of
  // the document and put the SAME node back later (e.g. a list re-render), and
  // in between those two moments document.contains(row) is false, so the sweep
  // prunes it. With the old partial teardown the orphaned <select> was still
  // sitting in the re-attached row, and installOnCloseControl's reinstall
  // branch had no reason to remove it (row.__cdbDv had already been reset to
  // false, so the "already served" branch never even looks at it) - the next
  // sweep just added a second dropdown beside the orphan. teardownRow() removes
  // the <select> too, so a re-attach reinstalls cleanly instead of doubling up.
  reattach: String.raw`
async function run() {
  toggle().click();                        // arm
  await tick();
  ok(toggle().getAttribute("data-cdb-dv-armed") === "1", "armed before detach");

  var row = document.getElementById("row");
  var parent = row.parentNode;
  parent.removeChild(row);                 // the chrome row unmounts
  ok(!document.querySelector(".cdb-dv-toggle"), "the button left with the row");

  await sleep(900);                        // let the debounced sweep prune

  parent.appendChild(row);                 // the SAME node comes back, not a fresh one
  await sleep(900);                        // let the debounced sweep reinstall

  ok(document.querySelectorAll(".cdb-dv-select").length === 1,
     "exactly one dropdown after detach+reattach: " +
     document.querySelectorAll(".cdb-dv-select").length);
  ok(document.querySelectorAll(".cdb-dv-toggle").length === 1,
     "exactly one toggle button after detach+reattach: " +
     document.querySelectorAll(".cdb-dv-toggle").length);
}`,
  // Fullscreen (the ⤢ control) mounts a SECOND chrome row for the SAME view and
  // leaves the side panel's row in the document, merely hidden. Both installs
  // observe the same view and neither knows about the other, so the hidden one's
  // armed expand half has to go - nothing on screen can disarm it.
  fullscreen: String.raw`
async function run() {
  toggle().click();                        // arm the side panel's instance
  await tick();
  ok(toggle().getAttribute("data-cdb-dv-armed") === "1", "the side panel's instance is armed");

  var before = window.__disconnects;
  document.getElementById("row").style.display = "none";
  var row2 = document.createElement("div");
  row2.className = "chromerow";
  row2.id = "row2";
  var c2 = document.createElement("button");
  c2.type = "button";
  c2.id = "close2";
  c2.className = "epitaxy-pane-close-control shrink-0 text-t5";
  c2.setAttribute("aria-label", "Close");
  row2.appendChild(c2);
  document.getElementById("view").appendChild(row2);
  await sleep(900);                        // let the debounced sweep install

  ok(document.querySelectorAll(".cdb-dv-toggle").length === 1,
     "exactly ONE live expand button, not the hidden row's plus the new one: " +
     document.querySelectorAll(".cdb-dv-toggle").length);
  ok(row2.querySelector(".cdb-dv-toggle") !== null &&
     row2.querySelector(".cdb-dv-select") !== null,
     "and it is the VISIBLE row that carries the working UI");
  ok(document.getElementById("row").querySelector(".cdb-dv-select") === null,
     "the hidden row is left as a never-installed row, so re-displaying it cannot " +
     "grow a second dropdown beside an orphan");
  ok(window.__disconnects >= before + 1,
     "the stale instance's observer was disconnected (" + before + " -> " +
     window.__disconnects + ")");

  // The visible instance is fresh and NOT armed. A patch landing now must stay
  // shut: if the hidden row's armed instance were still alive it would open it.
  window.__clicks.length = 0;
  window.__load("f4");
  await tick(6);
  ok(window.__clicks.length === 0,
     "no stale armed instance auto-expanded the new patch: " + window.__clicks.join(","));

  // ROUND TRIP. Tearing the hidden row down WHOLE (rather than only destroying
  // its expand half) is only safe if re-displaying it reinstalls cleanly: an
  // orphaned <select> left behind would get a second one inserted next to it.
  row2.parentNode.removeChild(row2);
  document.getElementById("row").style.display = "";
  await sleep(900);
  ok(document.querySelectorAll(".cdb-dv-toggle").length === 1 &&
     document.querySelectorAll(".cdb-dv-select").length === 1,
     "exiting fullscreen leaves exactly one button and one dropdown: " +
     document.querySelectorAll(".cdb-dv-toggle").length + "/" +
     document.querySelectorAll(".cdb-dv-select").length);
  ok(document.getElementById("row").querySelector(".cdb-dv-toggle") !== null,
     "and they are back in the side panel's own row");
}`,
  // DEFECT B (2026-08-04, measured live): the diff-scope dropdown showed up in
  // the in-app browser/preview panel's toolbar row. With `preview` as the only
  // mounted side tile the probe read
  //   panel tileId=preview  markers: []  wouldQualify: false  ourDropdown: TRUE
  // - present in a panel diff-views' OWN qualification check rejects, so it was
  // never a mis-install. Upstream REUSES the chrome-row DOM when it swaps which
  // tile owns that row, and our <select> is a foreign node React does not
  // manage, so it survives the row's contents being replaced and rides along.
  // Reproduced structurally: the SAME row node stays put while the view around
  // it stops being a diff view.
  //
  // The FIRST HALF is the regression guard for the edge case that motivated the
  // loose marker (see VIEW_MARKERS in js/diff_views_page.js): FIXTURES.mixed IS
  // the large-diff shape - every file COLLAPSED, so ".epitaxy-diff-panel" does
  // not exist anywhere and only ONE of the four markers is present. A
  // re-validation that demanded the expanded per-file content (or any ALL-of
  // gate) would strip the dropdown off a real 12-file diff view, which is
  // exactly the live bug the ANY-OF rule was introduced to fix on 2026-08-01.
  stale: String.raw`
async function run() {
  var row = document.getElementById("row");
  var view = document.getElementById("view");
  ok(!!select(), "installed on the large-diff view (precondition)");
  ok(document.querySelectorAll(".epitaxy-diff-panel").length === 0 &&
     document.querySelectorAll("button.epitaxy-panel-subheader").length === 5,
     "precondition: the all-files-collapsed shape - 5 per-file headers and ZERO " +
     ".epitaxy-diff-panel - so only the LOOSE marker qualifies this view");

  for (var i = 0; i < 3; i++) {
    document.getElementById("filelist").appendChild(document.createElement("span"));
    await sleep(600);                      // one debounced sweep each
  }
  ok(!!select() && row.contains(select()),
     "STILL installed after three re-validating sweeps: a large diff with every " +
     "file collapsed keeps its dropdown");
  ok(document.querySelectorAll(".cdb-dv-select").length === 1,
     "and exactly one - re-validation neither removed nor duplicated it: " +
     document.querySelectorAll(".cdb-dv-select").length);

  // Upstream now reuses this row for another tile: the ROW NODE stays, the view
  // around it becomes an embedded browser surface with no diff marker at all.
  var before = window.__disconnects;
  document.getElementById("filelist").remove();
  var frame = document.createElement("iframe");
  frame.id = "preview";
  view.appendChild(frame);
  ok(row.querySelector(".cdb-dv-select") !== null,
     "precondition: our <select> really did survive the view being replaced - " +
     "that IS the defect, and no sweep has run yet");

  await sleep(900);                        // let the debounced sweep re-validate

  ok(document.querySelectorAll(".cdb-dv-select").length === 0,
     "the stale dropdown is removed on the next sweep: " +
     document.querySelectorAll(".cdb-dv-select").length);
  ok(document.querySelectorAll(".cdb-dv-toggle").length === 0,
     "and so is the expand button - the row is torn down WHOLE, not half");
  ok(!row.__cdbDv && !row.__cdbDvUi,
     "the row is left exactly as a never-installed row, so a later sweep could " +
     "reinstall cleanly instead of doubling up");
  ok(window.__disconnects >= before + 1,
     "the expand half's observer was disconnected too (" + before + " -> " +
     window.__disconnects + ")");
  var staleLines = window.__diag.filter(function (d) { return /stale dropdown/.test(d); });
  ok(staleLines.length === 1 && /removed 1 stale dropdown/.test(staleLines[0]),
     "exactly one [cdb-dv] line names what happened: " + (staleLines.join(" | ") || "(none)"));

  await sleep(900);
  ok(document.querySelectorAll(".cdb-dv-select").length === 0,
     "still gone a sweep later - the install loop does not put one back into a " +
     "view that does not qualify");
}`,
  // THE DROPDOWN LEAK (2026-08-21, measured live on 1.32352.1): with a
  // non-working scope applied, the diff-scope dropdown mounted in the in-app
  // browser panel's chrome row - and in the Files panel the same way. Unlike
  // DEFECT B this is a genuine MIS-INSTALL, not a stale leftover: an empty "New
  // tab" has no iframe yet, so qualifiesAsEmptyDiffView's negative surface check
  // passes and the mode gate is open because the user really did apply Branch
  // changes (in the diff panel). The fix is a POSITIVE identity gate: the fiber's
  // memoizedProps.tileId must say "diff" before the empty-diff fallback fires.
  // A null tileId (unreadable fiber) falls back to the old gates so the
  // dead-end rescue survives a React internals change.
  leak: String.raw`
async function run() {
  var view = document.getElementById("view");
  // The fiber, shaped as measured live: tileId sits on an ANCESTOR fiber node,
  // not on the element's own memoizedProps.
  var FIBER = "__reactFiber$leaktest";
  view[FIBER] = { memoizedProps: {}, return: { memoizedProps: { tileId: "preview" }, return: null } };

  ok(document.querySelectorAll(".cdb-dv-select").length === 0,
     "precondition: a marker-less browser panel gets nothing in Working tree");

  // The user applies Branch changes (in the real diff panel elsewhere): main's
  // effective mode goes non-working, which is GATE 1 of the empty-diff fallback.
  window.__stubMode = "branch";
  await sleep(150);                        // several 10ms pref polls + the mode-change sweep
  view.appendChild(document.createElement("span"));
  await sleep(900);                        // one debounced sweep
  ok(document.querySelectorAll(".cdb-dv-select").length === 0,
     "LEAK GUARD: an empty in-app browser tab (no iframe, tileId=preview) gets NO " +
     "dropdown even with a non-working scope applied: " +
     document.querySelectorAll(".cdb-dv-select").length);

  // The dead-end rescue must SURVIVE the fix: the same zero-marker shape whose
  // fiber says tileId=diff IS the diff view our own scope emptied, and without a
  // dropdown there is no way back to Working tree.
  view[FIBER].return.memoizedProps.tileId = "diff";
  view.appendChild(document.createElement("span"));
  await sleep(900);
  ok(document.querySelectorAll(".cdb-dv-select").length === 1,
     "the emptied DIFF view (tileId=diff, zero markers) still gets its dropdown: " +
     document.querySelectorAll(".cdb-dv-select").length);

  // Upstream hands this row to the browser tile again: the re-validation sweep
  // must now strip the dropdown off it (this is the exact live state measured
  // 2026-08-21 - ourDropdown:true on tileId=preview).
  view[FIBER].return.memoizedProps.tileId = "preview";
  view.appendChild(document.createElement("span"));
  await sleep(900);
  ok(document.querySelectorAll(".cdb-dv-select").length === 0,
     "re-validation strips the dropdown once the fiber identity stops being diff: " +
     document.querySelectorAll(".cdb-dv-select").length);

  // And with the fiber UNREADABLE the old gates still carry the rescue: an
  // emptied diff whose fiber upstream renamed must not become a dead end.
  delete view[FIBER];
  view.appendChild(document.createElement("span"));
  await sleep(900);
  ok(document.querySelectorAll(".cdb-dv-select").length === 1,
     "null tileId falls back to the legacy gates - the dead-end rescue outlives " +
     "a React internals rename: " + document.querySelectorAll(".cdb-dv-select").length);
}`,
  destroy: String.raw`
async function run() {
  var t = toggle();
  ok(!!t, "installed");
  // The page script owns destroy(); reach it the way the real teardown does.
  var row = document.getElementById("row");
  ok(!!row.__cdbDvUi && !!row.__cdbDvUi.expand, "the install record carries the expand half");
  var before = window.__disconnects;
  row.__cdbDvUi.expand.destroy();
  await tick();
  ok(!document.querySelector(".cdb-dv-toggle"), "destroy() removes the button from the row");
  // The call count, not the DOM: refresh()'s own 'destroyed' guard already
  // blocks the repaint, so "a later mutation clicks nothing" stays true even
  // with obs.disconnect() deleted. Only the spy can see the leak.
  ok(window.__disconnects === before + 1,
     "destroy() really calls MutationObserver.disconnect() (" + before + " -> " +
     window.__disconnects + ")");
  window.__clicks.length = 0;
  window.__load("f4");
  await tick();
  ok(window.__clicks.length === 0, "and nothing is clicked afterwards");

  // Idempotent: the page script can reach destroy() from the prune path, the
  // feature switch and the reinstall branch, and those can overlap.
  row.__cdbDvUi.expand.destroy();
  ok(!document.querySelector(".cdb-dv-toggle"), "a second destroy() is harmless");
}`
};

// The real icon font, if this checkout has an extract. Without it the suite can
// only prove the fallback - which is the important half: a missing glyph must
// leave a VISIBLE icon, because this font draws nothing at all for an unmapped
// codepoint. The SPA is resources/ion-dist.asar since v4.29.0 (a plain
// resources/ion-dist/ dir before), so the font is read through openIonDist()
// and handed to the page as a data: URL; FONT is that URL, or null.
const FONT = (() => {
  try {
    const trees = globSync("tmp/extract*/usr/lib/claude-desktop", { cwd: ROOT }).sort();
    for (const rel of trees) {
      const ion = openIonDist(join(ROOT, rel));
      if (!ion) continue;
      for (const name of ion.list("assets/v1").filter((f) => f.endsWith(".woff2")).sort()) {
        const bytes = ion.read("assets/v1/" + name);
        // Anthropicons is the one with the .ico rule; pick by size band and let
        // the in-page probe decide - a wrong guess simply fails the upgrade.
        if (bytes.length > 20000) return "data:font/woff2;base64," + bytes.toString("base64");
      }
    }
  } catch {}
  return null;
})();

// --- page template ---------------------------------------------------------

function html(fixture, run, font) {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  .chromerow { display: flex; align-items: center; gap: 4px; }
  .filelist { display: block; }
  .epitaxy-panel-subheader { display: block; width: 100%; }
</style>
${font ? `<style>@font-face{font-family:Anthropicons-Variable;src:url(${font})format("woff2-variations");font-weight:400 700;font-display:block}
.ico{font-family:Anthropicons-Variable;font-size:16px;font-weight:400;line-height:1}</style>` : ""}
</head><body>
${fixture}
<pre id="cdb-results">pending</pre>
<script>
// Upstream's per-file toggle is LOCAL React state. The fixture reproduces the
// observable half: clicking flips this header's own aria-expanded. Disabled
// headers get no listener at all - browsers do not dispatch click on them,
// which is exactly the constraint the module has to respect.
window.__clicks = [];
function attach(b) {
  b.addEventListener("click", function () {
    window.__clicks.push(b.id);
    b.setAttribute("aria-expanded", b.getAttribute("aria-expanded") === "true" ? "false" : "true");
  });
}
Array.prototype.forEach.call(document.querySelectorAll("button.epitaxy-panel-subheader"), function (b) {
  if (!b.hasAttribute("disabled")) attach(b);
});
// Simulate a patch arriving for a file: aria-expanded appears as "false" and the
// button becomes clickable. This is what scrolling does in the real app.
window.__load = function (id) {
  var b = document.getElementById(id);
  b.removeAttribute("disabled");
  b.setAttribute("aria-expanded", "false");
  attach(b);
};
window.__diag = [];
window.__cdbDvTestPollMs = 10;   // TEST-ONLY override documented in diff_views_page.js
window.cdbDiffViews = {
  state: function () {
    // __stubMode lets a scenario apply a non-working scope the way the real main
    // process would report one (the "leak" scenario needs Branch changes active
    // to open the qualifiesAsEmptyDiffView gate). Default unchanged: working.
    return Promise.resolve({ ok: true, available: true, isGitRepo: true,
                             enabled: true, mode: window.__stubMode || "working",
                             hasTurnSnapshot: false });
  },
  setMode: function () { return Promise.resolve({ ok: true, nudged: true }); }
};
var __warn = console.warn.bind(console);
console.warn = function (m) { window.__diag.push(String(m)); __warn(m); };
// TEST-ONLY spy, installed BEFORE the module evals below: counts how many
// times the module schedules its 16ms coalesced recompute. A transparent
// passthrough (every call still reaches the real setTimeout unchanged), so it
// cannot alter the module's timing - it only tallies calls. Used by the
// "reactive" scenario to pin that the observer does not re-trigger itself off
// its own repaint of the button (see js/diff_views_expand.js's "OUR OWN BUTTON
// IS INSIDE THIS SUBTREE" comment): the DOM end state is identical whichever
// way that goes (paintIcon/setDisabled are idempotent), so only a call count
// like this - not a DOM assertion - can tell the two apart.
window.__sched16 = 0;
var __origSetTimeout = window.setTimeout.bind(window);
window.setTimeout = function (fn, delay) {
  if (delay === 16) window.__sched16++;
  return __origSetTimeout(fn, delay);
};
// TEST-ONLY spy, same transparent-passthrough style: tallies every
// MutationObserver.disconnect() call and still performs the real one. The
// "destroy" scenario needs it because refresh() has its OWN destroyed guard,
// so the DOM after destroy() is identical whether or not the observer was
// actually disconnected - only a call count can tell a real teardown from a
// leaked-but-inert observer. No hook of any kind exists in the production code.
window.__disconnects = 0;
var __origDisconnect = MutationObserver.prototype.disconnect;
MutationObserver.prototype.disconnect = function () {
  window.__disconnects++;
  return __origDisconnect.apply(this, arguments);
};
</script>
<script>
// Exactly how the main process delivers it: ONE evaluated string, the expand
// module first. Same concatenation as patches/community/add_feature_diff_views.nim.
eval(${JSON.stringify(EXPAND_JS + "\n;\n" + PAGE_JS)});
</script>
<script>
${DRIVER}
${run}
(async function () {
  await sleep(300);
  try { await run(); } catch (e) { results.push("FAIL driver threw: " + (e && e.stack || e)); }
  document.getElementById("cdb-results").textContent = "CDB-BEGIN\\n" + results.join("\\n") + "\\nCDB-END";
  document.title = "done";
})();
</script>
</body></html>`;
}

// --- main-process sender guard (node only, no chromium needed) --------------
// js/diff_views_main.js backs the Extra -> Diff views row through its own IPC
// channels. The guard is exact-origin. 3P mode serves the SPA from
// app://localhost, whose parsed origin is the opaque "null", so it has to be
// normalised before the compare - and nothing near it may slip through. The
// module runs in a vm with electron shimmed; URL is passed in because it is a
// global in Electron's main process.
let mainPass = 0;
let mainFail = 0;
{
  const okm = (c, n) => { if (c) { mainPass++; console.log("  ok   " + n); }
    else { mainFail++; console.error("  FAIL " + n); } };
  const mdir = mkdtempSync(join(tmpdir(), "cdb-dv-main-"));
  const handlers = {};
  const appListeners = {};
  const electron = {
    app: { getPath: () => mdir, on: (ev, fn) => { (appListeners[ev] = appListeners[ev] || []).push(fn); },
      whenReady: () => new Promise(() => {}) },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, removeHandler: () => {} }
  };
  const sb = { require: (m) => (m === "electron" ? electron : Module.createRequire(import.meta.url)(m)),
    process: { platform: "linux", env: {} }, console, URL,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} };
  sb.globalThis = sb;
  { const __c = vm.createContext(sb);
    vm.runInContext(readFileSync(new URL("../../../js/sender_guard.js", import.meta.url), "utf8"), __c);
    vm.runInContext(readFileSync(join(ROOT, "js/diff_views_main.js"), "utf8"), __c); }
  const from = (u, parent = null) => ({ sender: { getURL: () => u, isDestroyed: () => false }, senderFrame: { parent } });
  for (const ch of ["cdb-diff:pref-read", "cdb-diff:state"]) {
    for (const u of ["https://claude.ai/x", "https://preview.claude.ai/x", "https://claude.com/",
                     "https://preview.claude.com/x", "app://localhost/", "app://localhost/new?x=1"]) {
      okm((await handlers[ch](from(u))).ok === true, "main: " + ch + " sender " + u + " accepted");
    }
    for (const u of ["https://evil.example/", "app://localhost.evil/", "app://localhost:1234/", "app://other/",
                     "file:///home/u/x.html", "http://localhost:3000/", "http://claude.ai/", "not a url"]) {
      const r = await handlers[ch](from(u));
      okm(r.ok === false && /unrecognized sender/.test(r.error || ""), "main: " + ch + " sender " + u + " rejected");
    }
    okm((await handlers[ch](from("app://localhost/", {}))).ok === false,
        "main: " + ch + " rejects an app://localhost subframe");
  }
  // The page injection uses the same origin test.
  const injected = [];
  for (const u of ["app://localhost/new", "app://localhost.evil/", "app://other/", "https://claude.ai/new",
                   "app://localhost/setup-desktop-3p", "app://localhost/setup-desktop-3p?x=1"]) {
    const wc = { getURL: () => u, on: (ev, fn) => { if (ev === "dom-ready") fn(); }, ipc: { handle: () => {} },
      executeJavaScript: () => { injected.push(u); return Promise.resolve(); } };
    for (const fn of appListeners["web-contents-created"] || []) { try { fn({}, wc); } catch {} }
  }
  okm(JSON.stringify(injected) === JSON.stringify(["app://localhost/new", "https://claude.ai/new"]),
      "main: page injected into app://localhost and claude.ai only, not the 3P setup wizard (got " + JSON.stringify(injected) + ")");
  rmSync(mdir, { recursive: true, force: true });
  console.log("[main] " + mainPass + "/" + (mainPass + mainFail) + " sender-guard assertions passed");
}

// --- runner ----------------------------------------------------------------

if (!CHROMIUM) {
  console.error("no chromium/chrome binary found - pass --chromium PATH");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "cdb-dv-expand-dom-"));
const scenarios = [
  ["placement", FIXTURES.mixed, RUNS.placement, null],
  ["empty", FIXTURES.empty, RUNS.empty, null],
  ["reactive", FIXTURES.mixed, RUNS.reactive, null],
  ["nostate", FIXTURES.nostate, RUNS.nostate, null],
  ["expand", FIXTURES.mixed, RUNS.expand, null],
  ["collapse", FIXTURES.open, RUNS.collapse, null],
  ["seenopen", FIXTURES.mixed, RUNS.seenopen, null],
  ["autodisarm", FIXTURES.mixed, RUNS.autodisarm, null],
  ["sticky", FIXTURES.mixed, RUNS.sticky, null],
  ["icon", FIXTURES.mixed, RUNS.icon, FONT],
  ["nofont", FIXTURES.mixed, RUNS.nofont, null],
  ["lifecycle", FIXTURES.mixed, RUNS.lifecycle, null],
  ["prune", FIXTURES.mixed, RUNS.prune, null],
  ["reattach", FIXTURES.mixed, RUNS.reattach, null],
  ["fullscreen", FIXTURES.mixed, RUNS.fullscreen, null],
  ["destroy", FIXTURES.mixed, RUNS.destroy, null],
  ["stale", FIXTURES.mixed, RUNS.stale, null],
  ["leak", FIXTURES.browser, RUNS.leak, null]
];

let pass = mainPass;
let fail = mainFail;
const skipped = [];
if (!FONT) {
  console.log("note: no Anthropicons woff2 found under " +
    "tmp/extract*/usr/lib/claude-desktop/resources/ion-dist.asar (assets/v1/) - " +
    "the icon scenario will report its font branch as SKIPPED");
}
for (const [name, fx, run, font] of scenarios) {
  const file = join(dir, name + ".html");
  writeFileSync(file, html(fx, run, font), "utf8");
  let dump = "";
  try {
    dump = execFileSync(CHROMIUM, [
      "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
      "--allow-file-access-from-files",
      "--window-size=1000,700", "--virtual-time-budget=8000",
      "--dump-dom", "file://" + file
    ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    console.error(`[${name}] chromium failed: ${e.message}`);
    fail++;
    continue;
  }
  // Anchor on the #cdb-results element itself, never the whole dump: a page
  // whose inline script throws (a syntax error, a thrown exception before
  // run() reports) still leaves its unexecuted <script> SOURCE TEXT sitting in
  // the serialized DOM, and that source text can itself contain the literal
  // strings "CDB-BEGIN"/"CDB-END" - a bare regex over `dump` would match that
  // dead source and fabricate PASS/FAIL lines for a page that never ran a
  // single assertion. The <pre> is the only place real results ever land.
  const pre = dump.match(/<pre id="cdb-results">([\s\S]*?)<\/pre>/);
  const m = pre && pre[1].match(/CDB-BEGIN\n([\s\S]*?)\nCDB-END/);
  if (!m) {
    console.error(`[${name}] the page never reported results - the module or the driver threw`);
    fail++;
    continue;
  }
  const lines = m[1].split("\n").filter(Boolean)
    .map(unescapeHtml);
  let n = 0;
  let s = 0;
  for (const line of lines) {
    if (line.startsWith("PASS")) { pass++; n++; continue; }
    if (line.startsWith("SKIP")) {
      s++;
      skipped.push(`[${name}] ${line.slice(5)}`);
      continue;
    }
    fail++;
    console.error(`[${name}] ${line}`);
  }
  console.log(`[${name}] ${n}/${lines.length - s} assertions passed` +
              (s ? ` (+${s} SKIPPED)` : ""));
}

if (KEEP) console.log(`fixtures kept in ${dir}`);
else rmSync(dir, { recursive: true, force: true });

// A skipped branch is printed in full and counted in the summary: the point is
// that a suite which quietly shrinks - the icon scenario used to drop from 6 to
// 4 assertions on a checkout with no tmp/extract, which is every CI run - can
// never look identical to one that exercised everything. It is NOT a failure: a
// fresh checkout legitimately has no extract.
for (const s of skipped) console.log(`SKIPPED ${s}`);
console.log(`\n${pass} passed, ${fail} failed, ${skipped.length} skipped`);
process.exit(fail ? 1 : 0);
