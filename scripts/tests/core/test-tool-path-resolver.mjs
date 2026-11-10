#!/usr/bin/env node
// The shared tool lookup (globalThis.__cdbToolPath, js/tool_path.js, inserted
// by patches/core/add_tool_path_resolver.nim) and the patch sites that use it.
//
// WHY THIS EXISTS
// ---------------
// Since 4.23118 upstream narrows process.env.PATH at startup to fixed system
// dirs and keeps the launch PATH in CLAUDE_DESKTOP_STARTED_PATH. Tools our
// patches ran by bare name (xdg-mime, xdg-open, hyprctl, git, qemu-system-*,
// secret-tool) stopped resolving from every root-managed dir outside that list:
// the NixOS wrapper's store dirs, /etc/profiles/per-user/<user>/bin, the rpm's
// qemu-shim dir. The resolver gives them the TOOL PATH back - the narrowed dirs
// plus the started dirs that pass upstream's trust rule - without ever taking a
// tool from a folder the user can write.
//
//   A  shared vectors (scripts/tests/lib/tool-path-vectors.mjs) against the
//      resolver AND the private copy in js/cu_linux_executor.js: the two
//      implementations cannot drift.
//   B  resolver-only API: which / toolEnv / appEnv / ignored, process.env.PATH
//      never written, frozen, win32 defines nothing, diagnostics queued until
//      __cdbDiag exists.
//   C  the core patch: inserts the head script, idempotent, fails loud.
//   D  sites (run through the compiled patches over upstream-shaped fixtures,
//      or the real js): open-in-editor xdg-mime, Quick Entry hyprctl, the
//      Chrome DevTools xdg-open, Diff views git (APP PATH, like upstream's own
//      git). Per TOOL PATH site: ordinary distro ->
//      the same tool by absolute path; narrowing off -> unchanged; NixOS
//      wrapper store dir -> found; planted ~/.local/bin copy -> never run;
//      resolver missing -> the old bare-name code.
// The qemu, host-tool and background-display sites are covered in their own
// harnesses (test-cowork-qemu-shim, test-host-tool-paths,
// test-cu-background-display-main).
//
// TOOL_PATH_JS / CU_EXECUTOR / DIFF_VIEWS_JS / PATCHES_DIR override the files
// under test (old-code runs). Exit: 0 PASS, 3 SKIP, other FAIL.

import { readFileSync, writeFileSync, mkdtempSync, rmSync, accessSync, constants } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import { VECTORS, NARROWED, makeHost, runVector, loadResolver, loadExecutorCopy } from "../lib/tool-path-vectors.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RESOLVER_JS = process.env.TOOL_PATH_JS || join(ROOT, "js", "tool_path.js");
const EXECUTOR_JS = process.env.CU_EXECUTOR || join(ROOT, "js", "cu_linux_executor.js");
const DIFF_VIEWS_JS = process.env.DIFF_VIEWS_JS || join(ROOT, "js", "diff_views_main.js");
const PATCHES = process.env.PATCHES_DIR || join(ROOT, "patches");
const RSRC = readFileSync(RESOLVER_JS, "utf8");

let pass = 0;
const failures = [];
function check(label, ok, extra) {
  if (ok) { pass++; console.log("  PASS " + label); return; }
  failures.push(label);
  console.log("  FAIL " + label + (extra !== undefined ? "  -> " + String(extra).slice(0, 1500) : ""));
}
const section = (t) => console.log("\n" + t);
const tick = () => new Promise((r) => setTimeout(r, 5));

// ---------------------------------------------------------------- A vectors
section("A: shared vectors, resolver (js/tool_path.js) and the executor's copy");
for (const [name, load, src] of [["resolver", loadResolver, RSRC], ["executor", loadExecutorCopy, readFileSync(EXECUTOR_JS, "utf8")]]) {
  for (const v of VECTORS) {
    let res;
    try { res = runVector(v, load, src); } catch (e) { res = [{ label: "load", ok: false, got: e.message }]; }
    const bad = res.filter((r) => !r.ok);
    check(`${name}: ${v.name} (${res.length} steps)`, bad.length === 0,
      bad.map((r) => `${r.label}: got ${JSON.stringify(r.got)} want ${JSON.stringify(r.want)}`).join(" | "));
  }
}

