#!/usr/bin/env node
/*
 * test-theme-inherit-reload.mjs - main-process tests for the theme engine's three
 * config-side features (patches/core/add_feature_custom_themes.nim, GitHub issue #242):
 *
 *   - "extends" inheritance: a child theme lays its tokens over a base theme per mode
 *     and inherits the base's spinner/font/metadata; chains, aliases, cycles, depth
 *     limit and a missing base all degrade loudly instead of breaking the theme.
 *   - themes.d/: one theme per file next to the config, below both config files in
 *     precedence, parse errors per file.
 *   - reload() + the directory watcher: the file on disk is re-read and re-applied to
 *     every live window without persisting; identical output is a no-op; our own
 *     writes do not bounce; "themeWatch": false switches the watcher off.
 *
 * The engine really runs (electron shimmed, fake windows recording insertCSS /
 * executeJavaScript). The watcher checks use real inotify with short real waits: the
 * debounce is 300 ms, so every wait is well above that and well below anything flaky.
 * Bundled data (mario's tokens and spinner) is read back from the registry itself, so
 * re-authoring a palette does not move these assertions.
 *
 * Usage: node scripts/tests/core/test-theme-inherit-reload.mjs   (exit 3 = SKIP, 1 = FAIL)
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  installEngine, mkWc, pushedSpec, settle, reporter, runSuite,
} from "../lib/theme-engine-harness.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const DEBOUNCE_SETTLE = 700; // engine debounce is 300 ms
const V = (bg) => ({ "--bg-000": bg, "--accent-brand": "0 100% 50%" });
const SPIN = { viewBox: "0 0 10 10", animation: "spin", paths: [{ d: "M1 1 L9 9 Z" }] };

/** Write a config the way an external tool does: tmp file + rename (the case that kills file-level watches). */
function writeCfg(userData, obj, name = "claude-desktop-extra.jsonc") {
  const p = join(userData, name);
  writeFileSync(p + ".ext-tmp", JSON.stringify(obj, null, 2));
  renameSync(p + ".ext-tmp", p);
}
function attach(appEvents) {
  const wc = mkWc();
  appEvents["web-contents-created"]({}, wc);
  wc.fire("dom-ready");
  return wc;
}
const reloadLines = (diag) => diag.filter((m) => m.indexOf("[CustomThemes] reload (file watch") === 0);
const tokenRe = (k, v) => new RegExp(k.replace(/-/g, "\\-") + ":" + v.replace(/[%.]/g, "\\$&") + " !important");

