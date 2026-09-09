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

function item(label, opts = {}) {
  const cls = ROW_BASE + " " + (opts.selected ? ROW_ON : ROW_OFF) + (opts.badge ? " opacity-60" : "");
  const cur = opts.selected && opts.attr ? ' aria-current="page"' : "";
  const key = opts.key || slug(label);
  return `<li data-testid="${key}-settings"><button type="button" id="row-${key}"${cur} ` +
    `class="${cls}">${icon()}<span class="${LABEL_CLS}">${label}</span></button></li>`;
}

// A group is a header div and a list, as PLAIN SIBLINGS. There is no wrapper
// element around them - that is the fact the injection got wrong.
function group(header, items) {
  return `<div class="${HDR_CLS}">${header}</div>
      <ul class="${LIST_CLS}">${items.join("")}</ul>`;
}

function dialog(navInner) {
  return `
<div role="dialog" tabindex="-1" data-cds="Dialog" class="dialog" aria-labelledby="ttl">
  <nav aria-label="Settings" class="navcol">
    <h2 id="ttl" class="sr-only">Settings</h2>
    <div class="shrink-0 px-md pt-md"><input type="search" placeholder="Search settings"></div>
    <div id="navbox" class="navbox">${navInner}</div>
  </nav>
  <div id="pane" class="pane">
    <div class="panehead"><button type="button" id="close-btn">close</button></div>
    <div id="panebody" class="panebody">upstream settings sections</div>
  </div>
</div>`;
}

// Scenario 1-3: the real shape. `attr` puts aria-current="page" on the selected
// button as the capture does; without it only the class swap is left, which is
// the harder path. `ambiguous` makes a second row deviate from the shared class
// shape, so no selected row can be identified at all.
const FIXTURE_REAL = (attr, ambiguous) => dialog(`
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
      <a id="row-org" href="/admin-settings/organization" class="orglink">${icon()}<span class="${LABEL_CLS}">Organization</span>${icon("text-muted")}</a>`);

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
var LABELS = ["Themes", "Community", "Anthropic", "Deployment"];
// Upstream's nav column is narrow and truncates, so the two long names are
// shortened there and carried in a tooltip instead. The panels keep the full
// name in their h1 - asserted in featuresPanel()/flagsPanel() below.
var TOOLTIPS = { Community: "Community Features", Anthropic: "Anthropic Features" };

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

