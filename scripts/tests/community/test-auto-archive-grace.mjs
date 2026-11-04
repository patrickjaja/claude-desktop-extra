#!/usr/bin/env node
// Profile-local grace state + compiled native pipeline + settings/IPC validation.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync, execFileSync } from "node:child_process";
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const source = fs.readFileSync(path.join(ROOT, "js/auto_archive_grace.js"), "utf8");
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("PASS " + name); }
const pr = { repo: "owner/repo", prNumber: 1, state: "MERGED" };
function harness(disk = new Map()) {
  let clock = 1000000, minutes = 15, optIn = true, failure = false;
  const session = { sessionId: "s", prs: [{ ...pr }] }, logs = [];
  const file = "/profile/cdb-auto-archive-grace.json";
  const fakeFs = {
    readFileSync(p) { if (!disk.has(p)) throw Object.assign(Error("missing"), { code: "ENOENT" }); return disk.get(p); },
    mkdirSync() {},
    writeFileSync(p, data, options) { if (failure) throw Error("disk full"); assert.equal(options.mode, 0o600); disk.set(p, data); },
    renameSync(from, to) { disk.set(to, disk.get(from)); disk.delete(from); }
  };
  const engine = {
    sessionManager: { getSession: async () => session, getAllSessions: async () => [session] },
    ownPrBindings: prs => (prs || []).filter(p => !p.inherited),
    terminalVerdict: (_id, prs) => ({ terminal: prs.length > 0 && prs.every(p => ["MERGED", "CLOSED"].includes(p.state)), merged: prs.length > 0 && prs.every(p => p.state === "MERGED") })
  };
  const context = { require: id => id === "node:fs" ? fakeFs : id === "node:path" ? path : { app: { getPath: () => "/profile" } },
    Date: { now: () => clock }, globalThis: { __cdbDiag: text => logs.push(text), __cdbAutoArchiveMergeDelayMinutes: () => minutes } };
  const restart = () => vm.runInNewContext(source, context)(engine, () => optIn);
  const api = restart();
  return { api, restart, session, engine, disk, file, logs,
    tick: n => { clock += n; }, minutes: n => { minutes = n; }, optIn: v => { optIn = v; },
    fail: () => { failure = true; }, state: () => JSON.parse(disk.get(file) || '{"records":{}}').records,
    wait: (state = "merged") => api.wait(session, state) };
}
await test("default zero leaves native behavior and creates no ledger", async () => {
  const h = harness(); h.minutes(0); assert.equal(await h.wait(), false); assert.equal(h.disk.size, 0);
});
await test("whole grace, exact boundary, restart and no duplicate reset", async () => {
  const h = harness(); assert.equal(await h.wait(), true); const since = h.state().s.since;
  h.tick(14 * 60000); assert.equal(await h.restart().wait(h.session, "merged"), true);
  assert.equal(h.state().s.since, since); h.tick(60000); assert.equal(await h.wait(), false);
});
await test("live delay changes retain original start, immediate cancels", async () => {
  const h = harness(); await h.wait(); h.tick(5 * 60000); h.minutes(30); assert.equal(await h.wait(), true);
  h.minutes(5); assert.equal(await h.wait(), false); h.minutes(0); await h.wait(); assert.deepEqual(h.state(), {});
});
await test("CLOSED gets a full persisted grace, then reopen cancels and re-close restarts", async () => {
  const h = harness(); h.session.prs[0].state = "CLOSED";
  await h.api.reconcileAll(); assert.ok(h.state().s, "native terminal verdict starts closed grace while held");
  h.tick(14 * 60000); assert.equal(await h.restart().wait(h.session, "closed"), true);
  h.tick(60000); assert.equal(await h.wait("closed"), false);
  assert.equal(await h.wait("open"), false); assert.deepEqual(h.state(), {});
  h.tick(60000); assert.equal(await h.wait("closed"), true); assert.equal(h.state().s.since, 1960000);
});
await test("only a positive OPEN answer discards a prior deadline", async () => {
  const h = harness(); await h.wait(); assert.equal(await h.wait("open"), false); assert.deepEqual(h.state(), {});
  for (const state of [null, "no_pr_found", "unconfirmed_close"]) {
    const k = harness(); await k.wait(); const before = k.state().s;
    assert.equal(await k.wait(state), false); assert.deepEqual(k.state().s, before, String(state) + " is not an answer");
  }
});
await test("a null answer between two sweeps does not move the deadline", async () => {
  const h = harness(); await h.wait(); const since = h.state().s.since;
  h.tick(5 * 60000); await h.wait(null); await h.api.reconcileAll(); assert.equal(h.state().s.since, since);
  h.tick(10 * 60000); assert.equal(await h.wait(), false, "expires 15 minutes after the first confirmation");
});
await test("immediate with no ledger: reconcile never lists sessions; the delay is read once per sweep", async () => {
  const h = harness(); h.minutes(0); let listed = 0;
  h.engine.sessionManager.getAllSessions = async () => { listed++; return [h.session]; };
  await h.api.reconcileAll(); assert.equal(listed, 0); assert.equal(h.disk.size, 0);
  const g = harness(); let reads = 0;
  const context = { require: id => id === "node:fs" ? { readFileSync() { throw Object.assign(Error(), { code: "ENOENT" }); },
    mkdirSync() {}, writeFileSync() {}, renameSync() {} } : id === "node:path" ? path : { app: { getPath: () => "/profile" } },
    Date, globalThis: { __cdbAutoArchiveMergeDelayMinutes: () => { reads++; return 15; } } };
  const api = vm.runInNewContext(source, context)(g.engine, () => true);
  api.begin(); await api.wait(g.session, "merged"); await api.wait(g.session, null); api.pending(g.session); await api.reconcileAll();
  assert.equal(reads, 1);
});
await test("binding change starts new grace; old in-flight snapshot cannot archive", async () => {
  const h = harness(); await h.wait(); const old = structuredClone(h.session);
  h.tick(60000); h.session.prs[0].prNumber = 2;
  assert.equal(await h.api.wait(old, "merged"), true); assert.deepEqual(h.state(), {});
  assert.equal(await h.wait(), true); assert.equal(h.state().s.since, 1060000);
});
await test("native opt-out and per-session override cancel", async () => {
  const h = harness(); await h.wait(); h.optIn(false); await h.api.reconcileAll(); assert.deepEqual(h.state(), {});
  h.session.autoArchiveOnPrClose = true; await h.wait(); assert.ok(h.state().s);
  h.session.autoArchiveOnPrClose = false; await h.api.reconcileAll(); assert.deepEqual(h.state(), {});
});
await test("archived sessions and removed sessions discard grace without GH reads", async () => {
  const h = harness(); await h.wait(); h.session.isArchived = true; await h.api.reconcileAll(); assert.deepEqual(h.state(), {});
  h.session.isArchived = false; await h.wait(); h.engine.sessionManager.getAllSessions = async () => [];
  await h.api.reconcileAll(); assert.deepEqual(h.state(), {});
});
await test("native safety-held merged session starts clock on sweep", async () => {
  const h = harness(); h.session.isRunning = true; await h.api.reconcileAll(); assert.ok(h.state().s);
  h.tick(15 * 60000); h.session.isRunning = false; assert.equal(await h.wait(), false);
});
await test("unknown/open bindings do not start grace; inherited PRs do not count", async () => {
  const h = harness(); h.session.prs = [{ ...pr, inherited: true }, { ...pr, prNumber: 2, state: "OPEN" }];
  await h.api.reconcileAll(); assert.deepEqual(h.state(), {});
});
await test("binding identity is order-independent and host-specific", async () => {
  const h = harness(); h.session.prs.push({ ...pr, prNumber: 2 }); await h.wait();
  const before = h.state().s; h.tick(60000); h.session.prs.reverse(); await h.wait(); assert.deepEqual(h.state().s, before);
  h.session.prs[0].host = "enterprise.example"; await h.api.reconcileAll(); assert.notEqual(h.state().s.binding, before.binding);
});
await test("disk/corrupt state failures hold MERGED and CLOSED archives", async () => {
  const h = harness(); h.fail(); assert.equal(await h.wait(), true); assert.match(h.logs.join(), /disk full/);
  assert.equal(await h.wait("closed"), true);
  const bad = harness(new Map([[h.file, "not json"]])); assert.equal(await bad.wait(), true); assert.equal(await bad.wait("closed"), true);
  bad.minutes(0); assert.equal(await bad.wait(), false, "immediate restores native behavior even with corrupt leftover state");
});
await test("a stale terminal binding cannot recreate grace after confirmed reopen", async () => {
  const h = harness(); await h.wait("closed"); h.api.cancel(h.session.sessionId);
  h.tick(10 * 60000); await h.api.reconcileAll(); assert.deepEqual(h.state(), {});
  h.tick(10 * 60000); assert.equal(await h.wait("closed"), true);
  assert.equal(h.state().s.since, 2200000, "a fresh close gets its own confirmation clock");
});
await test("failed reopen cancellation cannot consume an old deadline in memory", async () => {
  const h = harness(); await h.wait("closed"); h.fail(); h.api.cancel(h.session.sessionId);
  h.tick(20 * 60000); assert.equal(await h.wait("closed"), true, "fresh grace write fails closed instead of consuming expired old deadline");
});
await test("clock rollback and invalid delay cannot shorten a grace", async () => {
  const h = harness(); await h.wait(); h.tick(-100000); assert.equal(await h.wait(), true);
  for (const invalid of [-1, 1.1, 10081, "15", NaN]) { h.minutes(invalid); assert.equal(await h.wait(), true); }
});

