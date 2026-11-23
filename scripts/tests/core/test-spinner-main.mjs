#!/usr/bin/env node
/*
 * test-spinner-main.mjs - main-process tests for the theme engine injected by
 * patches/core/add_feature_custom_themes.nim: what it PUSHES into windows on a live theme
 * switch, and what __cdbThemes.list() reports.
 *
 * Why this exists: a green patch run only proves the IIFE was inserted. The behaviour
 * that broke before (spinner shape frozen until restart) lives in whether apply() pushes
 * the new spec to every live window - which no regex can assert. Here the engine really
 * runs, with electron shimmed and fake windows recording every insertCSS and
 * executeJavaScript call.
 *
 * Deterministic: the switching assertions use themes this file defines in the config, so
 * they do not move when someone re-authors a bundled palette. The assertions that DO
 * cover bundled data (gaming category, bundled spinner specs) read js/*.json from disk.
 *
 * Usage: node scripts/tests/core/test-spinner-main.mjs        (exit 3 = SKIP, 1 = FAIL)
 */
import {
  installEngine, mkWc, pushedSpec, lastSpinnerPayload, settle, readJson, reporter, runSuite,
} from "../lib/theme-engine-harness.mjs";

const KEYFRAMES = ["cdbSpin", "cdbBounce", "cdbPulse", "cdbFlipA", "cdbFlipB"];

// Harness-owned themes: one per spinner shape we need to switch between, plus one with
// no spinner at all (the "theme without a spinner -> restore the glyph" edge case).
const SPIN_A = { viewBox: "0 0 100 100", animation: "spin", paths: [{ d: "M50 10 L55 90 Z" }] };
const SPIN_B = {
  viewBox: "0 0 100 100", animation: "flip",
  paths: [{ d: "M20 20h60v60H20Z" }],
  paths2: [{ d: "M30 30h40v40H30Z", fill: "#00ff00" }],
};
const V = (bg) => ({ "--bg-000": bg, "--accent-brand": "0 100% 50%" });
const CONFIG = {
  activeTheme: "",
  themes: {
    "harness-a": { name: "Harness A", light: V("0 0% 100%"), dark: V("0 0% 4%"), spinner: SPIN_A },
    "harness-b": { name: "Harness B", category: "gaming", light: V("0 0% 98%"), dark: V("0 0% 6%"), spinner: SPIN_B },
    "harness-plain": { name: "Harness Plain", light: V("0 0% 96%"), dark: V("0 0% 8%") },
  },
};