await runSuite(async () => {
  const r = reporter("Theme engine (extends / themes.d / reload / watcher)");

  // ------------------------------------------------------------------ [1] extends
  r.section("[1] extends: a partial dark override on a built-in keeps the rest of the base");
  {
    const CONFIG = {
      activeTheme: "", themeWatch: false,
      themes: {
        "my-mario": { extends: "mario", dark: { "--accent-brand": "200 80% 60%" } },
        "base-a": { name: "Base A", category: "harness", chatFont: "serif", light: V("0 0% 99%"), dark: V("0 0% 1%"), spinner: SPIN },
        "child-a": { extends: "base-a", dark: { "--bg-000": "0 0% 2%" } },
        "child-font": { extends: "base-a", name: "Child Font", chatFont: "monospace", spinner: null },
        "child-flat": { extends: "base-a", "--accent-brand": "120 50% 50%" },
        "child-alias": { extends: "nordic", dark: { "--accent-brand": "1 2% 3%" } },
        "child-missing": { extends: "does-not-exist", dark: V("0 0% 7%") },
        "bare": { extends: "mario" },
      },
    };
    const { themes: T, appEvents, diag } = installEngine({ config: CONFIG });
    const by = {};
    T.list().forEach((e) => (by[e.name] = e));
    const mario = by["mario"], mm = by["my-mario"];
    r.ok(T.version === 2 && typeof T.reload === "function" && typeof T.themesDir === "string",
       "registry is version 2 with reload() and themesDir", JSON.stringify({ v: T.version, td: T.themesDir }));
    r.ok(mm && mm.dark["--accent-brand"] === "200 80% 60%", "child's dark override wins");
    r.ok(mm && mm.dark["--bg-000"] === mario.dark["--bg-000"] && mm.dark["--text-000"] === mario.dark["--text-000"],
       "the base's other dark tokens survive", mm && mm.dark["--bg-000"]);
    r.ok(mm && JSON.stringify(mm.light) === JSON.stringify(mario.light), "light mode is inherited untouched");
    r.ok(mm && !mm.category && mm.source === "custom", "category not inherited (lands under Your themes), source stays custom",
       mm && JSON.stringify({ c: mm.category, s: mm.source }));
    r.ok(mario.dark["--accent-brand"] !== "200 80% 60%", "the built-in itself is not mutated");
    r.ok(by["bare"] && JSON.stringify(by["bare"].dark) === JSON.stringify(mario.dark),
       "a theme that is ONLY extends is a complete theme");

    const wc = attach(appEvents);
    const ap = T.apply("my-mario");
    await settle();
    r.ok(ap.ok === true, "apply('my-mario') builds", JSON.stringify(ap));
    r.ok(wc.css.length === 1 && tokenRe("--accent-brand", "200 80% 60%").test(wc.sheet()),
       "the sheet carries the override");
    r.ok(tokenRe("--bg-000", mario.dark["--bg-000"]).test(wc.sheet()), "and the base's bg token");
    const marioSpec = pushedSpec(wc);
    r.ok(marioSpec && marioSpec.paths && marioSpec.paths.length > 0, "mario's spinner is pushed for the child");

    r.ok(by["child-a"].displayName === "Child A" && !by["child-a"].category,
       "name and category are not inherited (user theme stays under Your themes)",
       JSON.stringify({ d: by["child-a"].displayName, c: by["child-a"].category }));
    r.ok(by["child-a"].dark["--bg-000"] === "0 0% 2%" && by["child-a"].dark["--accent-brand"] === "0 100% 50%" &&
         by["child-a"].light["--bg-000"] === "0 0% 99%", "dual-variant child merges per mode");
    r.ok(T.apply("child-a").ok === true, "apply('child-a') ok");
    await settle();
    r.ok(JSON.stringify(pushedSpec(wc)) === JSON.stringify(SPIN), "spinner inherited from a user base");
    r.ok(/font-family:serif!important/.test(wc.sheet()), "chatFont inherited from the base");
    r.ok(T.apply("child-font").ok === true, "apply('child-font') ok");
    await settle();
    r.ok(/font-family:monospace!important/.test(wc.sheet()) && !/font-family:serif/.test(wc.sheet()),
       "the child's own chatFont wins over the base's");
    r.ok(by["child-font"].displayName === "Child Font", "the child's own name wins");
    r.ok(by["child-flat"].light["--accent-brand"] === "120 50% 50%" && by["child-flat"].dark["--accent-brand"] === "120 50% 50%" &&
         by["child-flat"].dark["--bg-000"] === "0 0% 1%", "a legacy flat child merges into both modes");
    r.ok(by["child-alias"] && by["child-alias"].dark["--accent-brand"] === "1 2% 3%" &&
         by["child-alias"].light["--bg-000"] === by["nord"].light["--bg-000"],
       "extends resolves aliases (nordic -> nord)");
    r.ok(by["child-missing"] && by["child-missing"].dark["--bg-000"] === "0 0% 7%" && by["child-missing"].light["--bg-000"] === "0 0% 7%",
       "a missing base degrades to 'no base' (dark reused for light)");
    r.ok(diag.some((m) => /extends unknown theme 'does-not-exist'/.test(m)), "and is logged",
       diag.filter((m) => /does-not-exist/.test(m))[0]);
  }

  // ------------------------------------------------------------ [2] chain + guards
  r.section("[2] extends: chains, cycle guard, depth limit");
  {
    const themes = {
      "root": { light: { "--bg-000": "0 0% 90%", "--bg-100": "0 0% 91%", "--bg-200": "0 0% 92%" }, dark: { "--bg-000": "0 0% 10%", "--bg-100": "0 0% 11%", "--bg-200": "0 0% 12%" }, spinner: SPIN },
      "mid": { extends: "root", dark: { "--bg-100": "0 0% 21%" } },
      "leaf": { extends: "mid", dark: { "--bg-200": "0 0% 32%" } },
      "cyc-a": { extends: "cyc-b", dark: { "--bg-000": "0 0% 41%" } },
      "cyc-b": { extends: "cyc-a", dark: { "--bg-100": "0 0% 42%" } },
      "self": { extends: "self", dark: V("0 0% 5%") },
    };
    // A chain of 12 on top of root: only the nearest 8 bases may contribute.
    let prev = "root";
    for (let i = 0; i < 12; i++) {
      themes["deep-" + i] = { extends: prev, dark: { ["--deep-" + i]: "1 1% 1%" } };
      prev = "deep-" + i;
    }
    const { themes: T, diag } = installEngine({ config: { activeTheme: "", themeWatch: false, themes } });
    const by = {};
    T.list().forEach((e) => (by[e.name] = e));
    r.ok(by["leaf"].dark["--bg-000"] === "0 0% 10%" && by["leaf"].dark["--bg-100"] === "0 0% 21%" && by["leaf"].dark["--bg-200"] === "0 0% 32%",
       "three-level chain: nearest definition wins per token", JSON.stringify(by["leaf"].dark));
    r.ok(by["leaf"].light["--bg-000"] === "0 0% 90%", "light mode flows through the chain");
    r.ok(T.apply("leaf").ok === true, "apply('leaf') ok");
    r.ok(by["cyc-a"] && by["cyc-a"].dark["--bg-000"] === "0 0% 41%" && by["cyc-a"].dark["--bg-100"] === "0 0% 42%",
       "a two-theme cycle still yields both themes' own tokens", JSON.stringify(by["cyc-a"] && by["cyc-a"].dark));
    r.ok(by["self"] && by["self"].dark["--bg-000"] === "0 0% 5%", "self-extends is a valid theme");
    r.ok(diag.some((m) => /cycle/.test(m)), "cycles are logged", diag.filter((m) => /cycle/.test(m))[0]);
    r.ok(T.apply("cyc-a").ok === true && T.apply("self").ok === true, "cyclic themes apply without throwing");
    const top = by["deep-11"];
    r.ok(top && top.dark["--deep-11"] === "1 1% 1%" && top.dark["--deep-4"] === "1 1% 1%",
       "depth: the 8 nearest bases contribute");
    r.ok(top && top.dark["--deep-3"] === "1 1% 1%" && top.dark["--deep-2"] === undefined && top.dark["--bg-000"] === undefined,
       "depth: the 9th base and beyond are cut off", JSON.stringify(top && Object.keys(top.dark)));
    r.ok(diag.some((m) => /chain deeper than 8/.test(m)), "the depth cut is logged");
  }

  // ------------------------------------------------------------------ [3] themes.d
  r.section("[3] themes.d/: one theme per file, wrapper form, precedence, bad files");
  {
    const files = {
      "themes.d/matugen.json": JSON.stringify({ dark: V("0 0% 13%"), light: V("0 0% 93%") }),
      "themes.d/pack.jsonc": '{\n  // two themes in one wrapper file\n  "themes": {\n    "pack-one": {"dark": {"--bg-000": "0 0% 14%"}, "light": {"--bg-000": "0 0% 94%"},},\n    "pack-two": {"extends": "matugen", "dark": {"--accent-brand": "10 10% 10%"}},\n  },\n}\n',
      "themes.d/shadowed.json": JSON.stringify({ dark: V("0 0% 15%") }),
      "themes.d/shadowed-json.json": JSON.stringify({ dark: V("0 0% 16%") }),
      "themes.d/nord.json": JSON.stringify({ dark: V("0 0% 17%") }),
      "themes.d/broken.json": "{ this is not json",
      "themes.d/notes.txt": "ignored",
      "themes.d/list.json": "[1,2,3]",
      "claude-desktop-extra.json": JSON.stringify({ themes: { "shadowed": { dark: V("0 0% 25%") }, "shadowed-json": { dark: V("0 0% 26%") } } }),
    };
    const config = { activeTheme: "matugen", themeWatch: false, themes: { "shadowed": { dark: V("0 0% 35%") } } };
    const { themes: T, appEvents, diag, userData } = installEngine({ config, files });
    const by = {};
    T.list().forEach((e) => (by[e.name] = e));
    r.ok(T.themesDir === join(userData, "themes.d"), "registry exposes themesDir", T.themesDir);
    r.ok(by["matugen"] && by["matugen"].source === "custom" && by["matugen"].dark["--bg-000"] === "0 0% 13%",
       "a bare theme object file is a theme named after the file stem");
    r.ok(by["pack-one"] && by["pack-one"].dark["--bg-000"] === "0 0% 14%", "a {themes:{...}} wrapper file contributes its inner names");
    r.ok(!by["pack"], "the wrapper file's stem is not itself a theme");
    r.ok(by["pack-two"] && by["pack-two"].dark["--bg-000"] === "0 0% 13%" && by["pack-two"].dark["--accent-brand"] === "10 10% 10%",
       "a themes.d theme can extend another themes.d theme");
    r.ok(by["shadowed"].dark["--bg-000"] === "0 0% 35%", ".jsonc theme beats .json and themes.d for the same name");
    r.ok(by["shadowed-json"].dark["--bg-000"] === "0 0% 26%", ".json theme beats themes.d for the same name");
    r.ok(by["nord"].source === "custom" && by["nord"].dark["--bg-000"] === "0 0% 17%", "themes.d beats a built-in of the same name");
    r.ok(!by["notes"] && !by["list"] && !by["broken"], "non-json, array and unparsable files add no theme");
    r.ok(diag.some((m) => /Error parsing .*broken\.json/.test(m)), "the parse error is logged per file",
       diag.filter((m) => /broken/.test(m))[0]);
    r.ok(diag.some((m) => /list\.json: not a theme object/.test(m)), "a non-object file is logged");
    const wc = attach(appEvents);
    await settle();
    r.ok(T.active() === "matugen" && wc.css.length === 1 && tokenRe("--bg-000", "0 0% 13%").test(wc.sheet()),
       "a themes.d theme can be the startup activeTheme");
  }

  // -------------------------------------------------------------------- [4] reload
  r.section("[4] reload(): no-op when nothing changed, re-applies when the file changed, never persists");
  {
    const cfgOf = (active, extra) => Object.assign({
      activeTheme: active, themeWatch: false,
      themes: {
        "harness-a": { light: V("0 0% 100%"), dark: V("0 0% 4%"), spinner: SPIN },
        "harness-b": { light: V("0 0% 98%"), dark: V("0 0% 6%") },
      },
    }, extra || {});
    const { themes: T, appEvents, diag, userData } = installEngine({ config: cfgOf("harness-a") });
    const wc = attach(appEvents);
    await settle();
    r.ok(wc.css.length === 1 && T.active() === "harness-a", "startup applied harness-a");

    let res = T.reload("test: untouched");
    await settle();
    r.ok(res.ok === true && res.changed === false && res.name === "harness-a", "unchanged file -> changed:false", JSON.stringify(res));
    r.ok(wc.css.length === 1 && wc.removedKeys.length === 0, "and no window was touched");

    writeCfg(userData, cfgOf("harness-b"));
    const before = readFileSync(join(userData, "claude-desktop-extra.jsonc"), "utf8");
    res = T.reload("test: switched");
    await settle();
    r.ok(res.ok === true && res.changed === true && res.name === "harness-b" && res.windows === 1,
       "new activeTheme on disk -> changed:true, windows:1", JSON.stringify(res));
    r.ok(wc.css.length === 2 && wc.removedKeys.length === 1 && tokenRe("--bg-000", "0 0% 6%").test(wc.sheet()),
       "the window got the new sheet");
    r.ok(pushedSpec(wc) === null && T.active() === "harness-b", "spinner re-pushed (null for a spinner-less theme), active() follows");
    r.ok(readFileSync(join(userData, "claude-desktop-extra.jsonc"), "utf8") === before, "reload did not write the config back");
    r.ok(diag.some((m) => /reload \(test: switched\): applied 'harness-b' to 1 window\(s\)/.test(m)), "reload logs the switch");

    // Same name, a token edited in place: still a change.
    const edited = cfgOf("harness-b");
    edited.themes["harness-b"].dark["--bg-000"] = "0 0% 66%";
    writeCfg(userData, edited);
    res = T.reload("test: token edit");
    await settle();
    r.ok(res.ok === true && res.changed === true && tokenRe("--bg-000", "0 0% 66%").test(wc.sheet()),
       "editing the active theme's tokens in place re-applies", JSON.stringify(res));

    writeCfg(userData, cfgOf("no-such-theme"));
    res = T.reload("test: unknown");
    r.ok(res.ok === false && /no-such-theme/.test(res.error), "unknown activeTheme -> {ok:false,error}", JSON.stringify(res));
    r.ok(T.active() === "harness-b" && wc.css.length === 3, "and the previous theme stays applied");

    writeCfg(userData, cfgOf(""));
    res = T.reload("test: revert");
    await settle();
    r.ok(res.ok === true && res.changed === true && res.name === null && T.active() === null, "empty activeTheme -> stock, not persisted",
       JSON.stringify(res));
    r.ok(wc.removedKeys.length === 3 && wc.css.length === 3, "the sheet was removed and nothing inserted");
    res = T.reload("test: still stock");
    r.ok(res.ok === true && res.changed === false && res.name === null, "stock twice is a no-op", JSON.stringify(res));
  }

  // -------------------------------------------------------------------- [5] watcher
  r.section("[5] watcher: external tmp+rename writes re-theme live, debounced, self-writes ignored");
  {
    const cfgOf = (active) => ({
      activeTheme: active,
      themes: {
        "harness-a": { light: V("0 0% 100%"), dark: V("0 0% 4%") },
        "harness-b": { light: V("0 0% 98%"), dark: V("0 0% 6%") },
        "harness-c": { light: V("0 0% 97%"), dark: V("0 0% 8%") },
      },
    });
    const { themes: T, appEvents, diag, userData } = installEngine({ config: cfgOf("harness-a") });
    r.ok(diag.some((m) => m === "[CustomThemes] watching " + userData + " for config changes (themeWatch)"),
       "startup logs the watched directory");
    const wc = attach(appEvents);
    await settle();

    writeCfg(userData, cfgOf("harness-b"));
    await wait(DEBOUNCE_SETTLE);
    r.ok(T.active() === "harness-b" && tokenRe("--bg-000", "0 0% 6%").test(wc.sheet()),
       "an external tmp+rename write of the .jsonc re-themes the live window", T.active());
    r.ok(reloadLines(diag).length === 1 && /file watch: claude-desktop-extra\.jsonc/.test(reloadLines(diag)[0]),
       "exactly one reload, attributed to the file", JSON.stringify(reloadLines(diag)));

    // Debounce: three writes inside the window collapse into one reload.
    writeCfg(userData, cfgOf("harness-a"));
    await wait(50);
    writeCfg(userData, cfgOf("harness-b"));
    await wait(50);
    writeCfg(userData, cfgOf("harness-c"));
    await wait(DEBOUNCE_SETTLE);
    r.ok(T.active() === "harness-c", "the last write wins", T.active());
    r.ok(reloadLines(diag).length === 2, "three rapid writes -> one more reload, not three", JSON.stringify(reloadLines(diag).length));
    const cssBefore = wc.css.length;

    // The legacy .json file is watched too. Its theme is not active yet, so the first
    // write must reload into an identical state (no window touched); activating it
    // through the .jsonc then proves the .json theme really arrived.
    const pre = reloadLines(diag).length, cssPre = wc.css.length;
    writeCfg(userData, { themes: { "harness-c": { dark: V("0 0% 55%") }, "json-only": { dark: V("0 0% 77%") } } }, "claude-desktop-extra.json");
    await wait(DEBOUNCE_SETTLE);
    r.ok(reloadLines(diag).length === pre && wc.css.length === cssPre,
       "a .json write that changes nothing visible is a silent no-op reload", String(reloadLines(diag).length - pre));
    r.ok(T.list().some((e) => e.name === "json-only"), "but the .json theme is now listed");
    writeCfg(userData, cfgOf("json-only"));
    await wait(DEBOUNCE_SETTLE);
    r.ok(T.active() === "json-only" && tokenRe("--bg-000", "0 0% 77%").test(wc.sheet()),
       "a theme that lives only in .json can be activated", T.active());
    r.ok(!tokenRe("--bg-000", "0 0% 55%").test(wc.sheet()) && T.list().find((e) => e.name === "harness-c").dark["--bg-000"] === "0 0% 8%",
       ".jsonc's harness-c still shadows the .json one");

    // Self-write guard: apply() persists via __cdb_writeFile; that write must not bounce.
    const pre2 = reloadLines(diag).length, css2 = wc.css.length;
    r.ok(T.apply("harness-b").ok === true, "apply('harness-b') persists");
    await wait(DEBOUNCE_SETTLE);
    r.ok(reloadLines(diag).length === pre2, "our own persist does not trigger a reload", String(reloadLines(diag).length - pre2));
    r.ok(wc.css.length === css2 + 1, "the window was styled exactly once (by apply)", JSON.stringify({ before: css2, after: wc.css.length }));

    // themes.d appearing AFTER startup is watched lazily. First let the 1.5 s self-write
    // window opened by apply() expire, so the external config edit below is not treated
    // as ours.
    await wait(1000);
    const td = join(userData, "themes.d");
    mkdirSync(td);
    writeFileSync(join(td, "late.json"), JSON.stringify({ dark: V("0 0% 21%"), light: V("0 0% 91%") }));
    await wait(DEBOUNCE_SETTLE);
    r.ok(T.list().some((e) => e.name === "late"), "a themes.d/ created after boot is read");
    writeCfg(userData, cfgOf("late"));
    await wait(DEBOUNCE_SETTLE);
    r.ok(T.active() === "late" && tokenRe("--bg-000", "0 0% 21%").test(wc.sheet()), "and its theme can be activated by a config edit", T.active());
    const pre3 = reloadLines(diag).length;
    writeFileSync(join(td, "late.json.tmp"), JSON.stringify({ dark: V("0 0% 22%"), light: V("0 0% 92%") }));
    renameSync(join(td, "late.json.tmp"), join(td, "late.json"));
    await wait(DEBOUNCE_SETTLE);
    r.ok(tokenRe("--bg-000", "0 0% 22%").test(wc.sheet()), "editing the active themes.d file re-themes live (lazy themes.d watcher)");
    r.ok(reloadLines(diag).length === pre3 + 1 && /file watch: themes\.d\/late\.json/.test(reloadLines(diag)[pre3]),
       "attributed to themes.d/late.json", JSON.stringify(reloadLines(diag).slice(pre3)));
    r.ok(cssBefore < wc.css.length, "sanity: sheets were re-inserted over the run");
  }

  // ------------------------------------------------------------- [6] themeWatch:false
  r.section("[6] themeWatch:false disables the watcher; reload() still works on demand");
  {
    const cfgOf = (active) => ({
      activeTheme: active, themeWatch: false,
      themes: { "harness-a": { dark: V("0 0% 4%") }, "harness-b": { dark: V("0 0% 6%") } },
    });
    const { themes: T, appEvents, diag, userData, nativeTheme } = installEngine({ config: cfgOf("harness-a") });
    r.ok(diag.some((m) => m === "[CustomThemes] watcher disabled (themeWatch:false)"), "startup logs the opt-out");
    r.ok(!diag.some((m) => /watching .* for config changes/.test(m)), "and no watching line");
    const wc = attach(appEvents);
    await settle();
    writeCfg(userData, cfgOf("harness-b"));
    await wait(DEBOUNCE_SETTLE);
    r.ok(T.active() === "harness-a" && reloadLines(diag).length === 0, "an external write changes nothing", T.active());
    const res = T.reload("manual");
    await settle();
    r.ok(res.ok === true && res.changed === true && T.active() === "harness-b", "reload() on demand still applies it", JSON.stringify(res));
    r.ok(wc.css.length === 2, "and the window got the sheet");

    // A half-saved / broken main config must not tear the current theme down.
    const jsoncPath = join(userData, "claude-desktop-extra.jsonc");
    const goodJsonc = readFileSync(jsoncPath, "utf8");
    writeFileSync(jsoncPath, '{ "activeTheme": "harness-b", oops');
    let res2 = T.reload("test: broken jsonc");
    r.ok(res2.ok === false && /syntax error/.test(res2.error) && T.active() === "harness-b",
       "broken .jsonc -> reload refuses and keeps the current theme", JSON.stringify(res2));
    writeFileSync(jsoncPath, goodJsonc);
    // ...while a broken themes.d drop-in is skipped and does not block reloads.
    mkdirSync(join(userData, "themes.d"), { recursive: true });
    writeFileSync(join(userData, "themes.d", "zz-broken.json"), "{ nope");
    res2 = T.reload("test: broken themes.d file");
    r.ok(res2.ok === true && res2.changed === false, "broken themes.d file is skipped, reload still ok", JSON.stringify(res2));

    // "hidden": true keeps a theme out of the picker list but it stays resolvable.
    writeFileSync(join(userData, "themes.d", "ov-hidden.json"), JSON.stringify({ hidden: true, dark: V("0 0% 9%") }));
    writeFileSync(join(userData, "themes.d", "harness-a.json"), JSON.stringify({ hidden: true, dark: V("0 0% 5%") }));
    const names = T.list().map((e) => e.name);
    r.ok(!names.includes("ov-hidden"), "hidden themes.d theme is not listed", JSON.stringify(names));
    r.ok(names.includes("harness-a") && !names.includes(undefined), "a visible config theme of the same name still lists once (no holes)", JSON.stringify(names));
    writeCfg(userData, Object.assign(cfgOf("harness-b"), { themeOverlay: "ov-hidden" }));
    res2 = T.reload("test: hidden overlay");
    r.ok(res2.ok === true && res2.overlay === "ov-hidden" && tokenRe("--bg-000", "0 0% 9%").test(wc.sheet()), "hidden theme still works as themeOverlay", JSON.stringify(res2));

    // :root fallback follows the effective app mode (window shell documents have no data-mode).
    r.ok(!/:root:not\(\[data-mode=light\]\)/.test(wc.sheet()), "light mode: no dark :root fallback block");
    nativeTheme.shouldUseDarkColors = true;
    nativeTheme.emit("updated");
    await wait(150);
    r.ok(/:root:not\(\[data-mode=light\]\)\{[^}]*--bg-000:0 0% 9%/.test(wc.sheet()), "dark mode: :root fallback carries the dark variant (with overlay)", wc.sheet().slice(-200));
    r.ok(diag.some((m) => /reload \(nativeTheme dark\): applied/.test(m)), "attributed to nativeTheme", JSON.stringify(diag.filter((m) => /nativeTheme/.test(m))));
    nativeTheme.shouldUseDarkColors = false;
    nativeTheme.emit("updated");
    await wait(150);
    r.ok(!/:root:not\(\[data-mode=light\]\)/.test(wc.sheet()), "back to light: fallback block removed again");

    // The frameless main window's own background follows the theme (upstream paints stock white/gray).
    const shell = mkWc("file:///usr/lib/claude-desktop/resources/app.asar/.vite/renderer/main_window/index.html");
    appEvents["web-contents-created"]({}, shell); shell.fire("dom-ready");
    await settle();
    r.ok(shell.win.bg.slice(-1)[0] === "#171717", "shell window painted with the theme chrome color (overlay --bg-000 0 0% 9% -> #171717)", JSON.stringify(shell.win.bg));
    r.ok(wc.win.bg.length === 0, "content view window is left alone", JSON.stringify(wc.win.bg));
    nativeTheme.shouldUseDarkColors = true;
    nativeTheme.emit("updated");
    await wait(150);
    r.ok(shell.win.bg.length >= 2 && shell.win.bg.slice(-1)[0] === "#171717", "repainted after a nativeTheme flip", JSON.stringify(shell.win.bg));
    T.apply("");
    await settle();
    r.ok(shell.win.bg.slice(-1)[0] === "#151515", "stock revert repaints the stock dark window color", JSON.stringify(shell.win.bg));
    nativeTheme.shouldUseDarkColors = false;
  }

  // ------------------------------------------------------------------ [7] overlay
  r.section("[7] themeOverlay: tokens laid over whatever theme is active; never listed, never persisted");
  {
    const SPIN2 = { viewBox: "0 0 10 10", animation: "bounce", paths: [{ d: "M2 2 L8 8 Z" }] };
    const OV = { light: { "--accent-brand": "301 50% 50%" }, dark: { "--accent-brand": "300 50% 50%", "--bg-000": "300 10% 10%" }, spinner: SPIN2, chatFont: "cursive", name: "Ov" };
    const cfgOf = (active, extra) => Object.assign({ activeTheme: active, themeWatch: false, themes: { "acc": OV } }, extra || {});
    const darkBlock = (sheet) => sheet.slice(sheet.indexOf(".darkTheme,"));
    const lightBlock = (sheet) => sheet.slice(0, sheet.indexOf(".darkTheme,"));
    const { themes: T, appEvents, diag, userData } = installEngine({ config: cfgOf("mario", { themeOverlay: "acc" }) });
    const by = {};
    T.list().forEach((e) => (by[e.name] = e));
    const mario = by["mario"];
    const wc = attach(appEvents);
    await settle();
    r.ok(typeof T.overlay === "function" && T.overlay() === "acc" && T.active() === "mario", "overlay() reports the active overlay",
       JSON.stringify({ o: T.overlay(), a: T.active() }));
    r.ok(wc.css.length === 1 && tokenRe("--accent-brand", "300 50% 50%").test(darkBlock(wc.sheet())) &&
         tokenRe("--accent-brand", "301 50% 50%").test(lightBlock(wc.sheet())), "overlay tokens win per mode");
    r.ok(tokenRe("--bg-000", "300 10% 10%").test(darkBlock(wc.sheet())) && tokenRe("--bg-000", mario.light["--bg-000"]).test(lightBlock(wc.sheet())),
       "a mode the overlay leaves alone keeps the base's token");
    r.ok(tokenRe("--text-000", mario.dark["--text-000"]).test(darkBlock(wc.sheet())), "the base's other tokens survive");
    const spec = pushedSpec(wc);
    r.ok(spec && spec.paths && spec.paths.length > 0 && JSON.stringify(spec) !== JSON.stringify(SPIN2) && spec.paths[0].d !== SPIN2.paths[0].d,
       "the base's spinner is kept, the overlay's ignored", spec && spec.paths[0].d.slice(0, 20));
    r.ok(!/font-family:cursive/.test(wc.sheet()), "the overlay's chatFont is ignored");
    r.ok(diag.some((m) => /Overlay 'acc' merged over 'mario' \(1 light, 2 dark token\(s\)\)/.test(m)), "the merge is logged",
       diag.filter((m) => /Overlay/.test(m)).pop());
    r.ok(by["mario"].dark["--accent-brand"] !== "300 50% 50%" && by["acc"] && by["acc"].source === "custom",
       "list() is untouched: base entries unmodified, the overlay theme listed as an ordinary theme");

    r.ok(T.apply("nord").ok === true, "apply('nord') ok");
    await settle();
    r.ok(T.active() === "nord" && T.overlay() === "acc" && tokenRe("--accent-brand", "300 50% 50%").test(darkBlock(wc.sheet())) &&
         tokenRe("--bg-100", by["nord"].dark["--bg-100"]).test(darkBlock(wc.sheet())), "switching the base keeps the overlay");
    r.ok(!/themeOverlay/.test(readFileSync(join(userData, "claude-desktop-extra.jsonc"), "utf8").replace(/"themeOverlay": "acc"/, "")),
       "persist wrote activeTheme only (the overlay key is untouched, not duplicated)");
    r.ok(/"themeOverlay": "acc"/.test(readFileSync(join(userData, "claude-desktop-extra.jsonc"), "utf8")), "the existing overlay key survived the persist");

    // Overlay from a themes.d file, then edited, then the key removed.
    const td = join(userData, "themes.d");
    mkdirSync(td);
    writeFileSync(join(td, "ov.json"), JSON.stringify({ dark: { "--accent-brand": "40 40% 40%" } }));
    writeCfg(userData, cfgOf("nord", { themeOverlay: "ov" }));
    let res = T.reload("test: themes.d overlay");
    await settle();
    r.ok(res.ok === true && res.changed === true && res.overlay === "ov" && tokenRe("--accent-brand", "40 40% 40%").test(darkBlock(wc.sheet())),
       "an overlay from themes.d applies via reload()", JSON.stringify(res));
    writeFileSync(join(td, "ov.json"), JSON.stringify({ dark: { "--accent-brand": "41 41% 41%" } }));
    res = T.reload("test: overlay edited");
    await settle();
    r.ok(res.ok === true && res.changed === true && tokenRe("--accent-brand", "41 41% 41%").test(darkBlock(wc.sheet())),
       "editing the overlay file -> changed:true", JSON.stringify(res));
    res = T.reload("test: nothing changed");
    r.ok(res.ok === true && res.changed === false && res.overlay === "ov", "no-op reload still reports the overlay", JSON.stringify(res));
    writeCfg(userData, cfgOf("nord"));
    res = T.reload("test: overlay removed");
    await settle();
    r.ok(res.ok === true && res.changed === true && res.overlay === null && T.overlay() === null &&
         tokenRe("--accent-brand", by["nord"].dark["--accent-brand"]).test(darkBlock(wc.sheet())),
       "removing the key -> changed:true, tokens back to the base", JSON.stringify(res));

    // Missing overlay name: logged, base still applied.
    writeCfg(userData, cfgOf("nord", { themeOverlay: "no-such-overlay" }));
    res = T.reload("test: missing overlay");
    r.ok(res.ok === true && res.overlay === null && T.active() === "nord", "a missing overlay theme is skipped, the base stays", JSON.stringify(res));
    r.ok(diag.some((m) => /themeOverlay 'no-such-overlay' is not a user, built-in, or community theme; ignoring the overlay/.test(m)), "and logged");

    // No active theme: the overlay alone applies nothing.
    const e2 = installEngine({ config: cfgOf("", { themeOverlay: "acc" }) });
    const wc2 = attach(e2.appEvents);
    await settle();
    r.ok(e2.themes.active() === null && e2.themes.overlay() === null && wc2.css.length === 0, "no activeTheme + overlay -> stock look, nothing injected",
       JSON.stringify({ css: wc2.css.length }));
  }

  r.done();
});
