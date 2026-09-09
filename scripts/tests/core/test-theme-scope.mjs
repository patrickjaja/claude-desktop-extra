/*
 * test-theme-scope.mjs - does a custom theme actually reach the chat view?
 *
 * The theme engine emits its var blocks at html scope (`:root,[data-mode=light]` and
 * `.darkTheme,[data-mode=dark],.dark`), every declaration !important. That is not
 * enough on its own: upstream's desktop frame RE-SCOPES --bg-100 on an inner
 * container, and custom properties resolve per element - a declaration ON an element
 * always beats an inherited value, !important or not. So every chat-view surface
 * painted from --bg-100 (the conversation header gradient, the "Quick answer" band,
 * the bottom disclaimer strip) rendered stock near-black under a custom theme while
 * the page background and the composer looked correct.
 *
 * Only a real engine can settle this: it is a cascade + custom-property-resolution
 * question, so the suite loads the REAL sheet the compiled patch produces into
 * headless Chromium on a DOM/CSS fixture quoted from claude.ai itself, and reads
 * getComputedStyle back.
 *
 * The suite runs the same fixture TWICE:
 *   - "fixed"   : the sheet as the patch emits it -> every probe must be the THEME color
 *   - "control" : the same sheet with our inner-scope rules stripped out -> every
 *                 --bg-100 probe must be the STOCK frame gray again
 * The control is what makes the fixed run meaningful: it proves the fixture really
 * reproduces the bug and that our two rules are what fix it, not something incidental.
 *
 * Exit code 3 means SKIP (no chromium on this machine).
 */
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installEngine, mkWc, settle, findChromium, dumpDom, readProbe, reporter, runSuite, Skip,
} from "../lib/theme-engine-harness.mjs";

// A theme with a distinct hue per mode and per token, so a wrong resolution can never
// look like a right one. Values stay in the "H S% L%" form upstream's
// `hsl(var(--bg-100) / <alpha>)` utilities require.
const THEME = {
  light: { "--bg-000": "0 80% 90%", "--bg-100": "120 60% 88%", "--bg-200": "200 60% 86%", "--bg-300": "260 60% 84%", "--bg-400": "40 60% 80%" },
  dark: { "--bg-000": "0 80% 20%", "--bg-100": "120 60% 18%", "--bg-200": "200 60% 16%", "--bg-300": "260 60% 26%", "--bg-400": "40 60% 10%" },
};

/*
 * The upstream half of the fixture. Selectors and declarations are quoted from the
 * live claude.ai bundle (assets-proxy.anthropic.com/claude-ai/v2/assets/v1/
 * c6a992d55-*.css + shared-18-*.css, captured 2026-07-25); the only edit is that the
 * --cds-hsl-gray-* indirection is collapsed to the literal values it resolves to, so
 * the fixture stays readable. Note what is NOT here: upstream never marks a token
 * declaration !important, which is why our html-level blocks win at html scope.
 */