// ---------------------------------------------------------------- B API
section("B: resolver API");
const STORE = "/nix/store/aaaa-xdg-utils-1.2/bin";
const NIXHOST = { dirs: { "/nix/store/aaaa-xdg-utils-1.2": { uid: 0, ro: "EROFS" }, [STORE]: { uid: 0, ro: "EROFS" } } };
const narrowed = (started) => ({ PATH: NARROWED, CLAUDE_DESKTOP_NARROWED_PATH: NARROWED, CLAUDE_DESKTOP_STARTED_PATH: started });
// An env that records every write: the resolver must never set PATH.
function watchedEnv(init) {
  const writes = [];
  const env = new Proxy({ ...init }, {
    set(t, k, v) { writes.push(String(k)); t[k] = v; return true; },
    deleteProperty(t, k) { writes.push("delete " + String(k)); delete t[k]; return true; }
  });
  return { env, writes };
}
{
  const host = makeHost({ files: ["/home/u/.local/bin/git", "/usr/bin/git"] });
  const off = loadResolver(RSRC, host, { PATH: "/home/u/.local/bin:/usr/bin" }).raw;
  check("narrowing off: which() is the old execvp pick, as an absolute path", off.which("git") === "/home/u/.local/bin/git", off.which("git"));
  check("narrowing off: toolEnv() / appEnv() are null (inherit, as before)", off.toolEnv() === null && off.appEnv() === null);
  check("narrowing off: appPath() null, toolPath() = PATH", off.appPath() === null && off.toolPath() === "/home/u/.local/bin:/usr/bin");
  check("invalid names: null", ["", "a/b", "/usr/bin/git", ".", "..", null, 5].every((b) => off.which(b) === null && off.cmd(b) === null));
  check("the API object is frozen", Object.isFrozen(off));

  const w = watchedEnv(narrowed("/home/u/.local/bin:" + STORE + ":/usr/bin"));
  const h2 = makeHost({ ...NIXHOST, files: ["/usr/bin/git", STORE + "/xdg-open", "/home/u/.local/bin/hyprctl"] });
  const on = loadResolver(RSRC, h2, w.env).raw;
  check("which(): system tool by absolute path", on.which("git") === "/usr/bin/git");
  check("which(): store tool by absolute path", on.which("xdg-open") === STORE + "/xdg-open");
  check("which(): planted user copy -> null, ignored() names the dir", on.which("hyprctl") === null && on.ignored("hyprctl") === "/home/u/.local/bin");
  const te = on.toolEnv({ A: "1", PATH: "/x" });
  check("toolEnv(base): a copy with PATH = TOOL PATH, base untouched", te.A === "1" && te.PATH === NARROWED + ":" + STORE, JSON.stringify(te));
  const ae = on.appEnv();
  check("appEnv(): PATH = APP PATH (started entries first)", ae.PATH === "/home/u/.local/bin:" + STORE + ":/usr/bin:/usr/local/bin:/usr/local/sbin:/bin:/usr/sbin:/sbin:/snap/bin:/run/current-system/sw/bin:/run/current-system/profile/bin", ae.PATH);
  check("toolEnv() without base copies process.env", on.toolEnv().CLAUDE_DESKTOP_NARROWED_PATH === NARROWED);
  check("process.env is never written by any call", w.writes.length === 0, JSON.stringify(w.writes));

  // win32 / darwin: nothing defined, nothing required.
  for (const platform of ["win32", "darwin"]) {
    const req = [];
    const ctx = { process: { platform, env: {} }, require: (id) => { req.push(id); return {}; } };
    vm.runInNewContext(RSRC, ctx);
    check(`${platform}: no global, nothing required`, ctx.__cdbToolPath === undefined && req.length === 0, JSON.stringify(req));
  }
  // First definition wins.
  {
    const ctx = { process: { platform: "linux", env: {} }, require: (id) => (id === "fs" ? makeHost({}).fs : path), __cdbToolPath: "keep" };
    vm.runInNewContext(RSRC, ctx);
    check("an existing global is kept", ctx.__cdbToolPath === "keep");
  }
  // A miss is cached for a few seconds only: a tool installed while the app
  // runs is seen without a restart (the old bare-name spawn saw it at once).
  {
    let T = 1000000;
    const h4 = makeHost({ ...NIXHOST });
    const ctx = { process: { platform: "linux", env: narrowed(STORE) }, Date: { now: () => T }, setTimeout, __cdbDiag: () => {}, require: (id) => (id === "fs" ? h4.fs : path) };
    vm.runInNewContext(RSRC, ctx);
    const t = ctx.__cdbToolPath;
    const a = t.which("xdg-mime");
    h4.files.add(STORE + "/xdg-mime");
    const b = t.which("xdg-mime");
    T += 6000;
    const c = t.which("xdg-mime");
    check("a miss expires after a few seconds: installed tool found without fresh or restart", a === null && b === null && c === STORE + "/xdg-mime", JSON.stringify([a, b, c]));
    h4.files.delete(STORE + "/xdg-mime");
    T += 60000;
    check("a hit stays cached (the trusted chain cannot change without root)", t.which("xdg-mime") === STORE + "/xdg-mime");
  }
  // The global binding: first definition wins, also against an assignment.
  {
    const ctx = { process: { platform: "linux", env: {} }, require: (id) => (id === "fs" ? makeHost({}).fs : path) };
    vm.createContext(ctx);
    vm.runInContext(RSRC, ctx);
    const first = ctx.__cdbToolPath;
    let sloppy = "ok";
    try { vm.runInContext("globalThis.__cdbToolPath = {which(){return '/evil'}};", ctx); } catch (e) { sloppy = "threw " + e.message; }
    check("sloppy assignment: ignored, no throw", sloppy === "ok" && ctx.__cdbToolPath === first, sloppy);
    let strict = "ok";
    try { vm.runInContext('"use strict";globalThis.__cdbToolPath = {};', ctx); } catch (e) { strict = e.constructor.name; }
    check("strict assignment (the bundle head runs strict): TypeError, binding unchanged", strict === "TypeError" && ctx.__cdbToolPath === first, strict);
    const d = Object.getOwnPropertyDescriptor(ctx, "__cdbToolPath");
    check("descriptor: non-writable, non-configurable, enumerable", d && d.writable === false && d.configurable === false && d.enumerable === true, JSON.stringify(d && { w: d.writable, c: d.configurable, e: d.enumerable }));
    vm.runInContext(RSRC, ctx);
    check("a second copy of the script leaves the binding alone", ctx.__cdbToolPath === first);
  }
  // Diagnostics: queued while __cdbDiag is missing, flushed after ready.
  {
    const lines = [];
    let ready;
    const readyP = new Promise((r) => { ready = r; });
    const h3 = makeHost({ ...NIXHOST, files: [STORE + "/xdg-mime"] });
    const ctx = {
      process: { platform: "linux", env: narrowed(STORE) }, setTimeout,
      console: { log: (m) => lines.push("console:" + m) },
      require: (id) => (id === "fs" ? h3.fs : id === "path" ? path : id === "electron" ? { app: { whenReady: () => readyP } } : null)
    };
    vm.runInNewContext(RSRC, ctx);
    ctx.__cdbToolPath.which("xdg-mime");
    ctx.__cdbToolPath.which("xdg-mime", { fresh: true });
    check("before ready: nothing written to console (the official build drops it)", lines.length === 0, JSON.stringify(lines));
    ctx.__cdbDiag = (m) => lines.push(m);
    ready();
    await tick(); await tick();
    check("after ready: the queued line is flushed to __cdbDiag, once",
      lines.length === 1 && lines[0] === "[tool-path] xdg-mime -> " + STORE + "/xdg-mime (a root-owned read-only folder on the PATH Claude Desktop was started with)", JSON.stringify(lines));
  }
}

