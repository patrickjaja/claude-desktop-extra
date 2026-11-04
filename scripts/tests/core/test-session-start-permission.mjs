#!/usr/bin/env node
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
let passed = 0;
async function test(label, fn) { await fn(); passed++; console.log("  PASS " + label); }
function install(userData, platform = "linux") {
  fs.mkdirSync(userData, { recursive: true });
  const handlers = {};
  const context = vm.createContext({ console, URL, setTimeout, clearTimeout, Buffer,
    process: { platform, env: {}, resourcesPath: dir },
    require: name => name === "electron" ? {
      app: { getPath: () => userData, on() {}, once() {}, isPackaged: true },
      ipcMain: { handle: (key, fn) => { handlers[key] = fn; }, removeHandler() {} }
    } : require(name)
  });
  vm.runInContext(main, context);
  return { store: context.__cdbSessionStartPermission, handlers };
}
function readFromFreshProcess(profile) {
  const code = `const fs=require("node:fs"),vm=require("node:vm");const main=fs.readFileSync(process.argv[1],"utf8");const dir=process.argv[2];const install=${install.toString()};process.stdout.write("STORE_READ="+install(dir).store.read());`;
  const child = spawnSync(process.execPath, ["-e", code, path.join(root, "js/extra_settings_main.js"), profile], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout.endsWith("STORE_READ=true");
}
function runner(store, dialog = async () => ({ response: 1 }), platform = "linux") {
  return vm.runInNewContext(helper, { process: { platform }, __cdbSessionStartPermission: store,
    require: name => { assert.equal(name, "electron"); return { dialog: { showMessageBox: dialog } }; }
  });
}
try {
  const profile = path.join(dir, "profile");
  fs.mkdirSync(profile);
  const cfg = path.join(profile, "claude-desktop-extra.json");
  const authors = ["github.com/aviatests-codex-alex[bot]"];
  fs.writeFileSync(cfg, JSON.stringify({ autoFixTrustedAuthors: authors, untouched: 42 }));
  let { store, handlers } = install(profile);
  await test("new profiles ask; settings cannot grant", () => {
    assert.equal(store.read(), false);
    assert.equal(handlers["cdb-session-start:grant"], undefined);
    assert.equal(handlers["cdb-session-start:set"], undefined);
  });
  await test("read/revoke IPC rejects unrelated origins and child frames", () => {
    const sender = url => ({ sender: { isDestroyed: () => false, getURL: () => url }, senderFrame: {} });
    assert.equal(handlers["cdb-session-start:read"](sender("https://example.com")).ok, false);
    const frame = sender("https://claude.ai/settings"); frame.senderFrame.parent = {};
    assert.equal(handlers["cdb-session-start:revoke"](frame).ok, false);
    assert.equal(handlers["cdb-session-start:read"](sender("https://claude.ai/settings")).ok, true);
  });
  const input = { initiation: "user_asked", title: "Task", prompt: "Do the work" };
  await test("Allow once grants only this call and forwards no child permissions", async () => {
    const result = await runner(store)(input, undefined, async () => true);
    assert.equal(result.behavior, "allow"); assert.equal(result.updatedInput, input);
    assert.deepEqual(Object.keys(result).sort(), ["behavior", "updatedInput"]);
    assert.equal(store.read(), false);
  });
  await test("Deny and close never grant", async () => {
    for (const response of [0, -1, 99]) assert.equal((await runner(store, async () => ({ response }))(input, undefined, async () => true)).behavior, "deny");
    assert.equal(store.read(), false);
  });
  await test("Allow always persists without changing unrelated configuration", async () => {
    const result = await runner(store, async options => {
      assert.equal(options.buttons.join("|"), "Deny|Allow once|Allow always");
      assert.equal(options.defaultId, 1); assert.equal(options.cancelId, 0);
      assert.ok(options.detail.includes(input.prompt));
      return { response: 2 };
    })(input, undefined, async () => true);
    assert.equal(result.behavior, "allow");
    assert.equal(store.read(), true);
    const config = JSON.parse(fs.readFileSync(cfg));
    assert.deepEqual(config.autoFixTrustedAuthors, authors); assert.equal(config.untouched, 42);
  });
  await test("grant survives main-process restart", async () => {
    store = install(profile).store;
    assert.equal(store.read(), true);
    assert.equal((await runner(store, () => { throw Error("unexpected dialog"); })(input, undefined, async () => true)).behavior, "allow");
  });
  await test("a genuinely separate Node main-process shim reads the persisted grant", () => assert.equal(readFromFreshProcess(profile), true));
  await test("profiles do not share grants", () => assert.equal(install(path.join(dir, "other-profile")).store.read(), false));
  await test("stored grant does not override an ineligible host decision", async () => assert.equal(await runner(store)(input, undefined, async () => false), undefined));
  await test("unreadable policy falls back, never auto-allows", async () => assert.equal(await runner(store)(input, undefined, async () => { throw Error("unreadable"); }), undefined));
  await test("revocation takes effect live and after restart", () => {
    assert.equal(store.revoke().ok, true); assert.equal(store.read(), false);
    assert.equal(install(profile).store.read(), false);
    assert.equal(readFromFreshProcess(profile), false);
  });
  await test("revocation while a dialog is open cancels its answer", async () => {
    const result = await runner(store, async () => { store.revoke(); return { response: 2 }; })(input, undefined, async () => true);
    assert.equal(result.behavior, "deny"); assert.equal(store.read(), false);
  });
  await test("policy changes while asking reject stale approval", async () => {
    let calls = 0;
    const result = await runner(store, async () => ({ response: 2 }))(input, undefined, async () => ++calls === 1);
    assert.equal(result.behavior, "deny"); assert.equal(store.read(), false);
  });
  await test("a denial never becomes another prompt when policy changes", async () => {
    let calls = 0;
    const result = await runner(store, async () => ({ response: 0 }))(input, undefined, async () => { if (++calls > 1) throw Error("changed"); return true; });
    assert.equal(result.behavior, "deny"); assert.equal(calls, 1);
  });
  await test("failed post-answer policy lookup denies instead of reusing stale metadata", async () => {
    let calls = 0;
    const result = await runner(store, async () => ({ response: 2 }))(input, undefined, async () => { if (++calls > 1) throw Error("unreadable"); return true; });
    assert.equal(result.behavior, "deny"); assert.equal(store.read(), false);
  });
  await test("native dialog receives cancellation signal and cannot grant after abort", async () => {
    const controller = new AbortController();
    const result = await runner(store, async options => { assert.equal(options.signal, controller.signal); controller.abort(); return { response: 2 }; })(input, controller.signal, async () => true);
    assert.equal(result.behavior, "deny"); assert.equal(store.read(), false);
  });
  await test("revocation during post-answer policy recheck cannot grant", async () => {
    let calls = 0;
    const result = await runner(store, async () => ({ response: 2 }))(input, undefined, async () => { if (++calls === 2) store.revoke(); return true; });
    assert.equal(result.behavior, "deny"); assert.equal(store.read(), false);
  });
  await test("a failed durable write denies instead of pretending to save", async () => {
    const badStore = { read: () => false, revision: 0, grant: () => ({ ok: false }) };
    assert.equal((await runner(badStore, async () => ({ response: 2 }))(input, undefined, async () => true)).behavior, "deny");
  });
  await test("Windows neither registers a grant store nor invokes native consent", async () => {
    assert.equal(install(path.join(dir, "windows"), "win32").store, undefined);
    assert.equal(await runner(store, () => { throw Error("unexpected dialog"); }, "win32")(input, undefined, async () => true), undefined);
  });

  const patch = process.env.CDB_SESSION_START_PATCH || path.join(root, "patches/core/add_session_start_permission");
  if (!fs.existsSync(patch)) throw Error("Compile patches first: missing " + patch);
  const fixture = path.join(dir, "broker.js");
  const original = `class Broker {
    async handleToolPermission(e,r,i,a,o,s){let c=this.config.getSession(e),l=s?.nameTrustWithheld===!0;
      let f=s?.viaHostCliLauncher===!0||t.TF(c);
      if(s?.forcedDenial)return {behavior:"deny"};
      let j=(0,G.randomUUID)(),M=J(s?.toolUseID),N=a?.length;
      this.fallbacks++;return {behavior:"native",input:i};
    }
  };globalThis.Broker=Broker;
  function nativeMatch(e,t){let n=e.trim().split("(")[0].trim(),r=t.indexOf("__",5),i=r===-1?"":t.slice(0,r);return n===t||n===i||n.includes("*")&&kor(n,t)}
  Object.defineProperty(exports,"matchToolRule",{enumerable:!0,get:function(){return nativeMatch}});
  function hostPolicyReferences(c,r,e){return t._K(c?.query,r).then(()=>t.hm(r)||t.qn(e,()=>c))}
  function nativeStartGate(e,r,i,a,o,c){if(!startTools.has(e)||t.qn(i,a))return!1;let l=a(i);return policy.continued(l)||remote(l,e,r)||count(l,o,c)>=10}
  `;
  fs.writeFileSync(fixture, original);
  let result = spawnSync(patch, [fixture], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const patched = fs.readFileSync(fixture, "utf8");
  result = spawnSync(patch, [fixture], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); assert.equal(fs.readFileSync(fixture, "utf8"), patched);
  const flags = { ask: false, ownAsk: false, unattended: false };
  let choice = 1;
  const context = vm.createContext({ process: { platform: "linux" }, exports: {},
    kor: (pattern, value) => new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(value),
    __cdbSessionStartPermission: store, __cdbDiag: message => console.error(message),
    require: () => ({ dialog: { showMessageBox: async () => ({ response: choice }) } }),
    t: { TF: () => false, hm: () => flags.ask, qn: () => flags.unattended, _K: async () => flags.ownAsk },
    G: { randomUUID: () => "request" }, J: value => value,
    startTools: new Set(["mcp__ccd_session__start_session"]),
    policy: { continued: session => session.continued === true },
    remote: session => session.remoteApproval === true,
    count: session => session.sideSessionStartsSinceUserMessage ?? 0
  });
  vm.runInContext(patched, context);
  context.t.matchToolRule = context.exports.matchToolRule;
  const broker = new context.Broker();
  let listing = { state: { managedOnly: false, rules: [] } };
  const session = { permissionMode: "default", sideSessionStartsSinceUserMessage: 0,
    query: { listPermissionRules: async () => listing } };
  broker.config = { getSession: () => session, laptopMcpToolAsksEveryCall: () => false };
  broker.internalNameProvenanceVerdict = () => undefined;
  broker.firstUseSidePlace = async () => undefined;
  broker.forceAskVerdict = async () => ({ cause: "ordinary" });
  broker.fallbacks = 0;
  const call = (options = {}, tool = "mcp__ccd_session__start_session") => broker.handleToolPermission("session", tool, input, [], undefined, options);
  await test("compiled sink uses native three-choice dialog and keeps Allow once", async () => assert.equal((await call()).behavior, "allow"));
  await test("compiled patch is idempotent and changes no pre-card denial", async () => assert.equal((await call({ forcedDenial: true })).behavior, "deny"));
  await test("explicit human/policy asks retain the original card", async () => {
    for (const options of [{ decisionReason: "Explicit ask" }, { decisionReasonType: "rule" }, { rulesLock: "managed_rules_only" }, { defaultToNo: true }, { handedToPerson: true }, { settingsFileRuleAsk: true }, { nameTrustWithheld: true }, { suppressAlwaysAllowRule: true }, { connectorAsk: "policy_only" }, { viaHostCliLauncher: true }]) {
      assert.equal((await call(options)).behavior, "native", JSON.stringify(options));
    }
  });
  await test("organization ask, own rules/hooks and unreadable rules remain enforced", async () => {
    flags.ask = true; assert.equal((await call()).behavior, "native"); flags.ask = false;
    for (const ownAsk of [true, undefined]) { flags.ownAsk = ownAsk; assert.equal((await call()).behavior, "native"); }
    flags.ownAsk = false;
  });
  await test("the SDK's verified server-policy-only ask can offer persistent consent", async () => {
    listing.state.rules = [{ rule: "mcp__ccd_session__start_session", behavior: "ask", source: "mcpServerPolicy" }];
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
  await test("deny rules use the native exact/server/wildcard matcher", async () => {
    for (const rule of ["mcp__ccd_session__start_session", "mcp__ccd_session", "mcp__ccd_*", "mcp__ccd_session__start_session(title:*)"]) {
      listing.state.rules = [{ rule, behavior: "deny", source: "policySettings" }];
      assert.equal((await call()).behavior, "native", rule);
    }
    listing.state.rules = [{ rule: "Bash", behavior: "deny", source: "userSettings" }];
    assert.equal((await call()).behavior, "allow");
    listing.state.rules = [];
  });
  await test("managed-only and malformed rule listings cannot keep a grant", async () => {
    listing.state.managedOnly = true; assert.equal((await call()).behavior, "native"); listing.state.managedOnly = false;
    listing.state.rules = [{}]; assert.equal((await call()).behavior, "native"); listing.state.rules = [];
    const saved = listing; listing = undefined; assert.equal((await call()).behavior, "native"); listing = saved;
  });
  await test("unattended sessions and plan mode keep their native checks", async () => {
    flags.unattended = true; assert.equal((await call()).behavior, "native"); flags.unattended = false;
    session.permissionMode = "plan"; assert.equal((await call()).behavior, "native"); session.permissionMode = "default";
  });
  await test("destination consent and native count guard stay separate", async () => {
    broker.firstUseSidePlace = async () => ({ sentence: "New destination" }); assert.equal((await call()).behavior, "native"); broker.firstUseSidePlace = async () => undefined;
    session.sideSessionStartsSinceUserMessage = 10; assert.equal((await call()).behavior, "native"); session.sideSessionStartsSinceUserMessage = 0;
  });
  await test("unproven server names and mandatory force-ask verdicts retain the card", async () => {
    broker.internalNameProvenanceVerdict = () => ({ decision: "ask" }); assert.equal((await call()).behavior, "native"); broker.internalNameProvenanceVerdict = () => undefined;
    broker.forceAskVerdict = async () => ({ cause: "org_settings_unavailable" }); assert.equal((await call()).behavior, "native"); broker.forceAskVerdict = async () => ({ cause: "ordinary" });
  });
  await test("handoff and other tools cannot acquire this grant", async () => {
    for (const tool of ["Bash", "mcp__ccd_session__hand_off_to_session", "mcp__other__start_session"]) assert.equal((await call({}, tool)).behavior, "native");
  });
  await test("compiled path persists only the dedicated profile choice", async () => {
    choice = 2; assert.equal((await call()).behavior, "allow"); assert.equal(store.read(), true);
    choice = 0; assert.equal((await call()).behavior, "allow");
    store.revoke(); assert.equal((await call()).behavior, "deny");
    assert.deepEqual(JSON.parse(fs.readFileSync(cfg)).autoFixTrustedAuthors, authors);
  });
  await test("minified dollar identifiers are supported", () => {
    const dollars = original.replace(/\b([erciaosljMNGJft])\b/g, "$$$1");
    fs.writeFileSync(fixture, dollars);
    const applied = spawnSync(patch, [fixture], { encoding: "utf8" });
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(spawnSync(process.execPath, ["--check", fixture]).status, 0);
  });
  await test("partial injections and missing/duplicate native anchors fail loud", () => {
    for (const broken of [patched.replace("Session start permission", "partial injection"), original.replace("let j=(0,G.randomUUID)()", "let j=1"), original + original]) {
      fs.writeFileSync(fixture, broken);
      assert.notEqual(spawnSync(patch, [fixture]).status, 0);
    }
  });
  console.log(`\n${passed} passed, 0 failed`);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
