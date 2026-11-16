#!/usr/bin/env node
/*
 * test-picker-gaming.mjs - headless-Chromium tests for the theme picker page
 * (js/theme_picker_page.html, delivered by patches/community/add_feature_theme_picker.nim), focused
 * on how it GROUPS themes: gaming palettes get their own separated section, chosen by the
 * theme's category rather than by which tier it came from.
 *
 * The page is used verbatim; only the bridge is a stub, shaped like the one the picker
 * patch exposes (list/active/apply/close over IPC). The fixtures are ours - deliberately
 * one gaming theme per source tier, which is the case the bucketing has to get right.
 *
 * Usage: node scripts/tests/community/test-picker-gaming.mjs [--png out.png] [--keep]
 *        (exit 3 = SKIP, 1 = FAIL)
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ROOT, Skip, findChromium, dumpDom, readProbe, reporter, runSuite } from "../lib/theme-engine-harness.mjs";

const argv = process.argv.slice(2);
const KEEP = argv.includes("--keep");
const PNG = argv.includes("--png") ? resolve(argv[argv.indexOf("--png") + 1]) : null;

const V = (bg, fg, ac) => ({ "--bg-000": bg, "--bg-100": bg, "--text-000": fg, "--accent-brand": ac });
// Entries spanning every source tier and category (custom, linux, gaming, common, lollipop).
const ENTRIES = [
  { name: "mine", displayName: "Mine", source: "custom", category: "", light: V("0 0% 100%", "0 0% 10%", "20 90% 50%"), dark: V("0 0% 8%", "0 0% 96%", "20 90% 60%") },
  { name: "arch-linux", displayName: "Arch Linux", source: "builtin", category: "linux", light: V("214 41% 96%", "212 29% 10%", "204 89% 38%"), dark: V("212 29% 9%", "212 43% 93%", "202 79% 57%") },
  { name: "my-arcade", displayName: "My Arcade", source: "custom", category: "gaming", light: V("0 0% 98%", "0 0% 10%", "300 90% 50%"), dark: V("0 0% 6%", "0 0% 96%", "300 90% 60%") },
  { name: "playstation", displayName: "PlayStation", source: "builtin", category: "gaming", light: V("0 0% 96%", "220 10% 12%", "220 60% 45%"), dark: V("220 8% 12%", "220 12% 92%", "220 70% 60%") },
  { name: "mario", displayName: "Mario", source: "builtin", category: "gaming", light: V("204 100% 96%", "222 66% 13%", "1 79% 49%"), dark: V("20 36% 11%", "40 60% 96%", "6 90% 44%") },
  { name: "nord", displayName: "Nord", source: "builtin", category: "", light: V("0 0% 100%", "220 16% 22%", "213 32% 48%"), dark: V("220 16% 22%", "218 27% 94%", "193 43% 68%") },
  { name: "dracula-ish", displayName: "Dracula-ish", source: "community", category: "", light: V("0 0% 100%", "0 0% 12%", "265 89% 78%"), dark: V("231 15% 18%", "60 30% 96%", "265 89% 78%") },
  { name: "retro-crt", displayName: "Retro CRT", source: "community", category: "gaming", light: V("0 0% 97%", "120 20% 12%", "120 80% 35%"), dark: V("120 10% 8%", "120 40% 90%", "120 90% 55%") },
  { name: "bfdi", displayName: "Battle for Dream Island", source: "builtin", category: "lollipop", light: V("196 58% 92%", "215 55% 14%", "207 80% 44%"), dark: V("215 54% 11%", "210 55% 94%", "25 95% 57%") },
  { name: "my-show", displayName: "My Show", source: "custom", category: "shows", light: V("0 0% 98%", "0 0% 12%", "280 80% 46%"), dark: V("280 40% 10%", "0 0% 94%", "280 90% 72%") },
];
const ACTIVE = "playstation";

await runSuite(async () => {
  const r = reporter("Theme picker: Gaming section (headless Chromium)");
  const chromium = findChromium();
  if (!chromium) throw new Skip("no chromium/chrome on this machine");

  const html = readFileSync(join(ROOT, "js/theme_picker_page.html"), "utf8");
  const out = mkdtempSync(join(tmpdir(), "cdb-picker-"));

  // The picker's own script runs at the end of <body>, so the bridge must exist before it.
  const bridge = `<script>
window.cdbThemes = {
  list: function () { return Promise.resolve({ ok: true, entries: ${JSON.stringify(ENTRIES)} }); },
  active: function () { return Promise.resolve({ ok: true, name: ${JSON.stringify(ACTIVE)} }); },
  apply: function () { return Promise.resolve({ ok: true, saved: "claude-desktop-extra.jsonc" }); },
  close: function () {}
};
</script>
<pre id="probe" style="position:fixed;left:-9999px"></pre>
`;
  const probe = `<script>
var lines = [];
function ok(c, label, extra) { lines.push((c ? "PASS " : "FAIL ") + label + (extra ? "  -> " + extra : "")); }
function $(id) { return document.getElementById(id); }
function names(gridId) {
  return [].slice.call(document.querySelectorAll("#" + gridId + " .card"))
    .map(function (c) { return c.dataset.name; }).join(",");
}
function check() {
  var order = [].slice.call(document.querySelectorAll("main > section")).map(function (s) { return s.id; });
  ok(order.join(" ") === "sec-stock sec-custom sec-linux sec-gaming sec-common sec-lollipop",
     "Sections run Stock, Your themes, Linux, Gaming, Common, then Lollipop at the end", order.join(" "));
  ok(names("grid-linux") === "arch-linux", "category=linux lands in Linux", names("grid-linux"));
  ok(names("grid-gaming") === "my-arcade,playstation,mario,retro-crt",
     "every category=gaming theme lands in Gaming whatever its source", names("grid-gaming"));
  ok(names("grid-custom") === "mine", "a non-gaming custom theme stays in Your themes", names("grid-custom"));
  ok(names("grid-common") === "nord,dracula-ish",
     "the non-gaming built-in and community palettes share Common", names("grid-common"));
  ok(names("grid-lollipop") === "bfdi,my-show",
     "category=lollipop and shows land in Lollipop at the very end", names("grid-lollipop"));
  ok($("count-linux").textContent === "1", "the Linux badge counts 1", $("count-linux").textContent);
  ok($("count-gaming").textContent === "4", "the Gaming badge counts 4", $("count-gaming").textContent);
  ok($("count-lollipop").textContent === "2", "the Lollipop badge counts 2", $("count-lollipop").textContent);
  var sec = $("sec-gaming");
  ok(!sec.hidden, "the Gaming section is visible");
  ok(sec.querySelector(".eyebrow").textContent.indexOf("Gaming") === 0 &&
     sec.querySelector(".eyebrow").textContent.indexOf("Shows") < 0, "Gaming uses its clean Gaming heading",
     sec.querySelector(".eyebrow").textContent.trim());
  ok($("sec-linux").querySelector(".eyebrow").textContent.indexOf("Linux") === 0, "Linux has its own heading");
  ok($("sec-lollipop").querySelector(".eyebrow").textContent.indexOf("Lollipop") === 0, "Lollipop has its own heading");
  var cs = getComputedStyle(sec);
  ok(cs.borderTopStyle === "solid" && parseFloat(cs.borderTopWidth) >= 1 &&
     getComputedStyle($("sec-linux")).borderTopStyle === "solid" &&
     getComputedStyle($("sec-lollipop")).borderTopStyle === "solid",
     "split sections carry the horizontal divider that sets them apart",
     cs.borderTopWidth + " " + cs.borderTopStyle + " " + cs.borderTopColor);
  ok(getComputedStyle($("sec-common")).borderTopStyle === "none",
     "no stray divider on the other sections");
  var pressed = [].slice.call(document.querySelectorAll('.card[aria-pressed="true"]'))
    .map(function (c) { return c.dataset.name; });
  ok(pressed.join(",") === ${JSON.stringify(ACTIVE)},
     "the active theme is still marked in its new section", pressed.join(","));

  var s = $("search");
  s.value = "linux"; s.dispatchEvent(new Event("input"));
  ok($("count-linux").textContent === "1" && $("sec-gaming").hidden && $("sec-common").hidden && $("sec-lollipop").hidden,
     'filtering by "linux" leaves only the Linux section',
     "linux=" + $("count-linux").textContent);
  s.value = "gaming"; s.dispatchEvent(new Event("input"));
  ok($("count-gaming").textContent === "4" && $("sec-common").hidden && $("sec-custom").hidden && $("sec-lollipop").hidden,
     'filtering by "gaming" leaves only the Gaming section',
     "gaming=" + $("count-gaming").textContent);
  s.value = "lollipop"; s.dispatchEvent(new Event("input"));
  ok($("count-lollipop").textContent === "2" && $("sec-common").hidden && $("sec-gaming").hidden && $("sec-linux").hidden,
     'filtering by "lollipop" leaves only the Lollipop section',
     "lollipop=" + $("count-lollipop").textContent);
  s.value = "shows"; s.dispatchEvent(new Event("input"));
  ok($("count-lollipop").textContent === "2" && $("sec-common").hidden && $("sec-gaming").hidden,
     'filtering by "shows" matches the Lollipop section',
     "shows=" + $("count-lollipop").textContent);
  s.value = "nord"; s.dispatchEvent(new Event("input"));
  ok($("sec-gaming").hidden && !$("sec-common").hidden, "an unrelated filter hides Gaming again");
  s.value = ""; s.dispatchEvent(new Event("input"));
  ok($("count-gaming").textContent === "4" && !$("sec-gaming").hidden && !$("sec-linux").hidden && !$("sec-lollipop").hidden,
     "clearing the filter brings all sections back");
  ok($("tally").textContent === "${ENTRIES.length} palettes", "the tally still counts every palette",
     $("tally").textContent);
  var footer = document.querySelector("footer").textContent;
  ok(footer.indexOf("next start") < 0 && /spinner shape switches with the theme/.test(footer),
     "the footer no longer claims the spinner needs a restart");
  $("probe").textContent = lines.join("\\n");
}
// The page renders from a promise; poll for the cards instead of guessing a delay.
function waitFor(cond, next, tries) {
  tries = (tries === undefined) ? 40 : tries;
  if (cond() || tries <= 0) { next(); return; }
  setTimeout(function () { waitFor(cond, next, tries - 1); }, 25);
}
window.addEventListener("load", function () {
  waitFor(function () { return document.querySelectorAll(".card").length > 0; }, check);
});
</script>`;
  const pagePath = join(out, "picker.html");
  writeFileSync(pagePath, html.replace("<body>", "<body>" + bridge).replace("</body>", probe + "</body>"));

  const dom = dumpDom(chromium, pagePath, ["--window-size=1100,900"]);
  if (PNG) {
    execFileSync(chromium, [
      "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
      "--window-size=1100,1000", "--virtual-time-budget=5000", "--screenshot=" + PNG,
      "file://" + pagePath,
    ], { stdio: "ignore" });
  }

  const lines = readProbe(dom, "probe");
  if (!lines) {
    console.log("  FAIL  the page never wrote its results");
    console.log(dom.slice(0, 2000));
    process.exit(1);
  }
  r.lines(lines);
  if (PNG) r.note("screenshot: " + PNG);
  if (KEEP) r.note("page kept at " + pagePath);
  else rmSync(out, { recursive: true, force: true });
  r.done();
});