// ---------------------------------------------------------------- helpers
const bin = (rel) => join(PATCHES, rel);
let haveBins = true;
for (const b of ["core/add_tool_path_resolver", "linux/fix_open_in_editor_linux", "linux/fix_quick_entry_position", "linux/fix_browser_tools_linux"]) {
  try { accessSync(bin(b), constants.X_OK); } catch { haveBins = false; }
}
const scratch = mkdtempSync(join(tmpdir(), "cdb-tool-path-"));
function runPatch(b, src) {
  const f = join(scratch, "index.js");
  writeFileSync(f, src);
  let out = "", status = 0;
  try { out = execFileSync(bin(b), [f], { encoding: "utf8", stdio: "pipe" }); }
  catch (e) { status = typeof e.status === "number" ? e.status : -1; out = String(e.stdout || "") + String(e.stderr || ""); }
  return { status, out, src: readFileSync(f, "utf8"), file: f };
}
const nodeCheck = (f) => spawnSync(process.execPath, ["--check", f], { encoding: "utf8" }).status === 0;

// A host per site scenario; spawns simulate execvp against it: an absolute
// command runs when it is a file on the host, a bare name is looked up on the
// PATH of the spawn's env (or of process.env when there is none).
const PLANTED = "/home/u/.local/bin";
function scenario(kind, tool) {
  switch (kind) {
    case "distro": return { host: { files: ["/usr/bin/" + tool, PLANTED + "/" + tool] }, env: narrowed(PLANTED + ":/usr/bin"), resolver: true };
    case "distro-off": return { host: { files: ["/usr/bin/" + tool] }, env: { PATH: "/usr/bin:/bin" }, resolver: true };
    case "nix-wrapper": return { host: { ...NIXHOST, files: [STORE + "/" + tool] }, env: narrowed(PLANTED + ":" + STORE + ":/run/current-system/sw/bin"), resolver: true };
    case "planted": return { host: { files: [PLANTED + "/" + tool] }, env: narrowed(PLANTED + ":/usr/bin"), resolver: true };
    case "no-resolver": return { host: { files: ["/usr/bin/" + tool] }, env: narrowed(PLANTED + ":/usr/bin"), resolver: false };
  }
}
function execvp(host, cmd, env) {
  const c = String(cmd);
  if (c.includes("/")) return host.files.has(c) ? c : null;
  for (const d of String((env && env.PATH) || "").split(":")) if (d.startsWith("/") && host.files.has(d + "/" + c)) return d + "/" + c;
  return null;
}
// A vm context with the resolver (unless sc.resolver is false), a recording
// child_process and the host's fs.
function siteCtx(sc, extra = {}) {
  const host = makeHost(sc.host);
  const proc = { platform: "linux", env: { ...sc.env } };
  const ran = [];
  const record = (cmd, args, opts) => {
    const env = opts && opts.env ? opts.env : proc.env;
    const r = { cmd: String(cmd), args, hasEnv: !!(opts && "env" in opts && opts.env !== undefined), envPath: env.PATH, exec: execvp(host, cmd, env) };
    ran.push(r);
    return r;
  };
  const cp = {
    execFileSync(cmd, args, opts) {
      const r = record(cmd, args, opts);
      if (!r.exec) { const e = new Error("spawnSync " + cmd + " ENOENT"); e.code = "ENOENT"; throw e; }
      return extra.out || "";
    },
    spawn(cmd, args, opts) {
      const r = record(cmd, args, opts);
      const c = new EventEmitter();
      c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {};
      setImmediate(() => { if (!r.exec) { const e = new Error("spawn " + cmd + " ENOENT"); e.code = "ENOENT"; c.emit("error", e); } else { c.stdout.emit("data", Buffer.from("ok")); c.emit("close", 0); } });
      return c;
    }
  };
  const ctx = {
    process: proc, console: { log() {}, warn() {} }, setTimeout, clearTimeout, setImmediate, Buffer, Promise,
    require: (id) => ({ fs: host.fs, path, child_process: cp })[id] || (() => { throw new Error("unexpected require " + id); })(),
    __cdbDiag: () => {}
  };
  vm.createContext(ctx);
  if (sc.resolver) vm.runInContext(RSRC, ctx);
  return { ctx, ran, host, proc };
}
// The per-site expectations, shared by every site below.
function judge(site, kind, tool, r, envMustBeTool) {
  const label = `${site} [${kind}]`;
  if (!r) { check(label + ": the tool was spawned", false, "no spawn recorded"); return; }
  switch (kind) {
    case "distro":
      check(label + `: /usr/bin/${tool} by absolute path (same tool as before), never the planted copy`, r.cmd === "/usr/bin/" + tool && r.exec === "/usr/bin/" + tool, JSON.stringify(r));
      if (envMustBeTool) check(label + ": PATH in its env = the TOOL PATH (narrowed dirs only here)", r.envPath === NARROWED, r.envPath);
      break;
    case "distro-off":
      check(label + `: narrowing off - /usr/bin/${tool}, the same binary the bare name found`, r.exec === "/usr/bin/" + tool && (r.cmd === tool || r.cmd === "/usr/bin/" + tool), JSON.stringify(r));
      check(label + ": narrowing off - no env override", !r.hasEnv || r.envPath === "/usr/bin:/bin", JSON.stringify(r));
      break;
    case "nix-wrapper":
      check(label + `: the wrapper's store copy is found and run by absolute path`, r.cmd === STORE + "/" + tool && r.exec === STORE + "/" + tool, JSON.stringify(r));
      if (envMustBeTool) check(label + ": PATH in its env = narrowed + the store dir", r.envPath === NARROWED + ":" + STORE, r.envPath);
      break;
    case "planted":
      check(label + ": the planted ~/.local/bin copy is never run", r.exec !== PLANTED + "/" + tool && r.cmd !== PLANTED + "/" + tool, JSON.stringify(r));
      check(label + ": bare name on the narrowed PATH (fails like before, no wider PATH)", r.cmd === tool && r.envPath === NARROWED, JSON.stringify(r));
      break;
    case "no-resolver":
      check(label + ": resolver missing - the old bare-name call, inherited env", r.cmd === tool && !r.hasEnv, JSON.stringify(r));
      break;
  }
}
const KINDS = ["distro", "distro-off", "nix-wrapper", "planted", "no-resolver"];