await runSuite(async () => {
  const r = reporter("Theme engine (main process)");
  const { themes: T, appEvents, diag } = installEngine({ config: CONFIG });
  const gaming = readJson("js/gaming_themes.json");
  const linuxThemes = readJson("js/linux_themes.json");
  const community = readJson("js/community_themes.json");

  r.section("[1] registry: source is the resolution tier, category is the grouping");
  const entries = T.list();
  const by = {};
  entries.forEach((e) => (by[e.name] = e));
  r.ok(typeof T.apply === "function" && typeof T.list === "function", "__cdbThemes installed");
  r.ok(entries.every((e) => typeof e.category === "string"),
     "every entry carries a category string");
  const gslugs = Object.keys(gaming);
  const lslugs = Object.keys(linuxThemes);
  r.ok(gslugs.length === 12 && gslugs.every((s) => by[s] && by[s].source === "builtin" &&
       by[s].category === "gaming"),
     "bundled gaming palettes (12) are builtin-tier, gaming-category",
     gslugs.length + " palettes: " + gslugs.join(","));
  r.ok(lslugs.length === 15 && lslugs.every((s) => by[s] && by[s].source === "builtin" &&
       by[s].category === "linux" && by[s].light && by[s].dark),
     "bundled linux palettes (15) are builtin-tier, linux-category with both variants",
     lslugs.length + " palettes");
  r.ok(gslugs.every((s) => by[s].light && by[s].dark), "gaming entries expose both variants");
  r.ok(by["mario"] && by["mario"].category === "gaming", "mario is categorised gaming",
     by["mario"] && JSON.stringify(by["mario"].category));
  r.ok(by["nord"] && by["nord"].source === "builtin" && by["nord"].category === "",
     "a plain built-in has an empty category");
  const cslugs = Object.keys(community);
  r.ok(cslugs.every((s) => by[s] && by[s].source === "community"),
     "all " + cslugs.length + " bundled community palettes still list as community");
  r.ok(by["harness-b"].source === "custom" && by["harness-b"].category === "gaming",
     "a user theme's own category flows through list()");

  r.section("[2] a window tracked while the stock look is active gets nothing");
  const wc = mkWc();
  appEvents["web-contents-created"]({}, wc);
  wc.fire("dom-ready");
  await settle();
  r.ok(wc.css.length === 0 && wc.js.length === 0, "no CSS and no JS injected",
     JSON.stringify({ css: wc.css.length, js: wc.js.length }));

  r.section("[3] applying a theme pushes the injector + spec into the live window");
  r.ok(T.apply("harness-a").ok === true, "apply('harness-a') ok");
  await settle();
  const payload = lastSpinnerPayload(wc);
  r.ok(!!payload, "a spinner payload arrived");
  r.ok(/window\.__cdbSpinnerApply/.test(payload || ""),
     "the payload carries the injector, which installs the live API");
  r.ok(JSON.stringify(pushedSpec(wc)) === JSON.stringify(SPIN_A), "the theme's spec pushed verbatim",
     JSON.stringify(pushedSpec(wc)));
  r.ok(wc.css.length === 1, "the stylesheet was inserted", "css=" + wc.css.length);

  r.section("[4] switching theme re-pushes the NEW spec to the SAME window (no restart)");
  r.ok(T.apply("harness-b").ok === true, "apply('harness-b') ok");
  await settle();
  const b = pushedSpec(wc);
  r.ok(JSON.stringify(b) === JSON.stringify(SPIN_B), "the second theme's spec pushed",
     JSON.stringify(b));
  r.ok(b.animation === "flip" && b.paths2.length === 1,
     "a flip spec survives the round trip with its second frame");
  r.ok(wc.removedKeys.length === 1 && wc.css.length === 2,
     "the old sheet was removed and the new one inserted",
     JSON.stringify({ removed: wc.removedKeys, css: wc.css.length }));

  r.section("[5] a theme with no spinner pushes null - the previous shape is undone");
  r.ok(T.apply("harness-plain").ok === true, "apply('harness-plain') ok");
  await settle();
  r.ok(pushedSpec(wc) === null, "null spec pushed", String(pushedSpec(wc)));

  r.section("[6] every keyframe ships with every sheet, spinner or not");
  const plainSheet = wc.sheet();
  KEYFRAMES.forEach((k) => r.ok(plainSheet.indexOf("@keyframes " + k) >= 0,
     "a spinner-less theme's sheet still defines @keyframes " + k));
  r.ok(/cdb-anim-flip \[data-cdb-frame="1"\]\{animation:cdbFlipA 1s steps\(2,jump-none\) infinite\}/
       .test(plainSheet), "flip frame 1 rule present with steps(2,jump-none) timing");
  r.ok(/cdb-anim-flip \[data-cdb-frame="2"\]\{animation:cdbFlipB 1s steps\(2,jump-none\) infinite\}/
       .test(plainSheet), "flip frame 2 rule present");

  r.section("[7] bundled themes' spinners are pushed exactly as authored");
  // Data-driven: whatever js/gaming_themes.json ships today must arrive unchanged. The
  // same __cdb_buildCss line reads `theme.spinner` for community palettes, so community
  // entries are covered by the loop below as soon as they carry one.
  let checkedBundled = 0;
  for (const [label, col] of [["gaming", gaming], ["linux", linuxThemes]]) {
    for (const slug of Object.keys(col)) {
      if (!col[slug].spinner) continue;
      T.apply(slug);
      await settle();
      r.ok(JSON.stringify(pushedSpec(wc)) === JSON.stringify(col[slug].spinner),
         label + " '" + slug + "' spinner pushed verbatim", col[slug].spinner.animation);
      checkedBundled++;
    }
  }
  r.ok(checkedBundled === 27, "all 27 bundled linux/gaming spinners were checked",
     checkedBundled + " of " + (gslugs.length + lslugs.length));
  const cWithSpinner = cslugs.filter((s) => community[s].spinner);
  if (cWithSpinner.length === 0) {
    r.note("0 community palettes carry a spinner yet; the extraction path they will use " +
           "is the same one [3]-[5] exercise through a custom-source theme");
  }
  for (const slug of cWithSpinner) {
    T.apply(slug);
    await settle();
    r.ok(JSON.stringify(pushedSpec(wc)) === JSON.stringify(community[slug].spinner),
       "community '" + slug + "' spinner pushed verbatim", community[slug].spinner.animation);
  }

  r.section("[8] revert restores: sheet removed, null spec pushed");
  const removedBefore = wc.removedKeys.length;
  r.ok(T.apply("").ok === true, "apply('') reverts");
  await settle();
  r.ok(T.active() === null, "active() is null after the revert");
  r.ok(pushedSpec(wc) === null, "null spec pushed so the injector puts the star back");
  r.ok(wc.removedKeys.length === removedBefore + 1, "the stylesheet was removed");

  r.section("[9] a window opened AFTER a switch gets the current spec");
  T.apply("harness-a");
  await settle();
  const late = mkWc();
  appEvents["web-contents-created"]({}, late);
  late.fire("dom-ready");
  await settle();
  r.ok(JSON.stringify(pushedSpec(late)) === JSON.stringify(SPIN_A),
     "the late window received the active spec, not a startup-frozen one");
  r.ok(late.css.length === 1, "the late window received the sheet");

  r.section("[10] diagnostics say what actually happened");
  r.ok(diag.some((m) => /spinner pushed to \d+/.test(m)),
     "apply logged how many windows got the spinner",
     diag.filter((m) => /spinner pushed/.test(m)).slice(-1)[0]);
  r.ok(diag.some((m) => /restored the glyph in \d+/.test(m)),
     "revert logged the glyph restore",
     diag.filter((m) => /restored the glyph/.test(m)).slice(-1)[0]);
  r.ok(diag.every((m) => m.startsWith("[CustomThemes]")), "every line is tagged [CustomThemes]",
     diag.length + " lines");

  r.section("[11] animated SVG backdrops + scene themes");
  const backdrops = T.backdrops();
  r.ok(Array.isArray(backdrops) && backdrops.length === 48,
     "backdrops() lists all 48 scenes (20 upstream + 15 linux + 13 gaming)",
     String(backdrops && backdrops.length));
  const sceneReg = globalThis.__cdbBackdropScenes;
  const dualCats = new Set(["linux", "gaming"]);
  r.ok(backdrops.every((b) => {
    const s = sceneReg && sceneReg.get && sceneReg.get(b.id);
    if (!s || typeof s.svg !== "string" || !s.svg.startsWith("<svg")) return false;
    if (dualCats.has(b.category)) {
      return typeof s.lightSvg === "string" && s.lightSvg.startsWith("<svg") &&
             typeof s.darkSvg === "string" && s.darkSvg.startsWith("<svg") &&
             s.lightSvg !== s.darkSvg;
    }
    return true;
  }), "all 48 scenes evaluate valid <svg> markup, and all 28 bespoke scenes have distinct lightSvg + darkSvg");
  function findTransformAnimCollisions(svg) {
    const styleMatch = /<style>([\s\S]*?)<\/style>/.exec(svg);
    if (!styleMatch) return [];
    const css = styleMatch[1];
    const transformFrames = new Set();
    const kfRe = /@keyframes\s+([\w-]+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g;
    let m;
    while ((m = kfRe.exec(css)) !== null) {
      if (/\btransform\s*:/.test(m[2])) transformFrames.add(m[1]);
    }
    const transformClasses = new Set();
    const ruleRe = /\.([\w-]+)\s*\{([^}]*)\}/g;
    while ((m = ruleRe.exec(css)) !== null) {
      const animMatch = /animation(?:-name)?\s*:([^;]+)/.exec(m[2]);
      if (animMatch) {
        for (const kf of transformFrames) {
          if (new RegExp("\\b" + kf + "\\b").test(animMatch[1])) {
            transformClasses.add(m[1]);
          }
        }
      }
    }
    const hits = [];
    const tagRe = /<[A-Za-z][\w:-]*\b([^>]*)>/g;
    while ((m = tagRe.exec(svg)) !== null) {
      const attrs = m[1];
      if (!/\btransform\s*=/.test(attrs)) continue;
      const clsMatch = /\bclass\s*=\s*["']([^"']+)["']/.exec(attrs);
      if (!clsMatch) continue;
      for (const cls of clsMatch[1].trim().split(/\s+/)) {
        if (transformClasses.has(cls)) hits.push(cls);
      }
    }
    return hits;
  }
  const transformCollisions = [];
  for (const b of backdrops.filter((x) => dualCats.has(x.category))) {
    const s = sceneReg && sceneReg.get && sceneReg.get(b.id);
    if (!s) continue;
    for (const variant of ["svg", "lightSvg", "darkSvg"]) {
      if (typeof s[variant] !== "string") continue;
      const bad = findTransformAnimCollisions(s[variant]);
      if (bad.length) transformCollisions.push(b.id + ":" + variant + "(" + bad.join(",") + ")");
    }
  }
  r.ok(transformCollisions.length === 0,
     "no bespoke scene mixes SVG transform attribute with a transform-animating CSS class",
     transformCollisions.join("; "));
  const bespokeBackdropGaps = [];
  for (const b of backdrops.filter((x) => dualCats.has(x.category))) {
    const s = sceneReg && sceneReg.get && sceneReg.get(b.id);
    for (const variant of ["lightSvg", "darkSvg"]) {
      const svg = s && s[variant];
      if (typeof svg !== "string") {
        bespokeBackdropGaps.push(b.id + ":" + variant + "(missing)");
        continue;
      }
      if (!/\bcdb-flank-l\b/.test(svg)) bespokeBackdropGaps.push(b.id + ":" + variant + "(no cdb-flank-l)");
      if (!/\bcdb-flank-r\b/.test(svg)) bespokeBackdropGaps.push(b.id + ":" + variant + "(no cdb-flank-r)");
      if (!/width=["']3200["']/.test(svg)) bespokeBackdropGaps.push(b.id + ":" + variant + "(no width=3200 bleed)");
      const tagRe2 = /<[A-Za-z][\w:-]*\b([^>]*)>/g;
      let tm;
      while ((tm = tagRe2.exec(svg)) !== null) {
        if (/\bclass\s*=\s*["'][^"']*\bcdb-(?:flank-(?:l|r|lt|rt)|pane-c)\b/.test(tm[1]) &&
            /\btransform\s*=/.test(tm[1])) {
          bespokeBackdropGaps.push(b.id + ":" + variant + "(flank tag also has SVG transform)");
        }
      }
    }
  }
  r.ok(bespokeBackdropGaps.length === 0,
     "all 28 bespoke scenes include .cdb-flank-l, .cdb-flank-r, and width=3200 full-bleed layers in both lightSvg and darkSvg",
     bespokeBackdropGaps.join("; "));
  const honuScene = sceneReg && sceneReg.get && sceneReg.get("honu-lagoon");
  const reefScene = sceneReg && sceneReg.get && sceneReg.get("night-reef");
  const honuSpec = sceneReg && typeof sceneReg.buildSpec === "function" && sceneReg.buildSpec("honu-lagoon");
  r.ok(Boolean(honuScene && honuScene.twin === "night-reef" &&
               reefScene && reefScene.twin === "honu-lagoon" &&
               honuSpec && honuSpec.twin === "night-reef"),
     "honu-lagoon and night-reef wire symmetrical twin metadata through get() and buildSpec()",
     JSON.stringify({ honu: honuScene && honuScene.twin, reef: reefScene && reefScene.twin, spec: honuSpec && honuSpec.twin }));
  const gtaIds = ["gta-i", "gta-ii", "gta-iii", "gta-iv", "gta-v", "gta-vi"];
  r.ok(gtaIds.every((id) => T.list().some((e) => e.name === id && e.category === "gaming" && e.backdrop === id)),
     "list() includes all 6 GTA gaming themes (gta-i..gta-vi) paired with their backdrop scenes");
  r.ok(lslugs.every((id) => T.list().some((e) => e.name === id && e.category === "linux" && e.backdrop === id)),
     "list() includes all 15 Linux distro themes paired with their backdrop scenes");
  const aliasPairs = [["arch", "arch-linux"], ["mint", "linux-mint"], ["mintos", "linux-mint"], ["lfs", "linux-from-scratch"]];
  r.ok(aliasPairs.every(([alias, target]) => {
    const res = T.apply(alias);
    return res && res.ok === true && T.active() === target;
  }), "alias slugs (arch, mint, mintos, lfs) resolve to canonical theme names");
  const flipIds = ["gta-iii", "gta-iv", "gta-v", "gta-vi"];
  r.ok(flipIds.every((id) => gaming[id] && gaming[id].spinner && gaming[id].spinner.animation === "flip" &&
                             Array.isArray(gaming[id].spinner.paths2) && gaming[id].spinner.paths2.length > 0),
     "gta-iii..gta-vi ship 2-frame flip spinners with paths2");
  const sceneThemes = T.list().filter((e) => e.category === "scenes");
  r.ok(sceneThemes.length === 20, "list() includes all 20 category='scenes' themes",
     String(sceneThemes.length));
  r.ok(sceneThemes.every((e) => e.backdrop === e.name && !!e.blurb),
     "every scene theme is paired with its own backdrop scene and blurb");
  const sceneJson = readJson("js/scene_themes.json");
  const sceneSpinnerSigs = new Set(Object.values(sceneJson).map((t) => JSON.stringify(t.spinner && t.spinner.paths)));
  const sceneSpinnersOk = Object.values(sceneJson).every((t) =>
    t.spinner && t.spinner.viewBox === "0 0 100 100" &&
    Array.isArray(t.spinner.paths) && t.spinner.paths.length > 0 &&
    t.spinner.paths.every((p) => typeof p.d === "string" && !("fill" in p))
  );
  r.ok(sceneSpinnerSigs.size === 20 && sceneSpinnersOk,
     "all 20 scene themes ship unique monochrome 0 0 100 100 spinners (no fill attribute)",
     sceneSpinnerSigs.size + "/20 unique");

  // Applying a scene theme or gaming theme pushes its paired backdrop spec via __cdbBackdropApply
  T.apply("honu-lagoon");
  await settle();
  r.ok(T.backdrop() === "", "backdrop() defaults to '' (follow theme)");
  r.ok(T.effectiveBackdrop() === "honu-lagoon", "effectiveBackdrop() resolves to the active theme's paired scene");
  const lastBackdropCall = wc.js.filter((s) => s.includes("__cdbBackdropApply")).slice(-1)[0] || "";
  r.ok(lastBackdropCall.includes('"honu-lagoon"'), "applying honu-lagoon pushed its animated SVG backdrop to the renderer");

  // Overriding activeBackdrop to another scene works over any theme (or stock)
  const setRes = T.setBackdrop("zelda");
  await settle();
  r.ok(setRes && setRes.ok === true && T.backdrop() === "zelda" && T.effectiveBackdrop() === "zelda",
     "setBackdrop('zelda') pins the Zelda backdrop over the current theme");
  const zeldaCall = wc.js.filter((s) => s.includes("__cdbBackdropApply")).slice(-1)[0] || "";
  r.ok(zeldaCall.includes('"zelda"'), "setBackdrop('zelda') pushed the Zelda SVG backdrop to the renderer");

  // Turning backdrop off pushes null
  const offRes = T.setBackdrop("off");
  await settle();
  r.ok(offRes && offRes.ok === true && T.backdrop() === "off" && T.effectiveBackdrop() === null,
     "setBackdrop('off') disables backdrops even when the theme has a paired scene");
  const offCall = wc.js.filter((s) => s.includes("__cdbBackdropApply")).slice(-1)[0] || "";
  r.ok(offCall.includes("__CDB_BACKDROP_SPEC=null"), "setBackdrop('off') pushed null to tear down the backdrop");

  // Resetting to follow theme ("") restores the active theme's paired scene
  T.setBackdrop("");
  await settle();
  r.ok(T.backdrop() === "" && T.effectiveBackdrop() === "honu-lagoon",
     "setBackdrop('') restores Follow theme");

  // Authentic game HUD & sprite markers (GTA I police/taxi chase, top-right cop heads & green cash, etc.)
  const gta1Scene = sceneReg.get("gta-i");
  const gta1Json = gaming["gta-i"];
  r.ok(Boolean(gta1Scene &&
               gta1Scene.lightSvg.includes("gta1TileL") &&
               gta1Scene.darkSvg.includes("gta1TileD") &&
               gta1Scene.lightSvg.includes("sirenR") &&
               gta1Scene.darkSvg.includes("sirenB") &&
               gta1Scene.lightSvg.includes("chaseUp") &&
               gta1Scene.lightSvg.includes("#facc15") &&
               gta1Scene.lightSvg.includes("#fbbf24") &&
               gta1Scene.lightSvg.includes("#16a34a") &&
               gta1Scene.darkSvg.includes("#22c55e") &&
               !gta1Scene.lightSvg.includes("#dc2626")),
     "gta-i scenes use authentic cop heads, green pixel cash, yellow taxi & police chase loop without blocky red squares");
  r.ok(Boolean(gta1Json && gta1Json.spinner &&
               gta1Json.spinner.paths.some((p) => p.fill === "#2563eb") &&
               gta1Json.spinner.paths.some((p) => p.fill === "#f8fafc") &&
               Array.isArray(gta1Json.spinner.paths2)),
     "gta-i spinner uses the 2-frame blue-and-white Police Cruiser with alternating sirens");
  const hudChecks = [
    ["gta-ii", ["cop2", "ztype", "#67e8f9", "#f5b82e"]],
    ["gta-iii", ["#60a5fa", "#5ec4b6"]],
    ["gta-iv", ["#f59e0b", "gta4Gold"]],
    ["gta-v", ["#c084fc", "#4ec962"]],
    ["gta-vi", ["gta6SunMask", "gta6PalmA", "gta6LogoG", "#fee8cb", "#9f6ea6"]],
    ["mario", ["qface", "starman", "piranha"]],
    ["playstation", ["psTower", "psOrbs"]],
    ["gameboy", ["lineClr", "tet"]],
    ["final-fantasy", ["ffHand", "crystal"]],
    ["zelda", ["tri", "fairy", "#e11d48", "#10b981"]],
    ["warcraft", ["rune", "#d49b27", "#38bdf8"]],
    ["dragonball", ["radarBlip", "orb"]]
  ];
  const hudGaps = [];
  for (const [id, markers] of hudChecks) {
    const sc = sceneReg.get(id);
    if (!sc || !sc.darkSvg || !sc.lightSvg) {
      hudGaps.push(id + "(missing)");
      continue;
    }
    for (const m of markers) {
      if (!sc.darkSvg.includes(m) && !sc.lightSvg.includes(m)) hudGaps.push(id + "(missing " + m + ")");
    }
  }
  r.ok(hudGaps.length === 0,
     "all upgraded gaming themes render their authentic HUD and sprite markers",
     hudGaps.join(", "));

  r.done();
});
