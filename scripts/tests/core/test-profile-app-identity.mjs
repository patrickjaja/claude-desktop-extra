#!/usr/bin/env node
/*
 * test-profile-app-identity.mjs - per-profile window identity (issue #319):
 * patches/core/fix_profile_app_identity.nim and the head script it embeds,
 * js/profile_app_identity.js.
 *
 * What can break a user here:
 *   - the default profile touched at all (a replaced app method, a written env
 *     var): the maintainer's hard constraint is byte-identical behaviour;
 *   - a named profile handing itself the system claude:// handler (Electron's
 *     protocol-client calls read CHROME_DESKTOP, so they must see the base name);
 *   - a switch to an app_id no .desktop file backs (the taskbar loses the icon);
 *   - a hostile CLAUDE_PROFILE building a path;
 *   - a second patch run injecting twice, or a head-script order that breaks
 *     fix_profile_url_routing or `node --check`.
 *
 * The compiled patch runs against a minimal "use strict" bundle head (and the
 * pristine tmp/ extract's index.js when present); the PATCHED file then runs in
 * a vm with a fake process, a fake `electron` and the real fs pointed at temp
 * XDG dirs. Nothing is read from the injected source except by executing it.
 *
 * PAI_PATCH_BIN overrides the patch binary (e.g. /bin/true to measure the
 * harness against a tree without the patch).
 *
 * Usage: node scripts/tests/core/test-profile-app-identity.mjs
 * Exit: 0 = PASS, 1 = FAIL, 3 = SKIP (patch not compiled).
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PATCH_BIN = process.env.PAI_PATCH_BIN || join(ROOT, "patches", "core", "fix_profile_app_identity");
const ROUTE_BIN = join(ROOT, "patches", "core", "fix_profile_url_routing");
const PRISTINE = join(ROOT, "tmp", "app.asar.contents", ".vite", "build", "index.js");
const nodeRequire = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  PASS " + label); return; }
  fail++;
  console.error("  FAIL " + label + (extra !== undefined ? "  -> " + extra : ""));
}
function section(t) { console.log("\n" + t); }
const J = (v) => JSON.stringify(v);

if (!existsSync(PATCH_BIN)) {
  console.log("SKIP: " + PATCH_BIN + " is not compiled (cd patches && make)");
  process.exit(3);
}

const work = mkdtempSync(join(tmpdir(), "cdb-pai-"));
process.on("exit", () => { try { rmSync(work, { recursive: true, force: true }); } catch (e) {} });

const BASE = "com.anthropic.Claude.desktop";
let caseNo = 0;
const HEAD = '"use strict";globalThis.__restRan=(globalThis.__restRan||0)+1;\n';

function runBin(bin, file) {
  const r = spawnSync(bin, [file], { encoding: "utf8" });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
function nodeCheck(file) {
  return spawnSync(process.execPath, ["--check", file], { encoding: "utf8" }).status;
}

// ---------------------------------------------------------------- patch file
section("[1] patch applies once, is idempotent, keeps the bundle valid");
const fixture = join(work, "index.js");
writeFileSync(fixture, HEAD);
const r1 = runBin(PATCH_BIN, fixture);
ok(r1.status === 0, "first run exits 0", r1.out);
const once = readFileSync(fixture, "utf8");
ok(once !== HEAD, "first run changed the file");
ok(once.startsWith('"use strict";;(function __cdbProfileAppIdentity(){'), "head script sits right after \"use strict\"", once.slice(0, 60));
ok(once.endsWith(HEAD.slice('"use strict";'.length)), "upstream code kept intact after it");
const r2 = runBin(PATCH_BIN, fixture);
ok(r2.status === 0 && readFileSync(fixture, "utf8") === once, "second run exits 0 and changes nothing", r2.out);
ok(/\[OK\].*already present/.test(r2.out), "second run reports the positive already-present check", r2.out);
ok(nodeCheck(fixture) === 0, "patched fixture passes node --check");

// A foreign occurrence of the marker that is not our exact script must fail loud.
const forged = join(work, "forged.js");
writeFileSync(forged, '"use strict";;(function __cdbProfileAppIdentity(){return})();\n');
const rf = runBin(PATCH_BIN, forged);
ok(rf.status !== 0 && /\[FAIL\]/.test(rf.out), "marker without our exact script -> [FAIL], non-zero exit", rf.status + " " + rf.out);
const noStrict = join(work, "nostrict.js");
writeFileSync(noStrict, "var x=1;\n");
const rn = runBin(PATCH_BIN, noStrict);
const rnTxt = readFileSync(noStrict, "utf8");
ok(rn.status === 0 && rnTxt.startsWith(";(function __cdbProfileAppIdentity(){") && rnTxt.endsWith("var x=1;\n") && nodeCheck(noStrict) === 0, "bundle head without \"use strict\" (an earlier patch prepended): prepended, node --check ok", rn.status + " " + rn.out);

if (existsSync(ROUTE_BIN)) {
  for (const order of [[PATCH_BIN, ROUTE_BIN], [ROUTE_BIN, PATCH_BIN]]) {
    const f = join(work, "order.js");
    writeFileSync(f, HEAD);
    const st = order.map((b) => runBin(b, f).status);
    const txt = readFileSync(f, "utf8");
    const tag = order[0] === PATCH_BIN ? "identity first" : "url routing first";
    ok(st.every((s) => s === 0), tag + ": both patches exit 0", J(st));
    ok(txt.includes("function __cdbProfileAppIdentity(){") && txt.includes("[claude-profile-route]"), tag + ": both head scripts present");
    ok(txt.startsWith('"use strict";') && nodeCheck(f) === 0, tag + ": starts with \"use strict\" and passes node --check");
    ok(st.length === 2 && runBin(order[0], f).status === 0 && runBin(order[1], f).status === 0 && readFileSync(f, "utf8") === txt, tag + ": re-running both changes nothing");
    if (order[0] === ROUTE_BIN) {
      const res = runBundle(txt, { profile: "t319", desktop: true });
      ok(res.app.desktopName === "com.anthropic.Claude-t319.desktop" && res.shellHooked && res.ctx.__restRan === 1, tag + ": both scripts run, upstream code runs once", J({ dn: res.app.desktopName, hooked: res.shellHooked, rest: res.ctx.__restRan }));
    }
  }
} else {
  console.log("  (fix_profile_url_routing not compiled - order checks skipped)");
}

if (existsSync(PRISTINE)) {
  const p = join(work, "pristine-index.js");
  writeFileSync(p, readFileSync(PRISTINE));
  const rp = runBin(PATCH_BIN, p);
  ok(rp.status === 0 && nodeCheck(p) === 0, "pristine tmp/ index.js: applies and passes node --check", rp.out);
} else {
  console.log("  (no tmp/app.asar.contents extract - pristine check skipped)");
}

// ---------------------------------------------------------------- runtime
// Runs the PATCHED bundle head with a fake process + electron. `env` is the
// starting environment; the fake setDesktopName mirrors Electron on Linux
// (it sets CHROME_DESKTOP).
function makeEnv(home, extra) {
  return Object.assign({ CHROME_DESKTOP: BASE, HOME: home, XDG_DATA_HOME: join(home, "share"), XDG_DATA_DIRS: join(home, "sys1") + ":" + join(home, "sys2") }, extra || {});
}

function runBundle(src, opts) {
  const home = join(work, "home" + (++caseNo));
  mkdirSync(join(home, "share", "applications"), { recursive: true });
  mkdirSync(join(home, "sys1", "applications"), { recursive: true });
  mkdirSync(join(home, "sys2", "applications"), { recursive: true });
  const profileName = opts.profile;
  if (opts.desktop) {
    const dir = join(home, opts.desktopDir || "share", "applications");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, (opts.desktopName || "com.anthropic.Claude-" + profileName + ".desktop")), opts.desktopBody || "[Desktop Entry]\n");
  }
  if (opts.setup) opts.setup(home);
  const env = makeEnv(home, opts.env);
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  if (profileName !== undefined) env.CLAUDE_PROFILE = profileName;
  if (opts.base !== undefined) { if (opts.base === null) delete env.CHROME_DESKTOP; else env.CHROME_DESKTOP = opts.base; }
  const envBefore = J(env);
  const calls = [];
  let readyCb = null;
  const app = {
    desktopName: null,
    setDesktopName(n) { calls.push(["setDesktopName", n]); this.desktopName = n; env.CHROME_DESKTOP = n; },
    isDefaultProtocolClient(s) { calls.push(["isDefaultProtocolClient", s, env.CHROME_DESKTOP, this === app, [...arguments]]); return "is-result"; },
    setAsDefaultProtocolClient(s) { calls.push(["setAsDefaultProtocolClient", s, env.CHROME_DESKTOP, this === app, [...arguments]]); if (opts.throwSet) throw new Error("boom"); return true; },
    removeAsDefaultProtocolClient(s) { calls.push(["removeAsDefaultProtocolClient", s, env.CHROME_DESKTOP, this === app, [...arguments]]); return false; },
    whenReady() { return { then(f) { readyCb = f; } }; },
  };
  const origProps = {};
  for (const k of Object.keys(app)) if (typeof app[k] === "function") origProps[k] = app[k];
  let shellHooked = false;
  const shell = { openExternal() {} };
  const origOpen = shell.openExternal;
  let electronRequired = false;
  const fakeProcess = { platform: opts.platform || "linux", env, getuid: () => 1000, pid: 1 };
  const ctx = {
    process: fakeProcess,
    console: { log() {}, warn() {} },
    Buffer,
    setTimeout: (f) => { f(); return 0; },
    require(m) {
      if (m === "electron") { electronRequired = true; return { app, shell }; }
      return nodeRequire(m);
    },
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: "index.js" });
  shellHooked = shell.openExternal !== origOpen;
  // "ready": upstream defines __cdbDiag in its ready handler; the queue flushes after it.
  const logs = [];
  ctx.__cdbDiag = (l) => logs.push(l);
  if (readyCb) readyCb();
  const replaced = Object.keys(origProps).filter((k) => app[k] !== origProps[k]);
  return { app, env, envBefore, calls, logs, ctx, replaced, electronRequired, shellHooked, home };
}

const patched = readFileSync(fixture, "utf8");
const untouched = (res) => res.replaced.length === 0 && J(res.env) === res.envBefore && res.calls.length === 0;

section("[2] default profile and non-named values touch nothing");
for (const [label, profile] of [["unset", undefined], ["empty", ""], ["default", "default"], ["path traversal", "../../x"], ["slash", "a/b"], ["space", "a b"], ["dot", "a.b"], ["newline", "a\nb"]]) {
  const res = runBundle(patched, { profile, desktop: profile !== undefined && /^[\w-]+$/.test(profile) });
  ok(untouched(res) && !res.electronRequired && res.logs.length === 0, "CLAUDE_PROFILE " + label + ": no app property replaced, env unchanged, electron not required, no log", J({ r: res.replaced, c: res.calls, e: res.electronRequired, l: res.logs }));
}
{
  const res = runBundle(patched, { profile: "t319", desktop: true, platform: "darwin" });
  ok(untouched(res) && !res.electronRequired, "non-linux named profile: nothing touched");
}
{
  // A "default.desktop"-shaped file must not tempt the default profile.
  const res = runBundle(patched, { profile: "default", desktop: true, desktopName: "com.anthropic.Claude-default.desktop" });
  ok(untouched(res), "CLAUDE_PROFILE=default with a -default.desktop present: untouched");
}

section("[3] named profile with its .desktop: switched");
const namedCase = (where) => runBundle(patched, { profile: "t319", desktop: true, desktopDir: where });
for (const where of ["share", "sys1", "sys2"]) {
  const res = namedCase(where);
  const want = "com.anthropic.Claude-t319.desktop";
  ok(res.env.CHROME_DESKTOP === want && res.app.desktopName === want, "file in " + where + ": CHROME_DESKTOP and setDesktopName -> " + want, J({ env: res.env.CHROME_DESKTOP, dn: res.app.desktopName }));
  ok(J(res.replaced.sort()) === J(["isDefaultProtocolClient", "removeAsDefaultProtocolClient", "setAsDefaultProtocolClient"]), "file in " + where + ": only the three protocol-client methods replaced", J(res.replaced));
  if (where === "share") {
    ok(res.logs.length === 2 && /^\[profile-identity\] named profile 't319'/.test(res.logs[0]) && /^\[profile-identity\] switched to com\.anthropic\.Claude-t319\.desktop/.test(res.logs[1]), "log: entry line + switched line, delivered after ready via __cdbDiag", J(res.logs));
  }
}
{
  const res = runBundle(patched, { profile: "w", desktop: true, desktopDir: ".local/share", env: { XDG_DATA_HOME: undefined } });
  ok(res.env.CHROME_DESKTOP === "com.anthropic.Claude-w.desktop", "XDG_DATA_HOME unset: falls back to $HOME/.local/share", res.env.CHROME_DESKTOP);
}
{
  const res = runBundle(patched, { profile: "w", desktop: true, desktopDir: "share", env: { XDG_DATA_DIRS: undefined, XDG_DATA_HOME: "/nonexistent-cdb" } });
  ok(res.env.CHROME_DESKTOP === BASE, "file only outside the searched dirs: untouched", res.env.CHROME_DESKTOP);
}
{
  // Base comes from Electron's value, not a literal.
  const res = runBundle(patched, { profile: "t319", base: "org.example.Other.desktop", desktop: true, desktopName: "org.example.Other-t319.desktop" });
  ok(res.env.CHROME_DESKTOP === "org.example.Other-t319.desktop", "base derived from CHROME_DESKTOP, no hard-coded id", res.env.CHROME_DESKTOP);
}

section("[4] named profile without a usable .desktop: identity unchanged");
{
  const res = runBundle(patched, { profile: "t319", desktop: false });
  ok(untouched(res), "no file: no app property replaced, env unchanged", J({ r: res.replaced, c: res.calls }));
  ok(res.logs.length === 2 && /no com\.anthropic\.Claude-t319\.desktop in XDG applications dirs/.test(res.logs[1]), "log: entry + no-.desktop line", J(res.logs));
}
{
  const res = runBundle(patched, { profile: "t319", desktop: true, desktopName: "com.anthropic.Claude-other.desktop" });
  ok(untouched(res), "another profile's file only: untouched");
}
{
  // A relative XDG dir resolves against the cwd; it must be ignored even when it holds the file.
  const rel = mkdtempSync(join(work, "rel-"));
  mkdirSync(join(rel, "x", "applications"), { recursive: true });
  writeFileSync(join(rel, "x", "applications", "com.anthropic.Claude-t319.desktop"), "x");
  const cwd = process.cwd();
  process.chdir(rel);
  let res;
  try { res = runBundle(patched, { profile: "t319", env: { XDG_DATA_HOME: "x", XDG_DATA_DIRS: "x" } }); } finally { process.chdir(cwd); }
  ok(untouched(res), "relative XDG dirs are ignored");
}
{
  // An invalid (relative) XDG_DATA_HOME falls back to ~/.local/share, per the XDG spec.
  const res = runBundle(patched, { profile: "t319", desktop: true, desktopDir: ".local/share", env: { XDG_DATA_HOME: "relative/share" } });
  ok(res.env.CHROME_DESKTOP === "com.anthropic.Claude-t319.desktop", "relative XDG_DATA_HOME + file in ~/.local/share/applications: switched", res.env.CHROME_DESKTOP);
}
{
  const res = runBundle(patched, { profile: "t319", desktop: true, desktopDir: ".local/share", env: { XDG_DATA_HOME: "" } });
  ok(res.env.CHROME_DESKTOP === "com.anthropic.Claude-t319.desktop", "empty XDG_DATA_HOME + file in ~/.local/share/applications: switched", res.env.CHROME_DESKTOP);
}
{
  const res = runBundle(patched, { profile: "d", setup: (h) => mkdirSync(join(h, "share", "applications", "com.anthropic.Claude-d.desktop"), { recursive: true }) });
  ok(untouched(res), "a directory named like the .desktop does not count");
}
for (const [label, base] of [["missing", null], ["no .desktop suffix", "com.anthropic.Claude"], ["with slash", "../x.desktop"]]) {
  const res = runBundle(patched, { profile: "t319", desktop: true, base });
  ok(untouched(res) && res.logs.length === 2 && /bad base desktop name/.test(res.logs[1]), "base " + label + ": untouched, bad-base line", J({ r: res.replaced, l: res.logs }));
}

section("[4b] Hidden=true (a menu editor's \"deleted\") counts as absent");
const HID = "[Desktop Entry]\nName=Claude (t319)\nType=Application\n  Hidden = true \nNoDisplay=false\n";
const WANT = "com.anthropic.Claude-t319.desktop";
{
  const res = runBundle(patched, { profile: "t319", desktop: true, desktopBody: HID });
  ok(untouched(res), "Hidden=true in XDG_DATA_HOME: untouched", J({ r: res.replaced, e: res.env.CHROME_DESKTOP }));
  ok(res.logs.length === 2 && /no com\.anthropic\.Claude-t319\.desktop in XDG applications dirs/.test(res.logs[1]) && /Hidden=true/.test(res.logs[1]), "log: no-.desktop line with the Hidden hint", J(res.logs));
}
{
  // The hidden file masks a visible copy in a later dir (XDG lookup: first match wins).
  const res = runBundle(patched, { profile: "t319", desktop: true, desktopBody: HID, setup: (h) => writeFileSync(join(h, "sys1", "applications", WANT), "[Desktop Entry]\n") });
  ok(untouched(res), "Hidden=true in XDG_DATA_HOME + visible copy in XDG_DATA_DIRS: untouched (masked)", res.env.CHROME_DESKTOP);
}
{
  // A visible file in an earlier dir wins over a hidden one later.
  const res = runBundle(patched, { profile: "t319", desktop: true, setup: (h) => writeFileSync(join(h, "sys1", "applications", WANT), HID) });
  ok(res.env.CHROME_DESKTOP === WANT, "visible in XDG_DATA_HOME, hidden later: switched", res.env.CHROME_DESKTOP);
}
for (const [label, body] of [["Hidden=false", "[Desktop Entry]\nHidden=false\n"], ["Hidden=True (value is case-sensitive)", "[Desktop Entry]\nHidden=True\n"], ["X-Hidden=true (other key)", "[Desktop Entry]\nX-Hidden=true\n"]]) {
  const res = runBundle(patched, { profile: "t319", desktop: true, desktopBody: body });
  ok(res.env.CHROME_DESKTOP === WANT, label + ": switched", res.env.CHROME_DESKTOP);
}
if (typeof process.getuid === "function" && process.getuid() !== 0) {
  const res = runBundle(patched, { profile: "t319", desktop: true, desktopBody: HID, setup: (h) => chmodSync(join(h, "share", "applications", WANT), 0o000) });
  ok(res.env.CHROME_DESKTOP === WANT, "unreadable file (even one saying Hidden=true): counts as present, switched", res.env.CHROME_DESKTOP);
} else {
  console.log("  (root: unreadable-file case skipped)");
}

section("[5] protocol-client wrappers run with the base name");
{
  const res = namedCase("share");
  const want = "com.anthropic.Claude-t319.desktop";
  res.calls.length = 0;
  const r = res.app.isDefaultProtocolClient("claude");
  const c = res.calls.find((x) => x[0] === "isDefaultProtocolClient");
  ok(r === "is-result", "isDefaultProtocolClient returns the original's result", r);
  ok(c && c[2] === BASE, "isDefaultProtocolClient sees CHROME_DESKTOP=" + BASE + " during the call", J(c));
  ok(c && c[3] === true, "original called with this === app");
  ok(res.env.CHROME_DESKTOP === want && res.app.desktopName === want, "restored to the profile name afterwards", J({ e: res.env.CHROME_DESKTOP, d: res.app.desktopName }));
  ok(res.app.setAsDefaultProtocolClient("claude") === true && res.calls.find((x) => x[0] === "setAsDefaultProtocolClient")[2] === BASE, "setAsDefaultProtocolClient: base during, original result back");
  ok(res.app.removeAsDefaultProtocolClient("claude") === false && res.calls.find((x) => x[0] === "removeAsDefaultProtocolClient")[2] === BASE, "removeAsDefaultProtocolClient: base during, original result back");
  ok(res.env.CHROME_DESKTOP === want, "still the profile name after all three");

  // Every argument reaches the original, in order (protocol, path, args).
  res.calls.length = 0;
  const argv = ["claude", "/opt/x/claude", ["--profile=t319", "%u"]];
  for (const k of ["isDefaultProtocolClient", "setAsDefaultProtocolClient", "removeAsDefaultProtocolClient"]) {
    res.app[k](...argv);
    const c = res.calls.find((x) => x[0] === k);
    ok(c && J(c[4]) === J(argv) && c[4][2] === argv[2] && c[3] === true && c[2] === BASE, k + ": forwards protocol, path and args unchanged, this === app, base name during", J(c));
  }

  // Quick Entry may have swapped the name meanwhile: the PRIOR value comes back.
  res.app.setDesktopName("claude-quick-entry.desktop");
  res.app.isDefaultProtocolClient("claude");
  ok(res.env.CHROME_DESKTOP === "claude-quick-entry.desktop" && res.app.desktopName === "claude-quick-entry.desktop", "restores the value current before the call, not a constant", J({ e: res.env.CHROME_DESKTOP, d: res.app.desktopName }));
}
{
  const res = runBundle(patched, { profile: "t319", desktop: true, throwSet: true });
  let threw = null;
  try { res.app.setAsDefaultProtocolClient("claude"); } catch (e) { threw = e.message; }
  ok(threw === "boom", "original's exception propagates", threw);
  ok(res.env.CHROME_DESKTOP === "com.anthropic.Claude-t319.desktop" && res.app.desktopName === "com.anthropic.Claude-t319.desktop", "restored after the original throws", res.env.CHROME_DESKTOP);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