const binary = path.join(ROOT, "patches/community/add_feature_auto_archive_grace");
fs.accessSync(binary, fs.constants.X_OK);
// Mirrors upstream's AutoArchiveEngine shapes on 4.16336.0: the try-block
// locals, the lookup, the comma-expression terminal check, the block-scoped
// `let s` (readsGitHub), the reopenSeen return, the takesShare/GitHub block and
// the worktree inspection. Dollar identifiers exercise the minifier contract.
const fixture = `const e$={drt:()=>true},n$={s:s=>s==='merged'||s==='closed'},i$={inspectSessionWorktree:async()=>null},o$=36e5,E$=b=>JSON.stringify(b);
class Engine {
constructor(manager){this.sessionManager=manager;this.calls=[];this.reopenSeen=new Map;this.prCheckedAt=new Map;this.noPrAnswer=new Map;this.sweeping=!1;this.reads=!0}
answered(){}
freshReopen(t$,u$){if(this.calls.push('fresh'),u$.length>0)return this.answered(t$.sessionId,"close"),this.reopenSeen.set(t$.sessionId,{})}
async sweep(k$=!1){this.calls.push('sweep')}
ownPrBindings(prs){return(prs||[]).filter(p=>!p.inherited)}
terminalVerdict(id,prs){return this.verdict??{terminal:!1,merged:!1}}
holdReason(){return null}
readsGitHub(){return this.reads}
takesShare(){this.calls.push('share');return!0}
async waitsOnRememberedClose(){this.calls.push('remembered');return!1}
async waitsOnUnrecordedPr(){return!1}
async lookupPrState(){this.calls.push('lookup');return this.state}
async checkAndArchive(r$,a$,s$,c$){let l$=s$?"inactive":"pr";try{let u$=this.ownPrBindings(r$.prs),d$=null,m$=!1,g$=!1,_$;if(!s$){let t$=u$.filter(e=>!n$.s(e.state.toLowerCase()));if(t$.length>1){this.prCheckedAt.set(r$.sessionId,a$);return}if(d$=u$.length>0&&t$.length===0?u$[u$.length-1]?.state?.toLowerCase()??null:null,n$.s(d$)||(d$=await this.lookupPrState(r$,a$),d$==="unconfirmed_close"&&(_$=u$[0],d$="closed")),!n$.s(d$))return;let h$=this.holdReason(r$,l$);let s$=!g$&&this.readsGitHub(r$,u$,_$),c$=this.reopenSeen.get(r$.sessionId);if(s$&&c$?.bindings===E$(u$)&&a$-c$.at<o$)return;if(s$){if(!this.takesShare(r$.sessionId))return;let e=await this.waitsOnRememberedClose(r$,u$,a$,_$);if(await this.waitsOnUnrecordedPr(r$,a$)||e)return;this.noPrAnswer.delete(r$.sessionId)}}let v$=await i$.inspectSessionWorktree(null,r$);this.calls.push('inspect');if(l$==="pr"&&(this.sessionManager.sessionAutoArchiveOnPrClose(r$.sessionId)??e$.drt("ccAutoArchiveOnPrClose")===!0)===!1)return;this.calls.push('archive')}catch(e){throw e}}
}globalThis.Engine=Engine;`;
await test("compiled patch applies, preserves syntax, exact idempotence and fails closed on changed anchors", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdb-grace-patch-")), file = path.join(dir, "fixture.js");
  try {
    fs.writeFileSync(file, fixture); execFileSync(binary, [file]);
    const patched = fs.readFileSync(file, "utf8"); execFileSync(process.execPath, ["--check", file]);
    execFileSync(binary, [file]); assert.equal(fs.readFileSync(file, "utf8"), patched);
    for (const text of [fixture + fixture, fixture.replace("checkAndArchive", "changed"),
      fixture.replace("async sweep", "async changed"), fixture.replace("this.takesShare(", "this.share("),
      fixture.replace("this.prCheckedAt.set(", "this.checkedAt.set("),
      fixture.replace("}}let v$=await", "}};let v$=await"),
      patched.replace(".reconcileAll()", ".wrong()"),
      patched.replace("await this.__cdbGrace().wait", "await this.wrong().wait"),
      patched.replace(".pending(", ".wrong("), patched.replace('&&_$&&await', '&&await'),
      patched.replace("this.__cdbGrace().cancel(", "this.__cdbGrace().broken(")]) {
      fs.writeFileSync(file, text); assert.notEqual(spawnSync(binary, [file]).status, 0);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Run the actual injected methods against the fixture, not just the helper.
function patchedEngine(minutes = 15) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdb-grace-run-")), file = path.join(dir, "fixture.js");
  fs.writeFileSync(file, fixture); execFileSync(binary, [file]);
  const patched = fs.readFileSync(file, "utf8"); fs.rmSync(dir, { recursive: true, force: true });
  const h = harness(); const clock = { now: 1000000 };
  const context = { Date: { now: () => clock.now }, JSON, require: id => id === "node:fs" ? { readFileSync() { throw Object.assign(Error(), { code: "ENOENT" }); },
    mkdirSync() {}, writeFileSync() {}, renameSync() {} } : id === "node:path" ? path : { app: { getPath: () => "/profile" } },
    process: { platform: "linux" }, globalThis: { __cdbAutoArchiveMergeDelayMinutes: () => minutes } };
  vm.runInNewContext(patched, context);
  const manager = { ...h.engine.sessionManager, sessionAutoArchiveOnPrClose: () => true };
  const engine = new context.globalThis.Engine(manager);
  const check = async (inactive = false) => { engine.calls.length = 0; await engine.checkAndArchive(h.session, clock.now, inactive, false); return engine.calls.join(","); };
  return { h, engine, clock, context, check };
}
await test("injected gate holds a confirmed MERGED/CLOSED before any pre-archive work, all of it runs after expiry", async () => {
  for (const state of ["MERGED", "CLOSED"]) {
    const { h, clock, check } = patchedEngine(); h.session.prs[0].state = state;
    assert.equal(await check(), "", "no takesShare, GitHub re-read, worktree inspection or archive during the grace");
    clock.now += 14 * 60000; assert.equal(await check(), "");
    clock.now += 60000; assert.equal(await check(), "share,remembered,inspect,archive", "after expiry every upstream check runs");
  }
});
await test("injected lookup short-circuit: no lookupPrState while a known terminal verdict is in its grace", async () => {
  const { h, engine, clock, check } = patchedEngine(); h.session.prs[0].state = "OPEN"; engine.state = "merged";
  assert.equal(await check(), "lookup", "first confirmation reads the PR and starts the grace");
  engine.verdict = { terminal: true, merged: true };
  clock.now += 5 * 60000; assert.equal(await check(), "", "the next sweep does not read it again");
  clock.now += 10 * 60000; assert.equal(await check(), "lookup,share,remembered,inspect,archive", "after expiry upstream re-reads and archives");
});
await test("injected gate: an unconfirmed close is confirmed by upstream first, then held", async () => {
  const { h, engine, clock, check } = patchedEngine(); h.session.prs[0].state = "OPEN"; engine.state = "unconfirmed_close";
  assert.equal(await check(), "lookup,share,remembered", "upstream's own confirmation runs, the late gate holds before inspection");
  clock.now += 15 * 60000; assert.equal(await check(), "lookup,share,remembered,inspect,archive");
});
await test("injected: a null lookup between sweeps keeps the deadline, OPEN clears it", async () => {
  const { h, engine, clock, check } = patchedEngine(); h.session.prs[0].state = "OPEN"; engine.state = "merged";
  await check(); clock.now += 5 * 60000; engine.state = null; assert.equal(await check(), "lookup");
  clock.now += 10 * 60000; engine.state = "merged";
  assert.equal(await check(), "lookup,share,remembered,inspect,archive", "the original deadline still expired on time");
  const b = patchedEngine(); b.h.session.prs[0].state = "OPEN"; b.engine.state = "merged"; await b.check();
  b.clock.now += 10 * 60000; b.engine.state = "open"; await b.check();
  b.clock.now += 10 * 60000; b.engine.state = "merged"; assert.equal(await b.check(), "lookup", "after OPEN a re-merge starts a fresh grace");
});
await test("injected: confirmed reopen cancels the old clock and a stale CLOSED gets a fresh grace; inactivity, win32, immediate unchanged", async () => {
  const { h, engine, clock, context, check } = patchedEngine();
  assert.equal(await check(), "");
  clock.now += 14 * 60000; engine.freshReopen(h.session, [{}]); h.session.prs[0].state = "CLOSED";
  assert.equal(await check(), ""); clock.now += 2 * 60000;
  assert.equal(await check(), "", "the CLOSED binding got its own new grace");
  assert.equal(await check(true), "inspect,archive", "inactivity is unchanged");
  await engine.sweep(); assert.equal(engine.calls.includes("sweep"), true);
  context.process.platform = "win32"; assert.equal(await check(), "share,remembered,inspect,archive");
  const zero = patchedEngine(0); assert.equal(await zero.check(), "share,remembered,inspect,archive", "immediate is upstream");
});

await test("settings IPC: default, persistence, jsonc lock, validation and untouched unrelated preferences", async () => {
  const extra = path.join(ROOT, "patches/core/add_feature_extra_settings"); fs.accessSync(extra, fs.constants.X_OK);
  const require2 = createRequire(import.meta.url), Module = require2("module");
  for (const platform of ["linux", "win32"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdb-grace-settings-")), file = path.join(dir, "extra.cjs");
    try {
      fs.writeFileSync(file, 'function FHa(e=[]){let t=G().type==="3p"&&ou()==="1p"?[...e,j$t]:e;a.app.isPackaged?Mj(!0,t):fj(t)}');
      execFileSync(extra, [file]); const handlers = {}, userData = path.join(dir, "Claude"); fs.mkdirSync(userData);
      const electron = { app: { getPath: () => userData, on() {}, once() {} },
        ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; }, removeHandler() {} }, shell: {} };
      const original = Module._load, descriptor = Object.getOwnPropertyDescriptor(process, "platform");
      delete globalThis.__cdbAutoArchiveMergeDelayMinutes;
      Module._load = function (id, ...args) { return id === "electron" ? electron : original.call(this, id, ...args); };
      Object.defineProperty(process, "platform", { value: platform });
      try { require2(file); } finally { Module._load = original; Object.defineProperty(process, "platform", descriptor); }
      const event = { sender: { isDestroyed: () => false, getURL: () => "https://claude.ai/settings" }, senderFrame: { parent: null } };
      const call = (channel, ...args) => handlers["cdb-archive-grace:" + channel](event, ...args);
      if (platform === "win32") { assert.equal((await call("set", 15)).ok, false); assert.equal(globalThis.__cdbAutoArchiveMergeDelayMinutes, undefined); continue; }
      assert.equal((await call("read")).minutes, 0);
      const json = path.join(userData, "claude-desktop-extra.json"), jsonc = path.join(userData, "claude-desktop-extra.jsonc");
      const unrelated = { autoFixTrustedAuthors: ["github.com/my-app[bot]"], other: true };
      fs.writeFileSync(json, JSON.stringify(unrelated));
      for (const minutes of [5, 15, 30, 60, 42, 10080]) {
        assert.equal((await call("set", minutes)).ok, true); assert.equal(globalThis.__cdbAutoArchiveMergeDelayMinutes(), minutes);
        assert.deepEqual(JSON.parse(fs.readFileSync(json)), { ...unrelated, autoArchiveMergeDelayMinutes: minutes });
      }
      for (const invalid of ["15", null, true, -1, 1.5, 10081, NaN, Infinity]) assert.equal((await call("set", invalid)).ok, false);
      assert.equal((await call("set", 0)).ok, true); assert.deepEqual(JSON.parse(fs.readFileSync(json)), unrelated);
      fs.writeFileSync(jsonc, '{// comment\n"autoArchiveMergeDelayMinutes": 30,}');
      assert.equal((await call("read")).lockedByJsonc, true); assert.equal((await call("set", 5)).ok, false);
      assert.equal(globalThis.__cdbAutoArchiveMergeDelayMinutes(), 30);
      for (const bad of ['"bad"', "-1", "1.5", "10081"]) {
        fs.writeFileSync(jsonc, '{"autoArchiveMergeDelayMinutes": ' + bad + '}');
        const res = await call("read");
        assert.equal(res.lockedByJsonc, null, "an invalid .jsonc value does not lock: " + bad);
        assert.match(res.warning, /Ignoring autoArchiveMergeDelayMinutes/);
        assert.equal(globalThis.__cdbAutoArchiveMergeDelayMinutes(), 0);
      }
      assert.equal((await call("set", 15)).ok, true, "the row stays in charge past an invalid .jsonc value");
      assert.equal(globalThis.__cdbAutoArchiveMergeDelayMinutes(), 15);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); delete globalThis.__cdbAutoArchiveMergeDelayMinutes; }
  }
});
await test("narrow bridge forwards raw value for main validation", async () => {
  const calls = []; let api;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "js/extra_settings_bridge.js"), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, exposed) => { api = exposed; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); } } }) });
  api.autoArchiveGraceRead(); api.autoArchiveGraceSet(42); api.autoArchiveGraceSet("bad");
  assert.deepEqual(calls, [["cdb-archive-grace:read"], ["cdb-archive-grace:set", 42], ["cdb-archive-grace:set", "bad"]]);
});
console.log(`${passed} archive-grace tests passed`);
