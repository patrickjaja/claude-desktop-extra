#!/usr/bin/env node
// test-session-start-permission.mjs - the opt-in native dialog with "Allow
// always" for starting other sessions
// (patches/community/add_feature_session_start_always_allow.nim,
// js/session_start_permission.js, the cdb-session-start:* half of
// js/extra_settings_main.js).
//
// 1. Settings: switch off by default, .jsonc lock, project-scoped grants that
//    only the store adds, cap, off forgets, win32 refusal.
// 2. Helper: switch first, scope rules, window rules, fail directions.
// 3. Compiled patch on a synthetic staged concat (split markers, a namespace
//    chunk) incl. the layout assertions and idempotency.
// 4. When tmp/app.asar.contents exists: the REAL release broker method,
//    start gate and rule matcher, patched by the compiled binary from a full
//    staged concat, driven through one eligible ordinary start_session ask.
// 5. Diagnostics: every refused start_session ask logs exactly one
//    "[session-start-always-allow] card kept: <token>" line; switch off and
//    other tools log nothing.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(import.meta.url);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdb-session-start-"));
const helper = fs.readFileSync(path.join(root, "js/session_start_permission.js"), "utf8");
const main = fs.readFileSync(path.join(root, "js/extra_settings_main.js"), "utf8");
// The core patch emits the shared IPC sender guard ahead of extra_settings_main.js.
const guard = fs.readFileSync(path.join(root, "js/sender_guard.js"), "utf8");
const START = "mcp__ccd_session__start_session";
const SPLIT = name => `\n/*__CDB_SPLIT__${name}__*/\n`;
let passed = 0;
async function test(label, fn) { await fn(); passed++; console.log("  PASS " + label); }

class FakeWin {
  constructor() { this.visible = true; this.minimized = false; this.destroyed = false; this.shown = 0; this.focused = 0; }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  isDestroyed() { return this.destroyed; }
  show() { this.shown++; }
  focus() { this.focused++; }
}

