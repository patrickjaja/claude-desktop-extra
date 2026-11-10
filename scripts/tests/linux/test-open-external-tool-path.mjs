#!/usr/bin/env node
// shell.openExternal / shell.openPath under upstream's PATH narrowing
// (patches/linux/fix_open_external_tool_path.nim, js/open_external_tool_path.js).
//
// WHY THIS EXISTS
// ---------------
// Since 4.23118 upstream narrows process.env.PATH at startup to fixed system
// dirs. Electron's shell.openExternal and shell.openPath execvp `xdg-open` from
// the live process.env.PATH synchronously inside the call (measured with
// Electron 44) and fail silently. Where xdg-open is only in a root-managed
// folder of the started PATH (as with the Nix package's wrapper), every link
// did nothing. The hook runs the synchronous
// call with the shared resolver's TOOL PATH - only when xdg-open is missing
// from the narrowed PATH and found in a root-owned read-only folder - and
// restores PATH on the same tick. Everything else must reach the original
// untouched, and the hook must compose with fix_profile_url_routing's wrapper
// in both orders.
//
// OPEN_EXTERNAL_JS / TOOL_PATH_JS override the files under test.
// Exit: 0 PASS, 3 SKIP, other FAIL.

import { readFileSync, writeFileSync, mkdtempSync, rmSync, accessSync, constants } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import { NARROWED, makeHost } from "../lib/tool-path-vectors.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HOOK = readFileSync(process.env.OPEN_EXTERNAL_JS || join(ROOT, "js", "open_external_tool_path.js"), "utf8");
const RESOLVER = readFileSync(process.env.TOOL_PATH_JS || join(ROOT, "js", "tool_path.js"), "utf8");
const ROUTING_NIM = readFileSync(join(ROOT, "patches", "core", "fix_profile_url_routing.nim"), "utf8");
const ROUTING = (ROUTING_NIM.match(/const URL_ROUTING_JS =\n  """([\s\S]*?)"""/) || [])[1];
const PATCH_BIN = join(ROOT, "patches", "linux", "fix_open_external_tool_path");

let pass = 0;
const failures = [];
function check(label, ok, extra) {
  if (ok) { pass++; console.log("  PASS " + label); return; }
  failures.push(label);
  console.log("  FAIL " + label + (extra !== undefined ? "  -> " + String(extra).slice(0, 1200) : ""));
}
const section = (t) => console.log("\n" + t);

const STORE = "/nix/store/aaaa-xdg-utils-1.2/bin";
const STORE_DIRS = { "/nix/store/aaaa-xdg-utils-1.2": { uid: 0, ro: "EROFS" }, [STORE]: { uid: 0, ro: "EROFS" } };
const PLANTED = "/home/u/.local/bin";
const narrowed = (started) => ({ PATH: NARROWED, CLAUDE_DESKTOP_NARROWED_PATH: NARROWED, CLAUDE_DESKTOP_STARTED_PATH: started });
const HOSTS = {
  distro: { host: { files: ["/usr/bin/xdg-open", PLANTED + "/xdg-open"] }, env: narrowed(PLANTED + ":/usr/bin") },
  off: { host: { files: [PLANTED + "/xdg-open"] }, env: { PATH: PLANTED + ":/usr/bin" } },
  nix: { host: { dirs: STORE_DIRS, files: [STORE + "/xdg-open", PLANTED + "/xdg-open"] }, env: narrowed(PLANTED + ":" + STORE + ":/run/current-system/sw/bin") },
  planted: { host: { files: [PLANTED + "/xdg-open"] }, env: narrowed(PLANTED + ":/usr/bin") }
};

