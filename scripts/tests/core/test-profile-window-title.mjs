#!/usr/bin/env node
// patches/core/fix_profile_window_title.nim: with a named profile
// (CLAUDE_PROFILE set) the main window title AND the titles of the main view's
// pop-out windows carry " (PROFILE)" exactly once.
//
// WHY THIS EXISTS
// ---------------
// Upstream opens every pop-out (popped-out Code session, chat, artifact shell,
// idle pool window) as a `window.open("about:blank", <name>)` child of the main
// view, and Electron applies the page's document.title as the OS title
// verbatim. The patch installs, only when a profile is set, one
// app.on("web-contents-created") listener that wraps such a child's setTitle
// and preventDefaults its window's page-title-updated. A wrong opener test would suffix
// windows that are not pop-outs (or none at all) on a green build, so this
// harness evaluates the patched bundle against fake electron objects:
//   [1] the patch applies; a second run reports the injected end state and
//       changes nothing; a half-patched bundle fails loudly
//   [2] main window suffixed once; no-profile = pristine path, no listener
//   [3] pop-out: suffix once, later title changes keep it, no double suffix when
//       the page title already ends with it (events and direct setTitle), empty
//       title skipped, a title present at creation is suffixed at once
//   [4] the hook installs once across several windows and several calls
//   [5] left alone: no opener, subframe opener, opener that is not the
//       webContents' main frame, non-app origin, non about:blank child, and a
//       missing sender guard (fails closed)
// CDB_PATCH_BIN points at another compiled patch. Without the binary the
// harness exits 3 (skipped).
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.
import { readFileSync, writeFileSync, mkdtempSync, rmSync, accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BIN = process.env.CDB_PATCH_BIN || path.join(ROOT, "patches", "core", "fix_profile_window_title");

let pass = 0;
const failures = [];
const J = JSON.stringify;
function check(label, actual, expected) {
  if (J(actual) === J(expected)) { pass++; console.log("  PASS " + label + "  -> " + J(actual)); }
  else { failures.push(label); console.log("  FAIL " + label + "  -> got " + J(actual) + ", expected " + J(expected)); }
}
function section(t) { console.log("\n" + t); }

try { accessSync(BIN, constants.X_OK); } catch { console.log("SKIP: " + BIN + " not compiled (cd patches && make)"); process.exit(3); }

const scratch = mkdtempSync(path.join(os.tmpdir(), "cdb-profile-title-"));
const cleanup = () => { try { rmSync(scratch, { recursive: true, force: true }); } catch {} };
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { cleanup(); process.exit(130); });

// Upstream shapes (v5.1231.2): the preventDefault helper, the main-window
// factory `WIN=new ELECTRON.BrowserWindow(arg),...`, and the helper called on
// the window returned by the factory call.
const FIXTURE = `function PH(e){e.on("page-title-updated",(e=>{e.preventDefault()}))}
function MK(o){return WIN=new E.BrowserWindow(o),WIN}
function boot(){let w=MK({title:"x"});PH(w);return w}
`;

function runPatch(name, src) {
  const f = path.join(scratch, name);
  writeFileSync(f, src);
  const r = spawnSync(BIN, [f], { encoding: "utf8" });
  return { file: f, status: r.status, out: (r.stdout || "") + (r.stderr || ""), text: readFileSync(f, "utf8") };
}

// ---- fakes -------------------------------------------------------------------
class Frame { constructor(url, parent = null) { this.url = url; this.parent = parent; } }
class WC extends EventEmitter {
  constructor(url) { super(); this.mainFrame = new Frame(url); this.opener = null; }
}
class BW extends EventEmitter {
  constructor() { super(); this.webContents = new WC("about:blank"); this.t = "Claude"; this.calls = 0; }
  setTitle(t) { this.t = t; this.calls++; }
  getTitle() { return this.t; }
}
const origin = (u) => { const o = new URL(u); return o.origin === "null" ? o.protocol + "//" + o.host : o.origin; };
const GUARD = { originAllowed: (u) => { try { return ["app://localhost", "https://claude.ai"].includes(origin(u)); } catch { return false; } } };

function boot(patched, { profile, guard = true } = {}) {
  const app = new EventEmitter();
  const logs = [];
  const sb = { E: { BrowserWindow: BW }, WIN: null, process: { env: profile ? { CLAUDE_PROFILE: profile } : {} }, console, require: (m) => (m === "electron" ? { app } : null) };
  sb.globalThis = sb;
  sb.__cdbDiag = (m) => logs.push(m);
  if (guard) sb.__cdbSenderGuard = GUARD;
  vm.runInContext(patched + ";globalThis.__boot=boot", vm.createContext(sb));
  const main = sb.__boot();
  const mainView = new WC("app://localhost/new");
  app.emit("web-contents-created", {}, mainView);
  return { app, sb, main, mainView, logs, again: () => sb.__boot() };
}
function child(mv, { opener = mv.mainFrame, url = "about:blank", title } = {}) {
  const c = new BW();
  if (title !== undefined) c.t = title;
  c.webContents.opener = opener;
  mv.emit("did-create-window", c, { url, frameName: "n" });
  return c;
}
function pageTitle(c, t) {
  let prevented = false;
  c.emit("page-title-updated", { preventDefault: () => (prevented = true) }, t, true);
  return prevented;
}