const UPSTREAM_CSS = `
@property --tw-gradient-position{syntax:"*";inherits:false}
@property --tw-gradient-from{syntax:"<color>";inherits:false;initial-value:#0000}
@property --tw-gradient-via{syntax:"<color>";inherits:false;initial-value:#0000}
@property --tw-gradient-to{syntax:"<color>";inherits:false;initial-value:#0000}
@property --tw-gradient-stops{syntax:"*";inherits:false}
@property --tw-gradient-via-stops{syntax:"*";inherits:false}
@property --tw-gradient-from-position{syntax:"<length-percentage>";inherits:false;initial-value:0%}
@property --tw-gradient-via-position{syntax:"<length-percentage>";inherits:false;initial-value:50%}
@property --tw-gradient-to-position{syntax:"<length-percentage>";inherits:false;initial-value:100%}

[data-color-version=v2][data-theme=claude],[data-color-version=v2][data-theme=claude][data-mode=light]{--bg-000:0 0% 100%;--bg-100:60 14.2857% 97.2549%;--bg-200:60 14% 96%;--bg-300:45 11.7647% 93.3333%}
[data-color-version=v2][data-theme=claude][data-mode=dark]{--bg-000:60 2.3256% 16.8627%;--bg-100:60 1.5873% 12.3529%;--bg-200:0 0% 9%;--bg-300:0 0% 7.451%}
[data-darker-default][data-color-version=v2][data-theme=claude][data-mode=dark]{--bg-000:60 1.5873% 12.3529%;--bg-100:0 0% 8.2353%;--bg-200:0 0% 6.5%;--bg-300:0 0% 5.098%}

.dframe-root{--df-bg-page-hsl:60 14.2857% 98.6275%;--df-bg-page:hsl(var(--df-bg-page-hsl))}
[data-mode=dark] .dframe-root{--df-bg-page-hsl:60 1.5873% 12.3529%}
.dframe-root[data-variant=web]:not([data-frame-mode=code]){--df-bg-page-hsl:60 14% 98.6%}
[data-mode=dark] .dframe-root[data-variant=web]:not([data-frame-mode=code]){--df-bg-page-hsl:60 2% 10%}
[data-darker-default][data-mode=dark] .dframe-root[data-variant=web]{--df-bg-page-hsl:0 0% 5.5%}
.dframe-content{background:var(--df-bg-page)}
.dframe-content-inner{--bg-100:var(--df-bg-page-hsl)}

.bg-bg-100{background-color:hsl(var(--bg-100) / 1)}
.bg-bg-300{background-color:hsl(var(--bg-300) / 1)}
.bg-gradient-to-t{--tw-gradient-position:to top in oklab;background-image:linear-gradient(var(--tw-gradient-stops))}
.bg-gradient-to-b{--tw-gradient-position:to bottom in oklab;background-image:linear-gradient(var(--tw-gradient-stops))}
.from-bg-100{--tw-gradient-from:hsl(var(--bg-100) / 1);--tw-gradient-stops:var(--tw-gradient-via-stops,var(--tw-gradient-position), var(--tw-gradient-from) var(--tw-gradient-from-position), var(--tw-gradient-to) var(--tw-gradient-to-position))}
.via-bg-100\\/90{--tw-gradient-via:color-mix(in oklab, hsl(var(--bg-100) / 1) 90%, transparent)}
.via-bg-100\\/90{--tw-gradient-via-stops:var(--tw-gradient-position), var(--tw-gradient-from) var(--tw-gradient-from-position), var(--tw-gradient-via) var(--tw-gradient-via-position), var(--tw-gradient-to) var(--tw-gradient-to-position);--tw-gradient-stops:var(--tw-gradient-via-stops)}
.to-bg-100\\/0{--tw-gradient-to:color-mix(in oklab, hsl(var(--bg-100) / 1) 0%, transparent)}
.to-bg-100\\/0{--tw-gradient-stops:var(--tw-gradient-via-stops,var(--tw-gradient-position), var(--tw-gradient-from) var(--tw-gradient-from-position), var(--tw-gradient-to) var(--tw-gradient-to-position))}
.from-60\\%{--tw-gradient-from-position:60%}

/* v1.49585.0 CDS layer (MainWindowPage-*.css + DevTools 2026-09-09): the neutral ramp aliases
   the gray palette in light and INVERTS it in dark; the mode pills read the ramp directly. */
.cds-root{--cds-gray-60:#edece8;--cds-gray-840:#181817;--cds-neutral-60:var(--cds-gray-60)}
[data-mode=dark] .cds-root:not([data-mode=light]):not([data-mode=system]),.cds-root[data-mode=dark]{--cds-neutral-60:var(--cds-gray-840)}
.dframe-root[data-variant=web] .df-pills[data-segmented]{background:var(--cds-neutral-60)}
.to-transparent{--tw-gradient-to:transparent;--tw-gradient-stops:var(--tw-gradient-via-stops,var(--tw-gradient-position), var(--tw-gradient-from) var(--tw-gradient-from-position), var(--tw-gradient-to) var(--tw-gradient-to-position))}
`;