// A main-process stand-in: fake process + electron.shell recording the PATH
// each call saw; real hook, real resolver (unless opts.resolver === false),
// optionally the url-routing wrapper before or after the hook.
function rig(kind, opts = {}) {
  const h = HOSTS[kind];
  const host = makeHost(h.host);
  const proc = { platform: opts.platform || "linux", env: { ...h.env, XDG_RUNTIME_DIR: "/run/user/1000" }, getuid: () => 1000 };
  const calls = [], diag = [], written = [];
  const RET = { tag: "upstream-return" };
  const shell = {
    openExternal(url, o) { calls.push({ m: "openExternal", self: this, args: [...arguments], PATH: proc.env.PATH }); if (url === "throw://") throw new Error("boom"); return RET; },
    openPath(p) { calls.push({ m: "openPath", self: this, args: [...arguments], PATH: proc.env.PATH }); return RET; },
    showItemInFolder(p) { calls.push({ m: "showItemInFolder", PATH: proc.env.PATH }); }
  };
  const origs = { openExternal: shell.openExternal, openPath: shell.openPath, showItemInFolder: shell.showItemInFolder };
  const fs = { ...host.fs, writeFileSync: (p, d) => written.push(String(p)) };
  const ctx = {
    process: proc, console: { log() {}, warn() {} }, setTimeout, Date,
    require: (id) => ({ fs, path, electron: { shell, app: { whenReady: () => Promise.resolve() } } })[id] || (() => { throw new Error("unexpected require " + id); })(),
    __cdbDiag: (m) => diag.push(String(m))
  };
  vm.createContext(ctx);
  if (opts.resolver !== false) vm.runInContext(RESOLVER, ctx);
  if (opts.routing === "before") vm.runInContext(ROUTING, ctx);
  vm.runInContext(HOOK, ctx);
  if (opts.routing === "after") vm.runInContext(ROUTING, ctx);
  return { shell, origs, calls, diag, proc, written, RET, host };
}

section("untouched situations: the original gets the same this/args/PATH and its return value comes back");
for (const [label, kind, o] of [
  ["mainstream distro (xdg-open on the narrowed PATH)", "distro", {}],
  ["narrowing off (flag restored the started PATH)", "off", {}],
  ["resolver missing", "nix", { resolver: false }],
  ["xdg-open only in a user-writable folder", "planted", {}]
]) {
  const r = rig(kind, o);
  const before = r.proc.env.PATH;
  const ret = r.shell.openExternal("https://example.com/", { activate: true });
  const c = r.calls[0];
  check(`${label}: openExternal reaches upstream with the unchanged PATH`, c && c.PATH === before && c.self === r.shell && c.args[0] === "https://example.com/" && c.args[1].activate === true && c.args.length === 2, JSON.stringify(c && { PATH: c.PATH, args: c.args }));
  check(`${label}: return value passed through, PATH unchanged after`, ret === r.RET && r.proc.env.PATH === before);
  r.shell.openPath("/home/u/file.pdf");
  check(`${label}: openPath unchanged too`, r.calls[1] && r.calls[1].PATH === before);
  check(`${label}: no openExternal diag line`, !r.diag.some((d) => /openExternal:/.test(d)), JSON.stringify(r.diag));
  if (kind === "planted") check("planted copy: the call never sees a PATH containing ~/.local/bin", !String(c.PATH).includes(PLANTED));
}
{
  const r = rig("nix", { platform: "win32" });
  check("non-Linux: nothing wrapped", r.shell.openExternal === r.origs.openExternal && r.shell.openPath === r.origs.openPath);
}