// Installs the real extra_settings_main.js in a fresh context. `electron`
// extras (dialog, BrowserWindow) are merged into its electron module.
function install(userData, platform = "linux", extraElectron = {}) {
  fs.mkdirSync(userData, { recursive: true });
  const handlers = {};
  const electron = {
    app: { getPath: () => userData, on() {}, once() {}, isPackaged: true },
    ipcMain: { handle: (key, fn) => { handlers[key] = fn; }, removeHandler() {} },
    ...extraElectron
  };
  const context = vm.createContext({ console, URL, setTimeout, clearTimeout, Buffer,
    process: { platform, env: {}, resourcesPath: dir },
    require: name => name === "electron" ? electron : require(name)
  });
  vm.runInContext(guard, context);
  vm.runInContext(main, context);
  return { context, store: context.__cdbSessionStartPermission, enabled: context.__cdbSessionStartDialogEnabled, handlers, electron };
}
const settingsSender = { sender: { isDestroyed: () => false, getURL: () => "https://claude.ai/settings" }, senderFrame: {} };
const ipc = (handlers, ch, ...args) => handlers[ch](settingsSender, ...args);
function readFromFreshProcess(profile, key) {
  const code = `const fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");const main=fs.readFileSync(process.argv[1],"utf8");const guard=fs.readFileSync(process.argv[4],"utf8");const dir=process.argv[2];const install=${install.toString()};process.stdout.write("HAS="+install(dir).store.has(process.argv[3]));`;
  const child = spawnSync(process.execPath, ["-e", code, path.join(root, "js/extra_settings_main.js"), profile, key, path.join(root, "js/sender_guard.js")], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout.endsWith("HAS=true");
}
// The helper alone, in its own context, with a stub dialog.
function runner(profileCtx, dialog = async () => ({ response: 1 }), platform = "linux") {
  const calls = [];
  const fn = vm.runInNewContext(helper, {
    process: { platform },
    __cdbSessionStartPermission: profileCtx.store,
    __cdbSessionStartDialogEnabled: profileCtx.enabled,
    require: name => {
      if (name === "path") return require("node:path");
      if (name === "fs") return fs;
      assert.equal(name, "electron");
      return { dialog: { showMessageBox: async (win, options) => { calls.push({ win, options }); return dialog(win, options); } } };
    }
  });
  fn.calls = calls;
  return fn;
}
const parent = (extra = {}) => ({ title: "Parent work", permissionMode: "acceptEdits", originCwd: "/home/u/proj", cwd: "/home/u/proj/.wt/a", backend: {}, ...extra });

try {
  // ------------------------------------------------------------ 1. settings
  const profile = path.join(dir, "profile");
  fs.mkdirSync(profile);
  const cfg = path.join(profile, "claude-desktop-extra.json");
  const jsonc = path.join(profile, "claude-desktop-extra.jsonc");
  const authors = ["github.com/aviatests-codex-alex[bot]"];
  fs.writeFileSync(cfg, JSON.stringify({ autoFixTrustedAuthors: authors, untouched: 42 }));
  let P = install(profile);
  const KEY = "/home/u/proj";

  await test("off by default; nothing can be granted while off", () => {
    assert.equal(P.enabled(), false);
    assert.equal(P.store.has(KEY), false);
    assert.equal(P.store.grant(KEY).ok, false);
    assert.equal("sessionStartGrants" in JSON.parse(fs.readFileSync(cfg)), false);
    const r = ipc(P.handlers, "cdb-session-start:read");
    assert.deepEqual([r.ok, r.enabled, r.lockedByJsonc, r.grants], [true, false, null, 0]);
    assert.equal(P.handlers["cdb-session-start:grant"], undefined, "no IPC grant channel");
  });
  await test("read/set/revoke IPC rejects unrelated origins and child frames", () => {
    const sender = url => ({ sender: { isDestroyed: () => false, getURL: () => url }, senderFrame: {} });
    assert.equal(P.handlers["cdb-session-start:read"](sender("https://example.com")).ok, false);
    assert.equal(P.handlers["cdb-session-start:set"](sender("https://example.com"), true).ok, false);
    const frame = sender("https://claude.ai/settings"); frame.senderFrame.parent = {};
    assert.equal(P.handlers["cdb-session-start:revoke"](frame).ok, false);
    assert.equal(P.enabled(), false);
  });
  await test("set: boolean only, live, preserves unrelated configuration", () => {
    assert.equal(ipc(P.handlers, "cdb-session-start:set", "yes").ok, false);
    assert.equal(ipc(P.handlers, "cdb-session-start:set", true).ok, true);
    assert.equal(P.enabled(), true, "read live, no restart");
    const c = JSON.parse(fs.readFileSync(cfg));
    assert.equal(c.sessionStartAlwaysAllow, true); assert.deepEqual(c.autoFixTrustedAuthors, authors); assert.equal(c.untouched, 42);
  });
  await test("grants are per project key, validated, capped at 50", () => {
    assert.equal(P.store.grant("relative/path").ok, false);
    const rev = P.store.revision;
    assert.equal(P.store.grant(KEY).ok, true);
    assert.ok(P.store.revision > rev, "a grant bumps the revision");
    assert.equal(P.store.has(KEY), true); assert.equal(P.store.has("/home/u/other"), false);
    assert.equal(P.store.has("/home/u/PROJ"), false, "keys are exact (case-sensitive paths)");
    for (let i = 0; i < 60; i++) P.store.grant("/p/" + i);
    assert.equal(P.store.count(), 50);
    assert.equal(P.store.has("/p/59"), true, "the newest grant is kept");
    assert.equal(ipc(P.handlers, "cdb-session-start:read").grants, 50);
    assert.equal(P.store.forget().ok, true); assert.equal(P.store.count(), 0);
    P.store.grant(KEY);
  });
  await test("grant survives a main-process restart; profiles do not share grants", () => {
    P = install(profile);
    assert.equal(P.store.has(KEY), true);
    assert.equal(readFromFreshProcess(profile, KEY), true);
    assert.equal(install(path.join(dir, "other-profile")).store.has(KEY), false);
  });
  await test("a malformed grants value is ignored, not trusted", () => {
    const c = JSON.parse(fs.readFileSync(cfg));
    fs.writeFileSync(cfg, JSON.stringify({ ...c, sessionStartGrants: { [KEY]: true, "rel": { grantedAt: 1 } } }));
    assert.equal(P.store.has(KEY), false); assert.equal(P.store.count(), 0);
    fs.writeFileSync(cfg, JSON.stringify({ ...c, sessionStartGrants: [KEY] }));
    assert.equal(P.store.has(KEY), false);
    fs.writeFileSync(cfg, JSON.stringify(c));
  });
  await test("a stored grant is ignored while the switch is off; switch-off forgets grants", () => {
    assert.equal(P.store.has(KEY), true);
    const c = JSON.parse(fs.readFileSync(cfg));
    fs.writeFileSync(cfg, JSON.stringify({ ...c, sessionStartAlwaysAllow: false }));
    assert.equal(P.store.has(KEY), false, "grant present on disk, ignored while off");
    fs.writeFileSync(cfg, JSON.stringify(c));
    assert.equal(ipc(P.handlers, "cdb-session-start:set", false).ok, true);
    const after = JSON.parse(fs.readFileSync(cfg));
    assert.equal("sessionStartAlwaysAllow" in after, false); assert.equal("sessionStartGrants" in after, false);
    assert.deepEqual(after.autoFixTrustedAuthors, authors);
  });
  await test("revoke forgets grants and keeps the switch", () => {
    ipc(P.handlers, "cdb-session-start:set", true); P.store.grant(KEY);
    const r = ipc(P.handlers, "cdb-session-start:revoke");
    assert.deepEqual([r.ok, r.enabled, r.grants], [true, true, 0]);
    assert.equal(P.store.has(KEY), false); assert.equal(readFromFreshProcess(profile, KEY), false);
  });
  await test(".jsonc wins and locks the switch; it cannot plant grants", () => {
    fs.writeFileSync(jsonc, '{\n  // hand-edited\n  "sessionStartAlwaysAllow": false,\n  "sessionStartGrants": { "/home/u/proj": { "grantedAt": 1 } },\n}\n');
    assert.equal(P.enabled(), false, ".jsonc false beats .json true");
    let r = ipc(P.handlers, "cdb-session-start:read"); assert.deepEqual([r.enabled, r.lockedByJsonc], [false, true]);
    r = ipc(P.handlers, "cdb-session-start:set", true); assert.equal(r.ok, false); assert.equal(r.lockedByJsonc, true);
    fs.writeFileSync(jsonc, '{ "sessionStartAlwaysAllow": true }');
    assert.equal(P.enabled(), true); assert.equal(P.store.has(KEY), false, "grants come from the .json only");
    fs.rmSync(jsonc);
  });
  await test("Windows: no predicate, no store, channels refuse", () => {
    const W = install(path.join(dir, "windows"), "win32");
    assert.equal(W.store, undefined); assert.equal(W.enabled, undefined);
    for (const ch of ["cdb-session-start:read", "cdb-session-start:set", "cdb-session-start:revoke"]) {
      const r = ipc(W.handlers, ch, true); assert.equal(r.ok, false); assert.match(r.error, /Linux only/);
    }
  });

  // ------------------------------------------------------------ 2. helper
  const input = { initiation: "user_asked", title: "Task", prompt: "Do the work" };
  const yes = async () => true;
  ipc(P.handlers, "cdb-session-start:set", true);
  const win = new FakeWin();
  const ctx = (extra = {}) => ({ session: parent(), sessionId: "session-1", mainWindow: () => win, ...extra });
  await test("FIRST check is the switch: off -> card without evaluating eligibility", async () => {
    ipc(P.handlers, "cdb-session-start:set", false);
    let evaluated = false;
    const run = runner(P);
    assert.equal(await run(input, undefined, async () => { evaluated = true; return true; }, ctx()), undefined);
    assert.equal(evaluated, false); assert.equal(run.calls.length, 0);
    ipc(P.handlers, "cdb-session-start:set", true);
  });
  await test("dialog: parented to the main window, Deny default, informative text", async () => {
    const long = "\u{1F600}".repeat(400);
    const run = runner(P, async () => ({ response: 1 }));
    const result = await run({ ...input, prompt: long, model: "claude-x", permission_mode: "default", use_worktree: false }, undefined, yes, ctx());
    assert.equal(result.behavior, "allow"); assert.deepEqual(Object.keys(result).sort(), ["behavior", "updatedInput"]);
    const { win: parentWin, options } = run.calls[0];
    assert.equal(parentWin, win); assert.ok(win.shown > 0 && win.focused > 0, "shown and focused first");
    assert.equal(options.buttons.join("|"), "Deny|Allow once|Allow always");
    assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0);
    assert.match(options.message, /"Task"/);
    for (const part of ["Asked by: Parent work", "Project: /home/u/proj", "sharing this session's checkout", "Permission mode: default", "Model: claude-x",
      "THIS project and the default destination only", "from a prompt Claude wrote", "nothing inside them is approved by this"]) {
      assert.ok(options.detail.includes(part), part);
    }
    assert.ok(options.detail.includes("\u{1F600}".repeat(300) + "\u2026"), "prompt clipped at 300 code points");
    assert.ok(!options.detail.includes("\u{1F600}".repeat(301)));
    assert.equal(P.store.has(KEY), false, "Allow once remembers nothing");
  });
  await test("Deny, Escape/close and unknown answers deny", async () => {
    for (const response of [0, -1, 99]) assert.equal((await runner(P, async () => ({ response })) (input, undefined, yes, ctx())).behavior, "deny");
    assert.equal(P.store.has(KEY), false);
  });
  await test("Allow always stores the project key; the next ask in it is allowed without a dialog", async () => {
    assert.equal((await runner(P, async () => ({ response: 2 }))(input, undefined, yes, ctx())).behavior, "allow");
    assert.equal(P.store.has(KEY), true);
    const run = runner(P, () => { throw Error("unexpected dialog"); });
    assert.equal((await run(input, undefined, yes, ctx({ session: parent({ cwd: "/home/u/proj" }) }))).behavior, "allow");
    assert.equal(run.calls.length, 0);
  });
  await test("a remembered approval never covers another project", async () => {
    const run = runner(P, async () => ({ response: 0 }));
    assert.equal((await run(input, undefined, yes, ctx({ session: parent({ originCwd: "/home/u/other" }) }))).behavior, "deny");
    assert.equal(run.calls.length, 1);
  });
  await test("non-local place, invalid cwd, remote parents and higher modes -> card, even with a grant", async () => {
    const run = runner(P, () => { throw Error("unexpected dialog"); });
    for (const extra of [{ cwd: "relative" }, { cwd: path.join(dir, "missing") }, { host: "box" }, { environment: "env" }, { preset: "p" }, { repository: "o/r" }, { target: "cloud" }, { target: "ssh" },
      { permission_mode: "bypassPermissions" }, { permission_mode: "auto" }, { permission_mode: "dontAsk" }, { permission_mode: "weird" }]) {
      assert.equal(await run({ ...input, ...extra }, undefined, yes, ctx()), undefined, JSON.stringify(extra));
    }
    for (const session of [parent({ sshConfig: {} }), parent({ wslConfig: {} }), parent({ backend: { remoteTarget: { kind: "x" } } }), parent({ originCwd: undefined, cwd: "rel" }), undefined]) {
      assert.equal(await run(input, undefined, yes, ctx({ session })), undefined);
    }
    assert.equal((await run({ ...input, permission_mode: "plan" }, undefined, yes, ctx())).behavior, "allow", "a lower mode stays in scope");
    assert.equal((await run({ ...input, target: "local" }, undefined, yes, ctx())).behavior, "allow");
  });
  P.store.forget();
  const destinationA = fs.mkdtempSync(path.join(dir, "destination-a-"));
  const destinationB = fs.mkdtempSync(path.join(dir, "destination-b-"));
  await test("explicit local directory gets named native dialog and its own durable grant", async () => {
    const data = { ...input, cwd: destinationA, use_worktree: false };
    const run = runner(P, async () => ({ response: 2 }));
    assert.equal((await run(data, undefined, yes, ctx())).behavior, "allow");
    assert.ok(run.calls[0].options.detail.includes("Destination directory: " + destinationA));
    assert.ok(run.calls[0].options.detail.includes("ONLY the destination directory"));
    const key = JSON.stringify([KEY, destinationA]);
    assert.equal(P.store.has(key), true); assert.equal(P.store.has(KEY), false);
    assert.equal(readFromFreshProcess(profile, key), true);
    assert.equal((await runner(P, () => { throw Error("must reuse"); })(data, undefined, yes, ctx())).behavior, "allow");
    assert.equal((await runner(P, async () => ({ response: 0 }))({ ...data, cwd: destinationB }, undefined, yes, ctx())).behavior, "deny");
    assert.equal((await runner(P, async () => ({ response: 0 }))(data, undefined, yes, ctx({ session: parent({ originCwd: "/another-project" }) }))).behavior, "deny");
    assert.equal((await runner(P, async () => ({ response: 0 }))(input, undefined, yes, ctx())).behavior, "deny");
  });
  await test("forget and switch-off clear default and explicit-destination grants together", () => {
    const tuple = JSON.stringify([KEY, destinationA]);
    assert.equal(P.store.has(tuple), true);
    assert.equal(ipc(P.handlers, "cdb-session-start:revoke").ok, true);
    assert.equal(P.store.has(tuple), false); assert.equal(readFromFreshProcess(profile, tuple), false);
    assert.equal(P.store.grant(KEY).ok, true); assert.equal(P.store.grant(tuple).ok, true);
    assert.equal(ipc(P.handlers, "cdb-session-start:set", false).ok, true);
    assert.equal(P.store.has(tuple), false); assert.equal(P.store.has(KEY), false);
    ipc(P.handlers, "cdb-session-start:set", true);
    assert.equal(P.store.has(tuple), false);
    for (const key of [JSON.stringify([KEY]), JSON.stringify([KEY, "relative"]), JSON.stringify([KEY, destinationA, "extra"]), '["/a", "/b"]']) {
      assert.equal(P.store.grant(key).ok, false, key);
    }
    P.store.grant(tuple);
  });
  await test("first-use destination consent is shown even when the start was remembered", async () => {
    const place = { key: "native-place-key", sentence: "Claude wants to start in this new folder." };
    let approved;
    const run = runner(P, async () => ({ response: 1 }));
    const result = await run({ ...input, cwd: destinationA }, undefined, yes, ctx({ place: async () => place, onApproved: value => { approved = value; } }));
    assert.equal(result.behavior, "allow"); assert.equal(approved, result);
    assert.equal(run.calls.length, 1); assert.ok(run.calls[0].options.detail.includes(place.sentence));
  });
  await test("symlink destination change while asking denies and saves no grant", async () => {
    P.store.forget();
    const link = path.join(dir, "destination-link"); fs.symlinkSync(destinationA, link);
    const run = runner(P, async () => { fs.unlinkSync(link); fs.symlinkSync(destinationB, link); return { response: 2 }; });
    assert.equal((await run({ ...input, cwd: link }, undefined, yes, ctx())).behavior, "deny");
    assert.equal(P.store.has(JSON.stringify([KEY, destinationB])), false);
  });
  await test("destination consent changing while asking denies", async () => {
    let place = { key: "a", sentence: "Native destination A" };
    const run = runner(P, async () => { place = { key: "b", sentence: "Native destination B" }; return { response: 2 }; });
    assert.equal((await run({ ...input, cwd: destinationA }, undefined, yes, ctx({ place: async () => place }))).behavior, "deny");
  });
  P.store.forget();
  await test("no visible main window -> card, no dialog", async () => {
    const run = runner(P, () => { throw Error("unexpected dialog"); });
    for (const w of [null, Object.assign(new FakeWin(), { visible: false }), Object.assign(new FakeWin(), { minimized: true }), Object.assign(new FakeWin(), { destroyed: true })]) {
      assert.equal(await run(input, undefined, yes, ctx({ mainWindow: () => w })), undefined);
    }
    assert.equal(await run(input, undefined, yes, ctx({ mainWindow: () => { throw Error("gone"); } })), undefined);
  });
  await test("ineligible host decision or unreadable policy -> card, never allow", async () => {
    assert.equal(await runner(P)(input, undefined, async () => false, ctx()), undefined);
    assert.equal(await runner(P)(input, undefined, async () => { throw Error("unreadable"); }, ctx()), undefined);
  });
  await test("dialog throwing before an answer -> card", async () => {
    assert.equal(await runner(P, async () => { throw Error("no dialog"); })(input, undefined, yes, ctx()), undefined);
  });
  await test("revocation, switch-off or policy change while the dialog is open deny", async () => {
    assert.equal((await runner(P, async () => { P.store.forget(); return { response: 2 }; })(input, undefined, yes, ctx())).behavior, "deny");
    assert.equal((await runner(P, async () => { ipc(P.handlers, "cdb-session-start:set", false); return { response: 1 }; })(input, undefined, yes, ctx())).behavior, "deny");
    ipc(P.handlers, "cdb-session-start:set", true);
    let calls = 0;
    assert.equal((await runner(P, async () => ({ response: 2 }))(input, undefined, async () => ++calls === 1, ctx())).behavior, "deny");
    calls = 0;
    assert.equal((await runner(P, async () => ({ response: 2 }))(input, undefined, async () => { if (++calls > 1) throw Error("x"); return true; }, ctx())).behavior, "deny");
    assert.equal(P.store.has(KEY), false);
  });
  await test("cancellation signal reaches the dialog and denies after abort", async () => {
    const controller = new AbortController();
    const run = runner(P, async (w, options) => { assert.equal(options.signal, controller.signal); controller.abort(); return { response: 2 }; });
    assert.equal((await run(input, controller.signal, yes, ctx())).behavior, "deny");
    const aborted = new AbortController(); aborted.abort();
    assert.equal((await runner(P)(input, aborted.signal, yes, ctx())).behavior, "deny");
    assert.equal(P.store.has(KEY), false);
  });
  await test("a failed durable write denies instead of pretending to save", async () => {
    const bad = { store: { has: () => false, revision: 0, grant: () => ({ ok: false }) }, enabled: () => true };
    assert.equal((await runner(bad, async () => ({ response: 2 }))(input, undefined, yes, ctx())).behavior, "deny");
  });
  await test("Windows: the helper never runs", async () => {
    assert.equal(await runner(P, () => { throw Error("unexpected dialog"); }, "win32")(input, undefined, yes, ctx()), undefined);
  });

  // ------------------------------------------------------- 3. synthetic patch
  const patch = process.env.CDB_SESSION_START_PATCH || path.join(root, "patches/community/add_feature_session_start_always_allow");
  if (!fs.existsSync(patch)) throw Error("Compile patches first: missing " + patch);
  const fixture = path.join(dir, "broker.js");
  const brokerPart = `const t=require("./index.chunk-api.js");class Broker {
    async handleToolPermission(e,r,i,a,o,s){let c=this.config.getSession(e),l=s?.nameTrustWithheld===!0;
      let f=s?.viaHostCliLauncher===!0||t.TF(c);
      if(s?.forcedDenial)return {behavior:"deny"};
      let j=(0,G.randomUUID)(),M=J(s?.toolUseID),N=a?.length;
      this.fallbacks++;return {behavior:"native",input:i};
    }async firstUseSidePlace(e,r,i){if(!(r!==""||t.qn(e,(e=>this.config.getSession(e)))))try{return}catch(e){return}}async forceAskVerdict(e,r,i){return{cause:"ordinary"}}internalNameProvenanceVerdict(e,n){return}
  };globalThis.Broker=Broker;
  function hostPolicyReferences(c,r,e,a,ge){if(a!=="ordinary")return t.hm(e)?"org_requires_approval":0;return ge??=t._K(c?.query,r).then((e=>{let n=e;return t.jJ("desktop_ccd_own_ask_rules_read",{covers:n})}))}
  function nativeStartGate(e,r,i,a,o,c){if(!startTools.has(e)||t.qn(i,a))return!1;let l=a(i);return policy.continued(l)||remote(l,e,r)||count(l,o,c)>=10}`;
  const apiPart = `function apiTF(e){return!1}async function apiK(e,t){return flags.ownAsk}function apiHm(e){return flags.ask}function apiQn(e,t){return flags.unattended}
  var mainWin=void 0;function makeMain(e){return mainWin=new u.BrowserWindow(e),zi(mainWin.webContents,Li.MAIN_WINDOW),mainWin}globalThis.makeMain=makeMain;
  function nativeMatch(e,t){let n=e.trim().split("(")[0].trim(),r=t.indexOf("__",5),i=r===-1?"":t.slice(0,r);return n===t||n===i||n.includes("*")&&kor(n,t)}
  Object.defineProperty(exports,"TF",{enumerable:!0,get:function(){return apiTF}});Object.defineProperty(exports,"_K",{enumerable:!0,get:function(){return apiK}});
  Object.defineProperty(exports,"hm",{enumerable:!0,get:function(){return apiHm}});Object.defineProperty(exports,"qn",{enumerable:!0,get:function(){return apiQn}});
  Object.defineProperty(exports,"Xmt",{enumerable:!0,get:function(){return mainWin}});Object.defineProperty(exports,"matchToolRule",{enumerable:!0,get:function(){return nativeMatch}});`;
  const original = `"use strict";/*stub*/` + SPLIT("index.chunk-broker.js") + brokerPart + SPLIT("index.chunk-api.js") + apiPart;
  fs.writeFileSync(fixture, original);
  let result = spawnSync(patch, [fixture], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const patched = fs.readFileSync(fixture, "utf8");
  result = spawnSync(patch, [fixture], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); assert.equal(fs.readFileSync(fixture, "utf8"), patched);
  assert.match(result.stdout, /already present \(idempotent\)/);
  const flags = { ask: false, ownAsk: false, unattended: false };
  let choice = 1;
  const dialogCalls = [];
  const diag = [];
  const kept = () => diag.splice(0).filter(m => m.startsWith("[session-start-always-allow] card kept: ")).map(m => m.slice(40));
  const exportsObj = {};
  const context = vm.createContext({ process: { platform: "linux" }, exports: exportsObj, flags,
    kor: (pattern, value) => new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(value),
    __cdbSessionStartPermission: P.store, __cdbSessionStartDialogEnabled: P.enabled, __cdbDiag: message => diag.push(message),
    require: name => name === "./index.chunk-api.js" ? exportsObj : name === "fs" ? fs : name === "path" ? require("node:path")
      : { dialog: { showMessageBox: async (w, options) => { dialogCalls.push({ w, options }); return { response: choice }; } } },
    u: { BrowserWindow: FakeWin }, zi() {}, Li: { MAIN_WINDOW: 1 },
    G: { randomUUID: () => "request" }, J: value => value,
    startTools: new Set([START]),
    policy: { continued: session => session.continued === true },
    remote: session => session.remoteApproval === true,
    count: session => session.sideSessionStartsSinceUserMessage ?? 0
  });
  vm.runInContext(patched, context);
  const mainWindow = context.makeMain({});
  const broker = new context.Broker();
  let listing = { state: { managedOnly: false, rules: [] } };
  const session = { ...parent(), permissionMode: "default", sideSessionStartsSinceUserMessage: 0,
    query: { listPermissionRules: async () => listing } };
  broker.config = { getSession: () => session, laptopMcpToolAsksEveryCall: () => false };
  broker.fallbacks = 0;
  broker.allowedOnCardJustNow = new WeakSet();
  const call = (options = {}, tool = START, data = input) => broker.handleToolPermission("session", tool, data, [], undefined, options);
  await test("compiled: switch off -> upstream card, on -> dialog parented to Xmt", async () => {
    ipc(P.handlers, "cdb-session-start:set", false);
    assert.equal((await call()).behavior, "native"); assert.equal(dialogCalls.length, 0);
    ipc(P.handlers, "cdb-session-start:set", true);
    assert.equal((await call()).behavior, "allow"); assert.equal(dialogCalls.at(-1).w, mainWindow);
    assert.equal(dialogCalls.at(-1).options.defaultId, 0);
  });
  await test("compiled: pre-card denials are untouched", async () => assert.equal((await call({ forcedDenial: true })).behavior, "deny"));
  await test("compiled: explicit human/policy asks retain the original card", async () => {
    for (const options of [{ decisionReason: "Explicit ask" }, { decisionReasonType: "rule" }, { rulesLock: "managed_rules_only" }, { defaultToNo: true }, { handedToPerson: true }, { settingsFileRuleAsk: true }, { nameTrustWithheld: true }, { suppressAlwaysAllowRule: true }, { connectorAsk: "policy_only" }, { viaHostCliLauncher: true }]) {
      assert.equal((await call(options)).behavior, "native", JSON.stringify(options));
    }
  });
  await test("compiled: organization ask, own rules/hooks and unreadable rules remain enforced", async () => {
    flags.ask = true; assert.equal((await call()).behavior, "native"); flags.ask = false;
    for (const ownAsk of [true, undefined]) { flags.ownAsk = ownAsk; assert.equal((await call()).behavior, "native"); }
    flags.ownAsk = false;
  });
  await test("compiled: the SDK's verified server-policy-only ask can use the dialog", async () => {
    listing.state.rules = [{ rule: START, behavior: "ask", source: "mcpServerPolicy" }];
    const options = { decisionReasonType: "rule", decisionReason: "MCP server policy asks every time" };
    assert.equal((await call(options)).behavior, "allow");
    flags.ownAsk = true; assert.equal((await call(options)).behavior, "native"); flags.ownAsk = false;
    assert.equal((await call({ ...options, reasonFromApp: true })).behavior, "native");
    assert.equal((await call({ ...options, forceAskCause: "server_unconfirmed" })).behavior, "native");
    session.continued = true; assert.equal((await call(options)).behavior, "native"); session.continued = false;
    session.remoteApproval = true; assert.equal((await call(options)).behavior, "native"); session.remoteApproval = false;
    listing.state.rules = [];
    assert.equal((await call(options)).behavior, "native");
  });
  await test("compiled: deny rules use the native exact/server/wildcard matcher", async () => {
    for (const rule of [START, "mcp__ccd_session", "mcp__ccd_*", START + "(title:*)"]) {
      listing.state.rules = [{ rule, behavior: "deny", source: "policySettings" }];
      assert.equal((await call()).behavior, "native", rule);
    }
    listing.state.rules = [{ rule: "Bash", behavior: "deny", source: "userSettings" }];
    assert.equal((await call()).behavior, "allow");
    listing.state.rules = [];
  });
  await test("compiled: managed-only and malformed rule listings fall back to the card", async () => {
    listing.state.managedOnly = true; assert.equal((await call()).behavior, "native"); listing.state.managedOnly = false;
    listing.state.rules = [{}]; assert.equal((await call()).behavior, "native"); listing.state.rules = [];
    const saved = listing; listing = undefined; assert.equal((await call()).behavior, "native"); listing = saved;
  });
  await test("compiled: unattended sessions and plan mode keep their native checks", async () => {
    flags.unattended = true; assert.equal((await call()).behavior, "native"); flags.unattended = false;
    session.permissionMode = "plan"; assert.equal((await call()).behavior, "native"); session.permissionMode = "default";
  });
  await test("compiled: destination consent, count guard, provenance and force-ask verdicts stay separate", async () => {
    broker.firstUseSidePlace = async () => ({ sentence: "New destination" }); assert.equal((await call()).behavior, "native"); delete broker.firstUseSidePlace;
    session.sideSessionStartsSinceUserMessage = 10; assert.equal((await call()).behavior, "native"); session.sideSessionStartsSinceUserMessage = 0;
    broker.internalNameProvenanceVerdict = () => ({ decision: "ask" }); assert.equal((await call()).behavior, "native"); delete broker.internalNameProvenanceVerdict;
    broker.forceAskVerdict = async () => ({ cause: "org_settings_unavailable" }); assert.equal((await call()).behavior, "native"); delete broker.forceAskVerdict;
  });
  await test("compiled: ordinary first-use ask for an explicit local folder reaches the dialog", async () => {
    const place = { key: "place-a", sentence: "Claude wants to start a session in a new folder." };
    const data = { ...input, cwd: destinationA, use_worktree: false };
    broker.firstUseSidePlace = async () => place;
    choice = 1; diag.length = 0;
    const before = dialogCalls.length;
    const res = await call({ toolUseID: "t1" }, START, data);
    assert.equal(res.behavior, "allow"); assert.equal(dialogCalls.length, before + 1);
    assert.ok(dialogCalls.at(-1).options.detail.includes(place.sentence), "place sentence shown");
    assert.ok(dialogCalls.at(-1).options.detail.includes("Destination directory: " + destinationA));
    assert.equal(broker.allowedOnCardJustNow.has(res), true, "a real answer stamps upstream's on-card set");
    assert.deepEqual(kept(), []);
    // A stored tuple grant never skips the dialog while the place is first-use.
    const tuple = JSON.stringify([KEY, destinationA]);
    assert.equal(P.store.grant(tuple).ok, true);
    choice = 0;
    assert.equal((await call({}, START, data)).behavior, "deny"); assert.equal(dialogCalls.length, before + 2);
    // Once the place is known (no first-use sentence), the grant skips it.
    broker.firstUseSidePlace = async () => undefined;
    assert.equal((await call({}, START, data)).behavior, "allow"); assert.equal(dialogCalls.length, before + 2);
    // Without an explicit cwd, a first-use place still keeps the card.
    broker.firstUseSidePlace = async () => place;
    assert.equal((await call({}, START, input)).behavior, "native"); assert.deepEqual(kept(), ["firstUsePlace"]);
    // A reason other than the place sentence or the verified rule reason keeps the card.
    assert.equal((await call({ decisionReason: "Some other reason" }, START, data)).behavior, "native"); assert.deepEqual(kept(), ["firstUsePlace"]);
    assert.equal((await call({ decisionReasonType: "hook", decisionReason: "other" }, START, data)).behavior, "native");
    assert.deepEqual(kept(), ["gate:decisionReasonType=hook"]);
    assert.equal((await call({ handedToPerson: true }, START, data)).behavior, "native"); assert.deepEqual(kept(), ["gate:handedToPerson"]);
    // The exact first-use sentence from a hook ask stays admitted.
    choice = 1;
    assert.equal((await call({ decisionReasonType: "hook", decisionReason: place.sentence, handedToPerson: true }, START, data)).behavior, "allow");
    delete broker.firstUseSidePlace; P.store.forget(); diag.length = 0;
  });
  await test("compiled: each refused ask logs exactly one card-kept line with its token", async () => {
    choice = 1; diag.length = 0;
    const cases = [
      [{ decisionReasonType: "mode" }, "gate:decisionReasonType=mode"],
      [{ decisionReasonType: "weird value/../x" }, "gate:decisionReasonType=string"],
      [{ forceAskCause: "server_unconfirmed" }, "gate:forceAskCause=server_unconfirmed"],
      [{ firstDriveReference: {} }, "gate:firstDriveReference"],
      [{ rulesLock: "managed_rules_only" }, "gate:rulesLock"],
      [{ nameTrustWithheld: true }, "gate:nameTrustWithheld"],
      [{ handedToPerson: true }, "gate:handedToPerson"],
      [{ defaultToNo: true }, "gate:defaultToNo"],
      [{ settingsFileRuleAsk: true }, "gate:settingsFileRuleAsk"],
      [{ suppressAlwaysAllowRule: true }, "gate:suppressAlwaysAllowRule"],
      [{ connectorAsk: "policy_only" }, "gate:connectorAsk"],
      [{ viaHostCliLauncher: true }, "gate:viaHostCliLauncher"],
      [{ decisionReason: "Explicit ask" }, "reason"]
    ];
    for (const [options, token] of cases) {
      assert.equal((await call(options)).behavior, "native", token);
      assert.deepEqual(kept(), [token], token);
    }
    const env = [
      [() => { flags.ask = true; }, () => { flags.ask = false; }, "hostPolicy"],
      [() => { flags.unattended = true; }, () => { flags.unattended = false; }, "unattended"],
      [() => { flags.ownAsk = true; }, () => { flags.ownAsk = false; }, "ownAskRules"],
      [() => { session.permissionMode = "plan"; }, () => { session.permissionMode = "default"; }, "planMode"],
      [() => { session.sideSessionStartsSinceUserMessage = 10; }, () => { session.sideSessionStartsSinceUserMessage = 0; }, "startGate"],
      [() => { broker.internalNameProvenanceVerdict = () => ({ decision: "ask" }); }, () => { delete broker.internalNameProvenanceVerdict; }, "provenance"],
      [() => { broker.forceAskVerdict = async () => ({ standDown: "classifier" }); }, () => { delete broker.forceAskVerdict; }, "forceAsk:classifier"],
      [() => { listing.state.managedOnly = true; }, () => { listing.state.managedOnly = false; }, "rules:listing"],
      [() => { listing.state.rules = [{ rule: START, behavior: "deny", source: "userSettings" }]; }, () => { listing.state.rules = []; }, "rules:deny"],
      [() => { broker.config.laptopMcpToolAsksEveryCall = () => true; }, () => { broker.config.laptopMcpToolAsksEveryCall = () => false; }, "laptopAsksEveryCall"],
      [() => { mainWindow.visible = false; }, () => { mainWindow.visible = true; }, "window"]
    ];
    for (const [on, off, token] of env) {
      on();
      try { assert.equal((await call()).behavior, "native", token); } finally { off(); }
      assert.deepEqual(kept(), [token], token);
    }
    assert.equal((await call({}, START, { ...input, host: "box" })).behavior, "native"); assert.deepEqual(kept(), ["scope:input"]);
    const saved = session.originCwd; session.originCwd = undefined; session.cwd = "rel";
    assert.equal((await call()).behavior, "native"); assert.deepEqual(kept(), ["scope:project"]);
    session.originCwd = saved; session.cwd = parent().cwd;
    // An eligible ask, other tools and the switch being off log nothing.
    assert.equal((await call()).behavior, "allow");
    for (const tool of ["Bash", "mcp__ccd_session__hand_off_to_session"]) assert.equal((await call({ decisionReason: "x" }, tool)).behavior, "native");
    ipc(P.handlers, "cdb-session-start:set", false);
    for (const [options] of cases) assert.equal((await call(options)).behavior, "native");
    flags.ask = true; assert.equal((await call()).behavior, "native"); flags.ask = false;
    ipc(P.handlers, "cdb-session-start:set", true);
    assert.deepEqual(diag, [], "no diagnostics for eligible asks, other tools or switch off");
  });
  await test("compiled: the post-answer recheck stays quiet and still denies", async () => {
    choice = 1; diag.length = 0;
    const n = dialogCalls.length;
    // Eligible before the dialog, refused by the host once the person answered.
    broker.config.laptopMcpToolAsksEveryCall = () => dialogCalls.length > n;
    try { assert.equal((await call()).behavior, "deny"); } finally { broker.config.laptopMcpToolAsksEveryCall = () => false; }
    assert.equal(dialogCalls.length, n + 1);
    assert.deepEqual(diag, [], "recheck refusal is a deny, not a kept card");
  });
  await test("compiled: handoff and other tools cannot acquire this grant", async () => {
    for (const tool of ["Bash", "mcp__ccd_session__hand_off_to_session", "mcp__other__start_session"]) assert.equal((await call({}, tool)).behavior, "native");
  });
  await test("compiled: Allow always is per project; a hidden window falls back to the card", async () => {
    choice = 2; assert.equal((await call()).behavior, "allow"); assert.equal(P.store.has(KEY), true);
    choice = 0; const before = dialogCalls.length;
    assert.equal((await call()).behavior, "allow"); assert.equal(dialogCalls.length, before, "no dialog for a remembered project");
    assert.equal((await call({}, START, { ...input, cwd: "/elsewhere" })).behavior, "native");
    P.store.forget(); mainWindow.visible = false;
    assert.equal((await call()).behavior, "native"); mainWindow.visible = true;
    assert.equal((await call()).behavior, "deny");
    assert.deepEqual(JSON.parse(fs.readFileSync(cfg)).autoFixTrustedAuthors, authors);
  });
  await test("compiled: minified dollar identifiers are supported", () => {
    const dollars = original.replace(/\b([erciaosljMNGJft])\b/g, "$$$1");
    fs.writeFileSync(fixture, dollars);
    const applied = spawnSync(patch, [fixture], { encoding: "utf8" });
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  });
  await test("compiled: partial injections, missing anchors and layout changes fail loud", () => {
    const broken = [
      ["partial injection", patched.replace("Start another session?", "partial injection")],
      ["no card sink", original.replace("let j=(0,G.randomUUID)()", "let j=1")],
      ["duplicate", original + original],
      ["no split markers", brokerPart + apiPart],
      ["namespace from another chunk", original.replace('require("./index.chunk-api.js")', 'require("./index.chunk-other.js")')],
      ["export moved out of the namespace chunk", original.replace('Object.defineProperty(exports,"hm",{enumerable:!0,get:function(){return apiHm}});', "").replace("nativeStartGate(", 'nativeStartGate(){}Object.defineProperty(exports,"hm",{enumerable:!0,get:function(){return apiHm}});function x(')],
      ["Xmt is not the main window", original.replace("Li.MAIN_WINDOW", "Li.QUICK_ENTRY")],
      ["start gate in another chunk", `"use strict";` + SPLIT("index.chunk-broker.js") + brokerPart.replace(/function nativeStartGate[^]*$/, "") + SPLIT("index.chunk-api.js") + apiPart + brokerPart.match(/function nativeStartGate[^]*$/)[0]],
      ["broker method missing", original.replace("async forceAskVerdict(", "async forceAskVerdictX(")],
      ["org-policy call site missing", original.replace('"org_requires_approval"', '"org_other"')],
      ["own-ask-rules call site missing", original.replace('"desktop_ccd_own_ask_rules_read"', '"desktop_other"')],
      ["unattended call site missing", original.replace("||t.qn(e,(e=>this.config", "||t.qx(e,(e=>this.config")]
    ];
    for (const [label, text] of broken) {
      fs.writeFileSync(fixture, text);
      const r = spawnSync(patch, [fixture], { encoding: "utf8" });
      assert.notEqual(r.status, 0, label); assert.match(r.stdout + r.stderr, /FAIL/, label);
      assert.equal(fs.readFileSync(fixture, "utf8"), text, label + ": nothing written");
    }
  });

  // ------------------------------------------------------- 4. real release
  const build = path.join(root, "tmp/app.asar.contents/.vite/build");
  if (fs.existsSync(path.join(build, "index.js"))) {
    // Stage exactly like scripts/apply_patches.py: index.js + sorted chunks.
    const names = fs.readdirSync(build).filter(n => /^index.*\.chunk-.*\.js$/.test(n)).sort();
    const orig = new Map([["index.js", fs.readFileSync(path.join(build, "index.js"), "latin1")]]);
    for (const n of names) orig.set(n, fs.readFileSync(path.join(build, n), "latin1"));
    let staged = orig.get("index.js");
    for (const n of names) staged += SPLIT(n) + orig.get(n);
    const stagedPath = path.join(dir, "staged.js");
    fs.writeFileSync(stagedPath, staged, "latin1");
    const r1 = spawnSync(patch, [stagedPath], { encoding: "utf8" });
    assert.equal(r1.status, 0, r1.stdout + r1.stderr);
    const once = fs.readFileSync(stagedPath, "latin1");
    const r2 = spawnSync(patch, [stagedPath], { encoding: "utf8" });
    assert.equal(r2.status, 0, r2.stdout + r2.stderr); assert.equal(fs.readFileSync(stagedPath, "latin1"), once, "real release: idempotent");
    const pieces = once.split(/\n\/\*__CDB_SPLIT__([^*\n]+?)__\*\/\n/);
    const parts = new Map([["index.js", pieces[0]]]);
    for (let k = 1; k < pieces.length; k += 2) parts.set(pieces[k], pieces[k + 1]);
    const changed = [...parts].filter(([n, s]) => orig.get(n) !== s).map(([n]) => n);
    assert.equal(changed.length, 1, "exactly one chunk changes: " + changed);
    const brokerName = changed[0];
    const brokerSrc = parts.get(brokerName);
    const checkPath = path.join(dir, "broker-chunk.js"); fs.writeFileSync(checkPath, brokerSrc, "latin1");
    assert.equal(spawnSync(process.execPath, ["--check", checkPath]).status, 0, "patched broker chunk passes node --check");

    // Splice the patched method, the start gate and the rule matcher. Every
    // minified name is recovered from the release, not assumed.
    const method = brokerSrc.match(/async handleToolPermission\([\w$]+(?:,[\w$]+){5}\)\{let [\w$]+=this\.config\.getSession\([^]*?\}(?=respondToToolPermission\()/)?.[0];
    assert.ok(method && method.includes("/*__CDB_SESSION_START_PERMISSION__*/"), "real patched broker method found");
    // Namespace export names are re-minified per release: resolve each from
    // the same upstream call site the patch uses.
    const [, api, tfName] = method.match(/\.viaHostCliLauncher===!0\|\|([\w$]+)\.([\w$]+)\(/);
    const site = re => { const m = brokerSrc.match(re); assert.ok(m, "real call site " + re); return m[1]; };
    const hmName = site(/if\([\w$]+!=="ordinary"\)return [\w$]+\.([\w$]+)\([\w$]+\)\?"org_requires_approval":/);
    const kName = site(/\?\?=[\w$]+\.([\w$]+)\([\w$]+\?\.query,[\w$]+\)\.then\(\([\w$]+=>\{[^{}]{0,100}"desktop_ccd_own_ask_rules_read",/);
    const qnName = site(/\}async firstUseSidePlace\([\w$]+,[\w$]+,[\w$]+\)\{if\(!\([^{}]*?\|\|[\w$]+\.([\w$]+)\([\w$]+,\([\w$]+=>this\.config\.getSession\(/);
    const planNs = method.match(/permissionMode!==[\w$]+\.([\w$]+)\.Plan/)[1];
    const uuidNs = method.match(/=\(0,([\w$]+)\.randomUUID\)\(\)/)[1];
    const identity = method.match(/([\w$]+)=([\w$]+)\(\1\),[\w$]+&&[\w$]+\?\.length&&this\.askFirstSessionApprovals/)[2];
    const gate = brokerSrc.match(/function ([\w$]+)\([\w$]+,[\w$]+,[\w$]+,[\w$]+,[\w$]+,[\w$]+\)\{if\(!([\w$]+)\.has\([\w$]+\)[^{}]*;return [\w$]+\.[\w$]+\([\w$]+\)\|\|[\w$]+\([\w$]+,[\w$]+,[\w$]+\)\|\|[\w$]+\([\w$]+,[\w$]+,[\w$]+\)>=10\}/);
    assert.ok(gate && method.includes(gate[1] + "("), "real start gate found and called by the hook");
    const apiChunk = brokerSrc.match(new RegExp(`(?:^|[^\\w$.])${api.replace(/\$/g, "\\$")}=require\\("\\./(index[\\w.-]*\\.js)"\\)`))[1];
    const apiSrc = parts.get(apiChunk);
    const matcher = apiSrc.match(/function ([\w$]+)\(e,t\)\{let n=0,r=0,i=-1,a=0;[^{}]*return n===e\.length\}function ([\w$]+)\(e,t\)\{let n=e\.trim\(\)\.split\("\("\)\[0\]\.trim\(\),r=t\.indexOf\("__",5\),[^}]*\}/);
    assert.ok(matcher, "real rule matcher found");
    const matcherExport = apiSrc.match(new RegExp(`"([\\w$]+)",\\{enumerable:!0,get:function\\(\\)\\{return ${matcher[2].replace(/\$/g, "\\$")}\\}\\}`))[1];
    assert.ok(method.includes(`${api}.${matcherExport}(`), "the hook calls the real matcher export");
    const mainVar = apiSrc.match(/(?:^|[^\w$.])([\w$]+)=new [\w$]+\.BrowserWindow\([\w$]+\),[\w$]+\(\1\.webContents,[\w$]+\.MAIN_WINDOW\)/)[1];
    const mainExport = apiSrc.match(new RegExp(`"([\\w$]+)",\\{enumerable:!0,get:function\\(\\)\\{return ${mainVar.replace(/\$/g, "\\$")}\\}\\}`))[1];
    for (const n of [tfName, hmName, kName, qnName]) assert.ok(method.includes(`${api}.${n}(`), "the hook calls " + n);
    assert.ok(method.includes(`${api}.${mainExport}`), "the hook parents the dialog to the MAIN_WINDOW export");

    const stub = new Proxy(function () {}, { get: (t, k) => (k === "then" || typeof k === "symbol") ? undefined : stub, apply: () => undefined });
    const soft = obj => new Proxy(obj, { get: (t, k) => (k in t ? t[k] : (k === "then" || typeof k === "symbol") ? undefined : stub) });
    const realWin = new FakeWin();
    let mainWin = realWin;
    const nsOverrides = { [tfName]: () => false, [hmName]: () => false, [qnName]: () => false, [kName]: async () => false,
      [planNs]: { Plan: "plan", Auto: "auto", Bypass: "bypassPermissions" } };
    Object.defineProperty(nsOverrides, mainExport, { get: () => mainWin });
    const passthrough = new Set(["Promise", "Object", "Array", "JSON", "Date", "Error", "TypeError", "Set", "Map", "WeakMap", "String", "Number",
      "Boolean", "Symbol", "Math", "RegExp", "undefined", "NaN", "Infinity", "globalThis", "process", "require", "isFinite", "parseInt", "Reflect"]);
    const explicit = { [api]: soft(nsOverrides), [uuidNs]: { randomUUID: () => "req-" + Math.random() }, [identity]: x => x,
      [gate[2]]: new Set([START]), setTimeout: () => ({ unref() {} }), clearTimeout() {} };
    const scope = new Proxy({}, {
      has: (t, k) => typeof k !== "symbol" && !passthrough.has(k),
      get: (t, k) => typeof k === "symbol" ? undefined : Object.hasOwn(explicit, k) ? explicit[k] : stub
    });
    let dialogAnswer = async () => ({ response: 1 });
    const realCalls = [];
    const R = install(path.join(dir, "real-profile"), "linux", {
      dialog: { showMessageBox: async (w, options) => { realCalls.push({ w, options }); return dialogAnswer(w, options); } }
    });
    const code = `(function(__scope){with(__scope){return (function(){${matcher[0]}${gate[0]}class __Broker{${method}}return __Broker})()}})`;
    const RealBroker = vm.runInContext(code, R.context)(scope);
    const realDiag = [];
    R.context.__cdbDiag = message => realDiag.push(message);
    const realKept = () => realDiag.splice(0).filter(m => m.startsWith("[session-start-always-allow] card kept: ")).map(m => m.slice(40));
    const cards = [];
    const realSession = { ...parent(), permissionMode: "default", sessionPermissionUpdates: [], alwaysAllowedReasons: new Set(),
      query: { listPermissionRules: async () => ({ state: { managedOnly: false, rules: [] } }) } };
    const target = Object.assign(new RealBroker(), {
      pendingPermissions: new Map(),
      allowedOnCardJustNow: new WeakSet(),
      async forceAskVerdict() { return { cause: "ordinary" }; },
      async firstUseSidePlace() { return undefined; },
      internalNameProvenanceVerdict() { return undefined; }
    });
    const brokerThis = soft(target);
    target.config = soft({
      getSession: () => realSession,
      laptopMcpToolAsksEveryCall: () => false,
      emitSessionUpdated() {},
      emit: event => {
        if (event.type !== "tool_permission_request") return;
        cards.push(event.request);
        target.pendingPermissions.get(event.request.requestId).resolve({ behavior: "card" });
      }
    });
    const ask = (data = input, options = {}) => brokerThis.handleToolPermission("real-session", START, data, undefined, undefined, options);
    await test("real release: switch off -> upstream card sink", async () => {
      assert.equal(R.enabled(), false);
      assert.equal((await ask()).behavior, "card"); assert.equal(cards.at(-1).toolName, START); assert.equal(realCalls.length, 0);
    });
    await test("real release: switch on -> dialog parented to Xmt, Deny default; Deny denies", async () => {
      ipc(R.handlers, "cdb-session-start:set", true);
      dialogAnswer = async () => ({ response: 0 });
      assert.equal((await ask()).behavior, "deny");
      assert.equal(realCalls.at(-1).w, realWin); assert.equal(realCalls.at(-1).options.defaultId, 0); assert.equal(realCalls.at(-1).options.cancelId, 0);
    });
    await test("real release: Allow always stores the project key; the next ask in it is auto-allowed", async () => {
      dialogAnswer = async () => ({ response: 2 });
      const res = await ask(); assert.equal(res.behavior, "allow"); assert.equal(res.updatedInput, input);
      assert.equal(R.store.has(KEY), true);
      const n = realCalls.length;
      dialogAnswer = async () => { throw Error("unexpected dialog"); };
      assert.equal((await ask()).behavior, "allow"); assert.equal(realCalls.length, n);
    });
    await test("real release: explicit local cwd names the directory and preserves native first-use consent", async () => {
      const data = { ...input, cwd: destinationA, use_worktree: false };
      const place = { key: "native-place", sentence: "Claude wants to start in a new local folder." };
      target.firstUseSidePlace = async () => place;
      const options = { decisionReasonType: "hook", decisionReason: place.sentence, handedToPerson: true, toolUseID: "real-place" };
      dialogAnswer = async () => ({ response: 1 });
      const result = await ask(data, options);
      assert.equal(result.behavior, "allow");
      assert.equal(target.allowedOnCardJustNow.has(result), true, "upstream outer flow can redeem real on-card consent");
      assert.ok(realCalls.at(-1).options.detail.includes(destinationA));
      assert.ok(realCalls.at(-1).options.detail.includes(place.sentence));
      assert.equal(R.store.has(JSON.stringify([KEY, destinationA])), false, "Allow once writes no start grant");
      // Even a matching first-use sentence cannot outrank an external ask/hook.
      nsOverrides[kName] = async () => true;
      assert.equal((await ask(data, options)).behavior, "card");
      nsOverrides[kName] = async () => false;
      assert.equal((await ask(data, { ...options, decisionReason: "different mandatory reason" })).behavior, "card");
      target.firstUseSidePlace = async () => undefined;
      dialogAnswer = async () => ({ response: 2 });
      assert.equal((await ask(data)).behavior, "allow");
      assert.equal(R.store.has(JSON.stringify([KEY, destinationA])), true);
      assert.equal((await ask({ ...data, cwd: path.join(dir, "missing-directory") })).behavior, "card");
    });
    await test("real release: Manual-mode ordinary ask for a new explicit folder reaches the dialog", async () => {
      R.store.forget(); realDiag.length = 0;
      const data = { ...input, cwd: destinationB, use_worktree: false };
      const place = { key: "native-place-b", sentence: "Claude wants to start a session in a new folder on this computer." };
      target.firstUseSidePlace = async () => place;
      dialogAnswer = async () => ({ response: 1 });
      const n = realCalls.length;
      const result = await ask(data, { toolUseID: "manual-1" });
      assert.equal(result.behavior, "allow"); assert.equal(realCalls.length, n + 1);
      assert.equal(target.allowedOnCardJustNow.has(result), true, "approved only after a real answer");
      assert.ok(realCalls.at(-1).options.detail.includes(place.sentence));
      assert.ok(realCalls.at(-1).options.detail.includes("Destination directory: " + destinationB));
      assert.deepEqual(realKept(), []);
      // Stored tuple grant + first-use place: still the dialog.
      assert.equal(R.store.grant(JSON.stringify([KEY, destinationB])).ok, true);
      dialogAnswer = async () => ({ response: 0 });
      assert.equal((await ask(data, { toolUseID: "manual-2" })).behavior, "deny"); assert.equal(realCalls.length, n + 2);
      // Place known (undefined) + stored grant: no dialog.
      target.firstUseSidePlace = async () => undefined;
      dialogAnswer = async () => { throw Error("unexpected dialog"); };
      assert.equal((await ask(data, { toolUseID: "manual-3" })).behavior, "allow"); assert.equal(realCalls.length, n + 2);
      // Refusals log one token each; the real card sink keeps the card.
      target.firstUseSidePlace = async () => place;
      assert.equal((await ask(data, { decisionReasonType: "hook", decisionReason: "other" })).behavior, "card");
      assert.deepEqual(realKept(), ["gate:decisionReasonType=hook"]);
      assert.equal((await ask(input)).behavior, "card"); assert.deepEqual(realKept(), ["firstUsePlace"]);
      realSession.permissionMode = "plan";
      assert.equal((await ask(data)).behavior, "card"); assert.deepEqual(realKept(), ["planMode"]);
      realSession.permissionMode = "default";
      target.firstUseSidePlace = async () => undefined;
      R.store.forget();
      ipc(R.handlers, "cdb-session-start:set", false);
      assert.equal((await ask(data, { decisionReasonType: "mode" })).behavior, "card");
      ipc(R.handlers, "cdb-session-start:set", true);
      assert.deepEqual(realDiag, [], "switch off logs nothing");
    });
    await test("real release: another project -> dialog", async () => {
      realSession.originCwd = "/home/u/other";
      dialogAnswer = async () => ({ response: 1 });
      const n = realCalls.length;
      assert.equal((await ask()).behavior, "allow"); assert.equal(realCalls.length, n + 1);
      realSession.originCwd = "/home/u/proj";
    });
    await test("real release: dialog throws -> card; no visible window -> card", async () => {
      realSession.originCwd = "/home/u/third";
      dialogAnswer = async () => { throw Error("no dialog"); };
      assert.equal((await ask()).behavior, "card");
      dialogAnswer = async () => ({ response: 1 });
      realWin.visible = false; const n = realCalls.length;
      assert.equal((await ask()).behavior, "card"); assert.equal(realCalls.length, n);
      realWin.visible = true; mainWin = undefined;
      assert.equal((await ask()).behavior, "card"); mainWin = realWin;
      realSession.originCwd = "/home/u/proj";
    });
    await test("real release: switch turned off -> card again and grants cleared", async () => {
      ipc(R.handlers, "cdb-session-start:set", false);
      assert.equal((await ask()).behavior, "card");
      ipc(R.handlers, "cdb-session-start:set", true);
      assert.equal(R.store.has(KEY), false, "turning it off forgot the grant");
    });
  } else console.log("SKIP real-release check: tmp/app.asar.contents unavailable");
  console.log(`\n${passed} passed, 0 failed`);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
