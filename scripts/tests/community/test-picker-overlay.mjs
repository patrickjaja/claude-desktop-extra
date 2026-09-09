#!/usr/bin/env node
/*
 * test-picker-overlay.mjs - headless-Chromium tests for the theme picker page's
 * OVERLAY bar (js/theme_picker_page.html, delivered by
 * patches/community/add_feature_theme_picker.nim).
 *
 * `themeOverlay` merges one theme's tokens over whatever theme is picked, which the
 * grid alone cannot show: the picked card looks active while something else
 * recolors the app. The page therefore carries a bar between the header and the
 * sections, and the active card a badge. Pinned here:
 *   - overlay active   -> bar names it, offers "Turn off", active card says "overlay"
 *   - Turn off         -> the bar switches to the select + Apply form, badge gone
 *   - pick + Apply     -> back to the active form with the new name
 *   - nothing active and nothing to pick -> no bar at all
 *   - a bridge WITHOUT the overlay calls (older preload, or the gaming harness's
 *     stub) -> no bar, and the page still renders
 * plus two source assertions: the preload exposes the three calls and the patch
 * registers the three channels they invoke.
 *
 * The page is used verbatim; only the bridge is a stub with mutable state.
 *
 * Usage: node scripts/tests/community/test-picker-overlay.mjs [--keep]
 *        (exit 3 = SKIP, 1 = FAIL)
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, Skip, findChromium, dumpDom, readProbe, reporter, runSuite } from "../lib/theme-engine-harness.mjs";

const argv = process.argv.slice(2);
const KEEP = argv.includes("--keep");

const V = (bg, fg, ac) => ({ "--bg-000": bg, "--bg-100": bg, "--text-000": fg, "--accent-brand": ac });
const ENTRIES = [
  { name: "mario", displayName: "Mario", source: "builtin", category: "gaming", light: V("204 100% 96%", "222 66% 13%", "1 79% 49%"), dark: V("20 36% 11%", "40 60% 96%", "6 90% 44%") },
  { name: "nord", displayName: "Nord", source: "builtin", category: "", light: V("0 0% 100%", "220 16% 22%", "213 32% 48%"), dark: V("220 16% 22%", "218 27% 94%", "193 43% 68%") },
  { name: "mine", displayName: "Mine", source: "custom", category: "", light: V("0 0% 100%", "0 0% 10%", "20 90% 50%"), dark: V("0 0% 8%", "0 0% 96%", "20 90% 60%") },
];
// What __cdbThemes.overlays() answers: user/generator themes, hidden first. The
// hidden one is the matugen template, which the grid never lists.
const OVERLAYS = [
  { name: "wallpaper-accent", displayName: "Wallpaper accent", hidden: true, source: "custom" },
  { name: "mine", displayName: "Mine", hidden: false, source: "custom" },
];
const ACTIVE = "mario";

// One bridge, mutable: setOverlay() records the call and flips what overlay()
// answers next, exactly like the engine.
function bridge(overlay, overlays, withOverlayApi) {
  return `<script>
window.__setCalls = [];
window.__overlay = ${JSON.stringify(overlay)};
window.cdbThemes = {
  list: function () { return Promise.resolve({ ok: true, entries: ${JSON.stringify(ENTRIES)} }); },
  active: function () { return Promise.resolve({ ok: true, name: ${JSON.stringify(ACTIVE)} }); },
  apply: function () { return Promise.resolve({ ok: true, saved: "claude-desktop-extra.jsonc" }); },
  close: function () {}
};
${withOverlayApi ? `
window.cdbThemes.overlay = function () { return Promise.resolve({ ok: true, overlay: window.__overlay }); };
window.cdbThemes.overlays = function () { return Promise.resolve({ ok: true, entries: ${JSON.stringify(overlays)} }); };
window.cdbThemes.setOverlay = function (name) {
  window.__setCalls.push(name);
  window.__overlay = name || null;
  return Promise.resolve({ ok: true, overlay: window.__overlay, changed: true, saved: "claude-desktop-extra.jsonc" });
};` : ""}
</script>
<pre id="probe" style="position:fixed;left:-9999px"></pre>
`;
}

const PROBE_HEAD = `<script>
var lines = [];
function ok(c, label, extra) { lines.push((c ? "PASS " : "FAIL ") + label + (extra ? "  -> " + extra : "")); }
function $(id) { return document.getElementById(id); }
function activeCard() { return document.querySelector('.card[aria-pressed="true"]'); }
function badgeShown() {
  var c = activeCard();
  var b = c && c.querySelector(".card-ov");
  return !!b && getComputedStyle(b).display !== "none";
}
function waitFor(cond, next, tries) {
  tries = (tries === undefined) ? 60 : tries;
  if (cond() || tries <= 0) { next(); return; }
  setTimeout(function () { waitFor(cond, next, tries - 1); }, 25);
}
function finish() { $("probe").textContent = lines.join("\\n"); }
`;

// Scenario A: an overlay is active, then it is turned off, then another is applied.
const PROBE_FLOW = PROBE_HEAD + `
function stepActive() {
  var bar = $("overlay-bar");
  ok(!bar.hidden, "the bar is shown while an overlay is active");
  ok(bar.querySelector(".overlay-k") && bar.querySelector(".overlay-k").textContent === "Overlay", "it is labelled Overlay");
  ok(bar.querySelector(".overlay-name") && bar.querySelector(".overlay-name").textContent === "Wallpaper accent",
     "it names the overlay by display name, resolved from overlays() even though the grid never lists a hidden theme",
     bar.querySelector(".overlay-name") && bar.querySelector(".overlay-name").textContent);
  ok(/merges its colors over every theme you pick/.test(bar.textContent), "it says what the overlay does");
  ok(!!$("overlay-off") && $("overlay-off").textContent === "Turn off", "it offers Turn off");
  ok(!$("overlay-pick"), "no select while one is active");
  ok(activeCard() && activeCard().dataset.name === "mario", "the picked theme is still the active card");
  ok(badgeShown(), "the active card carries the overlay badge");
  ok(activeCard().querySelector(".card-ov").textContent === "overlay", "the badge reads overlay");
  var others = [].slice.call(document.querySelectorAll('.card[aria-pressed="false"] .card-ov'))
    .filter(function (b) { return getComputedStyle(b).display !== "none"; });
  ok(others.length === 0, "no other card shows the badge");
  ok(document.querySelector("main > section").id === "sec-stock" && $("overlay-bar").nextElementSibling === $("main"),
     "the bar sits between the header and the sections");
  $("overlay-off").click();
  waitFor(function () { return !!$("overlay-pick"); }, stepOff);
}
function stepOff() {
  var bar = $("overlay-bar");
  ok(window.__setCalls.join(",") === "", 'Turn off called setOverlay("")', JSON.stringify(window.__setCalls));
  ok(!bar.hidden, "the bar stays, now as the picker form, because there are candidates");
  var sel = $("overlay-pick");
  ok(!!sel, "it has a select");
  var opts = sel ? [].slice.call(sel.options).map(function (o) { return o.value + "=" + o.textContent; }).join("|") : "";
  ok(opts === "=none|wallpaper-accent=Wallpaper accent|mine=Mine",
     "the select lists none first, then every candidate in engine order (hidden first)", opts);
  ok(!!$("overlay-apply") && $("overlay-apply").textContent === "Apply", "it offers Apply");
  ok($("overlay-apply").disabled, "Apply is disabled while none is selected");
  ok(!$("overlay-off"), "no Turn off while nothing is active");
  ok(!badgeShown(), "the badge left the active card");
  ok(activeCard() && activeCard().dataset.name === "mario", "the picked theme did not change");
  sel.value = "mine";
  sel.dispatchEvent(new Event("change"));
  ok(!$("overlay-apply").disabled, "choosing a candidate enables Apply");
  $("overlay-apply").click();
  waitFor(function () { return !!$("overlay-off"); }, stepReapplied);
}
function stepReapplied() {
  ok(window.__setCalls.join(",") === ",mine", "Apply called setOverlay with the chosen name", JSON.stringify(window.__setCalls));
  var name = $("overlay-bar").querySelector(".overlay-name");
  ok(!!name && name.textContent === "Mine", "the bar now names the new overlay", name && name.textContent);
  ok(badgeShown(), "the badge is back on the active card");
  ok($("toast").textContent.indexOf("Overlay Mine on") === 0, "the toast confirms it", $("toast").textContent);
  finish();
}
window.addEventListener("load", function () {
  waitFor(function () { return document.querySelectorAll(".card").length > 0 && !$("overlay-bar").hidden; }, stepActive);
});
</script>`;

// Scenario B: nothing active, nothing to pick -> no bar.
const PROBE_EMPTY = PROBE_HEAD + `
window.addEventListener("load", function () {
  waitFor(function () { return document.querySelectorAll(".card").length > 0; }, function () {
    var bar = $("overlay-bar");
    ok(!!bar && bar.hidden, "no bar when nothing is active and nothing could be");
    ok(bar.childNodes.length === 0, "and it is empty");
    ok(!badgeShown(), "no badge on the active card");
    ok(activeCard() && activeCard().dataset.name === "mario", "the grid rendered normally");
    finish();
  });
});
</script>`;

// Scenario C: a bridge without the overlay calls -> no bar, page still works.
const PROBE_NOAPI = PROBE_HEAD + `
window.addEventListener("load", function () {
  waitFor(function () { return document.querySelectorAll(".card").length > 0; }, function () {
    ok($("overlay-bar").hidden, "a bridge without overlay()/overlays()/setOverlay() draws no bar");
    ok(document.querySelectorAll(".card").length === ${ENTRIES.length + 1}, "every card still renders", String(document.querySelectorAll(".card").length));
    ok(activeCard() && activeCard().dataset.name === "mario", "the active card is still marked");
    ok(!badgeShown(), "no badge without an overlay");
    finish();
  });
});
</script>`;

await runSuite(async () => {
  const r = reporter("Theme picker: overlay bar (headless Chromium)");
  const chromium = findChromium();
  if (!chromium) throw new Skip("no chromium/chrome on this machine");

  const html = readFileSync(join(ROOT, "js/theme_picker_page.html"), "utf8");
  const out = mkdtempSync(join(tmpdir(), "cdb-picker-ov-"));

  const scenarios = [
    ["active-then-off-then-apply", bridge("wallpaper-accent", OVERLAYS, true), PROBE_FLOW],
    ["nothing-to-show", bridge(null, [], true), PROBE_EMPTY],
    ["bridge-without-overlay-api", bridge(null, [], false), PROBE_NOAPI],
  ];
  for (const [name, br, probe] of scenarios) {
    r.section(name);
    const pagePath = join(out, name + ".html");
    writeFileSync(pagePath, html.replace("<body>", "<body>" + br).replace("</body>", probe + "</body>"));
    const dom = dumpDom(chromium, pagePath, ["--window-size=1100,900"]);
    const lines = readProbe(dom, "probe");
    if (!lines || lines.length === 1 && lines[0] === "") {
      r.ok(false, "the page never wrote its results");
      console.log(dom.slice(0, 2000));
      continue;
    }
    r.lines(lines);
  }

  // Source assertions: the bridge and the channels the page relies on.
  r.section("preload + patch");
  const preload = readFileSync(join(ROOT, "js/theme_picker_preload.js"), "utf8");
  const patch = readFileSync(join(ROOT, "patches/community/add_feature_theme_picker.nim"), "utf8");
  for (const [fn, ch] of [["overlay", "cdb-themes:overlay"], ["overlays", "cdb-themes:overlays"], ["setOverlay", "cdb-themes:set-overlay"]]) {
    r.ok(new RegExp("\\b" + fn + ": function").test(preload) && preload.includes('"' + ch + '"'),
         "the preload exposes " + fn + "() over " + ch);
    r.ok(patch.includes('"' + ch + '":function'), "the patch registers the " + ch + " handler");
  }
  r.ok(patch.includes('"not supported by this build"'), "the patch guards an engine without overlay support");
  r.ok(patch.includes('"\\"cdb-themes:set-overlay\\""'), "set-overlay is an end-state marker of the patch");

  if (KEEP) r.note("pages kept at " + out);
  else rmSync(out, { recursive: true, force: true });
  r.done();
});
