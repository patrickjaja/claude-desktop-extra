#!/usr/bin/env node
// Teach mode on KDE Wayland in kwin mode (sub-patch 7d of fix_computer_use_linux.nim).
//
// WHY THIS EXISTS
// ---------------
// Upstream turns teach mode off on every Wayland session: its teach overlay is
// an Electron click-through window (4.23118.1, main chunk):
//   Z2r=!WO()                                   CLICK_THROUGH_WINDOWS
//   function t3r(){return Z2r?f4r()?!0:(e3r??=wx(EU,"teachModeEnabled",!0,O()),e3r):!1}
//                                               getChicagoTeachModeEnabled
// so in kwin mode the teach tools were never listed and our bridge-backed teach
// path (sub-patch 7b, js/executor_linux.js showTeachStep, kwin-portal-bridge's
// overlay) never ran. 7d makes the first term
//   (Z2r||/*__cdbTeachKwin*/process.platform==="linux"&&globalThis.__cuKwinMode===!0&&globalThis.__linuxExecutor?.__teachOverlay===!0)
// and keeps the rest (the override, the server-side teachModeEnabled value).
//
// This harness pins:
//   [1] the pristine anchors: the getter once, its first term the
//       CLICK_THROUGH_WINDOWS key and `=!M()` with M the Wayland check; the
//       KWin executor advertises __teachOverlay: true.
//   [2] the compiled patch applies with the full counter, reports 7d, is
//       idempotent; the changed chunk passes node --check.
//   [3] Rule 6: a bundle with everything but 7d's rewrite is refused as
//       half-patched; a moved getter or a first term that is not the
//       click-through flag fails the build.
//   [4] the REAL patched getter in vm: Wayland + kwin mode + __teachOverlay
//       follows teachModeEnabled; kwin mode without the flag, wlroots / GNOME
//       (regular mode), non-Linux: off; X11 unchanged.
// Sections SKIP (exit 3) when the binary or the extract is missing.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, rmSync, accessSync, constants } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..", "..");
const PATCH_SRC = path.join(repo, "patches", "linux", "fix_computer_use_linux.nim");
const PATCH_BIN = process.env.CDB_CU_PATCH_BIN || path.join(repo, "patches", "linux", "fix_computer_use_linux");
const BUILD_DIR = path.join(process.env.CDB_BUNDLE_DIR || path.join(repo, "tmp", "app.asar.contents"), ".vite", "build");
const EXPECTED_PATCHES = Number(/const EXPECTED_PATCHES = (\d+)/.exec(readFileSync(PATCH_SRC, "utf8"))[1]);

let pass = 0;
const failures = [];
function check(label, actual, expected) {
  if (actual === expected) { console.log(`  PASS ${label} -> ${actual}`); pass++; }
  else { console.log(`  FAIL ${label} -> got ${actual}, expected ${expected}`); failures.push(label); }
}
const esc = (x) => x.replace(/[$]/g, "\\$");
const countRe = (hay, re) => (hay.match(new RegExp(re.source, "g")) || []).length;
const SPLIT_RE = /\n\/\*__CDB_SPLIT__([^*\n]+?)__\*\/\n/;
function splitParts(blob) {
  const pieces = blob.split(SPLIT_RE);
  const names = ["index.js"], bodies = [pieces[0]];
  for (let i = 1; i < pieces.length; i += 2) { names.push(pieces[i]); bodies.push(pieces[i + 1]); }
  return { names, bodies };
}
function functionSource(blob, name) {
  const start = blob.indexOf("function " + name + "(){");
  if (start < 0) return null;
  let depth = 0;
  for (let i = blob.indexOf("{", start); i < blob.length; i++) {
    if (blob[i] === "{") depth++;
    else if (blob[i] === "}" && --depth === 0) return blob.slice(start, i + 1);
  }
  return null;
}