// ---- [1] apply ----------------------------------------------------------------
section("[1] the patch applies once and is idempotent");
const p = runPatch("index.js", FIXTURE);
check("applies", [p.status, /\[OK\] Main window title hook injected/.test(p.out)], [0, true]);
check("the pop-out hook is in the bundle", p.text.includes("__cdb_popoutTitleHook"), true);
const again = spawnSync(BIN, [p.file], { encoding: "utf8" });
check("second run: already applied, file unchanged", [again.status, /already applied/.test(again.stdout), readFileSync(p.file, "utf8") === p.text], [0, true, true]);
const half = runPatch("half.js", p.text.replace(/__cdb_popoutTitleHook/g, "x"));
check("a half-patched bundle (no pop-out hook) fails loudly", [half.status !== 0, /pop-out hook is missing/.test(half.out)], [true, true]);
const bare = runPatch("nofactory.js", "function PH(e){e.on(\"page-title-updated\",(e=>{e.preventDefault()}))}\n");
check("a bundle without the factory fails", bare.status !== 0, true);
const patched = p.text;

// ---- [2] main window / no profile ---------------------------------------------
section("[2] main window suffixed once; no profile = no listener");
{
  const r = boot(patched, { profile: "work" });
  check("main window title", r.main.t, "Claude (work)");
  check("one diagnostic line on entry", r.logs.length, 1);
  r.main.setTitle("Claude (work)");
  check("main window not doubled", r.main.t, "Claude (work)");
  r.main.setTitle("Chat");
  check("main window later setTitle", r.main.t, "Chat (work)");
}
{
  const r = boot(patched, {});
  check("no profile: no web-contents-created listener", r.app.listenerCount("web-contents-created"), 0);
  check("no profile: main title untouched", r.main.t, "Claude");
  check("no profile: no diagnostic", r.logs.length, 0);
  const c = child(r.mainView);
  check("no profile: pop-out untouched", [pageTitle(c, "x"), c.t], [false, "Claude"]);
}

// ---- [3] pop-out --------------------------------------------------------------
section("[3] a pop-out of the main view carries the suffix exactly once");
{
  const r = boot(patched, { profile: "work" });
  const c = child(r.mainView, { title: "" });
  check("page title event is taken over (preventDefault called, delivered on the window)", pageTitle(c, "My chat"), true);
  check("the hook listens on the window, not the webContents", [c.listenerCount("page-title-updated"), c.webContents.listenerCount("page-title-updated")], [1, 0]);
  check("suffix applied", c.t, "My chat (work)");
  pageTitle(c, "Other"); check("a later page title change keeps the suffix", c.t, "Other (work)");
  pageTitle(c, "Done (work)"); check("title already ending with the suffix is not doubled", c.t, "Done (work)");
  c.setTitle("direct"); check("direct setTitle suffixed", c.t, "direct (work)");
  c.setTitle("direct (work)"); check("direct setTitle not doubled", c.t, "direct (work)");
  check("empty page title: event left alone", pageTitle(c, ""), false);
  check("empty page title: title unchanged", c.t, "direct (work)");
  const pre = child(r.mainView, { title: "Pre-set" });
  check("a title present at creation is suffixed once, at once", pre.t, "Pre-set (work)");
  const preDone = child(r.mainView, { title: "Pre (work)" });
  check("a creation title already ending with the suffix is not doubled", preDone.t, "Pre (work)");
  const none = child(r.mainView, { title: "" });
  check("no creation title: nothing applied", none.calls, 0);
}

// ---- [4] installs once --------------------------------------------------------
section("[4] the hook installs once");
{
  const r = boot(patched, { profile: "work" });
  r.again(); r.again();
  check("one web-contents-created listener after several factory calls", r.app.listenerCount("web-contents-created"), 1);
  check("one diagnostic line", r.logs.length, 1);
  const a = child(r.mainView, { title: "" }), b = child(r.mainView, { title: "" });
  pageTitle(a, "A"); pageTitle(b, "B");
  check("several pop-outs each get one suffix", [a.t, b.t], ["A (work)", "B (work)"]);
  check("each pop-out has one title listener of ours", [a.listenerCount("page-title-updated"), b.listenerCount("page-title-updated"), a.webContents.listenerCount("page-title-updated")], [1, 1, 0]);
}

// ---- [5] left alone -----------------------------------------------------------
section("[5] children that are not pop-outs of the main view are left alone");
{
  const r = boot(patched, { profile: "work" });
  const untouched = (c, label) => check(label, [pageTitle(c, "x"), c.t], [false, "Claude"]);
  untouched(child(r.mainView, { opener: null }), "no opener");
  untouched(child(r.mainView, { opener: new Frame("app://localhost/x", new Frame("app://localhost/")) }), "subframe opener");
  untouched(child(r.mainView, { opener: new Frame("app://localhost/new") }), "opener is not the webContents' main frame");
  const fwc = new WC("https://evil.example/");
  r.app.emit("web-contents-created", {}, fwc);
  untouched(child(fwc), "non-app origin opener");
  untouched(child(r.mainView, { url: "https://claude.ai/x" }), "child that is not about:blank");
  const pre = child(r.mainView, { title: "Pre-set", opener: null });
  check("no opener, even with a title at creation", [pageTitle(pre, "x"), pre.t], [false, "Pre-set"]);
}
{
  const r = boot(patched, { profile: "work", guard: false });
  const c = child(r.mainView, { title: "Pre-set" });
  check("missing sender guard fails closed", [pageTitle(c, "x"), c.t], [false, "Pre-set"]);
}

console.log("");
if (failures.length) {
  console.log(failures.length + " CHECK(S) FAILED:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
console.log("ALL " + pass + " CHECKS PASSED");