// Community Features: only our own switches, all of them live, plus the filter
// bar over them. Nothing that needs a restart may appear here - that notice and
// Anthropic's flag list moved to their own panel, asserted below.
async function featuresPanel(featuresItem) {
  featuresItem.click();
  await sleep(120);
  const panel = document.querySelector(".cdbx-panel");
  ok(!!panel, "the Community Features panel is mounted");
  if (!panel) return;
  ok(panel.querySelector(".cdbx-h1").textContent === "Community Features",
     "the heading spells the full name out even though the nav row says Community: " +
     panel.querySelector(".cdbx-h1").textContent);
  ok(!panel.querySelector(".cdbx-notice"),
     "no restart notice here - every switch in this panel applies live");
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

  const glow = panel.querySelector(".cdbx-switch[aria-label='calm the Cowork glow']");
  ok(!!glow, "the Cowork glow switch renders in the Community Features panel");
  if (glow) {
    ok(glow.getAttribute("aria-checked") === "false", "the glow switch reflects mode 'pulse'");
    ok(!glow.disabled, "the glow switch is enabled when the .jsonc does not set it");
    glow.click();
    await sleep(60);
    ok(glow.getAttribute("aria-checked") === "true", "clicking the glow switch turns it on");
  }

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

  // This panel carries no restart notice, so every row has to say for itself
  // that it needs no restart - verified per feature against the code that
  // consumes each pref, see the comment above renderFeatures.
  const notes = Array.from(panel.querySelectorAll(".cdbx-row .cdbx-note"));
  ok(notes.length > 0 && notes.every(function (n) {
       return n.textContent.toLowerCase().indexOf("applies live") >= 0;
     }),
     "every row's note says it applies live (" + notes.length + " rows): " +
     notes.filter(function (n) { return n.textContent.toLowerCase().indexOf("applies live") < 0; })
       .map(function (n) { return n.closest(".cdbx-row").querySelector(".cdbx-id").textContent; })
       .join(",") || "all of them");

  // --- the filter bar. Rows are HIDDEN, never re-rendered: a redraw would
  // re-fire every row's async read and lose the state the user just set.
  const box = panel.querySelector(".cdbx-search");
  ok(!!box, "the panel has a filter bar");
  if (box) {
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

    await type("motion");
    ok(visible().join(",") === "Motion", "so does a section match: " + visible().join(","));

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
  window.__pickerState = { ok: true, enabled: true, lockedByJsonc: null };
}

// Anthropic Features: everything that used to sit below our own switches -
// Anthropic's GrowthBook flags, the restart notice they need, the filter over
// them and the one config file the panel links.
async function flagsPanel(flagsItem) {
  flagsItem.click();
  await sleep(140);
  const panel = document.querySelector(".cdbx-panel");
  ok(!!panel, "the Anthropic Features panel is mounted");
  if (!panel) return;
  ok(panel.querySelector(".cdbx-h1").textContent === "Anthropic Features",
     "the heading spells the full name out even though the nav row says Anthropic: " +
     panel.querySelector(".cdbx-h1").textContent);
  ok(!panel.querySelector(".cdbx-switch[aria-label='calm the Cowork glow']"),
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
  ok(!document.querySelector(".cdbx-panel .cdbx-switch[aria-label='calm the Cowork glow']"),
     "the Cowork glow switch is NOT in the Themes panel");

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
  ok(panel.parentElement === document.getElementById("pane"),
     "our panel is a sibling of the pane's scrolling body");
  const box = panel.getBoundingClientRect();
  ok(box.height > 100 && box.height <= 600,
     "our panel fits inside the dialog instead of stretching it (" + box.height + ")");
}

async function run() {
  const kind = window.__fixture;
  const real = kind.indexOf("real") === 0;
  const items = ourItems();
  const box = navbox();

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
    ok(shape.length <= 300, "the shape diagnostic fits the diag channel (" + shape.length + ")");
    ok(diags.some(function (d) { return d.indexOf("cloned from") >= 0; }),
       "the install line reports the clone path");
    ok(!diags.some(function (d) { return d.indexOf("carries no") >= 0; }),
       "no icon complaint for a nav that has icon boxes");

    if (kind === "real") {
      await themesPanel(items[0]);
      await featuresPanel(items[1]);
      await flagsPanel(items[2]);
      await deployPanel(items[3]);
    }
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
    ok(diags.some(function (d) { return d.indexOf("no known group header text") >= 0; }),
       "and it says which anchor was missing");

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
      inferenceModels: ["claude-opus-4-8", "claude-sonnet-4-6"]
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
  glowRead: stub({ ok: true, mode: "pulse", opacity: 0.55, defaultOpacity: 0.55, lockedByJsonc: null }),
  glowSet: stub({ ok: true, mode: "calm", windows: 1, path: "/tmp/x.json" }),
  panelTabsRead: function () { return Promise.resolve(window.__panelTabsState); },
  panelTabsSet: function (enabled) {
    window.__panelTabsCalls.push(enabled);
    return Promise.resolve({ ok: true, enabled: enabled, path: "/tmp/panel-tabs.json" });
  },
  quickOpenRead: function () { return Promise.resolve(window.__quickOpenState || { ok: true, enabled: false, lockedByJsonc: false, source: "default" }); },
  quickOpenSet: function (enabled) { window.__quickOpenCalls = (window.__quickOpenCalls || []).concat([enabled]); return Promise.resolve({ ok: true, enabled: enabled }); },
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
  diag: function (m) { diags.push(String(m)); return Promise.resolve({ ok: true }); }
};
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
  ["no-headers", FIXTURE_NO_HEADERS],
  ["bare", FIXTURE_BARE]
];

let pass = 0;
let fail = 0;
for (const [name, fixture] of scenarios) {
  const file = join(dir, name + ".html");
  writeFileSync(file, html(fixture, name), "utf8");
  let dump = "";
  try {
    dump = execFileSync(CHROMIUM, [
      "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
      "--window-size=1000,700", "--virtual-time-budget=6000",
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