/*
 * The chat-view fragment, class lists quoted from the live bundle:
 *   header     - the conversation header ("bg-gradient-to-b from-bg-100 from-60% to-transparent")
 *   band       - data-testid="answer-now-above-composer", the "Quick answer" strip
 *   bubble     - a user message bubble (bg-bg-300); --bg-300 is NOT re-scoped, so it is
 *                the control token: it must stay themed in every run
 *   disclaimer - role="note" data-disclaimer, the strip under the composer
 *   pills      - the "Chat and Cowork | Code" mode pills track (.df-pills[data-segmented]),
 *                painted from --cds-neutral-60 (v1.49585.0); the frame sits inside .cds-root
 */
const FRAGMENT = `
<div class="cds-root dframe-root" data-variant="web">
  <div id="pills" class="df-pills" data-segmented="true"></div>
  <div class="dframe-content">
    <div class="dframe-content-inner">
      <div id="header" class="sticky top-0 z-10 mb-2 flex w-screen items-center justify-end gap-3 bg-gradient-to-b from-bg-100 from-60% to-transparent px-6 pb-7 pt-3"></div>
      <div id="bubble" class="bg-bg-300 rounded-xl px-4 py-3">user message</div>
      <div id="band" data-testid="answer-now-above-composer" class="pointer-events-none relative -mt-6 flex w-full justify-center bg-gradient-to-t from-bg-100 via-bg-100/90 to-bg-100/0 pb-3 pt-6"></div>
      <div id="disclaimer" role="note" data-disclaimer="true" class="bg-bg-100 text-text-500 text-center text-xs py-2">Claude can make mistakes</div>
    </div>
  </div>
</div>`;

/** Our two inner-scope rules, removed to get the pre-fix sheet back. */
function stripScopeFix(sheet) {
  return sheet
    .replace(/\.dframe-content-inner\{[^}]*\}/g, "")
    .replace(/\.dframe-root\{--df-bg-page-hsl[^}]*\}/g, "");
}

function page(sheet, expect) {
  return `<!doctype html>
<meta charset="utf-8">
<style>${UPSTREAM_CSS}</style>
<style>${sheet}</style>
${FRAGMENT}
<pre id="probe"></pre>
<script>
var EXPECT = ${JSON.stringify(expect)};
var out = [];
function hslToRgb(spec) {
  var p = spec.trim().split(/\\s+/);
  var h = parseFloat(p[0]) / 360, s = parseFloat(p[1]) / 100, l = parseFloat(p[2]) / 100;
  function f(n) {
    var k = (n + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  }
  return [f(0), f(8), f(4)].map(function (x) { return Math.round(x * 255); });
}
function colorsIn(str) {
  var m = str.match(/rgba?\\([^)]*\\)/g) || [];
  return m.map(function (c) {
    return c.replace(/rgba?\\(|\\)/g, "").split(/[,\\s\\/]+/).slice(0, 3).map(Number);
  });
}
function near(a, b) {
  return a.length === 3 && b.length === 3 &&
    a.every(function (v, i) { return Math.abs(v - b[i]) <= 2; });
}
function check(label, cond, extra) {
  out.push((cond ? "PASS  " : "FAIL  ") + label + (extra ? "  -> " + extra : ""));
}
function probe(mode) {
  var html = document.documentElement;
  html.setAttribute("data-theme", "claude");
  html.setAttribute("data-color-version", "v2");
  html.setAttribute("data-darker-default", "");
  html.setAttribute("data-mode", mode);
  html.className = mode === "dark" ? "dark" : "";
  var want = hslToRgb(EXPECT[mode].bg100);
  var wantBubble = hslToRgb(EXPECT[mode].bg300);
  var other = hslToRgb(EXPECT[mode].other);
  var tag = "[" + EXPECT.label + "/" + mode + "] ";

  var disc = getComputedStyle(document.getElementById("disclaimer")).backgroundColor;
  check(tag + "disclaimer strip (bg-bg-100) is " + EXPECT.wantName,
    near(colorsIn(disc)[0] || [], want), disc + " want rgb(" + want + ")");

  ["header", "band"].forEach(function (id) {
    var img = getComputedStyle(document.getElementById(id)).backgroundImage;
    var cols = colorsIn(img);
    check(tag + id + " gradient carries " + EXPECT.wantName,
      cols.some(function (c) { return near(c, want); }),
      "want rgb(" + want + ") in " + img.slice(0, 120));
    check(tag + id + " gradient no longer carries the other value",
      !cols.some(function (c) { return near(c, other); }), "rgb(" + other + ")");
  });

  var bub = getComputedStyle(document.getElementById("bubble")).backgroundColor;
  check(tag + "user bubble (bg-bg-300) stays on the theme ramp",
    near(colorsIn(bub)[0] || [], wantBubble), bub + " want rgb(" + wantBubble + ")");

  if (EXPECT.pills) {
    var wantPills = hslToRgb(EXPECT[mode].pills);
    var pills = getComputedStyle(document.getElementById("pills")).backgroundColor;
    check(tag + "mode pills track (--cds-neutral-60) is " + EXPECT.pillsName[mode],
      near(colorsIn(pills)[0] || [], wantPills), pills + " want rgb(" + wantPills + ")");
  }
}
probe("dark");
probe("light");
document.getElementById("probe").textContent = out.join("\\n");
</script>`;
}

