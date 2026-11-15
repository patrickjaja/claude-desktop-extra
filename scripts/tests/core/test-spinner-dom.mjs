#!/usr/bin/env node
/*
 * test-spinner-dom.mjs - headless-Chromium tests for the live spinner engine
 * (js/spinner_injector.js), driven exactly the way the main process drives it: the file
 * is re-evaluated with a fresh __CDB_SPINNER_SPEC on every theme switch.
 *
 * What only a real browser can settle: that a SECOND spec actually reshapes a glyph the
 * engine already swapped (the frozen-until-restart bug), that reverting puts Claude's own
 * markup back well enough for the matcher to find the star again, and that the flip
 * frames resolve to the steps() keyframes the theme sheet ships. So the stylesheet here
 * is not a copy - it is captured from the real engine through insertCSS().
 *
 * The page writes its own PASS/FAIL lines into <pre id="out">, which this script reads
 * back out of the dumped DOM.
 *
 * Usage: node scripts/tests/core/test-spinner-dom.mjs [--keep]     (exit 3 = SKIP, 1 = FAIL)
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ROOT, Skip, installEngine, mkWc, settle, findChromium, dumpDom, readProbe, reporter, runSuite,
} from "../lib/theme-engine-harness.mjs";

const KEEP = process.argv.includes("--keep");

// Fixture geometry: a fragment of the real Anthropic 7-point star (what the matcher keys
// off), plus a decoy icon in the same 0 0 100 100 box that must never be reshaped.
const STAR_D = "M50 2.5 66.5 33.5 m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-10.4-.3-9-.5-6.4-.5Z";
const DECOY_D = "M10 10 H90 V90 H10 Z";

const SPIN = { viewBox: "0 0 100 100", animation: "spin", paths: [{ d: "M50 10 L55 90 Z" }] };
const BOUNCE = {
  viewBox: "0 0 100 100", animation: "bounce",
  paths: [{ d: "M50 14c-19 0-34 13-34 31Z", fill: "#E52521" }, { d: "M30 56h40v16Z", fill: "#FAD9C0" }],
};
const FLIP = {
  viewBox: "0 0 100 100", animation: "flip",
  paths: [{ d: "M20 20h60v60H20Z" }],
  paths2: [{ d: "M30 30h40v40H30Z", fill: "#00ff00" }],
};

await runSuite(async () => {
  const r = reporter("Spinner engine (headless Chromium)");
  const chromium = findChromium();
  if (!chromium) throw new Skip("no chromium/chrome on this machine");

  // --- capture the REAL stylesheet the engine inserts ----------------------
  const { themes: T, appEvents } = installEngine({
    config: { activeTheme: "", themes: { harness: { light: { "--bg-000": "0 0% 100%" }, dark: { "--bg-000": "0 0% 4%" } } } },
  });
  T.apply("harness");
  const wc = mkWc();
  appEvents["web-contents-created"]({}, wc);
  wc.fire("dom-ready");
  await settle();
  const sheet = wc.sheet();
  if (!sheet || sheet.indexOf("@keyframes cdbFlipA") < 0) {
    throw new Error("could not capture a stylesheet carrying the spinner keyframes");
  }

  const INJECTOR = readFileSync(join(ROOT, "js/spinner_injector.js"), "utf8");
  const BD_INJECTOR = readFileSync(join(ROOT, "js/backdrop_injector.js"), "utf8");
  r.ok(!/\?\?/.test(BD_INJECTOR), "backdrop_injector.js is strict ES5 (no nullish coalescing '??')");
  r.ok(/\.cdb-anim-spin[^}]*transform-box:\s*view-box/.test(sheet),
     "captured sheet sets transform-box: view-box on .cdb-anim-spin");
  r.ok(/prefers-reduced-motion:\s*reduce[\s\S]*data-cdb-frame="2"/.test(sheet),
     "captured sheet hides frame 2 of flip spinners under prefers-reduced-motion: reduce");
  r.ok(/data-engine-glass-unsuited[\s\S]*\/\s*0\.48/.test(sheet),
     "captured sheet uses lighter 0.48 unsuited glass veil");
  r.ok(/\.cdb-flank-l/.test(sheet) && /\.cdb-flank-r/.test(sheet) && /\.cdb-flank-rt/.test(sheet),
     "captured sheet ships responsive .cdb-flank-* rules");

  const out = mkdtempSync(join(tmpdir(), "cdb-spinner-dom-"));
  const FLANK_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">' +
    '<rect x="-800" y="0" width="3200" height="1000" fill="#102030"/>' +
    '<g class="cdb-flank-l"><rect id="fl-box" x="24" y="820" width="120" height="160" fill="#ff0"/></g>' +
    '<g class="cdb-flank-r"><rect id="fr-box" x="1460" y="820" width="120" height="160" fill="#0ff"/></g>' +
    '<g class="cdb-flank-rt"><rect id="frt-box" x="1420" y="62" width="140" height="44" fill="#f0f"/></g>' +
    "</svg>";
  const UPSTREAM_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">' +
    '<rect width="1600" height="1000" fill="#0a1430"/>' +
    "</svg>";
  const page = `<!doctype html>
<meta charset="utf-8">
<style>${sheet}</style>
<div id="app">
  <div class="greeting"><svg viewBox="0 0 100 100" class="fill-current"><path d="${STAR_D}"/></svg></div>
  <div class="thinking"><svg viewBox="0 0 100 100" class="fill-current"><path d="${STAR_D}"/></svg></div>
  <div class="decoy"><svg viewBox="0 0 100 100"><path d="${DECOY_D}"/></svg></div>
</div>
<div class="dframe-root" id="bd-root" style="position:relative;width:960px;height:720px;overflow:hidden">
  <aside class="dframe-sidebar" id="bd-sb" style="position:absolute;left:0;top:0;bottom:0;width:216px;z-index:10"></aside>
  <div class="dframe-content" id="bd-host" style="position:absolute;inset:0;overflow:hidden"></div>
</div>
<pre id="out"></pre>
<script>
var SRC = ${JSON.stringify(INJECTOR)};
var BD_SRC = ${JSON.stringify(BD_INJECTOR)};
var FLANK_SPEC = ${JSON.stringify({ id: "harness-flank", svg: FLANK_SVG, glass: { blur: 12, tint: "#102030", opacity: 0.4 } })};
var UPSTREAM_SPEC = ${JSON.stringify({ id: "harness-upstream", svg: UPSTREAM_SVG, glass: { blur: 12, tint: "#0a1430", opacity: 0.4 } })};
var SPIN = ${JSON.stringify(SPIN)}, BOUNCE = ${JSON.stringify(BOUNCE)}, FLIP = ${JSON.stringify(FLIP)};
var STAR_D = ${JSON.stringify(STAR_D)}, DECOY_D = ${JSON.stringify(DECOY_D)};
var lines = [];
function ok(c, label, extra) { lines.push((c ? "PASS " : "FAIL ") + label + (extra ? "  -> " + extra : "")); }

// Exactly what the main process does on dom-ready and on every live switch: set the
// spec as a global, re-evaluate the file.
function push(spec) { window.__CDB_SPINNER_SPEC = spec; (new Function(SRC))(); }

function glyphs() { return [].slice.call(document.querySelectorAll("svg[data-cdb-spinner]")); }
function stars() { return [].slice.call(document.querySelectorAll("#app svg")); }
function ds(svg) { return [].slice.call(svg.querySelectorAll("path")).map(function (p) { return p.getAttribute("d"); }); }
function cls(svg) { return svg.getAttribute("class") || ""; }
function anim(el) { return getComputedStyle(el).animationName; }
function decoy() { return document.querySelector(".decoy svg"); }
function star() { var d = document.createElement("div");
  d.innerHTML = '<svg viewBox="0 0 100 100" class="fill-current"><path d="' + STAR_D + '"/></svg>';
  document.getElementById("app").appendChild(d); }

// The engine's observer sweeps on the next animation frame, and under virtual time a
// frame lands whenever the browser decides to render. Polling for the expected state
// (with a deadline that still fails loudly) keeps this suite deterministic instead of
// betting on a fixed delay.
function waitFor(cond, next, tries) {
  tries = (tries === undefined) ? 40 : tries;
  if (cond() || tries <= 0) { next(); return; }
  setTimeout(function () { waitFor(cond, next, tries - 1); }, 25);
}

function run(step) {
  if (step === 0) {
    // Headless Chromium under --dump-dom + --virtual-time-budget produces (almost) no
    // compositor frames - measured: requestAnimationFrame runs ONCE in 5s of virtual
    // time - so the engine's rAF-debounced sweep would never fire here. Swap the
    // scheduler for a timer BEFORE the engine installs. The debounce mechanism is the
    // only thing replaced; the observer, the matcher and the render path under test are
    // the real ones.
    window.requestAnimationFrame = function (fn) { return window.setTimeout(fn, 16); };

    // --- first install ---------------------------------------------------
    ok(typeof window.__cdbSpinnerApply === "undefined", "no engine before the first push");
    push(SPIN);
    ok(typeof window.__cdbSpinnerApply === "function", "the push installed window.__cdbSpinnerApply");
    ok(glyphs().length === 2, "both star glyphs themed", glyphs().length + " stamped");
    ok(ds(glyphs()[0]).join("") === SPIN.paths[0].d, "the glyph carries the spec's path");
    ok(cls(glyphs()[0]).indexOf("cdb-anim-spin") >= 0, "anim class added", cls(glyphs()[0]));
    ok(cls(glyphs()[0]).indexOf("fill-current") >= 0, "upstream classes kept", cls(glyphs()[0]));
    ok(anim(glyphs()[0]) === "cdbSpin", "the real captured sheet animates it", anim(glyphs()[0]));
    ok(ds(decoy())[0] === DECOY_D, "a decoy icon in the same box is untouched", ds(decoy())[0]);
    var v1 = glyphs()[0].getAttribute("data-cdb-spinner");

    // --- live re-theme: the bug this engine exists to fix -----------------
    push(BOUNCE);
    ok(glyphs().length === 2, "still exactly two glyphs after the switch", glyphs().length);
    ok(ds(glyphs()[0]).length === 2 && ds(glyphs()[0])[0] === BOUNCE.paths[0].d,
       "the glyph was re-themed WITHOUT a restart", ds(glyphs()[0]).join(" | "));
    ok(glyphs()[0].querySelector("path").getAttribute("fill") === "#E52521", "explicit fill applied");
    ok(cls(glyphs()[0]).indexOf("cdb-anim-bounce") >= 0 && cls(glyphs()[0]).indexOf("cdb-anim-spin") < 0,
       "the old anim class was dropped and the new one added", cls(glyphs()[0]));
    ok(anim(glyphs()[0]) === "cdbBounce", "the computed animation followed the switch", anim(glyphs()[0]));
    ok(glyphs()[0].getAttribute("data-cdb-spinner") !== v1, "the stamp version changed with the spec");

    // --- flip: two sprite frames -----------------------------------------
    push(FLIP);
    var g = glyphs()[0].querySelectorAll("g[data-cdb-frame]");
    ok(g.length === 2, "flip renders two frame groups", g.length + " groups");
    ok(g[0].getAttribute("data-cdb-frame") === "1" && g[1].getAttribute("data-cdb-frame") === "2",
       "the frames are numbered 1 and 2");
    ok(g[0].querySelector("path").getAttribute("d") === FLIP.paths[0].d, "frame 1 renders paths");
    ok(g[1].querySelector("path").getAttribute("d") === FLIP.paths2[0].d, "frame 2 renders paths2");
    ok(g[1].querySelector("path").getAttribute("fill") === "#00ff00", "frame 2 keeps its own fill");
    ok(anim(g[0]) === "cdbFlipA" && anim(g[1]) === "cdbFlipB",
       "the frames animate on opposite keyframes", anim(g[0]) + " / " + anim(g[1]));
    var t = getComputedStyle(g[0]);
    ok(/steps\\(2/.test(t.animationTimingFunction), "steps() timing", t.animationTimingFunction);
    ok(t.animationDuration === "1s" && t.animationIterationCount === "infinite",
       "a 1s cycle = ~2 frames/sec, infinite", t.animationDuration + " " + t.animationIterationCount);
    ok(anim(glyphs()[0]) === "none", "the svg itself is not animated for flip", anim(glyphs()[0]));

    // --- revert: Claude's own glyph comes back ---------------------------
    push(null);
    ok(glyphs().length === 0, "no stamped glyphs after the revert", glyphs().length);
    var s = stars()[0];
    ok(ds(s).length === 1 && ds(s)[0] === STAR_D, "Claude's own star markup restored");
    ok(cls(s).indexOf("cdb-anim-") < 0, "the anim class was removed", cls(s));
    ok(anim(s) === "none", "no animation left on the restored glyph", anim(s));
    ok(window.__cdbSpinner.spec === null, "the debug surface reports the null spec");

    // --- and it can be themed again: the restore was real ----------------
    push(SPIN);
    ok(glyphs().length === 2, "re-themed after a revert - the matcher found the star again",
       glyphs().length);
    ok(window.__cdbSpinner.managed() === 2, "the engine tracks both glyphs",
       window.__cdbSpinner.managed());

    // --- bad specs are refused, the glyph is left alone ------------------
    var before = ds(glyphs()[0]).join("");
    var r1 = window.__cdbSpinnerApply({ paths: [] });
    ok(r1.ok === false && /no usable/.test(r1.error), "empty paths refused", r1.error);
    var r2 = window.__cdbSpinnerApply({ animation: "flip", paths: [{ d: "M0 0h1v1Z" }] });
    ok(r2.ok === false && /paths2/.test(r2.error), "flip without paths2 refused", r2.error);
    ok(window.__cdbSpinnerApply("not-an-object").ok === false, "a non-object spec refused");
    ok(window.__cdbSpinnerApply({ paths: [{ fill: "#fff" }] }).ok === false, "a path without d refused");
    ok(ds(glyphs()[0]).join("") === before && glyphs().length === 2,
       "the glyph survived every bad spec unchanged");
    var r5 = window.__cdbSpinnerApply({ paths: [{ d: "M5 5h9v9Z" }], animation: "wobble" });
    ok(r5.ok === true && cls(glyphs()[0]).indexOf("cdb-anim-") < 0,
       "an unknown animation degrades to no animation, shape still applied", cls(glyphs()[0]));

    // --- a newly rendered glyph gets the CURRENT spec --------------------
    push(BOUNCE);
    star();
    waitFor(function () { return glyphs().length === 3; }, function () { run(1); });
    return;
  }

  if (step === 1) {
    var all = glyphs();
    ok(all.length === 3, "the observer themed the newly rendered glyph", all.length + " glyphs");
    ok(ds(all[all.length - 1])[0] === BOUNCE.paths[0].d,
       "it got the CURRENT spec, not the one baked in at injection time");
    ok(window.__cdbSpinner.managed() === 3, "the engine tracks all three",
       window.__cdbSpinner.managed());

    // re-pushing the same spec must not duplicate anything
    push(BOUNCE);
    ok(glyphs().length === 3 && window.__cdbSpinner.managed() === 3,
       "re-pushing the same spec keeps the count stable", window.__cdbSpinner.managed());
    ok(glyphs()[0].querySelectorAll("path").length === BOUNCE.paths.length,
       "no path duplication on a re-push", glyphs()[0].querySelectorAll("path").length);

    // A glyph rendered while the stock look is active must stay stock. There is nothing
    // to wait FOR here (the expected outcome is "nothing happens"), so give the observer
    // a generous window to misbehave in before checking.
    push(null);
    star();
    waitFor(function () { return false; }, function () { run(2); }, 8);
    return;
  }

  ok(glyphs().length === 0, "nothing is themed while the stock look is active", glyphs().length);
  ok(stars().every(function (s) { return ds(s)[0] === STAR_D || ds(s)[0] === DECOY_D; }),
     "every glyph on the page is upstream markup again");

  // --- responsive sidebar-aware backdrop engine --------------------------
  function pushBd(spec) { window.__CDB_BACKDROP_SPEC = spec; (new Function(BD_SRC))(); }
  function checkFrame(label, expectOpen) {
    var rootR = document.getElementById("bd-root").getBoundingClientRect();
    var sbR = document.getElementById("bd-sb").getBoundingClientRect();
    var flR = document.getElementById("fl-box").getBoundingClientRect();
    var frR = document.getElementById("fr-box").getBoundingClientRect();
    var frtR = document.getElementById("frt-box").getBoundingClientRect();
    var minLeft = expectOpen ? sbR.right : rootR.left;
    ok(flR.left >= minLeft - 2 && flR.right <= rootR.right,
       label + " left flank clears sidebar & fits inside pane",
       "flL=" + flR.left.toFixed(1) + " min=" + minLeft.toFixed(1));
    ok(frR.right <= rootR.right + 2 && frR.left >= minLeft,
       label + " right flank fits inside window without clipping",
       "frR=" + frR.right.toFixed(1) + " winR=" + rootR.right.toFixed(1));
    ok((frtR.top - rootR.top) >= 46 && frtR.right <= rootR.right + 2,
       label + " top-right HUD clears window controls & right edge",
       "topOff=" + (frtR.top - rootR.top).toFixed(1) + " rtR=" + frtR.right.toFixed(1));
  }
  pushBd(FLANK_SPEC);
  checkFrame("960x720 open", true);
  var svg960 = document.querySelector("[data-engine-backdrop] svg");
  ok(svg960 && /^13[34]\\s+0\\s+1333\\s+1000$/.test(svg960.getAttribute("viewBox") || ""),
     "960x720 flank viewBox adapts to 4:3 aspect",
     svg960 ? svg960.getAttribute("viewBox") : "none");

  var bdRoot = document.getElementById("bd-root");
  var bdSb = document.getElementById("bd-sb");
  bdRoot.style.width = "1280px"; bdRoot.style.height = "800px";
  window.__cdbBackdrop.sweep();
  ok(document.querySelector("[data-engine-backdrop] svg") === svg960,
     "resize reuses existing <svg> DOM node so animations keep running");
  checkFrame("1280x800 open", true);

  bdSb.style.display = "none";
  window.__cdbBackdrop.sweep();
  ok(document.querySelector("[data-engine-backdrop] svg") === svg960,
     "collapsing sidebar reuses existing <svg> DOM node");
  checkFrame("1280x800 collapsed", false);
  var collapsedLeft = document.getElementById("fl-box").getBoundingClientRect().left - bdRoot.getBoundingClientRect().left;
  ok(collapsedLeft <= 48, "collapsed sidebar lets left flank shift to window edge", collapsedLeft.toFixed(1));

  bdSb.style.display = "";
  bdRoot.style.width = "1920px"; bdRoot.style.height = "1080px";
  window.__cdbBackdrop.sweep();
  checkFrame("1920x1080 open", true);
  ok(/^[-]?\\d+\\s+0\\s+177[78]\\s+1000$/.test(svg960.getAttribute("viewBox") || ""),
     "1920x1080 expands viewBox width horizontally while pinning height=1000",
     svg960.getAttribute("viewBox"));

  pushBd(UPSTREAM_SPEC);
  var svgUp = document.querySelector("[data-engine-backdrop] svg");
  ok(svgUp && svgUp.getAttribute("viewBox") === "0 0 1600 1000",
     "upstream non-flank scene keeps exact 0 0 1600 1000 viewBox untouched",
     svgUp ? svgUp.getAttribute("viewBox") : "none");

  document.getElementById("out").textContent = lines.join("\\n");
}
window.addEventListener("load", function () { run(0); });
</script>
`;
  const pagePath = join(out, "spinner.html");
  writeFileSync(pagePath, page);

  const dom = dumpDom(chromium, pagePath);
  const lines = readProbe(dom, "out");
  if (!lines) {
    console.log("  FAIL  the page never wrote its results");
    console.log(dom.slice(0, 2000));
    process.exit(1);
  }
  r.lines(lines);
  r.note("headless produces no compositor frames, so the engine's rAF debounce is " +
         "shimmed to a timer in the page; the observer and render path are the real ones");
  if (KEEP) r.note("page kept at " + pagePath);
  else rmSync(out, { recursive: true, force: true });
  r.done();
});
