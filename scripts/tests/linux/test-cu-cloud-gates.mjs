#!/usr/bin/env node
// Upstream's own Computer Use gates over our executors (issue #326).
//
// WHY THIS EXISTS
// ---------------
// Cloud Cowork, Dispatch and chat-linked sessions (and teach mode) run
// upstream's own dispatcher against our executor (js/cu_linux_executor.js in
// regular mode, js/executor_linux.js in kwin mode). Upstream's click gate reads
// executor.capabilities.hitTest: without "none" it asks appUnderPoint and
// takes null for the desktop shell, so on a backend without a hit test (GNOME
// without Introspect, niri / river) every click was refused; its key gate took
// a null getFrontmostApp() for "no app is frontmost (focus anomaly)"; and
// screenshot() returned no displayId / width / height, so a computer_batch
// screenshot was "display undefined" and the next click "could not be scaled".
// The fix answers upstream's whole-screen rules as its own Wayland executor
// does (hitTest "none", the Screen pseudo-app, Claude's window / dialog), gives
// cloud sessions the "Entire screen" pseudo-grant (sub-patch 16f) under the
// same predicate local sessions follow (16d), exposes upstream's
// "a Claude dialog is open" predicate (17f), and returns upstream's
// ScreenshotResult shape.
//
// This harness drives upstream's REAL dispatcher (the chunk holding its click
// and key gates, found by its refusal strings) against our REAL executors with
// fake bridges per session row and pins:
//   [B] the bundle anchors: the dispatcher, the Screen id literal it uses, the
//       dialog suffix its key gate tests, upstream's own Wayland executor's
//       getFrontmostApp shape (what ours mirrors), the cloud context.
//   [P] the compiled patch: 16f / 17f / 17g [OK], full counter, idempotent, the
//       patched cloud expression resolving to upstream's grant class / tier
//       order / Screen id, half-patched and moved-anchor refusals, node --check.
//   [E] __cdbCuWithScreenGrant == upstream's own local rule (`ye`, evaluated
//       from the bundle) over grant lists; nothing without a whole-screen
//       backend.
//   [R] per row (GNOME without / with Introspect, niri-like wlroots without
//       geometry, sway with geometry, X11): capabilities.hitTest (exec-free),
//       getFrontmostApp / getKeyFocusApp, the "no window info" line, and
//       upstream's dispatcher for click / type / key / batch over the
//       scenarios: approved app, read-tier grant, Claude's window focused,
//       Claude dialog open, no grant, unapproved app in front / under the
//       pointer, desktop under the pointer.
//   [S] the batch screenshot then click on two monitors, screenshot()'s shape
//       and its default display (GNOME: the monitor shared in the portal).
//   [K] kwin mode: unchanged per-app gate, screenshot shape.
//   [C] the Code-tab gate (js/cu_consent.js) gives the same answers as the
//       released executor on GNOME and niri; the access texts.
// GNOME fixtures are the real gnome-portal-bridge answers from a nested
// headless GNOME Shell 51.1 (Introspect refused: windows [], frontmost-app
// null, app-under-point null, doctor introspect_available false).
//
// CU_EXECUTOR / CU_CONSENT / CU_KWIN_EXECUTOR point at other sources (e.g. a
// released version); CDB_BUNDLE_DIR at an extract; CDB_CU_PATCH_BIN at another
// compiled patch. Sections [B] [P] [E] [R] [S] [K] need the extract (they
// load upstream's dispatcher) and SKIP without it; [P] also needs the binary.
// No child process is left behind (the fake bridges are in-process); temp
// dirs are removed on exit and on signals.
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, rmSync, accessSync, constants } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..", "..");
const SKIP_EXIT = 3;
const EXEC = process.env.CU_EXECUTOR || path.join(repo, "js", "cu_linux_executor.js");
const CONSENT = process.env.CU_CONSENT || path.join(repo, "js", "cu_consent.js");
const KWIN = process.env.CU_KWIN_EXECUTOR || path.join(repo, "js", "executor_linux.js");
const DISPLAY_TARGET = path.join(repo, "js", "cu_display_target.js");
const PATCH_SRC = path.join(repo, "patches", "linux", "fix_computer_use_linux.nim");
const PATCH_BIN = process.env.CDB_CU_PATCH_BIN || path.join(repo, "patches", "linux", "fix_computer_use_linux");
const BUILD_DIR = path.join(process.env.CDB_BUNDLE_DIR || path.join(repo, "tmp", "app.asar.contents"), ".vite", "build");
const EXPECTED_PATCHES = Number(/const EXPECTED_PATCHES = (\d+)/.exec(readFileSync(PATCH_SRC, "utf8"))[1]);
const SCREEN = "com.anthropic.cu.screen";
const HOST = "com.anthropic.Claude";
const nodeRequire = createRequire(import.meta.url);

const tmpDirs = [];
function cleanup() { for (const d of tmpDirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} } }
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { cleanup(); process.exit(130); });
function scratchDir(tag) { const d = mkdtempSync(path.join(os.tmpdir(), "cdb-cu-cloud-gates-" + tag + "-")); tmpDirs.push(d); return d; }

let pass = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { pass++; console.log("  PASS " + label); }
  else { failures.push(label); console.log("  FAIL " + label + (detail !== undefined ? " -> " + detail : "")); }
}
const J = JSON.stringify;
const esc = (x) => x.replace(/[$]/g, "\\$");
const countRe = (hay, re) => (hay.match(new RegExp(re.source, "g")) || []).length;