await runSuite(async () => {
  const r = reporter("Theme scope: chat-view surfaces under an inner --bg-100 re-scope");
  const chromium = findChromium();
  if (!chromium) throw new Skip("no chromium/chrome on this machine");

  const { themes: T, appEvents } = installEngine({
    config: { activeTheme: "", themes: { harness: THEME } },
  });
  T.apply("harness");
  const wc = mkWc();
  appEvents["web-contents-created"]({}, wc);
  wc.fire("dom-ready");
  await settle();
  const sheet = wc.sheet();
  if (!sheet || sheet.indexOf("--cdb-bg-100") < 0) {
    throw new Error("captured sheet carries no --cdb-bg-* mirrors - the engine did not build them");
  }
  r.ok(/\.dframe-content-inner\{[^}]*--bg-100:var\(--cdb-bg-100\)!important/.test(sheet),
    "sheet re-asserts --bg-100 on .dframe-content-inner");
  r.ok(sheet.includes(".dframe-root{--df-bg-page-hsl:var(--cdb-bg-100)!important"),
    "sheet puts the frame page-bg token on the theme");

  // v1.49585.0 CDS layer: the sheet must carry the token map (upstream inverts the neutral
  // ramp in dark, so the page side is per mode; the text side and the semantic fills are shared).
  r.section("CDS layer remap (v1.49585.0): the sheet carries the token map");
  r.ok(/:root,\[data-mode=light\],\.cds-root,\.epitaxy-root\{[^}]*--cds-neutral-60:hsl\(var\(--bg-400\)\)!important/.test(sheet),
    "light page-side rule maps the pills track (--cds-neutral-60) to --bg-400");
  r.ok(/\[data-mode=dark\][^{]*\{[^}]*--cds-neutral-60:hsl\(var\(--bg-100\)\)!important/.test(sheet),
    "dark page-side rule maps --cds-neutral-60 to --bg-100 (one step above the page, as stock)");
  r.ok(sheet.includes("--cds-neutral-900:hsl(var(--text-000))!important"),
    "shared text side pins --cds-neutral-900 (source of alpha/border/tooltip) to --text-000");
  r.ok((sheet.match(/--cds-neutral-150:color-mix\(in srgb,hsl\(var\(--bg-(500|000)\)\) 85%,hsl\(var\(--text-500\)\)\)!important/g) || []).length >= 2,
    "the 150..400 color-mix steps are emitted for both anchors (--bg-500 light, --bg-000 dark)");
  r.ok(sheet.includes("--cds-fill-accent:hsl(var(--accent-100))!important") &&
       sheet.includes("--cds-text-accent:hsl(var(--accent-000))!important"),
    "accent fill and text map onto the --accent-* ramp");
  r.ok(sheet.includes("--cds-fill-brand:hsl(var(--brand-000))!important") &&
       sheet.includes("--cds-clay-emphasized:hsl(var(--brand-000))!important"),
    "brand fill and clay-emphasized map onto --brand-000");
  r.ok(sheet.includes("--cds-bg-danger:hsl(var(--danger-900))!important") &&
       sheet.includes("--cds-on-success:hsl(var(--oncolor-100))!important"),
    "status backgrounds and on-colors map onto the status ramps / --oncolor-100");
  r.ok(/\.dframe-root\{[^}]*--df-hover:hsl\(var\(--text-000\) \/ 0\.06\)!important;--df-selected:hsl\(var\(--text-000\) \/ 0\.12\)!important/.test(sheet),
    "sidebar row states (--df-hover / --df-selected) are an alpha of --text-000");
  r.ok(!/--cds-(alpha-\d|gray-\d+|switch-knob|slider-handle|fill-warning):/.test(sheet),
    "derived alphas, the gray palette, the white knob and the warning fill are deliberately NOT overridden");

  const control = stripScopeFix(sheet);
  r.ok(control.length < sheet.length && !control.includes("--cdb-bg-100)!important"),
    "control sheet has the inner-scope rules removed");

  // A mirror that exists in only one mode would be invalid-at-computed-value-time in
  // the other and would blank the surface rather than theme it, so a token is only
  // re-asserted when BOTH variants carry it. Two themes that must NOT get the rule:
  r.section("sparse themes are left alone rather than blanked");
  T.apply("");
  const noBg = installEngine({
    config: { activeTheme: "textonly", themes: { textonly: { light: { "--text-000": "0 0% 10%" }, dark: { "--text-000": "0 0% 90%" } } } },
  });
  const wcNoBg = mkWc();
  noBg.appEvents["web-contents-created"]({}, wcNoBg);
  wcNoBg.fire("dom-ready");
  await settle();
  r.ok(!(wcNoBg.sheet() || "").includes(".dframe-content-inner{--bg-"),
    "a theme with no --bg-* tokens gets no re-assert rule");

  const halfBg = installEngine({
    config: { activeTheme: "halfbg", themes: { halfbg: { light: { "--bg-000": "0 0% 99%" }, dark: { "--bg-000": "0 0% 4%", "--bg-100": "0 0% 8%" } } } },
  });
  const wcHalf = mkWc();
  halfBg.appEvents["web-contents-created"]({}, wcHalf);
  wcHalf.fire("dom-ready");
  await settle();
  const halfSheet = wcHalf.sheet() || "";
  r.ok(halfSheet.includes(".dframe-content-inner{--bg-000:var(--cdb-bg-000)!important}"),
    "a token both variants define is re-asserted");
  r.ok(!halfSheet.includes("--bg-100:var(--cdb-bg-100)"),
    "a token only the dark variant defines is not");

  const out = mkdtempSync(join(tmpdir(), "cdb-theme-scope-"));
  // Stock frame grays for [data-darker-default][data-mode=dark] .dframe-root[data-variant=web]
  // and .dframe-root[data-variant=web] in light - what leaked through before the fix.
  const STOCK = { dark: "0 0% 5.5%", light: "60 14% 98.6%" };

  r.section("with the patch's sheet: the theme reaches the chat view");
  const fixedPage = join(out, "fixed.html");
  writeFileSync(fixedPage, page(sheet, {
    label: "fixed", wantName: "the theme's --bg-100",
    pills: true, pillsName: { light: "the theme's --bg-400", dark: "the theme's --bg-100" },
    dark: { bg100: THEME.dark["--bg-100"], bg300: THEME.dark["--bg-300"], other: STOCK.dark, pills: THEME.dark["--bg-100"] },
    light: { bg100: THEME.light["--bg-100"], bg300: THEME.light["--bg-300"], other: STOCK.light, pills: THEME.light["--bg-400"] },
  }));
  const fixedLines = readProbe(dumpDom(chromium, fixedPage), "probe");
  if (!fixedLines) throw new Error("the fixed page wrote no probe output");
  r.lines(fixedLines);

  r.section("control (inner-scope rules stripped): the bug is reproduced");
  const controlPage = join(out, "control.html");
  writeFileSync(controlPage, page(control, {
    label: "control", wantName: "the STOCK frame gray",
    dark: { bg100: STOCK.dark, bg300: THEME.dark["--bg-300"], other: THEME.dark["--bg-100"] },
    light: { bg100: STOCK.light, bg300: THEME.light["--bg-300"], other: THEME.light["--bg-100"] },
  }));
  const controlLines = readProbe(dumpDom(chromium, controlPage), "probe");
  if (!controlLines) throw new Error("the control page wrote no probe output");
  r.lines(controlLines);

  r.done();
});