section("widened: xdg-open only in a root-managed store folder (Nix wrapper shape)");
{
  const r = rig("nix");
  const before = r.proc.env.PATH;
  const ret = r.shell.openExternal("https://claude.ai/login?x=1", { activate: false });
  const c = r.calls[0];
  check("openExternal runs with PATH = TOOL PATH (narrowed + store folder)", c && c.PATH === NARROWED + ":" + STORE, c && c.PATH);
  check("the TOOL PATH never holds the user-writable folder", c && !c.PATH.includes(PLANTED));
  check("this / arguments / return value preserved", c.self === r.shell && c.args.length === 2 && c.args[1].activate === false && ret === r.RET);
  check("PATH restored on the same tick", r.proc.env.PATH === before);
  let threw = null;
  try { r.shell.openExternal("throw://"); } catch (e) { threw = e; }
  check("upstream throws: the error propagates and PATH is restored", threw && threw.message === "boom" && r.proc.env.PATH === before);
  r.shell.openPath("/home/u/a.pdf");
  check("openPath widened the same way, restored after", r.calls[2].PATH === NARROWED + ":" + STORE && r.proc.env.PATH === before);
  r.shell.showItemInFolder("/home/u/a.pdf");
  check("showItemInFolder untouched (D-Bus first, async fallback)", r.calls[3].PATH === before && r.shell.showItemInFolder === r.origs.showItemInFolder);
  r.shell.openExternal("https://a/"); r.shell.openExternal("https://b/");
  const lines = r.diag.filter((d) => d.includes("openExternal: xdg-open -> " + STORE + "/xdg-open"));
  check("one diag line for openExternal, not one per call", lines.length === 1, JSON.stringify(r.diag));
  check("one diag line for openPath", r.diag.filter((d) => d.includes("openPath: xdg-open -> ")).length === 1);
  // PATH unset before the call: deleted again afterwards.
  delete r.proc.env.PATH;
  r.shell.openExternal("https://c/");
  check("PATH unset before: not widened (no narrowing), still unset after", !("PATH" in r.proc.env));
  // Flag flips at run time.
  r.proc.env.PATH = r.proc.env.CLAUDE_DESKTOP_STARTED_PATH;
  r.shell.openExternal("https://d/");
  check("flag restores the started PATH: untouched", r.calls[r.calls.length - 1].PATH === r.proc.env.CLAUDE_DESKTOP_STARTED_PATH);
  r.proc.env.PATH = NARROWED;
  r.shell.openExternal("https://e/");
  check("narrowed again: widened again", r.calls[r.calls.length - 1].PATH === NARROWED + ":" + STORE);
}

section("composition with fix_profile_url_routing (both orders)");
check("url-routing script found in its patch", typeof ROUTING === "string" && ROUTING.includes("[claude-profile-route]"));
for (const order of ["before", "after"]) {
  for (const kind of ["nix", "distro"]) {
    const r = rig(kind, { routing: order });
    const before = r.proc.env.PATH;
    const ret = r.shell.openExternal("https://accounts.example.com/oauth/authorize", { x: 1 });
    const c = r.calls[0];
    const want = kind === "nix" ? NARROWED + ":" + STORE : before;
    check(`routing ${order} hook, ${kind}: marker written, upstream reached once with the right PATH`,
      r.written.length === 1 && r.written[0].endsWith("claude-desktop-pending-auth-default") && r.calls.length === 1 && c.PATH === want && c.args[1].x === 1 && ret === r.RET && r.proc.env.PATH === before,
      JSON.stringify({ written: r.written, n: r.calls.length, PATH: c && c.PATH }));
  }
}

section("patch: inserts the head script, idempotent, fails loud");
let haveBin = true;
try { accessSync(PATCH_BIN, constants.X_OK); } catch { haveBin = false; }
if (!haveBin) {
  console.log("  SKIP (compile: cd patches && make -j\"$(nproc)\")");
} else {
  const dir = mkdtempSync(join(tmpdir(), "cdb-openext-"));
  const f = join(dir, "index.js");
  const run = (src) => { writeFileSync(f, src); try { return { s: 0, out: execFileSync(PATCH_BIN, [f], { encoding: "utf8", stdio: "pipe" }), src: readFileSync(f, "utf8") }; } catch (e) { return { s: e.status, out: String(e.stdout || ""), src: readFileSync(f, "utf8") }; } };
  const FIX = '"use strict";require("./index.chunk-x.js");\n';
  const r1 = run(FIX);
  check("first run: exit 0, no 'already', inserted after \"use strict\"", r1.s === 0 && !/already/i.test(r1.out) && r1.src.startsWith('"use strict";' + HOOK), r1.out);
  check("patched output passes node --check", spawnSync(process.execPath, ["--check", f]).status === 0);
  const r2 = run(r1.src);
  check("second run: unchanged, positive 'already present'", r2.s === 0 && r2.src === r1.src && /\[OK\].*already present/.test(r2.out), r2.out);
  const r3 = run(r1.src.replace("var _said={};", "var _said={};/*edited*/"));
  check("marker present but script edited -> exit 1", r3.s === 1, r3.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log("FAIL: " + failures.join("; ")); process.exit(1); }
if (!haveBin) { console.log("SKIP (patch checks need the compiled patch)"); process.exit(3); }
console.log("PASS");