// ── the bundle ─────────────────────────────────────────────────────────────
const SPLIT_RE = /\n\/\*__CDB_SPLIT__([^*\n]+?)__\*\/\n/;
function splitParts(blob) {
  const pieces = blob.split(SPLIT_RE);
  const names = ["index.js"], bodies = [pieces[0]];
  for (let i = 1; i < pieces.length; i += 2) { names.push(pieces[i]); bodies.push(pieces[i + 1]); }
  return { names, bodies };
}
function exportTarget(body, alias) {
  const all = [...body.matchAll(new RegExp("Object\\.defineProperty\\(exports,([\"`])" + esc(alias) + "\\1,\\{enumerable:!0,get:function\\(\\)\\{return ([\\w$]+)\\}\\}\\)", "g"))];
  return all.length === 1 ? all[0][2] : null;
}
function requiredChunk(body, ns) {
  // Any quote style: upstream's minifier has switched between them before.
  const all = [...body.matchAll(new RegExp("(?<![\\w$.])" + esc(ns) + "=require\\(([\"'`])\\./([^\"'`]+)\\1\\)", "g"))];
  return all.length === 1 ? all[0][2] : null;
}
function functionSource(src, name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) return null;
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}
const DISPATCH_RE = /async function ([\w$]+)\(([\w$]+),[\w$]+,[\w$]+,[\w$]+\)\{let\{logger:[\w$]+,serverName:[\w$]+\}=\2,[\w$]+=[\w$]+\([\w$]+\);if\(\2\.isDisabled\(\)\)/;
const SCREEN_REF_RE = /\{bundleId:([\w$]+)\.([\w$]+),displayName:"Screen"\}/;
const DENIED_RE = /this\.isUserDenied=([\w$]+)\.([\w$]+)\(/;
// Upstream's own Wayland executor: what ours mirrors.
const UP_WL_FRONT_RE = /async getFrontmostApp\(\)\{return ([\w$]+)\.([\w$]+)\(\)\?\{bundleId:([\w$]+)\+\1\.([\w$]+),displayName:`\$\{[\w$]+\.app\.getName\(\)\} dialog`\}:[\w$]+\.BrowserWindow\.getFocusedWindow\(\)\?\{bundleId:\3,displayName:[\w$]+\.app\.getName\(\)\}:\{bundleId:\1\.([\w$]+),displayName:"Screen"\}\},async getKeyFocusApp\(\)\{return this\.getFrontmostApp\(\)\}/;
const CTX_RE = /\{sessionId:[\w$]+,skipFirstRequestWarnings:!0,getAllowedApps:\(\)=>([\w$]+)\(([\w$]+)\.grants\),getGrantFlags:/;
const PATCHED_CTX_RE = /getAllowedApps:\(\)=>process\.platform==="linux"&&typeof globalThis\.__cdbCuWithScreenGrant=="function"\?globalThis\.__cdbCuWithScreenGrant\(([\w$]+)\(([\w$]+)\.grants\),([\w$]+)\.([\w$]+)\(\),([\w$]+)\.([\w$]+),\5\.([\w$]+),([\w$]+)\.([\w$]+)\):\1\(\2\.grants\),/;
const PATCHED_STORE_RE = /([\w$]+)\.apps=process\.platform==="linux"\?\[\.\.\.([\w$]+)\]\.filter\(__cuScr=>__cuScr\.bundleId!==([\w$]+)\.([\w$]+)\):\[\.\.\.\2\],\1\.flags=/;
const DIALOG_FN_RE = /function [\w$]+\(\)\{if\(([\w$]+)>0\)throw Error\("A Claude dialog is open on the screen; wait for the user to answer it before clicking, scrolling or typing\."\)\}function ([\w$]+)\(\)\{return \1>0\}/;
const PATCHED_DIALOG_RE = /\{return [\w$]+>0\}process\.platform==="linux"&&\(globalThis\.__cdbCuDialogOpen=([\w$]+)\);/;

let bundle = null;
let skipped = false;
if (!existsSync(path.join(BUILD_DIR, "index.js"))) {
  skipped = true;
  console.log("\n  SKIP bundle sections: no extract under tmp/app.asar.contents/ (set CDB_BUNDLE_DIR to point at one)");
} else {
  const chunks = readdirSync(BUILD_DIR).filter((d) => /^index.*\.chunk-.*\.js$/.test(d)).sort();
  let blob = readFileSync(path.join(BUILD_DIR, "index.js"), "utf8");
  for (const c of chunks) blob += "\n/*__CDB_SPLIT__" + c + "__*/\n" + readFileSync(path.join(BUILD_DIR, c), "utf8");
  bundle = { blob, parts: splitParts(blob) };
}
const partOf = (pred) => { const i = bundle.parts.bodies.findIndex(pred); return i < 0 ? null : { name: bundle.parts.names[i], body: bundle.parts.bodies[i] }; };

// Upstream's REAL Wayland input guard predicate and own-input marker, cut from
// the bundle (the counters, the event-type map, the marker, the per-kind and
// per-event predicates); a fresh instance per row.
const MARK_RE = /async function ([\w$]+)\(([\w$]+),([\w$]+)\)\{([\w$]+)\[\2\]\.inFlight\+\+;try\{return await \3\(\)\}finally\{\4\[\2\]\.inFlight--,\4\[\2\]\.until=performance\.now\(\)\+([\w$]+)\}\}/;
let guardSrc = null;
if (bundle) {
  const kp = partOf((b) => MARK_RE.test(b));
  if (kp) {
    const m = MARK_RE.exec(kp.body);
    const start = kp.body.search(new RegExp("var " + esc(m[5]) + "=\\d+,"));
    const ev = new RegExp("function ([\\w$]+)\\(([\\w$]+)\\)\\{return ([\\w$]+)\\(([\\w$]+)\\[\\2\\.type\\]\\)\\}").exec(kp.body.slice(start));
    const end = ev ? start + ev.index + ev[0].length : -1;
    if (start >= 0 && end > start) guardSrc = { src: kp.body.slice(start, end), mark: m[1], kind: ev[3], event: ev[1], grace: Number(new RegExp("var " + esc(m[5]) + "=(\\d+),").exec(kp.body.slice(start))[1]) };
  }
}
function loadGuard() {
  if (!guardSrc) return null;
  return new Function(guardSrc.src + ";return {mark:" + guardSrc.mark + ",kind:" + guardSrc.kind + ",event:" + guardSrc.event + "};")();
}

// ── [B] bundle anchors ─────────────────────────────────────────────────────
let disp = null; // {name, body, fn, nsName, nsFile, screenAlias, deniedAlias}
if (bundle) {
  console.log("\n[B] upstream's dispatcher and the shapes ours mirrors");
  const d = partOf((b) => b.includes("no app is frontmost (focus anomaly)") && b.includes("The click would land on the desktop shell"));
  ok(!!d, "dispatcher chunk found by its gate refusals", d && d.name);
  if (d) {
    const fm = DISPATCH_RE.exec(d.body);
    const sm = SCREEN_REF_RE.exec(d.body);
    const dm = DENIED_RE.exec(d.body);
    ok(countRe(d.body, DISPATCH_RE) === 1, "its dispatch function found once", fm && fm[1]);
    ok(countRe(d.body, SCREEN_REF_RE) === 1 && /hitTest:[\w$]+,hostBundleId:[\w$]+\}=[\w$]+\.executor\.capabilities;return [\w$]+==="none"&&[\w$]+\?\.bundleId===[\w$]+\?\{bundleId:/.test(d.body), "the click gate maps the host to the Screen pseudo-app when hitTest is \"none\"");
    const nsFile = sm && requiredChunk(d.body, sm[1]);
    const nsPart = nsFile && partOf((b, i) => bundle.parts.names[i] === nsFile);
    const screenLocal = nsPart && exportTarget(nsPart.body, sm[2]);
    ok(!!screenLocal && countRe(nsPart.body, new RegExp("(?<![\\w$.])" + esc(screenLocal) + "=\"com\\.anthropic\\.cu\\.screen\"")) === 1, "the Screen id the gate uses is the literal \"" + SCREEN + "\" ours returns", nsFile + ":" + screenLocal);
    ok(d.body.includes('o.bundleId===u+" (dialog)"') || /([\w$]+)==="none"&&[\w$]+\.bundleId===([\w$]+)\+" \(dialog\)"/.test(d.body), "the key gate refuses \"<host> (dialog)\" when hitTest is \"none\"");
    ok(d.body.includes("Claude's own window still has keyboard focus, so the keystrokes would land in it."), "the key gate refuses the host in front");
    const up = partOf((b) => UP_WL_FRONT_RE.test(b));
    ok(!!up, "upstream's own Wayland executor answers dialog -> focused Claude window -> Screen (the order ours mirrors)", up && up.name);
    if (up) {
      const um = UP_WL_FRONT_RE.exec(up.body);
      const upNs = requiredChunk(up.body, um[1]);
      const nsP = upNs && partOf((b, i) => bundle.parts.names[i] === upNs);
      const suffixLocal = nsP && exportTarget(nsP.body, um[4]);
      ok(!!suffixLocal && new RegExp("(?<![\\w$.])" + esc(suffixLocal) + "=\" \\(dialog\\)\"").test(nsP.body), "its dialog suffix is \" (dialog)\"");
      const dlgLocal = nsP && exportTarget(nsP.body, um[2]);
      const dfm = DIALOG_FN_RE.exec(bundle.blob);
      ok(!!dfm && dfm[2] === dlgLocal, "its dialog check is the predicate 17f exposes", dlgLocal + " vs " + (dfm && dfm[2]));
    }
    ok(countRe(bundle.blob, CTX_RE) === 1, "the cloud dispatch context reads its grants once (`getAllowedApps:()=>G(i.grants)`)");
    disp = { name: d.name, body: d.body, fn: fm && fm[1], nsName: sm && sm[1], nsFile, screenAlias: sm && sm[2], deniedNs: dm && dm[1], deniedAlias: dm && dm[2] };
  }
}

// ── [P] the compiled patch ─────────────────────────────────────────────────
let patchedBlob = null;
if (bundle) {
  let binMissing = false;
  try { accessSync(PATCH_BIN, constants.X_OK); } catch { binMissing = true; }
  if (binMissing) {
    console.log(`\n  SKIP [P]: ${PATCH_BIN} is not compiled (run: make -C patches linux/fix_computer_use_linux)`);
  } else {
    console.log("\n[P] sub-patches 16f / 17f");
    const scratch = scratchDir("patch");
    const run = (blob, name) => { const f = path.join(scratch, name); writeFileSync(f, blob); const r = spawnSync(PATCH_BIN, [f], { encoding: "utf8" }); return { status: r.status, out: String(r.stdout || "") + String(r.stderr || ""), file: f }; };
    ok(!/__cdbCuWithScreenGrant|__cdbCuDialogOpen/.test(bundle.blob), "pristine bundle has none of ours");
    const r1 = run(bundle.blob, "staged.js");
    ok(r1.status === 0 && !/\[FAIL\]/.test(r1.out), "first run exits 0 without [FAIL]", r1.out.split("\n").filter((l) => /FAIL|Error/.test(l)).join(" | "));
    ok(r1.out.includes(`[PASS] ${EXPECTED_PATCHES}/${EXPECTED_PATCHES} sub-patches applied`), `[PASS] ${EXPECTED_PATCHES}/${EXPECTED_PATCHES}`);
    ok(/\[OK\] 16f cloud screen pseudo-grant: .*\(2 sites\)/.test(r1.out), "16f reported [OK] (2 sites)");
    ok(/\[OK\] 17f dialog-open predicate: [\w$]+ \(counter [\w$]+, counted by upstream's dialog wrapper\)/.test(r1.out), "17f reported [OK]");
    ok(/\[OK\] 17g own-input marker: [\w$]+ \(counts [\w$]+, read by the guard [\w$]+ installs\) exposed as globalThis\.__cdbCuMarkInput where the guard is installed/.test(r1.out), "17g reported [OK]");
    ok(/\[OK\] 16d screen pseudo-grant: .* unless the backend shares the whole screen without a hit test and upstream's gate checks/.test(r1.out), "16d reported [OK] with the shared predicate");
    patchedBlob = readFileSync(r1.file, "utf8");
    const r2 = spawnSync(PATCH_BIN, [r1.file], { encoding: "utf8" });
    ok(r2.status === 0 && /already present \(idempotent, no change\)/.test(String(r2.stdout)), "second run: idempotent");
    ok(readFileSync(r1.file, "utf8") === patchedBlob, "second run leaves the file byte-identical");
    // The patched cloud expression resolves to upstream's class / order / id.
    const pm = PATCHED_CTX_RE.exec(patchedBlob);
    ok(countRe(patchedBlob, PATCHED_CTX_RE) === 1, "patched cloud getAllowedApps present once");
    ok(countRe(patchedBlob, PATCHED_STORE_RE) === 1, "patched grant store drops the pseudo-grant once");
    if (pm) {
      const after = splitParts(patchedBlob);
      const ci = after.bodies.findIndex((b) => PATCHED_CTX_RE.test(b));
      const cb = after.bodies[ci];
      const gFile = requiredChunk(cb, pm[5]), kFile = requiredChunk(cb, pm[3]);
      const gBody = after.bodies[after.names.indexOf(gFile)] || "", kBody = after.bodies[after.names.indexOf(kFile)] || "";
      const cls = exportTarget(gBody, pm[6]), rank = exportTarget(gBody, pm[7]), scr = exportTarget(kBody, pm[9]);
      ok(pm[8] === pm[3], "the Screen id comes from the same namespace as the user-denied list");
      ok(!!cls && new RegExp("(?<![\\w$.])" + esc(cls) + "=class\\{kind=\"explicit\"").test(gBody), "16f hands upstream's explicit grant class", gFile + ":" + cls);
      ok(!!rank && new RegExp("(?<![\\w$.])" + esc(rank) + "=\\{read:0,click:1,full:2\\}").test(gBody), "16f hands upstream's tier order", rank);
      ok(!!scr && new RegExp("(?<![\\w$.])" + esc(scr) + "=\"com\\.anthropic\\.cu\\.screen\"").test(kBody), "16f hands upstream's Screen id", scr);
      const sm = PATCHED_STORE_RE.exec(cb);
      ok(!!sm && sm[3] === pm[3] && sm[4] === pm[9], "the store filter drops that same id");
      for (const name of new Set([after.names[ci], after.names[after.bodies.findIndex((b) => PATCHED_DIALOG_RE.test(b))]])) {
        const f = path.join(scratch, name);
        writeFileSync(f, after.bodies[after.names.indexOf(name)]);
        let good = true;
        try { execFileSync("node", ["--check", f], { stdio: "pipe" }); } catch { good = false; }
        ok(good, "node --check " + name);
      }
    }
    const gm = /(=!0,)process\.platform==="linux"&&\(globalThis\.__cdbCuMarkInput=([\w$]+)\),/.exec(patchedBlob);
    ok(!!gm && guardSrc && gm[2] === guardSrc.mark, "17g exposes the marker the harness runs as upstream's guard counter", gm && gm[2]);
    if (gm) {
      const r8 = run(patchedBlob.replace(gm[0], gm[1]), "missing_17g.js");
      ok(r8.status !== 0 && /half-patched input: .*missing: 17g own-input marker/.test(r8.out), "bundle without 17g's assignment: refused as half-patched, missing 17g");
    }
    const r9 = run(bundle.blob.replace(/(\.app\.on\()"web-contents-created"(,\(\(([\w$]+),([\w$]+)\)=>[\w$]+\(\4\)\)\)\}var [\w$]+=0;)/, '$1"web-contents-gone"$2'), "guard_moved.js");
    ok(r9.status !== 0 && /\[FAIL\] 17g guard install branch/.test(r9.out) && !/\[PASS\]/.test(r9.out), "pristine bundle whose guard no longer hooks web-contents-created: [FAIL] 17g, no [PASS]");
    // Rule 6: no false success.
    const dm = PATCHED_DIALOG_RE.exec(patchedBlob);
    const r3 = run(dm ? patchedBlob.replace(dm[0], dm[0].slice(0, dm[0].indexOf("}") + 1)) : patchedBlob, "missing_17f.js");
    ok(r3.status !== 0 && /half-patched input: .*missing: 17f dialog-open predicate/.test(r3.out), "bundle without 17f's assignment: refused as half-patched, missing 17f");
    const sm2 = PATCHED_STORE_RE.exec(patchedBlob);
    const r4 = run(sm2 ? patchedBlob.replace(sm2[0], sm2[1] + ".apps=[..." + sm2[2] + "]," + sm2[1] + ".flags=") : patchedBlob, "missing_16f_store.js");
    ok(r4.status !== 0 && /half-patched input: .*missing: 16f cloud grants stored without it/.test(r4.out), "bundle without 16f's store filter: refused as half-patched");
    const r5 = run(bundle.blob.replace(CTX_RE, (s) => s.replace("skipFirstRequestWarnings:!0", "skipFirstRequestWarnings:!1")), "ctx_moved.js");
    ok(r5.status !== 0 && /\[FAIL\] 16f cloud dispatch context/.test(r5.out) && !/\[PASS\]/.test(r5.out), "pristine bundle whose cloud context moved: [FAIL] 16f, no [PASS]");
    const r6 = run(bundle.blob.replace("throw Error(\"A Claude dialog is open on the screen;", "throw Error(\"A Claude dialog is open on screen;"), "dialog_moved.js");
    ok(r6.status !== 0 && /\[FAIL\] 17f dialog-open predicate/.test(r6.out) && !/\[PASS\]/.test(r6.out), "pristine bundle whose dialog check moved: [FAIL] 17f, no [PASS]");
    const r7 = run(bundle.blob.replace(/(\.apps=)\[\.\.\.([\w$]+)\],([\w$]+\.flags=[\w$]+,[\w$]+\.flagsGrantedAt=)/, "$1[].concat($2),$3"), "store_moved.js");
    ok(r7.status !== 0 && /\[FAIL\] 16f cloud context: `onAllowedAppsChanged/.test(r7.out) && !/\[PASS\]/.test(r7.out), "pristine bundle whose grant store moved: [FAIL] 16f, no [PASS]");
  }
}

// ── upstream's dispatcher, loaded from the bundle ──────────────────────────
function loadDispatcher(electronStub) {
  const src = disp.body.replace(/\/\/# sourceMappingURL=.*$/m, "") + "\n;globalThis.__cdbT326={dispatch:" + disp.fn + "};";
  const denied = (ids) => (id) => Array.isArray(ids) && ids.includes(id);
  const nsCache = new Map();
  const ns = (file) => {
    if (nsCache.has(file)) return nsCache.get(file);
    const known = {};
    if (file === disp.nsFile) known[disp.screenAlias] = SCREEN;
    if (requiredChunk(disp.body, disp.deniedNs) === file) known[disp.deniedAlias] = denied;
    const p = new Proxy(known, { get(t, k) { if (k in t) return t[k]; if (typeof k === "symbol") return undefined; return () => null; } });
    nsCache.set(file, p);
    return p;
  };
  const req = (id) => {
    if (id === "electron") return electronStub;
    if (id.startsWith("node:")) return nodeRequire(id);
    if (id.startsWith("./")) return ns(id.slice(2));
    throw new Error("dispatcher require " + id);
  };
  const mod = { exports: {} };
  new Function("require", "exports", "module", src)(req, mod.exports, mod);
  const Grants = Object.values(mod.exports).find((v) => typeof v === "function" && /kind="explicit"/.test(String(v)));
  const rank = Object.values(mod.exports).find((v) => v && typeof v === "object" && v.read === 0 && v.click === 1 && v.full === 2);
  return { dispatch: globalThis.__cdbT326.dispatch, Grants, rank };
}

// ── our executors on a fake session ────────────────────────────────────────
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const R = (x, y, width, height) => ({ x, y, width, height });
// Two monitors: built-in 1444x902 @1.33 (primary) + 3440x1440 to its right.
const DISPLAYS = [
  { id: 21, label: "Built-in display", bounds: R(0, 0, 1444, 902), size: { width: 1444, height: 902 }, workArea: R(0, 0, 1444, 902), scaleFactor: 1.33, nativeOrigin: { x: 0, y: 0 } },
  { id: 22, label: "Samsung 34", bounds: R(1444, 0, 3440, 1440), size: { width: 3440, height: 1440 }, workArea: R(1444, 0, 3440, 1440), scaleFactor: 1, nativeOrigin: { x: 1920, y: 0 } },
];
const SCREENS = [
  { id: "eDP-1", name: "eDP-1", geometry: R(0, 0, 1444, 902), scale: 1.33, is_primary: true, is_shared: true },
  { id: "DP-1", name: "DP-1", geometry: R(1444, 0, 3440, 1440), scale: 1, is_primary: false, is_shared: true },
];
const CALC = "org.gnome.Calculator", FIREFOX = "org.mozilla.firefox";
function win(id, app, geometry, extra = {}) {
  return { id: String(id), title: app, geometry, pid: 4000 + id, desktop_file_name: app, resource_class: app, resource_name: app, is_visible: true, is_minimized: false, is_active: false, stacking_order: id, output: "DP-1", ...extra };
}
const ROWS = {
  "gnome-nointro": { label: "GNOME Wayland, Introspect refused", env: { XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "GNOME", WAYLAND_DISPLAY: "wayland-0" }, bin: ["__cuGnomeBridgeBin", "/res/gnome-portal-bridge"], doctor: { contract: 1, introspect_available: false, gnome_shell_version: "51.1" }, intro: false, geo: false, front: false, hit: false },
  "gnome-intro": { label: "GNOME Wayland, Introspect allowed", env: { XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "GNOME", WAYLAND_DISPLAY: "wayland-0" }, bin: ["__cuGnomeBridgeBin", "/res/gnome-portal-bridge"], doctor: { contract: 1, introspect_available: true }, intro: true, geo: false, front: true, hit: false },
  niri: { label: "niri (wlroots-bridge, no window geometry)", env: { XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "niri", WAYLAND_DISPLAY: "wayland-1", NIRI_SOCKET: "/run/niri.sock" }, bin: ["__cuWlrootsBridgeBin", "/res/wlroots-bridge"], doctor: { contract: 1, window_geometry: false, backend_reachable: true, compositor: "niri" }, geo: false, front: true, hit: false },
  sway: { label: "sway (wlroots-bridge with window geometry)", env: { XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "sway", WAYLAND_DISPLAY: "wayland-1", SWAYSOCK: "/run/sway.sock" }, bin: ["__cuWlrootsBridgeBin", "/res/wlroots-bridge"], doctor: { contract: 1, window_geometry: true, backend_reachable: true, compositor: "sway" }, geo: true, front: true, hit: true },
  "x11-nobridge": { label: "X11 without x11-bridge (fallback tools)", env: { XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "XFCE", DISPLAY: ":0" }, bin: null, doctor: null, geo: false, front: false, hit: false, x11: true, noBridge: true },
  x11: { label: "X11 (x11-bridge)", env: { XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "XFCE", DISPLAY: ":0" }, bin: ["__cuX11BridgeBin", "/res/x11-bridge"], doctor: { contract: 1, capabilities: { screenshot_mask: false } }, geo: true, front: true, hit: true, x11: true },
};
const ENV_KEYS = ["SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE", "NIRI_SOCKET", "COWORK_SCREENSHOT_CMD", "X11_BRIDGE_BIN", "WLROOTS_BRIDGE_BIN", "GNOME_PORTAL_BRIDGE_BIN", "KWIN_PORTAL_BRIDGE_BIN", "YDOTOOL_SOCKET", "WAYLAND_DISPLAY", "DISPLAY", "CHROME_DESKTOP", "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE", "XDG_RUNTIME_DIR", "CDB_CU_DEBUG"];
const baseEnv = { ...process.env };
const baseGlobals = new Set(Object.keys(globalThis));
function resetWorld() {
  for (const k of Object.keys(globalThis)) if (!baseGlobals.has(k)) delete globalThis[k];
  for (const k of ENV_KEYS) delete process.env[k];
}

// A row's world. s: the scenario (who is in front / under the pointer).
//   s.front: "calc" | "firefox" | "claude" | "none"; s.under: same for the
//   point the click targets; s.dialog: a Claude dialog is open (upstream's
//   counter, as 17f exposes it); s.focus: one of Claude's BrowserWindows has
//   focus; s.portal: GNOME screenshots through the bridge (shared monitor).
function loadRow(rowKey, s, src = {}) {
  resetWorld();
  const row = ROWS[rowKey];
  Object.assign(process.env, row.env, { PATH: "/usr/bin:/bin" });
  if (!s.portal) process.env.COWORK_SCREENSHOT_CMD = "true {FILE}";
  if (rowKey.startsWith("gnome")) process.env.XDG_RUNTIME_DIR = "relative";
  const rig = { calls: [], diag: [], delivered: [], inputs: [], s };
  // Upstream installs its guard (and 17g exposes the marker) on Wayland only.
  rig.guard = !row.x11 && !s.noMarker ? loadGuard() : null;
  const claudeWin = (geo) => win(90, HOST, geo, { pid: process.pid, desktop_file_name: HOST, resource_class: HOST });
  const windowsFor = () => {
    if (rowKey === "gnome-nointro") return [];
    const g = (r) => (row.geo ? r : R(0, 0, r.width, r.height));
    const list = [win(1, CALC, g(R(1444, 0, 1600, 1000))), win(2, FIREFOX, g(R(3200, 0, 1600, 1000)))];
    if (s.front === "claude" || s.under === "claude" || s.dialog) list.push(claudeWin(g(R(1500, 100, 800, 600))));
    for (const w of list) w.is_active = (s.front === "calc" && w.desktop_file_name === CALC) || (s.front === "firefox" && w.desktop_file_name === FIREFOX) || ((s.front === "claude" || s.dialog) && w.pid === process.pid);
    if (row.geo) {
      // The click point (400,300 image px on the second monitor: logical
      // 1844,300, X root 2320,300) hits only the window "under" names; the
      // others sit elsewhere on that monitor.
      const top = { calc: CALC, firefox: FIREFOX, claude: HOST }[s.under];
      for (const w of list) {
        const isTop = w.desktop_file_name === top || (top === HOST && w.pid === process.pid);
        w.geometry = isTop ? R(1400, 0, 1800, 1000) : R(3400, 600, 900, 700);
        w.stacking_order = isTop ? 50 : w.stacking_order;
      }
    }
    return list;
  };
  const appRef = (w) => (w ? { bundleId: w.desktop_file_name, displayName: w.title } : null);
  const reply = (bin, args) => {
    const b = path.basename(String(bin));
    rig.calls.push(b + " " + args.join(" "));
    if (!/-bridge$/.test(b)) throw Object.assign(new Error("not found: " + b), { status: 127 });
    switch (args[0]) {
      case "doctor": if (s.doctorFails) throw Object.assign(new Error("doctor crashed"), { status: 101 }); return J(typeof s.doctor === "function" ? s.doctor() : s.doctor || row.doctor);
      case "windows": return J(windowsFor());
      case "screens": return J(SCREENS);
      case "frontmost-app": {
        if (rowKey.startsWith("gnome") && !row.intro) return "null";
        return J(appRef(windowsFor().find((w) => w.is_active)) || null);
      }
      case "app-under-point": {
        if (!row.x11) return "null";
        const x = Number(args[args.indexOf("--x") + 1]), y = Number(args[args.indexOf("--y") + 1]);
        const hit = windowsFor().filter((w) => x >= w.geometry.x && x < w.geometry.x + w.geometry.width && y >= w.geometry.y && y < w.geometry.y + w.geometry.height).sort((a, c) => c.stacking_order - a.stacking_order)[0];
        if (!hit) throw Object.assign(new Error(`no window under point (${x}, ${y})`), { status: 1 });
        return J(appRef(hit));
      }
      case "session-start": rig.session = true; return J({ ok: true });
      case "session-end": rig.session = false; return J({ ok: true });
      case "zoom": return J({ base64: PNG.toString("base64"), width: Number(args[args.indexOf("--w") + 1]) || 100, height: Number(args[args.indexOf("--h") + 1]) || 100 });
      case "pointer-move": case "pointer-click": case "pointer-scroll": case "pointer-drag": case "left-mouse-down": case "left-mouse-up": case "key-sequence": case "type": case "hold-key":
        rig.inputs.push({ cmd: args[0], args, discards: rig.guard ? { move: rig.guard.kind("move"), button: rig.guard.kind("button"), wheel: rig.guard.kind("wheel"), key: rig.guard.kind("key"), mouseDown: rig.guard.event({ type: "mouseDown" }), keyDown: rig.guard.event({ type: "keyDown" }) } : null });
        return J({ ok: true });
      default: throw Object.assign(new Error("not stubbed: " + args[0]), { status: 1 });
    }
  };
  const cp = {
    execFileSync(bin, args) { return reply(bin, args || []); },
    execSync(cmd) { rig.calls.push("SHELL " + cmd); return ""; },
    spawnSync() { return { status: 1, stdout: "", stderr: "" }; },
    execFile(bin, args, opts, cb) { const c = typeof opts === "function" ? opts : cb; let out, err = null; try { out = reply(bin, args || []); } catch (e) { err = e; } setTimeout(() => c(err, out || "", ""), 0); return { on() {}, kill() {} }; },
    spawn() { rig.calls.push("SPAWN"); return { on() {}, unref() {}, stdout: { on() {} }, stderr: { on() {} }, kill() {}, pid: 0 }; },
  };
  const electron = {
    app: { commandLine: { getSwitchValue: () => "" }, getPath: () => "/ud", getName: () => "Claude" },
    screen: { getAllDisplays: () => DISPLAYS, getPrimaryDisplay: () => DISPLAYS[0], getCursorScreenPoint: () => ({ x: 100, y: 100 }), getDisplayNearestPoint: () => DISPLAYS[0], getDisplayMatching: () => DISPLAYS[0] },
    desktopCapturer: { getSources: async () => [] },
    clipboard: { readText: () => "", writeText: () => {} },
    nativeImage: { createFromBuffer: () => ({ getSize: () => ({ width: 1, height: 1 }), isEmpty: () => false, toBitmap: () => Buffer.alloc(4), toPNG: () => PNG, resize: () => ({ toJPEG: () => PNG, toPNG: () => PNG, getSize: () => ({ width: 1, height: 1 }) }) }) },
    BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => (s.focus || s.front === "claude" ? { id: 1 } : null) },
  };
  const fsStub = {
    constants: { X_OK: 1 },
    readFileSync: (p) => (String(p).includes("claude-cu-") ? PNG : Buffer.alloc(0)),
    writeFileSync() {}, unlinkSync() {}, existsSync: () => false, renameSync() {}, mkdirSync() {},
    accessSync() { throw new Error("ENOENT"); }, readdirSync: () => [], statSync: () => ({ isDirectory: () => false, size: PNG.length }),
    readlinkSync() { throw new Error("no"); }, realpathSync: (p) => p, promises: { stat: async () => { throw new Error("ENOENT"); } },
  };
  const req = (id) => {
    const m = { child_process: cp, electron, path, os, fs: fsStub, crypto: nodeRequire("node:crypto") }[id];
    if (!m) throw new Error("unexpected require " + id);
    return m;
  };
  globalThis.__cdbDiag = (m) => rig.diag.push(String(m));
  globalThis.__cuKwinMode = false;
  if (row.bin) globalThis[row.bin[0]] = row.bin[1];
  if (rig.guard) globalThis.__cdbCuMarkInput = rig.guard.mark;
  // Upstream installs its dialog counter on Wayland sessions only (17f).
  if (!row.x11) globalThis.__cdbCuDialogOpen = () => !!s.dialog;
  new Function("process", readFileSync(DISPLAY_TARGET, "utf8"))(process);
  new Function("require", "process", readFileSync(src.exec || EXEC, "utf8"))(req, process);
  new Function("process", readFileSync(src.consent || CONSENT, "utf8"))(process);
  rig.ex = globalThis.__linuxExecutor;
  rig.electron = electron;
  rig.row = row;
  const record = (name) => async (...a) => { rig.delivered.push([name, ...a]); };
  if (!s.real) for (const m of ["click", "moveMouse", "type", "key", "holdKey", "scroll", "drag", "mouseDown", "mouseUp", "typePaced"]) rig.ex[m] = record(m);
  rig.calls.length = 0;
  return rig;
}
async function settle() { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); }

// Upstream's dispatcher over a cloud session context, as 16f leaves it:
// getAllowedApps = __cdbCuWithScreenGrant(grants, denied, Grants, rank, SCREEN)
// when the consent module defines it (the released one does not: upstream's
// plain list, as on the released bundle).
function cloudSession(D, rig, grants, extra = {}) {
  const st = { selected: extra.selected, lastShot: undefined };
  const denied = extra.denied || [];
  const getAllowedApps = () => (typeof globalThis.__cdbCuWithScreenGrant === "function" ? globalThis.__cdbCuWithScreenGrant(grants.slice(), denied, D.Grants, D.rank, SCREEN) : grants.slice());
  const adapter = {
    serverName: "computer-use", executor: rig.ex, isDisabled: () => false,
    logger: { silly() {}, debug() {}, info() {}, warn() {}, error() {} },
    ensureOsPermissions: async () => ({ granted: true }),
    getSubGates: () => ({ pixelValidation: false, clipboardPasteMultiline: true, mouseAnimation: false, hideBeforeAction: false, autoTargetDisplay: true, clipboardGuard: false, maskFailClosed: true, adaptiveResolution: true }),
    cropRawPatch: () => null,
  };
  const ctx = () => {
    const apps = getAllowedApps();
    return { allowedApps: apps, grants: new D.Grants(apps, denied), grantFlags: {}, userDeniedBundleIds: denied, coordinateMode: "pixels", selectedDisplayId: st.selected, lastScreenshot: st.lastShot, onResolvedDisplayUpdated: (d) => { st.selected = d; }, onDisplayPinned: () => {}, displayPinnedByModel: false };
  };
  return {
    st, getAllowedApps,
    async call(tool, input) {
      const r = await D.dispatch(adapter, tool, input, ctx());
      if (r.screenshot) { const { base64, ...dims } = r.screenshot; st.lastShot = { ...dims, base64: "" }; }
      const text = (r.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" | ");
      return { isError: !!r.isError, text, shot: r.screenshot ? (({ base64, ...d }) => d)(r.screenshot) : null };
    },
  };
}

const T_OK_CLICK = /^Clicked\.$/;
const T_OK_TYPE = /^Typed 3 /;
const RE_READ = /granted at tier "read"/;
const RE_HOST_KEYS = /Claude's own window still has keyboard focus/;
const RE_DIALOG = /One of Claude's own dialogs is open/;
const RE_NOGRANT = /No applications are granted for this session/;
const RE_FRONT_UNGRANTED = /is not in the allowed applications and is currently in front/;
const RE_UNDER_UNGRANTED = /Click at these coordinates would land on "[^"]*", which is not in the allowed applications/;
const RE_DESKTOP = /would land on the desktop shell/;
const RE_OVERLAY = /the Claude overlay intercepted the hit test/;

// ── [E] the cloud pseudo-grant rule == upstream's local rule ───────────────
let D0 = null;
if (bundle && disp && disp.fn) {
  D0 = loadDispatcher({ app: { getName: () => "Claude" }, BrowserWindow: { getFocusedWindow: () => null }, screen: {} });
  console.log("\n[E] __cdbCuWithScreenGrant against upstream's own local rule");
  ok(typeof D0.dispatch === "function" && typeof D0.Grants === "function" && !!D0.rank, "dispatcher, explicit grant class and tier order loaded from the bundle");
  const yeHead = /function ([\w$]+)\(([\w$]+),([\w$]+)\)\{if\(([\w$]+)\.([\w$]+)!==\4\.([\w$]+)\|\|\2\.some\(\(?([\w$]+)=>\7\.bundleId==="com\.anthropic\.cu\.screen"\)\)?\)return \2;let [\w$]+=new ([\w$]+)\.([\w$]+)\(\2,\3\)\.explicitGrants;/;
  const yp = partOf((b) => yeHead.test(b));
  ok(!!yp, "upstream's local rule found", yp && yp.name);
  rig0: {
    if (!yp) break rig0;
    const m = yeHead.exec(yp.body);
    const src = functionSource(yp.body, m[1]);
    const tail = src.slice(m[0].length);
    const rankAlias = (/([\w$]+)\.([\w$]+)\[[\w$]+\]>=\1\.\2\[/.exec(tail) || [])[2];
    const scrAlias = (/\{bundleId:([\w$]+)\.([\w$]+),displayName:"Entire screen"/.exec(tail) || [])[2];
    const same = {};
    const kNs = new Proxy({ [m[5]]: same, [m[6]]: same, [scrAlias]: SCREEN }, { get: (t, k) => t[k] });
    const gNs = { [m[9]]: D0.Grants, [rankAlias]: D0.rank };
    const nsNames = [...new Set([m[4], m[8], /\{bundleId:([\w$]+)\./.exec(tail)[1]])];
    const upstream = new Function(...nsNames, "return " + src)(...nsNames.map((n) => (n === m[8] ? gNs : kNs)));
    resetWorld();
    const tierScreen = (list) => (list.find((a) => a.bundleId === SCREEN) || {}).tier;
    globalThis.__linuxExecutor = { capabilities: { hitTest: "none" } };
    globalThis.__cuKwinMode = false;
    new Function("process", readFileSync(CONSENT, "utf8"))(process);
    const ours = globalThis.__cdbCuWithScreenGrant;
    if (typeof ours !== "function") { ok(false, "__cdbCuWithScreenGrant defined by " + path.basename(CONSENT)); break rig0; }
    const t0 = 1000;
    const cases = [
      ["no grant", [], []],
      ["one full grant", [{ bundleId: CALC, displayName: "Calculator", grantedAt: t0, tier: "full" }], []],
      ["read only", [{ bundleId: CALC, displayName: "Calculator", grantedAt: t0, tier: "read" }], []],
      ["click + read", [{ bundleId: CALC, displayName: "Calculator", grantedAt: t0, tier: "read" }, { bundleId: FIREFOX, displayName: "Firefox", grantedAt: t0 + 1, tier: "click" }], []],
      ["no tier = full", [{ bundleId: CALC, displayName: "Calculator", grantedAt: t0 }], []],
      ["the full app user-denied", [{ bundleId: CALC, displayName: "Calculator", grantedAt: t0, tier: "full" }, { bundleId: FIREFOX, displayName: "Firefox", grantedAt: t0, tier: "read" }], [CALC]],
      ["every app user-denied", [{ bundleId: CALC, displayName: "Calculator", grantedAt: t0, tier: "full" }], [CALC]],
      ["pseudo-grant already there", [{ bundleId: CALC, displayName: "Calculator", grantedAt: t0, tier: "read" }, { bundleId: SCREEN, displayName: "Entire screen", grantedAt: t0, tier: "read" }], []],
    ];
    for (const [label, apps, den] of cases) {
      const a = ours(apps.map((x) => ({ ...x })), den, D0.Grants, D0.rank, SCREEN);
      const b = upstream(apps.map((x) => ({ ...x })), den);
      ok(J(a) === J(b), `whole-screen backend, ${label}: same list as upstream's rule (Screen tier ${tierScreen(b) ?? "none"})`, J(a) + " vs " + J(b));
    }
    globalThis.__linuxExecutor = { capabilities: {} };
    const one = [{ bundleId: CALC, displayName: "Calculator", grantedAt: t0, tier: "full" }];
    ok(J(ours(one, [], D0.Grants, D0.rank, SCREEN)) === J(one), "backend with a hit test: list unchanged");
    globalThis.__cuKwinMode = true;
    globalThis.__linuxExecutor = { capabilities: { hitTest: "none" } };
    ok(J(ours(one, [], D0.Grants, D0.rank, SCREEN)) === J(one), "kwin mode: list unchanged");
    ok(globalThis.__cdbCuNoScreenGrant() === true, "kwin mode: 16d leaves the local pseudo-grant out");
    globalThis.__cuKwinMode = false;
    globalThis.__cdbCuAskBeforeControl = () => false;
    ok(globalThis.__cdbCuNoScreenGrant() === false, "whole-screen backend, ask-before-control off: 16d keeps upstream's local pseudo-grant (same predicate)");
    globalThis.__cdbCuAskBeforeControl = () => true;
    ok(globalThis.__cdbCuNoScreenGrant() === true, "whole-screen backend, ask-before-control on: 16d leaves it out (the Code-tab gate checks; its list unchanged)");
    globalThis.__cdbCuAskBeforeControl = () => false;
    globalThis.__linuxExecutor = { capabilities: {} };
    ok(globalThis.__cdbCuNoScreenGrant() === true, "backend with a hit test: 16d leaves it out");
    resetWorld();
  }
}

// ── [R] rows through upstream's dispatcher ─────────────────────────────────
const SCEN = {
  ok: { front: "calc", under: "calc" },
  read: { front: "calc", under: "calc", tier: "read" },
  claude: { front: "claude", under: "claude", focus: true },
  dialog: { front: "calc", under: "calc", dialog: true },
  nogrant: { front: "calc", under: "calc", grants: [] },
  firefoxFront: { front: "firefox", under: "calc" },
  firefoxUnder: { front: "calc", under: "firefox" },
  desktop: { front: "calc", under: "none" },
};
// Expected [click, type] per row and scenario (regex, or "ok").
const EXPECT = {
  ok: { all: ["ok", "ok"] },
  read: { all: [RE_READ, RE_READ] },
  // Blind rows: the click passes upstream's gate and is delivered with
  // upstream's input guard armed, so Claude's window drops it ([M1] proves the
  // guard state during the delivery); without the guard it is refused.
  claude: { "gnome-nointro": ["ok", RE_HOST_KEYS], "gnome-intro": ["ok", RE_HOST_KEYS], niri: ["ok", RE_HOST_KEYS], "x11-nobridge": [RE_FRONT_UNGRANTED, RE_FRONT_UNGRANTED], sway: [RE_OVERLAY, RE_HOST_KEYS], x11: [RE_OVERLAY, RE_HOST_KEYS] },
  dialog: { "gnome-nointro": [RE_DIALOG, RE_DIALOG], "gnome-intro": [RE_DIALOG, RE_DIALOG], niri: [RE_DIALOG, RE_DIALOG] },
  nogrant: { all: [RE_NOGRANT, RE_NOGRANT] },
  // GNOME without Introspect cannot see the app in front: the loss, pinned.
  firefoxFront: { "gnome-nointro": ["ok", "ok"], "x11-nobridge": ["ok", "ok"], "gnome-intro": [RE_FRONT_UNGRANTED, RE_FRONT_UNGRANTED], niri: [RE_FRONT_UNGRANTED, RE_FRONT_UNGRANTED], sway: [RE_FRONT_UNGRANTED, RE_FRONT_UNGRANTED], x11: [RE_FRONT_UNGRANTED, RE_FRONT_UNGRANTED] },
  firefoxUnder: { sway: [RE_UNDER_UNGRANTED, "ok"], x11: [RE_UNDER_UNGRANTED, "ok"] },
  desktop: { sway: [RE_DESKTOP, "ok"], x11: [RE_DESKTOP, "ok"] },
};
const matches = (r, want, okRe) => (want === "ok" ? !r.isError && okRe.test(r.text) : r.isError && want.test(r.text));
const show = (r) => (r.isError ? "ERROR " : "") + r.text.slice(0, 160);

if (bundle && disp && disp.fn) {
  for (const rowKey of Object.keys(ROWS)) {
    const row = ROWS[rowKey];
    console.log(`\n[R] ${row.label}`);
    // capabilities, frontmost
    try {
      const rig = loadRow(rowKey, SCEN.ok);
      await rig.ex.capabilitiesAsync();
      await settle();
      if (rowKey.startsWith("gnome")) {
        // Nothing spawned for Introspect: unknown until a window list answers.
        ok(rig.ex.capabilitiesNow().frontmost === "none" && !rig.calls.some((c) => / doctor$/.test(c)), "GNOME: front window unknown before any window list, no doctor spawned", J(rig.calls));
        await rig.ex.listRunningApps(); // upstream asks at session open
      }
      const before = rig.calls.length;
      let h;
      for (let i = 0; i < 200; i++) h = rig.ex.capabilities.hitTest;
      ok(rig.calls.length === before, "capabilities.hitTest is exec-free (200 reads, no bridge call)", rig.calls.slice(before).join("; "));
      ok(row.hit ? h === undefined : h === "none", `capabilities.hitTest = ${row.hit ? "undefined (real hit test)" : "\"none\""}`, String(h));
      ok(!("hitTest" in rig.ex.capabilities) || Object.getOwnPropertyDescriptor(rig.ex.capabilities, "hitTest").get !== undefined, "hitTest is a getter");
      const cn = rig.ex.capabilitiesNow();
      ok(cn.frontmost === (row.front ? "native" : "none"), `capabilitiesNow().frontmost = ${row.front ? "native" : "none"}`, cn.frontmost);
      ok(cn.hitTest === (row.hit ? "native" : "none"), `capabilitiesNow().hitTest = ${row.hit ? "native" : "none"}`, cn.hitTest);
      const f1 = await rig.ex.getFrontmostApp();
      ok(f1 && f1.bundleId === (row.front ? CALC : SCREEN), `front app with Calculator focused: ${row.front ? CALC : SCREEN}`, J(f1));
      ok(typeof rig.ex.getKeyFocusApp === "function" && J(await rig.ex.getKeyFocusApp()) === J(f1), "getKeyFocusApp answers the same");
      const lines = () => rig.diag.filter((l) => l.startsWith("[claude-cu] no window info")).length;
      for (let i = 0; i < 4; i++) await rig.ex.getFrontmostApp();
      ok(lines() === (row.hit ? 0 : 1), `"no window info" line ${row.hit ? "never" : "once"} over 5 reads`, rig.diag.filter((l) => l.includes("no window info")).join(" | "));
      if (!row.hit) {
        await rig.ex.__setLockHeld(true, "cse_test");
        await rig.ex.getFrontmostApp();
        ok(lines() === 2, "... and once more after a new lock", lines());
        console.log("    " + rig.diag.find((l) => l.startsWith("[claude-cu] no window info")));
        await rig.ex.__setLockHeld(false);
      }
      // Claude focused: Claude. A Claude dialog: "<host> (dialog)" without a
      // hit test (upstream's counter), else the window the bridge names (the
      // dialog is one of Claude's windows). Nothing focused: null where the
      // backend names the window in front, else the Screen pseudo-app (GNOME
      // counts an empty Introspect answer as "cannot name").
      // Without upstream's guard (X11 without a bridge) Claude's window is an
      // id no grant covers; without its dialog counter no dialog is seen.
      for (const [sk, want] of [["claude", row.noBridge ? HOST + " (window)" : HOST], ["dialog", row.hit ? HOST : row.noBridge ? SCREEN : HOST + " (dialog)"], ["desktop", row.hit ? null : SCREEN]]) {
        const r2 = loadRow(rowKey, sk === "desktop" ? { front: "none", under: "none" } : SCEN[sk]);
        await r2.ex.capabilitiesAsync(); await settle();
        const f = await r2.ex.getFrontmostApp();
        const exp = want;
        ok((f ? f.bundleId : null) === exp, `front app, ${sk === "desktop" ? "nothing focused" : sk}: ${exp}`, J(f));
      }
    } catch (e) { ok(false, "capabilities / front app section ran", e && e.message); }
    // upstream's dispatcher
    for (const [sk, sc] of Object.entries(SCEN)) {
      const exp = EXPECT[sk][rowKey] || EXPECT[sk].all;
      if (!exp) continue;
      try {
      const rig = loadRow(rowKey, sc);
      await rig.ex.capabilitiesAsync(); await settle();
      const D = loadDispatcher(rig.electron);
      const grants = sc.grants || [{ bundleId: CALC, displayName: "Calculator", grantedAt: Date.now(), tier: sc.tier || "full" }];
      const sess = cloudSession(D, rig, grants, { selected: 1 });
      const shot = await sess.call("screenshot", {});
      if (sk !== "nogrant") ok(!shot.isError, `${sk}: screenshot`, show(shot));
      const c = await sess.call("left_click", { coordinate: [400, 300] });
      const t = await sess.call("type", { text: "3*9" });
      ok(matches(c, exp[0], T_OK_CLICK), `${sk}: left_click -> ${exp[0] === "ok" ? "Clicked" : exp[0].source}`, show(c));
      ok(matches(t, exp[1], T_OK_TYPE), `${sk}: type -> ${exp[1] === "ok" ? "Typed" : exp[1].source}`, show(t));
      if (sk === "ok") {
        const k = await sess.call("key", { text: "ctrl+a" });
        ok(!k.isError, "ok: key ctrl+a", show(k));
        const b = await sess.call("computer_batch", { actions: [{ action: "screenshot" }, { action: "left_click", coordinate: [400, 300] }, { action: "type", text: "1+1" }] });
        ok(!b.isError && !/display undefined/.test(b.text), "ok: computer_batch [screenshot, left_click, type]", show(b));
        const after = await sess.call("left_click", { coordinate: [400, 300] });
        ok(!after.isError, "ok: left_click after the batch screenshot", show(after));
        const al = sess.getAllowedApps();
        ok(al.some((a) => a.bundleId === SCREEN) === !row.hit, `cloud grants ${row.hit ? "without" : "with"} the "Entire screen" pseudo-grant`, J(al.map((a) => a.bundleId + ":" + a.tier)));
        const lg = await sess.call("list_granted_applications", {});
        console.log("    list_granted_applications: " + lg.text.slice(0, 220));
      }
      } catch (e) { ok(false, `${sk}: scenario ran`, e && e.message); }
    }
  }

  // ── [M] review findings: own-window input, cold / failing doctor, null front
  console.log("\n[M1] a click at Claude's own window on a backend without a hit test");
  ok(!!guardSrc, "upstream's Wayland input guard (marker, per-kind and per-event predicates) cut from the bundle", guardSrc && J({ mark: guardSrc.mark, kind: guardSrc.kind, event: guardSrc.event, grace: guardSrc.grace }));
  const cloudFor = (rig, tier = "full") => cloudSession(loadDispatcher(rig.electron), rig, [{ bundleId: CALC, displayName: "Calculator", grantedAt: Date.now(), tier }], { selected: 1 });
  for (const rowKey of ["gnome-nointro", "gnome-intro", "niri"]) {
    try {
      const rig = loadRow(rowKey, { ...SCEN.claude, real: true });
      await rig.ex.capabilitiesAsync(); await settle();
      if (rowKey === "gnome-intro") await rig.ex.listRunningApps();
      const sess = cloudFor(rig);
      await sess.call("screenshot", {});
      const c = await sess.call("left_click", { coordinate: [400, 300] });
      const press = rig.inputs.find((i) => i.cmd === "pointer-click" || i.cmd === "left-mouse-down");
      ok(!c.isError && !!press, `${rowKey}: upstream's gate passes the click (Claude's window = the shared screen)`, show(c) + " " + J(rig.inputs.map((i) => i.cmd)));
      ok(!!press && press.discards && press.discards.mouseDown === true && press.discards.button === true && press.discards.move === true, `${rowKey}: while it is delivered, upstream's real guard discards mouse events in Claude's windows`, J(press && press.discards));
      ok(rig.guard.event({ type: "mouseDown" }) === true, `${rowKey}: ... and keeps discarding right after (upstream's grace)`);
      await new Promise((r) => setTimeout(r, guardSrc.grace + 60));
      ok(rig.guard.event({ type: "mouseDown" }) === false && rig.guard.event({ type: "keyDown" }) === false, `${rowKey}: the guard stops discarding ${guardSrc.grace} ms after the last delivery`);
      const t = await sess.call("type", { text: "3*9" });
      ok(t.isError && RE_HOST_KEYS.test(t.text), `${rowKey}: typing while Claude's window has focus is refused`, show(t));
      // The marker missing (upstream installed no guard): refused, never delivered.
      const r2 = loadRow(rowKey, { ...SCEN.claude, real: true, noMarker: true });
      await r2.ex.capabilitiesAsync(); await settle();
      if (rowKey === "gnome-intro") await r2.ex.listRunningApps();
      const s2 = cloudFor(r2);
      await s2.call("screenshot", {});
      const c2 = await s2.call("left_click", { coordinate: [400, 300] });
      ok(c2.isError && /"Claude's own window" is not in the allowed applications/.test(c2.text) && !r2.inputs.some((i) => /pointer-click|mouse-down|mouse-up/.test(i.cmd)), `${rowKey}, guard missing: the click is refused, no button is sent (upstream's own pre-gate hover move only: ${r2.inputs.map((i) => i.cmd).join(",") || "none"})`, show(c2));
      console.log("    model sees (guard missing): " + c2.text.slice(0, 200));
    } catch (e) { ok(false, rowKey + ": [M1] ran", e && e.stack); }
  }
  {
    const rig = loadRow("x11-nobridge", { ...SCEN.claude });
    await rig.ex.capabilitiesAsync(); await settle();
    const sess = cloudFor(rig);
    await sess.call("screenshot", {});
    const c = await sess.call("left_click", { coordinate: [400, 300] });
    ok(c.isError && /"Claude's own window" is not in the allowed applications/.test(c.text) && !rig.delivered.some((d) => d[0] === "click"), "X11 without x11-bridge (no guard): a click while Claude's window has focus is refused", show(c));
  }
  for (const rowKey of ["sway", "x11"]) {
    const rig = loadRow(rowKey, { ...SCEN.ok, real: true });
    if (rowKey === "sway") globalThis.__cdbCuMarkInput = (rig.guard = loadGuard()).mark;
    await rig.ex.capabilitiesAsync(); await settle();
    const sess = cloudFor(rig);
    await sess.call("screenshot", {});
    const c = await sess.call("left_click", { coordinate: [400, 300] });
    const press = rig.inputs.find((i) => /pointer-click|left-mouse-down/.test(i.cmd));
    ok(!c.isError && !!press && (!press.discards || press.discards.button === false), `${rowKey}: a real hit test - input not marked (upstream refuses Claude's window by its hit test instead)`, show(c) + " " + J(press && press.discards));
  }

  console.log("\n[M2] sway before / without a doctor answer: fail closed");
  for (const [label, sc] of [["cold (no doctor answer yet)", {}], ["failing doctor", { doctorFails: true }]]) {
    for (const under of ["firefox", "calc"]) {
      const rig = loadRow("sway", { front: "calc", under, ...sc });
      const hit0 = rig.ex.capabilities.hitTest;
      const sess = cloudFor(rig);
      ok(!sess.getAllowedApps().some((a) => a.bundleId === SCREEN), `sway ${label}, ${under} under the point: no "Entire screen" pseudo-grant`, J(sess.getAllowedApps().map((a) => a.bundleId)));
      const c = await sess.call("left_click", { coordinate: [400, 300] });
      const want = under === "firefox" ? "refused" : sc.doctorFails ? "refused" : "ok";
      ok(hit0 === undefined && (want === "ok" ? !c.isError : c.isError && (RE_UNDER_UNGRANTED.test(c.text) || RE_DESKTOP.test(c.text))), `sway ${label}: hitTest ${hit0 === undefined ? "undefined" : hit0} before any answer; click with ${under} under the point ${want}`, show(c));
    }
  }
  {
    const rig = loadRow("niri", { front: "calc", under: "calc" });
    ok(rig.ex.capabilities.hitTest === undefined, "niri cold: hit test assumed until the doctor says otherwise");
    const sess = cloudFor(rig);
    const c = await sess.call("left_click", { coordinate: [400, 300] });
    ok(!c.isError && rig.ex.capabilities.hitTest === "none", "niri cold: the first click waits for the doctor and passes (no dead window)", show(c));
  }


  console.log("\n[M4] final review: inconclusive wlroots doctors, the blind latch, dialogs at delivery, plain clicks");
  const realNow = Date.now;
  const later = async (ms, f) => { Date.now = () => realNow() + ms; try { return await f(); } finally { Date.now = realNow; } };
  const swayDoc = (extra) => ({ contract: 1, window_geometry: false, screenshot_mask: false, ...extra });
  for (const [label, doc] of [
    ["backend_reachable false (Wayland connect failed)", swayDoc({ backend_reachable: false })],
    ["sway IPC over its budget (reachable, compositor sway)", swayDoc({ backend_reachable: true, compositor: "sway" })],
    ["reachable, compositor unknown, SWAYSOCK set", swayDoc({ backend_reachable: true, compositor: "unknown" })],
  ]) {
    for (const under of ["firefox", "none"]) {
      const rig = loadRow("sway", { front: "calc", under, doctor: doc });
      await rig.ex.capabilitiesAsync(); await settle();
      const sess = cloudFor(rig);
      ok(rig.ex.capabilities.hitTest === undefined && !sess.getAllowedApps().some((a) => a.bundleId === SCREEN), `sway, ${label}: hit test kept, no "Entire screen" grant`, J([rig.ex.capabilities.hitTest, sess.getAllowedApps().map((a) => a.bundleId)]));
      const c = await sess.call("left_click", { coordinate: [400, 300] });
      ok(c.isError && (RE_UNDER_UNGRANTED.test(c.text) || RE_DESKTOP.test(c.text)), `sway, ${label}: click with ${under === "none" ? "the desktop" : "unapproved Firefox"} under the pointer refused`, show(c));
    }
    {
      const rig = loadRow("sway", { front: "calc", under: "calc", doctor: doc, portal: true });
      let e = null;
      try { await rig.ex.screenshot({ displayId: 1, allowedBundleIds: [CALC] }); } catch (err) { e = err; }
      ok(!!e && !rig.calls.some((c) => / zoom /.test(c) && !/--keep-window|--mask-all/.test(c)), `sway, ${label}: a masked capture is refused, never taken unmasked`, e ? e.message.slice(0, 160) : "captured");
    }
  }
  {
    // A real niri: reachable, compositor niri, no sway / Hyprland env.
    const rig = loadRow("niri", { front: "calc", under: "calc", doctor: { contract: 1, window_geometry: false, backend_reachable: true, compositor: "niri" } });
    await rig.ex.capabilitiesAsync(); await settle();
    ok(rig.ex.capabilities.hitTest === "none", "niri (reachable, compositor niri): the negative is certain - no hit test");
  }
  {
    // Geometry true, then an inconclusive (or even a certain) false: sticky.
    let n = 0;
    // niri env (no SWAYSOCK), so the later "no" is one the executor would trust.
    const rig = loadRow("niri", { front: "calc", under: "firefox", doctor: () => (n++ === 0 ? { contract: 1, window_geometry: true, backend_reachable: true, compositor: "niri" } : { contract: 1, window_geometry: false, backend_reachable: true, compositor: "niri" }) });
    await rig.ex.capabilitiesAsync(); await settle();
    ok(rig.ex.capabilities.hitTest === undefined, "geometry true first: hit test");
    await later(61000, async () => { await rig.ex.capabilitiesAsync(); await settle(); });
    await later(61000, () => rig.ex.capabilitiesAsync());
    ok(n >= 2 && rig.ex.capabilities.hitTest === undefined, "a later doctor without geometry does not take the hit test away (a seen true is kept)", J([n, rig.ex.capabilities.hitTest]));
  }
  {
    // none -> native between the gate and the delivery: still marked.
    let geo = false;
    const rig = loadRow("niri", { ...SCEN.ok, real: true, doctor: () => ({ contract: 1, window_geometry: geo, backend_reachable: true, compositor: "niri" }) });
    await rig.ex.capabilitiesAsync(); await settle();
    ok(rig.ex.capabilities.hitTest === "none", "niri: the gate sees no hit test");
    geo = true;
    await later(61000, () => rig.ex.capabilitiesAsync());
    ok(rig.ex.capabilities.hitTest === undefined, "... then the doctor reports geometry (the gate now asks the stricter per-app hit test)");
    rig.inputs.length = 0;
    await rig.ex.click(1844, 300, "left", 1);
    const press = rig.inputs.find((i) => i.cmd === "pointer-click");
    ok(!!press && press.discards && press.discards.button === true, "the delivery is still marked (blind latched for the lock)", J(press && press.discards));
    await rig.ex.__setLockHeld(true, "cse_next");
    await new Promise((r) => setTimeout(r, guardSrc.grace + 60));
    rig.inputs.length = 0;
    await rig.ex.click(1844, 300, "left", 1);
    const p2 = rig.inputs.find((i) => i.cmd === "pointer-click");
    ok(!!p2 && p2.discards && p2.discards.button === false, "a new lock on a hit-test backend: not marked", J(p2 && p2.discards));
    await rig.ex.__setLockHeld(false).catch(() => {});
  }
  for (const rowKey of ["gnome-nointro", "niri"]) {
    const rig = loadRow(rowKey, { ...SCEN.ok, real: true });
    await rig.ex.capabilitiesAsync(); await settle();
    rig.inputs.length = 0;
    await rig.ex.click(1844, 300, "left", 1);
    const p = rig.inputs.find((i) => i.cmd === "pointer-click");
    ok(!!p && p.discards.button === true && p.discards.keyDown === false, `${rowKey}: a plain click does not drop the user's keystrokes into Claude's windows`, J(p && p.discards));
    rig.inputs.length = 0;
    await rig.ex.click(1844, 300, "left", 1, ["ctrl"]);
    const p3 = rig.inputs.find((i) => i.cmd === "pointer-click");
    ok(!!p3 && p3.discards.keyDown === true, `${rowKey}: a click holding modifier keys marks keys too`, J(p3 && p3.discards));
    // A Claude dialog opens between the gate and the delivery.
    rig.s.dialog = true;
    rig.inputs.length = 0;
    let e = null;
    try { await rig.ex.click(1844, 300, "left", 1); } catch (err) { e = err; }
    ok(!!e && /A Claude dialog is open on the screen/.test(e.message) && !rig.inputs.length, `${rowKey}: with a Claude dialog open the delivery is refused (upstream's text), nothing sent`, e && e.message);
    await rig.ex.mouseUp().catch(() => {});
    ok(rig.inputs.some((i) => i.cmd === "left-mouse-up"), `${rowKey}: a button release still goes out with a dialog open`);
    rig.s.dialog = false;
    // Code tab: dialog -> refused; Claude's window focused -> keys refused.
    globalThis.__cdbCuAskBeforeControl = () => true;
    const session = { sessionId: "local_1", getCuAllowedApps: () => [{ bundleId: CALC, displayName: "Calculator", grantedAt: 1, tier: "full" }], getCuGrantFlags: () => ({}) };
    rig.s.dialog = true;
    const g1 = await globalThis.__cdbCuConsent.gate(session, "pointer", [[1844, 300]]);
    ok(!!g1 && /One of Claude's own dialogs is open/.test(g1.content[0].text), `${rowKey}: Code tab, Claude dialog open: a click is refused`, g1 && g1.content[0].text);
    rig.s.dialog = false;
    rig.s.focus = true; rig.s.front = "claude";
    const g2 = await globalThis.__cdbCuConsent.gate(session, "keyboard");
    const g3 = await globalThis.__cdbCuConsent.gate(session, "pointer", [[1844, 300]]);
    ok(!!g2 && RE_HOST_KEYS.test(g2.content[0].text) && g3 === null, `${rowKey}: Code tab, Claude's window focused: keystrokes refused, a click allowed (Claude's windows drop it)`, J([g2 && g2.content[0].text, g3]));
  }

  console.log("\n[M3] niri / river with no active window: the Screen pseudo-app, never null");
  for (const tier of ["full", "read"]) {
    const rig = loadRow("niri", { front: "none", under: "none" });
    await rig.ex.capabilitiesAsync(); await settle();
    const f = await rig.ex.getFrontmostApp();
    ok(f && f.bundleId === SCREEN, "niri, nothing focused: front app = the Screen pseudo-app", J(f));
    const sess = cloudFor(rig, tier);
    await sess.call("screenshot", {});
    const c = await sess.call("left_click", { coordinate: [400, 300] });
    const t = await sess.call("type", { text: "3*9" });
    if (tier === "full") ok(!c.isError && !t.isError, "niri, nothing focused, full grant: click and type pass", show(c) + " / " + show(t));
    else ok(c.isError && RE_READ.test(c.text) && t.isError && RE_READ.test(t.text), "niri, nothing focused, read-only grant: click and type refused by the tier", show(c) + " / " + show(t));
  }

  // ── [S] screenshots on two monitors ──────────────────────────────────────
  console.log("\n[S] screenshot() shape and the batch screenshot on two monitors");
  for (const rowKey of ["gnome-nointro", "x11"]) {
    const rig = loadRow(rowKey, SCEN.ok);
    await rig.ex.capabilitiesAsync(); await settle();
    const s1 = await rig.ex.screenshot({ displayId: 1, allowedBundleIds: [CALC] });
    ok(s1.displayId === 1 && s1.width === s1.imgW && s1.height === s1.imgH && s1.width > 0, `${rowKey}: screenshot({displayId:1}) has displayId / width / height`, J({ displayId: s1.displayId, width: s1.width, height: s1.height, imgW: s1.imgW }));
    const s0 = await rig.ex.screenshot({ allowedBundleIds: [CALC] });
    const rp = await rig.ex.resolvePrepareCapture({ allowedBundleIds: [CALC] });
    ok(s0.displayId === rp.displayId, `${rowKey}: screenshot() without a display = resolvePrepareCapture's display (${rp.displayId})`, s0.displayId + " vs " + rp.displayId);
    const z = await rig.ex.zoom({ x: 10, y: 10, w: 100, h: 100 }, [CALC], 1);
    ok(typeof z.base64 === "string" && z.width === z.imgW, `${rowKey}: zoom result carries width / height`);
    const D = loadDispatcher(rig.electron);
    const sess = cloudSession(D, rig, [{ bundleId: CALC, displayName: "Calculator", grantedAt: Date.now(), tier: "full" }], { selected: 1 });
    await sess.call("screenshot", {});
    const b = await sess.call("computer_batch", { actions: [{ action: "screenshot" }, { action: "wait", duration: 0 }] });
    ok(!b.isError && !/display undefined/.test(b.text) && !/which is different from your previous/.test(b.text), `${rowKey}: batch screenshot names the same monitor`, show(b));
    ok(!!sess.st.lastShot && sess.st.lastShot.width > 0 && sess.st.lastShot.displayId === 1, `${rowKey}: the batch screenshot's dims are kept (width, displayId 1)`, J(sess.st.lastShot));
    const c = await sess.call("left_click", { coordinate: [400, 300] });
    ok(!c.isError && rig.delivered.some((d) => d[0] === "click" && d[1] === 1444 + 400), `${rowKey}: the click after it lands on the second monitor (x ${1444 + 400})`, show(c) + " " + J(rig.delivered.filter((d) => d[0] === "click")));
  }
  // GNOME portal path: the shared monitor is the default for both.
  {
    const rig = loadRow("gnome-nointro", { ...SCEN.ok, portal: true });
    process.env.XDG_RUNTIME_DIR = "relative";
    SCREENS[0].is_shared = false;
    try {
      await rig.ex.__setLockHeld(true, "cse_portal");
      const s0 = await rig.ex.screenshot({ allowedBundleIds: [CALC] });
      const rp = await rig.ex.resolvePrepareCapture({ allowedBundleIds: [CALC] });
      ok(s0.displayId === 1 && rp.displayId === 1, "GNOME portal: screenshot() and resolvePrepareCapture() both default to the shared monitor (DP-1, display 1)", s0.displayId + " / " + rp.displayId + " " + rig.diag.filter((l) => /default display|zoom|screenshot/.test(l)).slice(-3).join(" | "));
    } catch (e) {
      ok(false, "GNOME portal default display", e && e.message);
    } finally {
      SCREENS[0].is_shared = true;
      await rig.ex.__setLockHeld(false).catch(() => {});
    }
  }

  // ── [K] kwin mode ────────────────────────────────────────────────────────
  console.log("\n[K] kwin mode (js/executor_linux.js): per-app gate and screenshot shape unchanged");
  {
    resetWorld();
    const kwinDisplays = [{ id: 1, label: "DP-1", bounds: R(0, 0, 1920, 1080), size: { width: 1920, height: 1080 }, workArea: R(0, 0, 1920, 1080), scaleFactor: 1 }];
    const screens = [{ id: "DP-1", name: "DP-1", geometry: R(0, 0, 1920, 1080), scale: 1, is_primary: true, is_active: true }];
    const kw = (app, g, extra = {}) => ({ id: app, title: app, desktopFileName: app, resourceClass: app, frameGeometry: g, geometry: g, output: "DP-1", isActive: false, is_active: false, ...extra });
    const state = { front: CALC, under: CALC };
    const reply = (s, args) => {
      if (s === "screens") return J(screens);
      if (s === "windows") return J([kw(CALC, R(0, 0, 800, 600), { isActive: state.front === CALC, is_active: state.front === CALC }), kw(FIREFOX, R(900, 0, 800, 600))]);
      if (s === "frontmost-app") return J({ bundleId: state.front, displayName: state.front });
      if (s === "app-under-point") return state.under ? J({ bundleId: state.under, displayName: state.under }) : "null";
      if (s === "screenshot") return J({ base64: PNG.toString("base64"), width: 1920, height: 1080 });
      return "{}";
    };
    const cpStub = { execFile(bin, args, opts, cb) { if (typeof opts === "function") cb = opts; setImmediate(() => cb(null, { stdout: reply((args || [])[0], args), stderr: "" })); }, spawnSync() { return { status: 0 }; } };
    const src = readFileSync(KWIN, "utf8")
      .replace("import { execFile as execFileCb, spawnSync } from 'node:child_process'", "const { execFile: execFileCb, spawnSync } = __cp")
      .replace("import { screen as electronScreen } from 'electron'", "const electronScreen = __screen")
      .replace("import { promisify } from 'node:util'", "const { promisify } = __util")
      .replace(/^export /gm, "");
    globalThis.__cdbDiag = () => {};
    globalThis.__cuKwinBridgeBin = "/res/kwin-portal-bridge";
    globalThis.__cuKwinMode = true;
    const quiet = console.debug;
    console.debug = () => {};
    if (/^import /m.test(src)) { ok(false, "executor_linux.js imports changed - update this splice"); }
    else try {
      const mod = new Function("__cp", "__util", "__screen", src + "\nreturn { createLinuxExecutor };")(cpStub, nodeRequire("node:util"), { getAllDisplays: () => kwinDisplays, getPrimaryDisplay: () => kwinDisplays[0] });
      const kx = mod.createLinuxExecutor({ hostBundleId: "com.anthropic.claude" });
      await kx.__setLockHeld(true, "cse_kwin");
      ok(kx.capabilities.hitTest === undefined, "kwin capabilities: no hitTest (upstream's per-app gate)", J(kx.capabilities));
      const electron = { app: { getName: () => "Claude" }, BrowserWindow: { getFocusedWindow: () => null }, screen: {} };
      const D = loadDispatcher(electron);
      for (const m of ["click", "moveMouse", "type", "key"]) kx[m] = async () => {};
      const sess = cloudSession(D, { ex: kx }, [{ bundleId: CALC, displayName: "Calculator", grantedAt: Date.now(), tier: "full" }]);
      const s = await sess.call("screenshot", {});
      ok(!s.isError, "kwin: screenshot", show(s));
      ok(J(sess.getAllowedApps().map((a) => a.bundleId)) === J([CALC]), "kwin: no pseudo-grant in cloud grants");
      let c = await sess.call("left_click", { coordinate: [100, 100] });
      ok(!c.isError, "kwin: click on the granted app passes", show(c));
      state.under = FIREFOX;
      c = await sess.call("left_click", { coordinate: [100, 100] });
      ok(c.isError && RE_UNDER_UNGRANTED.test(c.text), "kwin: click on an unapproved app is refused", show(c));
      state.under = null;
      c = await sess.call("left_click", { coordinate: [100, 100] });
      ok(c.isError && RE_DESKTOP.test(c.text), "kwin: click on the desktop is refused", show(c));
      const b = await sess.call("computer_batch", { actions: [{ action: "screenshot" }, { action: "wait", duration: 0 }] });
      ok(!b.isError && !/display undefined/.test(b.text), "kwin: batch screenshot", show(b));
      const shot = await kx.screenshot({ displayId: undefined });
      ok(typeof shot.width === "number" && typeof shot.height === "number" && shot.displayId !== undefined, "kwin: screenshot() has width / height / displayId", J({ w: shot.width, h: shot.height, d: shot.displayId }));
      await kx.__setLockHeld(false).catch(() => {});
    } finally { console.debug = quiet; }
    resetWorld();
  }
}

// ── [C] the Code-tab gate on GNOME and niri ─────────────────────────────────
// The released executor (git tag v4.23118.1-6) answered null in front on GNOME
// and the bridge's own answers on niri; the new one answers the Screen
// pseudo-app / Claude / Claude's dialog. js/cu_consent.js must read them as
// before: every gate answer below must equal the released pair's.
// Two deliberate differences from the released gate (issue #326 review):
// Claude's own window in front refuses keystrokes on GNOME too (the executor
// now names it from Electron's focus, a known positive; the released gate let
// them through into Claude's prompt), and a Claude dialog refuses all input
// (upstream's input guard does not cover native dialogs).
console.log("\n[C] Code-tab gate (js/cu_consent.js) on GNOME and niri against the released one; access texts");
{
  const rel = (f) => { try { return execFileSync("git", ["-C", repo, "show", "v4.23118.1-6:js/" + f], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } };
  const relExec = rel("cu_linux_executor.js"), relConsent = rel("cu_consent.js");
  if (!relExec || !relConsent) {
    console.log("  SKIP the released comparison: tag v4.23118.1-6 is not in this checkout");
  } else {
    const d = scratchDir("rel");
    writeFileSync(path.join(d, "exec.js"), relExec);
    writeFileSync(path.join(d, "consent.js"), relConsent);
    const session = { sessionId: "local_1", getCuAllowedApps: () => [{ bundleId: CALC, displayName: "Calculator", grantedAt: 1, tier: "full" }], getCuGrantFlags: () => ({}) };
    const scenarios = { "nothing focused": { front: "none", under: "none" }, "Calculator focused": { front: "calc", under: "calc" }, "Claude focused": { front: "claude", under: "claude", focus: true }, "Claude dialog open": { front: "calc", under: "calc", dialog: true }, "Firefox focused": { front: "firefox", under: "calc" } };
    for (const rowKey of ["gnome-nointro", "niri"]) {
      for (const [sk, sc] of Object.entries(scenarios)) {
        const answers = [];
        for (const src of [{ exec: path.join(d, "exec.js"), consent: path.join(d, "consent.js") }, {}]) {
          const rig = loadRow(rowKey, sc, src);
          await rig.ex.capabilitiesAsync(); await settle();
          globalThis.__cdbCuAskBeforeControl = () => true;
          const cc = globalThis.__cdbCuConsent;
          const out = [];
          for (const kind of ["pointer", "keyboard"]) {
            const r = await cc.gate(session, kind, kind === "pointer" ? [[1844, 300]] : null);
            out.push(r ? r.content[0].text : "allowed");
          }
          answers.push(out);
        }
        const DLG = "One of Claude's own dialogs is open on the shared screen. Wait for the user to answer it before clicking, scrolling or typing.";
        const KEYS = "Claude's own window still has keyboard focus, so the keystrokes would land in it. Click on the target application first.";
        const want = sk === "Claude dialog open" ? [DLG, DLG] : sk === "Claude focused" && rowKey === "gnome-nointro" ? [answers[0][0], KEYS] : answers[0];
        ok(J(want) === J(answers[1]), `${rowKey}, ${sk}: Code-tab gate (pointer, keyboard) ${J(want) === J(answers[0]) ? "= released" : "= released except the stated change"}`, J(answers[0]) + " -> " + J(answers[1]));
      }
    }
  }
  for (const rowKey of ["gnome-nointro", "niri"]) {
    const rig = loadRow(rowKey, SCEN.ok);
    await rig.ex.capabilitiesAsync(); await settle();
    globalThis.__cdbCuAskBeforeControl = () => true;
    const cc = globalThis.__cdbCuConsent;
    if (!cc || typeof globalThis.__cdbCuScreenOnly !== "function") { ok(false, rowKey + ": consent module with __cdbCuScreenOnly"); continue; }
    const m = cc.mode();
    ok(m.frontmost === (rowKey === "niri" ? "native" : "none") && m.hitTest === "none", `${rowKey}: consent mode frontmost ${rowKey === "niri" ? "native" : "none"}, hit test none`, J(m));
    ok(globalThis.__cdbCuScreenOnly() === true && globalThis.__cdbCuNoScreenGrant() === true, `${rowKey}: whole shared screen; with ask-before-control on the local "Entire screen" stays out (Code-tab list unchanged)`);
    console.log(`    ${rowKey} access: ${cc.text("access")}`);
    console.log(`    ${rowKey} input:  ${cc.text("input")}`);
    const want = rowKey === "niri" ? /This session cannot tell which window is under a point: clicks and keystrokes go to whatever is there, and they are refused while an app that is not approved is in front/ : /This session cannot tell which window is under a point or in front: clicks and keystrokes go to whatever is there, so keep to the approved apps/;
    ok(want.test(cc.text("access")), `${rowKey}: the access text states what the backend can check`);
  }
  resetWorld();
}

console.log(`\n${pass} passed, ${failures.length} failed${skipped ? " (bundle sections skipped)" : ""}`);
if (failures.length) { for (const f of failures) console.log("  - " + f); process.exit(1); }
process.exit(skipped ? SKIP_EXIT : 0);