if (!haveBins) {
  console.log("\nC/D: SKIP (compile the patches: cd patches && make -j\"$(nproc)\")");
} else {
  // ---------------------------------------------------------------- C core patch
  section("C: patches/core/add_tool_path_resolver");
  {
    const FIX = '"use strict";(function(){globalThis.__up=1})();require("./index.chunk-x.js");\n';
    const r1 = runPatch("core/add_tool_path_resolver", FIX);
    check("exits 0, no [FAIL], never 'already' on a first run", r1.status === 0 && !/\[FAIL\]/.test(r1.out) && !/already/i.test(r1.out), r1.out);
    check("inserted right after \"use strict\", ahead of upstream's code", r1.src.startsWith('"use strict";' + RSRC) && r1.src.endsWith('(function(){globalThis.__up=1})();require("./index.chunk-x.js");\n'));
    check("patched output passes node --check", nodeCheck(r1.file));
    const r2 = runPatch("core/add_tool_path_resolver", r1.src);
    check("second run: idempotent, positive assertion", r2.status === 0 && r2.src === r1.src && /\[OK\].*already present/.test(r2.out), r2.out);
    const r3 = runPatch("core/add_tool_path_resolver", "/*other head*/" + FIX);
    check("no leading \"use strict\" (an earlier head script prepended): at the very top", r3.status === 0 && r3.src.startsWith(RSRC + "/*other head*/"));
    const r4 = runPatch("core/add_tool_path_resolver", r1.src.replace('Object.defineProperty(globalThis, "__cdbToolPath", { value: Object.freeze({', 'Object.defineProperty(globalThis, "__cdbToolPath", { value: Object.freeze({ /*x*/'));
    check("defining line present but not our exact script -> exit 1", r4.status === 1, r4.out);
    const r5 = runPatch("core/add_tool_path_resolver", r1.src.replace("function __cdbToolPathInit(){", "function __cdbToolPathInit(){/*edited*/"));
    check("head present but script edited -> exit 1", r5.status === 1, r5.out);
    // The patched head evaluated as the main bundle would: global present on Linux.
    const ctx = { process: { platform: "linux", env: { PATH: "/usr/bin" } }, require: (id) => (id === "fs" ? makeHost({ files: ["/usr/bin/git"] }).fs : id === "path" ? path : {}) };
    vm.runInNewContext(r1.src.replace('require("./index.chunk-x.js");', ""), ctx);
    check("evaluated bundle head: __cdbToolPath defined before upstream code, PATH untouched", typeof ctx.__cdbToolPath.which === "function" && ctx.__up === 1 && ctx.process.env.PATH === "/usr/bin");
  }

  // ---------------------------------------------------------------- D1 xdg-mime
  section("D1: open-in-editor xdg-mime (fix_open_in_editor_linux)");
  const EDITOR_FIX = `"use strict";
async function Dc(e){try{let t=await Ut.app.getApplicationInfoForProtocol(e);return t?.path?t:null}catch{return null}}
async function L1(i){let d;try{let e=await u.app.getApplicationInfoForProtocol(i);e?.name&&(d=e.name.replace(/\\.app$/i,""))}catch{}return d}
async function L2(e){let a;try{let t=await u.app.getApplicationInfoForProtocol(e);t?.name&&(a=t.name.replace(/\\.app$/i,""))}catch{}return a}
async function IC(o){let e=o.info.icon;(!e||e.isEmpty())&&(e=await Ut.app.getFileIcon(o.info.path,{size:"normal"}));return e}
globalThis.__fixture={Dc};
`;
  const pe = runPatch("linux/fix_open_in_editor_linux", EDITOR_FIX);
  check("patch applies (exit 0), output passes node --check", pe.status === 0 && nodeCheck(pe.file), pe.out);
  for (const kind of KINDS) {
    const s = siteCtx(scenario(kind, "xdg-mime"), { out: "code.desktop\n" });
    s.ctx.Ut = { app: { getApplicationInfoForProtocol: async () => null, getFileIcon: async () => null } };
    s.ctx.u = s.ctx.Ut;
    vm.runInContext(pe.src, s.ctx);
    const info = await s.ctx.__fixture.Dc("vscode://");
    const r = s.ran[0];
    judge("xdg-mime", kind, "xdg-mime", r, true);
    if (r && r.exec) check(`xdg-mime [${kind}]: same argv, handler reported`, JSON.stringify(r.args) === JSON.stringify(["query", "default", "x-scheme-handler/vscode"]) && info && info.path === "code.desktop", JSON.stringify([r.args, info]));
  }

  // ---------------------------------------------------------------- D2 hyprctl
  section("D2: Quick Entry cursor via hyprctl (fix_quick_entry_position)");
  const QE_FIX = `"use strict";
var u={screen:{getPrimaryDisplay:()=>({workAreaSize:{width:100,height:100},workArea:{x:0,y:0}}),getAllDisplays:()=>[],getDisplayNearestPoint:(p)=>({workAreaSize:{width:100,height:100},workArea:{x:p.x,y:p.y}}),getCursorScreenPoint:()=>({x:1,y:2})}},wo={get:()=>null},PEi=10,FEi=10,WY=null;
function VEi(){let e=u.screen.getPrimaryDisplay(),{width:t,height:n}=e.workAreaSize;return{x:(t-PEi)/2+e.workArea.x,y:(n-FEi)/2+e.workArea.y}}
function BEi(){let e=wo.get("quickWindowPosition",null),t=u.screen.getAllDisplays();if(!(e&&e.absolutePointInWorkspace&&e.monitor&&e.relativePointFromMonitor))return VEi();return null}
function SH(e){if(!WY)return!1;{WY.show()}return WY.setPosition(Math.round(e.x),Math.round(e.y)),!0}
globalThis.__fixture={VEi};
`;
  const pq = runPatch("linux/fix_quick_entry_position", QE_FIX);
  check("patch applies (exit 0), output passes node --check", pq.status === 0 && nodeCheck(pq.file), pq.out);
  for (const kind of KINDS) {
    const sc = scenario(kind, "hyprctl");
    sc.env.HYPRLAND_INSTANCE_SIGNATURE = "abc";
    const s = siteCtx(sc, { out: "500, 600\n" });
    s.ctx.process.resourcesPath = "/nonexistent";
    vm.runInContext(pq.src, s.ctx);
    const pos = s.ctx.__fixture.VEi();
    judge("hyprctl", kind, "hyprctl", s.ran[0], false);
    const used = s.ran[0] && s.ran[0].exec;
    check(`hyprctl [${kind}]: ${used ? "the cursor display comes from hyprctl" : "cascade moves on to Electron's cursor point"}`, used ? pos.x === 500 + 45 : pos.x === 1 + 45, JSON.stringify(pos));
  }

  // ---------------------------------------------------------------- D3 xdg-open
  section("D3: Chrome DevTools opener xdg-open (fix_browser_tools_linux)");
  const BT_FIX = `"use strict";
var Q={join:(...a)=>a.join("/")},os={homedir:()=>"/home/u"};function Nt(){return "/home/u/.config"}
function Ft(){os.homedir();{let c=Nt();return[{name:"Chrome",path:Q.join(c,"google-chrome")},{name:"Edge",path:Q.join(c,"microsoft-edge")},{name:"Chromium",path:Q.join(c,"chromium")}]}return[]}
async function VUi(){try{process.platform==="darwin"?await um("/usr/bin/open",["-a","Google Chrome","chrome://inspect"]):process.platform==="win32"&&await um("start",["chrome","chrome://inspect"])}catch(e){}}
globalThis.__fixture={VUi};
`;
  const pb = runPatch("linux/fix_browser_tools_linux", BT_FIX);
  check("patch applies (exit 0), output passes node --check", pb.status === 0 && nodeCheck(pb.file), pb.out);
  for (const kind of KINDS) {
    const s = siteCtx(scenario(kind, "xdg-open"));
    // upstream's spawnAsync: no env option, so the bare name meets process.env.PATH.
    s.ctx.um = async (cmd, args) => { const r = s.ran.push({ cmd: String(cmd), args, hasEnv: false, envPath: s.proc.env.PATH, exec: execvp(s.host, cmd, s.proc.env) }); return r; };
    vm.runInContext(pb.src, s.ctx);
    await s.ctx.__fixture.VUi();
    judge("xdg-open", kind, "xdg-open", s.ran[0], false);
  }

  // ---------------------------------------------------------------- D4 git
  section("D4: Diff views git (js/diff_views_main.js) - the one tool on the APP PATH, like upstream's own git");
  {
    const src = readFileSync(DIFF_VIEWS_JS, "utf8");
    const a = src.indexOf("  // spawn-based collector");
    const b = src.indexOf("\n  var idxSeq = 0;", a);
    check("git collector found in diff_views_main.js", a > 0 && b > a);
    const APP = (started) => [...new Set([...started.split(":"), ...NARROWED.split(":")].filter((d) => d.startsWith("/")))].join(":");
    // [kind, expected spawned command, expected PATH in its env]
    const want = {
      "distro": [PLANTED + "/git", APP(PLANTED + ":/usr/bin")],
      "distro-off": ["/usr/bin/git", "/usr/bin:/bin"],
      "nix-wrapper": [STORE + "/git", APP(PLANTED + ":" + STORE + ":/run/current-system/sw/bin")],
      "planted": [PLANTED + "/git", APP(PLANTED + ":/usr/bin")],
      "no-resolver": ["git", NARROWED]
    };
    const why = {
      "distro": "the user's own git first on the started PATH, as their shell (and upstream) runs it",
      "distro-off": "narrowing off: /usr/bin/git, the binary the bare name found, env unchanged",
      "nix-wrapper": "git from the wrapper's store dir, APP PATH in its env",
      "planted": "per-user git (~/.local/bin, standalone home-manager) found again",
      "no-resolver": "resolver missing: bare git, process.env (as before)"
    };
    for (const kind of KINDS) {
      const s2 = siteCtx(scenario(kind, "git"));
      Object.assign(s2.ctx, { MAX_DIFF_BYTES: 1 << 21, GIT_TIMEOUT_MS: 5000, TRUNCATED_MARK: "T", _cp: s2.ctx.require("child_process") });
      vm.runInContext(src.slice(a, b) + "\nglobalThis.__git=git;", s2.ctx);
      const res = await new Promise((r) => s2.ctx.__git(["write-tree"], "/repo", { GIT_INDEX_FILE: "/tmp/idx" }, (err, out) => r({ err, out })));
      const r = s2.ran[0];
      const [wc, wp] = want[kind];
      check(`git [${kind}]: ${why[kind]}`, r && r.cmd === wc && r.envPath === wp && JSON.stringify(r.args) === '["write-tree"]', JSON.stringify(r));
      if (kind !== "no-resolver") check(`git [${kind}]: the git that ran is the one looked up, extra env kept`, r.exec === (wc.includes("/") ? wc : r.exec) && !res.err, JSON.stringify(res));
    }
  }
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log("FAIL: " + failures.join("; ")); process.exit(1); }
if (!haveBins) { console.log("SKIP (patch checks need the compiled patches)"); process.exit(3); }
console.log("PASS");