const GETTER_RE = /function ([\w$]+)\(\)\{return ([\w$]+)\?([\w$]+)\(\)\?!0:\(([\w$]+)\?\?=([\w$]+)\(([\w$]+),(["'`])teachModeEnabled\7,!0,([\w$]+)\(\)\),\4\):!1\}/;
const PATCHED_RE = /function ([\w$]+)\(\)\{return\(([\w$]+)\|\|\/\*__cdbTeachKwin\*\/process\.platform==="linux"&&globalThis\.__cuKwinMode===!0&&globalThis\.__linuxExecutor\?\.__teachOverlay===!0\)\?([\w$]+)\(\)\?!0:\(([\w$]+)\?\?=([\w$]+)\(([\w$]+),(["'`])teachModeEnabled\7,!0,([\w$]+)\(\)\),\4\):!1\}/;

let skipped = false;
let haveBin = true;
try { accessSync(PATCH_BIN, constants.X_OK); } catch { haveBin = false; }
if (!haveBin || !existsSync(path.join(BUILD_DIR, "index.js"))) {
  skipped = true;
  console.log("\n  SKIP real-bundle sections: " + (haveBin ? "no extract under tmp/app.asar.contents/" : `${PATCH_BIN} is not compiled`));
} else {
  const scratch = mkdtempSync(path.join(tmpdir(), "cdb-cu-teach-gate-"));
  try {
    let blob = readFileSync(path.join(BUILD_DIR, "index.js"), "utf8");
    for (const c of readdirSync(BUILD_DIR).filter((d) => /^index.*\.chunk-.*\.js$/.test(d)).sort()) blob += "\n/*__CDB_SPLIT__" + c + "__*/\n" + readFileSync(path.join(BUILD_DIR, c), "utf8");
    const staged = path.join(scratch, "staged_index.js");
    writeFileSync(staged, blob);

    console.log("\n[1] pristine anchors");
    check("teach getter present once", countRe(blob, GETTER_RE), 1);
    const g = GETTER_RE.exec(blob) || [];
    const [, getter, ct] = g;
    check(`${ct} is the CLICK_THROUGH_WINDOWS key`, countRe(blob, new RegExp("CLICK_THROUGH_WINDOWS:\\(\\)=>" + esc(ct || "\u0000") + "[,}]")), 1);
    const def = new RegExp("(?<![\\w$.])" + esc(ct || "\u0000") + "=!([\\w$]+)\\(\\)", "g");
    const defs = [...blob.matchAll(def)];
    check(`${ct} defined once as =!M()`, defs.length, 1);
    const mo = defs[0]?.[1] || "\u0000";
    const moRe = new RegExp("(?<![\\w$.])" + esc(mo) + "=\\(\\)=>\\{let ([\\w$]+)=(?:[\\w$]+\\(\\)|process\\.env)\\.XDG_SESSION_TYPE;return \\1\\?\\1===([\"'`])wayland\\2:!!(?:[\\w$]+\\(\\)|process\\.env)\\.WAYLAND_DISPLAY\\}", "g");
    check(`${mo} is the XDG_SESSION_TYPE Wayland check`, [...blob.matchAll(moRe)].length, 1);
    check("no __cdbTeachKwin yet", blob.includes("__cdbTeachKwin"), false);
    const kwinSrc = readFileSync(path.join(repo, "js", "executor_linux.js"), "utf8");
    check("KWin executor advertises __teachOverlay: true next to __initTeachController", /__teachOverlay: true,\s*\n\s*__initTeachController\(/.test(kwinSrc), true);
    const pristine = splitParts(blob);
    const gIdx = pristine.bodies.findIndex((b) => GETTER_RE.test(b));

    console.log("\n[2] the compiled patch applies, then is idempotent");
    const run = (f) => { const r = spawnSync(PATCH_BIN, [f], { encoding: "utf8" }); return { status: r.status, out: String(r.stdout || "") + String(r.stderr || "") }; };
    const r1 = run(staged);
    check("first run exits 0", r1.status, 0);
    check("no [FAIL] line", /\[FAIL\]/.test(r1.out), false);
    check(`[PASS] ${EXPECTED_PATCHES}/${EXPECTED_PATCHES} reported`, r1.out.includes(`[PASS] ${EXPECTED_PATCHES}/${EXPECTED_PATCHES} sub-patches applied`), true);
    check("7d reported [OK]", new RegExp("\\[OK\\] 7d teach gate: " + esc(getter || "\u0000") + "\\(\\) also on in kwin mode with the bridge's teach overlay \\(" + esc(ct || "\u0000") + " = !" + esc(mo) + "\\(\\), 1 match\\)").test(r1.out), true);
    if (r1.status !== 0) console.log(r1.out);
    const patched = readFileSync(staged, "utf8");
    const r2 = run(staged);
    check("second run exits 0 and changes nothing", r2.status === 0 && readFileSync(staged, "utf8") === patched, true);
    check("patched getter present once", countRe(patched, PATCHED_RE), 1);
    check("pristine getter shape gone", countRe(patched, GETTER_RE), 0);
    check("marker /*__cdbTeachKwin*/ once", patched.split("/*__cdbTeachKwin*/").length - 1, 1);
    const after = splitParts(patched);
    const pIdx = after.bodies.findIndex((b) => PATCHED_RE.test(b));
    check("rewrite lands in the getter's own chunk", after.names[pIdx], pristine.names[gIdx]);
    if (pIdx >= 0) {
      const f = path.join(scratch, after.names[pIdx]);
      writeFileSync(f, after.bodies[pIdx]);
      let okc = true;
      try { execFileSync("node", ["--check", f], { stdio: "pipe" }); } catch { okc = false; }
      check(`node --check ${after.names[pIdx]}`, okc, true);
    }

    console.log("\n[3] Rule 6: no false success");
    const pm = PATCHED_RE.exec(patched);
    const half = path.join(scratch, "missing_7d.js");
    writeFileSync(half, pm ? patched.replace(pm[0], g[0]) : patched);
    const r3 = run(half);
    check("bundle without 7d: exits non-zero", r3.status !== 0, true);
    check("bundle without 7d: refused as half-patched, missing 7d", /half-patched input: .*missing: .*7d teach gate/.test(r3.out), true);
    const moved = path.join(scratch, "moved.js");
    writeFileSync(moved, blob.replace(g[0], g[0].replace("teachModeEnabled", "teachModeOn")));
    const r4 = run(moved);
    check("moved getter: [FAIL] 7d with 0 matches", /\[FAIL\] 7d teach gate .*: 0 matches, expected 1/.test(r4.out), true);
    check("moved getter: never [PASS]", /\[PASS\]/.test(r4.out), false);
    const notCt = path.join(scratch, "not_click_through.js");
    writeFileSync(notCt, blob.replace("CLICK_THROUGH_WINDOWS:()=>" + ct, "CLICK_THROUGH_WINDOWS:()=>" + ct + "x"));
    const r5 = run(notCt);
    check("first term not CLICK_THROUGH_WINDOWS: [FAIL] 7d names it", /\[FAIL\] 7d teach gate [\w$]+: [\w$]+ is not CLICK_THROUGH_WINDOWS/.test(r5.out), true);
    check("first term not CLICK_THROUGH_WINDOWS: exits non-zero", r5.status !== 0, true);

    console.log("\n[4] the REAL patched getter in vm");
    const src = functionSource(after.bodies[pIdx] || "", getter || "\u0000");
    const pristineSrc = functionSource(blob, getter || "\u0000");
    check("patched getter source extracted", !!src && src.includes("__cdbTeachKwin"), true);
    if (src && pristineSrc) {
      const [, , , ov, cache, wx, eu, , o] = PATCHED_RE.exec(src);
      const evalGetter = (body, s) => {
        const ctx = { process: { platform: s.platform || "linux" } };
        ctx.globalThis = ctx;
        ctx[ct] = !s.wayland; // Z2r = !WO()
        ctx[ov] = () => !!s.override;
        ctx[wx] = (_store, key, dflt) => (key === "teachModeEnabled" ? (s.server === undefined ? dflt : s.server) : dflt);
        ctx[eu] = {};
        ctx[o] = () => ({});
        if (s.kwin !== undefined) ctx.__cuKwinMode = s.kwin;
        if (s.overlay !== undefined) ctx.__linuxExecutor = { __teachOverlay: s.overlay };
        vm.createContext(ctx);
        vm.runInContext("var " + cache + ";" + body, ctx);
        return vm.runInContext(getter + "()", ctx);
      };
      const both = (label, s, want, wantPristine) => {
        check(`${label}: patched`, evalGetter(src, s), want);
        if (wantPristine !== undefined) check(`${label}: pristine`, evalGetter(pristineSrc, s), wantPristine);
      };
      both("KDE Wayland, kwin mode, overlay, server on -> on", { wayland: true, kwin: true, overlay: true }, true, false);
      both("KDE Wayland, kwin mode, overlay, server teachModeEnabled false -> off", { wayland: true, kwin: true, overlay: true, server: false }, false, false);
      both("KDE Wayland, kwin mode, overlay, override on -> on", { wayland: true, kwin: true, overlay: true, override: true, server: false }, true, false);
      both("kwin mode without __teachOverlay -> off", { wayland: true, kwin: true }, false, false);
      both("kwin mode, __teachOverlay 1 (not === true) -> off", { wayland: true, kwin: true, overlay: 1 }, false);
      both("wlroots / GNOME (regular mode), executor flag absent -> off", { wayland: true, kwin: false }, false, false);
      both("regular mode with an executor that says overlay -> still off (kwin only)", { wayland: true, kwin: false, overlay: true }, false, false);
      both("win32, Wayland-ish env, kwin globals set -> off (unchanged)", { platform: "win32", wayland: true, kwin: true, overlay: true }, false, false);
      both("X11, server on -> on (unchanged)", { wayland: false }, true, true);
      both("X11, server off -> off (unchanged)", { wayland: false, server: false }, false, false);
      both("darwin, server on -> on (unchanged)", { platform: "darwin", wayland: false }, true, true);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

console.log("");
if (failures.length) {
  console.log(`${failures.length} CHECK(S) FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
if (skipped) { console.log(`${pass} checks passed; real-bundle sections SKIPPED`); process.exit(3); }
console.log("ALL " + pass + " CHECKS PASSED");
