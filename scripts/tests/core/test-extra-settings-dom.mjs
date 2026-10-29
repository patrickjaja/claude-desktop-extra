#!/usr/bin/env node
/*
 * test-extra-settings-dom.mjs - headless-Chromium DOM tests for the "Extra"
 * settings area injected into the remote claude.ai Settings modal
 * (js/extra_settings_page.js, delivered by patches/core/add_feature_extra_settings.nim).
 *
 * The page script cannot be unit-tested against the real SPA - the markup is
 * remote and changes without a desktop release. What CAN be pinned is that the
 * script derives everything from the DOM it is given: our group must be a HEADER
 * and a LIST inserted as SIBLINGS where upstream puts its own, our rows must be
 * clones (upstream classes, upstream icon box, upstream label span), the selected
 * look must be borrowed and given back, and an unfamiliar structure must degrade
 * to valid markup instead of breaking.
 *
 * The fixtures below are built FROM baseline/SETTINGS_NAV_CAPTURE.md - a verbatim
 * capture of the real nav taken from a live v1.24012.9 install. Class strings,
 * the icon-font spans with their private-use ligature characters, the alternating
 * header/list siblings with no group wrapper, the aria-current selection and the
 * list-less organization group are all the real thing. Two extra scenarios are
 * deliberately unlike it, to exercise the two fallback renderings.
 *
 * When upstream changes shape, re-capture the nav, update that baseline file, and
 * refit these fixtures against it - the claude-patches.log "nav shape" line
 * written by the installer says which anchor was lost.
 *
 * No npm dependency: each scenario is a generated HTML file run through
 * `chromium --headless --dump-dom`, and the assertions the page ran are read
 * back out of the dumped DOM.
 *
 * Usage: node scripts/tests/core/test-extra-settings-dom.mjs [--keep] [--chromium PATH]
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unescapeHtml } from "../lib/unescape-html.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PAGE_JS = readFileSync(join(ROOT, "js/extra_settings_page.js"), "utf8");
const PAGE_CSS = readFileSync(join(ROOT, "js/extra_settings_page.css"), "utf8");

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
// Everything in this block is verbatim from the capture except the ids, which
// only exist so the driver can address a row.

const ROW_BASE = "flex h-control w-full items-center gap-sm rounded px-sm text-left text-body transition-colors cursor-pointer";
const ROW_OFF = "text-secondary hover:bg-fill-ghost-hover hover:text-primary";
const ROW_ON = "bg-alpha-2 font-medium text-primary";
const HDR_CLS = "px-sm pt-md text-caption text-muted";
const LIST_CLS = "flex flex-col gap-px";
const LABEL_CLS = "min-w-0 flex-1 truncate";
// The icon is an Anthropicons ICON-FONT span: a 1em flex box at font-size 20px
// whose text is a private-use ligature character. NOT an <svg>, NOT an <img>.
const ICON_STYLE = "font-family: var(--font-anthropicons, Anthropicons-Variable); " +
  "font-feature-settings: &quot;liga&quot; 0; font-optical-sizing: auto; line-height: 1; " +
  "width: 1em; height: 1em; display: flex; align-items: center; justify-content: center; " +
  "flex-shrink: 0; user-select: none; font-size: 20px; font-weight: 433.3;";

let pua = 0xe000;
function icon(cls) {
  return `<span data-cds="Icon" class="${cls || "shrink-0 text-secondary"}" aria-hidden="true" ` +
    `style="${ICON_STYLE}">&#x${(pua++).toString(16).toUpperCase()};</span>`;
}

const slug = (s) => s.replace(/\W+/g, "-").toLowerCase();

// `noTestId` reproduces the rows upstream leaves untagged - the whole desktop-only
// group is like that on the live nav, which is why the test ids may locate the nav
// but must never be used to enumerate its rows.
function item(label, opts = {}) {
  const cls = ROW_BASE + " " + (opts.selected ? ROW_ON : ROW_OFF) + (opts.badge ? " opacity-60" : "");
  const cur = opts.selected && opts.attr ? ' aria-current="page"' : "";
  const key = opts.key || slug(label);
  const testid = opts.noTestId ? "" : ` data-testid="${key}-settings"`;
  return `<li${testid}><button type="button" id="row-${key}"${cur} ` +
    `class="${cls}">${icon()}<span class="${LABEL_CLS}">${label}</span></button></li>`;
}

// A group is a header div and a list, as PLAIN SIBLINGS. There is no wrapper
// element around them - that is the fact the injection got wrong.
function group(header, items) {
  return `<div class="${HDR_CLS}">${header}</div>
      <ul class="${LIST_CLS}">${items.join("")}</ul>`;
}

// `nested` is the pane as Anthropic ships it now (captured from a live v2.9939.4
// install): the scrolling body is no longer a direct child of the pane. Between
// them sit a `display: contents` wrapper and a flex column, so a search that only
// looks at the pane's children finds no scroller and hides the WHOLE pane -
// header, close button and solid background included.
function dialog(navInner, nested) {
  const paneInner = nested
    ? `<div class="panehead"><button type="button" id="close-btn">close</button></div>
    <div class="subhead"></div>
    <div class="contents"><div class="wrapcol"><div id="panebody" class="panebody">upstream settings sections</div></div></div>`
    : `<div class="panehead"><button type="button" id="close-btn">close</button></div>
    <div id="panebody" class="panebody">upstream settings sections</div>`;
  return `
<div role="dialog" tabindex="-1" data-cds="Dialog" class="dialog" aria-labelledby="ttl">
  <nav aria-label="Settings" class="navcol">
    <h2 id="ttl" class="sr-only">Settings</h2>
    <div class="shrink-0 px-md pt-md"><input type="search" placeholder="Search settings"></div>
    <div id="navbox" class="navbox">${navInner}</div>
  </nav>
  <div id="pane" class="pane">
    ${paneInner}
  </div>
</div>`;
}

// Scenario 1-3: the real shape. `attr` puts aria-current="page" on the selected
// button as the capture does; without it only the class swap is left, which is
// the harder path. `ambiguous` makes a second row deviate from the shared class
// shape, so no selected row can be identified at all.
const FIXTURE_REAL = (attr, ambiguous, nested) => dialog(`
      ${group("Settings", [
        item("General", { selected: true, attr }),
        item("Account", { badge: ambiguous }),
        item("Usage"),
        item("Capabilities"),
        item("Claude Code", { key: "claude-code" }),
        item("Cowork")
      ])}
      ${group("Desktop app", [
        item("General", { key: "desktop-general" }),
        item("Extensions"),
        item("Developer")
      ])}
      ${group("Customize", [item("Skills")])}
      <div class="${HDR_CLS}">Example Org</div>
      <a id="row-org" href="/admin-settings/organization" class="orglink">${icon()}<span class="${LABEL_CLS}">Organization</span>${icon("text-muted")}</a>`, nested);

// Scenario 4: real rows and real lists, but no group header text we know. There
// is nothing to insert next to, so our rows are appended to the LAST list behind
// a divider - and a divider inside a <ul> has to be an <li>.
const FIXTURE_NO_HEADERS = dialog(`
      <ul class="${LIST_CLS}">${[
        item("General", { selected: true, attr: true }),
        item("Account"),
        item("Usage"),
        item("Cowork")
      ].join("")}</ul>
      <ul class="${LIST_CLS}">${[item("Extensions"), item("Developer")].join("")}</ul>`);

// Scenarios 6-7: the very same shape with the interface in Spanish. The nav is a
// remote SPA and it is translated; nothing but the data-testid attributes and the
// nesting survives a language change, so these two fixtures are what proves the
// injection does not depend on English.
//
// The rows that keep an English word do so for a reason: "General" is spelled the
// same in Spanish, and "Cowork", "Claude Code" and "Plugins" are product names the
// SPA leaves untranslated. That is exactly the handful of accidental matches a
// Spanish session reported, and it is why the label path finds a nav of four rows
// there instead of eleven.
//
// `withTestIds` false is the same nav on a build that carries no test ids: the
// label path is then the only way in, and the anchor has to be found by structure.
const FIXTURE_ES = (withTestIds) => {
  const es = (label, opts = {}) => item(label, Object.assign({ noTestId: !withTestIds }, opts));
  return dialog(`
      ${group("Ajustes", [
        es("General", { selected: true, attr: true }),
        es("Cuenta", { key: "account" }),
        es("Uso", { key: "usage" }),
        es("Capacidades", { key: "capabilities" }),
        es("Claude Code", { key: "claude-code" }),
        es("Cowork", { key: "cowork" })
      ])}
      ${group("Aplicación de escritorio", [
        // Upstream tags no row of its desktop-only group, in any language.
        item("General", { key: "desktop-general", noTestId: true }),
        item("Extensiones", { key: "extensions", noTestId: true }),
        item("Desarrollador", { key: "developer", noTestId: true })
      ])}
      ${group("Personalizar", [
        es("Habilidades", { key: "skills" }),
        es("Plugins", { key: "plugins" })
      ])}
      <div class="${HDR_CLS}">Organización de ejemplo</div>
      <a id="row-org" href="/admin-settings/organization" class="orglink">${icon()}<span class="${LABEL_CLS}">Organización</span>${icon("text-muted")}</a>`);
};

// Scenario 5: exotic - one flat list of bare links, no lists, no group headers
// and no icon of any kind. Every degradation at once: a fabricated <div> header
// in the nav container, a label appended as a text node, a link clone made
// focusable by hand, and no glyph.
const FIXTURE_BARE = dialog(`
      <a class="nvi" href="#">General</a>
      <a class="nvi" href="#">Account</a>
      <a class="nvi" href="#">Privacy</a>
      <a class="nvi" href="#">Notifications</a>`);

// --- the in-page test driver ----------------------------------------------

// Runs after the installer. Everything it checks is observable DOM state, so a
// failure names a real regression a user would see.
const DRIVER = String.raw`
var SVGNS = "http://www.w3.org/2000/svg";
var ICON_SEL = '[data-cds="Icon"]';
var LABELS = ["Themes", "Community", "Models", "Anthropic", "Deployment"];
// Upstream's nav column is narrow and truncates, so the long names are
// shortened there and carried in a tooltip instead. The panels keep the full
// name in their h1 - asserted in featuresPanel()/modelsPanel()/flagsPanel() below.
var TOOLTIPS = { Community: "Community Features", Models: "Custom models", Anthropic: "Anthropic Features" };

function navbox() { return document.getElementById("navbox"); }

function childByText(text) {
  return Array.from(navbox().children).find(function (n) {
    return (n.textContent || "").trim() === text;
  });
}

function ourItems() {
  return Array.from(document.querySelectorAll(".cdbx-item"));
}

function controlOf(item) {
  return item.classList.contains("cdbx-item-btn") ? item : item.querySelector(".cdbx-item-btn");
}

// The alpha of a computed colour, whatever notation it came back in: rgb() and
// rgba(), or the color(srgb r g b / a) that color-mix() serialises to. Counting
// the components is what keeps rgb()'s blue channel from reading as an alpha.
function alphaOf(color) {
  var inside = /\(([^)]*)\)/.exec(color || "");
  if (!inside) return 1;
  var halves = inside[1].split("/");
  if (halves.length > 1) return parseFloat(halves[1]);
  var nums = inside[1].split(/[,\s]+/).filter(function (t) { return /^[\d.]+%?$/.test(t); });
  return nums.length >= 4 ? parseFloat(nums[3]) : 1;
}

function labelSpans(control) {
  return Array.from(control.querySelectorAll("*")).filter(function (n) {
    return n.namespaceURI !== SVGNS && !n.matches(ICON_SEL) && !n.closest(ICON_SEL);
  });
}

// The Themes panel: the 91 real palettes are grouped, so a built-in like mario
// cannot get lost in the middle of the community ones.
function sections() {
  const host = document.querySelector(".cdbx-sections");
  const out = [];
  if (!host) return out;
  Array.from(host.children).forEach(function (n) {
    if (n.classList.contains("cdbx-sec-h")) {
      out.push({
        label: n.querySelector(".cdbx-sec-t").textContent,
        count: n.querySelector(".cdbx-sec-n").textContent,
        cards: []
      });
    } else if (n.classList.contains("cdbx-grid") && out.length) {
      out[out.length - 1].cards = Array.from(n.querySelectorAll(".cdbx-cardname"))
        .map(function (c) { return c.textContent; });
    }
  });
  return out;
}

function labels() {
  return sections().map(function (s) { return s.label + ":" + s.count; }).join(" | ");
}

async function type(value) {
  const box = document.querySelector(".cdbx-panel .cdbx-search");
  box.value = value;
  box.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(30);
}

// Community Features: only our own switches, live except for the two window
// modes, plus the filter bar over them. No STANDING restart notice may appear
// here - Anthropic's flag list has that, in its own panel, asserted below. The
// window modes' bar is conditional and starts hidden, which is asserted as
// such.
async function featuresPanel(featuresItem) {
  featuresItem.click();
  await sleep(120);
  const panel = document.querySelector(".cdbx-panel");
  ok(!!panel, "the Community Features panel is mounted");
  if (!panel) return;
  ok(panel.querySelector(".cdbx-h1").textContent === "Community Features",
     "the heading spells the full name out even though the nav row says Community: " +
     panel.querySelector(".cdbx-h1").textContent);
  // No standing notice: a restart is offered per row, next to the switch that
  // owes it (renderToggleRow's restartOwed slot), never as a bar above the rows
  // that scrolls out of view.
  ok(panel.querySelectorAll(".cdbx-notice").length === 0,
     "no notice in this panel (" + panel.querySelectorAll(".cdbx-notice").length + ")");
  // Every restart row carries the same hidden Restart now; with the fixture's
  // saved settings matching the running app, none of them is up.
  const restartOf = function (row) {
    return Array.prototype.filter.call(row.querySelectorAll(".cdbx-row-aside .cdbx-btn"),
      function (b) { return b.textContent === "Restart now"; })[0] || null;
  };
  const restartUp = function (row) { const b = restartOf(row); return !!b && !b.classList.contains("cdbx-hide"); };
  [
    "open the main window frameless, without window-control buttons or a shadow",
    "use the system window frame instead of this app's integrated titlebar",
    "make the main window transparent",
    "load large Code sessions in full",
    "allow non-Anthropic models from a third-party gateway in the model list"
  ].forEach(function (label) {
    const sw = panel.querySelector('.cdbx-switch[aria-label="' + label + '"]');
    ok(!!sw, "renders the restart row: " + label);
    if (!sw) return;
    const rs = restartOf(sw.closest(".cdbx-row"));
    ok(!!rs && rs.classList.contains("cdbx-hide"), "a hidden Restart now next to the switch: " + label);
  });
  [
    "show the Code tab's side panels as tabs instead of a split layout"
  ].forEach(function (label) {
    const sw = panel.querySelector('.cdbx-switch[aria-label="' + label + '"]');
    ok(!!sw, "renders the live row: " + label);
    if (sw) ok(!restartOf(sw.closest(".cdbx-row")), "a live row has no Restart now: " + label);
  });
  // The config file row, the same footnote the Themes and Anthropic Features
  // panels carry. It arrives from an async paths() read, so give it a tick.
  await sleep(60);
  const cfgRows = panel.querySelectorAll(".cdbx-pathrow");
  ok(cfgRows.length === 1, "the panel links exactly one config file (" + cfgRows.length + ")");
  if (cfgRows.length === 1) {
    const shown = cfgRows[0].querySelector(".cdbx-pathlink").textContent;
    ok(shown.endsWith("claude-desktop-extra.jsonc"),
       "and it is the .jsonc, like the other two panels: " + shown);
    ok(/win over this page/.test(cfgRows[0].textContent),
       "worded as what that file does to these switches: " + cfgRows[0].textContent);
    ok(cfgRows[0] === panel.lastElementChild,
       "and it sits at the very bottom of the panel, as a footnote");
    const seen = window.__revealCalls.length;
    cfgRows[0].querySelector(".cdbx-pathbtn").click();
    await sleep(40);
    ok(window.__revealCalls[seen] === "config-jsonc:folder",
       "its folder button works: " + window.__revealCalls.join(","));
  }
  ok(!Array.from(panel.querySelectorAll(".cdbx-pathlink"))
      .some(function (a) { return a.textContent.endsWith("claude-desktop-extra.json"); }),
     "the internal .json is not linked here either");

  // All four rows go through the same renderToggleRow contract, so the panel
  // tabs one below stands in for the mechanics and the others are checked for
  // the facts that differ: their title, their default, and their note.
  const diff = panel.querySelector('.cdbx-switch[aria-label="show the diff view modes dropdown and the expand/collapse-all button"]');
  ok(!!diff, "the diff view modes switch renders in the Community Features panel");
  if (diff) {
    ok(diff.closest(".cdbx-row").querySelector(".cdbx-id").textContent === "Diff view modes",
       "titled Diff view modes");
    ok(diff.getAttribute("aria-checked") === "false", "off by default - it reshapes a first-party panel");
  }

  const tabsSel = '.cdbx-switch[aria-label="show the Code tab\'s side panels as tabs instead of a split layout"]';
  const tabs = panel.querySelector(tabsSel);
  ok(!!tabs, "the panel tabs switch renders in the Community Features panel");
  if (tabs) {
    const tabsRow = tabs.closest(".cdbx-row");
    ok(tabsRow.querySelector(".cdbx-id").textContent === "Panel tabs", "titled Panel tabs");
    ok(tabs.getAttribute("aria-checked") === "false", "the panel tabs switch reflects enabled:false");
    ok(!tabs.disabled, "the panel tabs switch is enabled when the .jsonc does not lock it");

    tabs.click();
    await sleep(60);
    ok(window.__panelTabsCalls.length === 1 && window.__panelTabsCalls[0] === true,
       "clicking it calls panelTabsSet(true) exactly once: " + JSON.stringify(window.__panelTabsCalls));
    ok(tabs.getAttribute("aria-checked") === "true", "the switch reflects the write");
  }

  const qoSel = '.cdbx-switch[aria-label="open files with Ctrl+P from a quick-open box over the Files panel"]';
  const qo = panel.querySelector(qoSel);
  ok(!!qo, "renders the Files quick open switch");
  if (qo) {
    const qoRow = qo.closest(".cdbx-row");
    ok(qoRow.querySelector(".cdbx-id").textContent === "Files quick open", "titled Files quick open");
    ok(qo.getAttribute("aria-checked") === "false", "off by default (opt-in)");

    qo.click();
    await sleep(60);
    ok(window.__quickOpenCalls.length === 1 && window.__quickOpenCalls[0] === true,
       "clicking it calls quickOpenSet(true) exactly once: " + JSON.stringify(window.__quickOpenCalls));
    ok(qo.getAttribute("aria-checked") === "true", "the switch reflects the write");
  }

  const cmSel = '.cdbx-switch[aria-label="list custom Anthropic-compatible models in the Code model picker"]';
  const cm = panel.querySelector(cmSel);
  ok(!!cm, "renders the Custom models switch");
  if (cm) {
    const cmRow = cm.closest(".cdbx-row");
    ok(cmRow.querySelector(".cdbx-id").textContent === "Custom models", "titled Custom models");
    ok(cm.getAttribute("aria-checked") === "false", "off in the fixture");
    const cmState = cmRow.querySelector(".cdbx-state").textContent;
    ok(cmState === "off - 2 models from 1 provider configured",
       "the state line counts the configured models and providers: " + cmState);

    cm.click();
    await sleep(60);
    ok(window.__customModelsCalls.length === 1 && window.__customModelsCalls[0] === true,
       "clicking it calls customModelsSet(true) exactly once: " + JSON.stringify(window.__customModelsCalls));
    ok(cm.getAttribute("aria-checked") === "true", "the switch reflects the write");
    ok(cmRow.querySelector(".cdbx-state").textContent === "on - 2 models from 1 provider",
       "the state line follows the flip: " + cmRow.querySelector(".cdbx-state").textContent);
  }

  // --- Load large sessions in full: opt-in, NOT live, numbers shown but not edited
  const tlSel = '.cdbx-switch[aria-label="load large Code sessions in full"]';
  const tl = panel.querySelector(tlSel);
  ok(!!tl, "renders the Load large sessions in full switch");
  if (tl) {
    const tlRow = tl.closest(".cdbx-row");
    const tlState = function () { return tlRow.querySelector(".cdbx-state").textContent; };
    const tlNote = tlRow.querySelector(".cdbx-note").textContent;
    ok(tlRow.querySelector(".cdbx-id").textContent === "Load large sessions in full", "titled Load large sessions in full");
    ok(tl.getAttribute("aria-checked") === "false", "off by default (opt-in)");
    ok(!tl.disabled, "enabled when the .jsonc does not lock it");
    ok(tlState() === "off - Anthropic's limits", "the off state says Anthropic's limits apply: " + tlState());
    ok(/browser screenshots/.test(tlNote), "the note names what it is for (long sessions with browser screenshots)");
    ok(/exactly as Anthropic ships them/.test(tlNote), "the note promises off leaves Anthropic's limits as shipped");
    ok(/Takes effect after a restart/.test(tlNote), "the note says it needs a restart");
    ok(/by default/.test(tlNote) && /adjustable in claude-desktop-extra\.jsonc/.test(tlNote),
       "the note says the 256/192 are defaults and can be adjusted in the config file (file only, no GUI field)");
    ok(tlNote.length < 700, "the note stays within the length range of the other rows (" + tlNote.length + " chars)");
    ok(!tlRow.querySelector("input"), "no number field in the row: the numbers stay in the file");

    tl.click();
    await sleep(60);
    ok((window.__tlCalls || []).length === 1 && window.__tlCalls[0] === true,
       "clicking it calls transcriptLimitsSet(true) exactly once: " + JSON.stringify(window.__tlCalls));
    ok(tl.getAttribute("aria-checked") === "true", "the switch reflects the write");
    ok(tlState() === "on - 256 MiB main, 192 MiB subagents after a restart",
       "switching on while the app runs off says a restart is owed: " + tlState());
    ok(restartUp(tlRow), "and the row offers Restart now next to its switch");
    const tlToast = function () { const t = document.querySelector(".cdbx-toast"); return t ? t.textContent : ""; };
    ok(tlToast() === "Large sessions on - restart Claude Desktop to apply",
       "the toast for a change the running app does not have asks for a restart: " + tlToast());
    tl.click();
    await sleep(60);
    ok(tlState() === "off - Anthropic's limits",
       "switching straight back stops claiming a restart is owed: " + tlState());
    ok(!restartUp(tlRow), "and takes its Restart now away again");
    ok(tlToast() === "Large sessions off - no restart needed",
       "...and so does its toast, from the main side's pendingRestart: " + tlToast());
  }

  // --- non-Anthropic gateway models: read at startup, so the same per-row
  // Restart now as every other restart row, shown exactly while the switch and
  // the running app (activeNow) disagree.
  {
    const naSel = '.cdbx-switch[aria-label="allow non-Anthropic models from a third-party gateway in the model list"]';
    const na = panel.querySelector(naSel);
    if (na) {
      const naRow = na.closest(".cdbx-row");
      ok(na.getAttribute("aria-checked") === "false" && !restartUp(naRow), "off, matching the running app, no Restart now");
      na.click();
      await sleep(60);
      ok(na.getAttribute("aria-checked") === "true" && restartUp(naRow),
         "switched on while the app runs off: Restart now next to the switch");
      na.click();
      await sleep(60);
      ok(!restartUp(naRow), "switched straight back: Restart now gone again");
    }
  }

  // --- the two window modes. Three mutually exclusive outcomes behind two
  // switches (native titlebar > no window controls > integrated), so the pair
  // is checked together: the override has to be visible in the overridden row,
  // and each row's Restart now has to follow its disagreement rather than latch.
  const wcSel = '.cdbx-switch[aria-label="open the main window frameless, without window-control buttons or a shadow"]';
  const ntSel = '.cdbx-switch[aria-label="use the system window frame instead of this app\'s integrated titlebar"]';
  const wc = panel.querySelector(wcSel);
  const nt = panel.querySelector(ntSel);
  ok(!!wc, "renders the Hide window controls switch");
  ok(!!nt, "renders the Native titlebar switch");
  if (wc && nt) {
    const wcRow = wc.closest(".cdbx-row");
    const ntRow = nt.closest(".cdbx-row");
    const wcState = function () { return wcRow.querySelector(".cdbx-state").textContent; };
    ok(wcRow.querySelector(".cdbx-id").textContent === "Hide window controls", "titled Hide window controls");
    ok(ntRow.querySelector(".cdbx-id").textContent === "Native titlebar", "titled Native titlebar");
    ok(wc.getAttribute("aria-checked") === "false" && nt.getAttribute("aria-checked") === "false",
       "both off by default (opt-in)");
    ok(!wc.disabled && !nt.disabled, "both switches live when nothing locks or overrides them");
    ok(wcState() === "off - window buttons, integrated titlebar",
       "the controls row's plain wording while native is off: " + wcState());
    ok(ntRow.querySelector(".cdbx-state").textContent === "off - the titlebar is this app's own",
       "the native row's off wording holds for both other modes: " +
       ntRow.querySelector(".cdbx-state").textContent);

    // Flipping native on: the other row must SAY it is overridden, refuse the
    // click, and the native row must offer Restart now.
    nt.click();
    await sleep(80);
    ok((window.__ntCalls || []).length === 1 && window.__ntCalls[0] === true,
       "clicking it calls nativeTitlebarSet(true) exactly once: " + JSON.stringify(window.__ntCalls));
    ok(wcState() === "off - overridden by the native titlebar",
       "the overridden row says so, in its own state line: " + wcState());
    ok(wc.disabled === true, "and its switch is disabled while it cannot take effect");
    ok(wc.title === "The native titlebar is on, and it wins over this",
       "with a title that explains why: " + wc.title);
    const wcBefore = (window.__wcCalls || []).length;
    wc.click();
    await sleep(60);
    ok((window.__wcCalls || []).length === wcBefore, "a click on the disabled switch writes nothing");
    ok(restartUp(ntRow), "the native row offers Restart now: enabled true, active false");
    ok(!restartUp(wcRow), "the controls row does not - it owes nothing");

    // ... and flipping it straight back must take it away again, not leave
    // a restart owed for a change that is no longer pending.
    nt.click();
    await sleep(80);
    ok(!restartUp(ntRow), "flipping it back takes Restart now away - nothing is owed any more");
    ok(wc.disabled === false, "and the other switch is live again");
    ok(wcState() === "off - window buttons, integrated titlebar", "with its plain wording back: " + wcState());

    // The same, driven from the other row.
    wc.click();
    await sleep(80);
    ok((window.__wcCalls || []).length === wcBefore + 1 && window.__wcCalls[wcBefore] === true,
       "the controls switch writes once it is live again: " + JSON.stringify(window.__wcCalls));
    ok(wcState() === "on - no window buttons, no frame", "its on wording: " + wcState());
    ok(restartUp(wcRow), "and it offers its own Restart now");
    nt.click();
    await sleep(80);
    ok(wcState() === "on, but the native titlebar overrides it",
       "on plus native on is spelled out, not left to the reader: " + wcState());
    nt.click();
    await sleep(80);
    wc.click();
    await sleep(80);
    ok(!restartUp(wcRow) && !restartUp(ntRow), "and back to both agreeing, no Restart now on either");
  }

  // A saved window mode the running window does not have: Restart now must be up
  // from the first paint, and the override must survive the lock suffix.
  {
    window.__ntState = { ok: true, enabled: true, active: false, lockedByJsonc: false, source: "json", envForced: false };
    window.__wcState = { ok: true, enabled: false, active: false, lockedByJsonc: true, source: "jsonc", envForced: false };
    featuresItem.click();
    await sleep(200);
    const p2 = document.querySelector(".cdbx-panel");
    const wc2 = p2.querySelector(wcSel);
    const nt2 = p2.querySelector(ntSel);
    ok(!!wc2 && !!nt2, "both window rows render again on a re-entry");
    if (wc2 && nt2) {
      ok(nt2.getAttribute("aria-checked") === "true", "the native switch reflects enabled:true from disk");
      const line = wc2.closest(".cdbx-row").querySelector(".cdbx-state").textContent;
      ok(line === "off - overridden by the native titlebar - set in claude-desktop-extra.jsonc",
         "the override wording and the .jsonc lock suffix survive together: " + line);
      ok(wc2.disabled === true, "and the overridden, locked switch is disabled");
      const ntRow2 = nt2.closest(".cdbx-row");
      ok(restartUp(ntRow2),
         "the native row offers Restart now on load, because the saved mode is not the running one");
      const seen = window.__relaunchCalls;
      restartOf(ntRow2).click();
      await sleep(60);
      ok(window.__relaunchCalls === seen + 1, "its Restart now button relaunches the app");
      // The flags panel below counts the same global and expects its own click
      // to be the first one, so hand the counter back as it was found.
      window.__relaunchCalls = seen;
    }
    window.__ntState = null;
    window.__wcState = null;
  }

  // A launcher flag or env var forcing a mode on for this run. The switch must
  // keep showing what is SAVED and stay usable, the line must say both, and no
  // restart may be offered: the flag decides the next start the same way, so a
  // restart cannot close the gap and the button would be promising a lie.
  {
    window.__wcState = { ok: true, enabled: false, active: true, lockedByJsonc: false, source: "default", envForced: true };
    window.__ntState = { ok: true, enabled: false, active: false, lockedByJsonc: false, source: "default", envForced: false };
    featuresItem.click();
    await sleep(200);
    const p3 = document.querySelector(".cdbx-panel");
    const wc3 = p3.querySelector(wcSel);
    if (wc3) {
      const line = wc3.closest(".cdbx-row").querySelector(".cdbx-state").textContent;
      ok(line === "on for this run by a launcher flag - saved: off",
         "the forced row names the flag AND what is saved: " + line);
      ok(wc3.getAttribute("aria-checked") === "false",
         "the switch still shows the saved value, not the forced one");
      ok(!wc3.disabled, "and stays usable - the saved value is still the user's to change");
      ok(!restartUp(wc3.closest(".cdbx-row")),
         "no Restart now for a difference a restart cannot resolve");
    }
    // The same row with the flag on top of a saved on, so the wording is not
    // secretly keyed to the saved value being off.
    window.__wcState = { ok: true, enabled: true, active: true, lockedByJsonc: false, source: "json", envForced: true };
    featuresItem.click();
    await sleep(200);
    const wc3b = document.querySelector(".cdbx-panel").querySelector(wcSel);
    if (wc3b) {
      const line = wc3b.closest(".cdbx-row").querySelector(".cdbx-state").textContent;
      ok(line === "on for this run by a launcher flag - saved: on", "saved on, forced on: " + line);
    }

    // A flag forcing the NATIVE titlebar overrides the other row just as
    // thoroughly as a saved native does, so the other row must say so - but its
    // switch stays usable, because a flag is not something the user can undo
    // from this page and the saved value is still worth setting for a launch
    // without it.
    window.__ntState = { ok: true, enabled: false, active: true, lockedByJsonc: false, source: "default", envForced: true };
    window.__wcState = { ok: true, enabled: true, active: true, lockedByJsonc: false, source: "json", envForced: false };
    featuresItem.click();
    await sleep(200);
    const p3c = document.querySelector(".cdbx-panel");
    const wc3c = p3c.querySelector(wcSel);
    const nt3c = p3c.querySelector(ntSel);
    if (wc3c && nt3c) {
      const wcLine = wc3c.closest(".cdbx-row").querySelector(".cdbx-state").textContent;
      ok(wcLine === "on, but the native titlebar overrides it",
         "a forced native titlebar still overrides the other row: " + wcLine);
      ok(!wc3c.disabled, "and that row stays usable, since no switch here can undo a flag");
      const ntLine = nt3c.closest(".cdbx-row").querySelector(".cdbx-state").textContent;
      ok(ntLine === "on for this run by a launcher flag - saved: off",
         "while the native row names the flag and what is saved: " + ntLine);
      ok(nt3c.getAttribute("aria-checked") === "false", "its switch shows the saved off");
      ok(!restartUp(wc3c.closest(".cdbx-row")) && !restartUp(nt3c.closest(".cdbx-row")),
         "and no Restart now: the forced row cannot be resolved by a restart and the other row agrees");
    }
    window.__wcState = null;
    window.__ntState = null;
  }

  // active not a boolean: no window had been built when the value was read, so
  // there is nothing to compare and no Restart now to offer, however the saved settings
  // read.
  {
    window.__wcState = { ok: true, enabled: true, active: null, lockedByJsonc: false, source: "json", envForced: false };
    window.__ntState = { ok: true, enabled: true, active: null, lockedByJsonc: false, source: "json", envForced: false };
    featuresItem.click();
    await sleep(200);
    const p4 = document.querySelector(".cdbx-panel");
    ok(!!p4.querySelector(wcSel) && !!p4.querySelector(ntSel), "both rows still render with active unknown");
    if (p4.querySelector(wcSel) && p4.querySelector(ntSel)) {
      ok(!restartUp(p4.querySelector(wcSel).closest(".cdbx-row")) &&
         !restartUp(p4.querySelector(ntSel).closest(".cdbx-row")),
         "and no Restart now: an unknown running value is not a disagreement");
    }
    window.__wcState = null;
    window.__ntState = null;
  }

  // --- Transparent window: the switch owes a restart and gets its own Restart
  // now while it does; the transparency slider previews on input and saves on
  // change, applies live only on a window built transparent, and refuses while
  // the .jsonc or an env variable decides the value, naming the one that does
  // (the legacy windowOpacity / CLAUDE_WINDOW_OPACITY included).
  {
    const wtSel = ".cdbx-switch[aria-label='make the main window transparent']";
    featuresItem.click();
    await sleep(200);
    const p5 = document.querySelector(".cdbx-panel");
    const wt = p5.querySelector(wtSel);
    ok(!!wt, "renders the Transparent window switch");
    if (wt) {
      const wtRow = wt.closest(".cdbx-row");
      const range = wtRow.querySelector("input[type=range]");
      const val = function () { return wtRow.querySelector(".cdbx-range-val").textContent; };
      const hint = function () { return wtRow.querySelector(".cdbx-range-hint").textContent; };
      const rs = Array.from(wtRow.querySelectorAll(".cdbx-row-aside .cdbx-btn"))
        .filter(function (b) { return b.textContent === "Restart now"; })[0];
      ok(!!range && range.min === "0" && range.max === "90" && range.step === "5",
         "the row carries a 0-90 % transparency slider in steps of 5");
      ok(wtRow.querySelector(".cdbx-range-label").textContent === "Transparency", "labelled Transparency");
      ok(range && range.value === "20" && val() === "20%", "showing the saved 20 %: " + val());
      ok(range && !range.disabled, "usable while nothing locks the value");
      ok(hint() === "Saved now - applies once the transparent window is active",
         "on an opaque window the slider says it saves for later: " + hint());
      ok(!!rs && rs.classList.contains("cdbx-hide"), "a hidden Restart now sits next to the switch");

      wt.click();
      await sleep(80);
      ok(window.__wtCalls && window.__wtCalls[0] === true, "the switch writes true");
      ok(rs && !rs.classList.contains("cdbx-hide"), "after the flip the row offers Restart now");
      ok(wtRow.querySelector(".cdbx-state").textContent === "on - see-through main window (restart to apply)",
         "and its state line says a restart is owed: " + wtRow.querySelector(".cdbx-state").textContent);
      const seen = window.__relaunchCalls;
      rs.click();
      await sleep(60);
      ok(window.__relaunchCalls === seen + 1, "the row's Restart now relaunches the app");
      window.__relaunchCalls = seen;
      wt.click();
      await sleep(80);
      ok(rs.classList.contains("cdbx-hide"), "flipping back takes Restart now away again");

      range.value = "50";
      range.dispatchEvent(new Event("input"));
      await sleep(40);
      ok(val() === "50%", "dragging updates the label: " + val());
      ok(!(window.__wtlPreview || []).length, "no preview while the window is not transparent");
      range.dispatchEvent(new Event("change"));
      await sleep(60);
      ok(window.__wtlSet && window.__wtlSet.length === 1 && window.__wtlSet[0] === 0.5,
         "releasing saves 0.5: " + JSON.stringify(window.__wtlSet));
    }

    // Built transparent: input previews live, change saves.
    window.__wtState = { ok: true, enabled: true, active: true, level: 0.6, levelSource: "json",
      levelSetBy: "windowTransparencyLevel", levelLocked: false, levelEnvForced: false, lockedByJsonc: false,
      source: "json", envForced: false, nativeTitlebar: false };
    window.__wtlPreview = [];
    window.__wtlSet = [];
    featuresItem.click();
    await sleep(200);
    const wtRow2 = document.querySelector(".cdbx-panel").querySelector(wtSel).closest(".cdbx-row");
    const range2 = wtRow2.querySelector("input[type=range]");
    ok(range2.value === "60" && wtRow2.querySelector(".cdbx-range-hint").textContent === "Applies live",
       "a transparent window shows its saved 60 % and says the slider applies live");
    ok(wtRow2.querySelector(".cdbx-row-aside .cdbx-btn").classList.contains("cdbx-hide"),
       "no Restart now while the saved switch matches the window");
    range2.value = "40";
    range2.dispatchEvent(new Event("input"));
    await sleep(40);
    ok(window.__wtlPreview.length >= 1 && window.__wtlPreview[window.__wtlPreview.length - 1] === 0.4,
       "input previews the new level live: " + JSON.stringify(window.__wtlPreview));
    ok(window.__wtlSet.length === 0, "and a preview saves nothing");
    range2.dispatchEvent(new Event("change"));
    await sleep(60);
    ok(window.__wtlSet.length === 1 && window.__wtlSet[0] === 0.4, "change saves it: " + JSON.stringify(window.__wtlSet));

    // Locked by the .jsonc, then forced by the env var: disabled, with the why.
    const lockedRow = async function (patch) {
      window.__wtState = Object.assign({}, window.__wtState, patch);
      featuresItem.click();
      await sleep(200);
      const r = document.querySelector(".cdbx-panel").querySelector(wtSel).closest(".cdbx-row");
      return { disabled: r.querySelector("input[type=range]").disabled, hint: r.querySelector(".cdbx-range-hint").textContent };
    };
    let lk = await lockedRow({ levelSource: "jsonc-locked", levelSetBy: "windowTransparencyLevel", levelLocked: true });
    ok(lk.disabled && lk.hint === "Set by windowTransparencyLevel in claude-desktop-extra.jsonc - edit that file to change this",
       "a .jsonc windowTransparencyLevel disables the slider and says where it is set: " + lk.hint);
    lk = await lockedRow({ levelSource: "jsonc-locked", levelSetBy: "windowOpacity", levelLocked: true });
    ok(lk.disabled && lk.hint === "Set by windowOpacity in claude-desktop-extra.jsonc - edit that file to change this",
       "a legacy .jsonc windowOpacity locks it too, named as such: " + lk.hint);
    lk = await lockedRow({ levelSource: "env", levelSetBy: "CLAUDE_WINDOW_TRANSPARENCY_LEVEL", levelLocked: false, levelEnvForced: true });
    ok(lk.disabled && lk.hint === "Set by CLAUDE_WINDOW_TRANSPARENCY_LEVEL - unset it to change this here",
       "CLAUDE_WINDOW_TRANSPARENCY_LEVEL disables it, naming the variable: " + lk.hint);
    lk = await lockedRow({ levelSource: "env", levelSetBy: "CLAUDE_WINDOW_OPACITY", levelLocked: false, levelEnvForced: true });
    ok(lk.disabled && /^Set by CLAUDE_WINDOW_OPACITY /.test(lk.hint),
       "the legacy CLAUDE_WINDOW_OPACITY is named when it decides: " + lk.hint);

    // A switch forced by CLAUDE_WINDOW_TRANSPARENCY: no restart can close the gap.
    window.__wtState = { ok: true, enabled: false, active: true, level: 0.2, levelSource: "default",
      levelSetBy: "windowTransparencyLevel", levelLocked: false, levelEnvForced: false, lockedByJsonc: false,
      source: "default", envForced: true, nativeTitlebar: false };
    featuresItem.click();
    await sleep(200);
    const row3 = document.querySelector(".cdbx-panel").querySelector(wtSel).closest(".cdbx-row");
    ok(row3.querySelector(".cdbx-row-aside .cdbx-btn").classList.contains("cdbx-hide"),
       "no Restart now when CLAUDE_WINDOW_TRANSPARENCY decides the run");
    window.__wtState = null;
  }

  // Back to the default fixture for the rest of this walk-through. The panel
  // element itself is reused across renders, so the panel handle still points
  // at it - only the nodes captured above are gone, and everything below
  // re-queries. (No backticks in here: this whole driver is one String.raw
  // template, and one stray backtick ends it.)
  featuresItem.click();
  await sleep(200);

  // The theme picker: the only switch that is on with nothing on disk, because
  // the shortcut is how a fresh install finds the themes at all.
  const pickSel = ".cdbx-switch[aria-label='open the theme gallery with Ctrl+Shift+T']";
  const pick = panel.querySelector(pickSel);
  ok(!!pick, "the theme picker switch renders in the Community Features panel");
  if (pick) {
    const pickRow = pick.closest(".cdbx-row");
    ok(pickRow.querySelector(".cdbx-id").textContent === "Theme picker", "titled Theme picker");
    ok(pick.getAttribute("aria-checked") === "true",
       "it is on when nothing on disk turned it off");
    ok(pickRow.querySelector(".cdbx-state").textContent.indexOf("Ctrl+Shift+T opens the gallery") >= 0,
       "the state line names the chord: " + pickRow.querySelector(".cdbx-state").textContent);
    pick.click();
    await sleep(60);
    ok(window.__pickerCalls.length === 1 && window.__pickerCalls[0] === false,
       "clicking it calls pickerSet(false) exactly once: " + JSON.stringify(window.__pickerCalls));
    ok(pickRow.querySelector(".cdbx-state").textContent.indexOf("the shortcut does nothing") >= 0,
       "and the state line follows the write");
    pick.click();
    await sleep(60);
    ok(pick.getAttribute("aria-checked") === "true", "and it turns back on");
  }

  // This panel carries no STANDING restart notice, so every row has to say for
  // itself which of the two it is - verified per feature against the code that
  // consumes each pref, see the comment above renderFeatures. The window modes
  // are the only rows a restart is allowed to reach: they are BrowserWindow
  // constructor options with no live setter on Electron 44. Every other row
  // must promise live, and a row that quietly stops promising it trips this.
  // The rows that are NOT live: the two window modes (the frame is fixed when the
  // window is created), large-session loading (the limits are handed to the
  // session manager when it is constructed at startup) and non-Anthropic gateway
  // models (the model list is built at startup).
  const RESTART_ROWS = ["Hide window controls", "Native titlebar", "Load large sessions in full",
    "Allow non-Anthropic models"];
  // Transparent window is both: its switch needs a restart, its slider is live,
  // and its note has to say each.
  const MIXED_ROWS = ["Transparent window"];
  const rowNotes = Array.from(panel.querySelectorAll(".cdbx-row")).map(function (r) {
    return {
      title: r.querySelector(".cdbx-id").textContent,
      note: r.querySelector(".cdbx-note").textContent.toLowerCase()
    };
  });
  const mixedRows = rowNotes.filter(function (r) { return MIXED_ROWS.indexOf(r.title) >= 0; });
  const liveRows = rowNotes.filter(function (r) {
    return RESTART_ROWS.indexOf(r.title) < 0 && MIXED_ROWS.indexOf(r.title) < 0;
  });
  const restartRows = rowNotes.filter(function (r) { return RESTART_ROWS.indexOf(r.title) >= 0; });
  const missing = function (list, needle, want) {
    return list.filter(function (r) { return (r.note.indexOf(needle) >= 0) !== want; })
      .map(function (r) { return r.title; }).join(",");
  };
  ok(mixedRows.length === MIXED_ROWS.length && !missing(mixedRows, "applies live", true) &&
     !missing(mixedRows, "after a restart", true),
     "the mixed rows say both applies live and after a restart; these do not: " +
     missing(mixedRows, "applies live", true) + missing(mixedRows, "after a restart", true));
  ok(liveRows.length === rowNotes.length - RESTART_ROWS.length - MIXED_ROWS.length && liveRows.length > 0,
     "the panel is " + liveRows.length + " live rows plus the " + RESTART_ROWS.length + " restart-needing rows");
  ok(!missing(liveRows, "applies live", true),
     "every live row's note says it applies live; these do not: " + missing(liveRows, "applies live", true));
  ok(restartRows.length === RESTART_ROWS.length && !missing(restartRows, "after a restart", true),
     "and each restart-needing row's note says it takes effect after a restart; these do not: " +
     missing(restartRows, "after a restart", true));
  ok(!missing(restartRows, "applies live", false),
     "and neither of them also claims to apply live: " + missing(restartRows, "applies live", false));

  // --- the filter bar. Rows are HIDDEN, never re-rendered: a redraw would
  // re-fire every row's async read and lose the state the user just set.
  const box = panel.querySelector(".cdbx-search");
  ok(!!box, "the panel has a filter bar");
  if (box) {
    ok(document.activeElement === box, "the filter has the caret when the panel opens, ready to type into");
    ok(/^Filter \d+ features by name or description$/.test(box.placeholder),
       "which says what it filters: " + box.placeholder);
    const heads = Array.from(panel.querySelectorAll(".cdbx-sec-h"));
    const visible = function () {
      return heads.filter(function (h) { return h.style.display !== "none"; })
        .map(function (h) { return h.textContent; });
    };
    ok(visible().length === heads.length, "every row is visible before typing");

    await type("panel tabs");
    ok(visible().join(",") === "Layout",
       "a title match leaves only that section: " + visible().join(","));
    ok(!!panel.querySelector(".cdbx-row .cdbx-id"), "the matching row is still in the DOM");
    ok(panel.querySelectorAll(".cdbx-switch").length === heads.length,
       "no row was re-rendered - all switches survive the filter (" +
       panel.querySelectorAll(".cdbx-switch").length + ")");
    ok(window.__panelTabsCalls.length === 1 && window.__pickerCalls.length === 2,
       "and no read or write was fired again: " +
       JSON.stringify(window.__panelTabsCalls) + JSON.stringify(window.__pickerCalls));

    await type("ctrl+shift+t");
    ok(visible().join(",") === "Shortcuts",
       "a note match works too: " + visible().join(","));

    await type("source control");
    ok(visible().join(",") === "Source control", "so does a section match: " + visible().join(","));

    await type("no such feature");
    ok(visible().length === 0, "a needle nothing matches hides every row");
    const empty = panel.querySelector(".cdbx-empty");
    ok(!!empty && empty.style.display !== "none" &&
       empty.textContent === "No feature matches that filter.",
       "and the empty state says so");

    await type("");
    ok(visible().length === heads.length, "clearing the filter brings every row back");
    ok(panel.querySelector(".cdbx-empty").style.display === "none", "and hides the empty state");
  }

  // Locked: a hand-edited claude-desktop-extra.jsonc wins the startup merge, so
  // a fresh mount must render disabled with the "edit that file" affordance -
  // not just decline the write. Leave the panel and come back so renderFeatures
  // re-reads panelTabsRead()/pickerRead() against the updated fixture state.
  document.getElementById("row-account").click();
  await sleep(30);
  window.__panelTabsState = { ok: true, enabled: true, lockedByJsonc: true, source: "jsonc-locked" };
  window.__pickerState = { ok: true, enabled: false, lockedByJsonc: true };
  featuresItem.click();
  await sleep(120);
  const panel2 = document.querySelector(".cdbx-panel");
  const tabs2 = panel2 && panel2.querySelector(tabsSel);
  ok(!!tabs2, "the panel tabs switch renders again after remounting the panel");
  if (tabs2) {
    ok(tabs2.getAttribute("aria-checked") === "true", "a locked response still reports its real state (on)");
    ok(tabs2.disabled, "but the switch is disabled once the .jsonc locks it");
    ok(tabs2.title.indexOf("claude-desktop-extra.jsonc") >= 0,
       "and names the file to edit: " + tabs2.title);
    ok(tabs2.closest(".cdbx-row").querySelector(".cdbx-state").textContent
         .indexOf("claude-desktop-extra.jsonc") >= 0,
       "the state line says so too");
  }
  const pick2 = panel2 && panel2.querySelector(pickSel);
  ok(!!pick2, "the theme picker switch renders again after remounting the panel");
  if (pick2) {
    ok(pick2.getAttribute("aria-checked") === "false",
       "an explicit false in the .jsonc turns the shortcut off");
    ok(pick2.disabled, "and the switch is disabled because that file wins");
    ok(pick2.title.indexOf("claude-desktop-extra.jsonc") >= 0,
       "naming the file to edit: " + pick2.title);
  }
  // Load large sessions in full, against three more fixtures. Each remount
  // re-reads transcriptLimitsRead(), which is the only way to see these states:
  // the row's "restart owed" wording compares the SWITCH with what the running
  // app was started with, and only a fresh read changes the latter.
  async function remountTl(state) {
    document.getElementById("row-account").click();
    await sleep(30);
    window.__tlState = state;
    featuresItem.click();
    await sleep(120);
    const p = document.querySelector(".cdbx-panel");
    const sw = p && p.querySelector('.cdbx-switch[aria-label="load large Code sessions in full"]');
    return sw ? { sw: sw, state: sw.closest(".cdbx-row").querySelector(".cdbx-state").textContent } : null;
  }
  {
    const base = { ok: true, mainMiB: 512, subagentMiB: 384 };
    const locked = await remountTl(Object.assign({}, base, { enabled: true, lockedByJsonc: true, source: "jsonc-locked",
      activeNow: true, activeMainMiB: 512, activeSubagentMiB: 384, pendingRestart: false }));
    ok(!!locked, "the large-sessions switch renders again after remounting");
    if (locked) {
      ok(locked.sw.getAttribute("aria-checked") === "true", "locked: still reports its real state (on)");
      ok(locked.sw.disabled, "locked: the switch is disabled once the .jsonc holds it");
      ok(locked.sw.title.indexOf("claude-desktop-extra.jsonc") >= 0, "locked: names the file to edit: " + locked.sw.title);
      ok(locked.state === "on - up to 512 MiB main, 384 MiB subagents - set in claude-desktop-extra.jsonc",
         "locked and already running with it: shows the file's numbers, no restart wording: " + locked.state);
    }
    const changed = await remountTl(Object.assign({}, base, { mainMiB: 300, subagentMiB: 192, enabled: true,
      lockedByJsonc: false, source: "json", activeNow: true, activeMainMiB: 256, activeSubagentMiB: 192, pendingRestart: true }));
    ok(!!changed && changed.state === "on - 300 MiB main, 192 MiB subagents after a restart",
       "numbers edited since the app started: the row says a restart is owed: " + (changed && changed.state));
    const offRunning = await remountTl(Object.assign({}, base, { mainMiB: 256, subagentMiB: 192, enabled: false,
      lockedByJsonc: false, source: "default", activeNow: true, activeMainMiB: 256, activeSubagentMiB: 192, pendingRestart: true }));
    ok(!!offRunning && offRunning.state === "off - Anthropic's limits after a restart",
       "switched off while the app runs on: the row says Anthropic's limits return after a restart: " + (offRunning && offRunning.state));
    window.__tlState = undefined;
  }
  window.__pickerState = { ok: true, enabled: true, lockedByJsonc: null };
}

// Anthropic Features: everything that used to sit below our own switches -
// Anthropic's GrowthBook flags, the restart notice they need, the filter over
// them and the one config file the panel links.
// The Models panel: providers and models drawn from the bridge's state, the
// forms that write them back, and the write-only key. Every assertion is
// observable DOM or a recorded bridge call.
// Computer Use on a background display (issue #300): the Experimental row and
// the setup page behind its Set up button. Pinned here: the row only exists
// with the whole cuBackground* bridge, a .jsonc lock makes the row AND the page
// read-only, the user's own desktop is listed but never selectable or probed,
// and previews are taken only on request.
async function cubgPanel(featuresItem) {
  const SW = '.cdbx-switch[aria-label="let Computer Use work on a background display instead of your desktop"]';
  const base = window.__cubgBase;
  async function remount() {
    document.getElementById("row-account").click();
    await sleep(20);
    featuresItem.click();
    await sleep(50);
    return document.querySelector(".cdbx-panel");
  }
  async function openSetup(panel) {
    const sw = panel.querySelector(SW);
    const btn = sw && Array.prototype.filter.call(sw.closest(".cdbx-row").querySelectorAll(".cdbx-btn"),
      function (b) { return b.textContent === "Set up"; })[0];
    ok(!!btn, "the row carries a Set up button");
    if (!btn) return null;
    btn.click();
    await sleep(60);
    return document.querySelector(".cdbx-panel .cdbx-cubg");
  }

  window.__cubgState = Object.assign({}, base);
  let panel = await remount();
  let sw = panel.querySelector(SW);
  ok(!!sw, "renders the background display row");
  if (!sw) return;
  let row = sw.closest(".cdbx-row");
  const badge = row.querySelector(".cdbx-id .cdbx-exp");
  ok(!!badge && badge.textContent === "Experimental", "the title carries the Experimental badge");
  ok(row.querySelector(".cdbx-id").firstChild.textContent === "Computer Use on a background display", "titled Computer Use on a background display");
  ok(/next Computer Use start/.test(row.querySelector(".cdbx-note").textContent), "the note says it applies from the next Computer Use start");
  ok(row.querySelector(".cdbx-state").textContent === "off - no display chosen yet (Set up)",
     "state with nothing chosen: " + row.querySelector(".cdbx-state").textContent);
  ok(!sw.disabled, "the switch is usable when the .jsonc does not lock it");

  const restartOf = function (r) {
    return Array.prototype.filter.call(r.querySelectorAll(".cdbx-row-aside .cdbx-btn"),
      function (x) { return x.textContent === "Restart now"; })[0] || null;
  };
  const rs0 = restartOf(row);
  ok(!rs0 || rs0.classList.contains("cdbx-hide"), "off KDE: no Restart now on the row");

  // A KDE session that started in kwin mode: the row is a restart row.
  window.__cubgState = Object.assign({}, base, { config: { enabled: false, kind: "x11", display: ":99" },
    startedWith: { enabled: false, kwinMode: true, kdeWayland: true, restartOnChange: true } });
  panel = await remount();
  sw = panel.querySelector(SW);
  row = sw.closest(".cdbx-row");
  const rs = restartOf(row);
  ok(!!rs && rs.classList.contains("cdbx-hide"), "kwin session, nothing flipped: Restart now present but hidden");
  sw.click();
  await sleep(30);
  ok(!!rs && !rs.classList.contains("cdbx-hide") && /after a restart/.test(row.querySelector(".cdbx-state").textContent),
     "kwin session: flipping on shows Restart now and says after a restart: " + row.querySelector(".cdbx-state").textContent);
  sw.click();
  await sleep(30);
  ok(!!rs && rs.classList.contains("cdbx-hide"), "and flipping back hides it again");
  window.__cubgState = Object.assign({}, base, { enabled: true, config: { enabled: true, kind: "x11", display: ":99" },
    startedWith: { enabled: false, kwinMode: true, kdeWayland: true, restartOnChange: true } });
  panel = await remount();
  const pg = await openSetup(panel);
  ok(/takes effect after a restart/.test(row.querySelector(".cdbx-note").textContent) &&
     !/next Computer Use start/.test(row.querySelector(".cdbx-note").textContent),
     "kwin session: the row note says a restart, not the next Computer Use start");
  ok(!!pg && /takes effect after a restart/.test(document.querySelector(".cdbx-panel .cdbx-sub").textContent),
     "kwin session: so does the setup page intro");
  ok(!!pg && !!pg.querySelector(".cdbx-cubg-restart") &&
     Array.prototype.some.call(pg.querySelectorAll(".cdbx-cubg-restart .cdbx-btn"), function (x) { return x.textContent === "Restart now"; }),
     "kwin session, saved differs from start: the setup page offers Restart now");
  window.__cubgCalls = { set: [], thumb: [], probe: [], test: 0 };

  // Partial install: one channel missing in the preload -> no row at all.
  const savedProbe = window.cdbExtra.cuBackgroundProbe;
  delete window.cdbExtra.cuBackgroundProbe;
  panel = await remount();
  ok(!panel.querySelector(SW) && !/background display/.test(panel.textContent),
     "an older preload without the whole cuBackground* bridge gets no row");
  window.cdbExtra.cuBackgroundProbe = savedProbe;

  // The downstream Windows build: the main side answers "Linux only".
  window.__cubgState = { ok: false, error: "Computer Use on a background display is Linux only" };
  panel = await remount();
  ok(!panel.querySelector(SW) && !/background display/.test(panel.textContent) &&
     !/Computer Use$/m.test(Array.prototype.map.call(panel.querySelectorAll(".cdbx-sec-t"), function (n) { return n.textContent; }).join("\n")),
     "a 'Linux only' read hides the row and its section heading");

  // Locked by the hand-edited .jsonc: switch disabled, page read-only.
  window.__cubgState = Object.assign({}, base, { enabled: true, lockedByJsonc: true, source: "jsonc",
    config: { enabled: true, kind: "x11", display: ":99" }, path: "/home/u/.config/Claude/claude-desktop-extra.jsonc" });
  panel = await remount();
  sw = panel.querySelector(SW);
  ok(!!sw && sw.disabled && sw.getAttribute("aria-checked") === "true", "locked: the switch shows on and is disabled");
  ok(!!sw && /set in claude-desktop-extra\.jsonc$/.test(sw.closest(".cdbx-row").querySelector(".cdbx-state").textContent),
     "locked: the state line names the file: " + (sw ? sw.closest(".cdbx-row").querySelector(".cdbx-state").textContent : ""));
  let page = await openSetup(panel);
  ok(!!page, "Set up opens the setup page in the same panel");
  if (page) {
    ok(!!page.querySelector(".cdbx-cubg-locked") && /read-only/.test(page.querySelector(".cdbx-cubg-locked").textContent),
       "locked: the page says it is read-only and why");
    const lp = page.querySelector(".cdbx-cubg-locked .cdbx-pathlink");
    ok(!!lp && lp.textContent.endsWith("claude-desktop-extra.jsonc"), "locked: and links the .jsonc");
    const picks = page.querySelectorAll(".cdbx-cubg-select");
    ok(picks.length === 5 && Array.prototype.every.call(picks, function (b) { return b.disabled; }),
       "locked: every Select is disabled (" + picks.length + ")");
    ok(!Array.prototype.some.call(page.querySelectorAll(".cdbx-btn"), function (b) { return b.textContent === "Turn off"; }),
       "locked: no Turn off button");
  }

  // Unlocked, nothing chosen.
  window.__cubgState = Object.assign({}, base);
  window.__cubgCalls = { set: [], thumb: [], probe: [], test: 0 };
  panel = await remount();
  page = await openSetup(panel);
  if (!page) return;
  ok(document.querySelector(".cdbx-panel .cdbx-h1").textContent.indexOf("Computer Use on a background display") === 0 &&
     !!document.querySelector(".cdbx-panel .cdbx-h1 .cdbx-exp"), "the page heading carries the badge too");
  ok(/Display 1 is your desktop/.test(document.querySelector(".cdbx-panel .cdbx-sub").textContent) &&
     /You start display 2 yourself/.test(document.querySelector(".cdbx-panel .cdbx-sub").textContent),
     "the intro explains display 1 vs display 2 and who starts it");
  const own = page.querySelector('.cdbx-cubg-cand[data-display=":0"]');
  ok(!!own && /your desktop/.test(own.textContent), "the own desktop is listed and labelled");
  ok(!!own && !own.querySelector(".cdbx-cubg-select") && !own.querySelector(".cdbx-cubg-preview"),
     "the own desktop has no Select and no preview");
  ok(window.__cubgCalls.probe.indexOf(":0") < 0, "the own desktop is never probed: " + window.__cubgCalls.probe.join(","));
  ok(window.__cubgCalls.thumb.length === 0, "opening the page takes no preview");
  const c99 = page.querySelector('.cdbx-cubg-cand[data-display=":99"]');
  ok(!!c99 && /1280x800, 1 output, supported, window manager: Xfwm4/.test(c99.textContent),
     "a candidate shows the probe: " + (c99 ? c99.querySelector(".cdbx-state").textContent : ""));
  ok(!!c99 && c99.querySelectorAll(".cdbx-cubg-restr li").length === 2, "and the restrictions as text");
  const weston = page.querySelector('.cdbx-cubg-cand[data-display="wayland-weston"]');
  ok(!!weston && weston.querySelector(".cdbx-cubg-select").disabled && /not supported/.test(weston.textContent),
     "an unsupported display cannot be selected and says why");
  ok(/Not running/.test(page.querySelector('.cdbx-cubg-cand[data-display=":97"]').textContent), "a dead socket reads Not running");
  ok(page.querySelector(".cdbx-cubg-test").disabled, "Test is disabled until a display is chosen");
  ok(/from the next Computer Use start/.test(document.querySelector(".cdbx-panel .cdbx-sub").textContent),
     "off KDE: the intro says from the next Computer Use start");

  // Remote-supplied strings (bridge errors, WM/compositor names, restriction
  // text) are text, never markup.
  const evil = page.querySelector('.cdbx-cubg-cand[data-display=":66"]');
  ok(!!evil && evil.textContent.indexOf('<img src=x onerror="window.__xss=1">bridge said no') >= 0 &&
     evil.textContent.indexOf("<scr" + "ipt>window.__xss=2</scr" + "ipt>Evil WM") >= 0 &&
     evil.textContent.indexOf('<img src=y onerror="window.__xss=3">restriction') >= 0,
     "a probe's reason, WM name and restriction show as literal text");
  ok(!!evil && !evil.querySelector("img, script, b") && window.__xss === undefined, "and create no element and run nothing");

  // Busy is busy: not "not supported", Select stays usable.
  const busyRow = page.querySelector('.cdbx-cubg-cand[data-display=":67"]');
  ok(!!busyRow && /^Busy - /.test(busyRow.querySelector(".cdbx-state").textContent) && !busyRow.querySelector(".cdbx-cubg-select").disabled &&
     !/not supported/.test(busyRow.textContent), "a busy probe reads Busy - press Refresh, Select not disabled: " + (busyRow ? busyRow.querySelector(".cdbx-state").textContent : ""));

  // Copy: the clipboard API when it works, else the text is selected.
  const firstPre = page.querySelector(".cdbx-cubg-pre");
  const firstCopy = page.querySelector(".cdbx-cubg-copy");
  const copied = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, get: function () {
    return { writeText: function (t) { copied.push(t); return Promise.resolve(); } }; } });
  firstCopy.click();
  await sleep(10);
  ok(copied.length === 1 && copied[0] === firstPre.textContent && document.querySelector(".cdbx-toast").textContent === "Copied",
     "Copy writes the exact command to the clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, get: function () {
    return { writeText: function () { return Promise.reject(new Error("denied")); } }; } });
  window.getSelection().removeAllRanges();
  firstCopy.click();
  await sleep(10);
  ok(window.getSelection().toString() === firstPre.textContent && /press Ctrl\+C/.test(document.querySelector(".cdbx-toast").textContent),
     "a refused clipboard selects the command instead and says so");
  Object.defineProperty(navigator, "clipboard", { configurable: true, get: function () { return undefined; } });
  window.getSelection().removeAllRanges();
  firstCopy.click();
  await sleep(10);
  ok(window.getSelection().toString() === firstPre.textContent, "no clipboard API at all: selected as well");

  // Recipes: built for what is installed.
  const recipes = page.querySelectorAll(".cdbx-cubg-recipe");
  ok(recipes.length === 5, "five recipes (" + recipes.length + ")");
  const codes = Array.prototype.map.call(page.querySelectorAll(".cdbx-cubg-pre"), function (p) { return p.textContent; });
  ok(/^Xvfb :100 /.test(codes[0] || "") && /DISPLAY=:100 xfwm4 &$/.test(codes[0] || ""),
     "the Xvfb recipe skips display numbers in use and uses the installed WM: " + JSON.stringify(codes[0]));
  ok(/WLR_BACKENDS=headless WLR_RENDERER=pixman/.test(codes[2] || ""), "the headless sway recipe");
  ok(!/Install /.test(recipes[0].textContent) && /Install Arch: xorg-server-xephyr/.test(recipes[1].textContent),
     "a missing tool names its packages, an installed one does not");
  ok(Array.prototype.every.call(recipes, function (r) { return !!r.querySelector(".cdbx-cubg-copy"); }), "every recipe has a Copy button");

  // Narrow dialog: nothing pushes the panel wider than itself.
  const pnl = document.querySelector(".cdbx-panel");
  const oldW = pnl.style.width;
  pnl.style.width = "300px";
  await sleep(10);
  ok(pnl.scrollWidth <= pnl.clientWidth + 1, "no horizontal overflow at 300 px (" + pnl.scrollWidth + " > " + pnl.clientWidth + ")");
  pnl.style.width = oldW;

  // Preview on demand.
  c99.querySelector(".cdbx-cubg-preview").click();
  await sleep(30);
  ok(window.__cubgCalls.thumb.join(",") === ":99", "Show preview takes exactly one screenshot of that display");
  ok(!!c99.querySelector(".cdbx-cubg-shot img.cdbx-cubg-img"), "and shows it");

  // Select -> the exact bridge call, then the page redraws with it chosen.
  c99.querySelector(".cdbx-cubg-select").click();
  await sleep(60);
  ok(window.__cubgCalls.set.join("|") === '{"enabled":true,"kind":"x11","display":":99"}',
     "Select calls cuBackgroundSet({enabled, kind, display}): " + window.__cubgCalls.set.join("|"));
  page = document.querySelector(".cdbx-panel .cdbx-cubg");
  const status = page && page.querySelector(".cdbx-cubg-status");
  ok(!!status && /^On - running: 1280x800/.test(status.textContent), "the status line reads the chosen display: " + (status ? status.textContent : ""));
  const test = page && page.querySelector(".cdbx-cubg-test");
  ok(!!test && !test.disabled, "Test is enabled once a display is chosen");
  if (test) {
    test.click();
    await sleep(30);
    ok(window.__cubgCalls.test === 1 && page.querySelectorAll(".cdbx-cubg-steps li").length === 3 &&
       !!page.querySelector(".cdbx-cubg-testout img"), "Test shows its three steps and the screenshot");
    ok(page.querySelectorAll(".cdbx-cubg-testout img").length === 1 && window.__xss === undefined &&
       page.querySelector(".cdbx-cubg-steps").textContent.indexOf('<img src=z onerror="window.__xss=4">') >= 0,
       "a step detail with markup shows as text");
  }

  // Not running while on: the fail-closed explanation is visible.
  window.__cubgState = Object.assign({}, base, { enabled: true, config: { enabled: true, kind: "x11", display: ":97" } });
  document.querySelector(".cdbx-cubg-refresh").click();
  await sleep(60);
  const st2 = document.querySelector(".cdbx-panel .cdbx-cubg-status");
  ok(!!st2 && /not running/.test(st2.textContent) && /refuses to act/.test(st2.textContent) && st2.classList.contains("cdbx-warn"),
     "on but not running: the status says Computer Use refuses: " + (st2 ? st2.textContent : ""));

  document.querySelector(".cdbx-cubg-back").click();
  await sleep(40);
  ok(!!document.querySelector(".cdbx-panel " + SW), "Back returns to the feature list");
}

async function modelsPanel(modelsItem) {
  window.__cmConfig = { ok: true, enabled: true, configured: true, lockedByJsonc: false, source: "default",
    surfaces: ["ccd", "code"], models: 2, webSearch: "claude-deepseek-flash", webSearchLocked: false,
    smallFastModel: "", smallFastModelLocked: false,
    searchConflict: "gw-model is marked without the web search tool. Pick a web-search model to search from any session.",
    subagentModel: "", subagentModelLocked: false, announce: true, announceLocked: false,
    announceText: "Custom models available in this app (claude-desktop-extra), served by the user's own providers: claude-deepseek-flash[1m] (DeepSeek Flash, deepseek; sub-agent type deepseek-flash).",
    anthropicModels: [{ id: "claude-opus-5", name: "Opus 5" }, { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5" }],
    presets: [{ id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/anthropic", keyHint: "sk-...",
      modelsUrl: "https://api.deepseek.com/v1/models", effort: ["low", "high", "max"], context: "1m" }],
    paths: { json: "/home/u/.config/Claude/claude-desktop-extra.json", jsonc: "/home/u/.config/Claude/claude-desktop-extra.jsonc",
      secrets: "/home/u/.config/Claude/custom-models/secrets.json", routes: "/home/u/.config/Claude/custom-models/routes.json" },
    providers: [
      { id: "deepseek", baseUrl: "https://api.deepseek.com/anthropic", locked: false, keyOk: true, keySource: "stored", preset: "deepseek", modelsUrl: "https://api.deepseek.com/v1/models", effort: ["low", "high", "max"], context: "1m",
        models: [{ id: "deepseek-flash", alias: "claude-deepseek-flash", listedAs: ["claude-deepseek-flash[1m]"], name: "DeepSeek Flash", description: "", vision: true, thinking: true, context: "1m", effort: ["low", "high", "max"], effortDefault: "max", badge: "",
          agent: true, agentName: "deepseek-flash", agentDescription: "", agentPrompt: "", agentDefaults: { name: "deepseek-flash", description: "Sub-agent running on DeepSeek Flash via deepseek, a custom model outside Anthropic's.", prompt: "You are a sub-agent running on DeepSeek Flash." } }] },
      { id: "gw", baseUrl: "https://gw.example/anthropic", locked: true, keyOk: false, keySource: "none", effort: ["low", "medium", "high", "xhigh", "max"], context: "200k",
        models: [{ id: "gw-model", alias: "claude-gw-model", listedAs: ["claude-gw-model"], name: "gw-model", description: "", vision: false, thinking: false, webSearch: false, context: "200k", effortDefault: "", badge: "", agent: false, agentName: "", agentDescription: "", agentPrompt: "" }] }
    ] };
  window.__cmWrites = [];
  modelsItem.click();
  await sleep(120);
  const panel = document.querySelector(".cdbx-panel");
  ok(!!panel, "the Models panel is mounted");
  if (!panel) return;
  ok(panel.querySelector(".cdbx-h1").textContent === "Custom models", "the heading spells the full name out");
  const state = panel.querySelector(".cdbx-state");
  ok(!!state && /^On - 2 models from 2 providers/.test(state.textContent), "the state line counts models and providers: " + (state && state.textContent));
  {
    // The switch is the Community Features row, drawn first: same markup, same switch.
    const sw = panel.querySelector(".cdbx-models-status .cdbx-switch[role=switch]");
    ok(!!sw && sw.getAttribute("aria-checked") === "true" && !sw.disabled &&
       sw.closest(".cdbx-row").querySelector(".cdbx-id").textContent === "Custom models" &&
       sw.closest(".cdbx-row").querySelector(".cdbx-state") === state,
       "the page opens on the Custom models row with its switch, on");
    ok(!panel.querySelector(".cdbx-models-off"), "on: no off warning");
    // Providers come first, the app-wide choices after them.
    const order = Array.from(panel.querySelectorAll(".cdbx-sec-t")).map((t) => t.textContent);
    ok(order.join(",") === "Providers,Web search,Small / fast model,Sub-agents",
       "the providers come before the app-wide choices: " + order.join(","));
  }
  const reloadBtn = panel.querySelector(".cdbx-models-reload");
  ok(!!reloadBtn && reloadBtn.textContent === "Reload the Code tab" && /picker/.test(reloadBtn.title),
     "a Reload the Code tab button sits next to the switch (the picker is drawn from the page's bootstrap)");
  {
    // The dialog is closed first (Escape on the document, as a hand would), or
    // the reloaded page reopens it on its first section.
    let escapes = 0, reloads = 0;
    const onKey = (ev) => { if (ev.key === "Escape") escapes++; };
    const onReload = (ev) => { reloads++; ev.preventDefault(); }; // a real reload would restart this very page
    document.addEventListener("keydown", onKey);
    document.addEventListener("cdbx:reload", onReload);
    reloadBtn.click();
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("cdbx:reload", onReload);
    ok(escapes === 1 && reloads === 1, "Reload the Code tab sends Escape to the settings dialog, then reloads (cancelable cdbx:reload event)");
    await sleep(200);
  }
  ok(/reach open sessions at once/.test(panel.querySelector(".cdbx-models-files").textContent) &&
     /custom-models\/routes\.json/.test(panel.querySelector(".cdbx-models-files").textContent),
     "the footer says routing is live and names the routes file");
  {
    // Like every panel, it ends in the files behind it, as links.
    const links = Array.from(panel.querySelectorAll(".cdbx-pathrow .cdbx-pathlink")).map((b) => b.textContent);
    ok(links.indexOf("/home/u/.config/Claude/claude-desktop-extra.json") >= 0 && links.indexOf("/home/u/.config/Claude/claude-desktop-extra.jsonc") >= 0 &&
       links.indexOf("/home/u/.config/Claude/custom-models/secrets.json") < 0,
       "the panel ends in clickable rows for the .json and the .jsonc (not the secrets file): " + JSON.stringify(links));
    // The web-search warning sits in the web-search row.
    const wsRowEl = panel.querySelector("select.cdbx-models-websearch").closest(".cdbx-row");
    const warn = wsRowEl.querySelector(".cdbx-models-warn");
    ok(!!warn && /marked without the web search tool/.test(warn.textContent) &&
       !wsRowEl.querySelector("select.cdbx-models-smallfast"),
       "a searchConflict from the main side shows as a warning in the web-search row");
  }
  const cards = panel.querySelectorAll(".cdbx-models-card");
  ok(cards.length === 2, "one card per provider (" + cards.length + ")");
  if (cards.length !== 2) return;
  ok(cards[0].querySelector(".cdbx-id").textContent === "deepseek", "the editable provider is titled by its id");
  ok(/API key: stored/.test(cards[0].querySelector(".cdbx-state").textContent), "its key line says stored");
  const ws = panel.querySelector("select.cdbx-models-websearch");
  ok(!!ws && ws.value === "claude-deepseek-flash" && ws.options.length === 4 && ws.options[0].value === "" &&
     ws.options[1].textContent === "deepseek / DeepSeek Flash" && ws.options[2].value === "claude-opus-5" && ws.options[3].textContent === "Anthropic / Haiku 4.5",
     "the web-search select: the default, the custom models, then the Anthropic ones; current one selected (" + ws.options.length + ")");
  ok(!Array.from(ws.options).some((o) => o.value === "claude-gw-model"), "a model marked without the web search tool is not offered");
  ws.value = "";
  ws.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(40);
  ok(window.__cmWrites.indexOf("websearch-set:") >= 0, "picking Anthropic writes an empty value");
  window.__cmWrites = [];
  // The Small / fast model section: the ANTHROPIC_SMALL_FAST_MODEL slot. Unlike
  // the web-search select above it, every configured model qualifies - a model
  // marked without the web search tool is offered here.
  const sf = panel.querySelector("select.cdbx-models-smallfast");
  ok(!!sf && sf.value === "" && sf.options[0].value === "" && /Anthropic's default/.test(sf.options[0].textContent),
     "the small/fast select defaults to Anthropic, first option the default (" + (sf && sf.options.length) + ")");
  ok(Array.from(sf.options).some((o) => o.value === "claude-gw-model"),
     "a model without the web search tool IS offered for the small/fast slot (it is not web search)");
  sf.value = "claude-deepseek-flash";
  sf.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(40);
  ok(window.__cmWrites.indexOf("smallfast-set:claude-deepseek-flash") >= 0, "picking a model writes the small/fast alias: " + JSON.stringify(window.__cmWrites));
  window.__cmWrites = [];
  // The Sub-agents section: the default sub-agent model and the announce line.
  const sa = panel.querySelector("select.cdbx-models-subagent");
  ok(!!sa && sa.value === "" && sa.options.length === 3 && /Claude Code's default/.test(sa.options[0].textContent) &&
     sa.options[1].value === "claude-deepseek-flash" && sa.options[2].textContent === "gw / gw-model",
     "the default sub-agent model select: the CLI's default, then every custom model (" + (sa && sa.options.length) + ")");
  ok(!!sa && /general-purpose and Plan/.test(sa.closest(".cdbx-row").querySelector(".cdbx-note").textContent) &&
     /Explore is pinned/.test(sa.closest(".cdbx-row").querySelector(".cdbx-note").textContent),
     "its note names the built-in types it affects, and the one it does not");
  sa.value = "claude-deepseek-flash";
  sa.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(40);
  ok(window.__cmWrites.indexOf("subagent-set:claude-deepseek-flash") >= 0, "picking a model writes its alias: " + JSON.stringify(window.__cmWrites));
  window.__cmWrites = [];
  const an = panel.querySelector("button.cdbx-models-announce-box.cdbx-switch[role=switch]");
  ok(!!an && an.getAttribute("aria-checked") === "true" && !an.disabled, "Tell Claude about custom models is a switch, on");
  const anText = panel.querySelector(".cdbx-models-announce");
  ok(!!anText && /^Custom models available in this app/.test(anText.textContent) && /sub-agent type deepseek-flash/.test(anText.textContent),
     "and the line new sessions get is shown under it");
  an.click();
  await sleep(40);
  ok(window.__cmWrites.indexOf("announce-set:false") >= 0, "switching it off writes false: " + JSON.stringify(window.__cmWrites));
  window.__cmWrites = [];
  ok(/handed to each session as it opens/.test(panel.querySelector(".cdbx-models-files").textContent),
     "the footer says the sub-agent settings apply to sessions opened afterwards");
  ok(cards[1].classList.contains("cdbx-models-locked") && /set in claude-desktop-extra\.jsonc/.test(cards[1].querySelector(".cdbx-id").textContent),
     "the .jsonc provider is drawn locked and says so");
  ok(/MISSING/.test(cards[1].querySelector(".cdbx-state").textContent), "a provider without a key says so");
  ok(!cards[1].querySelector(".cdbx-models-add") && !Array.from(cards[1].querySelectorAll("button")).some((b) => b.textContent === "remove"),
     "a locked provider offers neither Add a model nor remove");
  const row = cards[0].querySelector(".cdbx-models-list .cdbx-row");
  ok(!!row && /in the picker as claude-deepseek-flash\[1m\] - 1M context/.test(row.querySelector(".cdbx-note").textContent) &&
     /default effort max/.test(row.querySelector(".cdbx-note").textContent), "the model row states the id it is listed under, its context and default effort: " + row.querySelector(".cdbx-note").textContent);
  ok(/sub-agent type deepseek-flash/.test(row.querySelector(".cdbx-note").textContent), "and its sub-agent type");
  ok(/no sub-agent type/.test(cards[1].querySelector(".cdbx-models-list .cdbx-row .cdbx-note").textContent), "a model without one says so");
  ok(/in the picker as claude-gw-model - 200k context/.test(cards[1].querySelector(".cdbx-models-list .cdbx-row .cdbx-note").textContent),
     "a 200k model says so");
  ok(/effort levels low\/high\/max/.test(cards[0].querySelector(".cdbx-state").textContent), "the provider card states its effort levels");

  // Add a model: the form's fields reach the bridge as typed.
  cards[0].querySelector(".cdbx-models-add").click();
  await sleep(30);
  const form = cards[0].querySelector(".cdbx-models-form-model-new");
  ok(!!form, "Add a model opens a form inside the card");
  if (form) {
    const inputs = form.querySelectorAll("input.cdbx-input");
    inputs[0].value = "deepseek-pro";
    inputs[1].value = "DeepSeek Pro";
    ok(!form.querySelector(".cdbx-models-level"), "a model form has no effort-level boxes - they belong to the provider");
    const selects = form.querySelectorAll("select");
    const effortSel = selects[0], contextSel = selects[1];
    ok(Array.from(effortSel.options).map((o) => o.value).join(",") === "low,high,max" && effortSel.value === "max",
       "the default select lists the provider's levels, the highest preselected: " + effortSel.value);
    effortSel.value = "high";
    ok(!!contextSel && Array.from(contextSel.options).map((o) => o.value).join(",") === "200k,1m,both" && contextSel.value === "1m",
       "the context select offers 200k / 1M / both, the provider's (preset) value preselected: " + (contextSel && contextSel.value));
    const ctxNote = contextSel.closest(".cdbx-models-field").querySelector(".cdbx-note");
    ok(!!ctxNote && /reads only the id/.test(ctxNote.textContent) && /\[1m\]/.test(ctxNote.textContent) && /Preset default: 1m/.test(ctxNote.textContent),
       "the context help explains the CLI reads the id, the [1m] spelling and the preset default");
    contextSel.value = "both";
    const boxes = form.querySelectorAll(".cdbx-models-field > .cdbx-row-aside > input[type=checkbox]");
    boxes[1].checked = false; // images off
    boxes[2].checked = false; // web search tool off
    ok(boxes.length === 4 && boxes[3].checked, "the form offers the sub-agent type, ticked by default (" + boxes.length + " boxes)");
    const agentPrompt = form.querySelector("textarea.cdbx-models-agent-prompt");
    ok(!!agentPrompt && agentPrompt.placeholder === "generated" && inputs.length === 6 && /generated from the display name/.test(inputs[4].placeholder),
       "with a name, a description and a prompt, the generated ones as placeholders");
    inputs[4].value = "Pro-Fanout";
    inputs[5].value = "Fan-out only, never a judge";
    agentPrompt.value = "Do the step.";
    Array.from(form.querySelectorAll("button")).find((b) => b.textContent === "Add model").click();
    await sleep(60);
    ok(window.__cmWrites.indexOf("model-set:deepseek:deepseek-pro:DeepSeek Pro:true:false:high:false:both") >= 0,
       "Add model sends provider id, model id, name, thinking, images, effort default, web search and context: " + JSON.stringify(window.__cmWrites));
    ok(window.__cmWrites.indexOf("model-agent:deepseek:deepseek-pro:true:Pro-Fanout:Fan-out only, never a judge:Do the step.") >= 0,
       "and the sub-agent fields as typed: " + JSON.stringify(window.__cmWrites));
  }

  // Add a provider: a button opens the form; the preset prefills, the key
  // travels only when typed.
  ok(!panel.querySelector(".cdbx-models-form-provider-new"), "the provider form is not open until asked");
  panel.querySelector(".cdbx-models-add-provider").click();
  await sleep(30);
  const addForm = panel.querySelector(".cdbx-models-form-provider-new");
  ok(!!addForm, "Add a provider opens the form under the button");
  if (addForm) {
    const preset = addForm.querySelector("select");
    preset.value = "deepseek";
    preset.dispatchEvent(new Event("change", { bubbles: true }));
    const f = addForm.querySelectorAll("input.cdbx-input");
    ok(f[0].value === "deepseek" && f[1].value === "https://api.deepseek.com/anthropic" && f[3].value === "https://api.deepseek.com/v1/models" && f.length === 5,
       "the preset prefills id, base URL and models URL");
    ok(fieldControl(addForm, "User-Agent") === f[4] && f[4].value === "" && fieldControl(addForm, "Drop the billing line").checked === false,
       "a new provider's User-Agent starts empty and the billing line is kept");
    f[4].value = "MyAgent/1.0";
    fieldControl(addForm, "Drop the billing line").checked = true;
    const plv = addForm.querySelectorAll(".cdbx-models-level input[type=checkbox]");
    ok(plv.length === 5 && Array.from(plv).map((c) => c.checked).join(",") === "true,false,true,false,true",
       "and ticks the effort levels it knows (low/high/max)");
    const pdetect = Array.from(addForm.querySelectorAll("button")).find((b) => b.textContent === "detect");
    ok(!!pdetect && pdetect.disabled, "detect waits for the provider to exist with a key and a model");
    ok(f[2].type === "password" && f[2].value === "", "the key field is a password field and starts empty");
    f[0].value = "ds2";
    f[2].value = "sk-secret-123456";
    Array.from(addForm.querySelectorAll("button")).find((b) => b.textContent === "Add provider").click();
    await sleep(80);
    ok(window.__cmWrites.some((w) => w === "provider-set:ds2:https://api.deepseek.com/anthropic:key:deepseek:https://api.deepseek.com/v1/models:low/high/max"),
       "Add provider sends the id, URL, key, preset, models URL and effort levels: " + JSON.stringify(window.__cmWrites));
    const sentP = (window.__cmProviderPayloads || []).filter((p) => p.id === "ds2").pop();
    ok(!!sentP && sentP.userAgent === "MyAgent/1.0" && sentP.stripBillingHeader === true,
       "and the User-Agent and the billing-line switch: " + JSON.stringify(sentP));
    ok(!window.__cmWrites.some((w) => /^model-set:ds2/.test(w)), "no model is added silently - fetch models is the next step");
    ok(!/sk-secret-123456/.test(panel.textContent), "the key never appears in the panel");
    // By hand (no preset): the provider alone, the card's Add a model is next.
    window.__cmWrites = [];
    panel.querySelector(".cdbx-models-add-provider").click();
    await sleep(30);
    const addForm2 = panel.querySelector(".cdbx-models-form-provider-new");
    const g = addForm2.querySelectorAll("input.cdbx-input");
    g[0].value = "gw2"; g[1].value = "https://gw.example/anthropic";
    Array.from(addForm2.querySelectorAll("button")).find((b) => b.textContent === "Add provider").click();
    await sleep(80);
    ok(window.__cmWrites.length === 1 && window.__cmWrites[0] === "provider-set:gw2:https://gw.example/anthropic:nokey:::low/medium/high/xhigh/max",
       "by hand: only the provider is created, no preset, all five levels: " + JSON.stringify(window.__cmWrites));
    const sentG = (window.__cmProviderPayloads || []).filter((p) => p.id === "gw2").pop();
    ok(!!sentG && sentG.userAgent === "" && sentG.stripBillingHeader === false, "untouched, they go empty and off: " + JSON.stringify(sentG));

  // Edit the existing provider: detect is live there and ticks what the
  // provider accepted.
  window.__cmWrites = [];
  // The panel redraws after every write, so re-query the card.
  const card0 = panel.querySelectorAll(".cdbx-models-card")[0];
  Array.from(card0.querySelectorAll(".cdbx-row-aside button")).find((b) => b.textContent === "edit").click();
  await sleep(30);
  const editForm = card0.querySelector(".cdbx-models-form");
  ok(!!editForm, "edit opens the provider form in the card");
  if (editForm) {
    const edetect = Array.from(editForm.querySelectorAll("button")).find((b) => b.textContent === "detect");
    ok(!!edetect && !edetect.disabled, "detect is live on a saved provider with a key and a model");
    edetect.click();
    await sleep(60);
    ok(window.__cmWrites.indexOf("probe:deepseek:") >= 0, "detect probes the provider (its first model)");
    const elv = editForm.querySelectorAll(".cdbx-models-level input[type=checkbox]");
    ok(Array.from(elv).map((c) => c.checked).join(",") === "true,false,false,false,true", "the boxes follow the provider's answer");
    Array.from(editForm.querySelectorAll("button")).find((b) => b.textContent === "cancel").click();
  }
  {
    // A save that moved the base URL to another host: the main side cleared
    // the key, and the toast asks for it again.
    const cfg = window.__cmConfig;
    window.__cmConfig = Object.assign({}, cfg, { keyCleared: true });
    const cardE = panel.querySelectorAll(".cdbx-models-card")[0];
    Array.from(cardE.querySelectorAll(".cdbx-row-aside button")).find((b) => b.textContent === "edit").click();
    await sleep(30);
    const f2 = cardE.querySelector(".cdbx-models-form");
    const save = f2 && Array.from(f2.querySelectorAll("button")).find((b) => b.textContent === "Save");
    if (save) { save.click(); await sleep(60); }
    const toastEl = document.querySelector(".cdbx-toast");
    ok(!!toastEl && /stored key was cleared: paste the key again/.test(toastEl.textContent) && /cdbx-toast-bad/.test(toastEl.className),
       "a key cleared by a host change is announced: " + (toastEl && toastEl.textContent));
    window.__cmConfig = cfg;
    await sleep(20);
  }
  {
    // Models that would still carry one of Anthropic's ids under their
    // provider's prefix were skipped by the main side: the card names them
    // and offers to remove them. A native (api.anthropic.com) card says so.
    const cfg = window.__cmConfig;
    const saveVia = async (card) => {
      Array.from(card.querySelectorAll(".cdbx-row-aside button")).find((b) => b.textContent === "edit").click();
      await sleep(30);
      const f = card.querySelector(".cdbx-models-form");
      const s = f && Array.from(f.querySelectorAll("button")).find((b) => b.textContent === "Save");
      if (s) { s.click(); await sleep(60); }
    };
    window.__cmConfig = JSON.parse(JSON.stringify(cfg));
    // The stored User-Agent and switch fill the edit form; a native provider has no switch.
    const editedForm = async () => {
      const card = panel.querySelectorAll(".cdbx-models-card")[0];
      Array.from(card.querySelectorAll(".cdbx-row-aside button")).find((b) => b.textContent === "edit").click();
      await sleep(30);
      return card.querySelector(".cdbx-models-form");
    };
    window.__cmConfig.providers[0].userAgent = "Other/2.0";
    window.__cmConfig.providers[0].stripBillingHeader = true;
    await saveVia(panel.querySelectorAll(".cdbx-models-card")[0]);
    let ef = await editedForm();
    ok(fieldControl(ef, "User-Agent").value === "Other/2.0" && fieldControl(ef, "Drop the billing line").checked === true,
       "a compatible provider's form shows its User-Agent and its billing-line switch");
    Array.from(ef.querySelectorAll("button")).find((b) => b.textContent === "cancel").click();
    window.__cmConfig = JSON.parse(JSON.stringify(cfg));
    window.__cmConfig.providers[0].shadowed = ["claude-opus-5-5", "claude-sonnet-5-5"];
    window.__cmConfig.providers[0].native = true;
    window.__cmConfig.providers[0].userAgent = "Pre/1.0";
    await saveVia(panel.querySelectorAll(".cdbx-models-card")[0]);
    ef = await editedForm();
    ok(fieldControl(ef, "User-Agent").value === "Pre/1.0" && fieldControl(ef, "Drop the billing line") === null,
       "a native provider's form shows its User-Agent and no billing-line switch (Anthropic uses that line)");
    Array.from(ef.querySelectorAll("button")).find((b) => b.textContent === "cancel").click();
    const cardS = panel.querySelectorAll(".cdbx-models-card");
    const line = cardS[0].querySelector(".cdbx-models-shadowed");
    ok(!!line && /^Skipped: claude-opus-5-5, claude-sonnet-5-5 - listed under this provider's id, they would still carry one of Anthropic's own model ids/.test(line.textContent) &&
       /Give the provider another id, or remove them\./.test(line.textContent) && /cdbx-models-warn/.test(line.className),
       "models that would still carry an Anthropic id are named as skipped, as a warning: " + (line && line.textContent));
    ok(!cardS[1].querySelector(".cdbx-models-shadowed"), "no such line on a provider without any");
    ok(/Anthropic's API on your API credit: the CLI's requests go as they are \(prompt caching kept\), Claude models listed as claude-deepseek-<model>/.test(cardS[0].textContent) &&
       !/Anthropic's API on your API credit/.test(cardS[1].textContent), "a native provider's card says how it is used");
    const rm = line && line.querySelector("button");
    ok(!!rm && rm.textContent === "remove them", "with a button to remove them");
    if (rm) {
      window.__cmWrites = [];
      rm.click();
      await sleep(80);
      ok(window.__cmWrites.join("|") === "model-delete:deepseek:claude-opus-5-5|model-delete:deepseek:claude-sonnet-5-5",
         "which deletes each skipped id, one after the other: " + window.__cmWrites.join("|"));
    }
    window.__cmConfig = cfg;
    await saveVia(panel.querySelectorAll(".cdbx-models-card")[0]);
    ok(!panel.querySelector(".cdbx-models-shadowed"), "gone once the main side reports none");
  }

  // Fetch models: the provider's list as a checklist, added ones disabled,
  // the picked ones added with the preset's effort levels.
  window.__cmWrites = [];
  const cardF = panel.querySelectorAll(".cdbx-models-card")[0];
  const fetchBtn = Array.from(cardF.querySelectorAll("button")).find((b) => b.textContent === "Fetch models");
  ok(!!fetchBtn && !fetchBtn.disabled, "Fetch models is offered on a provider with a key");
  fetchBtn.click();
  await sleep(60);
  const fetched = cardF.querySelector(".cdbx-models-fetched");
  ok(!!fetched && window.__cmWrites.indexOf("list:deepseek") >= 0, "the list is asked from the bridge and shown in the card");
  if (fetched) {
    const cbs = fetched.querySelectorAll("input[type=checkbox]");
    ok(cbs.length === 2 && cbs[0].checked && cbs[0].disabled && !cbs[1].checked, "the already-configured model is ticked and disabled, the other free");
    cbs[1].checked = true;
    Array.from(fetched.querySelectorAll("button")).find((b) => b.textContent === "Add selected").click();
    await sleep(80);
    ok(window.__cmWrites.some((w) => /^model-set:deepseek:deepseek-v4-pro:/.test(w)),
       "Add selected creates the ticked model: " + JSON.stringify(window.__cmWrites));
    ok(!fetched.querySelector(".cdbx-models-filter"), "a short list has no filter box");
  }
  // A long listing (a gateway) gets a filter box; a stated 1M context is
  // shown and travels with the added model.
  window.__cmModelsList = { ok: true, source: "https://openrouter.ai/api/v1/models", models: Array.from({ length: 14 }, (_, i) => (
    i === 0 ? { id: "qwen/qwen3.8-max-0902", name: "Qwen: Qwen3.8 Max", context: "1m" }
    : i === 1 ? { id: "z-ai/glm-5.3", name: "Z.ai: GLM 5.3", context: "1m" }
    : { id: "vendor/model-" + i, name: "Model " + i, context: "200k" })) };
  window.__cmWrites = [];
  fetchBtn.click();
  await sleep(60);
  const fetched2 = cardF.querySelector(".cdbx-models-fetched");
  const filt = fetched2 && fetched2.querySelector(".cdbx-models-filter");
  ok(!!filt, "a listing of more than 12 models gets a filter box");
  if (filt) {
    const labels = Array.from(fetched2.querySelectorAll(".cdbx-models-level"));
    ok(labels.length === 14 && /qwen\/qwen3\.8-max-0902 \(Qwen: Qwen3\.8 Max\) - 1M/.test(labels[0].textContent) && !/1M/.test(labels[2].textContent),
       "each entry shows id, name and 1M when the listing states it: " + labels[0].textContent);
    filt.value = "glm";
    filt.dispatchEvent(new Event("input", { bubbles: true }));
    ok(labels.filter((l) => !l.hidden).length === 1 && /glm-5\.3/.test(labels.find((l) => !l.hidden).textContent), "the filter narrows the checklist by id or name");
    filt.value = "";
    filt.dispatchEvent(new Event("input", { bubbles: true }));
    ok(labels.every((l) => !l.hidden), "an empty filter shows everything again");
    labels[0].querySelector("input").checked = true;
    Array.from(fetched2.querySelectorAll("button")).find((b) => b.textContent === "Add selected").click();
    await sleep(80);
    ok(window.__cmWrites.some((w) => w === "model-set:deepseek:qwen/qwen3.8-max-0902:Qwen: Qwen3.8 Max:undefined:undefined:undefined:undefined:1m"),
       "a listed model is added with its name and the listing's context: " + JSON.stringify(window.__cmWrites));
  }
  window.__cmModelsList = null;
  }

  // Test and remove on the editable provider.
  const btns = Array.from(panel.querySelectorAll(".cdbx-models-card")[0].querySelectorAll(".cdbx-row-aside button"));
  const test = btns.find((b) => b.textContent === "test");
  ok(!!test && !test.disabled, "test is offered on a provider with a key and a model");
  if (test) {
    test.click(); await sleep(40);
    ok(window.__cmWrites.indexOf("test:deepseek") >= 0, "test calls the bridge");
    const line = panel.querySelectorAll(".cdbx-models-card")[0].querySelector(".cdbx-models-testline");
    ok(!!line && !line.hidden && /answered \(deepseek-flash, HTTP 200\)/.test(line.textContent), "the result stays on the card: " + (line && line.textContent));
  }
  // The locked card has no key: test says so on the card instead of staying mute.
  const lockedTest = Array.from(panel.querySelectorAll(".cdbx-models-card")[1].querySelectorAll(".cdbx-row-aside button")).find((b) => b.textContent === "test");
  if (lockedTest) {
    window.__cmWrites = [];
    lockedTest.click(); await sleep(20);
    const line2 = panel.querySelectorAll(".cdbx-models-card")[1].querySelector(".cdbx-models-testline");
    ok(!!line2 && !line2.hidden && /no API key/.test(line2.textContent) && window.__cmWrites.indexOf("test:gw") < 0,
       "test without a key explains instead of calling the bridge: " + (line2 && line2.textContent));
  }
  const rm = btns.find((b) => b.textContent === "remove");
  if (rm) {
    rm.click();
    await sleep(20);
    ok(rm.textContent === "remove? click again" && window.__cmWrites.indexOf("provider-delete:deepseek") < 0, "remove asks for a second click");
    rm.click();
    await sleep(40);
    ok(window.__cmWrites.indexOf("provider-delete:deepseek") >= 0, "the second click deletes");
  }

  // Off but configured: the switch is off, a warning says nothing on the page is in use, and the switch turns it on.
  window.__cmConfig = Object.assign({}, window.__cmConfig, { enabled: false });
  window.__customModelsCalls = [];
  modelsItem.click();
  await sleep(120);
  {
    const p2 = document.querySelector(".cdbx-panel");
    const sw = p2 && p2.querySelector(".cdbx-models-status .cdbx-switch");
    const off = p2 && p2.querySelector(".cdbx-models-status .cdbx-models-off");
    ok(!!sw && sw.getAttribute("aria-checked") === "false" && !sw.disabled, "off: the switch is off and usable");
    ok(!!off && /Nothing on this page is in use while the switch is off/.test(off.textContent), "off: the row warns that nothing on the page is in use");
    ok(/^Off - 2 models configured but not listed/.test(p2.querySelector(".cdbx-state").textContent), "off: the state line says so");
    if (sw) { sw.click(); await sleep(60); }
    ok(window.__customModelsCalls.length === 1 && window.__customModelsCalls[0] === true, "off: the switch calls customModelsSet(true) once: " + JSON.stringify(window.__customModelsCalls));
  }
  // Nothing configured: the switch cannot turn on, and says why.
  window.__cmConfig = Object.assign({}, window.__cmConfig, { enabled: false, configured: false, models: 0, providers: [] });
  modelsItem.click();
  await sleep(120);
  {
    const p3 = document.querySelector(".cdbx-panel");
    const sw = p3 && p3.querySelector(".cdbx-models-status .cdbx-switch");
    ok(!!sw && sw.disabled && /Add a provider and a model first/.test(sw.title), "empty: the switch is disabled and says what is missing");
    ok(!p3.querySelector(".cdbx-models-off") && !p3.querySelector(".cdbx-models-reload"), "empty: no off warning, no reload button");
    const firstSec = p3.querySelector(".cdbx-sec-t");
    ok(!!firstSec && firstSec.textContent === "Providers" && !!p3.querySelector(".cdbx-models-add-provider"),
       "empty: Add a provider sits right under the switch, before the app-wide choices");
  }
}

async function flagsPanel(flagsItem) {
  flagsItem.click();
  await sleep(140);
  const panel = document.querySelector(".cdbx-panel");
  ok(!!panel, "the Anthropic Features panel is mounted");
  if (!panel) return;
  ok(panel.querySelector(".cdbx-h1").textContent === "Anthropic Features",
     "the heading spells the full name out even though the nav row says Anthropic: " +
     panel.querySelector(".cdbx-h1").textContent);
  ok(!panel.querySelector(".cdbx-switch[aria-label=\"show the Code tab's side panels as tabs instead of a split layout\"]"),
     "our own switches stayed behind in Community Features");

  // The restart notice speaks only for these flags, which is why it lives here.
  const notice = panel.querySelector(".cdbx-notice");
  ok(!!notice, "the restart notice is in this panel");
  if (notice) {
    ok(notice.textContent.indexOf("require a restart of Claude Desktop") >= 0,
       "and says a restart is needed");
    const restart = notice.querySelector(".cdbx-btn");
    ok(!!restart && restart.textContent === "Restart now", "with the Restart now button");
    if (restart) {
      restart.click();
      await sleep(40);
      ok(window.__relaunchCalls === 1,
         "clicking it calls appRelaunch exactly once (" + window.__relaunchCalls + ")");
    }
  }

  // --- the flag list itself
  const rows = function () { return Array.from(panel.querySelectorAll(".cdbx-list .cdbx-row")); };
  const ids = function () {
    return rows().map(function (r) { return r.querySelector(".cdbx-id").textContent; });
  };
  ok(ids().join(",") === "1001,1002,1003",
     "every catalog entry got a row, in catalog order: " + ids().join(","));
  const first = rows()[0];
  ok(first.querySelector(".cdbx-state").textContent.indexOf("not in your account") >= 0,
     "a flag the account payload does not carry says so: " +
     first.querySelector(".cdbx-state").textContent);
  ok(rows()[1].querySelector(".cdbx-switch").getAttribute("aria-checked") === "true",
     "a flag the account has on renders on");

  // Value-carrying flags are a read-only chip: a bare true would replace the
  // server's value with something meaningless.
  const valueRow = rows()[2];
  ok(!!valueRow.querySelector(".cdbx-value"), "a value flag renders its value as a chip");
  ok(!valueRow.querySelector(".cdbx-switch"), "and gets no switch at all");
  ok(valueRow.querySelector(".cdbx-state").textContent.indexOf("read-only here") >= 0,
     "the state line says why");

  first.querySelector(".cdbx-switch").click();
  await sleep(60);
  ok(window.__flagCalls.length === 1 && window.__flagCalls[0] === "1001=true",
     "flipping a flag writes it once: " + JSON.stringify(window.__flagCalls));
  ok(!!first.querySelector(".cdbx-clear"), "and the clear-override affordance appears");

  // --- the filter, over ids and notes both
  await type("imagine");
  ok(ids().join(",") === "1002", "the filter matches a note: " + ids().join(","));
  await type("1003");
  ok(ids().join(",") === "1003", "and an id: " + ids().join(","));
  await type("no such flag");
  ok(ids().length === 0 &&
     panel.querySelector(".cdbx-list .cdbx-empty").textContent === "No flag matches that filter.",
     "a needle nothing matches gets the empty state");
  await type("");
  ok(ids().length === 3, "clearing the filter brings every flag back");

  // Only the .jsonc is linked: it is the config file a human edits, and the one
  // whose hand-set flag ids win over this page. The .json the switches are
  // persisted to is internal bookkeeping and is deliberately not advertised.
  const fileRows = panel.querySelectorAll(".cdbx-pathrow");
  ok(fileRows.length === 1, "the panel links exactly one file (" + fileRows.length + ")");
  if (fileRows.length === 1) {
    const shown = fileRows[0].querySelector(".cdbx-pathlink").textContent;
    ok(shown.endsWith("claude-desktop-extra.jsonc"), "and it is the .jsonc: " + shown);
    ok(/win over this page/.test(fileRows[0].textContent),
       "worded as what that file does, not as where the switches are saved: " + fileRows[0].textContent);
    const seen = window.__revealCalls.length;
    fileRows[0].querySelector(".cdbx-pathbtn").click();
    await sleep(40);
    ok(window.__revealCalls[seen] === "config-jsonc:folder",
       "its folder button works: " + window.__revealCalls.join(","));
  }
  ok(!Array.from(panel.querySelectorAll(".cdbx-pathlink"))
      .some(function (a) { return a.textContent.endsWith("claude-desktop-extra.json"); }),
     "the internal .json is not linked anywhere in the panel");
}

// The Deployment panel: the 1P/3P switch writes the persisted deploymentMode and
// the managed-settings keys are rendered from the catalog the main process sends.
// The fixture below runs in 1P with a stored gateway config, which is exactly the
// state where the switch matters.
async function deployPanel(deployItem) {
  deployItem.click();
  await sleep(140);
  const panel = document.querySelector(".cdbx-panel");
  ok(!!panel, "the Deployment panel is mounted");
  if (!panel) return;

  // --- the mode switch
  const seg = panel.querySelectorAll(".cdbx-seg-b");
  ok(seg.length === 2, "the mode switch offers exactly 1P and 3P (" + seg.length + ")");
  ok(seg[0].textContent === "1P" && seg[1].textContent === "3P", "labelled 1P and 3P");
  ok(seg[0].getAttribute("aria-pressed") === "true",
     "the pressed side is the mode the next start will use");
  ok(panel.textContent.indexOf("Running now: Personal") >= 0, "the running mode is stated");
  ok(!!panel.querySelector(".cdbx-notice.cdbx-hide"),
     "the restart notice is hidden while the running and next modes agree");

  seg[1].click();
  await sleep(80);
  ok(window.__deployCalls.indexOf("mode:3p") >= 0, "clicking 3P persists deploymentMode=3p");
  ok(seg[1].getAttribute("aria-pressed") === "true" && seg[0].getAttribute("aria-pressed") === "false",
     "the switch moves to 3P");
  const notice = panel.querySelector(".cdbx-notice");
  ok(notice && !notice.classList.contains("cdbx-hide"),
     "and the restart notice appears, because the running session is still 1P");
  ok(!!panel.querySelector(".cdbx-notice .cdbx-btn"), "with a restart button");

  // --- undoing the mode choice: the same "clear" the Features panel offers for a
  //     flag override. Without it, one click on 1P/3P is permanent.
  let modeClear = panel.querySelector(".cdbx-mode .cdbx-clear");
  ok(!!modeClear, "the mode switch has a clear chip");
  ok(!modeClear.classList.contains("cdbx-hide"),
     "shown, because this fixture has a saved deploymentMode");
  modeClear.click();
  await sleep(60);
  ok(window.__deployCalls.indexOf("mode:clear") >= 0,
     "clicking it clears the persisted key rather than writing another mode: " +
     window.__deployCalls.join(","));
  ok(modeClear.classList.contains("cdbx-hide"),
     "and it hides itself, because there is nothing left to clear");
  ok(panel.querySelector(".cdbx-state").textContent.indexOf("deploymentMode") < 0,
     "the next-start line stops citing a saved choice");

  // --- keys: rendered from the catalog, grouped, and provider-filtered
  const rows = panel.querySelectorAll(".cdbx-sections .cdbx-row");
  ok(rows.length >= 4, "the configuration keys are rendered (" + rows.length + ")");
  const keyOf = (row) => row.querySelector(".cdbx-id").textContent;
  const keys = Array.from(rows).map(keyOf);
  ok(keys.indexOf("inferenceGatewayBaseUrl") >= 0,
     "the stored provider's own keys are shown: " + keys.join(","));
  ok(keys.indexOf("inferenceVertexProjectId") < 0,
     "another provider's keys stay hidden until it is selected");
  const check = panel.querySelector(".cdbx-check input");
  check.click();
  await sleep(40);
  ok(Array.from(panel.querySelectorAll(".cdbx-sections .cdbx-row")).map(keyOf)
       .indexOf("inferenceVertexProjectId") >= 0,
     "\"show every provider\" brings them back");
  check.click();
  await sleep(40);

  // --- a boolean writes through
  const chat = Array.from(panel.querySelectorAll(".cdbx-sections .cdbx-row"))
    .find(function (r) { return keyOf(r) === "chatTabEnabled"; });
  ok(!!chat, "a boolean key row exists");
  const sw = chat.querySelector(".cdbx-switch");
  ok(sw.getAttribute("aria-checked") === "false", "an unset boolean reads as off");
  ok(chat.textContent.indexOf("not set") >= 0, "and says so, with the upstream default");
  sw.click();
  await sleep(60);
  ok(window.__deployCalls.indexOf("set:chatTabEnabled=true") >= 0, "clicking it writes the key");
  ok(sw.getAttribute("aria-checked") === "true", "the switch follows");
  ok(!!chat.querySelector(".cdbx-clear"), "a clear chip appears once the key is set");

  // --- the batch undo, for a handful of toggles set by mistake
  const clearAll = panel.querySelector(".cdbx-sec-act");
  ok(!!clearAll, "the configuration section has a clear-all button");
  ok(!clearAll.classList.contains("cdbx-hide"), "shown, because keys are set");
  const count = panel.querySelector(".cdbx-sec-h .cdbx-sec-n").textContent;
  ok(/^\d+ set$/.test(count), "next to how many keys are set: " + count);
  clearAll.click();
  await sleep(40);
  ok(window.__deployCalls.indexOf("clear") < 0,
     "one click does NOT clear anything - it arms the button");
  ok(/click again/.test(clearAll.textContent) && clearAll.classList.contains("cdbx-armed"),
     "which the label and the styling say: " + clearAll.textContent);
  clearAll.click();
  await sleep(60);
  ok(window.__deployCalls.indexOf("clear") >= 0, "the second click clears");

  // --- a secret is never sent to the page
  const secret = Array.from(panel.querySelectorAll(".cdbx-sections .cdbx-row"))
    .find(function (r) { return keyOf(r) === "inferenceGatewayApiKey"; });
  ok(!!secret, "the secret row is rendered");
  const box = secret.querySelector("input");
  ok(box.type === "password", "as a password field");
  ok(box.value === "", "with no value in the DOM");
  ok(box.placeholder.indexOf("stored") >= 0, "but it says one is stored: " + box.placeholder);
  ok(panel.textContent.indexOf("sk-secret") < 0, "the secret itself never reaches the page");

  // --- object model entries show as JSON lines, never "[object Object]"
  const models = Array.from(panel.querySelectorAll(".cdbx-sections .cdbx-row"))
    .find(function (r) { return keyOf(r) === "inferenceModels"; });
  const area = models && models.querySelector("textarea");
  ok(!!area, "the model list row is a textarea");
  ok(area.value.indexOf("[object Object]") < 0, "an object entry is not stringified to [object Object]: " + JSON.stringify(area.value));
  ok(area.value === 'claude-opus-4-8\n{"name":"claude-sonnet-4-6","labelOverride":"Sonnet"}',
     "strings stay bare, objects become one JSON line each: " + JSON.stringify(area.value));

  // --- a locked key cannot be written from here
  const locked = Array.from(panel.querySelectorAll(".cdbx-sections .cdbx-row"))
    .find(function (r) { return keyOf(r) === "disableDeploymentModeChooser"; });
  ok(!!locked, "the key that would lock the machine into 3P is shown");
  ok(locked.querySelector(".cdbx-switch").disabled,
     "but its switch is disabled, so this page can never write it");
  ok(locked.textContent.indexOf("read-only") >= 0, "and the row says why");

  // --- the dropdown popup: Chromium paints it from the SELECT's own colors, and
  //     a popup is not composited over the page, so a translucent background
  //     leaves it unreadable (white on white in the dark modal).
  const sel = panel.querySelector(".cdbx-select");
  ok(!!sel, "a select is rendered");
  const selBg = getComputedStyle(sel).backgroundColor;
  ok(alphaOf(selBg) === 1,
     "the select's background is fully opaque, so its popup is too: " + selBg);
  const opt = sel.querySelector("option");
  const optBg = getComputedStyle(opt).backgroundColor;
  const optFg = getComputedStyle(opt).color;
  ok(alphaOf(optBg) === 1, "so is every option's: " + optBg);
  ok(optBg !== optFg, "and the option text is not the same colour as its background");
  const surface = panel.style.getPropertyValue("--cdbx-surface");
  ok(surface === "rgb(38,38,36)",
     "the modal's own opaque surface was measured, not the panel's own translucency: " + surface);
  ok(panel.style.getPropertyValue("--cdbx-ink") === "rgb(245, 244, 239)",
     "and the modal's ink with it");
  ok(panel.style.colorScheme === "dark" || panel.style.colorScheme === "light",
     "and color-scheme is set, so Chromium paints the popup chrome to match: " +
     panel.style.colorScheme);

  // --- the file paths are stated, and they open
  ok(panel.textContent.indexOf("configLibrary") >= 0, "the configuration file path is shown");
  ok(panel.textContent.indexOf("claude_desktop_config.json") >= 0, "so is the mode file");
  const rowsP = panel.querySelectorAll(".cdbx-pathrow");
  ok(rowsP.length === 3, "three file links: the config, the mode file and the managed policy (" +
     rowsP.length + ")");
  const link = rowsP[0].querySelector(".cdbx-pathlink");
  ok(link.tagName === "BUTTON" && link.textContent.indexOf("configLibrary") >= 0,
     "the path itself is the link");
  link.click();
  await sleep(40);
  ok(window.__revealCalls.indexOf("deploy-config:open") >= 0,
     "clicking it asks the main process to open that LOCATION, not a path: " +
     window.__revealCalls.join(","));
  rowsP[1].querySelector(".cdbx-pathbtn").click();
  await sleep(40);
  ok(window.__revealCalls.indexOf("deploy-mode:folder") >= 0,
     "and the folder button reveals it in the file manager");
  ok(Array.from(rowsP).map(function (r) {
       return r.querySelector(".cdbx-pathlink").textContent;
     }).every(function (t) { return t.indexOf("/") === 0; }),
     "every link shows an absolute path");
}

async function themesPanel(themesItem) {
  themesItem.click();
  await sleep(80);
  ok(!!document.querySelector(".cdbx-sections"), "the Themes panel renders sections");
  ok(!document.querySelector(".cdbx-panel .cdbx-switch[aria-label=\"show the Code tab's side panels as tabs instead of a split layout\"]"),
     "the panel tabs switch is NOT in the Themes panel");

  const secs = sections();
  ok(labels() === "Your themes:1 | Gaming:3 | Common:5 | More:1",
     "section order and counts: " + labels());
  ok(secs.length === 4, "four sections for this list (" + secs.length + ")");

  const gaming = secs[1];
  ok(gaming.cards.indexOf("Mario") >= 0, "the built-in mario is under Gaming, not lost in Common");
  ok(gaming.cards.indexOf("Zelda") >= 0, "a community gaming palette is under Gaming");
  ok(gaming.cards.indexOf("My-neon") >= 0, "a user gaming theme is under Gaming");
  ok(gaming.cards.join(",") === "Mario,My-neon,Zelda", "Gaming is alphabetical: " + gaming.cards.join(","));
  ok(secs[0].cards.join(",") === "My-own", "Your themes holds the non-gaming custom theme only");
  // Built-in and community share one section: the packaging tier is not
  // something a user picks a theme by.
  ok(secs[2].cards.join(",") === "Almond,Catppuccin-mocha,Dracula,Nord,Solarized",
     "Common merges built-in and community, alphabetically, and keeps the entry with no category field: " +
     secs[2].cards.join(","));
  ok(secs[3].cards.join(",") === "Mystery", "an unknown source tier is still shown, under More");
  ok(secs.reduce(function (n, s) { return n + s.cards.length; }, 0) === 10,
     "every theme appears exactly once across the sections");

  // The active card keeps its highlight and its badge wherever it is sectioned.
  const marioCard = Array.from(document.querySelectorAll(".cdbx-card")).find(function (c) {
    return c.querySelector(".cdbx-cardname").textContent === "Mario";
  });
  ok(marioCard.classList.contains("cdbx-on"), "the active theme card is still highlighted");
  ok(marioCard.querySelector(".cdbx-badge").textContent.indexOf("active") >= 0,
     "the active badge is unchanged");

  // Filtering searches across sections and takes empty headings with it.
  await type("nord");
  ok(labels() === "Common:1", "filtering to one theme leaves one section: " + labels());
  await type("gaming");
  ok(labels() === "Gaming:3", "the filter also matches the category: " + labels());
  await type("zzzz");
  ok(labels() === "", "no section heading survives a filter that matches nothing");
  ok(!!document.querySelector(".cdbx-panel .cdbx-empty"), "the empty message is shown instead");
  await type("");
  ok(labels() === "Your themes:1 | Gaming:3 | Common:5 | More:1",
     "clearing the filter brings every section back");

  // The config file we write is a link, not just text - and it must be the file
  // a click here ACTUALLY writes, which depends on what exists on disk. This
  // fixture reports the .json as the effective target, so a hardcoded .jsonc
  // link would be wrong.
  let savedRow = document.querySelector(".cdbx-panel .cdbx-pathrow");
  ok(!!savedRow, "the Themes panel shows the config file it saves to");
  ok(savedRow.querySelector(".cdbx-pathlink").textContent.endsWith("claude-desktop-extra.json"),
     "naming the effective save target, not the registry's fixed .jsonc: " +
     savedRow.querySelector(".cdbx-pathlink").textContent);
  savedRow.querySelector(".cdbx-pathlink").click();
  await sleep(40);
  ok(window.__revealCalls.indexOf("config-json:open") >= 0,
     "and the link opens THAT file, derived from the path rather than hardcoded: " +
     window.__revealCalls.join(","));

  // Applying still works from inside a section.
  const zeldaCard = Array.from(document.querySelectorAll(".cdbx-card")).find(function (c) {
    return c.querySelector(".cdbx-cardname").textContent === "Zelda";
  });
  zeldaCard.click();
  await sleep(60);
  const nowActive = Array.from(document.querySelectorAll(".cdbx-card.cdbx-on"))
    .map(function (c) { return c.querySelector(".cdbx-cardname").textContent; });
  ok(nowActive.join(",") === "Zelda", "applying from a section moves the highlight: " + nowActive.join(","));
  savedRow = document.querySelector(".cdbx-panel .cdbx-pathrow");
  ok(savedRow.querySelector(".cdbx-pathlink").textContent.endsWith(".jsonc"),
     "an apply that reports a different file corrects the row: " +
     savedRow.querySelector(".cdbx-pathlink").textContent);
  savedRow.querySelector(".cdbx-pathlink").click();
  await sleep(40);
  ok(window.__revealCalls.indexOf("config-jsonc:open") >= 0,
     "and the link follows it too: " + window.__revealCalls.join(","));
  ok(labels() === "Your themes:1 | Gaming:3 | Common:5 | More:1",
     "the sections survive a re-render after apply");

  // The overlay row: what themeOverlay merges over the picked theme, above the
  // filter, with a way to turn it off - and a way to pick one when it is off.
  function overlayRow() { return document.querySelector(".cdbx-panel .cdbx-overlay-row"); }
  function activeBadge() {
    var on = document.querySelector(".cdbx-panel .cdbx-card.cdbx-on");
    return on ? on.querySelector(".cdbx-badge").textContent : "";
  }
  let row = overlayRow();
  ok(!!row, "the Themes panel renders the overlay row");
  if (row) {
    ok(row.querySelector(".cdbx-id").textContent === "Overlay: Wallpaper accent",
       "it names the active overlay by display name, resolved from the candidates (the grid never lists a hidden theme): " +
       row.querySelector(".cdbx-id").textContent);
    ok(/over every theme you pick/.test(row.querySelector(".cdbx-note").textContent), "it says what the overlay does");
    const off = row.querySelector(".cdbx-row-aside .cdbx-btn");
    ok(!!off && off.textContent === "Turn off", "it offers Turn off");
    ok(!row.querySelector("select"), "no select while an overlay is active");
    const search = document.querySelector(".cdbx-panel .cdbx-search");
    ok(!!search && row.closest(".cdbx-list").compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING,
       "the row sits above the filter box");
    ok(/active \+ overlay/.test(activeBadge()), "the active card's badge says an overlay is merged over it: " + activeBadge());

    off.click();
    await sleep(80);
    ok(window.__overlayCalls.join(",") === "", 'Turn off called setOverlay(""): ' + JSON.stringify(window.__overlayCalls));
    row = overlayRow();
    ok(!!row, "the row stays because there are candidates");
    const select = row && row.querySelector("select.cdbx-select");
    ok(!!select, "and now carries a select");
    const opts = select ? Array.from(select.options).map(function (o) { return o.value + "=" + o.textContent; }).join("|") : "";
    ok(opts === "=none|wallpaper-accent=Wallpaper accent|my-own=My-own|my-neon=My-neon",
       "listing none first, then the candidates in engine order: " + opts);
    const apply = row && row.querySelector(".cdbx-row-aside .cdbx-btn");
    ok(!!apply && apply.textContent === "Apply", "and an Apply button");
    ok(apply.disabled, "Apply is disabled while none is selected");
    ok(!/overlay/.test(activeBadge()), "the badge dropped the overlay note: " + activeBadge());

    select.value = "my-own";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    ok(!apply.disabled, "choosing a candidate enables Apply");
    apply.click();
    await sleep(80);
    ok(window.__overlayCalls.join(",") === ",my-own", "Apply called setOverlay with the chosen name: " + JSON.stringify(window.__overlayCalls));
    row = overlayRow();
    ok(!!row && row.querySelector(".cdbx-id").textContent === "Overlay: My-own",
       "the row names the new overlay: " + (row ? row.querySelector(".cdbx-id").textContent : "no row"));
    ok(/active \+ overlay/.test(activeBadge()), "and the badge is back: " + activeBadge());
    ok(labels() === "Your themes:1 | Gaming:3 | Common:5 | More:1",
       "the sections survive the overlay re-render");
  }
}

// The invariant the broken injection violated: a <ul> may only ever hold <li>
// children. Whatever we insert, and wherever we insert it, that has to hold.
function assertMarkupIsValid() {
  const strays = [];
  Array.from(document.querySelectorAll("ul,ol")).forEach(function (list) {
    Array.from(list.children).forEach(function (kid) {
      if (kid.tagName !== "LI") strays.push(list.className + " > " + kid.tagName + "." + kid.className);
    });
  });
  ok(!strays.length, "every child of every list is an <li>: " + (strays.join("; ") || "none"));
  ok(!document.querySelector("ul > div, ul > span, ol > div, ol > span"),
     "no <div> or <span> is a child of a list");
}

// A cloned row: upstream classes on both halves, our glyph INSIDE the icon-font
// box, our label ONLY in the label span, and both rendering exactly like the
// sibling row it was cloned from.
function assertClonedRow(item, label, sibling) {
  const control = controlOf(item);
  const sibControl = sibling.querySelector("button,a") || sibling;
  ok(!!control, "the row has a control (" + label + ")");
  ok(control.tagName === sibControl.tagName, "the control keeps the row tag (" + control.tagName + ")");
  ok(sameClasses(control, sibControl, ["cdbx-item-btn", "cdbx-item", "cdbx-sel-fb"]),
     "the control carries exactly the sibling row's classes");
  ok(!control.id, "the cloned id was stripped");
  ok(!item.hasAttribute("data-testid") && !control.hasAttribute("data-testid"),
     "the cloned test id was stripped");
  ok(!control.hasAttribute("aria-current"), "no cloned selection attribute");
  ok(!control.hasAttribute("href"), "no cloned href");

  // --- icon
  const boxes = control.querySelectorAll(ICON_SEL);
  const box = boxes[0];
  const sibBox = sibControl.querySelector(ICON_SEL);
  if (sibBox) {
    ok(boxes.length === 1, "exactly one icon box survives (" + boxes.length + ")");
    ok(!!box, "the upstream icon-font box was kept, not replaced");
    ok(sameClasses(box, sibBox), "the icon box keeps the sibling icon's classes");
    ok(box.getAttribute("style") === sibBox.getAttribute("style"),
       "the icon box keeps the sibling icon's inline metrics");
    const svg = box.querySelector("svg");
    ok(!!svg, "our <svg> sits INSIDE the icon-font box");
    if (svg) {
      ok(svg.namespaceURI === SVGNS, "the glyph is in the SVG namespace");
      ok(svg.getAttribute("viewBox") === "0 0 24 24", "the glyph uses our 24x24 box");
      ok(svg.getAttribute("width") === "1em" && svg.getAttribute("height") === "1em",
         "the glyph is 1em square, so the icon font's size drives it");
      ok(svg.children.length >= 2, "the glyph has our own shapes (" + svg.children.length + ")");
      ok(Array.from(svg.children).every(function (s) { return s.namespaceURI === SVGNS; }),
         "our shapes are in the SVG namespace");
      ok(!!svg.querySelector('[fill="currentColor"], [stroke="currentColor"]'),
         "our shapes paint themselves with currentColor");
      const rect = svg.getBoundingClientRect();
      ok(Math.abs(rect.width - 20) <= 1 && Math.abs(rect.height - 20) <= 1,
         "the glyph renders at the icon font's 20px (" + rect.width + "x" + rect.height + ")");
    }
    ok(!/[\uE000-\uF8FF]/.test(box.textContent),
       "the upstream private-use ligature character is gone");
    ok(box.textContent.trim() === "", "the icon box carries no text at all");
  }

  // --- label
  const spans = labelSpans(control);
  if (sibBox) {
    ok(spans.length === 1, "the row has exactly one non-icon element, the label span (" + spans.length + ")");
  }
  const slot = spans[spans.length - 1] || control;
  ok(slot.textContent === label, "the label text is in the label span: " + JSON.stringify(slot.textContent));
  ok(control.textContent.trim() === label,
     "and nowhere else in the row: " + JSON.stringify(control.textContent.trim()));
  if (sibBox) {
    ok(box.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING,
       "the label still follows the icon");
    const sibLabel = labelSpans(sibControl).pop();
    const fs = getComputedStyle(slot).fontSize;
    const sfs = getComputedStyle(sibLabel).fontSize;
    ok(fs === sfs, "the label renders at the sibling label's font-size (" + fs + " vs " + sfs + ")");
    ok(fs !== getComputedStyle(box).fontSize,
       "the label is NOT rendered at the icon font's size (" + fs + ")");
  }

  // --- geometry
  const mine = control.getBoundingClientRect();
  const theirs = sibControl.getBoundingClientRect();
  ok(Math.abs(mine.height - theirs.height) <= 1,
     "the row renders at the sibling's height (" + mine.height + " vs " + theirs.height + ")");
  ok(Math.abs(mine.left - theirs.left) <= 1,
     "the row is indented like the sibling (" + mine.left + " vs " + theirs.left + ")");
  ok(Math.abs(mine.width - theirs.width) <= 1,
     "the row is as wide as the sibling (" + mine.width + " vs " + theirs.width + ")");
}

async function assertPanelMounts(item) {
  const body = document.getElementById("panebody");
  item.click();
  await sleep(40);
  const panel = document.querySelector(".cdbx-panel");
  ok(!!panel, "our panel is mounted");
  if (!panel) return;
  ok(body.style.display === "none", "the pane's scrolling body is hidden, not removed");
  ok(document.getElementById("pane").style.display !== "none",
     "the content pane itself stays visible, so the close button survives");
  ok(!!document.getElementById("close-btn").offsetParent, "the close button is still rendered");
  ok(panel.parentElement === body.parentElement,
     "our panel is a sibling of the pane's scrolling body");
  ok(document.getElementById("pane").contains(panel),
     "and it sits inside the content pane, on the pane's own background");
  const box = panel.getBoundingClientRect();
  ok(box.height > 100 && box.height <= 600,
     "our panel fits inside the dialog instead of stretching it (" + box.height + ")");
}

async function run() {
  // "<kind>-nested" is the same scenario on the nested pane shape (see dialog()).
  const nested = /-nested$/.test(window.__fixture);
  const kind = window.__fixture.replace(/-nested$/, "");
  const real = kind.indexOf("real") === 0;
  const items = ourItems();
  const box = navbox();

  // --- the Windows build: the page runs with navigator.platform "Win32" and
  //     offers the Models panel only.
  if (kind === "windows") {
    ok(items.length === 1, "Windows: one row was added (" + items.length + ")");
    ok(items.length === 1 && items[0].textContent.trim() === "Models",
       "Windows: the row is Models (" + (items[0] ? items[0].textContent.trim() : "none") + ")");
    if (items.length === 1) await assertPanelMounts(items[0]);
    return;
  }

  ok(items.length === LABELS.length, LABELS.length + " rows were added (" + items.length + ")");
  ok(!!document.querySelector(".cdbx-navgroup"), "the rainbow Extra label is in the DOM");
  ok(document.querySelector(".cdbx-navgroup").textContent === "Extra", "it says Extra");
  if (items.length !== LABELS.length) return;

  if (real) {
    // --- placement: header and list as SIBLINGS in the scroll container,
    //     immediately before the "Desktop app" header. No wrapper, no nesting.
    const hdr = document.querySelector(".cdbx-navhdr");
    const list = document.querySelector(".cdbx-navlist");
    ok(!!hdr, "our group header exists");
    ok(!!list, "our group list exists");
    if (!hdr || !list) return;
    const kids = Array.from(box.children);
    const desktopHdr = childByText("Desktop app");
    const desktopList = desktopHdr.nextElementSibling;
    ok(hdr.parentElement === box, "our header is a direct child of the scroll container");
    ok(list.parentElement === box, "our list is a direct child of the scroll container");
    ok(kids.indexOf(list) === kids.indexOf(hdr) + 1, "our header and list are adjacent siblings");
    ok(kids.indexOf(desktopHdr) === kids.indexOf(list) + 1,
       "the pair sits immediately before the Desktop app header");
    ok(!hdr.parentElement.closest("ul") && !list.parentElement.closest("ul"),
       "neither of them was nested inside an upstream <ul>");
    ok(!box.querySelector(".cdbx-navhdr .cdbx-item"), "our rows are not inside our header");
    assertMarkupIsValid();
    ok(box.querySelectorAll("ul").length === 4,
       "the three upstream lists are untouched and exactly one was added (" +
       box.querySelectorAll("ul").length + ")");
    ok(Array.from(box.children).filter(function (n) { return n.textContent.trim() === "Settings"; }).length === 1,
       "no upstream group header was duplicated");

    // --- the frame is a clone of the real one.
    ok(hdr.tagName === desktopHdr.tagName, "our header keeps the upstream header tag");
    ok(sameClasses(hdr, desktopHdr, ["cdbx-group", "cdbx-navhdr"]),
       "our header keeps the upstream header classes (" + hdr.className + ")");
    ok(hdr.textContent.trim() === "Extra", "our header says Extra");
    ok(hdr.firstElementChild && hdr.firstElementChild.classList.contains("cdbx-navgroup"),
       "the rainbow class is on the header text only");
    ok(!hdr.classList.contains("cdbx-navgroup-fb"), "the fabricated-header class is NOT used");
    ok(getComputedStyle(hdr).fontSize === getComputedStyle(desktopHdr).fontSize,
       "our header renders at the upstream header's font-size");
    ok(list.tagName === desktopList.tagName, "our list keeps the upstream list tag (" + list.tagName + ")");
    ok(sameClasses(list, desktopList, ["cdbx-group", "cdbx-navlist"]),
       "our list keeps the upstream list classes (" + list.className + ")");
    ok(list.children.length === LABELS.length, "our list holds exactly our own rows");
    ok(items.every(function (it) { return it.parentElement === list; }),
       "both rows are children of our cloned list");
    ok(items.every(function (it) { return it.tagName === "LI"; }),
       "our rows are <li> - valid children of a <ul>");
    ok(list.textContent.replace(/\s+/g, "") === LABELS.join("").replace(/\s+/g, ""),
       "no upstream text survived the clone: " + JSON.stringify(list.textContent.trim()));

    // --- the rows are clones of a real row of that same group.
    const sibling = document.getElementById("row-developer").parentElement;
    LABELS.forEach(function (label, i) { assertClonedRow(items[i], label, sibling); });

    // --- the shortened labels carry their full name as a tooltip, and only they
    //     do: a title repeating the label it sits on would be noise.
    LABELS.forEach(function (label, i) {
      const tip = controlOf(items[i]).getAttribute("title");
      if (TOOLTIPS[label]) {
        ok(tip === TOOLTIPS[label],
           "the " + label + " row's tooltip carries the full name: " + JSON.stringify(tip));
      } else {
        ok(tip === null, "the " + label + " row carries no tooltip: " + JSON.stringify(tip));
      }
    });

    // --- selection migration, both directions.
    const upstreamSel = document.getElementById("row-general");
    const before = upstreamSel.className;
    const attrMode = kind === "real";
    const ambiguous = kind === "real-ambiguous";
    await assertPanelMounts(items[0]);
    const ctl0 = controlOf(items[0]);
    if (ambiguous) {
      // Two rows deviate from the shared shape and none carries an attribute, so
      // which one is "selected" is not knowable: our own outline, and upstream is
      // left completely alone.
      ok(ctl0.classList.contains("cdbx-sel-fb"),
         "an ambiguous nav gets our own outline instead of a borrowed pill");
      ok(upstreamSel.className === before, "the upstream row is left untouched");
      ok(!ctl0.classList.contains("bg-alpha-2"), "no upstream selected class was taken");
      ok(diags.some(function (d) { return d.indexOf("no selected-row class diff") >= 0; }),
         "the missing class diff was reported through the diag channel");
      ok(diags.some(function (d) { return d.indexOf("cloned from") >= 0; }),
         "the group is still a clone - only the selected look falls back");
      document.getElementById("row-account").click();
      await sleep(30);
      ok(!ctl0.classList.contains("cdbx-sel-fb"), "the outline is removed on leaving");
      ok(!document.querySelector(".cdbx-panel"), "the panel unmounts");
      return;
    }
    if (attrMode) {
      ok(ctl0.getAttribute("aria-current") === "page", "our button took over aria-current");
      ok(!upstreamSel.hasAttribute("aria-current"), "the upstream button gave up aria-current");
    } else {
      ok(!ctl0.hasAttribute("aria-current"), "no aria-current is invented when upstream uses none");
    }
    ok(ctl0.classList.contains("bg-alpha-2") && ctl0.classList.contains("font-medium") &&
       ctl0.classList.contains("text-primary"), "our button took over the selected classes");
    ok(!ctl0.classList.contains("text-secondary"), "our button dropped the unselected colour class");
    ok(!upstreamSel.classList.contains("bg-alpha-2"), "the upstream button gave the selected classes up");
    ok(upstreamSel.classList.contains("text-secondary"), "the upstream button got the base colour back");
    ok(!ctl0.classList.contains("cdbx-sel-fb"), "no fallback outline when a real diff exists");
    ok(document.getElementById("row-org").classList.contains("orglink"),
       "the list-less organization link was not mistaken for a nav row");

    controlOf(items[1]).parentElement.click();
    await sleep(30);
    ok(!ctl0.classList.contains("bg-alpha-2") && !ctl0.hasAttribute("aria-current"),
       "switching between our rows moves the selected look along");
    ok(controlOf(items[1]).classList.contains("bg-alpha-2"), "and the other row takes it");

    document.getElementById("row-account").click();
    await sleep(30);
    ok(upstreamSel.className === before, "the upstream selected row is exactly restored");
    if (attrMode) ok(upstreamSel.getAttribute("aria-current") === "page", "aria-current came back");
    ok(!controlOf(items[1]).classList.contains("bg-alpha-2") &&
       !controlOf(items[1]).hasAttribute("aria-current"), "our row gave the selected look back");
    ok(!document.querySelector(".cdbx-panel"), "our panel is unmounted");
    ok(document.getElementById("panebody").style.display !== "none",
       "the pane's scrolling body is visible again");

    // Clicking a row of ANOTHER group also restores (the listener sits on the
    // scroll container, the level our header and list live at).
    items[0].click();
    await sleep(30);
    document.getElementById("row-extensions").click();
    await sleep(30);
    ok(!document.querySelector(".cdbx-panel"), "a click in another group restores too");

    // Keyboard: a cloned <button> activates by itself, so no key handler of ours
    // may fire on top of the synthetic click.
    ok(diags.some(function (d) { return d.indexOf("nav shape") >= 0; }),
       "a DOM-shape diagnostic was logged");
    const shape = diags.find(function (d) { return d.indexOf("nav shape") >= 0; }) || "";
    ok(shape.indexOf("Cowork") < 0 && shape.indexOf("text-secondary") < 0 && shape.indexOf("truncate") < 0,
       "the shape diagnostic leaks no class names and no page text");
    ok(shape.indexOf("icon=box") >= 0, "the shape diagnostic records the icon-font box");
    ok(shape.indexOf("hdr[desktop app]") >= 0, "and which group header it anchored on");
    ok(shape.indexOf("via=testid") >= 0,
       "and that the nav itself was found language-independently: " + shape);
    ok(shape.length <= 300, "the shape diagnostic fits the diag channel (" + shape.length + ")");
    ok(diags.some(function (d) { return d.indexOf("cloned from") >= 0; }),
       "the install line reports the clone path");
    ok(!diags.some(function (d) { return d.indexOf("carries no") >= 0; }),
       "no icon complaint for a nav that has icon boxes");

    if (kind === "real") {
      await themesPanel(items[0]);
      await featuresPanel(items[1]);
      await cubgPanel(items[1]);
      await modelsPanel(items[2]);
      await flagsPanel(items[3]);
      await deployPanel(items[4]);
    }
    return;
  }

  // --- the same nav in Spanish. Everything asserted here is placement and
  //     diagnostics: the panels are English-independent and are covered by the
  //     "real" scenario, so what these two pin is that a translated interface
  //     reaches the SAME rendering - a cloned header and list pair - and never
  //     the divider fallback.
  if (kind.indexOf("es-") === 0) {
    const byId = kind === "es-testid";
    const hdr = document.querySelector(".cdbx-navhdr");
    const list = document.querySelector(".cdbx-navlist");
    ok(!!hdr && !!list, "a cloned header and list pair was built for a Spanish nav");
    ok(!document.querySelector(".cdbx-navgroup-fb"),
       "the divider fallback did NOT run - the group is a real clone");
    if (!hdr || !list) return;
    const kids = Array.from(box.children);
    // Where the pair belongs: before the desktop group when the test ids are
    // there to point at it, and otherwise before the last group that has a list
    // of its own - never after the organization section, which has none.
    const anchorText = byId ? "Aplicación de escritorio" : "Personalizar";
    const anchorHdr = childByText(anchorText);
    ok(!!anchorHdr, "the anchor header is in the fixture: " + anchorText);
    ok(hdr.parentElement === box && list.parentElement === box,
       "both are direct children of the scroll container");
    ok(kids.indexOf(list) === kids.indexOf(hdr) + 1, "our header and list are adjacent siblings");
    ok(anchorHdr && kids.indexOf(anchorHdr) === kids.indexOf(list) + 1,
       "the pair sits immediately before the " + anchorText + " header");
    ok(hdr.textContent.trim() === "Extra", "our header says Extra");
    ok(list.children.length === LABELS.length, "our list holds exactly our own rows");
    ok(items.every(function (it) { return it.tagName === "LI" && it.parentElement === list; }),
       "our rows are <li> children of our cloned list");
    ok(sameClasses(hdr, anchorHdr, ["cdbx-group", "cdbx-navhdr"]),
       "our header carries the upstream header classes (" + hdr.className + ")");
    assertMarkupIsValid();
    ok(box.querySelectorAll("ul").length === 4,
       "the three upstream lists are untouched and exactly one was added (" +
       box.querySelectorAll("ul").length + ")");
    LABELS.forEach(function (label, i) {
      assertClonedRow(items[i], label, document.getElementById("row-skills").parentElement);
    });

    const shape = diags.find(function (d) { return d.indexOf("nav shape") >= 0; }) || "";
    ok(!!shape, "a DOM-shape diagnostic was logged");
    ok(shape.indexOf(byId ? "via=testid" : "via=labels") >= 0,
       "it names the path the nav was found by: " + shape);
    ok(shape.indexOf(byId ? "hdr[#structure]" : "hdr[#last-group]") >= 0,
       "and the tier the anchor came from rather than its text: " + shape);
    // The anchor's own text is the user's interface language. It is page content
    // and it must not reach the log, so the whole line is checked for it.
    const spanish = ["Ajustes", "Aplicaci", "Personalizar", "Habilidades", "Cuenta",
                     "Capacidades", "Desarrollador", "Organizaci"];
    const leaked = spanish.filter(function (w) {
      return diags.some(function (d) { return d.indexOf(w) >= 0; });
    });
    ok(!leaked.length, "no translated page text reached the diag channel: " + (leaked.join(",") || "none"));
    ok(!diags.some(function (d) { return d.indexOf("behind a divider") >= 0; }),
       "and the fallback rendering was never reported");
    ok(diags.some(function (d) {
      return d.indexOf(byId ? "cloned from the group found by structure, not by label"
                            : "cloned from the last group, found by structure") >= 0;
    }),
       "the install line names the anchor by tier, with no page text: " +
       (diags.find(function (d) { return d.indexOf("Extra nav group added") >= 0; }) || "-"));

    // Selection still migrates: aria-current is on a row of a group we did not
    // anchor on, which is the case the re-scan in selectOurs exists for.
    const upstreamSel = document.getElementById("row-general");
    const before = upstreamSel.className;
    await assertPanelMounts(items[0]);
    ok(controlOf(items[0]).getAttribute("aria-current") === "page",
       "our button took over aria-current");
    ok(!upstreamSel.hasAttribute("aria-current"), "the upstream button gave it up");
    ok(!controlOf(items[0]).classList.contains("cdbx-sel-fb"), "so no outline is needed");
    document.getElementById("row-account").click();
    await sleep(30);
    ok(upstreamSel.className === before, "the upstream selected row is exactly restored");
    ok(upstreamSel.getAttribute("aria-current") === "page", "aria-current came back");
    ok(!document.querySelector(".cdbx-panel"), "the panel unmounts");
    return;
  }

  if (kind === "no-headers") {
    // --- fallback into a real list: the divider must be a valid list child.
    const hdr = document.querySelector(".cdbx-navgroup-fb");
    ok(!!hdr, "the fabricated divider is in the DOM");
    if (!hdr) return;
    ok(hdr.tagName === "LI", "the divider is an <li>, a valid child of a <ul> (" + hdr.tagName + ")");
    ok(hdr.parentElement.tagName === "UL", "it was appended to a real list");
    ok(hdr.parentElement === box.querySelectorAll("ul")[1], "to the LAST list, after its own rows");
    ok(hdr.nextElementSibling === items[0], "the divider immediately precedes our rows");
    ok(items.every(function (it) { return it.tagName === "LI" && it.parentElement === hdr.parentElement; }),
       "our rows are list children next to it");
    ok(getComputedStyle(hdr).display === "block" && getComputedStyle(hdr).listStyleType === "none",
       "the divider carries no list marker");
    assertMarkupIsValid();
    ok(!document.querySelector(".cdbx-navhdr,.cdbx-navlist"), "no cloned frame was claimed");
    ok(diags.some(function (d) { return d.indexOf("behind a divider") >= 0; }),
       "the fallback was reported through the diag channel");
    ok(diags.some(function (d) { return d.indexOf("nor a group header shape") >= 0; }),
       "and it says that neither the label nor the structural anchor was found");

    const sibling = document.getElementById("row-developer").parentElement;
    LABELS.forEach(function (label, i) { assertClonedRow(items[i], label, sibling); });

    // The frame falls back but the selected look does not: aria-current is here.
    const upstreamSel = document.getElementById("row-general");
    const before = upstreamSel.className;
    await assertPanelMounts(items[0]);
    ok(controlOf(items[0]).getAttribute("aria-current") === "page",
       "the selected look still migrates in the fallback rendering");
    ok(!controlOf(items[0]).classList.contains("cdbx-sel-fb"), "so no outline is needed");
    document.getElementById("row-account").click();
    await sleep(30);
    ok(upstreamSel.className === before, "and it is given back exactly");
    ok(upstreamSel.getAttribute("aria-current") === "page", "aria-current came back");
    ok(!document.querySelector(".cdbx-panel"), "the panel unmounts");
    return;
  }

  // --- kind === "bare": every degradation at once.
  const hdr = document.querySelector(".cdbx-navgroup-fb");
  ok(!!hdr, "the fabricated header is in the DOM");
  if (!hdr) return;
  ok(hdr.tagName === "DIV", "with no list to append to it is a <div> in the nav container");
  ok(hdr.parentElement === box, "appended to the nav container itself");
  ok(hdr.querySelector(".cdbx-navgroup").textContent === "Extra", "the fallback header says Extra");
  assertMarkupIsValid();
  ok(items[0].tagName === "A" && items[0].classList.contains("nvi"),
     "the rows are still clones of the real row");
  ok(!items[0].hasAttribute("href"), "the cloned href was stripped");
  ok(items[0].getAttribute("role") === "button" && items[0].getAttribute("tabindex") === "0",
     "a link clone is made focusable and activatable by hand");
  ok(items[0].classList.contains("cdbx-item") && items[0].classList.contains("cdbx-item-btn"),
     "cell and control are the same element here");
  ok(LABELS.every(function (label, i) { return items[i].textContent.trim() === label; }),
     "the labels are appended as text when the row has no label element");
  ok(diags.some(function (d) { return d.indexOf("icon box") >= 0 && d.indexOf("<svg>") >= 0; }),
     "the missing icon box was reported through the diag channel");
  ok(diags.some(function (d) { return d.indexOf("behind a divider") >= 0; }),
     "so was the fallback rendering");

  await assertPanelMounts(items[0]);
  ok(items[0].classList.contains("cdbx-sel-fb"),
     "without a computable class diff our own outline marks the active row");
  document.querySelectorAll(".nvi")[1].click();
  await sleep(30);
  ok(!document.querySelector(".cdbx-panel"), "the fallback panel unmounts");
  ok(!items[0].classList.contains("cdbx-sel-fb"), "the fallback outline is removed again");

  // Keyboard activation, the only way in for a link clone with no href.
  items[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await sleep(40);
  ok(!!document.querySelector(".cdbx-panel"), "Enter on a link clone opens the panel");
}
`;

function html(fixture, name) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, sans-serif; font-size: 16px; }
  button { border: 0; background: none; font: inherit; color: inherit; }
  ul { margin: 0; padding: 0; list-style: none; }
  /* dialog shell, mirroring the capture's own layout classes */
  .dialog { display: flex; width: 900px; height: 600px; background: #262624; color: #f5f4ef; }
  .navcol { display: flex; width: 192px; flex: 0 0 auto; flex-direction: column; gap: 8px; border-right: 1px solid #eee; }
  .navbox { display: flex; min-height: 0; flex: 1 1 auto; flex-direction: column; gap: 8px; overflow-y: auto; padding: 0 12px 12px; }
  .pane { display: flex; min-height: 0; min-width: 0; flex: 1 1 auto; flex-direction: column; }
  .panehead { display: flex; flex: 0 0 auto; height: 44px; align-items: center; padding: 0 12px; }
  .subhead { flex: 0 0 auto; height: 12px; }
  .contents { display: contents; }
  .wrapcol { position: relative; display: flex; min-height: 0; flex: 1 1 auto; flex-direction: column; }
  .panebody { position: relative; min-height: 0; flex: 1 1 auto; overflow-y: auto; overflow-x: hidden; padding: 8px 24px 20px; }
  .orglink { display: flex; height: 32px; align-items: center; gap: 8px; border-radius: 6px; padding: 0 8px; color: #555; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }
  .nvi { display: block; padding: 6px 8px; font-size: 14px; }
  /* the utility classes the captured rows actually use */
  .flex { display: flex; } .flex-col { flex-direction: column; } .items-center { align-items: center; }
  .w-full { width: 100%; } .min-w-0 { min-width: 0; } .flex-1 { flex: 1 1 0%; } .shrink-0 { flex-shrink: 0; }
  .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gap-sm { gap: 8px; } .gap-px { gap: 1px; }
  .px-sm { padding-left: 8px; padding-right: 8px; } .px-md { padding-left: 12px; padding-right: 12px; }
  .pt-md { padding-top: 12px; } .pb-md { padding-bottom: 12px; }
  .h-control { height: 32px; } .rounded { border-radius: 6px; } .text-left { text-align: left; }
  .text-body { font-size: 14px; line-height: 20px; }
  .text-caption { font-size: 11px; line-height: 16px; }
  .bg-alpha-2 { background: rgba(0,0,0,0.06); } .font-medium { font-weight: 500; }
  .text-secondary { color: #555; } .text-primary { color: #111; } .text-muted { color: #888; }
  .opacity-60 { opacity: 0.6; }
${PAGE_CSS}
</style></head>
<body>
${fixture}
<pre id="cdb-results" hidden></pre>
<script>
window.__fixture = ${JSON.stringify(name)};
var results = [];
var diags = [];
function ok(cond, what) { results.push((cond ? "PASS " : "FAIL ") + what); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
// The control of a form row by its label, or null when the form has no such row.
function fieldControl(form, label) {
  var row = Array.from(form.querySelectorAll(".cdbx-models-field")).find(function (r) {
    var l = r.querySelector(".cdbx-id");
    return l && l.textContent === label;
  });
  return row ? row.querySelector(".cdbx-row-aside input") : null;
}
function sameClasses(a, b, ignore) {
  var skip = ignore || [];
  var norm = function (n) {
    return Array.prototype.slice.call(n.classList).filter(function (c) {
      return skip.indexOf(c) < 0;
    }).sort().join(" ");
  };
  return norm(a) === norm(b);
}
function stub(value) { return function () { return Promise.resolve(value); }; }
// A theme list shaped like the real projection: two of the entries carry
// category "gaming" (one of them a community palette, one a user theme), one
// has no category field at all - the pre-category registry case.
function theme(name, source, category) {
  var e = { name: name, displayName: name.charAt(0).toUpperCase() + name.slice(1),
            source: source, light: ["#111", "#eee"], dark: ["#eee", "#111"] };
  if (category !== undefined) e.category = category;
  return e;
}
window.__themes = [
  theme("nord", "builtin", ""),
  theme("catppuccin-mocha", "builtin", ""),
  theme("mario", "builtin", "gaming"),
  theme("zelda", "community", "gaming"),
  theme("my-neon", "custom", "gaming"),
  theme("solarized", "community", ""),
  theme("dracula", "community"),
  theme("my-own", "custom", ""),
  theme("almond", "community", ""),
  theme("mystery", "weird-tier", "")
];
// The deployment fixture: running 1P, a stored gateway configuration with a
// secret, and the catalog subset the panel renders from. Mirrors the projection
// cdb-deploy:read returns, secrets already replaced by the placeholder.
window.__deployCalls = [];
window.__revealCalls = [];
window.__panelTabsCalls = [];
window.__panelTabsState = { ok: true, enabled: false, lockedByJsonc: false, source: "default" };
window.__quickOpenCalls = [];
window.__quickOpenState = { ok: true, enabled: false, lockedByJsonc: false, source: "default" };
window.__diffViewsCalls = [];
window.__diffViewsState = { ok: true, enabled: false, source: "default", defaultEnabled: false,
  lockedByJsonc: false, key: "diffViewModes" };
// The theme picker switch is the one row that is ON unless the config says
// otherwise, so its fixture starts enabled with nothing on disk.
window.__pickerCalls = [];
window.__pickerState = { ok: true, enabled: true, lockedByJsonc: null };
// A flag catalog shaped like the real one: two plain switches and one
// value-carrying flag, which must render as a read-only chip instead.
window.__flagCalls = [];
window.__relaunchCalls = 0;
window.__flagCatalog = [
  { id: "1001", note: "Cowork sandbox sessions on the desktop", valueFlag: false, warn: "" },
  { id: "1002", note: "Imagine mode in the composer", valueFlag: false, warn: "" },
  { id: "1003", note: "Model routing weights", valueFlag: true, warn: "" }
];
window.__deployState = {
  ok: true,
  running: "1p",
  persisted: "1p",
  expected: "1p",
  source: "local",
  editable: true,
  locksSignIn: false,
  keepToken: "__cdb_unchanged__",
  paths: {
    userData: "/home/u/.config/Claude",
    threePDir: "/home/u/.config/Claude-3p",
    modeFile: "/home/u/.config/Claude-3p/claude_desktop_config.json",
    libDir: "/home/u/.config/Claude-3p/configLibrary",
    metaFile: "/home/u/.config/Claude-3p/configLibrary/_meta.json",
    etcFile: "/etc/claude-desktop/managed-settings.json"
  },
  managed: { present: false, usable: false, keys: [], provider: null, locksSignIn: false, error: "" },
  local: {
    present: true,
    appliedId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    entries: [{ id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", name: "Default" }],
    file: "/home/u/.config/Claude-3p/configLibrary/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.json",
    values: {
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "http://127.0.0.1:4000",
      inferenceGatewayApiKey: "__cdb_unchanged__",
      inferenceModels: ["claude-opus-4-8", { name: "claude-sonnet-4-6", labelOverride: "Sonnet" }]
    },
    unknown: [],
    selects3p: true
  },
  groups: [
    { key: "connection", label: "Inference & connection" },
    { key: "sandbox", label: "Surfaces, sandbox & tools" }
  ],
  keys: [
    { key: "inferenceProvider", kind: "enum", group: "connection", scope: "3p", label: "Inference provider",
      options: ["gateway", "vertex", "bedrock", "foundry", "anthropic"] },
    { key: "inferenceModels", kind: "models", group: "connection", scope: "3p", label: "Model list" },
    { key: "inferenceGatewayBaseUrl", kind: "text", group: "connection", scope: "3p", only: "gateway",
      label: "Gateway base URL" },
    { key: "inferenceGatewayApiKey", kind: "secret", group: "connection", scope: "3p", only: "gateway",
      label: "Gateway API key" },
    { key: "inferenceVertexProjectId", kind: "text", group: "connection", scope: "3p", only: "vertex",
      label: "GCP project ID" },
    { key: "chatTabEnabled", kind: "bool", group: "sandbox", scope: "3p", label: "Chat tab", dflt: false },
    { key: "disableDeploymentModeChooser", kind: "bool", group: "sandbox", scope: "3p",
      label: "Disable claude.ai sign-in", lock: "it overrides the switch above" }
  ]
};
window.claudeAppBindings = {};
// The overlay fixture: a matugen-style hidden template is merged over the
// active theme, and the user's own themes are the other candidates. setOverlay
// records the call and flips what overlay() answers next, like the engine.
window.__overlay = "wallpaper-accent";
window.__overlayCalls = [];
window.__overlays = [
  { name: "wallpaper-accent", displayName: "Wallpaper accent", hidden: true, source: "custom" },
  { name: "my-own", displayName: "My-own", hidden: false, source: "custom" },
  { name: "my-neon", displayName: "My-neon", hidden: false, source: "custom" }
];
// Computer Use on a background display: :0 is the own desktop (never probed),
// :97 a dead socket, :99 a supported Xvfb, wayland-weston unsupported.
window.__cubgBase = { ok: true, present: false, enabled: false, config: null, valid: true, error: null, envKeys: [],
  lockedByJsonc: null, source: "default", path: "/home/u/.config/Claude/claude-desktop-extra.json", own: { display: ":0", wayland: null } };
window.__cubgState = Object.assign({}, window.__cubgBase);
window.__cubgCalls = { set: [], thumb: [], probe: [], test: 0 };
window.__cubgProbe = function (k, d) {
  if (d === ":99") return { ok: true, kind: k, display: d, running: true, supported: true, reason: null,
    screens: [{ id: "screen", width: 1280, height: 800 }], size: { width: 1280, height: 800 }, windows: 2,
    wm: { present: true, name: "Xfwm4", via: "xprop" }, clipboard: { tool: "xclip" },
    restrictions: [{ id: "single-instance", text: "Firefox already runs on your desktop." }, { id: "teach", text: "Teach mode is not available on a background display." }] };
  if (d === ":66") return { ok: true, kind: k, display: d, running: true, supported: false,
    reason: "<img src=x onerror=\\"window.__xss=1\\">bridge said no", screens: [{ id: "<b>out</b>", width: 640, height: 480 }],
    size: { width: 640, height: 480 }, windows: 0, wm: { present: true, name: "<scr" + "ipt>window.__xss=2</scr" + "ipt>Evil WM" },
    restrictions: [{ id: "x", text: "<img src=y onerror=\\"window.__xss=3\\">restriction" }] };
  if (d === ":67") return { ok: true, kind: k, display: d, running: null, supported: null, busy: true,
    reason: "busy - too many checks at once, refresh in a moment", restrictions: [] };
  if (d === "wayland-weston") return { ok: true, kind: k, display: d, running: true, supported: false,
    reason: "the compositor does not offer zwlr_virtual_pointer_v1", screens: [{ id: "X", width: 800, height: 600 }],
    size: { width: 800, height: 600 }, windows: null, wm: { present: true, name: null }, restrictions: [] };
  return { ok: true, kind: k, display: d, running: false, supported: false, reason: "not running: Connection refused", restrictions: [] };
};
window.cdbExtra = {
  themesList: stub({ ok: true, entries: window.__themes, active: "mario",
    configPath: "/home/u/.config/Claude/claude-desktop-extra.jsonc",
    savePath: "/home/u/.config/Claude/claude-desktop-extra.json" }),
  themesApply: function () {
    return Promise.resolve({ ok: true, saved: "/home/u/.config/Claude/claude-desktop-extra.jsonc" });
  },
  themesOverlay: function () { return Promise.resolve({ ok: true, overlay: window.__overlay }); },
  themesOverlays: function () { return Promise.resolve({ ok: true, entries: window.__overlays }); },
  themesSetOverlay: function (name) {
    window.__overlayCalls.push(name);
    window.__overlay = name || null;
    return Promise.resolve({ ok: true, overlay: window.__overlay, changed: true,
      saved: "/home/u/.config/Claude/claude-desktop-extra.jsonc" });
  },
  flagsCatalog: function () {
    return Promise.resolve({ ok: true, count: window.__flagCatalog.length, entries: window.__flagCatalog });
  },
  flagsRead: stub({ ok: true, storeSeen: true,
    server: { "1002": { on: true, value: true }, "1003": { on: true, value: 3 } },
    effective: { "1002": { on: true, value: true }, "1003": { on: true, value: 3 } },
    overridesJson: {}, overridesJsonc: {}, builtins: {},
    paths: { json: "/home/u/.config/Claude/claude-desktop-extra.json",
             jsonc: "/home/u/.config/Claude/claude-desktop-extra.jsonc",
             userData: "/home/u/.config/Claude" } }),
  flagsSet: function (id, value) {
    window.__flagCalls.push(id + "=" + value);
    return Promise.resolve({ ok: true });
  },
  flagsUnset: stub({ ok: true }),
  appRelaunch: function () {
    window.__relaunchCalls++;
    return Promise.resolve({ ok: true });
  },
  panelTabsRead: function () { return Promise.resolve(window.__panelTabsState); },
  panelTabsSet: function (enabled) {
    window.__panelTabsCalls.push(enabled);
    return Promise.resolve({ ok: true, enabled: enabled, path: "/tmp/panel-tabs.json" });
  },
  quickOpenRead: function () { return Promise.resolve(window.__quickOpenState || { ok: true, enabled: false, lockedByJsonc: false, source: "default" }); },
  quickOpenSet: function (enabled) { window.__quickOpenCalls = (window.__quickOpenCalls || []).concat([enabled]); return Promise.resolve({ ok: true, enabled: enabled }); },
  // Custom models: the read carries the config summary the state line is built
  // from (how many models, from how many providers, which of them lack a key).
  customModelsRead: function () { return Promise.resolve(window.__customModelsState || { ok: true, enabled: false, configured: true, lockedByJsonc: false, source: "default", surfaces: ["code"], models: 2, providers: [{ id: "deepseek", models: 2, keyOk: true }] }); },
  customModelsSet: function (enabled) { window.__customModelsCalls = (window.__customModelsCalls || []).concat([enabled]); return Promise.resolve({ ok: true, enabled: enabled, configured: true, models: 2, providers: [{ id: "deepseek", models: 2, keyOk: true }] }); },
  // The Models panel: one editable provider with a model, one locked (.jsonc)
  // provider without a key. Writes are recorded and answered with the same
  // state, which is what the panel redraws from.
  customModelsConfig: function () { return Promise.resolve(window.__cmConfig); },
  customModelsProviderSet: function (p) { window.__cmProviderPayloads = (window.__cmProviderPayloads || []).concat([JSON.parse(JSON.stringify(p))]); window.__cmWrites =(window.__cmWrites || []).concat(["provider-set:" + p.id + ":" + p.baseUrl + ":" + (p.apiKey ? "key" : "nokey") + ":" + p.preset + ":" + p.modelsUrl + ":" + (p.effort ? p.effort.join("/") : "-")]); return Promise.resolve(window.__cmConfig); },
  customModelsModelsList: function (pid) { window.__cmWrites = (window.__cmWrites || []).concat(["list:" + pid]); return Promise.resolve(window.__cmModelsList || { ok: true, source: "https://api.deepseek.com/v1/models", models: [{ id: "deepseek-flash", name: "deepseek-flash" }, { id: "deepseek-v4-pro", name: "deepseek-v4-pro" }] }); },
  customModelsWebSearchSet: function (v) { window.__cmWrites = (window.__cmWrites || []).concat(["websearch-set:" + v]); return Promise.resolve(window.__cmConfig); },
  customModelsSmallFastSet: function (v) { window.__cmWrites = (window.__cmWrites || []).concat(["smallfast-set:" + v]); return Promise.resolve(window.__cmConfig); },
  customModelsProviderDelete: function (id) { window.__cmWrites = (window.__cmWrites || []).concat(["provider-delete:" + id]); return Promise.resolve(window.__cmConfig); },
  customModelsModelSet: function (pid, m) { window.__cmWrites = (window.__cmWrites || []).concat(["model-set:" + pid + ":" + m.id + ":" + m.name + ":" + m.thinking + ":" + m.vision + ":" + m.effortDefault + ":" + m.webSearch + (m.context ? ":" + m.context : "")]); if ("agent" in m) window.__cmWrites.push("model-agent:" + pid + ":" + m.id + ":" + m.agent + ":" + m.agentName + ":" + m.agentDescription + ":" + m.agentPrompt); return Promise.resolve(window.__cmConfig); },
  customModelsSubagentSet: function (v) { window.__cmWrites = (window.__cmWrites || []).concat(["subagent-set:" + v]); return Promise.resolve(window.__cmConfig); },
  customModelsAnnounceSet: function (v) { window.__cmWrites = (window.__cmWrites || []).concat(["announce-set:" + v]); return Promise.resolve(window.__cmConfig); },
  customModelsModelDelete: function (pid, mid) { window.__cmWrites = (window.__cmWrites || []).concat(["model-delete:" + pid + ":" + mid]); return Promise.resolve(window.__cmConfig); },
  customModelsTest: function (id) { window.__cmWrites = (window.__cmWrites || []).concat(["test:" + id]); return Promise.resolve({ ok: true, status: 200, model: "deepseek-flash" }); },
  customModelsEffortProbe: function (pid, mid) { window.__cmWrites = (window.__cmWrites || []).concat(["probe:" + pid + ":" + mid]); return Promise.resolve({ ok: true, accepted: ["low", "max"], rejected: { medium: "x", high: "x", xhigh: "x" } }); },
  // Load large sessions in full. Without these two the row is silently skipped
  // (renderToggleRow answers nothing when its bridge half is missing), so a
  // harness that omits them would pass while never rendering the row.
  transcriptLimitsRead: function () { return Promise.resolve(window.__tlState || { ok: true, enabled: false, lockedByJsonc: false, source: "default", mainMiB: 256, subagentMiB: 192, activeNow: false, activeMainMiB: null, activeSubagentMiB: null, pendingRestart: false }); },
  // Answers pendingRestart the way the main side does: owed while the saved
  // switch differs from what the running app was started with (activeNow).
  allowNonAnthropicModelsRead: function () { return Promise.resolve({ ok: true, enabled: false, activeNow: false, lockedByJsonc: false, source: "default" }); },
  allowNonAnthropicModelsSet: function (enabled) { return Promise.resolve({ ok: true, enabled: enabled, pendingRestart: enabled !== false }); },
  transcriptLimitsSet: function (enabled) {
    window.__tlCalls = (window.__tlCalls || []).concat([enabled]);
    var running = !!(window.__tlState && window.__tlState.activeNow);
    return Promise.resolve({ ok: true, enabled: enabled, pendingRestart: enabled !== running });
  },
  // The two window modes. Three fields the page treats as three different
  // facts, so a fixture that conflated any of them could not tell the states
  // apart: "enabled" is the SAVED setting, "active" what this window was built
  // with (null = no window existed when it was read), and "envForced" a
  // launcher flag that decides this run whatever is saved.
  windowControlsRead: function () { return Promise.resolve(window.__wcState || { ok: true, enabled: false, active: false, lockedByJsonc: false, source: "default", envForced: false }); },
  windowControlsSet: function (enabled) { window.__wcCalls = (window.__wcCalls || []).concat([enabled]); return Promise.resolve({ ok: true, enabled: enabled, path: "/tmp/window-controls.json" }); },
  nativeTitlebarRead: function () { return Promise.resolve(window.__ntState || { ok: true, enabled: false, active: false, lockedByJsonc: false, source: "default", envForced: false }); },
  nativeTitlebarSet: function (enabled) { window.__ntCalls = (window.__ntCalls || []).concat([enabled]); return Promise.resolve({ ok: true, enabled: enabled, path: "/tmp/window-controls.json" }); },
  // Transparent window: the switch plus the live transparency slider. "active"
  // is what this window was built with, the level* fields say who decides the
  // value (.jsonc lock, env variable, by name) so the slider can refuse.
  windowTransparencyRead: function () { return Promise.resolve(window.__wtState || { ok: true, enabled: false, active: false, level: 0.2, levelSource: "default", levelSetBy: "windowTransparencyLevel", levelLocked: false, levelEnvForced: false, lockedByJsonc: false, source: "default", envForced: false, nativeTitlebar: false }); },
  windowTransparencySet: function (enabled) { window.__wtCalls = (window.__wtCalls || []).concat([enabled]); return Promise.resolve({ ok: true, enabled: enabled, path: "/tmp/wt.json" }); },
  windowTransparencyLevelPreview: function (v) { window.__wtlPreview = (window.__wtlPreview || []).concat([v]); return Promise.resolve({ ok: true, level: v, live: 1 }); },
  windowTransparencyLevelSet: function (v) { window.__wtlSet = (window.__wtlSet || []).concat([v]); return Promise.resolve({ ok: true, level: v, path: "/tmp/wt.json" }); },
  diffViewsRead: function () { return Promise.resolve(window.__diffViewsState); },
  diffViewsSet: function (enabled) {
    window.__diffViewsCalls.push(enabled);
    return Promise.resolve({ ok: true, enabled: enabled, path: "/tmp/diff-views.json", nudged: true });
  },
  pickerRead: function () { return Promise.resolve(window.__pickerState); },
  pickerSet: function (enabled) {
    window.__pickerCalls.push(enabled);
    return Promise.resolve({ ok: true, enabled: enabled, path: "/tmp/picker.json" });
  },
  paths: stub({ ok: true, paths: {
    json: "/home/u/.config/Claude/claude-desktop-extra.json",
    jsonc: "/home/u/.config/Claude/claude-desktop-extra.jsonc",
    userData: "/home/u/.config/Claude" } }),
  deployRead: function () { return Promise.resolve(window.__deployState); },
  deployMode: function (mode) {
    window.__deployCalls.push("mode:" + mode);
    return Promise.resolve({ ok: true, mode: mode, expected: mode, path: "/tmp/claude_desktop_config.json" });
  },
  deploySet: function (key, value) {
    window.__deployCalls.push("set:" + key + "=" + JSON.stringify(value));
    return Promise.resolve({ ok: true, path: "/tmp/cfg.json", value: value });
  },
  deployClear: function () {
    window.__deployCalls.push("clear");
    return Promise.resolve({ ok: true, cleared: 4, expected: "1p" });
  },
  deployApply: function (id) {
    window.__deployCalls.push("apply:" + id);
    return Promise.resolve({ ok: true, appliedId: id, expected: "1p" });
  },
  deployRaw: stub({ ok: true, text: "{}", file: "/tmp/cfg.json", unknown: [], editable: true }),
  reveal: function (name, how) {
    window.__revealCalls.push(name + ":" + how);
    return Promise.resolve({ ok: true, opened: "/tmp/" + name, mode: how === "folder" ? "folder" : "file" });
  },
  deploySaveRaw: stub({ ok: true, path: "/tmp/cfg.json" }),
  cuBackgroundRead: function () { return Promise.resolve(window.__cubgState); },
  cuBackgroundSet: function (cfg) {
    window.__cubgCalls.set.push(JSON.stringify(cfg));
    if (cfg.display) window.__cubgState = Object.assign({}, window.__cubgState, { present: true, enabled: cfg.enabled,
      config: { enabled: cfg.enabled, kind: cfg.kind, display: cfg.display } });
    return Promise.resolve({ ok: true, config: window.__cubgState.config, valid: true, envDropped: false });
  },
  cuBackgroundCandidates: function () {
    return Promise.resolve({ ok: true, own: { display: ":0", wayland: null }, candidates: [
      { kind: "x11", display: ":0", own: true, selectable: false, label: "your desktop" },
      { kind: "x11", display: ":97", own: false, selectable: true, label: "X11 display :97" },
      { kind: "x11", display: ":66", own: false, selectable: true, label: "X11 display :66" },
      { kind: "x11", display: ":67", own: false, selectable: true, label: "X11 display :67" },
      { kind: "x11", display: ":99", own: false, selectable: true, label: "X11 display :99" },
      { kind: "wlroots", display: "wayland-weston", own: false, selectable: true, label: "Wayland socket wayland-weston" }] });
  },
  cuBackgroundProbe: function (k, d) { window.__cubgCalls.probe.push(d); return Promise.resolve(window.__cubgProbe(k, d)); },
  cuBackgroundThumbnail: function (k, d) {
    window.__cubgCalls.thumb.push(d);
    return Promise.resolve({ ok: true, dataUrl: "data:image/png;base64,iVBORw0KGgo=", width: 480, height: 300 });
  },
  cuBackgroundTest: function () {
    window.__cubgCalls.test++;
    return Promise.resolve({ ok: true, display: ":99", dataUrl: "data:image/png;base64,iVBORw0KGgo=", steps: [
      { name: "screens", ok: true, ms: 3, detail: "1280x800" }, { name: "screenshot", ok: true, ms: 30, detail: "1280x800" },
      { name: "pointer-move", ok: true, ms: 3, detail: "640,400<img src=z onerror=\\"window.__xss=4\\">" }] });
  },
  cuBackgroundTools: function () {
    return Promise.resolve({ ok: true, tools: { Xvfb: "/usr/bin/Xvfb", Xephyr: null, sway: "/usr/bin/sway", labwc: null,
      xfwm4: "/usr/bin/xfwm4", openbox: null, i3: null, x11vnc: null, wayvnc: null, xclip: "/usr/bin/xclip", xsel: null,
      "wl-copy": null, "wl-paste": null, xprop: "/usr/bin/xprop" } });
  },
  diag: function (m) { diags.push(String(m)); return Promise.resolve({ ok: true }); }
};
</script>
<script>
${name === "windows" ? 'Object.defineProperty(navigator, "platform", { get: function () { return "Win32"; } });' : ""}
</script>
<script>
// Exactly how the main process delivers it: the source as one evaluated string,
// whose value is the status line executeJavaScript() logs.
var __status = eval(${JSON.stringify(PAGE_JS)});
</script>
<script>
${DRIVER}
(async function () {
  await sleep(250);
  try { await run(); } catch (e) { results.push("FAIL driver threw: " + (e && e.stack || e)); }
  var pre = document.getElementById("cdb-results");
  pre.textContent = "CDB-BEGIN\\n" + results.join("\\n") + "\\nCDB-END";
  document.title = "done";
})();
</script>
</body></html>`;
}

// --- runner ----------------------------------------------------------------

if (!CHROMIUM) {
  console.error("no chromium/chrome binary found - pass --chromium PATH");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "cdb-extra-dom-"));
const scenarios = [
  ["real", FIXTURE_REAL(true, false)],
  ["real-classonly", FIXTURE_REAL(false, false)],
  ["real-ambiguous", FIXTURE_REAL(false, true)],
  ["real-nested", FIXTURE_REAL(true, false, true)],
  ["real-classonly-nested", FIXTURE_REAL(false, false, true)],
  ["es-testid", FIXTURE_ES(true)],
  ["es-labels", FIXTURE_ES(false)],
  ["no-headers", FIXTURE_NO_HEADERS],
  ["bare", FIXTURE_BARE],
  ["windows", FIXTURE_REAL(true, false)]
];

let pass = 0;
let fail = 0;
for (const [name, fixture] of scenarios) {
  const file = join(dir, name + ".html");
  writeFileSync(file, html(fixture, name), "utf8");
  let dump = "";
  try {
    // Virtual time, so the budget costs no wall clock: it only has to cover the
    // sum of the driver's sleep() calls in the longest scenario.
    // 15 s since the background-display setup page tests (issue #300).
    dump = execFileSync(CHROMIUM, [
      "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
      "--window-size=1000,700", "--virtual-time-budget=15000",
      "--dump-dom", "file://" + file
    ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    console.error(`[${name}] chromium failed: ${e.message}`);
    fail++;
    continue;
  }
  const m = dump.match(/CDB-BEGIN\n([\s\S]*?)\nCDB-END/);
  if (!m) {
    console.error(`[${name}] the page never reported results - the installer or the driver threw`);
    fail++;
    continue;
  }
  const lines = m[1].split("\n").filter(Boolean).map(unescapeHtml);
  let n = 0;
  for (const line of lines) {
    if (line.startsWith("PASS")) { pass++; n++; continue; }
    fail++;
    console.error(`[${name}] ${line}`);
  }
  console.log(`[${name}] ${n}/${lines.length} assertions passed`);
}

// --- source assertion: no nav metrics in our stylesheet --------------------
// The whole point of cloning is that upstream styles our nav. A font-size or a
// padding on our cloned header, list or rows would silently undo it, so the CSS
// is checked here rather than trusted.
{
  const banned = /(font-size|padding|line-height|font-weight|letter-spacing|text-transform)\s*:/;
  const rules = PAGE_CSS.replace(/\/\*[\s\S]*?\*\//g, "").split("}");
  const offenders = [];
  for (const rule of rules) {
    const i = rule.indexOf("{");
    if (i < 0) continue;
    const sel = rule.slice(0, i).trim();
    const body = rule.slice(i + 1);
    if (!/\.cdbx-(item|navgroup|navhdr|navlist)\b/.test(sel)) continue;
    if (/cdbx-navgroup-fb|cdbx-sel-fb/.test(sel)) continue; // fallback-only, ours by design
    const hit = body.match(banned);
    if (hit) offenders.push(`${sel} sets ${hit[1]}`);
  }
  if (offenders.length) {
    for (const o of offenders) console.error(`[css] our stylesheet overrides upstream nav metrics: ${o}`);
    fail += offenders.length;
  } else {
    console.log("[css] 1/1 assertions passed (no nav metrics set by our stylesheet)");
    pass++;
  }
}

if (KEEP) console.log(`fixtures kept in ${dir}`);
else rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
